import test from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackHost, routeAccessError, REQUIRES_ORIGIN } from '../lib/access.js'

test('isLoopbackHost accepts loopback hosts with any port', () => {
  for (const value of ['127.0.0.1:10859', 'localhost:80', '127.0.0.1', '[::1]:8080', 'http://127.0.0.1:10859', 'https://localhost']) {
    assert.equal(isLoopbackHost(value), true, value)
  }
})

test('isLoopbackHost rejects foreign and malformed hosts', () => {
  for (const value of ['attacker.example', 'evil.com:80', '127.0.0.1.attacker.example', '127.0.0.2', '', '   ', 'null', 'http://[fe80::1]:80', undefined, null]) {
    assert.equal(isLoopbackHost(value), false, String(value))
  }
})

test('isLoopbackHost canonicalizes exotic IPv4 spellings to loopback (safe: same machine)', () => {
  // WHATWG URL 把 0177.0.0.1 规范化成 127.0.0.1——语义上仍是本机回环，接受是安全的
  assert.equal(isLoopbackHost('0177.0.0.1:10859'), true)
})

test('routeAccessError rejects rebound Host even from loopback address', () => {
  const req = { headers: { host: 'attacker.example' } }
  assert.match(routeAccessError(req, false), /Host/)
})

test('routeAccessError allows local tools without Origin', () => {
  const req = { headers: { host: '127.0.0.1:10859' } }
  assert.equal(routeAccessError(req, false), undefined)
})

test('routeAccessError rejects cross-site Origin (browser page calling the API)', () => {
  const req = { headers: { host: '127.0.0.1:10859', origin: 'https://evil.example' } }
  assert.match(routeAccessError(req, false), /Origin/)
  assert.match(routeAccessError(req, true), /Origin/)
})

test('routeAccessError accepts the GUI origin', () => {
  const req = { headers: { host: '127.0.0.1:10859', origin: 'http://127.0.0.1:10859' } }
  assert.equal(routeAccessError(req, false), undefined)
  assert.equal(routeAccessError(req, true), undefined)
})

test('routeAccessError requires Origin for quota-burning debug routes', () => {
  assert.ok(REQUIRES_ORIGIN.has('/api/atomcode/chat'))
  assert.ok(REQUIRES_ORIGIN.has('/api/atomcode/probe'))
  const req = { headers: { host: 'localhost:80' } }
  assert.match(routeAccessError(req, true), /Origin/)
  assert.equal(routeAccessError(req, false), undefined)
})

test('routeAccessError rejects Origin: null (sandboxed iframe)', () => {
  const req = { headers: { host: '127.0.0.1:10859', origin: 'null' } }
  assert.match(routeAccessError(req, false), /Origin/)
})
