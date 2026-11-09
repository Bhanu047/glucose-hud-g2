/**
 * Renders the big glucose value + trend arrow to a PNG for the G2 image
 * container. The firmware font has no size control, so anything larger than
 * body text has to be drawn as an image.
 *
 * Image container limits: width 20–288, height 20–144. The host converts the
 * PNG to 4-bit greyscale; black = LED off, white = full green.
 */

export const BIG_W = 288
export const BIG_H = 144

let canvas: HTMLCanvasElement | null = null

function getCanvas(): HTMLCanvasElement {
  if (!canvas) {
    canvas = document.createElement('canvas')
    canvas.width = BIG_W
    canvas.height = BIG_H
  }
  return canvas
}

export interface BigTileInput {
  /** Already formatted in display units, e.g. "142" or "7.9" */
  value: string
  /** e.g. "↗" or "↓↓" */
  arrow: string
  /** Draw a hollow frame around the tile to signal an alert state */
  alert: boolean
  /** Dim the whole tile to signal stale data */
  stale: boolean
}

/**
 * Returns a base64 PNG (no data: prefix) ready for ImageRawDataUpdate.
 */
export function renderBigTile(input: BigTileInput): string {
  const c = getCanvas()
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, BIG_W, BIG_H)

  const ink = input.stale ? '#777' : '#fff'

  if (input.alert) {
    ctx.strokeStyle = ink
    ctx.lineWidth = 4
    ctx.strokeRect(2, 2, BIG_W - 4, BIG_H - 4)
  }

  // Pick a value font size that fits alongside the arrow.
  const arrowW = input.arrow.length > 1 ? 86 : 60
  const maxValueW = BIG_W - arrowW - 28
  let size = 112
  ctx.font = `bold ${size}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`
  while (ctx.measureText(input.value).width > maxValueW && size > 48) {
    size -= 6
    ctx.font = `bold ${size}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`
  }

  ctx.fillStyle = ink
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const valueW = ctx.measureText(input.value).width
  const totalW = valueW + 14 + arrowW
  const x0 = Math.max(10, (BIG_W - totalW) / 2)
  const cy = BIG_H / 2 + 4
  ctx.fillText(input.value, x0, cy)

  // Arrow: a bit smaller than the number, vertically centred on it.
  ctx.font = `bold ${Math.round(size * 0.62)}px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif`
  ctx.fillText(input.arrow, x0 + valueW + 14, cy)

  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}

/** Simple "no data yet" tile. */
export function renderMessageTile(line1: string, line2 = ''): string {
  const c = getCanvas()
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, BIG_W, BIG_H)
  ctx.fillStyle = '#ccc'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = 'bold 34px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'
  ctx.fillText(line1, BIG_W / 2, line2 ? BIG_H / 2 - 20 : BIG_H / 2)
  if (line2) {
    ctx.font = '22px -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif'
    ctx.fillText(line2, BIG_W / 2, BIG_H / 2 + 24)
  }
  return c.toDataURL('image/png').replace(/^data:image\/png;base64,/, '')
}
