/**
 * AtomGit / AtomCode 网关请求签名（sign_v1）。
 *
 * 官方 AtomCode 在访问 `https://llm-api.atomgit.com/v1` 时必须携带
 * `X-AtomCode-Sig/Ts/Nonce/Alg/Ver` 五个头，否则网关直接返回
 * 403 `{"detail":{"code":"ATOMCODE_SIG_MISSING"}}`。
 * 公开仓库里的 `atomcode-codingplan-crypto` 只是占位实现，真正的算法在官方
 * 闭源构建里；这里的实现是对官方二进制行为的等价重建，并用 7 条真实抓包
 * 逐字节校验通过。
 *
 * 已知协议限制：派生密钥按 `floor(ts / 3600)` 分桶，nonce 只进签名串、不进密钥，
 * 因此签名本身**不防重放**——同一小时内抓到的完整请求可原样重发。要防重放只能
 * 由网关侧缓存 nonce / 限制 ts 偏移，客户端无法补。
 *
 * @module dsh-atomcode/sign
 */

import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

/**
 * HKDF-Extract 用的主密钥；官方客户端硬编码在二进制里。
 *
 * 这是**协议常量**，不是用户密钥：它只能证明"调用方实现了 AtomCode 签名协议"，
 * 不带来任何账号权限——网关仍然校验 `Authorization: Bearer <access_token>`，
 * 且派生密钥绑定 `sha256(token) + userId`，没有 token 无法冒充别人。
 *
 * 不导出；允许用 `ATOMCODE_MASTER_KEY` 覆盖，供应方轮换时无需发版。
 */
const KEY_HEX = process.env.ATOMCODE_MASTER_KEY
  ?? 'e97250f05303162c8ecd68c688b2f55c1d81e508d243d88466472e7f54637123'
const MASTER_KEY = Buffer.from(KEY_HEX, 'hex')
if (MASTER_KEY.length !== 32) {
  throw new Error('ATOMCODE_MASTER_KEY 必须是 32 字节 hex（64 个十六进制字符）')
}

/** 参与签名盐串的客户端版本；官方按 `x-atomcode-ver` 发送。可用 `ATOMCODE_CLIENT_VERSION` 覆盖。 */
export const CLIENT_VERSION = process.env.ATOMCODE_CLIENT_VERSION ?? '5.2.7'

/** 签名算法标识（`x-atomcode-alg`）。 */
export const ALGORITHM = '1'

/** 签名体的前缀。 */
const PREFIX = 'v1'

function sha256(...parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest()
}

/**
 * 派生本次请求的 HMAC 密钥。
 *
 * salt = user_id ‖ 0x01 ‖ uint64le(ts / 3600) ‖ sha256(token) ‖ sha256(version)
 * prk  = HMAC-SHA256(key = salt, data = MASTER_KEY)          （HKDF-Extract）
 * key  = HMAC-SHA256(key = prk, data = "atomcode-signing-v1" ‖ 0x01)（Expand，一个块）
 */
export function deriveSigningKey({ token, userId, timestamp, version = CLIENT_VERSION }) {
  const hourBucket = Buffer.alloc(8)
  hourBucket.writeBigUInt64LE(BigInt(Math.floor(timestamp / 3600)))

  const salt = Buffer.concat([
    Buffer.from(userId, 'utf8'),
    Buffer.from([0x01]),
    hourBucket,
    sha256(Buffer.from(token, 'utf8')),
    sha256(Buffer.from(version, 'utf8')),
  ])

  const prk = hmac(salt, MASTER_KEY)
  return hmac(prk, Buffer.concat([Buffer.from('atomcode-signing-v1', 'utf8'), Buffer.from([0x01])]))
}

/** 规范化签名串：v1 \n METHOD \n path \n ts \n nonceHex \n sha256(body)Hex。 */
export function canonicalString({ method, path, body, timestamp, nonce }) {
  return [
    PREFIX,
    method.toUpperCase(),
    path,
    String(timestamp),
    nonce.toString('hex'),
    createHash('sha256').update(body).digest('hex'),
  ].join('\n')
}

/**
 * 为一次请求生成签名头。
 *
 * `body` 必须是**实际上线的字节**：网关对 body 做 sha256，重新序列化会改变
 * 字节序列从而签名失败。
 *
 * @param {object} input
 * @param {string} input.method HTTP 方法
 * @param {string} input.path 规范化路径（base 路径 + `/chat/completions`）
 * @param {Buffer|Uint8Array|string} input.body 实际发送的请求体
 * @param {string} input.token OAuth access token
 * @param {string} input.userId AtomGit 用户 id
 * @param {number} [input.timestamp] Unix 秒
 * @param {Buffer} [input.nonce] 16 字节随机数
 * @param {string} [input.version] 客户端版本
 * @returns {{sig: string, timestamp: number, nonce: string, headers: Record<string, string>}}
 */
export function signRequest(input) {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000)
  const nonce = input.nonce ?? randomBytes(16)
  const version = input.version ?? CLIENT_VERSION
  const body = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body)

  const key = deriveSigningKey({
    token: input.token,
    userId: input.userId,
    timestamp,
    version,
  })
  const signature = hmac(key, Buffer.from(canonicalString({
    method: input.method,
    path: input.path,
    body,
    timestamp,
    nonce,
  }), 'utf8')).toString('hex')

  return {
    sig: `${PREFIX}:${signature}`,
    timestamp,
    nonce: nonce.toString('hex'),
    headers: {
      'x-atomcode-sig': `${PREFIX}:${signature}`,
      'x-atomcode-ts': String(timestamp),
      'x-atomcode-nonce': nonce.toString('hex'),
      'x-atomcode-alg': ALGORITHM,
      'x-atomcode-ver': version,
    },
  }
}

/** 每个网关会话的 id；官方客户端每进程一个。 */
export function newSessionId() {
  return randomUUID()
}

/**
 * 把网关的 base URL 规范成 OpenAI 兼容路径。
 * `https://llm-api.atomgit.com/v1` → `/v1/chat/completions`
 */
export function canonicalChatPath(baseUrl, suffix = '/chat/completions') {
  const { pathname } = new URL(baseUrl)
  const base = pathname.replace(/\/+$/, '')
  return base.endsWith(suffix) ? base : `${base}${suffix}`
}