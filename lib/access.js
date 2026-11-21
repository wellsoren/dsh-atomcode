/**
 * `/api/atomcode/*` 路由的访问检查。
 *
 * 只靠 `remoteAddress` 回环判断是不够的：
 *   - DNS rebinding：`attacker.example` 解析到 127.0.0.1 后，浏览器同源读取路由响应；
 *   - 跨站调用：浏览器里打开的任意网页可以对回环地址发 `fetch` / 表单 POST。
 *
 * 因此与 dsh-codearts 的做法一致（`hostIsLoopback` + `originIsLoopback`）：
 *   - `Host` 头必须是本机回环主机名；
 *   - 请求带了 `Origin` 头时，它也必须是本机回环主机名
 *     （浏览器跨站请求总会带 Origin，非浏览器本地工具不带，照常放行）；
 *   - 会被 `<img>` 这类 no-cors GET 触发的副作用接口额外要求必须带本机 Origin。
 *
 * @module dsh-atomcode/access
 */

/** 会触发模型调用、可能消耗额度的调试接口：必须带本机 Origin 才放行。 */
export const REQUIRES_ORIGIN = new Set(['/api/atomcode/chat', '/api/atomcode/probe'])

/** 判定 Host / Origin 头是否指向本机回环（127.0.0.1 / localhost / ::1，忽略端口与 IPv6 方括号）。 */
export function isLoopbackHost(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return false
  let host
  try {
    host = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

/**
 * 计算一条请求的访问拒绝原因；返回 `undefined` 表示放行。
 *
 * @param {{ headers?: Record<string, string | undefined> }} req
 * @param {boolean} requireOrigin 为 true 时缺少本机 Origin 也算拒绝
 * @returns {string | undefined}
 */
export function routeAccessError(req, requireOrigin) {
  if (!isLoopbackHost(req.headers?.host)) return 'Host 不是本机回环地址'
  const origin = req.headers?.origin
  if (!origin) return requireOrigin ? '缺少本机 Origin 头' : undefined
  return isLoopbackHost(origin) ? undefined : 'Origin 不是本机回环地址'
}
