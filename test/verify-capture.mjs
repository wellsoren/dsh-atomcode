/**
 * 用真实抓包校验签名实现。
 *
 *   ATOMCODE_TEST_TOKEN=... ATOMCODE_TEST_USER=... node test/verify-capture.mjs capture-log.jsonl
 *
 * `capture-log.jsonl` 是从官方 CLI 抓的请求（每行 `{method, path, headers, body}`）。
 * 这两样东西都**不入库**：token 会过期，抓包里还带着你的账号信息。
 */

import { readFileSync } from 'node:fs'
import { signRequest } from '../lib/sign.js'

const TOKEN = process.env.ATOMCODE_TEST_TOKEN
const USER = process.env.ATOMCODE_TEST_USER
const file = process.argv[2]

if (!file || !TOKEN || !USER) {
  console.log('skip: needs <capture.jsonl> ATOMCODE_TEST_TOKEN ATOMCODE_TEST_USER')
  process.exit(0)
}

let ok = 0
let total = 0
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const e = JSON.parse(line)
  if (e.method !== 'POST') continue
  total++
  const got = signRequest({
    method: e.method,
    path: e.path,
    body: e.body,
    token: TOKEN,
    userId: USER,
    timestamp: Number(e.headers['x-atomcode-ts']),
    nonce: Buffer.from(e.headers['x-atomcode-nonce'], 'hex'),
    version: e.headers['x-atomcode-ver'],
  })
  const want = e.headers['x-atomcode-sig']
  if (got.sig === want) ok++
  else console.log('FAIL', e.headers['x-atomcode-ts'], got.sig, want)
}
console.log(`matched ${ok}/${total}`)
process.exitCode = ok === total ? 0 : 1