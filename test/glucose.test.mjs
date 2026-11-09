// Unit tests for glucose logic and source helpers. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toPoints, currentReading, classify, formatGlucose, formatDelta, trendArrow, trendFromRate,
  isStale, formatAge, computeStats, predict, slopePerMin, formatPrediction, DEFAULT_THRESHOLDS,
} from '../dist-test/glucose.js'
import { buildNightscoutUrl, normalizeBaseUrl, profileIsComplete, newProfile } from '../dist-test/sources.js'

const now = 1_700_000_000_000
const MIN = 60_000
const T = DEFAULT_THRESHOLDS

/** Evenly spaced series ending at `now - lagMin`, oldest→newest values. */
const series = (vals, stepMin = 5, lagMin = 0) =>
  vals.map((v, i) => ({ mgdl: v, at: now - lagMin * MIN - (vals.length - 1 - i) * stepMin * MIN })).reverse()

test('toPoints: Nightscout entries → clean, newest-first points', () => {
  const p = toPoints([
    { sgv: 120, direction: 'Flat', date: now - 5 * MIN },
    { sgv: 128, direction: 'FortyFiveUp', date: now },
    { sgv: 0, date: now - MIN },
    { mbg: 99, date: now },
    null,
  ])
  assert.deepEqual(p.map(x => x.mgdl), [128, 120])
  assert.equal(p[0].trend, 'FortyFiveUp')
  assert.deepEqual(toPoints(null), [])
})

test('currentReading: delta normalised to 5 min; trend inferred when source has none', () => {
  const r = currentReading([{ mgdl: 140, at: now }, { mgdl: 120, at: now - 10 * MIN }])
  assert.equal(Math.round(r.deltaMgdl), 10)
  assert.equal(r.trend, 'SingleUp') // +2 mg/dL/min
})

test('trendFromRate thresholds', () => {
  assert.equal(trendFromRate(3.2), 'DoubleUp')
  assert.equal(trendFromRate(2.1), 'SingleUp')
  assert.equal(trendFromRate(1.2), 'FortyFiveUp')
  assert.equal(trendFromRate(0.2), 'Flat')
  assert.equal(trendFromRate(-1.5), 'FortyFiveDown')
  assert.equal(trendFromRate(-2.5), 'SingleDown')
  assert.equal(trendFromRate(-4), 'DoubleDown')
})

test('slopePerMin: linear fall of 2 mg/dL/min', () => {
  const pts = series([150, 140, 130, 120, 110]) // -10 per 5 min
  assert.equal(slopePerMin(pts, 20), -2)
})

test('classify + units formatting', () => {
  assert.equal(classify(50, T), 'urgentLow')
  assert.equal(classify(65, T), 'low')
  assert.equal(classify(180, T), 'inRange')
  assert.equal(classify(251, T), 'urgentHigh')
  assert.equal(formatGlucose(180, 'mmol'), '10.0')
  assert.equal(formatDelta(-4, 'mgdl'), '-4')
  assert.equal(formatDelta(5, 'mmol'), '+0.3')
  assert.equal(formatDelta(null, 'mgdl'), '--')
  assert.equal(trendArrow('DoubleDown'), '↓↓')
})

test('staleness and age', () => {
  assert.equal(isStale(now - 14 * MIN, now), false)
  assert.equal(isStale(now - 15 * MIN, now), true)
  assert.equal(formatAge(now - 7 * MIN, now), '7 min ago')
  assert.equal(formatAge(now - 125 * MIN, now), '2 hr ago')
})

test('computeStats: time in range, avg/min/max, span in hours', () => {
  // 13 readings over 1 h: 10 in range, 3 out
  const vals = [100, 110, 120, 130, 140, 150, 160, 170, 175, 180, 60, 200, 250]
  const s = computeStats(series(vals), T, now)
  assert.equal(s.n, 13)
  assert.equal(s.tir, Math.round((10 / 13) * 100))
  assert.equal(s.min, 60)
  assert.equal(s.max, 250)
  assert.equal(s.hours, 1)
  assert.equal(computeStats(series([100, 110]), T, now), null)
})

test('predict: falling 2/min from 110 warns LOW in ~20 min', () => {
  const p = predict(series([150, 140, 130, 120, 110]), T, now)
  assert.deepEqual(p, { kind: 'low', minutes: 20 })
  assert.equal(formatPrediction(p), '▼ LOW in ~20 min')
})

test('predict: accounts for time since the last reading', () => {
  const p = predict(series([150, 140, 130, 120, 110], 5, 4), T, now) // last reading 4 min old
  assert.equal(p.minutes, 16)
})

test('predict: rising toward high', () => {
  const p = predict(series([130, 140, 150, 160, 170]), T, now)
  assert.deepEqual(p, { kind: 'high', minutes: 5 })
})

test('predict: no warning when steady, far away, stale, or already low', () => {
  assert.equal(predict(series([120, 121, 120, 121, 120]), T, now), null)
  assert.equal(predict(series([220, 215, 210, 205, 200]), T, now), null) // high & falling: no LOW within 30m
  assert.equal(predict(series([150, 140, 130, 120, 110], 5, 20), T, now), null) // stale
  assert.equal(predict(series([80, 75, 70, 65, 60]), T, now), null) // already low
})

test('predict: falls back to delta when only two sparse points (LibreLinkUp graph)', () => {
  const p = predict([{ mgdl: 100, at: now }, { mgdl: 120, at: now - 15 * MIN }], T, now)
  // regression over 2 points within 20 min = -1.33/min → (100-70)/1.33 ≈ 23 min
  assert.equal(p.kind, 'low')
  assert.equal(p.minutes, 23)
})

test('nightscout URL: direct and via relay with 24h history', () => {
  assert.equal(normalizeBaseUrl(' my.site.com/ '), 'https://my.site.com')
  assert.equal(buildNightscoutUrl({ nsUrl: 'https://ns.example.com/', nsToken: 't1' }), 'https://ns.example.com/api/v1/entries.json?count=288&token=t1')
  assert.equal(
    buildNightscoutUrl({ nsUrl: 'https://ns.example.com', nsToken: '' }, 'https://r.workers.dev/'),
    'https://r.workers.dev/entries?ns=https%3A%2F%2Fns.example.com&count=288',
  )
})

test('profiles: completeness and defaults', () => {
  assert.equal(profileIsComplete(newProfile({ source: 'nightscout', nsUrl: 'x' })), true)
  assert.equal(profileIsComplete(newProfile({ source: 'libre', username: 'a@b.c' })), false)
  assert.equal(profileIsComplete(newProfile({ source: 'dexcom', username: 'u', password: 'p' })), true)
  assert.equal(newProfile({ source: 'dexcom' }).region, 'us')
  assert.notEqual(newProfile().id, newProfile().id)
})

test('demo source: 24h of data, falling person triggers predicted LOW, steady one does not', async () => {
  const { demoPoints } = await import('../dist-test/demo.js')
  const { fetchPoints } = await import('../dist-test/sources.js')
  const t = Date.now()
  const falling = demoPoints('falling', t)
  assert.equal(falling.length, 288)
  assert.ok(t - falling[0].at <= 7 * MIN, 'latest reading is fresh')
  const p = predict(falling, T, t)
  assert.equal(p?.kind, 'low')
  assert.ok(p.minutes >= 10 && p.minutes <= 30, `minutes=${p.minutes}`)
  assert.equal(predict(demoPoints('steady', t), T, t), null)
  const r = await fetchPoints(newProfile({ source: 'demo', region: 'steady' }), undefined, null)
  assert.equal(r.points.length, 288)
  assert.equal(profileIsComplete(newProfile({ source: 'demo' })), true)
})
