/**
 * Canvas renderers for the G2 image containers (max 288x144 each).
 * The host converts PNGs to 4-bit greyscale: black = LED off, white = full green.
 */
import type { Point, Thresholds } from './glucose'

export const BIG_W = 288
export const BIG_H = 136
export const CHART_W = 288
export const CHART_H = 96

const FONT = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'

function canvas(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  return ctx
}

const toBase64 = (ctx: CanvasRenderingContext2D) =>
  ctx.canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')

export interface BigTileInput {
  value: string
  arrow: string
  alert: boolean
  stale: boolean
}

export function renderBigTile(input: BigTileInput): string {
  const ctx = canvas(BIG_W, BIG_H)
  const ink = '#fff'
  if (input.alert && !input.stale) {
    ctx.strokeStyle = ink
    ctx.lineWidth = 4
    ctx.strokeRect(2, 2, BIG_W - 4, BIG_H - 4)
  }
  const arrowW = input.arrow.length > 1 ? 86 : 60
  const maxValueW = BIG_W - arrowW - 28
  let size = 108
  const setFont = (s: number) => (ctx.font = `bold ${s}px ${FONT}`)
  setFont(size)
  while (ctx.measureText(input.value).width > maxValueW && size > 48) setFont((size -= 6))
  ctx.fillStyle = ink
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const valueW = ctx.measureText(input.value).width
  const x0 = Math.max(10, (BIG_W - (valueW + 14 + arrowW)) / 2)
  const cy = BIG_H / 2 + 4
  // Stale data is drawn hollow: an on/off cue that survives any greyscale handling.
  const draw = (s: string, x: number) => {
    if (input.stale) {
      ctx.strokeStyle = ink
      ctx.lineWidth = 3
      ctx.strokeText(s, x, cy)
    } else ctx.fillText(s, x, cy)
  }
  draw(input.value, x0)
  ctx.font = `bold ${Math.round(size * 0.62)}px ${FONT}`
  draw(input.stale ? '?' : input.arrow, x0 + valueW + 14)
  return toBase64(ctx)
}

export function renderMessageTile(line1: string, line2 = ''): string {
  const ctx = canvas(BIG_W, BIG_H)
  ctx.fillStyle = '#ccc'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `bold 34px ${FONT}`
  ctx.fillText(line1, BIG_W / 2, line2 ? BIG_H / 2 - 20 : BIG_H / 2)
  if (line2) {
    ctx.font = `22px ${FONT}`
    ctx.fillText(line2, BIG_W / 2, BIG_H / 2 + 24)
  }
  return toBase64(ctx)
}

/** All-black placeholder for screens without data. */
export function renderBlankChart(): string {
  return toBase64(canvas(CHART_W, CHART_H))
}

export const CHART_HOURS = 3
const Y_MIN = 40
const Y_MAX = 300

/**
 * Last CHART_HOURS of readings as dots, with the target range drawn as a
 * dim band so in/out of range is readable at a glance. Y axis is fixed
 * (40–300 mg/dL) so the shape doesn't jump around between polls.
 */
export function renderChart(points: Point[], t: Thresholds, now = Date.now()): string {
  const ctx = canvas(CHART_W, CHART_H)
  const padL = 4
  const padR = 10
  const padT = 4
  const padB = 4
  const w = CHART_W - padL - padR
  const h = CHART_H - padT - padB
  const t0 = now - CHART_HOURS * 3_600_000
  const x = (at: number) => padL + ((at - t0) / (now - t0)) * w
  const y = (v: number) => padT + (1 - (Math.min(Y_MAX, Math.max(Y_MIN, v)) - Y_MIN) / (Y_MAX - Y_MIN)) * h

  // Target range as two dashed lines. No filled band: grey levels aren't
  // reliable across the simulator and firmware, so keep everything on/off.
  ctx.fillStyle = '#bbb'
  for (const v of [t.high, t.low]) {
    const ly = Math.round(y(v))
    for (let dx = 0; dx < w; dx += 8) ctx.fillRect(padL + dx, ly, 3, 1)
  }

  // Hour ticks along the bottom
  ctx.fillStyle = '#bbb'
  for (let i = 1; i < CHART_HOURS; i++) {
    const tx = Math.round(x(now - i * 3_600_000))
    ctx.fillRect(tx, CHART_H - padB - 5, 1, 5)
  }

  const recent = points.filter(p => p.at >= t0 && p.at <= now + 60_000).sort((a, b) => a.at - b.at)
  ctx.fillStyle = '#fff'
  for (const p of recent) {
    ctx.fillRect(Math.round(x(p.at)) - 2, Math.round(y(p.mgdl)) - 2, 4, 4)
  }
  // Emphasise the newest value
  const last = recent[recent.length - 1]
  if (last) {
    ctx.beginPath()
    ctx.arc(x(last.at), y(last.mgdl), 4.5, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.fillStyle = '#9a9a9a'
  ctx.font = `13px ${FONT}`
  ctx.textBaseline = 'top'
  ctx.fillText(`${CHART_HOURS}h`, padL + 2, padT)
  return toBase64(ctx)
}
