import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalString, canonicalChatPath, signRequest } from '../lib/sign.js'
import { parseAuthToml, AuthSession } from '../lib/auth.js'
import { normalizeModel } from '../lib/catalog.js'

test('规范化签名串', () => {
  const text = canonicalString({
    method: 'post',
    path: '/v1/chat/completions',
    body: Buffer.from('{"model":"x"}'),
    timestamp: 1_700_000_000,
    nonce: Buffer.from([...Array(16).keys()]),
  })
  assert.equal(text, [
    'v1',
    'POST',
    '/v1/chat/completions',
    '1700000000',
    '000102030405060708090a0b0c0d0e0f',
    '78b0e11c6754fc9671c2034f4a068d3a0e53c1c22a5a33900dd46bc8cd9136f3',
  ].join('\n'))
})

test('签名向量（与独立实现逐字节一致）', () => {
  const { sig, headers } = signRequest({
    method: 'POST',
    path: '/v1/chat/completions',
    body: '{"model":"x"}',
    token: 'test-token',
    userId: 'user-123',
    timestamp: 1_700_000_000,
    nonce: Buffer.from([...Array(16).keys()]),
    version: '5.2.7', // 显式固定：默认值可被 ATOMCODE_CLIENT_VERSION 覆盖，向量不能随之漂移
  })
  assert.equal(sig, 'v1:cf696cb3f572d744f646dfbd10c6b81b09a049187dd915d518776bbe05554839')
  assert.equal(headers['x-atomcode-alg'], '1')
  assert.equal(headers['x-atomcode-ver'], '5.2.7')
  assert.equal(headers['x-atomcode-ts'], '1700000000')
})

test('规范化路径', () => {
  assert.equal(canonicalChatPath('https://llm-api.atomgit.com/v1'), '/v1/chat/completions')
  assert.equal(canonicalChatPath('https://llm-api.atomgit.com/v1/'), '/v1/chat/completions')
  assert.equal(canonicalChatPath('https://llm-api.atomgit.com'), '/chat/completions')
})

test('解析 auth.toml', () => {
  const parsed = parseAuthToml([
    'access_token = "abc"',
    'refresh_token = "def"',
    'token_type = "Bearer"',
    'expires_in = 600',
    'created_at = 1700000000',
    '',
    '[user]',
    'id = "u1"',
    'username = "tester"',
  ].join('\n'))
  assert.equal(parsed.access_token, 'abc')
  assert.equal(parsed.expires_in, 600)
  assert.equal(parsed.user.username, 'tester')

  const session = new AuthSession({
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    expiresIn: parsed.expires_in,
    createdAt: parsed.created_at,
    user: parsed.user,
  })
  assert.equal(session.userId, 'u1')
  assert.equal(session.valid, false, '过期会话不应被判为有效')
})

test('模型条目规整', () => {
  const model = normalizeModel({
    id: 2052994857682014216,
    display_model_name: 'qwen3.8-27b',
    context_window: 262_144,
    max_tokens: 32_000,
    supports_vision: true,
    reasoning_effort_levels: ['low', 'medium', 'xhigh'],
    plan_available: true,
  })
  assert.equal(model.id, 'qwen3.8-27b')
  assert.equal(model.contextWindow, 262_144)
  assert.equal(model.supportsImages, true)
  assert.deepEqual(model.reasoningEfforts, ['low', 'medium', 'xhigh'])

  const small = normalizeModel({ id: 1, display_model_name: 'tiny', context_window: 8_000 })
  assert.equal(small.contextWindow, 128_000, '小于 128k 的上下文要抬到下限')
})