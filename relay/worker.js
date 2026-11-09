/**
 * Glucose HUD relay — Cloudflare Worker (free tier is plenty).
 *
 * Why this exists: Even Hub plugins may only contact origins listed in
 * app.json (no wildcards), and every user's data lives somewhere different.
 * The plugin calls this one fixed origin; the relay forwards to the user's
 * own Nightscout, or to LibreLinkUp / Dexcom Share.
 *
 * Privacy: stateless. Nothing is logged or stored. Credentials arrive in a
 * POST body over HTTPS, are used for that one request, and are dropped.
 * Session tokens are handed back to the plugin, which keeps them on the
 * phone and sends them next time so we don't log in on every poll.
 *
 * Routes (all respond with JSON, CORS-enabled):
 *   GET  /entries?ns=https://my.nightscout.site&count=N[&token=...]
 *   POST /libre   {email?, password?, region?, token?, accountId?, patientId?}
 *   POST /dexcom  {username?, password?, region: us|ous|jp, sessionId?}
 *
 * Every route returns entries as [{sgv, direction, date}] newest first.
 * A 401 with {error:"auth_required"} means "send credentials and retry".
 */

const MAX_COUNT = 300
const UPSTREAM_TIMEOUT_MS = 10000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  })
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function upstream(url, init = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal, redirect: 'follow' })
  } catch (e) {
    throw new HttpError(504, e && e.name === 'AbortError' ? 'upstream timeout' : 'upstream unreachable')
  } finally {
    clearTimeout(t)
  }
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const TREND_NAMES = ['NONE', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown']

function sortEntries(list) {
  const seen = new Set()
  return list
    .filter(e => e && typeof e.sgv === 'number' && e.sgv > 0 && Number.isFinite(e.date))
    .sort((a, b) => b.date - a.date)
    .filter(e => (seen.has(e.date) ? false : (seen.add(e.date), true)))
}

/* ------------------------------ Nightscout ------------------------------ */

function isSafeUpstream(u) {
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  // Block raw IPs (private ranges, link-local, loopback) — SSRF hygiene.
  if (/^[\d.]+$/.test(h) || h.includes(':')) return false
  return true
}

async function nightscout(url) {
  const ns = url.searchParams.get('ns')
  if (!ns) throw new HttpError(400, 'missing ns')
  let base
  try {
    base = new URL(ns)
  } catch {
    throw new HttpError(400, 'bad ns url')
  }
  if (!isSafeUpstream(base)) throw new HttpError(400, 'ns must be a public https host')

  const count = Math.min(MAX_COUNT, Math.max(1, Number(url.searchParams.get('count')) || 2))
  const token = url.searchParams.get('token')
  const target = new URL(`${base.origin}${base.pathname.replace(/\/+$/, '')}/api/v1/entries.json`)
  target.searchParams.set('count', String(count))
  if (token) target.searchParams.set('token', token)

  const res = await upstream(target, { headers: { Accept: 'application/json', 'User-Agent': 'glucose-hud-relay/2' } })
  if (res.status === 401 || res.status === 403) throw new HttpError(res.status, 'nightscout rejected token')
  if (!res.ok) throw new HttpError(502, `nightscout http ${res.status}`)
  const data = await readJson(res)
  return Array.isArray(data)
    ? sortEntries(data.map(e => ({ sgv: e.sgv, direction: e.direction, date: e.date, delta: e.delta })))
    : []
}

/* ------------------------------ LibreLinkUp ----------------------------- */

const LIBRE_REGIONS = new Set(['us', 'eu', 'eu2', 'de', 'fr', 'jp', 'ap', 'au', 'ae', 'ca', 'la'])
const LIBRE_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  product: 'llu.android',
  version: '4.16.0',
  'cache-control': 'no-cache',
}
// TrendArrow 1..5 → Nightscout names
const LIBRE_TREND = { 1: 'SingleDown', 2: 'FortyFiveDown', 3: 'Flat', 4: 'FortyFiveUp', 5: 'SingleUp' }

function libreBase(region) {
  return region && LIBRE_REGIONS.has(region) ? `https://api-${region}.libreview.io` : 'https://api.libreview.io'
}

async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** "11/8/2026 5:20:05 AM" (UTC) → epoch ms */
export function parseLibreTimestamp(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) ?(AM|PM)$/i.exec(String(s || '').trim())
  if (!m) return NaN
  let h = Number(m[4]) % 12
  if (/pm/i.test(m[7])) h += 12
  return Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), h, Number(m[5]), Number(m[6]))
}

async function libreLogin(email, password, region) {
  let reg = region
  for (let hop = 0; hop < 2; hop++) {
    const res = await upstream(`${libreBase(reg)}/llu/auth/login`, {
      method: 'POST',
      headers: LIBRE_HEADERS,
      body: JSON.stringify({ email, password }),
    })
    const body = await readJson(res)
    if (res.status === 429 || body?.status === 429) throw new HttpError(429, 'LibreLinkUp login locked — wait a few minutes')
    if (body?.status === 2) throw new HttpError(401, 'wrong LibreLinkUp email or password')
    if (body?.status === 4) throw new HttpError(403, 'open the LibreLinkUp app and accept the latest terms')
    if (body?.status === 920) throw new HttpError(502, 'LibreLinkUp requires a newer client version')
    if (body?.data?.redirect && body.data.region && hop === 0) {
      reg = String(body.data.region).toLowerCase()
      continue
    }
    const token = body?.data?.authTicket?.token
    const userId = body?.data?.user?.id
    if (!res.ok || !token || !userId) throw new HttpError(502, `LibreLinkUp login failed (${res.status})`)
    return { token, accountId: await sha256hex(String(userId)), region: reg || '' }
  }
  throw new HttpError(502, 'LibreLinkUp redirect loop')
}

async function libreGet(session, path) {
  const res = await upstream(`${libreBase(session.region)}${path}`, {
    headers: { ...LIBRE_HEADERS, Authorization: `Bearer ${session.token}`, 'account-id': session.accountId },
  })
  if (res.status === 401) return { unauthorized: true }
  const body = await readJson(res)
  if (body?.status === 429) throw new HttpError(429, 'LibreLinkUp rate limit — slow down polling')
  if (!res.ok) throw new HttpError(502, `LibreLinkUp http ${res.status}`)
  return { body }
}

async function libre(req) {
  const p = await req.json().catch(() => ({}))
  const hasCreds = !!(p.email && p.password)
  let session = p.token && p.accountId ? { token: p.token, accountId: p.accountId, region: p.region || '' } : null
  if (!session) {
    if (!hasCreds) throw new HttpError(401, 'auth_required')
    session = await libreLogin(p.email, p.password, p.region)
  }

  let conn = await libreGet(session, '/llu/connections')
  if (conn.unauthorized) {
    if (!hasCreds) throw new HttpError(401, 'auth_required')
    session = await libreLogin(p.email, p.password, session.region)
    conn = await libreGet(session, '/llu/connections')
    if (conn.unauthorized) throw new HttpError(401, 'LibreLinkUp rejected the session')
  }
  const list = Array.isArray(conn.body?.data) ? conn.body.data : []
  if (list.length === 0) throw new HttpError(404, 'no LibreLinkUp connections — follow the sensor wearer in LibreLinkUp first')
  const connections = list.map(c => ({
    patientId: c.patientId,
    name: [c.firstName, c.lastName ? `${String(c.lastName)[0]}.` : ''].filter(Boolean).join(' ') || 'Patient',
  }))
  const chosen = list.find(c => c.patientId === p.patientId) || list[0]

  const graph = await libreGet(session, `/llu/connections/${encodeURIComponent(chosen.patientId)}/graph`)
  if (graph.unauthorized) throw new HttpError(401, 'auth_required')
  const data = graph.body?.data || {}
  const cur = data.connection?.glucoseMeasurement || chosen.glucoseMeasurement || {}
  const entries = (Array.isArray(data.graphData) ? data.graphData : []).map(g => ({
    sgv: g.ValueInMgPerDl,
    date: parseLibreTimestamp(g.FactoryTimestamp),
  }))
  entries.push({
    sgv: cur.ValueInMgPerDl,
    date: parseLibreTimestamp(cur.FactoryTimestamp),
    direction: LIBRE_TREND[cur.TrendArrow] || 'NONE',
  })
  return {
    entries: sortEntries(entries),
    session,
    connections,
    patientId: chosen.patientId,
  }
}

/* ------------------------------ Dexcom Share ---------------------------- */

const DEXCOM = {
  us: { base: 'https://share2.dexcom.com/ShareWebServices/Services', appId: 'd89443d2-327c-4a6f-89e5-496bbb0317db' },
  ous: { base: 'https://shareous1.dexcom.com/ShareWebServices/Services', appId: 'd89443d2-327c-4a6f-89e5-496bbb0317db' },
  jp: { base: 'https://share.dexcom.jp/ShareWebServices/Services', appId: 'd8665ade-9673-4e27-9ff6-92db4ce13d13' },
}
const ZERO_UUID = '00000000-0000-0000-0000-000000000000'

async function dexcomPost(base, path, body) {
  const res = await upstream(`${base}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return { res, body: await readJson(res) }
}

async function dexcomLogin(cfg, username, password) {
  const a = await dexcomPost(cfg.base, 'General/AuthenticatePublisherAccount', {
    accountName: username,
    password,
    applicationId: cfg.appId,
  })
  if (!a.res.ok || typeof a.body !== 'string' || a.body === ZERO_UUID) {
    const code = a.body?.Code || ''
    if (/MaxAttempts/i.test(code)) throw new HttpError(429, 'Dexcom account locked — wait and try again')
    throw new HttpError(401, 'wrong Dexcom username or password (check region)')
  }
  const s = await dexcomPost(cfg.base, 'General/LoginPublisherAccountById', {
    accountId: a.body,
    password,
    applicationId: cfg.appId,
  })
  if (!s.res.ok || typeof s.body !== 'string' || s.body === ZERO_UUID) {
    throw new HttpError(401, 'Dexcom login failed')
  }
  return s.body
}

function parseDexcomDate(s) {
  const m = /Date\((\d+)/.exec(String(s || ''))
  return m ? Number(m[1]) : NaN
}

function dexcomTrend(t) {
  if (typeof t === 'number') return TREND_NAMES[t] || 'NONE'
  return TREND_NAMES.includes(t) ? t : 'NONE'
}

async function dexcom(req) {
  const p = await req.json().catch(() => ({}))
  const cfg = DEXCOM[p.region] || DEXCOM.us
  const hasCreds = !!(p.username && p.password)
  let sessionId = p.sessionId || null
  if (!sessionId) {
    if (!hasCreds) throw new HttpError(401, 'auth_required')
    sessionId = await dexcomLogin(cfg, p.username, p.password)
  }

  const read = id =>
    dexcomPost(cfg.base, `Publisher/ReadPublisherLatestGlucoseValues?sessionId=${encodeURIComponent(id)}&minutes=1440&maxCount=288`, {})
  let r = await read(sessionId)
  const expired = x => !x.res.ok && /Session/i.test(x.body?.Code || '')
  if (expired(r)) {
    if (!hasCreds) throw new HttpError(401, 'auth_required')
    sessionId = await dexcomLogin(cfg, p.username, p.password)
    r = await read(sessionId)
  }
  if (!r.res.ok || !Array.isArray(r.body)) throw new HttpError(502, `Dexcom http ${r.res.status}`)
  const entries = r.body.map(e => ({ sgv: e.Value, date: parseDexcomDate(e.WT), direction: dexcomTrend(e.Trend) }))
  return { entries: sortEntries(entries), session: { sessionId } }
}

/* -------------------------------- Router -------------------------------- */

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    const url = new URL(request.url)
    try {
      if (url.pathname === '/entries') {
        if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)
        // Legacy shape (v0.1 plugin) — a bare array.
        return json(await nightscout(url))
      }
      if (url.pathname === '/libre') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        return json(await libre(request))
      }
      if (url.pathname === '/dexcom') {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405)
        return json(await dexcom(request))
      }
      return json({ error: 'not found' }, 404)
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status)
      return json({ error: 'relay error' }, 500)
    }
  },
}
