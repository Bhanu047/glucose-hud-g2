/**
 * Runs relay/worker.js locally on http://localhost:8787 with LibreLinkUp and
 * Dexcom Share replaced by in-process fakes, so the full Libre/Dexcom path
 * (session handling, parsing, multiple patients) can be exercised in the
 * simulator without real accounts.
 *
 *   node scripts/dev-relay.mjs
 *
 * Fake accounts: any email/username, password "pw". Wrong password → 401.
 * Libre account has two followers: "Mia R." (falling, predicts LOW) and
 * "Dad K." (steady). Dexcom account is in range, 24 h history.
 */
import http from 'node:http'
import worker from '../relay/worker.js'
import { curve, directionFor } from '../mock/curve.mjs'

const PORT = Number(process.env.PORT) || 8787
const realFetch = globalThis.fetch
const json = (b, s = 200) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })

const pad = n => String(n).padStart(2, '0')
function libreTs(ms) {
  const d = new Date(ms)
  let h = d.getUTCHours()
  const ap = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${ap}`
}
const LIBRE_ARROW = { SingleDown: 1, DoubleDown: 1, FortyFiveDown: 2, Flat: 3, FortyFiveUp: 4, SingleUp: 5, DoubleUp: 5 }

const PATIENTS = {
  'pt-mia': { firstName: 'Mia', lastName: 'Rivera', scenario: 'falling', offset: 0 },
  'pt-dad': { firstName: 'Dad', lastName: 'Kim', scenario: 'normal', offset: 18 },
}

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  const body = init.body ? JSON.parse(init.body) : {}

  if (u.includes('libreview.io')) {
    if (u.endsWith('/llu/auth/login')) {
      if (body.password !== 'pw') return json({ status: 2 })
      return json({ status: 0, data: { user: { id: `u-${body.email}` }, authTicket: { token: 'libre-tok' } } })
    }
    if (init.headers?.Authorization !== 'Bearer libre-tok' || !init.headers?.['account-id']) return json({}, 401)
    if (u.endsWith('/llu/connections')) {
      return json({ status: 0, data: Object.entries(PATIENTS).map(([patientId, p]) => ({ patientId, firstName: p.firstName, lastName: p.lastName })) })
    }
    const m = u.match(/connections\/([^/]+)\/graph/)
    if (m && PATIENTS[m[1]]) {
      const p = PATIENTS[m[1]]
      const now = Date.now()
      const pts = curve(now, { hours: 12, stepMin: 5, scenario: p.scenario, personOffset: p.offset })
      // LibreLinkUp graph is 15-minute resolution; current reading is 1-minute.
      const graph = pts.filter((_, i) => i % 3 === 0).slice(1)
      const recent = pts.slice(0, 4) // a few recent minutes so prediction has data, like the app's cache
      return json({
        status: 0,
        data: {
          connection: {
            glucoseMeasurement: {
              ValueInMgPerDl: pts[0].mgdl,
              TrendArrow: LIBRE_ARROW[directionFor(pts)],
              FactoryTimestamp: libreTs(pts[0].at),
            },
          },
          graphData: [...recent.slice(1), ...graph].map(g => ({ ValueInMgPerDl: g.mgdl, FactoryTimestamp: libreTs(g.at) })),
        },
      })
    }
    return json({}, 404)
  }

  if (u.includes('dexcom')) {
    if (u.includes('AuthenticatePublisherAccount')) return body.password === 'pw' ? json('"acc-1"') : json({ Code: 'AccountPasswordInvalid' }, 500)
    if (u.includes('LoginPublisherAccountById')) return json('"dex-sess"')
    if (u.includes('ReadPublisherLatestGlucoseValues')) {
      if (!u.includes('sessionId=dex-sess')) return json({ Code: 'SessionIdNotFound' }, 500)
      const pts = curve(Date.now(), { hours: 24, scenario: 'normal', personOffset: 6 })
      const dir = directionFor(pts)
      return json(pts.map((p, i) => ({ WT: `Date(${p.at})`, Value: p.mgdl, Trend: i === 0 ? dir : 'Flat' })))
    }
  }
  return realFetch(url, init)
}

http
  .createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const request = new Request(`http://localhost:${PORT}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks),
    })
    const out = await worker.fetch(request)
    res.writeHead(out.status, Object.fromEntries(out.headers))
    res.end(Buffer.from(await out.arrayBuffer()))
  })
  .listen(PORT, () => console.log(`dev relay (fake Libre/Dexcom) on http://localhost:${PORT}`))
