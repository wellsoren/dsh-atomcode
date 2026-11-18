/**
 * CodingPlan 控制面客户端：模型清单、套餐状态、用量、领取。
 *
 * 控制面是普通 Bearer 鉴权（没有请求签名），可以放心直连。
 *
 * @module dsh-atomcode/codingplan
 */

import { USER_AGENT } from './auth.js'

/** 默认控制面 base。 */
export const DEFAULT_API_BASE = 'https://api.gitcode.com/api/v5'

/** 领取失败时依次尝试的套餐档位。 */
export const PLAN_CASCADE = ['Max', 'Pro', 'Lite']

async function call(apiBase, path, { method = 'GET', body, token, signal, timeoutMs = 20_000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)
  const onAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = text.slice(0, 300)
      try {
        const parsed = JSON.parse(text)
        detail = parsed.message || parsed.error_description || parsed.path || detail
      } catch {}
      const error = new Error(`CodingPlan ${path} → HTTP ${res.status}: ${detail}`)
      error.status = res.status
      error.body = text
      throw error
    }
    return text === '' ? {} : JSON.parse(text)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 服务端提供的模型清单（含当前套餐不可用的条目）。 */
export async function fetchModels(options) {
  const { apiBase = DEFAULT_API_BASE, planType = '' } = options
  const query = planType ? `?plan_type=${encodeURIComponent(planType)}` : ''
  const raw = await call(apiBase, `/coding-plan/models-v2${query}`, options)
  return Array.isArray(raw) ? raw : (raw.models ?? [])
}

/** 套餐状态 + 当前窗口用量。 */
export function fetchStatus(options) {
  const { apiBase = DEFAULT_API_BASE } = options
  return call(apiBase, '/coding-plan/status-v2', options)
}

/** 近 60 天用量明细。 */
export function fetchUsage(options) {
  const { apiBase = DEFAULT_API_BASE } = options
  return call(apiBase, '/coding-plan/usage', options)
}

/** 领取套餐（幂等：已领取时 duplicate=true）。 */
export function claimPlan(planType, options) {
  const { apiBase = DEFAULT_API_BASE } = options
  return call(apiBase, '/coding-plan/claim-v2', { ...options, method: 'POST', body: { plan_type: planType } })
}

/** 依次尝试 Max → Pro → Lite，返回第一次成功的领取结果。 */
export async function claimFirstAvailable(options) {
  const errors = []
  for (const planType of PLAN_CASCADE) {
    try {
      const result = await claimPlan(planType, options)
      if (result?.success !== false) return { planType, result }
      errors.push(`${planType}: ${result?.message ?? '失败'}`)
    } catch (error) {
      if (error.status === 401 || error.status === 403) throw error
      errors.push(`${planType}: ${error.message}`)
    }
  }
  throw new Error(`领取 CodingPlan 失败：${errors.join('；')}`)
}