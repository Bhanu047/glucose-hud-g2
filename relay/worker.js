/**
 * Glucose HUD relay — Cloudflare Worker (free tier is plenty).
 *
 * Why this exists: Even Hub plugins may only contact origins listed in
 * app.json, and wildcards aren't allowed. Every Nightscout user has a
 * different host, so the plugin calls this one fixed origin and the relay
 * forwards to the user's own Nightscout.
 *
 * Privacy: stateless. Nothing is logged or stored. The token travels in the
 * query string over HTTPS exactly as Nightscout itself accepts it.
 *
 * Deploy:  npx wrangler deploy relay/worker.js --name glucose-relay
 * Then put https://glucose-relay.<you>.workers.dev in app.json's whitelist
 * and in the plugin's Relay URL field.
 *
 * GET /entries?ns=https://my.nightscout.site&count=2[&token=...]
 */

const ALLOWED_PATH = '/entries'
const MAX_COUNT = 10
const UPSTREAM_TIMEOUT_MS = 8000

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  })
}

function isSafeUpstream(u) {
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false
  // Block raw IPs (private ranges, link-local, loopback) — SSRF hygiene.
  if (/^[\d.]+$/.test(h) || h.includes(':')) return false
  return true
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405)

    const url = new URL(request.url)
    if (url.pathname !== ALLOWED_PATH) return json({ error: 'not found' }, 404)

    const ns = url.searchParams.get('ns')
    if (!ns) return json({ error: 'missing ns' }, 400)

    let upstream
    try {
      upstream = new URL(ns)
    } catch {
      return json({ error: 'bad ns url' }, 400)
    }
    if (!isSafeUpstream(upstream)) return json({ error: 'ns must be a public https host' }, 400)

    const count = Math.min(MAX_COUNT, Math.max(1, Number(url.searchParams.get('count')) || 2))
    const token = url.searchParams.get('token')

    const target = new URL(`${upstream.origin}${upstream.pathname.replace(/\/+$/, '')}/api/v1/entries.json`)
    target.searchParams.set('count', String(count))
    if (token) target.searchParams.set('token', token)

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      const res = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'glucose-hud-relay/1.0' },
        signal: ctrl.signal,
        redirect: 'follow',
      })
      if (res.status === 401 || res.status === 403) return json({ error: 'nightscout rejected token' }, res.status)
      if (!res.ok) return json({ error: `nightscout http ${res.status}` }, 502)
      const data = await res.json()
      // Pass through only the fields the plugin needs.
      const slim = Array.isArray(data)
        ? data.map(e => ({ sgv: e.sgv, direction: e.direction, date: e.date, delta: e.delta }))
        : []
      return json(slim)
    } catch (e) {
      const timedOut = e && e.name === 'AbortError'
      return json({ error: timedOut ? 'nightscout timeout' : 'nightscout unreachable' }, 504)
    } finally {
      clearTimeout(t)
    }
  },
}
