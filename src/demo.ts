/**
 * Demo source: realistic synthetic CGM data generated on the phone, no
 * account or network needed. Lets new users (and store reviewers) see every
 * feature on real glasses: chart, time in range, a falling trend that
 * triggers the predicted-low warning, and caregiver switching.
 *
 * The curve is a function of wall-clock time, so polls are consistent and the
 * chart scrolls naturally.
 */
import type { Point, Trend } from './glucose'

export type DemoScenario = 'falling' | 'steady'

const MIN = 60_000
const STEP = 5 * MIN

function noise(i: number): number {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 6
}

function baseValue(at: number, offset: number): number {
  const h = (((at / 3_600_000) % 24) + 24) % 24
  let v = 125 + offset + 22 * Math.sin((h / 24) * Math.PI * 2)
  for (const meal of [7.5, 12.5, 19]) {
    const dt = h - meal
    if (dt > 0 && dt < 3) v += 70 * Math.exp(-((dt - 0.9) ** 2) / 0.35)
  }
  return v + noise(Math.floor(at / STEP) + offset)
}

function trendFor(points: Point[]): Trend {
  const [a, b] = points
  if (!a || !b) return 'Flat'
  const rate = (a.mgdl - b.mgdl) / ((a.at - b.at) / MIN)
  if (rate >= 2) return 'SingleUp'
  if (rate >= 1) return 'FortyFiveUp'
  if (rate > -1) return 'Flat'
  if (rate > -2) return 'FortyFiveDown'
  return 'SingleDown'
}

/** 24 h of 5-minute readings, newest first, latest ~2 minutes old. */
export function demoPoints(scenario: DemoScenario, now = Date.now()): Point[] {
  const offset = scenario === 'falling' ? 0 : 14
  const latest = Math.floor((now - 2 * MIN) / STEP) * STEP
  const pts: Point[] = []
  for (let i = 0; i < 288; i++) {
    const at = latest - i * STEP
    let v = baseValue(at, offset)
    // Last 30 minutes: falling ~1.1 mg/dL/min toward the low line, so the
    // forecast shows "LOW in ~20 min"; or a gentle steady tail.
    if (i <= 6) {
      const t = (6 - i) / 6
      const start = baseValue(latest - 6 * STEP, offset)
      v = scenario === 'falling' ? 128 - 33 * t : start + (132 - start) * t
    }
    pts.push({ mgdl: Math.round(v), at })
  }
  pts[0].trend = trendFor(pts)
  return pts
}
