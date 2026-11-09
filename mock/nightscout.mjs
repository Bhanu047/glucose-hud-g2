/**
 * Fake Nightscout for local testing.
 *   node mock/nightscout.mjs                 # http://localhost:1337
 *   node mock/nightscout.mjs --token=abc     # require ?token=abc
 *
 * Scenario as a path prefix (survives the plugin appending /api/v1/...):
 *   http://localhost:1337/falling | /low | /uhigh | /flat | /stale
 */
import http from 'node:http'
import { curve, directionFor } from './curve.mjs'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
const PORT = Number(args.port) || 1337
const TOKEN = args.token || null

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    const m = url.pathname.match(/^(?:\/([a-z]+))?\/api\/v1\/entries\.json$/)
    if (!m) return res.writeHead(404).end('not found')
    if (TOKEN && url.searchParams.get('token') !== TOKEN) return res.writeHead(401).end('unauthorized')
    const count = Math.min(300, Number(url.searchParams.get('count')) || 2)
    const pts = curve(Date.now(), { scenario: m[1] ?? 'normal' }).slice(0, count)
    const dir = directionFor(pts)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(pts.map((p, i) => ({ sgv: p.mgdl, date: p.at, direction: i === 0 ? dir : undefined, type: 'sgv' }))))
  })
  .listen(PORT, () => console.log(`mock nightscout on http://localhost:${PORT}  (token: ${TOKEN ?? 'none'})`))
