/**
 * 模型目录：把 CodingPlan 的 `models-v2` 条目规整成插件内部的模型描述。
 *
 * 服务端只返回"当前账号能看见"的模型，`plan_available: false` 的条目仍然会
 * 出现在列表里（套餐不够），这里保留该标记，由适配器决定是否暴露。
 *
 * @module dsh-atomcode/catalog
 */

import { fetchModels, fetchStatus } from './codingplan.js'

/** 服务端不可达时使用的兜底清单（与 2026-11 的实测返回一致）。 */
export const FALLBACK_MODELS = [
  {
    id: 'qwen3.8-27b',
    name: 'qwen3.8-27b',
    contextWindow: 262_144,
    maxTokens: 32_000,
    supportsImages: true,
    reasoningEfforts: ['low', 'medium', 'xhigh'],
    planAvailable: true,
  },
  {
    id: 'glm5.3-flash',
    name: 'glm5.3-flash',
    contextWindow: 512_000,
    maxTokens: 16_000,
    supportsImages: true,
    reasoningEfforts: ['low', 'high'],
    planAvailable: true,
  },
]

/** AtomCode 自己给的下限：服务端给的更小的上下文一律抬到 128k。 */
const MIN_CONTEXT_WINDOW = 128_000

const DEFAULT_MAX_TOKENS = 32_000

/** 一条 `models-v2` 条目 → 插件模型描述。 */
export function normalizeModel(entry) {
  const id = entry.display_model_name ?? String(entry.id)
  const contextWindow = Math.max(MIN_CONTEXT_WINDOW, entry.context_window ?? 0)
  return {
    id,
    name: id,
    contextWindow,
    maxTokens: entry.max_tokens ?? DEFAULT_MAX_TOKENS,
    supportsImages: entry.supports_vision === true,
    reasoningEfforts: Array.isArray(entry.reasoning_effort_levels) ? entry.reasoning_effort_levels : [],
    planAvailable: entry.plan_available !== false,
    baseUrl: entry.base_url ?? undefined,
    upstreamType: entry.type ?? 'openai',
    serverId: entry.id,
  }
}

/** 目录：内存缓存 + 失败时回落到上一份/内置清单。 */
export class ModelCatalog {
  constructor({ auth, apiBase, planType = '', log = () => {} }) {
    this.auth = auth
    this.apiBase = apiBase
    this.planType = planType
    this.log = log
    this.models = [...FALLBACK_MODELS]
    this.source = 'fallback'
    this.lastError = undefined
    this.lastRefresh = 0
  }

  current() {
    return this.models
  }

  /** 当前账号真正可用的模型（`plan_available`）。 */
  available() {
    return this.models.filter(model => model.planAvailable)
  }

  async refresh({ signal } = {}) {
    const session = await this.auth.ensure({ signal })
    if (!session) {
      this.lastError = '未登录'
      return false
    }
    try {
      // `models-v2` 强制要求 plan_type；没配就从 status-v2 里读当前套餐档位。
      if (!this.planType) {
        const status = await fetchStatus({ apiBase: this.apiBase, token: session.accessToken, signal })
        this.planType = status.plan_type ?? status.codingplan_free?.plan_type ?? 'Lite'
      }
      const entries = await fetchModels({
        apiBase: this.apiBase,
        planType: this.planType,
        token: session.accessToken,
        signal,
      })
      const models = entries.map(normalizeModel).filter(model => model.id)
      if (models.length > 0) {
        this.models = models
        this.source = 'server'
        this.lastRefresh = Date.now()
        this.lastError = undefined
        return true
      }
      this.lastError = '服务端返回了空模型列表'
      return false
    } catch (error) {
      this.lastError = error.message
      this.log('catalog refresh failed', error)
      return false
    }
  }
}