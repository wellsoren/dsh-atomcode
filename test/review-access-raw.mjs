// 原始 socket 探测：fetch 会静默丢弃 Host 等禁止头，必须手写 HTTP 请求。
// 同时把 logout 的副作用恢复（重新登录态由 auth.toml 决定，logout 只清内存/文件，需检查）。
import { connect } from 'node:net'

const PORT = 10859

function rawRequest({ method = 'GET', path = '/api/atomcode/status', headers = {} }) {
  return new Promise((resolve, reject) => {
    const sock = connect(PORT, '127.0.0.1', () => {
      const lines = [`${method} ${path} HTTP/1.1`, `Host: ${headers.Host ?? '127.0.0.1:' + PORT}`]
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === 'host') continue
        lines.push(`${k}: ${v}`)
      }
      lines.push('Connection: close', '', '')
      sock.write(lines.join('\r\n'))
    })
    let data = ''
    sock.on('data', chunk => { data += chunk })
    sock.on('end', () => {
      const status = Number(data.split('\r\n')[0]?.split(' ')[1] ?? 0)
      const body = data.slice(data.indexOf('\r\n\r\n') + 4)
      resolve({ status, body: body.slice(0, 160) })
    })
    sock.on('error', reject)
    setTimeout(() => { sock.destroy(); reject(new Error('timeout')) }, 15000)
  })
}

const cases = [
  // DNS rebinding：真实浏览器会带 Host: attacker.example（fetch 做不到，raw 可以）
  { name: 'rebound Host GET status', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'rebound Host GET usage', path: '/api/atomcode/usage', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'rebound Host + loopback Origin GET status', headers: { Host: 'attacker.example', Origin: 'http://attacker.example' }, expect: 403 },
  // Host 混淆：WHATWG URL 会把 userinfo 剥掉、把整数/短式 IPv4 规范化成 127.0.0.1，
  // 这些写法语义上仍指向本机回环（与 0177.0.0.1 同理），接受是安全的，不是绕过。
  { name: 'Host userinfo user@127.0.0.1 (normalizes to loopback)', headers: { Host: 'user@127.0.0.1:10859' }, expect: 200 },
  { name: 'Host 127.0.0.1.evil.example', headers: { Host: '127.0.0.1.evil.example' }, expect: 403 },
  { name: 'Host 2130706433 (integer IP = 127.0.0.1)', headers: { Host: '2130706433' }, expect: 200 },
  { name: 'Host localhost.evil.example', headers: { Host: 'localhost.evil.example' }, expect: 403 },
  { name: 'Host 127.0.0.1:10859@evil.example', headers: { Host: '127.0.0.1:10859@evil.example' }, expect: 403 },
  { name: 'Host trailing dot 127.0.0.1. (not loopback per URL)', headers: { Host: '127.0.0.1.' }, expect: 200 },
  { name: 'Host localhost trailing dot', headers: { Host: 'localhost.' }, expect: 403 },
  { name: 'Host [::1] bracketed', headers: { Host: '[::1]:10859' }, expect: 200 },
  { name: 'Host 0177.0.0.1 octal', headers: { Host: '0177.0.0.1' }, expect: 200 },
  { name: 'Host 127.1 short form (= 127.0.0.1)', headers: { Host: '127.1' }, expect: 200 },
  // 路径规范化（exact 表基于 URL pathname）：点段会被规范化后命中 exact 表，
  // 命中后仍要过访问检查（403）；未命中的变体落到宿主 401/404，同样不放行。
  { name: 'dot segment /./status rebound (normalized, still gated)', path: '/api/atomcode/./status', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'dotdot /chat/../status rebound (normalized, still gated)', path: '/api/atomcode/chat/../status', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'percent /%73tatus rebound (no exact match, host 403)', path: '/api/atomcode/%73tatus', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'trailing slash rebound (no exact match, host 403)', path: '/api/atomcode/status/', headers: { Host: 'attacker.example' }, expect: 403 },
  { name: 'double slash rebound (no exact match, host 403)', path: '/api/atomcode//status', headers: { Host: 'attacker.example' }, expect: 403 },
  // 无 Origin 的烧额度接口
  { name: 'no-Origin GET /chat', path: '/api/atomcode/chat?model=qwen3.8-27b', expect: 403 },
  { name: 'no-Origin GET /probe', path: '/api/atomcode/probe?model=qwen3.8-27b', expect: 403 },
  // 正常
  { name: 'normal GET status', expect: 200 },
  { name: 'localhost Host GET status', headers: { Host: 'localhost:10859' }, expect: 200 },
]

let pass = 0
for (const c of cases) {
  try {
    const r = await rawRequest(c)
    const ok = r.status === c.expect
    if (ok) pass++
    console.log(`${ok ? 'PASS' : 'FAIL'} [${r.status}/${c.expect}] ${c.name}${ok ? '' : ' | ' + r.body.replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`FAIL [error] ${c.name}: ${e.message}`)
  }
}
console.log(`\n${pass}/${cases.length} passed`)
if (pass !== cases.length) process.exitCode = 1
