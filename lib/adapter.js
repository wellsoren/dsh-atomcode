/**
 * `atomcode` 这条 pi-ai provider：模型描述 + 指向本机回环签名代理。
 *
 * 与 dsh-codearts 同一套路：pi-ai 只认 OpenAI 兼容端点，签名代理负责把请求
 * 变成 AtomGit 网关要的样子。
 *
 * @module dsh-atomcode/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'

/** 本插件占用的 provider route。 */
export const ATOMCODE_PROVIDER = 'atomcode'

/** 流空闲上限：网关后面是 vLLM/LiteLLM，首 token 冷启动通常 < 30s。 */
export const ATOMCODE_STREAM_IDLE_TIMEOUT_MS = 120_000

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/** pi-ai 认识的推理档位（升序）。 */
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/**
 * 上游只声明了部分档位时，其余档位必须显式钉成 null——pi-ai 把"缺少条目"
 * 理解成"支持"，不钉的话 UI 会给一个只会 high 的模型列出 off/low/medium。
 */
export function thinkingFields(efforts) {
  const offered = new Set(efforts ?? [])
  if (!REASONING_LEVELS.some(level => level !== 'off' && offered.has(level))) return { reasoning: false }
  const map = {}
  for (const level of REASONING_LEVELS) map[level] = offered.has(level) ? level : null
  return { reasoning: true, thinkingLevelMap: map }
}

function toPiModel(info, baseUrl) {
  const thinking = thinkingFields(info.reasoningEfforts)
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: ATOMCODE_PROVIDER,
    baseUrl,
    input: info.supportsImages ? ['text', 'image'] : ['text'],
    reasoning: thinking.reasoning,
    ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
  }
}

/**
 * 构造 provider 与适配器。
 *
 * @param {object} options
 * @param {{baseUrl: string, token: () => string}} options.shim 回环签名代理
 * @param {{current: () => object[]}} options.catalog 模型目录
 * @param {() => string[] | undefined} [options.enabledModels] 用户在设置里勾选的模型
 */
export function createAtomCodeAdapter({ shim, catalog, enabledModels }) {
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl}/v1`
    return catalog.current()
      .filter(info => info.planAvailable)
      .map(info => toPiModel(info, baseUrl))
  }

  const base = createProvider({
    id: ATOMCODE_PROVIDER,
    name: 'AtomGit AtomCode',
    auth: {
      apiKey: {
        name: 'AtomCode 回环口令',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0 ? undefined : { auth: { apiKey }, source: 'AtomCode' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })

  const provider = { ...base, getModels: () => buildModels() }

  const profile = {
    provider: ATOMCODE_PROVIDER,
    displayName: 'AtomGit AtomCode',
    streamIdleTimeoutMs: ATOMCODE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-atomcode retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  const adapter = new AtomCodePiAiAdapter({
    profiles: () => new Map([[ATOMCODE_PROVIDER, profile]]),
    auth: {
      credentials: {
        async read() { return undefined },
        async list() { return [] },
        async modify() { throw new Error('dsh-atomcode: provider 没有 pi-ai 凭据生命周期') },
        async delete() {},
      },
      authContext: { async env() { return undefined }, async fileExists() { return false } },
    },
    resolveApiKey: async () => shim.token(),
  }, enabledModels)

  return { adapter, profile, provider }
}

/**
 * 只限制"可见模型"，不限制分发：用户在设置里关掉的模型不出现在列表里，
 * 但会话里已经选中的模型仍能继续 stream。
 */
class AtomCodePiAiAdapter extends PiAiAdapter {
  constructor(options, enabledModels) {
    super(options)
    this.enabledModels = enabledModels
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    const enabled = this.enabledModels?.()
    if (!enabled || enabled.length === 0) return models
    const allowed = new Set(enabled)
    return models.filter(model => allowed.has(model.id))
  }
}