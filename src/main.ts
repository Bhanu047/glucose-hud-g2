import { OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Hud, buildModel, messageModel, type HudModel } from './hud'
import type { Point } from './glucose'
import { fetchPoints, profileIsComplete, type Profile, type Session } from './sources'
import { activeProfile, loadSessions, loadSettings, saveSessions, saveSettings } from './settings'
import { mountPhoneUi } from './phone-ui'

async function getBridge(timeoutMs = 1500): Promise<EvenAppBridge | null> {
  return Promise.race<EvenAppBridge | null>([
    waitForEvenAppBridge(),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK_EVENT is 0 and protobuf drops zero-valued fields; resolve inside a real envelope only.
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

/** Browser network errors are opaque ("Load failed", "Failed to fetch"); translate them. */
function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message || ''
  if ((e as Error)?.name === 'TypeError' || /load failed|failed to fetch|network/i.test(msg)) {
    return "Can't reach the server — check connection / relay"
  }
  return msg || 'Request failed'
}

async function main() {
  const bridge = await getBridge()
  let settings = await loadSettings(bridge)
  const sessions = await loadSessions(bridge)
  /** history per profile id, kept so switching people is instant */
  const history = new Map<string, Point[]>()
  const errors = new Map<string, string>()
  let inFlight: AbortController | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const hud = bridge ? new Hud(bridge) : null

  const person = () => {
    const p = activeProfile(settings)
    return p ? { name: p.name, index: settings.active, count: settings.profiles.length } : undefined
  }

  const currentModel = (): HudModel => {
    const p = activeProfile(settings)
    if (!p || !profileIsComplete(p)) {
      return messageModel('Setup', 'needed', 'Open this plugin on\nyour phone and add\na person to follow.', 'Not configured')
    }
    const pts = history.get(p.id) ?? []
    const err = errors.get(p.id)
    if (err && pts.length === 0) {
      return messageModel('Error', 'check settings on phone', '', `▲ ${err}`.slice(0, 110))
    }
    return buildModel(pts, settings, person())
  }

  const paint = async () => {
    if (!hud) return
    try {
      await hud.update(currentModel())
    } catch (e) {
      console.warn('paint failed', e)
    }
  }

  const phoneState = () => {
    const p = activeProfile(settings)
    return { settings, points: p ? (history.get(p.id) ?? []) : [], error: p ? (errors.get(p.id) ?? null) : null }
  }

  const refresh = async (): Promise<void> => {
    const p = activeProfile(settings)
    if (!p || !profileIsComplete(p)) {
      await paint()
      phone.render(phoneState())
      return
    }
    inFlight?.abort()
    inFlight = new AbortController()
    try {
      const r = await fetchPoints(p, settings.relayUrl || undefined, sessions[p.id] ?? null, inFlight.signal)
      history.set(p.id, r.points)
      errors.delete(p.id)
      if (r.session) {
        sessions[p.id] = r.session
        void saveSessions(bridge, sessions)
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      errors.set(p.id, friendlyError(e))
      console.warn('refresh failed', errors.get(p.id))
    }
    await paint()
    phone.render(phoneState())
  }

  const stopTimers = () => {
    if (pollTimer) clearInterval(pollTimer)
    if (tickTimer) clearInterval(tickTimer)
    pollTimer = tickTimer = null
  }
  const startTimers = () => {
    stopTimers()
    pollTimer = setInterval(refresh, Math.max(30, settings.pollSeconds) * 1000)
    // Keep "N min ago", staleness and the prediction honest between polls.
    tickTimer = setInterval(paint, 60_000)
  }

  const switchPerson = async (step: number) => {
    const n = settings.profiles.length
    if (n < 2) return
    settings.active = (settings.active + step + n) % n
    void saveSettings(bridge, settings)
    await paint() // show cached history instantly
    await refresh()
  }

  const phone = mountPhoneUi({
    initial: settings,
    hasGlasses: !!bridge,
    onSave: async next => {
      // Drop sessions for people whose credentials changed or who were removed.
      const before = new Map(settings.profiles.map(p => [p.id, p]))
      for (const p of next.profiles) {
        const old = before.get(p.id)
        if (!old || old.username !== p.username || old.password !== p.password || old.region !== p.region || old.source !== p.source) {
          delete sessions[p.id]
          history.delete(p.id)
        }
      }
      for (const id of Object.keys(sessions)) if (!next.profiles.some(p => p.id === id)) delete sessions[id]
      settings = next
      await saveSettings(bridge, settings)
      void saveSessions(bridge, sessions)
      await refresh()
      startTimers()
    },
    onTest: async (p: Profile, relayUrl: string) => {
      const r = await fetchPoints(p, relayUrl || undefined, null)
      if (r.session) sessions[p.id] = r.session as Session
      return r
    },
  })
  phone.render(phoneState())

  if (!bridge || !hud) {
    console.info('No Even bridge detected — running phone UI only.')
    await refresh()
    startTimers()
    return
  }

  const ok = await hud.create(currentModel())
  if (!ok) console.error('createStartUpPageContainer failed')

  const unsubscribe = bridge.onEvenHubEvent(event => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    const is = (t: OsEventTypeList) => sysType === t || textType === t

    if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) {
      stopTimers()
      unsubscribe()
      bridge.shutDownPageContainer(1)
      return
    }
    if (is(OsEventTypeList.SCROLL_TOP_EVENT)) {
      void switchPerson(-1)
      return
    }
    if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) {
      void switchPerson(1)
      return
    }
    if (is(OsEventTypeList.CLICK_EVENT)) {
      void refresh()
      return
    }
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      void hud.rebuild(currentModel()).then(refresh)
      startTimers()
      return
    }
    if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      stopTimers()
      unsubscribe()
    }
  })

  await refresh()
  startTimers()
}

main().catch(e => console.error('fatal', e))
