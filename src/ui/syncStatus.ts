import { useEffect, useState, useSyncExternalStore } from 'react'
import { localMode } from '../local'
import { parseServerTime } from '../saveQueue'
import { autosave, follow, type Attention, type Household, type RemoteVault, type UnlockedWith } from '../session'

export { parseServerTime }

/**
 * What the sync chip, the banner, the conflict sheet and the sidebar say
 * about a zero-knowledge session: whether the tab's work is in the vault, how
 * many edits aren't, when and by whom the vault was last written, whether the
 * other member saved something newer, and who shares it. Derived from
 * localMode, autosave and session's follow state, which announce every
 * change on window ('scarab-mode', 'scarab-write').
 */

export type SyncState =
  | 'off' // household mode: the server holds the data, nothing to sync
  | 'saved'
  | 'saving'
  | 'retrying' // offline or a server hiccup: autosave tries again on its own
  | 'unsaved'
  | 'novault' // a session with nowhere to save — even when nothing has been edited yet
  | 'newer' // the vault moved on and this tab hasn't loaded it (unsaved work here, or mid-edit): a call to action
  | 'conflict' // a save was refused because the vault moved on, or the stored vault changed under the tab
  | 'failed' // any other refusal (over the size cap, an error)

/**
 * The one state to show. Something the person must decide outranks
 * everything; then a failure; then the other member's newer version; then an
 * upload in flight. A session without a vault reads as such even when clean.
 */
export function syncStateOf(s: {
  active: boolean
  hasVault: boolean
  dirty: boolean
  autosave: string
  attention?: Attention['kind'] | null
}): SyncState {
  if (!s.active) return 'off'
  if (s.autosave === 'conflict' || s.attention === 'gone') return 'conflict'
  if (s.autosave === 'error' || s.autosave === 'toolarge') return 'failed'
  if (s.attention === 'newer' || s.attention === 'older') return 'newer'
  if (s.autosave === 'retrying') return 'retrying'
  if (s.autosave === 'saving') return 'saving'
  if (!s.hasVault) return 'novault'
  return s.dirty ? 'unsaved' : 'saved'
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'Sep 20' (local date). */
export function shortDate(t: number): string {
  const d = new Date(t)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/** 'just now', '2m ago', '3h ago', '5d ago', then a local date ('Sep 20', or 'Sep 20, 2025' in another year). */
export function relTime(then: number, now: number): string {
  const d = now - then
  if (d < 45_000) return 'just now' // includes a little clock skew into the future
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))}m ago`
  if (d < DAY) return `${Math.floor(d / HOUR)}h ago`
  if (d < 7 * DAY) return `${Math.floor(d / DAY)}d ago`
  const t = new Date(then)
  const md = shortDate(then)
  return t.getFullYear() === new Date(now).getFullYear() ? md : `${md}, ${t.getFullYear()}`
}

/** '3 unsaved changes' / '1 unsaved change' / 'Unsaved changes' (count unknown). */
export function unsavedText(pending: number | null): string {
  if (pending === null || pending <= 0) return 'Unsaved changes'
  return `${pending} unsaved change${pending === 1 ? '' : 's'}`
}

/** Who saved, as this tab's person reads it: 'you' for their own identity (another tab or device), the email otherwise. */
export function whoLabel(email: string | null, identity: string | null): string {
  if (!email) return 'someone'
  return identity && email.toLowerCase() === identity.toLowerCase() ? 'you' : email
}

/** '44 KB', '1.2 MB' — a stored vault's size. */
export function sizeText(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Avatar initials for a household, in order: the first letter of each
 * email's name part, or the first two where two people share a first letter
 * (Max and Mia → 'Ma', 'Mi'). Never from passkey labels, which are free text.
 */
export function initialsFor(emails: string[]): string[] {
  const names = emails.map((e) => (e.split('@')[0] ?? '').replace(/[^\p{L}\p{N}]/gu, '') || '?')
  return names.map((name, i) => {
    const one = name[0]!.toUpperCase()
    const clash = names.some((other, j) => j !== i && other[0]!.toUpperCase() === one)
    return clash && name.length > 1 ? one + name[1]!.toLowerCase() : one
  })
}

/** The toast when the tab loads another save: "Updated to v43 · saved by nicole@x.com" (amendment 2). */
export function updatedText(r: { version: number; by: string | null }, identity: string | null): string {
  return `Updated to v${r.version}${r.by ? ` · saved by ${whoLabel(r.by, identity)}` : ''}`
}

/** The sidebar's vault line: "Vault v43 · saved 2m ago", or what is holding it up. */
export function sidebarText(s: Pick<SyncStatus, 'state' | 'version' | 'savedAt' | 'attention'>, now: number): string {
  if (s.state === 'off') return 'Household · server data'
  if (s.version === null) return s.state === 'failed' ? 'Session · save failed' : 'Session · no vault yet'
  const v = `Vault v${s.version}`
  switch (s.state) {
    case 'saving':
      return `${v} · saving…`
    case 'retrying':
      return `${v} · offline — retrying`
    case 'unsaved':
      return `${v} · unsaved changes`
    case 'newer':
      return s.attention?.version != null ? `${v} · v${s.attention.version} available` : `${v} · newer version available`
    case 'conflict':
      return `${v} · conflict — review`
    case 'failed':
      return `${v} · save failed`
    default:
      return s.savedAt !== null ? `${v} · saved ${relTime(s.savedAt, now)}` : `${v} · saved`
  }
}

export type SyncStatus = {
  state: SyncState
  /** The vault version this tab last loaded or saved; null without a vault (or in household mode). */
  version: number | null
  /** When that version was stored (epoch ms), if known. */
  savedAt: number | null
  /** Who stored that version (identity); null when unknown. */
  savedBy: string | null
  dirty: boolean
  /** Edits since the tab was last clean; null when a save landed mid-edit and the count is no longer knowable. */
  pending: number | null
  error: string | null
  identity: string | null
  /** autosave's own status ('conflict' is a refused save; see SyncState for what is shown). */
  autosave: string
  /** Epoch ms of autosave's next try while retrying. */
  retryAt: number | null
  /** The stored vault as the server last described it (in a session). */
  remote: RemoteVault | null
  attention: Attention | null
  unlockedWith: UnlockedWith | null
  storedBytes: number | null
  household: Household | null
  /** Another tab of this browser had a session open first (also known at the front door). */
  otherTab: boolean
  /** The idle auto-lock came due but the save before it failed: why (the banner). */
  idleBlocked: string | null
}

/* ---------- the tracker ---------- */

let lastVersion: number | null = null
/** When this tab watched its version rise (a save of its own landing), for a version the server hasn't described. */
let watchedAt: number | null = null
let baseline: number | null = 0 // localMode.writes the last time the tab was clean
let wasActive = false
let snap: SyncStatus = {
  state: 'off',
  version: null,
  savedAt: null,
  savedBy: null,
  dirty: false,
  pending: null,
  error: null,
  identity: null,
  autosave: 'idle',
  retryAt: null,
  remote: null,
  attention: null,
  unlockedWith: null,
  storedBytes: null,
  household: null,
  otherTab: false,
  idleBlocked: null,
}
const listeners = new Set<() => void>()

function refresh() {
  const active = localMode.active
  const version = active ? (localMode.vault?.version ?? null) : null
  if (active && !wasActive) baseline = 0 // a session starts counting from its first write
  wasActive = active
  if (!active) {
    lastVersion = null
    watchedAt = null
  } else if (version !== lastVersion) {
    const rose = version !== null && lastVersion !== null && version > lastVersion
    watchedAt = rose ? Date.now() : null
    if (rose && localMode.dirty) baseline = null // writes that slipped in mid-upload: how many is unknowable here
    lastVersion = version
  }
  if (active && !localMode.dirty) baseline = localMode.writes
  const remote = active ? follow.remote : null
  const described = remote !== null && version !== null && remote.version === version
  const next: SyncStatus = {
    state: syncStateOf({
      active,
      hasVault: version !== null,
      dirty: localMode.dirty,
      autosave: autosave.status,
      attention: active ? (follow.attention?.kind ?? null) : null,
    }),
    version,
    savedAt: described ? (remote.at ?? watchedAt) : watchedAt,
    savedBy: described ? remote.by : null,
    dirty: active && localMode.dirty,
    pending: active && localMode.dirty && baseline !== null ? localMode.writes - baseline : null,
    error: active ? autosave.error : null,
    identity: localMode.identity,
    autosave: active ? autosave.status : 'idle',
    retryAt: active ? autosave.retryAt : null,
    remote,
    attention: active ? follow.attention : null,
    unlockedWith: active ? follow.unlockedWith : null,
    storedBytes: active && version !== null ? follow.storedBytes : null,
    household: active && version !== null ? follow.household : null,
    otherTab: follow.otherTab,
    idleBlocked: active ? follow.idleBlocked : null,
  }
  const same = (Object.keys(next) as (keyof SyncStatus)[]).every((k) => Object.is(next[k], snap[k]))
  if (same) return
  snap = next
  for (const l of listeners) l()
}

if (typeof window !== 'undefined') {
  // Listening from import time (App imports this at startup) so the first session's entry is seen.
  window.addEventListener('scarab-mode', refresh)
  window.addEventListener('scarab-write', refresh)
  window.addEventListener('scarab-data', refresh)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  refresh() // anything that happened before the first subscriber
  return () => {
    listeners.delete(l)
  }
}
const getSnapshot = () => snap

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Date.now(), re-read every `ms` and when the tab comes back into view — for "2m ago" labels. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const t = setInterval(tick, ms)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [ms])
  return now
}
