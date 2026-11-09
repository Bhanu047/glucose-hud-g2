/**
 * Minimal fake Nightscout for local testing.
 *   node mock/nightscout.mjs            # http://localhost:1337
 *   node mock/nightscout.mjs --token=abc   # require ?token=abc
 *
 * Serves /api/v1/entries.json with a slowly drifting glucose value so you can
 * watch the HUD update. Query ?scenario=low|high|stale|flat to force states.
 */
import http from 'node:http'

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')))
const PORT = Number(args.port) || 1337
const TOKEN = args.token || null

const DIRS = ['DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown']
let base = 128
let phase = 0

function entries(scenario) {
  const now = Date.now()
  phase += 0.35
  let sgv = Math.round(base + 35 * Math.sin(phase))
  let direction = DIRS[Math.min(6, Math.max(0, Math.round(3 - Math.cos(phase) * 2.5)))]
  let date = now - 2 * 60_000
  if (scenario === 'low') { sgv = 62; direction = 'SingleDown' }
  if (scenario === 'ulow') { sgv = 48; direction = 'DoubleDown' }
  if (scenario === 'high') { sgv = 212; direction = 'FortyFiveUp' }
  if (scenario === 'uhigh') { sgv = 290; direction = 'DoubleUp' }
  if (scenario === 'flat') { sgv = 110; direction = 'Flat' }
  if (scenario === 'stale') { date = now - 27 * 60_000 }
  const prev = sgv - Math.round(5 * Math.cos(phase))
  return [
    { sgv, direction, date, dateString: new Date(date).toISOString(), type: 'sgv' },
    { sgv: prev, direction, date: date - 5 * 60_000, dateString: new Date(date - 5 * 60_000).toISOString(), type: 'sgv' },
  ]
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`)
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    // Scenario can be a path prefix so it survives the plugin appending
    // /api/v1/entries.json to the base URL: http://localhost:1337/low
    const m = url.pathname.match(/^(?:\/([a-z]+))?\/api\/v1\/entries\.json$/)
    if (!m) return res.writeHead(404).end('not found')
    if (TOKEN && url.searchParams.get('token') !== TOKEN) return res.writeHead(401).end('unauthorized')
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(entries(m[1] ?? url.searchParams.get('scenario'))))
  })
  .listen(PORT, () => console.log(`mock nightscout on http://localhost:${PORT}  (token: ${TOKEN ?? 'none'})`))
