// Unit tests for the pure glucose logic. Run: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEntries, classify, formatGlucose, formatDelta, trendArrow,
  isStale, formatAge, buildEntriesUrl, normalizeBaseUrl, DEFAULT_THRESHOLDS,
} from '../dist-test/nightscout.js'

const now = 1_700_000_000_000

test('parseEntries picks newest and computes 5-min delta', () => {
  const r = parseEntries([
    { sgv: 120, direction: 'Flat', date: now - 300_000 },
    { sgv: 128, direction: 'FortyFiveUp', date: now },
  ])
  assert.equal(r.mgdl, 128)
  assert.equal(r.trend, 'FortyFiveUp')
  assert.equal(Math.round(r.deltaMgdl), 8)
  assert.equal(r.at, now)
})

test('parseEntries normalises delta when readings are 10 min apart', () => {
  const r = parseEntries([
    { sgv: 140, date: now },
    { sgv: 120, date: now - 600_000 },
  ])
  assert.equal(Math.round(r.deltaMgdl), 10) // 20 over 10 min → 10 per 5 min
})

test('parseEntries prefers server-provided delta and ignores junk', () => {
  const r = parseEntries([{ sgv: 100, delta: -3.2, date: now }, { mbg: 99, date: now - 1 }, null])
  assert.equal(r.deltaMgdl, -3.2)
  assert.equal(r.trend, 'NONE')
})

test('parseEntries returns null on garbage', () => {
  assert.equal(parseEntries(null), null)
  assert.equal(parseEntries([]), null)
  assert.equal(parseEntries([{ sgv: 0, date: now }]), null)
})

test('classify thresholds', () => {
  const t = DEFAULT_THRESHOLDS
  assert.equal(classify(50, t), 'urgentLow')
  assert.equal(classify(65, t), 'low')
  assert.equal(classify(70, t), 'inRange')
  assert.equal(classify(180, t), 'inRange')
  assert.equal(classify(181, t), 'high')
  assert.equal(classify(251, t), 'urgentHigh')
})

test('units formatting', () => {
  assert.equal(formatGlucose(180, 'mgdl'), '180')
  assert.equal(formatGlucose(180, 'mmol'), '10.0')
  assert.equal(formatGlucose(70, 'mmol'), '3.9')
  assert.equal(formatDelta(4, 'mgdl'), '+4')
  assert.equal(formatDelta(-4, 'mgdl'), '-4')
  assert.equal(formatDelta(0.2, 'mgdl'), '0')
  assert.equal(formatDelta(5, 'mmol'), '+0.3')
  assert.equal(formatDelta(null, 'mmol'), '--')
})

test('trend arrows use glyphs the G2 font has', () => {
  assert.equal(trendArrow('DoubleUp'), '↑↑')
  assert.equal(trendArrow('FortyFiveDown'), '↘')
  assert.equal(trendArrow('NONE'), '?')
})

test('staleness and age', () => {
  assert.equal(isStale(now - 14 * 60_000, now), false)
  assert.equal(isStale(now - 15 * 60_000, now), true)
  assert.equal(formatAge(now - 30_000, now), 'just now')
  assert.equal(formatAge(now - 60_000, now), '1 min ago')
  assert.equal(formatAge(now - 7 * 60_000, now), '7 min ago')
  assert.equal(formatAge(now - 125 * 60_000, now), '2 hr ago')
})

test('URL building: direct and via relay', () => {
  assert.equal(normalizeBaseUrl(' my.site.com/ '), 'https://my.site.com')
  assert.equal(
    buildEntriesUrl({ nightscoutUrl: 'https://ns.example.com/', token: 't1' }),
    'https://ns.example.com/api/v1/entries.json?count=2&token=t1',
  )
  const viaRelay = buildEntriesUrl({ nightscoutUrl: 'https://ns.example.com', relayUrl: 'https://r.workers.dev/', count: 3 })
  assert.equal(viaRelay, 'https://r.workers.dev/entries?ns=https%3A%2F%2Fns.example.com&count=3')
})
