/**
 * Phone-side companion UI. Plain DOM, no framework — the WebView is small and
 * this is a settings form plus a live preview.
 */
import {
  DEFAULT_THRESHOLDS,
  formatAge,
  formatDelta,
  formatGlucose,
  mgdlToMmol,
  mmolToMgdl,
  trendArrow,
  type Reading,
  type Units,
} from './nightscout'
import type { Settings } from './settings'

export interface PhoneUiProps {
  initial: Settings
  hasGlasses: boolean
  onSave: (s: Settings) => Promise<void>
  onTest: (s: Settings) => Promise<Reading>
}

export interface PhoneUiState {
  settings: Settings
  reading: Reading | null
  lastError: string | null
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}

/** Thresholds are stored in mg/dL; show/accept them in the user's units. */
function toDisplay(mgdl: number, units: Units): string {
  return units === 'mmol' ? mgdlToMmol(mgdl).toFixed(1) : String(Math.round(mgdl))
}
function fromDisplay(v: string, units: Units, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return units === 'mmol' ? Math.round(mmolToMgdl(n)) : Math.round(n)
}

export function mountPhoneUi(props: PhoneUiProps) {
  const url = $<HTMLInputElement>('ns-url')
  const token = $<HTMLInputElement>('ns-token')
  const relay = $<HTMLInputElement>('relay-url')
  const units = $<HTMLSelectElement>('units')
  const low = $<HTMLInputElement>('t-low')
  const high = $<HTMLInputElement>('t-high')
  const ulow = $<HTMLInputElement>('t-ulow')
  const uhigh = $<HTMLInputElement>('t-uhigh')
  const poll = $<HTMLSelectElement>('poll')
  const saveBtn = $<HTMLButtonElement>('save')
  const testBtn = $<HTMLButtonElement>('test')
  const msg = $<HTMLElement>('msg')
  const preview = $<HTMLElement>('preview')
  const glassesNote = $<HTMLElement>('glasses-note')

  glassesNote.textContent = props.hasGlasses
    ? 'Connected to Even App — the reading is showing on your glasses.'
    : 'Running in a browser without the Even App. Settings and preview still work.'

  let currentUnits: Units = props.initial.units

  const fill = (s: Settings) => {
    url.value = s.nightscoutUrl
    token.value = s.token
    relay.value = s.relayUrl
    units.value = s.units
    poll.value = String(s.pollSeconds)
    currentUnits = s.units
    low.value = toDisplay(s.thresholds.low, s.units)
    high.value = toDisplay(s.thresholds.high, s.units)
    ulow.value = toDisplay(s.thresholds.urgentLow, s.units)
    uhigh.value = toDisplay(s.thresholds.urgentHigh, s.units)
  }

  const read = (): Settings => {
    const u = units.value as Units
    return {
      nightscoutUrl: url.value.trim(),
      token: token.value.trim(),
      relayUrl: relay.value.trim(),
      units: u,
      pollSeconds: Number(poll.value) || 60,
      thresholds: {
        low: fromDisplay(low.value, u, DEFAULT_THRESHOLDS.low),
        high: fromDisplay(high.value, u, DEFAULT_THRESHOLDS.high),
        urgentLow: fromDisplay(ulow.value, u, DEFAULT_THRESHOLDS.urgentLow),
        urgentHigh: fromDisplay(uhigh.value, u, DEFAULT_THRESHOLDS.urgentHigh),
      },
    }
  }

  // Switching units converts the threshold fields in place.
  units.addEventListener('change', () => {
    const prev = read()
    const next = units.value as Units
    low.value = toDisplay(prev.thresholds.low, next)
    high.value = toDisplay(prev.thresholds.high, next)
    ulow.value = toDisplay(prev.thresholds.urgentLow, next)
    uhigh.value = toDisplay(prev.thresholds.urgentHigh, next)
    currentUnits = next
  })

  const setMsg = (text: string, kind: 'ok' | 'err' | '' = '') => {
    msg.textContent = text
    msg.className = kind
  }

  saveBtn.addEventListener('click', async () => {
    const s = read()
    if (!s.nightscoutUrl) {
      setMsg('Enter your Nightscout URL first.', 'err')
      return
    }
    if (s.thresholds.low >= s.thresholds.high) {
      setMsg('Low threshold must be below high.', 'err')
      return
    }
    saveBtn.disabled = true
    setMsg('Saving…')
    try {
      await props.onSave(s)
      setMsg('Saved.', 'ok')
    } catch (e) {
      setMsg(`Save failed: ${(e as Error).message}`, 'err')
    } finally {
      saveBtn.disabled = false
    }
  })

  testBtn.addEventListener('click', async () => {
    const s = read()
    if (!s.nightscoutUrl) {
      setMsg('Enter your Nightscout URL first.', 'err')
      return
    }
    testBtn.disabled = true
    setMsg('Testing connection…')
    try {
      const r = await props.onTest(s)
      setMsg(
        `OK — ${formatGlucose(r.mgdl, s.units)} ${trendArrow(r.trend)} (${formatAge(r.at)})`,
        'ok',
      )
    } catch (e) {
      setMsg(`Failed: ${(e as Error).message}`, 'err')
    } finally {
      testBtn.disabled = false
    }
  })

  fill(props.initial)

  return {
    render(state: PhoneUiState) {
      const { reading, lastError, settings } = state
      if (reading) {
        preview.innerHTML = `
          <div class="big">${formatGlucose(reading.mgdl, settings.units)} <span class="arrow">${trendArrow(reading.trend)}</span></div>
          <div class="sub">Δ ${formatDelta(reading.deltaMgdl, settings.units)} · ${formatAge(reading.at)}</div>`
      } else if (lastError) {
        preview.innerHTML = `<div class="sub err">${lastError}</div>`
      } else {
        preview.innerHTML = `<div class="sub">No reading yet</div>`
      }
      void currentUnits
    },
  }
}
