/**
 * Glasses layout, 576x288:
 *
 *  ┌──────────────────────────────┬───────────────────────┐
 *  │ [big 288x136]  142 ↗         │ Δ +4 mg/dL            │
 *  │                              │ Rising slowly         │
 *  │                              │ 3 min ago             │
 *  │                              │ ▼ LOW in ~18 min      │
 *  ├──────────────────────────────┼───────────────────────┤
 *  │ [chart 288x96] 3h + band     │ 24h in range 78%      │
 *  │                              │ avg 128 · 68–195      │
 *  ├──────────────────────────────┴───────────────────────┤
 *  │ ● In range 70–180 mg/dL                Mia  1/2 ↕    │
 *  └───────────────────────────────────────────────────────┘
 */
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import {
  classify,
  computeStats,
  currentReading,
  formatAge,
  formatDelta,
  formatGlucose,
  formatPrediction,
  isStale,
  predict,
  rangeLabel,
  trendArrow,
  trendLabel,
  unitsLabel,
  type Point,
} from './glucose'
import { BIG_H, BIG_W, CHART_H, CHART_W, renderBigTile, renderBlankChart, renderChart, renderMessageTile } from './render'
import type { Settings } from './settings'

const ID = { big: 1, chart: 2, info: 3, stats: 4, status: 5 } as const
const NAME = { big: 'big', chart: 'chart', info: 'info', stats: 'stats', status: 'status' } as const

function text(id: number, name: string, x: number, y: number, w: number, h: number, capture = 0) {
  return new TextContainerProperty({
    xPosition: x,
    yPosition: y,
    width: w,
    height: h,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: id,
    containerName: name,
    content: '',
    isEventCapture: capture,
  })
}

function containers() {
  return {
    big: new ImageContainerProperty({
      xPosition: 8,
      yPosition: 2,
      width: BIG_W,
      height: BIG_H,
      containerID: ID.big,
      containerName: NAME.big,
    }),
    chart: new ImageContainerProperty({
      xPosition: 8,
      yPosition: 146,
      width: CHART_W,
      height: CHART_H,
      containerID: ID.chart,
      containerName: NAME.chart,
    }),
    info: text(ID.info, NAME.info, 304, 8, 268, 132),
    stats: text(ID.stats, NAME.stats, 304, 150, 268, 92),
    status: text(ID.status, NAME.status, 8, 250, 564, 38, 1),
  }
}

export interface HudModel {
  big: string
  chart: string
  info: string
  stats: string
  status: string
}

export interface PersonLabel {
  name: string
  index: number
  count: number
}

function personSuffix(p?: PersonLabel): string {
  if (!p) return ''
  return p.count > 1 ? `   ${p.name} ${p.index + 1}/${p.count} ↕` : p.name && p.name !== 'Me' ? `   ${p.name}` : ''
}

/** Pure-ish (uses canvas): turns history + settings into what the glasses show. */
export function buildModel(points: Point[], s: Settings, person?: PersonLabel, now = Date.now()): HudModel {
  const cur = currentReading(points)
  const u = unitsLabel(s.units)
  const range = `${formatGlucose(s.thresholds.low, s.units)}–${formatGlucose(s.thresholds.high, s.units)} ${u}`
  if (!cur) {
    return {
      big: renderMessageTile('No data'),
      chart: renderBlankChart(),
      info: '',
      stats: '',
      status: `No data yet${personSuffix(person)}`,
    }
  }
  const stale = isStale(cur.at, now)
  const state = classify(cur.mgdl, s.thresholds)
  const pred = stale ? null : predict(points, s.thresholds, now)

  const info = [`Δ ${formatDelta(cur.deltaMgdl, s.units)} ${u}`, trendLabel(cur.trend), formatAge(cur.at, now)]
  if (pred) info.push(formatPrediction(pred))

  const st = computeStats(points, s.thresholds, now)
  const stats = st
    ? [
        `${st.hours}h in range ${st.tir}%`,
        `avg ${formatGlucose(st.avg, s.units)} · ${formatGlucose(st.min, s.units)}–${formatGlucose(st.max, s.units)}`,
      ].join('\n')
    : 'Collecting history…'

  let status: string
  if (stale) status = `▲ STALE — last reading ${formatAge(cur.at, now)}`
  else if (state !== 'inRange') status = `${state === 'low' || state === 'urgentLow' ? '▼' : '▲'} ${rangeLabel(state)}  (${range})`
  else status = `● In range  ${range}`
  status += personSuffix(person)

  return {
    big: renderBigTile({
      value: formatGlucose(cur.mgdl, s.units),
      arrow: trendArrow(cur.trend),
      alert: state !== 'inRange' || pred?.kind === 'low',
      stale,
    }),
    chart: renderChart(points, s.thresholds, now),
    info: info.join('\n'),
    stats,
    status,
  }
}

export function messageModel(title: string, sub: string, info: string, status: string): HudModel {
  return {
    big: renderMessageTile(title, sub),
    chart: renderBlankChart(),
    info,
    stats: '',
    status,
  }
}

export class Hud {
  private created = false
  private imageBusy = false
  private pending: Array<{ id: number; name: string; data: string }> = []
  private last: HudModel | null = null

  constructor(private bridge: EvenAppBridge) {}

  private layout(model: HudModel) {
    const c = containers()
    c.info.content = model.info
    c.stats.content = model.stats
    c.status.content = model.status
    return {
      containerTotalNum: 5,
      imageObject: [c.big, c.chart],
      textObject: [c.info, c.stats, c.status],
    }
  }

  async create(model: HudModel): Promise<boolean> {
    const result = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.layout(model)))
    this.created = result === 0
    if (this.created) {
      this.last = model
      await this.sendImage(ID.big, NAME.big, model.big)
      await this.sendImage(ID.chart, NAME.chart, model.chart)
    }
    return this.created
  }

  /** Full redraw after FOREGROUND_ENTER (the host clears the page when backgrounded). */
  async rebuild(model: HudModel): Promise<void> {
    await this.bridge.rebuildPageContainer(new RebuildPageContainer(this.layout(model)))
    this.last = model
    await this.sendImage(ID.big, NAME.big, model.big)
    await this.sendImage(ID.chart, NAME.chart, model.chart)
  }

  async update(model: HudModel): Promise<void> {
    if (!this.created) return
    const prev = this.last
    this.last = model
    const jobs: Promise<unknown>[] = []
    const up = (id: number, name: string, content: string) =>
      jobs.push(this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: id, containerName: name, content })))
    if (prev?.info !== model.info) up(ID.info, NAME.info, model.info)
    if (prev?.stats !== model.stats) up(ID.stats, NAME.stats, model.stats)
    if (prev?.status !== model.status) up(ID.status, NAME.status, model.status)
    await Promise.all(jobs)
    if (prev?.big !== model.big) await this.sendImage(ID.big, NAME.big, model.big)
    if (prev?.chart !== model.chart) await this.sendImage(ID.chart, NAME.chart, model.chart)
  }

  /** Image sends must never overlap. Keep only the latest pending frame per container. */
  private async sendImage(id: number, name: string, data: string): Promise<void> {
    if (this.imageBusy) {
      this.pending = this.pending.filter(p => p.id !== id)
      this.pending.push({ id, name, data })
      return
    }
    this.imageBusy = true
    try {
      await this.bridge.updateImageRawData(new ImageRawDataUpdate({ containerID: id, containerName: name, imageData: data }))
    } catch (e) {
      console.warn('image send failed', e)
    } finally {
      this.imageBusy = false
    }
    const next = this.pending.shift()
    if (next) await this.sendImage(next.id, next.name, next.data)
  }
}
