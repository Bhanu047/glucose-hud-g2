// Tests the Cloudflare Worker relay with stubbed upstreams.
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import worker, { parseLibreTimestamp } from '../relay/worker.js'

const realFetch = globalThis.fetch
let calls = []
let handler = null

beforeEach(() => {
  calls = []
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, init })
    return handler(u, init)
  }
})
afterEach(() => {
  globalThis.fetch = realFetch
  handler = null
})

const jres = (body, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const get = q => worker.fetch(new Request(`https://relay.test${q}`))
const post = (path, body) =>
  worker.fetch(new Request(`https://relay.test${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }))

/* ---------------- Nightscout ---------------- */

test('nightscout: forwards, caps count at 300, slims fields', async () => {
  handler = () => jres([{ sgv: 123, direction: 'Flat', date: 1000, secret: 'x' }])
  const res = await get('/entries?ns=https://ns.example.com/&count=999&token=abc')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('access-control-allow-origin'), '*')
  assert.equal(calls[0].url, 'https://ns.example.com/api/v1/entries.json?count=300&token=abc')
  const body = await res.json()
  assert.deepEqual(body, [{ sgv: 123, direction: 'Flat', date: 1000 }])
})

test('nightscout: SSRF guard', async () => {
  handler = () => jres([])
  for (const bad of ['http://ns.example.com', 'https://127.0.0.1', 'https://localhost', 'https://10.0.0.5', 'https://[::1]']) {
    assert.equal((await get(`/entries?ns=${encodeURIComponent(bad)}`)).status, 400, bad)
  }
  assert.equal(calls.length, 0)
})

test('routing and preflight', async () => {
  assert.equal((await worker.fetch(new Request('https://relay.test/libre', { method: 'OPTIONS' }))).status, 204)
  assert.equal((await worker.fetch(new Request('https://relay.test/other'))).status, 404)
  assert.equal((await get('/libre')).status, 405)
})

/* ---------------- LibreLinkUp ---------------- */

test('libre timestamp parser (UTC, 12h clock)', () => {
  assert.equal(parseLibreTimestamp('11/8/2026 5:20:05 AM'), Date.UTC(2026, 10, 8, 5, 20, 5))
  assert.equal(parseLibreTimestamp('11/8/2026 12:00:00 AM'), Date.UTC(2026, 10, 8, 0, 0, 0))
  assert.equal(parseLibreTimestamp('11/8/2026 12:30:00 PM'), Date.UTC(2026, 10, 8, 12, 30, 0))
  assert.ok(Number.isNaN(parseLibreTimestamp('garbage')))
})

function libreServer({ redirectTo = null, badPassword = false, expired = false } = {}) {
  return (u, init) => {
    if (u.endsWith('/llu/auth/login')) {
      if (badPassword) return jres({ status: 2 })
      if (redirectTo && u.startsWith('https://api.libreview.io')) return jres({ status: 0, data: { redirect: true, region: redirectTo } })
      return jres({ status: 0, data: { user: { id: 'user-123' }, authTicket: { token: 'tok-new' } } })
    }
    const auth = init.headers?.Authorization
    if (expired && auth === 'Bearer tok-old') return jres({ message: 'unauthorized' }, 401)
    if (u.endsWith('/llu/connections')) {
      return jres({
        status: 0,
        data: [
          { patientId: 'p1', firstName: 'Ana', lastName: 'Lopez' },
          { patientId: 'p2', firstName: 'Ben', lastName: 'Ng' },
        ],
      })
    }
    if (u.includes('/graph')) {
      return jres({
        status: 0,
        data: {
          connection: { glucoseMeasurement: { ValueInMgPerDl: 142, TrendArrow: 4, FactoryTimestamp: '11/8/2026 5:20:05 AM' } },
          graphData: [
            { ValueInMgPerDl: 120, FactoryTimestamp: '11/8/2026 4:50:05 AM' },
            { ValueInMgPerDl: 130, FactoryTimestamp: '11/8/2026 5:05:05 AM' },
          ],
        },
      })
    }
    return jres({}, 404)
  }
}

test('libre: login → connections → graph, account-id is sha256(user.id), creds not echoed', async () => {
  handler = libreServer()
  const res = await post('/libre', { email: 'a@b.c', password: 'pw' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.entries.length, 3)
  assert.deepEqual(body.entries[0], { sgv: 142, date: Date.UTC(2026, 10, 8, 5, 20, 5), direction: 'FortyFiveUp' })
  assert.equal(body.session.token, 'tok-new')
  const { createHash } = await import('node:crypto')
  assert.equal(body.session.accountId, createHash('sha256').update('user-123').digest('hex'))
  assert.deepEqual(body.connections, [{ patientId: 'p1', name: 'Ana L.' }, { patientId: 'p2', name: 'Ben N.' }])
  assert.equal(JSON.stringify(body).includes('pw'), false)
  const connCall = calls.find(c => c.url.endsWith('/llu/connections'))
  assert.equal(connCall.init.headers['account-id'], body.session.accountId)
  assert.equal(connCall.init.headers.version, '4.16.0')
})

test('libre: picks requested patient', async () => {
  handler = libreServer()
  await post('/libre', { email: 'a@b.c', password: 'pw', patientId: 'p2' })
  assert.ok(calls.some(c => c.url.includes('/connections/p2/graph')))
})

test('libre: follows region redirect once', async () => {
  handler = libreServer({ redirectTo: 'eu' })
  const body = await (await post('/libre', { email: 'a@b.c', password: 'pw' })).json()
  assert.equal(body.session.region, 'eu')
  assert.ok(calls.some(c => c.url.startsWith('https://api-eu.libreview.io/llu/connections')))
})

test('libre: reuses token without logging in; expired token + no creds → auth_required', async () => {
  handler = libreServer({ expired: true })
  const res = await post('/libre', { token: 'tok-old', accountId: 'a'.repeat(64) })
  assert.equal(res.status, 401)
  assert.equal((await res.json()).error, 'auth_required')
  assert.equal(calls.some(c => c.url.endsWith('/login')), false)
})

test('libre: expired token + creds → re-login transparently', async () => {
  handler = libreServer({ expired: true })
  const res = await post('/libre', { token: 'tok-old', accountId: 'a'.repeat(64), email: 'a@b.c', password: 'pw' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).session.token, 'tok-new')
})

test('libre: wrong password → 401 with message', async () => {
  handler = libreServer({ badPassword: true })
  const res = await post('/libre', { email: 'a@b.c', password: 'nope' })
  assert.equal(res.status, 401)
  assert.match((await res.json()).error, /wrong/i)
})

/* ---------------- Dexcom Share ---------------- */

function dexcomServer({ badPassword = false, expiredSession = null } = {}) {
  return (u, init) => {
    if (u.includes('AuthenticatePublisherAccount')) {
      return badPassword ? jres({ Code: 'AccountPasswordInvalid' }, 500) : jres('"acc-1"')
    }
    if (u.includes('LoginPublisherAccountById')) return jres('"sess-new"')
    if (u.includes('ReadPublisherLatestGlucoseValues')) {
      if (expiredSession && u.includes(`sessionId=${expiredSession}`)) return jres({ Code: 'SessionIdNotFound' }, 500)
      return jres([
        { WT: 'Date(1700000300000)', Value: 101, Trend: 'Flat' },
        { WT: 'Date(1700000000000)', Value: 99, Trend: 4 },
      ])
    }
    return jres({}, 404)
  }
}

test('dexcom: login → readings, trend string and number both handled', async () => {
  handler = dexcomServer()
  const res = await post('/dexcom', { username: 'u', password: 'pw', region: 'ous' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.session.sessionId, 'sess-new')
  assert.deepEqual(body.entries, [
    { sgv: 101, date: 1700000300000, direction: 'Flat' },
    { sgv: 99, date: 1700000000000, direction: 'Flat' },
  ])
  assert.ok(calls[0].url.startsWith('https://shareous1.dexcom.com/'))
  assert.equal(JSON.stringify(body).includes('pw'), false)
})

test('dexcom: expired session re-logs in only when creds are present', async () => {
  handler = dexcomServer({ expiredSession: 'sess-old' })
  assert.equal((await post('/dexcom', { sessionId: 'sess-old' })).status, 401)
  const ok = await post('/dexcom', { sessionId: 'sess-old', username: 'u', password: 'pw' })
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).session.sessionId, 'sess-new')
})

test('dexcom: wrong password → 401', async () => {
  handler = dexcomServer({ badPassword: true })
  assert.equal((await post('/dexcom', { username: 'u', password: 'x' })).status, 401)
})
