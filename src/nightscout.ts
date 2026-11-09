/**
 * Nightscout client + glucose domain logic.
 *
 * Pure functions where possible so they can be unit-tested in Node without
 * the Even bridge or a browser.
 */

export type Units = 'mgdl' | 'mmol'

export interface Thresholds {
  /** mg/dL */
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

/** One sensor glucose value as Nightscout returns it from /api/v1/entries.json */
export interface NsEntry {
  sgv?: number
  mbg?: number
  direction?: string
  date?: number // epoch ms
  dateString?: string
  delta?: number
  type?: string
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

export interface Reading {
  /** mg/dL, always */
  mgdl: number
  /** mg/dL per 5 min, or null if unknown */
  deltaMgdl: number | null
  trend: Trend
  /** epoch ms of the reading */
  at: number
}

const MMOL_FACTOR = 18.0182

export function mgdlToMmol(v: number): number {
  return v / MMOL_FACTOR
}

export function mmolToMgdl(v: number): number {
  return v * MMOL_FACTOR
}

/** Formats a glucose value in the chosen units with no unit suffix. */
export function formatGlucose(mgdl: number, units: Units): string {
  if (units === 'mmol') return mgdlToMmol(mgdl).toFixed(1)
  return String(Math.round(mgdl))
}

/** Signed delta string, e.g. "+4" or "-0.3". */
export function formatDelta(deltaMgdl: number | null, units: Units): string {
  if (deltaMgdl == null) return '--'
  const v = units === 'mmol' ? mgdlToMmol(deltaMgdl) : deltaMgdl
  const rounded = units === 'mmol' ? v.toFixed(1) : String(Math.round(v))
  if (Number(rounded) === 0) return units === 'mmol' ? '0.0' : '0'
  return v > 0 ? `+${rounded}` : rounded
}

export function unitsLabel(units: Units): string {
  return units === 'mmol' ? 'mmol/L' : 'mg/dL'
}

/**
 * Glyphs available in the G2 firmware font (see even-g2-notes display.md):
 * ↑ ↗ → ↘ ↓ are all present; doubled arrows are not, so DoubleUp is "↑↑".
 */
export function trendArrow(trend: Trend): string {
  switch (trend) {
    case 'DoubleUp':
      return '↑↑'
    case 'SingleUp':
      return '↑'
    case 'FortyFiveUp':
      return '↗'
    case 'Flat':
      return '→'
    case 'FortyFiveDown':
      return '↘'
    case 'SingleDown':
      return '↓'
    case 'DoubleDown':
      return '↓↓'
    default:
      return '?'
  }
}

export function trendLabel(trend: Trend): string {
  switch (trend) {
    case 'DoubleUp':
      return 'Rising fast'
    case 'SingleUp':
      return 'Rising'
    case 'FortyFiveUp':
      return 'Rising slowly'
    case 'Flat':
      return 'Steady'
    case 'FortyFiveDown':
      return 'Falling slowly'
    case 'SingleDown':
      return 'Falling'
    case 'DoubleDown':
      return 'Falling fast'
    default:
      return 'No trend'
  }
}

export function normalizeTrend(raw: string | undefined): Trend {
  switch (raw) {
    case 'DoubleUp':
    case 'SingleUp':
    case 'FortyFiveUp':
    case 'Flat':
    case 'FortyFiveDown':
    case 'SingleDown':
    case 'DoubleDown':
      return raw
    default:
      return 'NONE'
  }
}

export function classify(mgdl: number, t: Thresholds): RangeState {
  if (mgdl < t.urgentLow) return 'urgentLow'
  if (mgdl < t.low) return 'low'
  if (mgdl > t.urgentHigh) return 'urgentHigh'
  if (mgdl > t.high) return 'high'
  return 'inRange'
}

export function rangeLabel(state: RangeState): string {
  switch (state) {
    case 'urgentLow':
      return 'URGENT LOW'
    case 'low':
      return 'LOW'
    case 'high':
      return 'HIGH'
    case 'urgentHigh':
      return 'URGENT HIGH'
    default:
      return 'In range'
  }
}

/** Minutes since the reading, floored. */
export function ageMinutes(at: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - at) / 60_000))
}

export function formatAge(at: number, now: number = Date.now()): string {
  const m = ageMinutes(at, now)
  if (m < 1) return 'just now'
  if (m === 1) return '1 min ago'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h === 1 ? '1 hr ago' : `${h} hr ago`
}

/** Nightscout posts every ~5 min; anything older than this is suspicious. */
export const STALE_AFTER_MIN = 15

export function isStale(at: number, now: number = Date.now()): boolean {
  return ageMinutes(at, now) >= STALE_AFTER_MIN
}

/**
 * Turns the two most-recent entries into a Reading. Accepts the raw array
 * from /api/v1/entries.json (newest first). Returns null if nothing usable.
 */
export function parseEntries(entries: unknown): Reading | null {
  if (!Array.isArray(entries)) return null
  const sgvs = (entries as NsEntry[]).filter(
    e => e && typeof e.sgv === 'number' && e.sgv > 0 && typeof e.date === 'number',
  )
  if (sgvs.length === 0) return null
  // Nightscout returns newest first, but don't rely on it.
  sgvs.sort((a, b) => (b.date as number) - (a.date as number))
  const latest = sgvs[0]
  const prev = sgvs[1]

  let delta: number | null = null
  if (typeof latest.delta === 'number') {
    delta = latest.delta
  } else if (prev && typeof prev.sgv === 'number') {
    // Normalise to a per-5-minute delta so spaced-out readings don't exaggerate.
    const minutes = ((latest.date as number) - (prev.date as number)) / 60_000
    if (minutes > 0 && minutes <= 20) {
      delta = ((latest.sgv as number) - prev.sgv) * (5 / minutes)
    }
  }

  return {
    mgdl: latest.sgv as number,
    deltaMgdl: delta,
    trend: normalizeTrend(latest.direction),
    at: latest.date as number,
  }
}

/** Strips trailing slashes and whitespace from a user-entered base URL. */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim()
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`
  return u.replace(/\/+$/, '')
}

export interface FetchOptions {
  /** User's Nightscout base URL, e.g. https://my.nightscout.site */
  nightscoutUrl: string
  /** Nightscout access token (optional for read-enabled sites) */
  token?: string
  /**
   * Relay origin. Even Hub only allows whitelisted origins, and every user has a
   * different Nightscout host, so requests go via a fixed stateless relay.
   * If empty, the app calls Nightscout directly (works in the simulator / dev).
   */
  relayUrl?: string
  count?: number
  signal?: AbortSignal
}

/** Builds the request URL, either direct or via the relay. */
export function buildEntriesUrl(o: FetchOptions): string {
  const base = normalizeBaseUrl(o.nightscoutUrl)
  const count = o.count ?? 2
  if (o.relayUrl) {
    const relay = normalizeBaseUrl(o.relayUrl)
    const q = new URLSearchParams({ ns: base, count: String(count) })
    if (o.token) q.set('token', o.token)
    return `${relay}/entries?${q.toString()}`
  }
  const q = new URLSearchParams({ count: String(count) })
  if (o.token) q.set('token', o.token)
  return `${base}/api/v1/entries.json?${q.toString()}`
}

export async function fetchReading(o: FetchOptions): Promise<Reading> {
  const url = buildEntriesUrl(o)
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: o.signal,
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error('Nightscout rejected the token (401/403)')
  }
  if (!res.ok) throw new Error(`Nightscout HTTP ${res.status}`)
  const json = await res.json()
  const reading = parseEntries(json)
  if (!reading) throw new Error('No glucose entries returned')
  return reading
}
