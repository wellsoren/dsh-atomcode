/**
 * dsh-atomcode：把 AtomGit / AtomCode 的 CodingPlan 模型接进 DeepSeek Harness。
 *
 * 组成：
 *   - `AuthStore`    读写 AtomCode 的 `~/.atomcode/auth.toml`（OAuth 登录态）
 *   - `ModelCatalog` 轮询 CodingPlan 的 `models-v2`
 *   - `SigningShim`  本机回环代理，负责 `X-AtomCode-*` 请求签名
 *   - pi-ai provider `atomcode`，baseUrl 指向该代理
 *
 * @module dsh-atomcode
 */

import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { AuthStore, DEFAULT_PLATFORM_BASE } from './auth.js'
import { ModelCatalog, FALLBACK_MODELS } from './catalog.js'
import { DEFAULT_API_BASE, fetchStatus, fetchUsage, claimFirstAvailable } from './codingplan.js'
import { SigningShim } from './shim.js'
import { CLIENT_VERSION } from './sign.js'
import { ATOMCODE_PROVIDER, createAtomCodeAdapter } from './adapter.js'
import { routeAccessError, REQUIRES_ORIGIN } from './access.js'

/** 插件 id：与 `cordis.patch.yml` 里 insert 的 id 保持一致。 */
export const name = 'llm-atomcode'

/** 依赖 LLM seam。 */
export const inject = ['llm']

/** 设置命名空间。 */
export const SETTINGS_NS = 'atomcode'

/** CodingPlan 的默认 LLM 网关。 */
const DEFAULT_LLM_BASE = 'https://llm-api.atomgit.com/v1'

export const Config = z.object({
  /** 只暴露这些模型；留空表示全开。 */
  enabledModels: z.array(z.string()).default([]),
  /** 查询模型清单时带的套餐档位（留空则从 status-v2 自动读）。 */
  planType: z.string().default(''),
  /** 平台 broker（登录、换 token、刷新）。 */
  platformBase: z.string().default(DEFAULT_PLATFORM_BASE),
  /** CodingPlan 控制面。 */
  apiBase: z.string().default(DEFAULT_API_BASE),
  /** LLM 网关。 */
  llmBase: z.string().default(DEFAULT_LLM_BASE),
  /** 模型清单刷新间隔（分钟）。 */
  refreshIntervalMinutes: z.natural().default(60),
  /** 网关把该版本号算进签名盐；默认值只有 lib/sign.js 一处，必要时可配置覆盖。 */
  clientVersion: z.string().default(CLIENT_VERSION),
})

/** 简易日志：宿主没有统一的 info 出口，调试时用环境变量打开。 */
function makeLog(ctx) {
  let logger
  try {
    logger = ctx.logger?.(name)
  } catch {}
  const debug = process.env.DSH_ATOMCODE_DEBUG !== undefined
  return (message, error) => {
    const text = error === undefined ? message : `${message}: ${error?.stack ?? error?.message ?? error}`
    if (logger?.debug) logger.debug(text)
    else if (debug) console.error(`[dsh-atomcode] ${text}`)
  }
}

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, null, 2), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) })
  res.end(payload)
}

export function apply(ctx, rawConfig) {
  const config = Config(rawConfig ?? {})
  const log = makeLog(ctx)

  const auth = new AuthStore({ platformBase: config.platformBase })
  const catalog = new ModelCatalog({ auth, apiBase: config.apiBase, planType: config.planType, log })
  const shim = new SigningShim({
    auth,
    llmBase: config.llmBase,
    models: () => catalog.current(),
    log,
    clientVersion: config.clientVersion || CLIENT_VERSION,
  })

  const { adapter } = createAtomCodeAdapter({
    shim,
    catalog,
    enabledModels: () => config.enabledModels,
  })

  /** 登录流程的进行状态，供 HTTP 接口轮询。 */
  let loginState = { status: 'idle' }

  const boot = async () => {
    await shim.start()
    log(`shim listening on ${shim.baseUrl}`)
    if (!auth.current()) {
      log('未找到 AtomGit 登录态：运行 `atomcode login`，或 POST /api/atomcode/login')
      return
    }
    if (await catalog.refresh()) log(`模型：${catalog.available().map(model => model.id).join(', ')}`)
    else log(`模型清单刷新失败：${catalog.lastError ?? '未知原因'}`)
  }

  ctx.effect(() => {
    boot().catch(error => log('启动失败', error))
    return () => {
      void shim.dispose()
    }
  })

  ctx.effect(() => {
    const adapterHandle = ctx.llm.registerAdapter([ATOMCODE_PROVIDER], adapter)
    const providerHandle = ctx.llm.registerConfigurableProviders([{
      provider: ATOMCODE_PROVIDER,
      displayName: 'AtomGit AtomCode',
      settingsNs: SETTINGS_NS,
      settingsPath: [],
      declared: false,
      defaultBaseURL: config.llmBase,
      nativeAuth: { env: [], oauth: true },
    }])
    return () => {
      adapterHandle()
      providerHandle()
    }
  })

  ctx.effect(() => {
    const minutes = Math.max(5, config.refreshIntervalMinutes)
    const catalogTimer = setInterval(() => {
      catalog.refresh().catch(error => log('模型清单刷新失败', error))
    }, minutes * 60_000)
    const authTimer = setInterval(() => {
      if (!auth.current()?.shouldRefresh) return
      auth.refresh().catch(error => log('登录态续期失败', error))
    }, 10 * 60_000)
    catalogTimer.unref?.()
    authTimer.unref?.()
    return () => {
      clearInterval(catalogTimer)
      clearInterval(authTimer)
    }
  })

  ctx.inject(['webServer'], webCtx => {
    const routes = [
      ['/api/atomcode/status', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        // clear() 只清内存；读状态前重新读盘，避免把「磁盘上仍有登录态」误报成未登录。
        if (!auth.current()) auth.reload()
        const session = auth.current()
        const plan = session
          ? await fetchStatus({ apiBase: config.apiBase, token: session.accessToken })
            .catch(error => ({ error: error.message }))
          : undefined
        const providers = (() => {
          try {
            return ctx.llm.listProviders()
          } catch (error) {
            return { error: error.message }
          }
        })()
        let listed
        try {
          listed = await ctx.llm.listModels(ATOMCODE_PROVIDER)
        } catch (error) {
          listed = { error: error.message }
        }
        sendJson(res, 200, {
          authenticated: Boolean(session),
          registeredProviders: providers,
          listedModels: listed,
          shim: shim.baseUrl,
          user: session?.user,
          expiresAt: session?.expiresIn ? session.createdAt + session.expiresIn : undefined,
          authFile: auth.file,
          planType: catalog.planType,
          models: catalog.current(),
          modelsSource: catalog.source,
          lastError: catalog.lastError,
          plan,
          client: (() => {
            try {
              const registry = ctx.get('clientModules')
              if (registry === undefined) return undefined
              const entry = registry.graph().entries.find(candidate => candidate.id === 'dsh-atomcode')
              return { bundle: registry.clientPath('dsh-atomcode'), entry }
            } catch (error) {
              return { error: error.message }
            }
          })(),
        })
      }],
      ['/api/atomcode/login', async (req, res) => {
        if (req.method === 'GET') return sendJson(res, 200, loginState)
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        if (loginState.status === 'pending') return sendJson(res, 200, loginState)
        loginState = { status: 'pending' }
        try {
          const session = await auth.login({
            onUrl: url => {
              loginState.url = url
              log(`请在浏览器打开：${url}`)
            },
          })
          await catalog.refresh().catch(() => {})
          loginState = { status: 'ok', user: session.user }
        } catch (error) {
          loginState = { status: 'error', error: error.message }
        }
        sendJson(res, 200, loginState)
      }],
      ['/api/atomcode/logout', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        // auth.toml 与 CLI 共用；只清内存的话下一次 /status 会把它读回来，等于假登出。
        auth.purge()
        loginState = { status: 'idle' }
        sendJson(res, 200, {
          ok: true,
          purged: true,
          message: '已退出登录并清除 auth.toml（AtomCode CLI 同时退出）',
        })
      }],
      ['/api/atomcode/refresh', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const refreshed = await catalog.refresh().catch(error => {
          catalog.lastError = error.message
          return false
        })
        sendJson(res, 200, { ok: refreshed, models: catalog.current(), lastError: catalog.lastError })
      }],
      ['/api/atomcode/claim', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        const session = await auth.ensure()
        if (!session) return sendJson(res, 401, { error: '未登录' })
        try {
          const claimed = await claimFirstAvailable({ apiBase: config.apiBase, token: session.accessToken })
          await catalog.refresh().catch(() => {})
          sendJson(res, 200, claimed)
        } catch (error) {
          sendJson(res, 502, { error: error.message })
        }
      }],
      ['/api/atomcode/usage', async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        const session = await auth.ensure().catch(() => undefined)
        if (!session) return sendJson(res, 401, { error: '未登录' })
        try {
          const usage = await fetchUsage({ apiBase: config.apiBase, token: session.accessToken })
          sendJson(res, 200, usage)
        } catch (error) {
          sendJson(res, 502, { error: error.message })
        }
      }],
      ['/api/atomcode/chat', async (req, res) => {
        const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
        const model = params.get('model') ?? 'qwen3.8-27b'
        const text = params.get('prompt') ?? '用一句话介绍你自己'
        const started = Date.now()
        const chunks = []
        const pieces = []
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 120_000)
          try {
            for await (const chunk of adapter.stream({
              provider: ATOMCODE_PROVIDER,
              model,
              messages: [{
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'model-selection', form: 'notice', summary: 'dsh-atomcode probe' },
              }],
              signal: controller.signal,
            })) {
              chunks.push(chunk)
              if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') pieces.push(chunk.text)
              else if (chunk?.type === 'text' && typeof chunk.text === 'string') pieces.push(chunk.text)
            }
          } finally {
            clearTimeout(timer)
          }
          sendJson(res, 200, {
            ok: true,
            model,
            elapsedMs: Date.now() - started,
            text: pieces.join(''),
            chunkTypes: [...new Set(chunks.map(chunk => chunk?.type))],
            chunks: chunks.slice(0, 40),
          })
        } catch (error) {
          sendJson(res, 502, { ok: false, model, elapsedMs: Date.now() - started, error: error.message, stack: error.stack })
        }
      }],
      ['/api/atomcode/probe', async (req, res) => {
        const model = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('model') ?? 'qwen3.8-27b'
        try {
          const resolved = await ctx.llm.resolveModelInfo(ATOMCODE_PROVIDER, model)
          sendJson(res, 200, { ok: true, model, resolved })
        } catch (error) {
          sendJson(res, 502, { ok: false, model, error: error.message, stack: error.stack })
        }
      }],
    ]

    const disposers = routes.map(([path, handler]) => webCtx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        const remote = req.socket?.remoteAddress ?? ''
        if (!/^(::1|::ffff:127\.0\.0\.1|127\.0\.0\.1)$/.test(remote)) {
          return sendJson(res, 403, { error: 'atomcode 接口只接受本机请求' })
        }
        const deny = routeAccessError(req, REQUIRES_ORIGIN.has(path))
        if (deny) {
          return sendJson(res, 403, { error: `atomcode 接口拒绝访问：${deny}` })
        }
        try {
          await handler(req, res)
        } catch (error) {
          log(`路由 ${path} 失败`, error)
          if (!res.headersSent) sendJson(res, 500, { error: error.message })
        }
      },
    }))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  log(`已加载，模型种子 ${FALLBACK_MODELS.length} 条`)
}

export { ATOMCODE_PROVIDER }