import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { DEFAULT_THRESHOLDS, type Thresholds, type Units } from './nightscout'

export interface Settings {
  nightscoutUrl: string
  token: string
  relayUrl: string
  units: Units
  thresholds: Thresholds
  /** seconds between polls */
  pollSeconds: number
}

export const DEFAULT_SETTINGS: Settings = {
  nightscoutUrl: '',
  token: '',
  relayUrl: '',
  units: 'mgdl',
  thresholds: { ...DEFAULT_THRESHOLDS },
  pollSeconds: 60,
}

const KEY = 'glucose-hud.settings.v1'

/**
 * Settings live in the Even App's plugin storage when the bridge is present,
 * and in window.localStorage when running in a plain browser for development.
 */
export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  const stored = await loadStored(bridge)
  return applyDevOverrides(stored)
}

/**
 * Dev/test convenience: `?ns=https://…&token=…&relay=…&units=mmol` on the page
 * URL overrides saved settings for this session only. Lets the simulator and
 * automated checks start fully configured without touching the phone form.
 */
function applyDevOverrides(s: Settings): Settings {
  if (typeof location === 'undefined') return s
  const q = new URLSearchParams(location.search)
  if (!q.has('ns')) return s
  return {
    ...s,
    nightscoutUrl: q.get('ns') ?? s.nightscoutUrl,
    token: q.get('token') ?? s.token,
    relayUrl: q.get('relay') ?? s.relayUrl,
    units: (q.get('units') as Units | null) ?? s.units,
    pollSeconds: Number(q.get('poll')) || s.pollSeconds,
  }
}

async function loadStored(bridge: EvenAppBridge | null): Promise<Settings> {
  let raw = ''
  try {
    raw = bridge ? await bridge.getLocalStorage(KEY) : (localStorage.getItem(KEY) ?? '')
  } catch {
    raw = ''
  }
  if (!raw) return { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_THRESHOLDS } }
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(parsed.thresholds ?? {}) },
    }
  } catch {
    return { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_THRESHOLDS } }
  }
}

export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<void> {
  const raw = JSON.stringify(s)
  if (bridge) {
    await bridge.setLocalStorage(KEY, raw)
  } else {
    localStorage.setItem(KEY, raw)
  }
}

export function isConfigured(s: Settings): boolean {
  return s.nightscoutUrl.trim().length > 0
}
