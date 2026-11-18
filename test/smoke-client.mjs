/**
 * 客户端半的接线 + 渲染冒烟。
 *
 * 这个脚本不做 DOM，也不跑真实 hooks：
 *   - 用假的 `window.__ModuleLoader__` 接住 bundle，验证导出的 `{name, inject, apply}`；
 *   - 用假 slots 服务验证 sidebar.panellist / main / settings.section 三条注册的
 *     name / id / key / order；
 *   - 用「预置 hooks 返回值的迷你渲染器」把主面板画成文本，覆盖空态、错误态和
 *     真实数据态三条路径 —— 抓的是首屏崩溃（拼错函数、对 undefined 取属性）。
 *
 * 真实交互（fetch、轮询、按钮）仍要靠浏览器刷新后目视验收。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client', 'index.js'), 'utf8')

const checks = []
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition), detail })
}

// --------------------------------------------------------------- fake React

/** 预置的 hooks 返回值；渲染前由 `renderWith` 指定。 */
let hookSeed = []
let hookIndex = 0

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  Component: class Component {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(patch) {
      this.state = { ...this.state, ...patch }
    }
  },
  useState(initial) {
    const index = hookIndex++
    const value = index < hookSeed.length ? hookSeed[index] : initial
    return [value, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
}

ReactStub.Component.prototype.isReactComponent = {}

/** 把元素树压成文本；函数/类组件就地调用（hooks 由上面的 stub 供货）。 */
function render(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node.type !== 'function') return render(node.children)

  const props = { ...node.props }
  props.children = node.children.length <= 1 ? node.children[0] : node.children

  if (node.type.prototype?.isReactComponent) {
    const instance = new node.type(props)
    instance.props = props
    return render(instance.render())
  }
  return render(node.type(props))
}

function renderWith(seed, component) {
  hookIndex = 0
  hookSeed = seed
  return render(ReactStub.createElement(component, {}))
}

// ------------------------------------------------------------------ fixtures

const STATUS_OK = {
  authenticated: true,
  user: { id: 'fixture_user_id', name: '示例用户', username: 'fixture', email: 'fixture@example.com' },
  authFile: '<user home>\\.atomcode\\auth.toml',
  planType: 'Lite-beta',
  modelsSource: 'server',
  models: [
    { id: 'qwen3.8-27b', contextWindow: 262144, maxTokens: 32000, supportsImages: true, reasoningEfforts: ['low', 'medium', 'xhigh'] },
    { id: 'glm5.3-flash', contextWindow: 512000, maxTokens: 16000, supportsImages: true, reasoningEfforts: ['low', 'high'] },
  ],
  expiresAt: 1795518322,
  shim: 'http://127.0.0.1:28414',
  plan: {
    codingplan_free: {
      plan_name: 'CodingPlan Lite-体验版', plan_type: 'Lite-beta', status: 1,
      claimed_at: '2026-11-17', expires_at: '2026-11-24', remaining_days: 5, total_days: 7,
    },
    current_usage: {
      window_token_limit: 400, window_tokens_used: 12, usage_percent: 3, window_hours: 5,
      reset_at: '2026-11-19T03:31:37', reset_at_display: '03:31', seconds_until_reset: 15105,
      reset_label: '当前窗口结束即重置额度（每 5 小时一个窗口）', usage_status_desc: '当前时间窗口用量约 3%',
    },
    rate_limit_windows: [{
      rule_index: 0, show_enable: 1, window_size_seconds: 18000, window_hours: 5,
      call_limit: 400, calls_used: 12, usage_percent: 3, quota_exhausted: false,
      reset_at: '2026-11-19T03:31:37', reset_at_display: '03:31', seconds_until_reset: 15105,
      reset_label: '当前窗口结束即重置额度（每 5 小时一个窗口）',
    }],
    audit_status: 1,
  },
}

const USAGE_OK = {
  days: 60, start_date: '2026-09-21', end_date: '2026-11-19',
  models: ['glm5.3-flash', 'qwen3.8-27b'],
  rows: [
    { date: '2026-09-21', model_counts: { 'glm5.3-flash': 7 }, model_tokens: { 'glm5.3-flash': 900 }, total_counts: 7, total_tokens: 900 },
    { date: '2026-11-18', model_counts: { 'qwen3.8-27b': 82 }, model_tokens: { 'qwen3.8-27b': 2595614 }, total_counts: 82, total_tokens: 2595614 },
  ],
  model_counts: { 'glm5.3-flash': 1702, 'qwen3.8-27b': 82 },
  model_tokens: { 'glm5.3-flash': 182667197, 'qwen3.8-27b': 2595614 },
  total_counts: 1784, total_tokens: 185262811,
}

// ------------------------------------------------------------------- load it

let loaded
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      loaded = registration
    },
  },
}

new Function('window', 'require', source)(globalThis.window, name => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
})

check('bundle called __ModuleLoader__.load', loaded !== undefined)
check('bundle id is dsh-atomcode', loaded?.id === 'dsh-atomcode', loaded?.id)

const exported = loaded?.factory(name => {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require: ${name}`)
})

check('exports.name', exported?.name === 'dsh-atomcode-client', exported?.name)
check('inject includes slots', Array.isArray(exported?.inject) && exported.inject.includes('slots'), exported?.inject)
check('exports.apply is a function', typeof exported?.apply === 'function')

// ------------------------------------------------------------- slot wiring

const registrations = []
const ctx = {
  slots: {
    inject(slot, callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    register(entry, component) {
      registrations.push({ slot: entry.name, entry, component })
      return () => {}
    },
  },
}

exported.apply(ctx)

const bySlot = name => registrations.filter(row => row.slot === name)
check('sidebar.panellist registered once', bySlot('sidebar.panellist').length === 1)
check('main registered once', bySlot('main').length === 1)
check('settings.section registered once', bySlot('settings.section').length === 1)
check('sidebar id is dsh-atomcode', bySlot('sidebar.panellist')[0]?.entry.id === 'dsh-atomcode')
check('sidebar order is 60', bySlot('sidebar.panellist')[0]?.entry.order === 60)
check('sidebar label is AtomCode', bySlot('sidebar.panellist')[0]?.entry.label === 'AtomCode')
check('main key is dsh-atomcode', bySlot('main')[0]?.entry.key === 'dsh-atomcode')
check('settings section id is dsh-atomcode', bySlot('settings.section')[0]?.entry.id === 'dsh-atomcode')

// -------------------------------------------------------------- render paths

const PanelPage = bySlot('main')[0]?.component
check('main panel component is a function', typeof PanelPage === 'function')

/** hooks 顺序：useAtomCodeData → [data, tick]；PanelPage → [busy, notice]。 */
const seedFor = data => [data, 0, '', null]

const loadingText = renderWith(seedFor({ loading: true, status: null, usage: null, error: null, reload() {} }), PanelPage)
check('loading state renders header', loadingText.includes('AtomGit AtomCode'))
check('loading state shows 未登录', loadingText.includes('未登录'))

const errorText = renderWith(seedFor({ loading: false, status: null, usage: null, error: '连不上宿主：ECONNREFUSED', reload() {} }), PanelPage)
check('error state surfaces the message', errorText.includes('ECONNREFUSED'))

const okText = renderWith(seedFor({ loading: false, status: STATUS_OK, usage: USAGE_OK, error: null, reload() {} }), PanelPage)
check('panel shows plan name', okText.includes('CodingPlan Lite-体验版'), okText.includes('CodingPlan Lite-体验版'))
check('panel shows account', okText.includes('示例用户'))
check('panel shows window usage', okText.includes('12 / 400'))
check('panel shows 60-day tokens', okText.includes('1.85 亿'), okText.includes('1.85 亿'))
check('panel lists models', okText.includes('qwen3.8-27b') && okText.includes('glm5.3-flash'))
check('panel shows reasoning levels', okText.includes('xhigh'))
check('panel shows shim address', okText.includes('127.0.0.1:28414'))

const emptyText = renderWith(seedFor({ loading: false, status: { authenticated: false, models: [], plan: null }, usage: null, error: null, reload() {} }), PanelPage)
check('empty state prompts login', emptyText.includes('登录'))
check('empty state shows 未领取', emptyText.includes('未领取'))

// ------------------------------------------------------------- error boundary

const internals = exported?.__internals ?? {}
check('internals exposed for tests', typeof internals.PanelBoundary === 'function')
if (typeof internals.PanelBoundary === 'function') {
  const instance = new internals.PanelBoundary({ children: null })
  instance.state = { error: new Error('boom: rows.map is not a function') }
  const crashText = render(instance.render())
  check('crash view titles the failure', crashText.includes('面板渲染出错'))
  check('crash view shows the stack', crashText.includes('rows.map is not a function'))
}

// -------------------------------------------------------------------- report

let failed = 0
for (const row of checks) {
  if (!row.ok) failed += 1
  console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.detail === undefined ? '' : ` → ${JSON.stringify(row.detail)}`}`)
}
console.log(failed === 0 ? `\nclient ok (${checks.length} checks)` : `\n${failed} check(s) failed`)
process.exitCode = failed === 0 ? 0 : 1