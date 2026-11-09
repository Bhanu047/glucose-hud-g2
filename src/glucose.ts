/**
 * Glucose domain logic: units, trends, ranges, stats, prediction.
 * Pure functions only, so everything here is unit-tested in Node.
 */

export type Units = 'mgdl' | 'mmol'

export interface Thresholds {
  /** all mg/dL */
  urgentLow: number
  low: number
  high: number
  urgentHigh: number
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  urgentLow: 55,
  low: 70,
  high: 180,
  urgentHigh: 250,
}

export type Trend =
  | 'DoubleUp'
  | 'SingleUp'
  | 'FortyFiveUp'
  | 'Flat'
  | 'FortyFiveDown'
  | 'SingleDown'
  | 'DoubleDown'
  | 'NONE'

export type RangeState = 'urgentLow' | 'low' | 'inRange' | 'high' | 'urgentHigh'

/** One sensor value. */
export interface Point {
  mgdl: number
  /** epoch ms */
  at: number
  trend?: Trend
}

/** The latest value plus what we derive from recent history. */
export interface Reading {
  mgdl: number
  /** mg/dL per 5 min, or null if unknown */
  deltaMgdl: number | null
  trend: Trend
  at: number
}

const MMOL_FACTOR = 18.0182
export const mgdlToMmol = (v: number) => v / MMOL_FACTOR
export const mmolToMgdl = (v: number) => v * MMOL_FACTOR

export function formatGlucose(mgdl: number, units: Units): string {
  return units === 'mmol' ? mgdlToMmol(mgdl).toFixed(1) : String(Math.round(mgdl))
}

export function formatDelta(deltaMgdl: number | null, units: Units): string {
  if (deltaMgdl == null) return '--'
  const v = units === 'mmol' ? mgdlToMmol(deltaMgdl) : deltaMgdl
  const rounded = units === 'mmol' ? v.toFixed(1) : String(Math.round(v))
  if (Number(rounded) === 0) return units === 'mmol' ? '0.0' : '0'
  return v > 0 ? `+${rounded}` : rounded
}

export const unitsLabel = (u: Units) => (u === 'mmol' ? 'mmol/L' : 'mg/dL')

/** Arrows limited to glyphs present in the G2 firmware font. */
export function trendArrow(trend: Trend): string {
  return (
    {
      DoubleUp: '↑↑',
      SingleUp: '↑',
      FortyFiveUp: '↗',
      Flat: '→',
      FortyFiveDown: '↘',
      SingleDown: '↓',
      DoubleDown: '↓↓',
      NONE: '?',
    } as const
  )[trend]
}

export function trendLabel(trend: Trend): string {
  return (
    {
      DoubleUp: 'Rising fast',
      SingleUp: 'Rising',
      FortyFiveUp: 'Rising slowly',
      Flat: 'Steady',
      FortyFiveDown: 'Falling slowly',
      SingleDown: 'Falling',
      DoubleDown: 'Falling fast',
      NONE: 'No trend',
    } as const
  )[trend]
}

const TRENDS: Trend[] = ['DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat', 'FortyFiveDown', 'SingleDown', 'DoubleDown']
export function normalizeTrend(raw: unknown): Trend {
  return TRENDS.includes(raw as Trend) ? (raw as Trend) : 'NONE'
}

/** Dexcom/Nightscout convention: rate in mg/dL per minute → arrow. */
export function trendFromRate(perMin: number): Trend {
  if (perMin >= 3) return 'DoubleUp'
  if (perMin >= 2) return 'SingleUp'
  if (perMin >= 1) return 'FortyFiveUp'
  if (perMin > -1) return 'Flat'
  if (perMin > -2) return 'FortyFiveDown'
  if (perMin > -3) return 'SingleDown'
  return 'DoubleDown'
}

export function classify(mgdl: number, t: Thresholds): RangeState {
  if (mgdl < t.urgentLow) return 'urgentLow'
  if (mgdl < t.low) return 'low'
  if (mgdl > t.urgentHigh) return 'urgentHigh'
  if (mgdl > t.high) return 'high'
  return 'inRange'
}

export function rangeLabel(state: RangeState): string {
  return { urgentLow: 'URGENT LOW', low: 'LOW', high: 'HIGH', urgentHigh: 'URGENT HIGH', inRange: 'In range' }[state]
}

export const ageMinutes = (at: number, now = Date.now()) => Math.max(0, Math.floor((now - at) / 60_000))

export function formatAge(at: number, now = Date.now()): string {
  const m = ageMinutes(at, now)
  if (m < 1) return 'just now'
  if (m === 1) return '1 min ago'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h === 1 ? '1 hr ago' : `${h} hr ago`
}

/** CGMs post every 1–5 min; older than this is suspicious. */
export const STALE_AFTER_MIN = 15
export const isStale = (at: number, now = Date.now()) => ageMinutes(at, now) >= STALE_AFTER_MIN

/** Newest first, valid only, de-duplicated by timestamp. */
export function cleanPoints(points: Point[]): Point[] {
  const seen = new Set<number>()
  return points
    .filter(p => p && Number.isFinite(p.mgdl) && p.mgdl > 0 && Number.isFinite(p.at))
    .sort((a, b) => b.at - a.at)
    .filter(p => (seen.has(p.at) ? false : (seen.add(p.at), true)))
}

/** Raw Nightscout-shaped entries ({sgv, date, direction}) → Points. */
export function toPoints(entries: unknown): Point[] {
  if (!Array.isArray(entries)) return []
  return cleanPoints(
    entries
      .filter(e => e && typeof e.sgv === 'number' && typeof e.date === 'number')
      .map(e => ({ mgdl: e.sgv, at: e.date, trend: normalizeTrend(e.direction) })),
  )
}

/**
 * Least-squares slope (mg/dL per minute) over points within `windowMin` of
 * the newest point. Null if fewer than 2 points.
 */
export function slopePerMin(points: Point[], windowMin = 20): number | null {
  const pts = cleanPoints(points)
  if (pts.length < 2) return null
  const t0 = pts[0].at
  const win = pts.filter(p => t0 - p.at <= windowMin * 60_000)
  if (win.length < 2) return null
  const xs = win.map(p => (p.at - t0) / 60_000)
  const ys = win.map(p => p.mgdl)
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length
  const my = ys.reduce((a, b) => a + b, 0) / ys.length
  let num = 0
  let den = 0
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my)
    den += (xs[i] - mx) ** 2
  }
  return den === 0 ? null : num / den
}

/** Latest reading with delta (per 5 min) and a trend arrow even if the source gave none. */
export function currentReading(points: Point[]): Reading | null {
  const pts = cleanPoints(points)
  if (pts.length === 0) return null
  const latest = pts[0]
  const prev = pts[1]
  let delta: number | null = null
  if (prev) {
    const mins = (latest.at - prev.at) / 60_000
    if (mins > 0 && mins <= 20) delta = (latest.mgdl - prev.mgdl) * (5 / mins)
  }
  let trend = latest.trend ?? 'NONE'
  if (trend === 'NONE') {
    const s = slopePerMin(pts, 15)
    if (s != null) trend = trendFromRate(s)
  }
  return { mgdl: latest.mgdl, deltaMgdl: delta, trend, at: latest.at }
}

export interface Stats {
  /** hours of data actually covered, rounded */
  hours: number
  /** % of readings within [low, high] */
  tir: number
  avg: number
  min: number
  max: number
  n: number
}

export function computeStats(points: Point[], t: Thresholds, now = Date.now(), windowHours = 24): Stats | null {
  const pts = cleanPoints(points).filter(p => now - p.at <= windowHours * 3_600_000)
  if (pts.length < 3) return null
  const vals = pts.map(p => p.mgdl)
  const inRange = vals.filter(v => v >= t.low && v <= t.high).length
  const span = (pts[0].at - pts[pts.length - 1].at) / 3_600_000
  return {
    hours: Math.max(1, Math.round(span)),
    tir: Math.round((inRange / vals.length) * 100),
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
    min: Math.min(...vals),
    max: Math.max(...vals),
    n: vals.length,
  }
}

export interface Prediction {
  kind: 'low' | 'high'
  /** minutes until the threshold is crossed */
  minutes: number
}

/** How far ahead we're willing to warn. Beyond this, linear extrapolation is noise. */
export const PREDICT_HORIZON_MIN = 30

/**
 * Projects the recent trend forward and warns if we'll cross the low (or high)
 * threshold within PREDICT_HORIZON_MIN. Uses a 20-minute regression when there
 * are enough points, otherwise the per-5-minute delta. Only warns while still
 * in range: once already low, the status line says so.
 */
export function predict(points: Point[], t: Thresholds, now = Date.now()): Prediction | null {
  const pts = cleanPoints(points)
  const cur = currentReading(pts)
  if (!cur || isStale(cur.at, now)) return null
  let rate = slopePerMin(pts, 20)
  if (rate == null && cur.deltaMgdl != null) rate = cur.deltaMgdl / 5
  if (rate == null || Math.abs(rate) < 0.5) return null
  // Project from "now", not from the reading time.
  const elapsed = (now - cur.at) / 60_000
  const projected = cur.mgdl + rate * elapsed
  if (rate < 0 && cur.mgdl >= t.low) {
    const mins = Math.max(0, (projected - t.low) / -rate)
    if (mins <= PREDICT_HORIZON_MIN) return { kind: 'low', minutes: Math.round(mins) }
  }
  if (rate > 0 && cur.mgdl <= t.high) {
    const mins = Math.max(0, (t.high - projected) / rate)
    if (mins <= PREDICT_HORIZON_MIN) return { kind: 'high', minutes: Math.round(mins) }
  }
  return null
}

export function formatPrediction(p: Prediction): string {
  const when = p.minutes <= 1 ? 'now' : `in ~${p.minutes} min`
  return p.kind === 'low' ? `▼ LOW ${when}` : `▲ HIGH ${when}`
}
