// Tests the Cloudflare Worker relay with a stubbed upstream fetch.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../relay/worker.js'

const realFetch = globalThis.fetch
let lastUpstream = null

beforeEach(() => {
  globalThis.fetch = async (url, init) => {
    lastUpstream = { url: String(url), init }
    if (String(url).includes('unauth')) return new Response('nope', { status: 401 })
    return new Response(
      JSON.stringify([{ sgv: 123, direction: 'Flat', date: 1, secret: 'should-not-leak' }]),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
})
afterEach(() => { globalThis.fetch = realFetch })

const req = (q, method = 'GET') => worker.fetch(new Request(`https://relay.test/entries${q}`, { method }))

test('forwards to /api/v1/entries.json with count+token and slims fields', async () => {
  const res = await req('?ns=https://ns.example.com/&count=3&token=abc')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(lastUpstream.url, 'https://ns.example.com/api/v1/entries.json?count=3&token=abc')
  const body = await res.json()
  assert.deepEqual(body, [{ sgv: 123, direction: 'Flat', date: 1 }])
  assert.equal('secret' in body[0], false)
})

test('rejects non-https, raw IPs and localhost (SSRF guard)', async () => {
  for (const bad of ['http://ns.example.com', 'https://127.0.0.1', 'https://localhost', 'https://10.0.0.5', 'https://[::1]']) {
    const res = await req(`?ns=${encodeURIComponent(bad)}`)
    assert.equal(res.status, 400, bad)
  }
})

test('passes through auth failures as 401/403', async () => {
  const res = await req('?ns=https://unauth.example.com')
  assert.equal(res.status, 401)
})

test('handles preflight and bad routes', async () => {
  assert.equal((await req('?ns=https://ns.example.com', 'OPTIONS')).status, 204)
  assert.equal((await req('?ns=https://ns.example.com', 'POST')).status, 405)
  assert.equal((await worker.fetch(new Request('https://relay.test/other'))).status, 404)
  assert.equal((await req('')).status, 400)
})

test('caps count at 10', async () => {
  await req('?ns=https://ns.example.com&count=999')
  assert.match(lastUpstream.url, /count=10/)
})
