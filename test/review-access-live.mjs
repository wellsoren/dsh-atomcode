// 独立复审：对运行中的 dsh-atomcode v0.2.1 路由做对抗性访问控制探测。
// 只读探测，不触发真实模型调用（/chat 仅测拒绝路径）。
const BASE = 'http://127.0.0.1:10859'
const results = []

async function probe(name, path, { method = 'GET', headers = {}, expect }) {
  try {
    const res = await fetch(BASE + path, { method, headers, redirect: 'manual' })
    const ok = res.status === expect
    results.push({ name, status: res.status, expect, ok })
    console.log(`${ok ? 'PASS' : 'FAIL'} [${res.status}/${expect}] ${name}`)
    if (!ok) {
      const body = await res.text().catch(() => '')
      console.log('   body:', body.slice(0, 200))
    }
  } catch (e) {
    results.push({ name, error: String(e), ok: false })
    console.log(`FAIL [error] ${name}: ${e.message}`)
  }
}

// --- 正常路径（GUI 同源） ---
await probe('GUI GET status (no Origin, curl-like)', '/api/atomcode/status', { expect: 200 })
await probe('GUI GET status with loopback Origin', '/api/atomcode/status', { headers: { Origin: 'http://127.0.0.1:10859' }, expect: 200 })
await probe('GUI GET usage with loopback Origin', '/api/atomcode/usage', { headers: { Origin: 'http://127.0.0.1:10859' }, expect: 200 })
await probe('localhost Host GET status', '/api/atomcode/status', { headers: { Host: 'localhost:10859' }, expect: 200 })
await probe('GET /login state (read-only)', '/api/atomcode/login', { headers: { Origin: 'http://localhost:10859' }, expect: 200 })

// --- DNS rebinding：Host 换成攻击者域名 ---
// 注意：fetch 会静默丢弃 Host 头（forbidden header），这三项改由 review-access-raw.mjs 用原始 socket 验证。
// 这里保留跨站 Origin 版本（Origin 是 fetch 允许设置的）。
await probe('rebound Origin GET status', '/api/atomcode/status', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('rebound Origin GET usage', '/api/atomcode/usage', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('rebound Origin POST logout', '/api/atomcode/logout', { method: 'POST', headers: { Origin: 'http://attacker.example' }, expect: 403 })

// --- 跨站 Origin（浏览器 fetch / 表单 POST 必带） ---
for (const origin of ['https://evil.example', 'http://evil.example:10859', 'null', 'file://', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example', 'http://127.0.0.1@evil.example', 'http://evil.example#@127.0.0.1']) {
  await probe(`foreign Origin GET status: ${origin}`, '/api/atomcode/status', { headers: { Origin: origin }, expect: 403 })
}
await probe('foreign Origin POST logout', '/api/atomcode/logout', { method: 'POST', headers: { Origin: 'https://evil.example' }, expect: 403 })
await probe('foreign Origin POST claim', '/api/atomcode/claim', { method: 'POST', headers: { Origin: 'https://evil.example' }, expect: 403 })
await probe('foreign Origin POST login', '/api/atomcode/login', { method: 'POST', headers: { Origin: 'https://evil.example' }, expect: 403 })
await probe('foreign Origin POST refresh', '/api/atomcode/refresh', { method: 'POST', headers: { Origin: 'https://evil.example' }, expect: 403 })

// --- no-cors GET 驱动（<img>/<script> 不带 Origin）：烧额度接口必须拒 ---
await probe('no-Origin GET /chat (img drive-by)', '/api/atomcode/chat?model=qwen3.8-27b', { expect: 403 })
await probe('no-Origin GET /probe', '/api/atomcode/probe?model=qwen3.8-27b', { expect: 403 })
await probe('foreign Origin GET /chat', '/api/atomcode/chat?model=qwen3.8-27b', { headers: { Origin: 'https://evil.example' }, expect: 403 })
await probe('rebound Host GET /chat', '/api/atomcode/chat?model=qwen3.8-27b', { headers: { Host: 'attacker.example' }, expect: 403 })

// --- 路径规范化绕过：exact 匹配基于 URL pathname ---
// 点段被规范化后仍命中 exact 表并过访问检查（403）；未命中的变体落到宿主鉴权层（401）。
await probe('trailing slash /status/ (host auth layer)', '/api/atomcode/status/', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('dot segment /./status (normalized, gated)', '/api/atomcode/./status', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('percent-encoded /%73tatus (host auth layer)', '/api/atomcode/%73tatus', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('double slash //status (host auth layer)', '/api/atomcode//status', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('case variant /STATUS (host auth layer)', '/api/atomcode/STATUS', { headers: { Origin: 'http://attacker.example' }, expect: 403 })
await probe('query on chat no-Origin', '/api/atomcode/chat?x=1', { expect: 403 })

// --- Host 头畸形/混淆：fetch 丢弃 Host，全部移到 review-access-raw.mjs ---

// --- Origin 混淆 ---
await probe('Origin https loopback (scheme differs)', '/api/atomcode/status', { headers: { Origin: 'https://127.0.0.1:10859' }, expect: 200 })
await probe('Origin with path', '/api/atomcode/status', { headers: { Origin: 'http://127.0.0.1:10859/evil' }, expect: 200 })
await probe('Origin uppercase host', '/api/atomcode/status', { headers: { Origin: 'http://LOCALHOST:10859' }, expect: 200 })
await probe('Origin chrome-extension', '/api/atomcode/status', { headers: { Origin: 'chrome-extension://abcdef' }, expect: 403 })

const fails = results.filter(r => !r.ok)
console.log(`\n${results.length - fails.length}/${results.length} passed`)
if (fails.length) process.exitCode = 1
