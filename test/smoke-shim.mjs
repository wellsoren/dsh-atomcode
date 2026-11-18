/**
 * 端到端冒烟：不经过 DSH，直接起签名代理并打一次真实网关。
 *
 *   node test/smoke-shim.mjs
 *
 * 需要 `~/.atomcode/auth.toml` 里有有效登录态（或 `ATOMCODE_HOME` 指向它）。
 */

import { AuthStore } from '../lib/auth.js'
import { ModelCatalog } from '../lib/catalog.js'
import { SigningShim } from '../lib/shim.js'

const auth = new AuthStore()
const session = await auth.ensure()
if (!session) {
  console.error('没有可用的 AtomGit 登录态，请先 `atomcode login`。')
  process.exit(1)
}
console.log('登录态：', session.user.username, `(${session.userId})`)

const catalog = new ModelCatalog({ auth, log: console.error })
console.log('模型刷新：', await catalog.refresh(), catalog.current().map(model => model.id).join(', '))

const shim = new SigningShim({ auth, llmBase: 'https://llm-api.atomgit.com/v1', models: () => catalog.current(), log: console.error })
const base = await shim.start()
console.log('shim：', base)

const body = JSON.stringify({
  model: 'qwen3.8-27b',
  messages: [{ role: 'user', content: '只回复两个字：收到' }],
  max_tokens: 32,
  stream: true,
})

const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { authorization: `Bearer ${shim.token()}`, 'content-type': 'application/json', accept: 'text/event-stream' },
  body,
})
console.log('HTTP', res.status, res.headers.get('content-type'))
const text = await res.text()
console.log(text.slice(0, 800))

await shim.dispose()