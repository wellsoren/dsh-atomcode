/**
 * AtomGit 登录态：读写 AtomCode 的 `auth.toml`，并实现平台 broker 的
 * 登录 / 轮询 / 换取 token / 刷新。
 *
 * 为什么要共用 CLI 的文件：AtomCode 的 refresh token 是**轮换**的，谁刷新谁
 * 就把旧值作废。两个进程各存一份必然互相踢掉对方，所以这里以
 * `~/.atomcode/auth.toml` 为唯一真源：DSH 刷新后写回，CLI 也继续可用（反之
 * 亦然）。
 *
 * @module dsh-atomcode/auth
 */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 官方 CLI 的默认 data dir；`ATOMCODE_HOME` 可覆盖。 */
export function atomcodeHome() {
  return process.env.ATOMCODE_HOME ?? join(homedir(), '.atomcode')
}

export function authFilePath() {
  return join(atomcodeHome(), 'auth.toml')
}

/** 平台 broker（登录、换 token、刷新）。 */
export const DEFAULT_PLATFORM_BASE = 'https://acs.atomgit.com'

/** OAuth 侧请求必须携带的 UA：AtomGit 的网关会拒绝没有它的请求。 */
export const USER_AGENT = 'atomcode/5.2.7'

/** AtomCode 会话；字段名与 `auth.toml` 一致，便于原样写回。 */
export class AuthSession {
  constructor(fields) {
    this.accessToken = fields.accessToken
    this.refreshToken = fields.refreshToken
    this.tokenType = fields.tokenType ?? 'Bearer'
    this.expiresIn = fields.expiresIn
    this.createdAt = fields.createdAt ?? Math.floor(Date.now() / 1000)
    this.user = fields.user ?? {}
  }

  get userId() {
    return this.user.id
  }

  /** 会话是否还有效（留 5 分钟余量）。 */
  get valid() {
    if (!this.accessToken || !this.userId) return false
    if (!this.expiresIn) return true
    return this.createdAt + this.expiresIn - 300 > Math.floor(Date.now() / 1000)
  }

  /** 会话是否已经到必须刷新的地步（提前 10 分钟）。 */
  get shouldRefresh() {
    if (!this.refreshToken) return false
    if (!this.expiresIn) return false
    return this.createdAt + this.expiresIn - 600 <= Math.floor(Date.now() / 1000)
  }
}

/** 极小 TOML 读取器：只认 `key = "value"` / `key = 123` 与 `[section]`。 */
export function parseAuthToml(text) {
  const root = {}
  let section = root
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const header = /^\[(.+)\]$/.exec(line)
    if (header) {
      section = root[header[1]] ??= {}
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*=\s*(.+)$/.exec(line)
    if (!kv) continue
    let value = kv[2].trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    else if (/^-?\d+$/.test(value)) value = Number(value)
    else if (value === 'true') value = true
    else if (value === 'false') value = false
    section[kv[1]] = value
  }
  return root
}

/** 渲染 `auth.toml` 的文本内容（保留 CLI 需要的全部字段）。 */
export function renderAuthToml(session) {
  const q = value => JSON.stringify(String(value))
  const lines = [
    `access_token = ${q(session.accessToken)}`,
    `refresh_token = ${q(session.refreshToken ?? '')}`,
    `token_type = ${q(session.tokenType ?? 'Bearer')}`,
  ]
  if (session.expiresIn !== undefined) lines.push(`expires_in = ${session.expiresIn}`)
  lines.push(`created_at = ${session.createdAt}`)
  lines.push('', '[user]')
  for (const key of ['id', 'username', 'name', 'email', 'avatar_url']) {
    if (session.user?.[key] !== undefined) lines.push(`${key} = ${q(session.user[key])}`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * 把会话写回 `auth.toml`。
 *
 * 两步保证：
 *   - 同目录临时文件 + `rename`，读者要么看到旧文件、要么看到新文件，不会读到半个 TOML
 *     （refresh token 是轮换的，写坏一次就等于掉登录）；
 *   - 文件权限 `0600`；POSIX 下同一台机器的其他用户读不到 token。
 */
export function writeAuthFile(session, file = authFilePath()) {
  const text = renderAuthToml(session)
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch {}
    throw error
  }
  // Windows 上 chmod 只影响只读位；POSIX 上修掉既有文件的宽松权限。
  try { chmodSync(file, 0o600) } catch {}
}

/** 读取磁盘上的登录态；文件不存在或不完整时返回 undefined。 */
export function readAuthSession(file = authFilePath()) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  const parsed = parseAuthToml(text)
  if (!parsed.access_token) return undefined
  return new AuthSession({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token || undefined,
    tokenType: parsed.token_type,
    expiresIn: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    createdAt: typeof parsed.created_at === 'number' ? parsed.created_at : undefined,
    user: {
      id: parsed.user?.id,
      username: parsed.user?.username,
      name: parsed.user?.name,
      email: parsed.user?.email,
      avatar_url: parsed.user?.avatar_url,
    },
  })
}

function headers(extra) {
  return {
    accept: '*/*',
    'user-agent': USER_AGENT,
    ...extra,
  }
}

async function requestJson(url, { method = 'GET', body, signal, token } = {}) {
  const res = await fetch(url, {
    method,
    headers: headers({
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    }),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) {
    const error = new Error(`AtomGit ${method} ${new URL(url).pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`)
    error.status = res.status
    error.body = text
    throw error
  }
  return text === '' ? {} : JSON.parse(text)
}

function sessionFromTokenResponse(raw) {
  return new AuthSession({
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    tokenType: raw.token_type,
    expiresIn: raw.expires_in,
    createdAt: Math.floor(Date.now() / 1000),
    user: raw.user ?? {},
  })
}

/** 发起一次登录：返回浏览器地址与轮询用的 state。 */
export async function startLogin({ platformBase = DEFAULT_PLATFORM_BASE, signal } = {}) {
  const raw = await requestJson(`${platformBase}/auth/login?provider=atomgit`, { signal })
  return { loginUrl: raw.login_url, state: raw.state }
}

/** 轮询一次登录状态。 */
export async function checkLogin(state, { platformBase = DEFAULT_PLATFORM_BASE, signal } = {}) {
  const raw = await requestJson(`${platformBase}/auth/check?state=${encodeURIComponent(state)}`, { signal })
  return { valid: raw.valid === true, user: raw.user ?? undefined }
}

/** 用 state 换 token（仅在 check 返回 valid 后调用）。 */
export async function exchangeToken(state, { platformBase = DEFAULT_PLATFORM_BASE, signal } = {}) {
  const raw = await requestJson(`${platformBase}/auth/token?state=${encodeURIComponent(state)}`, { signal })
  return sessionFromTokenResponse(raw)
}

/** 刷新登录态；返回新会话（refresh token 会轮换）。 */
export async function refreshSession(refreshToken, { platformBase = DEFAULT_PLATFORM_BASE, signal } = {}) {
  const raw = await requestJson(`${platformBase}/oauth/refresh`, {
    method: 'POST',
    body: { refresh_token: refreshToken },
    signal,
  })
  return sessionFromTokenResponse(raw)
}

/**
 * 登录态持有者：内存缓存 + 磁盘同步 + 并发刷新合并。
 */
export class AuthStore {
  constructor({ platformBase = DEFAULT_PLATFORM_BASE, file = authFilePath() } = {}) {
    this.platformBase = platformBase
    this.file = file
    this.session = readAuthSession(file)
    this.pending = undefined
  }

  /** 当前会话（可能为空）。 */
  current() {
    return this.session
  }

  /** 重新读盘（别处登录后无需重启）。 */
  reload() {
    this.session = readAuthSession(this.file)
    return this.session
  }

  save(session) {
    this.session = session
    writeAuthFile(session, this.file)
    return session
  }

  clear() {
    this.session = undefined
  }

  /**
   * 清除磁盘登录态。
   *
   * `auth.toml` 是与 AtomCode CLI 共用的，删掉它 CLI 也会退出登录——所以这是
   * 「退出登录」而不是「断开当前面板」。调用方要把后果告诉用户。
   */
  purge() {
    this.session = undefined
    try {
      unlinkSync(this.file)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }

  /** 取一个可用的会话，必要时自动刷新。 */
  async ensure({ signal } = {}) {
    if (this.session?.valid) return this.session
    if (this.session?.refreshToken) {
      try {
        return await this.refresh({ signal })
      } catch (error) {
        if (error.status !== 400 && error.status !== 401 && error.status !== 502) throw error
      }
    }
    const fresh = this.reload()
    if (fresh?.valid) return fresh
    return undefined
  }

  /** 刷新（并发调用共享同一次网络请求）。 */
  async refresh({ signal } = {}) {
    if (this.pending) return this.pending
    const session = this.session ?? this.reload()
    if (!session?.refreshToken) throw new Error('AtomGit 登录态缺少 refresh_token，请重新登录')
    this.pending = refreshSession(session.refreshToken, { platformBase: this.platformBase, signal })
      .then(next => this.save(next))
      .finally(() => { this.pending = undefined })
    return this.pending
  }

  /** 完整登录：返回 loginUrl 与一个在后台轮询的 promise。 */
  async login({ signal, onUrl, pollIntervalMs = 2000, timeoutMs = 180_000 } = {}) {
    const { loginUrl, state } = await startLogin({ platformBase: this.platformBase, signal })
    onUrl?.(loginUrl)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error('登录已取消')
      const { valid } = await checkLogin(state, { platformBase: this.platformBase, signal })
      if (valid) {
        const session = await exchangeToken(state, { platformBase: this.platformBase, signal })
        return this.save(session)
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    throw new Error('登录超时：请在浏览器完成 AtomGit 授权后重试')
  }
}