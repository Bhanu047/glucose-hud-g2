/**
 * Realistic-looking synthetic CGM day for mocks: slow circadian drift,
 * two meal bumps, sensor noise, and a scenario-specific tail for the last
 * 30 minutes so we can exercise alerts and prediction.
 */
const MIN = 60_000

function seededNoise(i) {
  const x = Math.sin(i * 12.9898) * 43758.5453
  return (x - Math.floor(x) - 0.5) * 6
}

export function curve(now, { hours = 24, stepMin = 5, scenario = 'normal', personOffset = 0 } = {}) {
  const out = []
  const n = Math.floor((hours * 60) / stepMin)
  for (let i = n; i >= 0; i--) {
    const at = now - 2 * MIN - i * stepMin * MIN
    const h = ((at / 3_600_000) % 24 + 24) % 24
    let v = 125 + personOffset + 22 * Math.sin((h / 24) * Math.PI * 2)
    for (const meal of [7.5, 12.5, 19]) {
      const dt = h - meal
      if (dt > 0 && dt < 3) v += 70 * Math.exp(-((dt - 0.9) ** 2) / 0.35)
    }
    v += seededNoise(i + personOffset)
    out.push({ at, v })
  }
  // Scenario tail: overwrite the last 30 minutes
  const tail = out.filter(p => now - p.at <= 32 * MIN)
  const start = tail[0]?.v ?? 120
  tail.forEach((p, k) => {
    const t = k / Math.max(1, tail.length - 1)
    if (scenario === 'falling') p.v = 128 - 33 * t // ~ -1.1/min → LOW ≈ 20 min after last
    if (scenario === 'low') p.v = 94 - 34 * t
    if (scenario === 'uhigh') p.v = 240 + 50 * t
    if (scenario === 'flat') p.v = 112 + seededNoise(k) * 0.3
    if (scenario === 'normal') p.v = start + (138 - start) * t
  })
  if (scenario === 'stale') out.splice(out.length - 6, 6)
  return out.map(p => ({ at: p.at, mgdl: Math.round(p.v) })).reverse() // newest first
}

export function directionFor(points) {
  if (points.length < 2) return 'Flat'
  const rate = (points[0].mgdl - points[1].mgdl) / ((points[0].at - points[1].at) / MIN)
  if (rate >= 3) return 'DoubleUp'
  if (rate >= 2) return 'SingleUp'
  if (rate >= 1) return 'FortyFiveUp'
  if (rate > -1) return 'Flat'
  if (rate > -2) return 'FortyFiveDown'
  if (rate > -3) return 'SingleDown'
  return 'DoubleDown'
}
