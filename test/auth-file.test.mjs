import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthSession, AuthStore, writeAuthFile } from '../lib/auth.js'
import * as sign from '../lib/sign.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 子进程环境：先摘掉可能被外部 shell 设过的覆盖变量，避免测试受环境影响。 */
const BASE_ENV = { ...process.env }
delete BASE_ENV.ATOMCODE_CLIENT_VERSION
delete BASE_ENV.ATOMCODE_MASTER_KEY

const session = new AuthSession({
  accessToken: 'new-token',
  refreshToken: 'new-refresh',
  expiresIn: 3600,
  createdAt: 1_700_000_000,
  user: { id: 'u1', username: 'tester', name: 'Tester' },
})

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), 'atomcode-auth-'))
  return { dir, file: join(dir, 'auth.toml') }
}

test('auth.toml 原子写：无残留临时文件、权限 0600', () => {
  const { dir, file } = tempFile()
  writeFileSync(file, 'access_token = "old"\n', { mode: 0o644 })

  writeAuthFile(session, file)

  const text = readFileSync(file, 'utf8')
  assert.match(text, /access_token = "new-token"/)
  assert.match(text, /refresh_token = "new-refresh"/)
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp-')), [])
  if (process.platform !== 'win32') {
    assert.equal(statSync(file).mode & 0o777, 0o600, '共有 auth.toml 不应留 0644')
  }
})

test('AuthStore.purge 清除磁盘登录态；clear 只清内存', () => {
  const { file } = tempFile()
  writeAuthFile(session, file)

  const store = new AuthStore({ file })
  assert.equal(store.current()?.accessToken, 'new-token')

  store.clear()
  assert.equal(store.current(), undefined)
  assert.equal(store.reload()?.accessToken, 'new-token', 'clear 不应动磁盘')

  store.purge()
  assert.equal(store.current(), undefined)
  assert.equal(existsSync(file), false)
  assert.equal(store.reload(), undefined)
})

test('MASTER_KEY 不再作为模块 API 导出', () => {
  assert.equal('MASTER_KEY' in sign, false)
  assert.equal(typeof sign.signRequest, 'function')
})

test('ATOMCODE_CLIENT_VERSION / ATOMCODE_MASTER_KEY 可覆盖', () => {
  const script = "import { CLIENT_VERSION, signRequest } from './lib/sign.js';"
    + "const { headers } = signRequest({ method: 'POST', path: '/v1/chat/completions',"
    + " body: '{}', token: 't', userId: 'u', timestamp: 1_700_000_000,"
    + " nonce: Buffer.alloc(16) });"
    + "process.stdout.write(CLIENT_VERSION + ' ' + headers['x-atomcode-sig']);"

  const run = env => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: ROOT,
    env: { ...BASE_ENV, ...env },
    encoding: 'utf8',
  })

  const plain = run({})
  assert.equal(plain.status, 0, plain.stderr)
  const [version, signature] = plain.stdout.split(' ')
  assert.equal(version, '5.2.7')

  const overridden = run({ ATOMCODE_CLIENT_VERSION: '9.9.9' })
  assert.equal(overridden.status, 0, overridden.stderr)
  const [version2, signature2] = overridden.stdout.split(' ')
  assert.equal(version2, '9.9.9')
  assert.notEqual(signature2, signature, '版本进签名盐，必须改变签名')

  const badKey = run({ ATOMCODE_MASTER_KEY: 'abcd' })
  assert.notEqual(badKey.status, 0)
  assert.match(badKey.stderr, /32 字节/)
})