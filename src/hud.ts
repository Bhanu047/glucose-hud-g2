/**
 * Glasses-side layout for the 576x288 canvas.
 *
 *  ┌──────────────────────────────┬───────────────────────┐
 *  │  [image 288x144]             │  Δ +4 mg/dL           │
 *  │   142 ↗                      │  Rising slowly        │
 *  │                              │  3 min ago            │
 *  ├──────────────────────────────┴───────────────────────┤
 *  │  ● In range  70–180 mg/dL                             │
 *  │  tap: refresh · double-tap: exit                      │
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
  formatAge,
  formatDelta,
  formatGlucose,
  isStale,
  rangeLabel,
  trendArrow,
  trendLabel,
  unitsLabel,
  type Reading,
} from './nightscout'
import { BIG_H, BIG_W, renderBigTile, renderMessageTile } from './render'
import type { Settings } from './settings'

const ID = { big: 1, info: 2, status: 3, foot: 4 } as const
const NAME = { big: 'big', info: 'info', status: 'status', foot: 'foot' } as const

const FOOTER = 'tap: refresh · double-tap: exit'

function containers() {
  const big = new ImageContainerProperty({
    xPosition: 8,
    yPosition: 32,
    width: BIG_W,
    height: BIG_H,
    containerID: ID.big,
    containerName: NAME.big,
  })
  const info = new TextContainerProperty({
    xPosition: 312,
    yPosition: 40,
    width: 256,
    height: 136,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: ID.info,
    containerName: NAME.info,
    content: '',
    isEventCapture: 0,
  })
  const status = new TextContainerProperty({
    xPosition: 8,
    yPosition: 200,
    width: 560,
    height: 48,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: ID.status,
    containerName: NAME.status,
    content: 'Connecting…',
    isEventCapture: 1,
  })
  const foot = new TextContainerProperty({
    xPosition: 8,
    yPosition: 250,
    width: 560,
    height: 38,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: ID.foot,
    containerName: NAME.foot,
    content: FOOTER,
    isEventCapture: 0,
  })
  return { big, info, status, foot }
}

export interface HudModel {
  info: string
  status: string
  tile: string // base64 png
}

/** Pure: turns a reading + settings into the strings/pixels to show. */
export function buildModel(reading: Reading | null, s: Settings, now = Date.now()): HudModel {
  if (!reading) {
    return {
      info: '',
      status: 'No data yet',
      tile: renderMessageTile('No data'),
    }
  }
  const stale = isStale(reading.at, now)
  const state = classify(reading.mgdl, s.thresholds)
  const alert = state !== 'inRange'
  const u = unitsLabel(s.units)

  const info = [
    `Δ ${formatDelta(reading.deltaMgdl, s.units)} ${u}`,
    trendLabel(reading.trend),
    formatAge(reading.at, now),
  ].join('\n')

  let status: string
  if (stale) {
    status = `▲ STALE — last reading ${formatAge(reading.at, now)}`
  } else if (alert) {
    const marker = state === 'low' || state === 'urgentLow' ? '▼' : '▲'
    status = `${marker} ${rangeLabel(state)}  (${formatGlucose(s.thresholds.low, s.units)}–${formatGlucose(s.thresholds.high, s.units)} ${u})`
  } else {
    status = `● In range  ${formatGlucose(s.thresholds.low, s.units)}–${formatGlucose(s.thresholds.high, s.units)} ${u}`
  }

  const tile = renderBigTile({
    value: formatGlucose(reading.mgdl, s.units),
    arrow: trendArrow(reading.trend),
    alert,
    stale,
  })

  return { info, status, tile }
}

export function errorModel(message: string): HudModel {
  return {
    info: '',
    status: `▲ ${message}`.slice(0, 120),
    tile: renderMessageTile('Error', 'check settings on phone'),
  }
}

export function setupModel(): HudModel {
  return {
    info: 'Open this plugin on\nyour phone to enter\nyour Nightscout URL.',
    status: 'Not configured',
    tile: renderMessageTile('Setup', 'needed'),
  }
}

export class Hud {
  private created = false
  private imageBusy = false
  private pendingTile: string | null = null
  private last: HudModel | null = null

  constructor(private bridge: EvenAppBridge) {}

  /** First paint. Must be called exactly once per app launch. */
  async create(model: HudModel): Promise<boolean> {
    const c = containers()
    c.info.content = model.info
    c.status.content = model.status
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 4,
        imageObject: [c.big],
        textObject: [c.info, c.status, c.foot],
      }),
    )
    this.created = result === 0
    if (this.created) {
      this.last = model
      await this.sendTile(model.tile)
    }
    return this.created
  }

  /**
   * Full redraw. Used after FOREGROUND_ENTER, when the host has cleared the
   * page and in-place upgrades would be dropped.
   */
  async rebuild(model: HudModel): Promise<void> {
    const c = containers()
    c.info.content = model.info
    c.status.content = model.status
    await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 4,
        imageObject: [c.big],
        textObject: [c.info, c.status, c.foot],
      }),
    )
    this.last = model
    await this.sendTile(model.tile)
  }

  /** Cheap in-place update: only touches what changed. */
  async update(model: HudModel): Promise<void> {
    if (!this.created) return
    const prev = this.last
    this.last = model
    const jobs: Promise<unknown>[] = []
    if (!prev || prev.info !== model.info) {
      jobs.push(
        this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: ID.info, containerName: NAME.info, content: model.info }),
        ),
      )
    }
    if (!prev || prev.status !== model.status) {
      jobs.push(
        this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: ID.status, containerName: NAME.status, content: model.status }),
        ),
      )
    }
    await Promise.all(jobs)
    if (!prev || prev.tile !== model.tile) await this.sendTile(model.tile)
  }

  /** Image sends must never overlap; queue the latest and drop older ones. */
  private async sendTile(base64Png: string): Promise<void> {
    if (this.imageBusy) {
      this.pendingTile = base64Png
      return
    }
    this.imageBusy = true
    try {
      await this.bridge.updateImageRawData(
        new ImageRawDataUpdate({ containerID: ID.big, containerName: NAME.big, imageData: base64Png }),
      )
    } catch (e) {
      console.warn('image send failed', e)
    } finally {
      this.imageBusy = false
    }
    if (this.pendingTile) {
      const next = this.pendingTile
      this.pendingTile = null
      await this.sendTile(next)
    }
  }
}
