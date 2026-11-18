/**
 * 本机回环签名代理。
 *
 * pi-ai 的 openai-completions 客户端只会带一个 `Authorization: Bearer`，而
 * AtomGit 网关还要求五个 `X-AtomCode-*` 签名头、且签名绑定请求体字节。把
 * 这一段放在回环 HTTP 代理里，pi-ai 侧就只是"又一个 OpenAI 兼容端点"。
 *
 * @module dsh-atomcode/shim
 */

import { createServer } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes } from 'node:crypto'
import { canonicalChatPath, newSessionId, signRequest } from './sign.js'

/** 请求体上限：DSH 的图片预算按 20MB 给足后仍有余量。 */
const MAX_BODY_BYTES = 64 * 1024 * 1024

/** 上游首字节超时。 */
const UPSTREAM_CONNECT_TIMEOUT_MS = 120_000

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
  })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 把网关的 SSE/JSON 响应原样回给 pi-ai。 */
function pipeResponse(upstream, res) {
  const headers = {}
  for (const [key, value] of Object.entries(upstream.headers)) {
    if (HOP_BY_HOP.has(key)) continue
    headers[key] = value
  }
  res.writeHead(upstream.statusCode ?? 502, headers)
  upstream.pipe(res)
}

export class SigningShim {
  constructor({ auth, llmBase, models, log = () => {}, clientVersion }) {
    this.auth = auth
    this.llmBase = llmBase
    this.models = models
    this.log = log
    /** 网关把客户端版本也算进签名盐里，所以必须与协议版本保持一致。 */
    this.clientVersion = clientVersion
    this.secret = randomBytes(24).toString('hex')
    this.sessionId = newSessionId()
    this.server = undefined
    this.port = undefined
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  /** pi-ai 侧使用的假 API key：只在本机回环上校验。 */
  token() {
    return this.secret
  }

  async start() {
    if (this.server) return this.baseUrl
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch(error => {
        this.log('shim error', error)
        if (!res.headersSent) json(res, 500, { error: { message: error.message, type: 'shim_error' } })
        else res.destroy(error)
      })
    })
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', resolve)
    })
    this.port = this.server.address().port
    return this.baseUrl
  }

  async dispose() {
    const server = this.server
    this.server = undefined
    if (server) await new Promise(resolve => server.close(resolve))
  }

  async #handle(req, res) {
    const host = req.headers.host ?? ''
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
      return json(res, 403, { error: { message: 'atomcode shim 只接受本机请求' } })
    }
    if (req.headers.authorization !== `Bearer ${this.secret}`) {
      return json(res, 401, { error: { message: 'atomcode shim: bad token', type: 'auth_error' } })
    }

    const url = new URL(req.url ?? '/', `http://${host}`)

    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return json(res, 200, {
        object: 'list',
        data: this.models().map(model => ({ id: model.id, object: 'model', owned_by: 'atomgit' })),
      })
    }

    if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
      return json(res, 404, { error: { message: `atomcode shim: 未支持的路径 ${url.pathname}` } })
    }

    const body = await readBody(req)
    await this.#forward(req, res, body, 0)
  }

  async #forward(req, res, body, attempt) {
    const session = await this.auth.ensure()
    if (!session) {
      return json(res, 401, {
        error: {
          message: 'AtomGit 未登录：请先运行 `atomcode login`，或在插件里完成一次登录。',
          type: 'auth_error',
        },
      })
    }

    const path = canonicalChatPath(this.llmBase)
    const { headers: signatureHeaders } = signRequest({
      method: 'POST',
      path,
      body,
      token: session.accessToken,
      userId: session.userId,
      ...(this.clientVersion ? { version: this.clientVersion } : {}),
    })

    const target = new URL(path, this.llmBase)
    const upstream = await new Promise((resolve, reject) => {
      const outbound = httpsRequest({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          ...signatureHeaders,
          authorization: `Bearer ${session.accessToken}`,
          'content-type': 'application/json',
          accept: req.headers.accept ?? 'text/event-stream',
          'accept-encoding': 'identity',
          'user-agent': `atomcode/${this.clientVersion ?? '5.2.7'}`,
          'x-atomcode-client': 'dsh-atomcode',
          'x-atomcode-session-id': this.sessionId,
          'content-length': String(body.length),
        },
        timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
      }, resolve)
      outbound.on('timeout', () => outbound.destroy(new Error('AtomGit 网关连接超时')))
      outbound.on('error', reject)
      outbound.end(body)
    })

    const status = upstream.statusCode ?? 502
    if (status === 200) return pipeResponse(upstream, res)

    // 非 200：缓冲整个响应体，认证类失败就刷新一次再试。
    const chunks = []
    for await (const chunk of upstream) chunks.push(chunk)
    const payload = Buffer.concat(chunks)
    const retryable = (status === 401 || status === 403) && attempt === 0 && this.#looksLikeAuthError(payload)
    if (retryable) {
      this.log('gateway rejected the token, refreshing and retrying once')
      try {
        await this.auth.refresh()
        return await this.#forward(req, res, body, attempt + 1)
      } catch (error) {
        this.log('refresh failed', error)
      }
    }

    const headers = { 'content-type': upstream.headers['content-type'] ?? 'application/json' }
    res.writeHead(status, headers)
    res.end(payload)
  }

  #looksLikeAuthError(payload) {
    const text = payload.toString('utf8', 0, Math.min(payload.length, 4096))
    return /auth|token|codingplan|SIG_MISSING|credential/i.test(text)
  }
}