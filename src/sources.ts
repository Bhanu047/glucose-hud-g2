/**
 * Data sources. Each returns a history of Points (newest first).
 *
 * LibreLinkUp and Dexcom Share always go through the relay (their hosts
 * aren't whitelisted and don't send CORS headers). Nightscout goes through
 * the relay in production and can be called directly in development.
 *
 * Sessions: the relay hands back a token/session id which we keep on the
 * phone and send next time, so credentials only travel when a login is
 * actually needed (first run, or the session expired).
 */
import { toPoints, type Point } from './glucose'
import { demoPoints } from './demo'

export type SourceKind = 'nightscout' | 'libre' | 'dexcom' | 'demo'

export interface Profile {
  id: string
  /** shown on the glasses, e.g. "Me", "Mia" */
  name: string
  source: SourceKind
  /** nightscout */
  nsUrl: string
  nsToken: string
  /** libre: email; dexcom: username / email / phone */
  username: string
  password: string
  /** libre: '' (auto) or api region; dexcom: us | ous | jp */
  region: string
  /** libre: which follower connection to show */
  patientId: string
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  nightscout: 'Nightscout',
  libre: 'FreeStyle Libre (LibreLinkUp)',
  dexcom: 'Dexcom Share',
  demo: 'Demo (sample data)',
}

export function newProfile(partial: Partial<Profile> = {}): Profile {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2, 10),
    name: partial.name ?? 'Me',
    source: partial.source ?? 'libre',
    nsUrl: partial.nsUrl ?? '',
    nsToken: partial.nsToken ?? '',
    username: partial.username ?? '',
    password: partial.password ?? '',
    region: partial.region ?? (partial.source === 'dexcom' ? 'us' : ''),
    patientId: partial.patientId ?? '',
  }
}

export function profileIsComplete(p: Profile): boolean {
  if (p.source === 'demo') return true
  if (p.source === 'nightscout') return p.nsUrl.trim().length > 0
  return p.username.trim().length > 0 && p.password.length > 0
}

export type Session = Record<string, string>

export interface Connection {
  patientId: string
  name: string
}

export interface FetchResult {
  points: Point[]
  session: Session | null
  connections?: Connection[]
  patientId?: string
}

export function normalizeBaseUrl(url: string): string {
  let u = url.trim()
  if (u && !/^https?:\/\//i.test(u)) u = `https://${u}`
  return u.replace(/\/+$/, '')
}

/** 24 h at 5-minute resolution. */
const HISTORY_COUNT = 288

export function buildNightscoutUrl(p: Pick<Profile, 'nsUrl' | 'nsToken'>, relayUrl?: string, count = HISTORY_COUNT): string {
  const base = normalizeBaseUrl(p.nsUrl)
  if (relayUrl) {
    const q = new URLSearchParams({ ns: base, count: String(count) })
    if (p.nsToken) q.set('token', p.nsToken)
    return `${normalizeBaseUrl(relayUrl)}/entries?${q.toString()}`
  }
  const q = new URLSearchParams({ count: String(count) })
  if (p.nsToken) q.set('token', p.nsToken)
  return `${base}/api/v1/entries.json?${q.toString()}`
}

export class SourceError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message)
  }
}

async function errorFrom(res: Response): Promise<SourceError> {
  let msg = `HTTP ${res.status}`
  try {
    const body = await res.json()
    if (body?.error) msg = String(body.error)
  } catch {
    /* not json */
  }
  return new SourceError(msg, res.status)
}

async function fetchNightscout(p: Profile, relayUrl: string | undefined, signal?: AbortSignal): Promise<FetchResult> {
  const res = await fetch(buildNightscoutUrl(p, relayUrl), { headers: { Accept: 'application/json' }, signal })
  if (res.status === 401 || res.status === 403) throw new SourceError('Nightscout rejected the token', res.status)
  if (!res.ok) throw await errorFrom(res)
  const points = toPoints(await res.json())
  if (points.length === 0) throw new SourceError('No glucose entries returned')
  return { points, session: null }
}

async function postRelay(relayUrl: string, path: string, body: unknown, signal?: AbortSignal) {
  return fetch(`${normalizeBaseUrl(relayUrl)}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
}

/**
 * Libre/Dexcom: try with the saved session alone; only if the relay says
 * auth_required do we send the credentials.
 */
async function fetchViaRelay(
  p: Profile,
  relayUrl: string | undefined,
  session: Session | null,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (!relayUrl) throw new SourceError('Relay URL is required for this source')
  const path = p.source === 'libre' ? '/libre' : '/dexcom'
  const base = { region: p.region, ...(p.source === 'libre' ? { patientId: p.patientId } : {}) }
  const creds = p.source === 'libre' ? { email: p.username, password: p.password } : { username: p.username, password: p.password }

  let res: Response | null = null
  if (session && Object.keys(session).length > 0) {
    res = await postRelay(relayUrl, path, { ...base, ...session }, signal)
    if (res.status === 401) res = null
  }
  if (!res) res = await postRelay(relayUrl, path, { ...base, ...creds }, signal)
  if (!res.ok) throw await errorFrom(res)

  const body = await res.json()
  const points = toPoints(body.entries)
  if (points.length === 0) throw new SourceError('No glucose readings returned')
  const newSession: Session = { ...(body.session ?? {}) }
  if (p.source === 'libre' && newSession.region === undefined) newSession.region = p.region
  return { points, session: newSession, connections: body.connections, patientId: body.patientId }
}

export async function fetchPoints(
  p: Profile,
  relayUrl: string | undefined,
  session: Session | null,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (p.source === 'demo') return { points: demoPoints(p.region === 'steady' ? 'steady' : 'falling'), session: null }
  if (p.source === 'nightscout') return fetchNightscout(p, relayUrl, signal)
  return fetchViaRelay(p, relayUrl, session, signal)
}
