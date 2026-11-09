import { OsEventTypeList, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { Hud, buildModel, errorModel, setupModel } from './hud'
import { fetchReading, type Reading } from './nightscout'
import { isConfigured, loadSettings, saveSettings } from './settings'
import { mountPhoneUi } from './phone-ui'

/**
 * The Even App injects the bridge into the WebView. In a plain desktop browser
 * (vite dev without the simulator) it never appears, so give it a moment and
 * then run phone-UI-only so settings can still be edited and tested.
 */
async function getBridge(timeoutMs = 1500): Promise<EvenAppBridge | null> {
  return Promise.race<EvenAppBridge | null>([
    waitForEvenAppBridge(),
    new Promise(resolve => setTimeout(() => resolve(null), timeoutMs)),
  ])
}

function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  // CLICK_EVENT is 0 and protobuf drops zero-valued fields, so a tap arrives
  // with eventType undefined. Resolve the default only inside a real envelope.
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

/** Browser network errors are opaque ("Load failed", "Failed to fetch"); translate them. */
function friendlyError(e: unknown): string {
  const msg = (e as Error)?.message || ''
  if ((e as Error)?.name === 'TypeError' || /load failed|failed to fetch|network/i.test(msg)) {
    return "Can't reach Nightscout — check URL / relay"
  }
  return msg || 'Request failed'
}

async function main() {
  const bridge = await getBridge()
  let settings = await loadSettings(bridge)
  let reading: Reading | null = null
  let lastError: string | null = null
  let inFlight: AbortController | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let tickTimer: ReturnType<typeof setInterval> | null = null

  const hud = bridge ? new Hud(bridge) : null

  const currentModel = () => {
    if (!isConfigured(settings)) return setupModel()
    if (lastError && !reading) return errorModel(lastError)
    return buildModel(reading, settings)
  }

  const paint = async () => {
    if (!hud) return
    try {
      await hud.update(currentModel())
    } catch (e) {
      console.warn('paint failed', e)
    }
  }

  const refresh = async (): Promise<void> => {
    if (!isConfigured(settings)) {
      await paint()
      return
    }
    inFlight?.abort()
    inFlight = new AbortController()
    try {
      reading = await fetchReading({
        nightscoutUrl: settings.nightscoutUrl,
        token: settings.token || undefined,
        relayUrl: settings.relayUrl || undefined,
        signal: inFlight.signal,
      })
      lastError = null
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      lastError = friendlyError(e)
      console.warn('refresh failed', lastError)
    }
    await paint()
    phone.render({ settings, reading, lastError })
  }

  const startTimers = () => {
    stopTimers()
    pollTimer = setInterval(refresh, Math.max(30, settings.pollSeconds) * 1000)
    // Re-paint once a minute so "N min ago" and stale state stay honest
    // between polls without hitting the network.
    tickTimer = setInterval(paint, 60_000)
  }
  const stopTimers = () => {
    if (pollTimer) clearInterval(pollTimer)
    if (tickTimer) clearInterval(tickTimer)
    pollTimer = tickTimer = null
  }

  // Phone-side settings UI (runs in the WebView on the phone, not the glasses).
  const phone = mountPhoneUi({
    initial: settings,
    hasGlasses: !!bridge,
    onSave: async next => {
      settings = next
      await saveSettings(bridge, settings)
      reading = null
      lastError = null
      await refresh()
      startTimers()
    },
    onTest: async next => {
      const r = await fetchReading({
        nightscoutUrl: next.nightscoutUrl,
        token: next.token || undefined,
        relayUrl: next.relayUrl || undefined,
      })
      return r
    },
  })
  phone.render({ settings, reading, lastError })

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

    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      stopTimers()
      unsubscribe()
      bridge.shutDownPageContainer(1)
      return
    }
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      void refresh()
      return
    }
    if (sysType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      // Host clears the page on backgrounding; a full rebuild is required here.
      void hud.rebuild(currentModel()).then(refresh)
      startTimers()
      return
    }
    if (sysType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      // Keep polling (cheap) so the number is fresh the instant we come back;
      // visual updates are dropped by the host while backgrounded anyway.
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
