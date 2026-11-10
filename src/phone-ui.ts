/**
 * Phone-side companion UI: people list + editor, display settings, live preview.
 * Plain DOM; the WebView is small and this is mostly a form.
 */
import {
  DEFAULT_THRESHOLDS,
  classify,
  computeStats,
  currentReading,
  formatAge,
  formatDelta,
  formatGlucose,
  formatPrediction,
  mgdlToMmol,
  mmolToMgdl,
  predict,
  trendArrow,
  type Point,
  type Units,
} from './glucose'
import { SOURCE_LABELS, newProfile, profileIsComplete, type FetchResult, type Profile, type SourceKind } from './sources'
import type { Settings } from './settings'

export interface PhoneUiProps {
  initial: Settings
  hasGlasses: boolean
  onSave: (s: Settings) => Promise<void>
  onTest: (p: Profile, relayUrl: string) => Promise<FetchResult>
}

export interface PhoneUiState {
  settings: Settings
  points: Point[]
  error: string | null
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`#${id} missing`)
  return el as T
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const toDisplay = (mgdl: number, u: Units) => (u === 'mmol' ? mgdlToMmol(mgdl).toFixed(1) : String(Math.round(mgdl)))
function fromDisplay(v: string, u: Units, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return u === 'mmol' ? Math.round(mmolToMgdl(n)) : Math.round(n)
}

const clone = (s: Settings): Settings => JSON.parse(JSON.stringify(s))

export function mountPhoneUi(props: PhoneUiProps) {
  let settings = clone(props.initial)
  let editing: Profile | null = null
  let editingIsNew = false

  $('glasses-note').textContent = props.hasGlasses
    ? 'Connected to the Even app. Your reading is on the glasses.'
    : 'Running in a browser without the Even app. Settings and preview still work.'

  /* ---------------- People list ---------------- */

  const peopleEl = $('people')
  const renderPeople = () => {
    if (settings.profiles.length === 0) {
      peopleEl.innerHTML = '<p class="empty">No one added yet.</p>'
      return
    }
    peopleEl.innerHTML = settings.profiles
      .map(
        (p, i) => `
        <div class="person ${i === settings.active ? 'active' : ''}" data-i="${i}">
          <span class="dot"></span>
          <div class="meta"><b>${esc(p.name || 'Unnamed')}</b><span>${esc(SOURCE_LABELS[p.source])}${profileIsComplete(p) ? '' : ' · incomplete'}</span></div>
          <button class="small" data-act="show" data-i="${i}">${i === settings.active ? 'Showing' : 'Show'}</button>
          <button class="small" data-act="edit" data-i="${i}">Edit</button>
        </div>`,
      )
      .join('')
  }

  peopleEl.addEventListener('click', async ev => {
    const btn = (ev.target as HTMLElement).closest('button')
    if (!btn) return
    const i = Number(btn.dataset.i)
    if (btn.dataset.act === 'show' && i !== settings.active) {
      settings.active = i
      renderPeople()
      await props.onSave(clone(settings))
    }
    if (btn.dataset.act === 'edit') openEditor(settings.profiles[i], false)
  })

  $('add-person').addEventListener('click', () =>
    openEditor(newProfile({ name: settings.profiles.length === 0 ? 'Me' : '' }), true),
  )

  // One tap: two sample people so every feature shows up on the glasses,
  // including the predicted-low warning and swiping between people.
  $('try-demo').addEventListener('click', async () => {
    const hasDemo = settings.profiles.some(p => p.source === 'demo')
    if (!hasDemo) {
      settings.profiles.push(
        newProfile({ name: 'Alex', source: 'demo', region: 'falling' }),
        newProfile({ name: 'Sam', source: 'demo', region: 'steady' }),
      )
    }
    settings.active = settings.profiles.findIndex(p => p.source === 'demo')
    closeEditor()
    renderPeople()
    await props.onSave(clone(settings))
  })

  /* ---------------- Editor ---------------- */

  const f = {
    card: $('editor'),
    title: $('editor-title'),
    name: $<HTMLInputElement>('p-name'),
    source: $<HTMLSelectElement>('p-source'),
    nsBox: $('f-ns'),
    nsUrl: $<HTMLInputElement>('p-ns-url'),
    nsToken: $<HTMLInputElement>('p-ns-token'),
    accBox: $('f-account'),
    userLabel: $('p-user-label'),
    user: $<HTMLInputElement>('p-user'),
    pass: $<HTMLInputElement>('p-pass'),
    regionBox: $('f-region'),
    region: $<HTMLSelectElement>('p-region'),
    patientBox: $('f-patient'),
    patient: $<HTMLSelectElement>('p-patient'),
    hint: $('account-hint'),
    del: $<HTMLButtonElement>('p-delete'),
    msg: $('p-msg'),
  }

  const setMsg = (el: HTMLElement, text: string, kind: 'ok' | 'err' | '' = '') => {
    el.textContent = text
    el.className = `msg ${kind}`
  }

  const syncSourceFields = () => {
    const src = f.source.value as SourceKind
    f.nsBox.classList.toggle('hidden', src !== 'nightscout')
    f.accBox.classList.toggle('hidden', src === 'nightscout' || src === 'demo')
    f.regionBox.classList.toggle('hidden', src !== 'dexcom')
    if (src === 'libre') {
      f.userLabel.textContent = 'LibreLinkUp email'
      f.user.placeholder = 'you@example.com'
      f.hint.textContent =
        'Use a LibreLinkUp (follower) account that follows the sensor wearer. In the Libre app: Connected Apps → LibreLinkUp → add the follower.'
    } else if (src === 'dexcom') {
      f.userLabel.textContent = 'Dexcom username, email or phone'
      f.user.placeholder = 'username'
      f.hint.textContent = 'Use the sensor wearer’s Dexcom account. Share must be on with at least one follower.'
      f.patientBox.classList.add('hidden')
    }
  }
  f.source.addEventListener('change', () => {
    f.patientBox.classList.add('hidden')
    syncSourceFields()
  })

  function openEditor(p: Profile, isNew: boolean) {
    editing = { ...p }
    editingIsNew = isNew
    f.title.textContent = isNew ? 'Add person' : `Edit ${p.name || 'person'}`
    f.name.value = p.name
    f.source.value = p.source
    f.nsUrl.value = p.nsUrl
    f.nsToken.value = p.nsToken
    f.user.value = p.username
    f.pass.value = p.password
    f.region.value = p.source === 'dexcom' ? p.region || 'us' : 'us'
    f.patient.innerHTML = p.patientId ? `<option value="${esc(p.patientId)}">Saved selection</option>` : ''
    f.patientBox.classList.toggle('hidden', !(p.source === 'libre' && p.patientId))
    f.del.classList.toggle('hidden', isNew)
    setMsg(f.msg, '')
    syncSourceFields()
    f.card.classList.remove('hidden')
    f.card.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const closeEditor = () => {
    editing = null
    f.card.classList.add('hidden')
  }

  const readEditor = (): Profile => {
    const src = f.source.value as SourceKind
    return newProfile({
      id: editing?.id,
      name: f.name.value.trim() || 'Me',
      source: src,
      nsUrl: f.nsUrl.value.trim(),
      nsToken: f.nsToken.value.trim(),
      username: f.user.value.trim(),
      password: f.pass.value,
      region:
        src === 'dexcom'
          ? f.region.value
          : src === 'libre'
            ? editing?.source === 'libre'
              ? editing.region
              : ''
            : src === 'demo'
              ? editing?.source === 'demo' && editing.region
                ? editing.region
                : 'falling'
              : '',
      patientId: src === 'libre' ? f.patient.value || '' : '',
    })
  }

  $('p-test').addEventListener('click', async () => {
    const p = readEditor()
    if (!profileIsComplete(p)) {
      setMsg(f.msg, p.source === 'nightscout' ? 'Enter the full Nightscout address (it starts with https)' : 'Enter the username and password.', 'err')
      return
    }
    const btn = $<HTMLButtonElement>('p-test')
    btn.disabled = true
    setMsg(f.msg, 'Connecting…')
    try {
      const r = await props.onTest(p, settings.relayUrl)
      if (editing && r.session?.region !== undefined) editing.region = r.session.region
      if (r.connections && r.connections.length > 1) {
        f.patient.innerHTML = r.connections
          .map(c => `<option value="${esc(c.patientId)}" ${c.patientId === r.patientId ? 'selected' : ''}>${esc(c.name)}</option>`)
          .join('')
        f.patientBox.classList.remove('hidden')
      } else if (r.patientId) {
        f.patient.innerHTML = `<option value="${esc(r.patientId)}" selected>${esc(r.connections?.[0]?.name ?? 'Patient')}</option>`
      }
      const cur = currentReading(r.points)
      setMsg(
        f.msg,
        cur ? `Connected: ${formatGlucose(cur.mgdl, settings.units)} ${trendArrow(cur.trend)} (${formatAge(cur.at)}), ${r.points.length} readings` : 'Connected',
        'ok',
      )
    } catch (e) {
      setMsg(f.msg, `Failed: ${(e as Error).message}`, 'err')
    } finally {
      btn.disabled = false
    }
  })

  $('p-save').addEventListener('click', async () => {
    const p = readEditor()
    if (!profileIsComplete(p)) {
      setMsg(f.msg, p.source === 'nightscout' ? 'Enter the full Nightscout address (it starts with https)' : 'Fill in the connection details first.', 'err')
      return
    }
    const i = settings.profiles.findIndex(x => x.id === p.id)
    if (i >= 0) settings.profiles[i] = p
    else {
      settings.profiles.push(p)
      if (editingIsNew && settings.profiles.length === 1) settings.active = 0
    }
    closeEditor()
    renderPeople()
    setMsg($('d-msg'), '')
    await props.onSave(clone(settings))
  })

  $('p-cancel').addEventListener('click', closeEditor)

  $('p-delete').addEventListener('click', async () => {
    if (!editing) return
    const i = settings.profiles.findIndex(x => x.id === editing!.id)
    if (i < 0) return closeEditor()
    if (!confirm(`Remove ${settings.profiles[i].name}? Saved credentials for this person are deleted from this phone.`)) return
    settings.profiles.splice(i, 1)
    if (settings.active >= settings.profiles.length) settings.active = Math.max(0, settings.profiles.length - 1)
    closeEditor()
    renderPeople()
    await props.onSave(clone(settings))
  })

  /* ---------------- Display settings ---------------- */

  const d = {
    units: $<HTMLSelectElement>('units'),
    low: $<HTMLInputElement>('t-low'),
    high: $<HTMLInputElement>('t-high'),
    ulow: $<HTMLInputElement>('t-ulow'),
    uhigh: $<HTMLInputElement>('t-uhigh'),
    poll: $<HTMLSelectElement>('poll'),
    relay: $<HTMLInputElement>('relay-url'),
  }
  const fillDisplay = () => {
    const u = settings.units
    d.units.value = u
    d.low.value = toDisplay(settings.thresholds.low, u)
    d.high.value = toDisplay(settings.thresholds.high, u)
    d.ulow.value = toDisplay(settings.thresholds.urgentLow, u)
    d.uhigh.value = toDisplay(settings.thresholds.urgentHigh, u)
    d.poll.value = String(settings.pollSeconds)
    d.relay.value = settings.relayUrl
  }
  const readThresholds = (u: Units) => ({
    low: fromDisplay(d.low.value, u, DEFAULT_THRESHOLDS.low),
    high: fromDisplay(d.high.value, u, DEFAULT_THRESHOLDS.high),
    urgentLow: fromDisplay(d.ulow.value, u, DEFAULT_THRESHOLDS.urgentLow),
    urgentHigh: fromDisplay(d.uhigh.value, u, DEFAULT_THRESHOLDS.urgentHigh),
  })
  let shownUnits: Units = settings.units
  d.units.addEventListener('change', () => {
    const t = readThresholds(shownUnits)
    shownUnits = d.units.value as Units
    d.low.value = toDisplay(t.low, shownUnits)
    d.high.value = toDisplay(t.high, shownUnits)
    d.ulow.value = toDisplay(t.urgentLow, shownUnits)
    d.uhigh.value = toDisplay(t.urgentHigh, shownUnits)
  })

  $('save-display').addEventListener('click', async () => {
    const u = d.units.value as Units
    const t = readThresholds(u)
    if (!(t.urgentLow < t.low && t.low < t.high && t.high < t.urgentHigh)) {
      setMsg($('d-msg'), 'Thresholds must go urgent low < low < high < urgent high.', 'err')
      return
    }
    settings.units = u
    settings.thresholds = t
    settings.pollSeconds = Number(d.poll.value) || 60
    if (import.meta.env.DEV) settings.relayUrl = d.relay.value.trim()
    setMsg($('d-msg'), 'Saving…')
    try {
      await props.onSave(clone(settings))
      setMsg($('d-msg'), 'Saved.', 'ok')
    } catch (e) {
      setMsg($('d-msg'), `Save failed: ${(e as Error).message}`, 'err')
    }
  })

  /* ---------------- Preview ---------------- */

  if (!import.meta.env.DEV) $('advanced').classList.add('hidden')

  const preview = $('preview')

  renderPeople()
  fillDisplay()

  return {
    render(state: PhoneUiState) {
      const s = state.settings
      const p = s.profiles[s.active]
      const who = p ? `<div class="who">${esc(p.name)}</div>` : ''
      const cur = currentReading(state.points)
      if (cur) {
        const alert = classify(cur.mgdl, s.thresholds) !== 'inRange'
        const pred = predict(state.points, s.thresholds)
        const st = computeStats(state.points, s.thresholds)
        preview.innerHTML = `${who}
          <div class="big ${alert ? 'alert' : ''}">${formatGlucose(cur.mgdl, s.units)} <span class="arrow">${trendArrow(cur.trend)}</span></div>
          <div class="sub">Δ ${formatDelta(cur.deltaMgdl, s.units)} · ${formatAge(cur.at)}${st ? ` · ${st.hours}h in range ${st.tir}%` : ''}</div>
          ${pred ? `<div class="warn">${esc(formatPrediction(pred))}</div>` : ''}`
      } else if (state.error) {
        preview.innerHTML = `${who}<div class="sub err">${esc(state.error)}</div>`
      } else {
        preview.innerHTML = `${who}<div class="sub">${p ? 'No reading yet' : 'Add a person to get started'}</div>`
      }
    },
  }
}
