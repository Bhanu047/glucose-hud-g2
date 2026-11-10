import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { DEFAULT_THRESHOLDS, type Thresholds, type Units } from './glucose'
import { newProfile, type Profile, type Session, type SourceKind } from './sources'

export const PUBLIC_RELAY = 'https://glucose-relay.bhanumanideep.workers.dev'

export interface Settings {
  /** people to show; ring/touchpad swipe cycles through them */
  profiles: Profile[]
  /** index into profiles */
  active: number
  relayUrl: string
  units: Units
  thresholds: Thresholds
  /** seconds between polls */
  pollSeconds: number
}

export function defaultSettings(): Settings {
  return {
    profiles: [],
    active: 0,
    relayUrl: PUBLIC_RELAY,
    units: 'mgdl',
    thresholds: { ...DEFAULT_THRESHOLDS },
    pollSeconds: 60,
  }
}

const KEY = 'glucose-hud.settings.v1'
const SESSIONS_KEY = 'glucose-hud.sessions.v1'

async function readRaw(bridge: EvenAppBridge | null, key: string): Promise<string> {
  try {
    return bridge ? await bridge.getLocalStorage(key) : (localStorage.getItem(key) ?? '')
  } catch {
    return ''
  }
}

async function writeRaw(bridge: EvenAppBridge | null, key: string, value: string) {
  if (bridge) await bridge.setLocalStorage(key, value)
  else localStorage.setItem(key, value)
}

/** Accepts v0.1 settings (single Nightscout site) and upgrades them. */
export function migrate(raw: unknown): Settings {
  const d = defaultSettings()
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Record<string, unknown>
  const profiles = Array.isArray(r.profiles) ? (r.profiles as Partial<Profile>[]).map(p => newProfile(p)) : []
  if (profiles.length === 0 && typeof r.nightscoutUrl === 'string' && r.nightscoutUrl.trim()) {
    profiles.push(
      newProfile({ name: 'Me', source: 'nightscout', nsUrl: r.nightscoutUrl, nsToken: typeof r.token === 'string' ? r.token : '' }),
    )
  }
  const s: Settings = {
    ...d,
    profiles,
    active: typeof r.active === 'number' ? r.active : 0,
    // Production builds only ever talk to the whitelisted relay.
    relayUrl: import.meta.env.DEV && typeof r.relayUrl === 'string' && r.relayUrl.trim() ? r.relayUrl : d.relayUrl,
    units: r.units === 'mmol' ? 'mmol' : 'mgdl',
    thresholds: { ...DEFAULT_THRESHOLDS, ...((r.thresholds as Partial<Thresholds>) ?? {}) },
    pollSeconds: typeof r.pollSeconds === 'number' ? r.pollSeconds : d.pollSeconds,
  }
  if (s.active < 0 || s.active >= Math.max(1, s.profiles.length)) s.active = 0
  return s
}

export async function loadSettings(bridge: EvenAppBridge | null): Promise<Settings> {
  const raw = await readRaw(bridge, KEY)
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  return applyDevOverrides(migrate(parsed))
}

export async function saveSettings(bridge: EvenAppBridge | null, s: Settings): Promise<void> {
  await writeRaw(bridge, KEY, JSON.stringify(s))
}

export async function loadSessions(bridge: EvenAppBridge | null): Promise<Record<string, Session>> {
  try {
    const raw = await readRaw(bridge, SESSIONS_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

export async function saveSessions(bridge: EvenAppBridge | null, s: Record<string, Session>): Promise<void> {
  try {
    await writeRaw(bridge, SESSIONS_KEY, JSON.stringify(s))
  } catch {
    /* non-fatal */
  }
}

export const activeProfile = (s: Settings): Profile | null => s.profiles[s.active] ?? null

/**
 * Dev/test only: query-string overrides so the simulator can start fully
 * configured. Examples:
 *   ?ns=http://localhost:1337               single Nightscout person
 *   ?src=libre&user=a@b.c&pass=x&relay=http://localhost:8787
 *   ?people=[{"name":"Mia","source":"libre",...}]&relay=...
 */
function applyDevOverrides(s: Settings): Settings {
  if (!import.meta.env.DEV || typeof location === 'undefined') return s
  const q = new URLSearchParams(location.search)
  const out: Settings = { ...s }
  if (q.has('relay')) out.relayUrl = q.get('relay') ?? ''
  if (q.has('units')) out.units = q.get('units') === 'mmol' ? 'mmol' : 'mgdl'
  if (q.has('poll')) out.pollSeconds = Number(q.get('poll')) || out.pollSeconds
  if (q.has('people')) {
    try {
      out.profiles = (JSON.parse(q.get('people') ?? '[]') as Partial<Profile>[]).map(p => newProfile(p))
      out.active = 0
    } catch {
      /* ignore */
    }
  } else if (q.has('ns') || q.has('src')) {
    const source = (q.get('src') as SourceKind | null) ?? 'nightscout'
    out.profiles = [
      newProfile({
        name: q.get('name') ?? 'Me',
        source,
        nsUrl: q.get('ns') ?? '',
        nsToken: q.get('token') ?? '',
        username: q.get('user') ?? '',
        password: q.get('pass') ?? '',
        region: q.get('region') ?? (source === 'dexcom' ? 'us' : ''),
      }),
    ]
    out.active = 0
    if (source === 'nightscout' && !q.has('relay')) out.relayUrl = ''
  }
  return out
}
