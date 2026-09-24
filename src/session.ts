import type { Dump } from '../engine/snapshot'
import {
  encodeRecoveryCode,
  isSeenRecord,
  isWrapIdentity,
  judgeServed,
  newVault,
  NewerVaultFormatError,
  openPayload,
  parseRecoveryCode,
  parseVaultBlob,
  RecoveryCodeError,
  sameKey,
  sealVault,
  sessionHeader,
  sha256Hex,
  unwrapWithPasskey,
  VaultAuthError,
  wrapForPasskey,
  type PasskeyWrap,
  type SeenRecord,
  type VaultBlob,
  type VaultBlobV3,
  type VaultHeader,
} from '../shared/vault'
import { todayLocal } from '../shared/dates'
import { enterLocalMode, exitLocalMode, loadLocalDump, localDump, localMode, type SnapshotLoad, type VaultSession } from './local'
import { assertPasskey, passkeysWorkHere, registerPasskey, rpId, wrongOriginMessage } from './passkey'
import {
  createAutosave,
  createIdleLock,
  createSaveQueue,
  createTabPresence,
  createWatcher,
  decideOnPoll,
  failureKind,
  IDLE_CHECK_MS,
  isIdleMinutes,
  NetError,
  parseServerTime,
  type HistoryPin,
  type IdleMinutes,
  type PresenceChannel,
  type SaveResult,
} from './saveQueue'

export type { SaveResult } from './saveQueue'

/**
 * The zero-knowledge session, end to end:
 *
 *   unlock  — fetch ciphertext → a passkey tap yields the PRF secret → unwrap
 *             the data key → decrypt in this tab → boot the in-tab engine.
 *             The server never receives plaintext; nothing reloads.
 *   save    — dump the in-tab database → reseal under the key kept from
 *             unlock → upload ciphertext. The only way local work persists.
 *             Saves queue one at a time and read the session when they run
 *             (src/saveQueue.ts), so a header change or a rotation can't be
 *             undone by a save that was requested before it.
 *   add     — a second device or a household member: one more passkey
 *             wrapping in the header, then a save. Nothing is re-encrypted.
 *             Each wrapping names the identity it belongs to (authenticated
 *             with the header), which is how the household panel ties
 *             passkeys to people.
 *   remove  — taking someone out of the household: the server stops serving
 *             them the ciphertext, then the vault is re-keyed without them
 *             (rotation) and the server drops every earlier version, which
 *             their key still opens. A new recovery code comes out of it.
 *
 * Every save writes vault format v3 (shared/vault.ts): the header — labels,
 * wrappings, RP ID and the sequence number — is authenticated with the
 * payload. This device remembers the last v3 state it opened or saved
 * (localStorage `scarab:seen:<vaultId>`), so an unlock that is served an
 * older copy than that stops and asks before opening it.
 *
 * A session follows the other member's saves: it asks the server for the
 * vault's version every 45s while the tab is visible (and on focus). A tab
 * with no unsaved work loads a newer version in place; one with unsaved work
 * is shown the choice (the conflict sheet) instead of a dead end.
 *
 * /api/vault is the one path that always goes to the network — the
 * encrypted-blob courier — so these work identically in both modes.
 */

export type VaultInfo = {
  version: number
  sha256: string
  size: number
  data: string
  updated_at: string
  /** Who stored this version (IAP identity); null for versions stored before the server kept it. */
  updated_by?: string | null
  /** The server keeps replaced versions (vault history). */
  keepsHistory?: boolean
}

/** fetch, or a NetError that says whether any response arrived (status null: offline, reset, blocked). */
async function send(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init })
  } catch (e) {
    throw new NetError(`couldn’t reach the server (${e instanceof Error ? e.message : String(e)})`, null)
  }
}

/** A JSON call to the network. Failures carry the HTTP status and body, which the save pipeline acts on. */
async function net<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await send(url, init)
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as Record<string, unknown> | null
    throw new NetError(typeof body?.error === 'string' ? body.error : `${r.status} ${r.statusText}`, r.status, body)
  }
  return r.json() as Promise<T>
}

/** The stored vault, or null when none exists yet. */
export async function fetchVaultInfo(): Promise<VaultInfo | null> {
  const r = await send('/api/vault')
  if (r.status === 404) return null
  if (!r.ok) throw new NetError(`vault: ${r.status} ${r.statusText}`, r.status)
  return r.json() as Promise<VaultInfo>
}

/** Every passkey registered on the stored vault — readable without unlocking (nothing in the header is secret). */
export async function fetchVaultKeys(): Promise<{ version: number; keys: PasskeyWrap[] } | null> {
  const info = await fetchVaultInfo()
  if (!info) return null
  return { version: info.version, keys: keysOfStored(info) }
}

/** The passkeys listed in a stored vault already fetched (no second download). Unauthenticated until it opens. */
export const keysOfStored = (info: VaultInfo): PasskeyWrap[] => parseVaultBlob(info.data).keys

/* ---------- what the server holds, who is here, and what needs the person ---------- */

/** The stored vault as the server last described it (a poll, an unlock, this tab's own save). */
export type RemoteVault = {
  version: number
  /** When it was stored (epoch ms): the server's clock for other saves, this tab's own for its saves. */
  at: number | null
  /** The identity that stored it; null for versions stored before the server kept it. */
  by: string | null
  /** The server keeps replaced versions (vault history), so keeping this tab's copy over another's loses nothing for good. */
  keepsHistory: boolean
}

/**
 * Something about the stored vault that needs the person — the banner and
 * the conflict sheet. (A version conflict on save is autosave's 'conflict'.)
 *   newer — a newer version, not loaded because this tab has unsaved work (or the person is mid-edit)
 *   older — a newer version that is an older copy than this device has seen (see Rollback)
 *   gone  — no vault stored any more, or one behind this tab (deleted, replaced, restored)
 */
export type Attention = { kind: 'newer' | 'older' | 'gone'; version: number | null }

/** How this session was opened: which passkey (its label as of now, and its credential id), or the recovery code. */
export type UnlockedWith = { kind: 'passkey'; label: string; credentialId: string } | { kind: 'recovery' }

/** Everyone who opens this vault — the identity that created it, and its members — and who is invited but hasn't answered. */
export type Household = { owner: string; members: string[]; invited: string[] }

export type Follow = {
  remote: RemoteVault | null
  attention: Attention | null
  unlockedWith: UnlockedWith | null
  /** The stored ciphertext's length, as last unlocked or saved. */
  storedBytes: number | null
  household: Household | null
  /** Another tab of this browser had a session open before this one (BroadcastChannel; nothing leaves the browser). */
  otherTab: boolean
  /**
   * The vault's key was set on this device (a rotation, a member removed,
   * or a create whose answer was lost) and nobody has confirmed storing its
   * recovery code yet — an older code doesn't open the vault. Remembered per
   * vault and key on this device (see oweRecoveryCode).
   */
  recoveryOwed: boolean
  /**
   * Someone was taken out of the household but the re-key that locks them out
   * of the key didn't happen (the passkey prompt was cancelled, a network
   * error): their email, until a re-key lands. Remembered per vault on this device.
   */
  rotationOwed: string | null
  /**
   * The idle auto-lock came due but didn't lock, because the save before it
   * failed: why, for the banner. Cleared by the next save that lands or a
   * fresh load.
   */
  idleBlocked: string | null
}

const followState: Follow = {
  remote: null,
  attention: null,
  unlockedWith: null,
  storedBytes: null,
  household: null,
  otherTab: false,
  recoveryOwed: false,
  rotationOwed: null,
  idleBlocked: null,
}

/** Read by the sync chip, the banner and the conflict sheet, which re-render on 'scarab-mode'. */
export const follow: Readonly<Follow> = followState

function setFollow(patch: Partial<Follow>): void {
  const changed = (Object.keys(patch) as (keyof Follow)[]).some((k) => !Object.is(followState[k], patch[k]))
  if (!changed) return
  Object.assign(followState, patch)
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('scarab-mode'))
}

/** What the server says about the stored vault (null: none stored). An own save's local timestamp survives a poll of the same version. */
function noteRemote(v: { version: number; updated_at: string; updated_by?: string | null; keepsHistory?: boolean } | null): void {
  const next: RemoteVault | null = v
    ? { version: v.version, at: parseServerTime(v.updated_at), by: v.updated_by ?? null, keepsHistory: v.keepsHistory === true }
    : null
  const cur = followState.remote
  if (cur && next && cur.version === next.version && cur.by === next.by && cur.keepsHistory === next.keepsHistory) return
  setFollow({ remote: next })
}

/** The household, for avatars. Cosmetic: a failure leaves the last answer. */
async function loadHousehold(): Promise<void> {
  try {
    const m = await fetchMembers()
    const next: Household = { owner: m.household, members: m.members.map((x) => x.email), invited: m.invites.map((x) => x.email) }
    const cur = followState.household
    if (cur && cur.owner === next.owner && cur.members.join('\n') === next.members.join('\n') && cur.invited.join('\n') === next.invited.join('\n')) return
    // Someone this tab saw invited is a member now: they accepted.
    const joined = cur && cur.owner === next.owner ? next.members.filter((e) => cur.invited.includes(e) && !cur.members.includes(e)) : []
    setFollow({ household: next })
    if (joined.length > 0) emitFollow({ kind: 'joined', emails: joined })
  } catch {
    /* offline, or a server without the route: no avatars */
  }
}

/** Something the tab did or noticed on its own that the person should hear about (the sync chip toasts it). */
export type FollowEvent =
  | { kind: 'updated'; version: number; by: string | null; notice: string | null }
  /** People the household had invited accepted: they are members now. */
  | { kind: 'joined'; emails: string[] }
const followListeners = new Set<(e: FollowEvent) => void>()
export function onFollow(fn: (e: FollowEvent) => void): () => void {
  followListeners.add(fn)
  return () => {
    followListeners.delete(fn)
  }
}
const emitFollow = (e: FollowEvent) => {
  for (const fn of followListeners) fn(e)
}

/* ---------- this device's memory of the vault (rollback detection) ---------- */

const SEEN_PREFIX = 'scarab:seen:'
/** Credential ids kept per record (every passkey the vault has listed while this device watched). */
const MAX_SEEN_CREDS = 64

/** What this device last saw of the v3 vault `vaultId`, or null (never opened here, storage blocked, or junk). */
function readSeen(vaultId: string): SeenRecord | null {
  try {
    const raw = localStorage.getItem(SEEN_PREFIX + vaultId)
    if (!raw) return null
    const rec = JSON.parse(raw) as unknown
    return isSeenRecord(rec) ? rec : null
  } catch {
    return null
  }
}

/** The record of a v3 vault that has listed any of these passkeys — how a v2 copy of a known vault is recognised. */
function seenListing(credentialIds: string[]): SeenRecord | null {
  if (credentialIds.length === 0) return null
  let best: SeenRecord | null = null
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k?.startsWith(SEEN_PREFIX)) continue
      const rec = readSeen(k.slice(SEEN_PREFIX.length))
      if (rec && rec.creds.some((c) => credentialIds.includes(c)) && (!best || rec.seq > best.seq)) best = rec
    }
  } catch {
    return best
  }
  return best
}

/** Remember that this device opened or saved `header`'s vault as `seq`, whose courier data hashes to `sha256`. Best effort. */
function writeSeen(header: VaultHeader, seq: number, sha256: string): void {
  const before = readSeen(header.vaultId)?.creds ?? []
  const creds = [...new Set([...header.keys.map((k) => k.credentialId), ...before])].slice(0, MAX_SEEN_CREDS)
  const rec: SeenRecord = { seq, sha256, at: new Date().toISOString(), creds, prfSalt: header.prfSalt }
  try {
    localStorage.setItem(SEEN_PREFIX + header.vaultId, JSON.stringify(rec))
  } catch {
    /* private window or blocked storage: no memory, so no rollback detection on this device */
  }
}

/* ---------- this device's passkeys, and what a re-key still owes (per vault, on this device) ---------- */

const DEVICE_CREDS_KEY = 'scarab:device-creds'
const MAX_DEVICE_CREDS = 32
/** Also kept in memory, for a browser whose storage is blocked. */
const deviceCredsHere = new Set<string>()

/** Credential ids of passkeys that live on this device: ones its own authenticator made or answered with. */
export function thisDevicePasskeys(): ReadonlySet<string> {
  const out = new Set(deviceCredsHere)
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_CREDS_KEY) ?? '[]') as unknown
    if (Array.isArray(raw)) for (const c of raw) if (typeof c === 'string') out.add(c)
  } catch {
    /* blocked or junk: memory only */
  }
  return out
}

/**
 * Remember a passkey as this device's — only when the browser says its own
 * (platform) authenticator answered. A phone over the QR prompt or a
 * security key is not "this device". Credential ids are public (every
 * vault header lists them); nothing secret is stored.
 */
function noteDevicePasskey(r: { credentialId: string; attachment?: 'platform' | 'cross-platform' | null }): void {
  if (r.attachment !== 'platform') return
  const known = thisDevicePasskeys()
  if (known.has(r.credentialId)) return
  deviceCredsHere.add(r.credentialId)
  try {
    localStorage.setItem(DEVICE_CREDS_KEY, JSON.stringify([r.credentialId, ...[...known].filter((c) => c !== r.credentialId)].slice(0, MAX_DEVICE_CREDS)))
  } catch {
    /* memory only */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('scarab-mode'))
}

const RECOVERY_OWED_PREFIX = 'scarab:recovery-owed:'
const ROTATION_OWED_PREFIX = 'scarab:rotation-owed:'

function readFlag(prefix: string, vaultId: string): string | null {
  try {
    return localStorage.getItem(prefix + vaultId)
  } catch {
    return null
  }
}
function writeFlag(prefix: string, vaultId: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(prefix + vaultId)
    else localStorage.setItem(prefix + vaultId, value)
  } catch {
    /* this tab's memory (follow) still has it */
  }
}

/*
 * A recovery code owed: `scarab:recovery-owed:<vaultId>` lists the keys whose
 * code nobody has confirmed storing yet, by PRF salt — minted with its key
 * (create, rotation) and public: every header shows it. An upload that sets
 * a new key writes its salt BEFORE it goes, so a response lost on the way,
 * a lock or a closed page while it uploads, still leaves the reminder; an
 * upload refused outright takes it back. When the vault opens, only the salt
 * of the key it is under counts. One naming another key is a re-key that
 * never landed, one superseded since — or one still uploading in another tab
 * of this browser — so it is left alone: it matters only if that key is the
 * vault's, and the list keeps just the newest few.
 */

/** How the flag read before it named its key (a timestamp): it counts for whatever key the vault is under. */
const OWED_STAMP = /^\d{4}-\d{2}-\d{2}T/
const MAX_OWED = 8

const owedSalts = (vaultId: string): string[] => (readFlag(RECOVERY_OWED_PREFIX, vaultId) ?? '').split(' ').filter(Boolean)
function setOwedSalts(vaultId: string, salts: string[]): void {
  const keep = [...new Set(salts)].slice(-MAX_OWED)
  writeFlag(RECOVERY_OWED_PREFIX, vaultId, keep.length > 0 ? keep.join(' ') : null)
}
/** The code of the key `prfSalt` names is owed (written before the upload that sets that key). */
const oweRecoveryCode = (vaultId: string, prfSalt: string) => setOwedSalts(vaultId, [...owedSalts(vaultId), prfSalt])
/** Not owed any more: the upload that would have set that key was refused, or its code was shown. */
const settleRecoveryCode = (vaultId: string, prfSalt: string) => setOwedSalts(vaultId, owedSalts(vaultId).filter((x) => x !== prfSalt))

/** What this device still owes the vault it just opened, as `header` says it is now (a recovery code not yet confirmed; an unfinished removal). */
function loadOwed(header: VaultHeader): void {
  const listed = owedSalts(header.vaultId)
  const stamped = listed.some((x) => OWED_STAMP.test(x))
  // A timestamp stands for the key the vault is under now: rewritten as that key's salt.
  if (stamped) setOwedSalts(header.vaultId, [...listed.filter((x) => !OWED_STAMP.test(x)), header.prfSalt])
  setFollow({ recoveryOwed: stamped || listed.includes(header.prfSalt), rotationOwed: readFlag(ROTATION_OWED_PREFIX, header.vaultId) })
}

/**
 * The person confirmed storing the current recovery code (the recovery-code
 * sheet's "I've stored it"). Clears the "the key changed" reminder — for the
 * key this tab holds; a re-key whose outcome is still unknown stays owed.
 */
export function acknowledgeRecoveryCode(): void {
  const s = localMode.vault
  if (s) setOwedSalts(s.header.vaultId, owedSalts(s.header.vaultId).filter((x) => x !== s.header.prfSalt && !OWED_STAMP.test(x)))
  setFollow({ recoveryOwed: false })
}

/** How the served vault compares with what this device last saw of it (the Vault screen's integrity line). */
export type SeenCheck = {
  format: 2 | 3
  /** The seq the served blob claims (v3; authenticated only once it opens). */
  servedSeq: number | null
  seen: SeenRecord | null
  /** unknown: this device never opened or saved it as v3 · same: byte-for-byte what it last saw · newer: saved since, elsewhere ·
   *  older / diverged / downgrade: not what it last saw (see judgeServed). */
  state: 'unknown' | 'same' | 'newer' | 'older' | 'diverged' | 'downgrade'
  sha256: string
}

/** Compare the served vault with this device's memory of it. Reads only the public header; no key needed. */
export async function checkSeen(info: VaultInfo): Promise<SeenCheck> {
  const blob = parseVaultBlob(info.data)
  const sha256 = await sha256Hex(new TextEncoder().encode(info.data))
  if (blob.v === 2) {
    const seen = seenListing(blob.keys.map((k) => k.credentialId))
    return { format: 2, servedSeq: null, seen, state: seen ? 'downgrade' : 'unknown', sha256 }
  }
  const seen = readSeen(blob.vaultId)
  const state = !seen
    ? 'unknown'
    : blob.seq < seen.seq
      ? 'older'
      : blob.seq > seen.seq
        ? 'newer'
        : sha256 === seen.sha256
          ? 'same'
          : 'diverged'
  return { format: 3, servedSeq: blob.seq, seen, state, sha256 }
}

/** The served copy is older than (or diverges from) what this device last saw of the vault. */
export type Rollback = {
  kind: 'rollback' | 'fork' | 'downgrade'
  seen: SeenRecord
  served: { version: number; seq: number | null; format: 2 | 3 }
}

export type UnlockOptions = {
  /**
   * Asked when the server serves an older copy than this device last saw
   * (see Rollback). Resolve true to open it anyway. Without it, unlocking
   * refuses such a copy.
   */
  confirmRollback?: (r: Rollback) => Promise<boolean>
}

/** The person chose not to open an older copy (or nobody could be asked). Nothing changed in the tab. */
export class RollbackRefused extends Error {
  constructor(readonly rollback: Rollback) {
    super(
      rollback.kind === 'downgrade'
        ? `Not opened: the server is serving an older-format copy of this vault, and this device has seen it at v${rollback.seen.seq}.`
        : rollback.kind === 'fork'
          ? `Not opened: the server’s v${rollback.served.seq} is not the v${rollback.seen.seq} this device saw.`
          : `Not opened: the server is serving v${rollback.served.seq} of this vault, older than the v${rollback.seen.seq} this device last saw.`,
    )
    this.name = 'RollbackRefused'
  }
}

/** What the vault holds, as unlocked: the ciphertext's SHA-256 (computed here) and the plaintext size. */
type Stored = { sha256: string; bytes: number }

/**
 * `baseline`: the tab will hold exactly what the vault stores, so a save
 * before any real edit has nothing to upload. False when the next save must
 * rewrite it anyway (a v2 vault, which saves as v3).
 */
async function boot(dump: Dump, session: VaultSession, stored: Stored, baseline: boolean): Promise<SnapshotLoad> {
  auto.reset() // a fresh unlock starts with no failure on the books
  setFollow({ attention: null, idleBlocked: null }) // …and with the tab in step with what it loaded
  pendingPin = null
  let loaded: SnapshotLoad
  if (localMode.active) {
    loaded = await loadLocalDump(dump)
    localMode.setVault(session)
    // An upgraded snapshot is NOT what the vault holds — leave the tab dirty so
    // the next save reseals it at the current version.
    if (loaded.upgraded.length === 0) localMode.markSaved(session.version)
  } else {
    // A non-null dump always yields a load; the null is for an empty start.
    loaded = (await enterLocalMode(dump, session)) ?? { from: dump.schemaVersion, upgraded: [] }
  }
  // What the courier holds at this version, so the next upload says which blob it replaces.
  if (baseline && loaded.upgraded.length === 0) void queue.loaded(session, dump, stored)
  else void queue.known(session.version, stored.sha256)
  // A snapshot this engine had to upgrade (tier C) is rewritten by the next save: the server's history keeps the copy
  // the older engine wrote — pinned, past the ordinary retention — in case the upgrade got something wrong.
  if (loaded.upgraded.length > 0) pendingPin = { vaultId: session.header.vaultId, version: session.version, pin: 'pre-upgrade' }
  return loaded
}

/* ---------- a vault saved by a newer Scarab than this page ---------- */

const NEWER_RELOAD_KEY = 'scarab:reloaded-for-newer-vault'
/** How long a reload for a newer vault counts as already tried (a deploy still rolling out gets another go later). */
const NEWER_RELOAD_WINDOW_MS = 5 * 60_000

/** loadDump's refusal of a snapshot written at a schema this engine doesn't know yet (engine/upgrades.ts). */
const isNewerSnapshot = (e: unknown) => e instanceof Error && /newer than this engine/.test(e.message)

/** Reload once to pick up the newer bundle. False when that was just tried (or can't be guarded against looping). */
function reloadOnceForNewerVault(): boolean {
  try {
    const at = Number(sessionStorage.getItem(NEWER_RELOAD_KEY) ?? 0)
    if (Date.now() - at < NEWER_RELOAD_WINDOW_MS) return false
    sessionStorage.setItem(NEWER_RELOAD_KEY, String(Date.now()))
  } catch {
    return false // no sessionStorage: a reload could loop forever
  }
  window.location.reload()
  return true
}

/**
 * This page is older than what wrote the vault (a newer snapshot schema or
 * vault format): reload once to fetch the current bundle (the HTML is never
 * cached), unless that would throw away unsaved work in this tab.
 */
function newerThanThisPage(): Promise<never> {
  // Work a reload would lose: writes this tab made that no save carried (an
  // empty start that was never written to has nothing to lose).
  const unsaved = localMode.active && localMode.dirty && localMode.writes > 0
  if (!unsaved && reloadOnceForNewerVault()) return new Promise<never>(() => {}) // the page is going away
  throw new Error(
    unsaved
      ? 'This vault was saved by a newer version of Scarab than this page. Export this tab’s data, then reload the page to update.'
      : 'This vault was saved by a newer version of Scarab than this page, and reloading didn’t bring one. A deploy may still be rolling out — try again in a few minutes.',
  )
}

/** The served blob, parsed; a vault format newer than this page reloads it (once). */
function parseServed(info: VaultInfo): VaultBlob | Promise<never> {
  try {
    return parseVaultBlob(info.data)
  } catch (e) {
    if (e instanceof NewerVaultFormatError) return newerThanThisPage()
    throw e
  }
}

/** Boot the unlocked dump; a snapshot from a newer schema than this engine reloads the page (once). */
async function bootUnlocked(dump: Dump, session: VaultSession, stored: Stored, baseline: boolean): Promise<SnapshotLoad> {
  try {
    const loaded = await boot(dump, session, stored, baseline)
    try {
      sessionStorage.removeItem(NEWER_RELOAD_KEY)
    } catch {
      /* nothing to clear */
    }
    return loaded
  } catch (e) {
    if (!isNewerSnapshot(e)) throw e
    return newerThanThisPage()
  }
}

const decodeDump = (plaintext: Uint8Array) => JSON.parse(new TextDecoder().decode(plaintext)) as Dump

/**
 * What an unlock reports: the vault's courier version, what the loader had to
 * do to the snapshot inside it, and anything worth telling the person about
 * the copy that was served (a restored copy; an old format).
 */
export type Unlocked = { version: number; label: string; loaded: SnapshotLoad; notice: string | null }

/**
 * Decrypt `blob` (which authenticates a v3 header, seq included), judge it
 * against this device's memory of the vault, and boot it. An older copy than
 * this device saw opens only if the person says so. `beforeBoot` runs last,
 * just before the tab's data is replaced, and may throw to stop it.
 */
/**
 * The served blob (`sha256`: of its courier data) against this device's
 * memory of the vault: the Rollback to ask about when it is an older copy
 * than this device saw, else null (`restored`: sealed for another version
 * than it is served as). Only for a blob that opened: its header is judged.
 */
function judgeAgainstSeen(info: VaultInfo, blob: VaultBlob, sha256: string): { rollback: Rollback | null; restored: boolean } {
  const seen = blob.v === 3 ? readSeen(blob.vaultId) : seenListing(blob.keys.map((k) => k.credentialId))
  const verdict = judgeServed({ header: blob, version: info.version, sha256 }, seen)
  if (verdict.kind === 'ok') return { rollback: null, restored: verdict.restored }
  const served = { version: info.version, seq: blob.v === 3 ? blob.seq : null, format: blob.v }
  return { rollback: { kind: verdict.kind, seen: verdict.seen, served }, restored: false }
}

async function openAndBoot(
  info: VaultInfo,
  blob: VaultBlob,
  rawDataKey: Uint8Array,
  o: UnlockOptions,
  beforeBoot?: () => void,
): Promise<{ loaded: SnapshotLoad; notice: string | null }> {
  const plaintext = await openPayload(blob, rawDataKey)
  const sha256 = await sha256Hex(new TextEncoder().encode(info.data))
  const { rollback, restored } = judgeAgainstSeen(info, blob, sha256)
  if (rollback && !(o.confirmRollback && (await o.confirmRollback(rollback)))) throw new RollbackRefused(rollback)
  const header = sessionHeader(blob, rpId())
  const dump = decodeDump(plaintext)
  beforeBoot?.()
  const loaded = await bootUnlocked(dump, { rawDataKey, header, version: info.version }, { sha256, bytes: plaintext.length }, blob.v === 3)
  loadOwed(header)
  // What this device now knows — an older copy it chose to open included, so its own next save doesn't read as a fork.
  if (blob.v === 3) writeSeen(header, blob.seq, sha256)
  noteRemote(info)
  setFollow({ storedBytes: info.size })
  const notice =
    blob.v === 2
      ? `Vault v${info.version} is in the older v2 format. Your next save rewrites it as v3, which authenticates its header and compresses it.`
      : restored
        ? `Vault v${info.version} holds a copy sealed as v${blob.seq}: an earlier version was put back on the server.`
        : null
  return { loaded, notice }
}

/** One passkey tap: decrypt the stored vault in this tab and run on it. Replaces the tab's data if a session is already on. */
export async function unlockVault(o: UnlockOptions = {}): Promise<Unlocked> {
  const info = await fetchVaultInfo()
  if (!info) throw new Error('no vault stored yet')
  const blob = await parseServed(info)
  // Passkeys are bound to the domain they were made on: say where, rather than show an empty browser prompt.
  if (blob.v === 3 && !passkeysWorkHere(blob.rpId)) throw new Error(wrongOriginMessage(blob.rpId))
  if (blob.keys.length === 0) throw new Error('this vault has no passkeys — only its recovery code can open it')
  const pk = await assertPasskey({ prfSaltB64: blob.prfSalt, credentialIds: blob.keys.map((k) => k.credentialId) })
  const { credentialId } = pk
  const rawDataKey = await unwrapWithPasskey(blob, credentialId, pk.prfOutput)
  const { loaded, notice } = await openAndBoot(info, blob, rawDataKey, o)
  noteDevicePasskey(pk)
  const label = blob.keys.find((k) => k.credentialId === credentialId)?.label ?? ''
  setFollow({ unlockedWith: { kind: 'passkey', label, credentialId } })
  void loadHousehold()
  idleLock.reset()
  return { version: info.version, label, loaded, notice }
}

/**
 * Break-glass: the typed recovery code is the raw data key. Works on any
 * domain. A typo is caught by the code's check group before anything is
 * fetched, and reported as a typo; a correctly typed code that doesn't open
 * this vault is reported as that.
 */
export async function unlockWithRecoveryCode(code: string, o: UnlockOptions = {}): Promise<Unlocked> {
  const { key: rawDataKey, checked } = await parseRecoveryCode(code)
  const info = await fetchVaultInfo()
  if (!info) throw new Error('no vault stored yet')
  const blob = await parseServed(info)
  try {
    const { loaded, notice } = await openAndBoot(info, blob, rawDataKey, o)
    setFollow({ unlockedWith: { kind: 'recovery' } })
    void loadHousehold()
    idleLock.reset()
    return { version: info.version, label: '', loaded, notice }
  } catch (e) {
    if (!(e instanceof VaultAuthError)) throw e
    throw new Error(
      checked
        ? 'That recovery code is typed correctly but doesn’t open this vault — it may be from before the key was rotated, or for another vault.'
        : 'That code doesn’t open this vault. Check it for a typo (a 52-character code predates the check group, so a typo can’t be told apart), or it may be from before the key was rotated.',
    )
  }
}

/** Boot an empty in-tab database: a session that starts with no plaintext anywhere. */
export async function startEmpty(): Promise<void> {
  await enterLocalMode(null, null)
}

/* ---------- saving ---------- */

/**
 * The one save pipeline (src/saveQueue.ts): every save — autosave, Save now,
 * a passkey added or removed, a rotation, a new vault — runs through it, one
 * at a time, each reading the session when it runs.
 */
/**
 * A pin for the stored version the next upload replaces ('pre-upgrade' after
 * an unlock that upgraded the snapshot, 'pre-restore' before a restore). Tied
 * to that vault and version: any save based on it carries the pin — an
 * autosave after a retry included — and none based on anything else does.
 */
let pendingPin: { vaultId: string; version: number; pin: HistoryPin } | null = null

const queue = createSaveQueue(
  {
    session: () => localMode.vault,
    pin: (base) => (pendingPin && pendingPin.vaultId === base.header.vaultId && pendingPin.version === base.version ? pendingPin.pin : undefined),
    writes: () => localMode.writes,
    dump: localDump,
    seal: (s, plaintext, seq) => sealVault(s.header, s.rawDataKey, plaintext, seq),
    // The server refuses a stale version (409), so a second device can't silently clobber this one.
    put: (body) => net<{ ok: true; version: number; sha256: string }>('/api/vault', { method: 'PUT', body: JSON.stringify(body) }),
    sha256: (data) => sha256Hex(typeof data === 'string' ? new TextEncoder().encode(data) : data),
    commit(s, writesAtDump, stored) {
      const before = localMode.vault
      // A re-key landed (possibly one whose response was lost, adopted later): the old recovery code no longer
      // opens anything new, and the new one must reach the person — remembered until they confirm storing it.
      // Any other key still listed as owed never became the vault's, or is retired now.
      if (before && before.rawDataKey !== s.rawDataKey) {
        setOwedSalts(s.header.vaultId, [s.header.prfSalt])
        setFollow({ recoveryOwed: true })
      }
      localMode.setVault(s)
      localMode.markSaved(s.version, writesAtDump)
      writeSeen(s.header, stored.seq, stored.sha256)
      if (pendingPin && s.version > pendingPin.version) pendingPin = null // the pinned version is history now
      // The server now holds this tab's copy: in step, saved by whoever is signed in here, just now (this tab's clock).
      setFollow({
        remote: { version: s.version, at: Date.now(), by: localMode.identity, keepsHistory: followState.remote?.keepsHistory ?? false },
        storedBytes: stored.size,
        attention: null,
        idleBlocked: null,
      })
    },
    markSaved: (version, writesAtDump) => localMode.markSaved(version, writesAtDump),
  },
  {
    start: (job) => auto.started(job),
    success: (r, job) => auto.succeeded(r, job),
    failure: (e, job) => {
      auto.failed(e, job)
      // Refused because the vault moved on: ask the server who saved what, for the banner and the conflict sheet.
      if (failureKind(e) === 'conflict' && !job.seed) watcher.kick()
    },
  },
)

/* ---------- autosave ---------- */

/**
 * Once a session holds a key, every write is uploaded on its own: 1.5s after
 * the last write, or at once when the tab goes into the background. Offline
 * or a server hiccup retries by itself (2s → 5s → 15s → 60s, and at once when
 * the browser is back online or the tab regains focus). A version conflict
 * (another device saved first) or an oversized vault is shown, not retried;
 * a manual save or a fresh unlock clears it.
 */
const auto = createAutosave({
  pending: () => localMode.active && localMode.vault !== null && localMode.dirty,
  save: () => queue.save(undefined, { auto: true }),
  inFlight: () => queue.inFlight(),
  announce: () => window.dispatchEvent(new Event('scarab-mode')),
})

/** What autosave is doing; read by the sync chip and the Vault screen, which re-render on 'scarab-mode'. */
export const autosave = auto.state

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('scarab-write', () => auto.onWrite()) // debounce restarts on every applied write
  window.addEventListener('scarab-mode', () => auto.onMode()) // e.g. an unlock that left an upgraded snapshot dirty
  window.addEventListener('online', () => auto.wake())
  window.addEventListener('focus', () => auto.wake())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') auto.flush()
    else auto.wake()
  })
}

function requireSession(): VaultSession {
  if (!localMode.active) throw new Error('not in a zero-knowledge session')
  const s = localMode.vault
  if (!s) throw new Error('no vault yet — create one first')
  return s
}

/** The key the tab holds now (read afresh: a save may have committed another since the caller last looked). */
const tabKey = (): Uint8Array | undefined => localMode.vault?.rawDataKey

/**
 * After a save whose answer never came (offline, a reset, a 5xx): ask the
 * server what it holds, and adopt the upload if it landed — so a create or a
 * re-key whose response was lost still ends with its recovery code on screen.
 * Null when it didn't land, or the server still can't be reached (whatever
 * the upload owes stays remembered; see oweRecoveryCode).
 */
async function settleLost(): Promise<SaveResult | null> {
  try {
    const r = await queue.settle(async () => {
      const info = await fetchVaultInfo()
      return info && { version: info.version, sha256: await sha256Hex(new TextEncoder().encode(info.data)) }
    })
    if (r) auto.wake() // a retry armed by the failure has nothing left to do
    return r
  } catch {
    return null
  }
}

/** What a failed create or re-key tells the person when the server may have stored it anyway. */
function mayHaveLanded(e: NetError, what: string): NetError {
  return new NetError(`${e.message}. ${what}`, e.status, e.body)
}

/**
 * Persist the in-tab database. Reseals under the session key; every passkey
 * and the recovery code keep working. Uploads nothing (and returns
 * `skipped`) when the data is exactly what was last sealed.
 */
export async function saveVault(): Promise<SaveResult> {
  requireSession()
  return queue.save()
}

/** Delete the stored vault — blob, history, members, invites — as the household's owner. `version` is what the person confirmed. */
const deleteVault = (version: number) =>
  net<{ ok: true }>('/api/vault', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE', version }) })

/**
 * First save of a session that has no vault: mint a data key, register this
 * device's passkey as its first wrapping, seal, upload as version 0 — which
 * the server refuses if any vault exists, so creating never overwrites one.
 * Returns the recovery code — the one time it is offered unprompted.
 *
 * `replace` is the version of the stored vault the person confirmed deleting
 * (the owner's typed REPLACE). It is deleted only after the new passkey
 * exists, and only if it is still that version.
 *
 * `empty` (the front door): the vault starts from an empty in-tab database,
 * booted here once the create can go ahead — after the checks and the
 * passkey. A create refused by the checks or a cancelled prompt leaves no
 * session behind; one that fails after the engine is up leaves it with
 * nothing unsaved (nothing was entered), so a reload doesn't ask to leave.
 */
export async function createVault(label: string, o: { replace?: number; empty?: boolean } = {}): Promise<SaveResult & { recoveryCode: string }> {
  if (!o.empty && !localMode.active) throw new Error('not in a zero-knowledge session')
  if (localMode.vault) throw new Error('this session already has a vault')
  // Check before the passkey prompt: a passkey minted for a vault that can't be
  // stored would be litter in the person's password manager.
  const existing = await fetchVaultInfo()
  if (existing && o.replace === undefined)
    throw new Error(`A vault is already stored here (v${existing.version}). Unlock it instead — creating a vault never overwrites one.`)
  if (existing && existing.version !== o.replace)
    throw new Error(`The stored vault changed since you confirmed (it is now v${existing.version}). Nothing was deleted — review it and confirm again.`)
  const { rawDataKey, header } = newVault(rpId())
  const pk = await registerPasskey({ prfSaltB64: header.prfSalt, label, excludeCredentialIds: [] })
  header.keys.push(await wrapForPasskey(rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label, identity: ownIdentity() }))
  if (o.empty) await startEmpty()
  try {
    return await finishCreate(label, rawDataKey, header, pk, existing)
  } catch (e) {
    // Nothing was entered into the empty start (the front door has no screens), so nothing in it is unsaved.
    if (o.empty && localMode.active && !localMode.vault && localMode.writes === 0) localMode.markSaved(0, 0)
    throw e
  }
}

/** createVault, from the moment its passkey exists and its engine is up: delete what it replaces, then the first upload. */
async function finishCreate(
  label: string,
  rawDataKey: Uint8Array,
  header: VaultHeader,
  pk: Awaited<ReturnType<typeof registerPasskey>>,
  existing: VaultInfo | null,
): Promise<SaveResult & { recoveryCode: string }> {
  if (existing) await deleteVault(existing.version)
  // Owed from before the upload: a create whose answer is lost has still stored a vault nobody has the code of.
  // Unlocking it later (loadOwed) then asks for the code to be shown and stored.
  oweRecoveryCode(header.vaultId, header.prfSalt)
  let r: SaveResult
  try {
    try {
      r = await queue.save(undefined, { seed: { rawDataKey, header, version: 0 } })
    } catch (e) {
      const adopted = failureKind(e) === 'transient' ? await settleLost() : null
      if (!adopted || tabKey() !== rawDataKey) throw e
      r = adopted // it landed; only the answer was lost
    }
  } catch (e) {
    if (failureKind(e) !== 'transient') settleRecoveryCode(header.vaultId, header.prfSalt) // refused outright: no vault was stored
    if (e instanceof NetError && e.status === 409)
      throw new Error('A vault was stored here in the meantime — nothing was overwritten. Unlock it instead.')
    if (e instanceof NetError && failureKind(e) === 'transient')
      throw mayHaveLanded(e, 'The vault may have been stored anyway: if Scarab later says a vault is stored here, unlock it, and the Recovery card asks you to store its code.')
    throw e
  }
  settleRecoveryCode(header.vaultId, header.prfSalt) // shown now: the caller's code step is the one time it is offered unprompted
  noteDevicePasskey(pk)
  setFollow({ unlockedWith: { kind: 'passkey', label, credentialId: pk.credentialId }, recoveryOwed: false, rotationOwed: null })
  void loadHousehold()
  idleLock.reset()
  return { ...r, recoveryCode: await encodeRecoveryCode(rawDataKey) }
}

/** The signed-in identity, as a wrapping may name it (null when unknown or not email-shaped). */
function ownIdentity(): string | null {
  const me = localMode.identity?.trim().toLowerCase() ?? ''
  return isWrapIdentity(me) ? me : null
}

/**
 * Register one more passkey on the vault — this device's, or a household
 * member's phone via the browser's QR hybrid prompt — and save. Same
 * mechanism either way. `identity` is whose passkey it is (default: whoever
 * is signed in here); the label is free text for the household panel.
 */
export async function addPasskey(label: string, o: { identity?: string } = {}): Promise<PasskeyWrap> {
  const s = requireSession()
  requirePasskeysHere(s)
  const identity = o.identity === undefined ? ownIdentity() : o.identity.trim().toLowerCase()
  if (identity !== null && !isWrapIdentity(identity)) throw new Error(`${o.identity} isn’t a sign-in email`)
  const pk = await registerPasskey({
    prfSaltB64: s.header.prfSalt,
    label,
    excludeCredentialIds: s.header.keys.map((k) => k.credentialId),
  })
  const wrap = await wrapForPasskey(s.rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label, identity })
  await queue.save((cur) => {
    // The wrapping is of the key and salt the prompt started with.
    if (cur.rawDataKey !== s.rawDataKey || cur.header.prfSalt !== s.header.prfSalt)
      throw new Error('the vault was re-keyed while the passkey was being added — add it again')
    return { ...cur, header: { ...cur.header, keys: [...cur.header.keys.filter((k) => k.credentialId !== wrap.credentialId), wrap] } }
  })
  // Made by this device's own authenticator — and for the person signed in here, not someone handed the prompt.
  if (identity === ownIdentity()) noteDevicePasskey(pk)
  return wrap
}

/**
 * Rename a passkey: edit its label in the header and reseal (the label is
 * authenticated, so this is a save). `bind` names whose passkey it is when
 * the wrapping predates identities, so a rename never loses who it belongs
 * to; an identity already on the wrapping is never changed.
 */
export async function renamePasskey(credentialId: string, label: string, bind?: string | null): Promise<void> {
  requireSession()
  const name = label.trim()
  if (!name) throw new Error('A passkey needs a name.')
  if (name.length > 64) throw new Error('Keep the name to 64 characters or fewer.')
  const who = bind?.trim().toLowerCase()
  await queue.save((cur) => {
    const w = cur.header.keys.find((k) => k.credentialId === credentialId)
    if (!w) throw new Error('that passkey is no longer on the vault — nothing was renamed')
    const identity = w.identity ?? (who && isWrapIdentity(who) ? who : undefined)
    const next: PasskeyWrap = { ...w, label: name, ...(identity !== undefined ? { identity } : {}) }
    return { ...cur, header: { ...cur.header, keys: cur.header.keys.map((k) => (k.credentialId === credentialId ? next : k)) } }
  })
  const u = followState.unlockedWith
  if (u?.kind === 'passkey' && u.credentialId === credentialId) setFollow({ unlockedWith: { ...u, label: name } })
}

/** Drop a passkey's wrapping and save. The last one stays: without it only the recovery code could open the vault. */
export async function removePasskey(credentialId: string): Promise<void> {
  requireSession()
  await queue.save((cur) => {
    if (!cur.header.keys.some((k) => k.credentialId === credentialId)) throw new Error('that passkey is not on the vault')
    if (cur.header.keys.length === 1) throw new Error('cannot remove the only passkey on the vault')
    return { ...cur, header: { ...cur.header, keys: cur.header.keys.filter((k) => k.credentialId !== credentialId) } }
  })
}

/** Passkeys can be made or asked for only on the domain the vault's passkeys belong to. */
function requirePasskeysHere(s: VaultSession): void {
  if (!passkeysWorkHere(s.header.rpId))
    throw new Error(`This vault’s passkeys belong to ${s.header.rpId} — manage them there. The recovery code works anywhere.`)
}

export type Rotated = { version: number; recoveryCode: string; kept: string }

/**
 * Rotate: a new data key, new PRF salt, new recovery code. The passkey that
 * answers the prompt is re-wrapped; every other passkey drops off and must
 * be added again. For when a recovery code may have leaked, and the second
 * half of removing someone. The upload asks the server to drop every
 * earlier version it keeps (they are sealed under the old key). The vault id
 * and RP ID stay: it is the same vault, so this device's rollback memory of
 * it carries on.
 *
 * `exclude`: passkeys that may not be the one that answers (the person being
 * removed — keeping their wrapping would keep them in).
 */
export async function rotateVault(o: { exclude?: readonly string[] } = {}): Promise<Rotated> {
  const s = requireSession()
  requirePasskeysHere(s)
  const excluded = new Set(o.exclude ?? [])
  const allowed = s.header.keys.filter((k) => !excluded.has(k.credentialId))
  if (allowed.length === 0) throw new Error('No passkey is left that may re-key the vault — add one of yours first. Nothing changed.')
  const fresh = newVault(s.header.rpId)
  const pk = await assertPasskey({ prfSaltB64: fresh.header.prfSalt, credentialIds: allowed.map((k) => k.credentialId) })
  const old = allowed.find((k) => k.credentialId === pk.credentialId)
  if (!old) throw new Error('that passkey can’t re-key this vault — nothing changed')
  noteDevicePasskey(pk)
  const keys = [await wrapForPasskey(fresh.rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label: old.label, identity: old.identity })]
  // Owed from before the upload: if its answer is lost, or the tab locks or closes before it arrives, the old code
  // may already have stopped working — the next unlock under the new key still asks for the new one (loadOwed).
  const { vaultId } = s.header
  oweRecoveryCode(vaultId, fresh.header.prfSalt)
  let r: SaveResult
  try {
    r = await queue.save(
      (cur) => {
        if (cur.rawDataKey !== s.rawDataKey) throw new Error('the vault was re-keyed meanwhile — nothing changed')
        const header: VaultHeader = { ...fresh.header, vaultId: cur.header.vaultId, rpId: cur.header.rpId, keys }
        return { ...cur, rawDataKey: fresh.rawDataKey, header }
      },
      { purgeHistory: true },
    )
  } catch (e) {
    const transient = failureKind(e) === 'transient'
    const adopted = transient ? await settleLost() : null
    if (!adopted || tabKey() !== fresh.rawDataKey) {
      if (!transient) settleRecoveryCode(vaultId, fresh.header.prfSalt) // refused outright: this key never became the vault's
      if (transient && e instanceof NetError)
        throw mayHaveLanded(
          e,
          'The new key may have reached the server anyway: if it did, this tab locks at its next check, and once you unlock again the Recovery card asks you to store the new code.',
        )
      throw e
    }
    r = adopted // it landed; only the answer was lost
  }
  return { version: r.version, recoveryCode: await encodeRecoveryCode(fresh.rawDataKey), kept: old.label }
}

/**
 * Take someone out of the household, for real:
 *   1. the server stops serving them the ciphertext (their membership row goes);
 *   2. they still know the key, so the vault is re-keyed without them — their
 *      passkeys may not answer — and the server drops every earlier version;
 *   3. the new recovery code comes back, for the person to store.
 * If step 2 doesn't happen (the prompt was cancelled), this device remembers
 * that a re-key is owed (follow.rotationOwed) and calling this again finishes
 * it. `exclude`: their passkeys the household panel matched by other means
 * than an identity on the wrapping (ones added before identities existed).
 */
export async function removeFromHousehold(email: string, exclude: readonly string[] = []): Promise<Rotated> {
  const s = requireSession()
  requirePasskeysHere(s)
  const who = email.trim().toLowerCase()
  if (!isWrapIdentity(who)) throw new Error(`${email} isn’t a sign-in email`)
  if (who === ownIdentity()) throw new Error('You can’t remove yourself from here.')
  // Theirs: wrappings naming them, and ones from before identities labelled with their email (how members' used to be).
  const named = s.header.keys.filter((k) => k.identity === who || (k.identity === undefined && k.label.trim().toLowerCase() === who))
  const theirs = [...new Set([...exclude, ...named.map((k) => k.credentialId)])]
  if (!s.header.keys.some((k) => !theirs.includes(k.credentialId)))
    throw new Error(`Every passkey on the vault is ${who}’s, so none is left to re-key it with. Add one of yours first — nothing changed.`)
  try {
    await removeMember(who)
  } catch (e) {
    if (!(e instanceof NetError && e.status === 404)) throw e // already out: go on to the re-key
  }
  writeFlag(ROTATION_OWED_PREFIX, s.header.vaultId, who)
  setFollow({ rotationOwed: who })
  const r = await rotateVault({ exclude: theirs })
  writeFlag(ROTATION_OWED_PREFIX, s.header.vaultId, null)
  setFollow({ rotationOwed: null })
  return r
}

/** The recovery code of the unlocked vault, with no further check — tests and internals; the screen uses revealRecoveryCode. */
export function recoveryCodeOfSession(): Promise<string> {
  return encodeRecoveryCode(requireSession().rawDataKey)
}

/**
 * Show the recovery code: only after a fresh passkey check — someone at an
 * unlocked tab they didn't open can't read it off the screen. The answering
 * passkey must unwrap this session's key.
 */
export async function revealRecoveryCode(): Promise<string> {
  const s = requireSession()
  if (!passkeysWorkHere(s.header.rpId))
    throw new Error(`Showing the recovery code takes one of the vault’s passkeys, and they belong to ${s.header.rpId} — open it there.`)
  if (s.header.keys.length === 0) throw new Error('This vault has no passkeys to confirm it’s you.')
  const pk = await assertPasskey({ prfSaltB64: s.header.prfSalt, credentialIds: s.header.keys.map((k) => k.credentialId) })
  const now = requireSession()
  if (now.rawDataKey !== s.rawDataKey) throw new Error('The vault was re-keyed meanwhile — ask again for the current code.')
  const key = await unwrapWithPasskey(now.header, pk.credentialId, pk.prfOutput)
  if (!sameKey(key, now.rawDataKey)) throw new Error('That passkey doesn’t open this session’s key — nothing is shown.')
  noteDevicePasskey(pk)
  return encodeRecoveryCode(now.rawDataKey)
}

/** A recovery-code drill's verdict. `problem` says why it failed: a typing problem, or a code for another key. */
export type Drill = { ok: true; message: string } | { ok: false; problem: 'length' | 'character' | 'typo' | 'mismatch'; message: string }

/**
 * Check a written-down recovery code against the unlocked vault's key,
 * entirely in this tab: nothing is fetched or sent, and the code is not kept.
 */
export async function drillRecoveryCode(code: string): Promise<Drill> {
  const s = requireSession()
  let parsed: { key: Uint8Array; checked: boolean }
  try {
    parsed = await parseRecoveryCode(code)
  } catch (e) {
    if (e instanceof RecoveryCodeError) return { ok: false, problem: e.problem, message: e.message }
    throw e
  }
  if (sameKey(parsed.key, s.rawDataKey))
    return {
      ok: true,
      message: parsed.checked
        ? 'This code opens this vault.'
        : 'This code opens this vault. It is an older 52-character code without a check group — Show recovery code gives the current form, which catches typos.',
    }
  return {
    ok: false,
    problem: 'mismatch',
    message: parsed.checked
      ? 'Typed correctly, but it doesn’t open this vault — it is for another key (from before a rotation?). Show recovery code gives the current one.'
      : 'It doesn’t open this vault: a typo, or a code for another key. Show recovery code gives the current one.',
  }
}

/* ---------- household members, by invitation (server-side routing, no secrets) ---------- */

export type Member = { email: string; added_by: string; added_at: string }
/** An invitation the household sent that the invitee hasn't answered yet. */
export type PendingInvite = { email: string; invited_by: string; invited_at: string }
export type Members = { household: string; members: Member[]; invites: PendingInvite[] }
export const fetchMembers = async (): Promise<Members> => {
  const r = await net<{ household: string; members: Member[]; invites?: PendingInvite[] }>('/api/vault/members')
  return { ...r, invites: r.invites ?? [] }
}

/**
 * Invite someone into the household. Nobody is added by this: the server
 * records an invitation, which they accept on their own device (the front
 * door offers it). The server answers the same whoever the email belongs to,
 * so the result says nothing about them.
 */
export async function addMember(email: string): Promise<{ ok: true }> {
  await net<{ ok: true }>('/api/vault/members', { method: 'POST', body: JSON.stringify({ email }) })
  void loadHousehold()
  return { ok: true }
}

/** Withdraw an invitation the household sent (never a membership — someone who accepted stays in). */
export async function withdrawInvite(email: string): Promise<void> {
  await net<{ ok: true }>(`/api/vault/members/${encodeURIComponent(email.trim().toLowerCase())}?pending=1`, { method: 'DELETE' })
  void loadHousehold()
}

/**
 * Invite someone and add their passkey in one go: the invitation first — so
 * nobody's passkey lands in the header for someone the household didn't ask
 * in — then their passkey ceremony (they answer the QR prompt with their
 * phone), bound to their identity. If the ceremony or its save fails, an
 * invitation this call made is withdrawn. Someone already in the household,
 * or already invited, just gets the passkey (after a re-key dropped theirs,
 * say). `pending`: they haven't accepted yet — the passkey opens the vault
 * once they do.
 */
export async function addHouseholdMember(email: string, label?: string): Promise<{ wrap: PasskeyWrap; already: boolean; pending: boolean }> {
  const s = requireSession()
  requirePasskeysHere(s)
  const who = email.trim().toLowerCase()
  if (!isWrapIdentity(who)) throw new Error('Enter the Google account email they sign in with.')
  if (who === ownIdentity()) throw new Error('That’s you — use Add a passkey for your own devices.')
  const now = await fetchMembers()
  const member = now.members.some((m) => m.email.toLowerCase() === who)
  const invited = !member && now.invites.some((i) => i.email.toLowerCase() === who)
  if (!member && !invited) await addMember(who)
  try {
    const wrap = await addPasskey(label?.trim() || who, { identity: who })
    return { wrap, already: member, pending: !member }
  } catch (e) {
    if (!member && !invited) await withdrawInvite(who).catch(() => undefined) // best effort: the panel still offers Withdraw
    throw e
  }
}

/**
 * Withdraw an invitation and take the passkeys added for that person since it
 * was sent off the vault (a save; no re-key: the server serves the vault only
 * to members, and they haven't accepted). A passkey of theirs from before the
 * invitation — they were in the household once, say — stays: they may know
 * the key, so it shows under "no longer in the household", whose way out is a
 * re-key. Refused if they accepted meanwhile — taking a member out is Remove
 * from household, which re-keys.
 */
export async function cancelInvite(email: string): Promise<{ removed: number; kept: number }> {
  requireSession()
  const who = email.trim().toLowerCase()
  const before = await fetchMembers()
  const invite = before.invites.find((i) => i.email.toLowerCase() === who)
  try {
    if (!invite) throw new NetError('no waiting invitation', 404)
    await withdrawInvite(who)
  } catch (e) {
    if (!(e instanceof NetError && e.status === 404)) throw e
    const now = await fetchMembers().catch(() => null)
    if (now?.members.some((m) => m.email.toLowerCase() === who))
      throw new Error(`${who} accepted meanwhile and is in the household now. To take their access away, use Remove from household — it re-keys the vault.`)
    throw new Error(
      `${who}’s invitation is no longer waiting — they declined it, or it was already withdrawn. Any passkey of theirs still on the vault shows under “no longer in the household”.`,
    )
  }
  const addedSince = (k: PasskeyWrap) => addedWhileInvited(k.addedAt, invite.invited_at)
  const theirs = (k: PasskeyWrap) => k.identity === who
  let removed = 0
  const kept = requireSession().header.keys.filter((k) => theirs(k) && !addedSince(k)).length
  if (requireSession().header.keys.some((k) => theirs(k) && addedSince(k)))
    await queue.save((cur) => {
      const keep = cur.header.keys.filter((k) => !(theirs(k) && addedSince(k)))
      removed = cur.header.keys.length - keep.length
      if (removed === 0) return cur
      if (keep.length === 0) throw new Error('Every passkey on the vault is theirs, so none would be left — add one of yours first.')
      return { ...cur, header: { ...cur.header, keys: keep } }
    })
  return { removed, kept }
}

/**
 * Was a wrapping (its `addedAt`, by the adding device's clock) made after the
 * invitation was sent (the server's `invited_at`, UTC)? Only such a passkey
 * belongs to someone who was only ever invited — never served the vault.
 * Anything older, undated, or within the second of an invitation stamped to
 * the second (older servers) counts as possibly from a time they were in.
 */
export function addedWhileInvited(addedAt: string, invitedAt: string): boolean {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z)?$/.exec(invitedAt.trim())
  const t = Date.parse(addedAt)
  if (!m || !Number.isFinite(t)) return false
  const since = Date.parse(`${m[1]}T${m[2]}${m[3] ?? ''}Z`)
  return Number.isFinite(since) && t >= since + (m[3] ? 0 : 1000)
}

export async function removeMember(email: string): Promise<{ ok: true }> {
  const r = await net<{ ok: true }>(`/api/vault/members/${encodeURIComponent(email)}`, { method: 'DELETE' })
  void loadHousehold()
  return r
}

/* ---------- invitations waiting for this identity (the front door) ---------- */

/** An invitation into someone's household, waiting for this identity's answer. */
export type Invite = { household: string; invited_by: string; invited_at: string }

/**
 * Say yes to an invitation: this identity joins `household`. If it owns a
 * vault, that vault is deleted (with its history, members and invitations);
 * if it is in another household, it leaves it. Either needs `replaceOwn`,
 * and `version` pins the own vault's version the person confirmed deleting.
 */
export async function acceptInvite(household: string, o: { replaceOwn?: boolean; version?: number } = {}): Promise<void> {
  if (localMode.active && localMode.vault) throw new Error('End this session first — joining another household replaces what this identity opens.')
  await net<{ ok: true }>('/api/vault/invites/accept', {
    method: 'POST',
    body: JSON.stringify({ household, ...(o.replaceOwn ? { replaceOwn: true } : {}), ...(o.version !== undefined ? { version: o.version } : {}) }),
  })
}

/** Say no to an invitation: it is gone (the household can invite again). */
export async function declineInvite(household: string): Promise<void> {
  await net<{ ok: true }>(`/api/vault/invites/${encodeURIComponent(household)}`, { method: 'DELETE' })
}

/**
 * Leave the household this identity is a member of: the server stops serving
 * it the vault at once. In a session, anything unsaved is saved first (it is
 * the household's), and the session ends — back to the front door. The key
 * this identity knew still opens what was saved so far, and its passkeys stay
 * on the vault until the owner re-keys (their Household card asks them to).
 */
export async function leaveHousehold(): Promise<void> {
  const me = localMode.identity?.trim().toLowerCase()
  if (!me) throw new Error('Scarab doesn’t know who is signed in, so it can’t tell the server who is leaving.')
  if (localMode.active && localMode.vault && localMode.dirty) await queue.save()
  await net<{ ok: true }>(`/api/vault/members/${encodeURIComponent(me)}`, { method: 'DELETE' })
  if (localMode.active && localMode.vault) lockAndSay('You left the household. Its vault is no longer served to you; set up your own, or accept another invitation.')
}

/**
 * Server-side state the front door needs: is there a vault (its version, and
 * when and by whom it was saved), whose household this identity belongs to,
 * does the server hold any plaintext, and is it a vault-only server (no
 * household escape hatch)? A session polls it to follow the other member.
 */
export type Mode = {
  /** `sha256`: of the stored ciphertext (the same caller can download it), so a session notices a vault replaced at its own version. */
  vault: { version: number; updated_at: string; updated_by?: string | null; sha256?: string; keepsHistory?: boolean } | null
  household: string | null
  /** Invitations into a household waiting for this identity's answer (older servers: absent). */
  invites?: Invite[]
  serverHasData: boolean
  zkOnly: boolean
}
export const fetchMode = () => net<Mode>('/api/mode')

/* ---------- following the other member's saves ---------- */

/** A refresh found unsaved work in the tab (it was edited after the check): nothing was replaced. */
export class TabIsDirty extends Error {
  constructor() {
    super('This tab has unsaved changes, so the stored version wasn’t loaded over them.')
    this.name = 'TabIsDirty'
  }
}

/** No vault is stored any more (deleted, or replaced and not yet re-created). */
export class VaultGone extends Error {
  constructor() {
    super('No vault is stored on the server any more.')
    this.name = 'VaultGone'
  }
}

/** The session was locked — the page is reloading to the front door. Not a failure to report. */
export class SessionLocked extends Error {
  constructor(readonly note: string) {
    super(note)
    this.name = 'SessionLocked'
  }
}

const LOCK_NOTE_KEY = 'scarab:lock-note'

/** End the session and say why on the front door (the page reloads; see takeLockNote). */
function lockAndSay(note: string): void {
  try {
    sessionStorage.setItem(LOCK_NOTE_KEY, note)
  } catch {
    /* the front door just won't say why */
  }
  exitLocalMode()
}

/** lockAndSay, for a path that must stop here: throws SessionLocked (not a failure to report). */
function lockWithNote(note: string): never {
  lockAndSay(note)
  throw new SessionLocked(note)
}

let lockNote: string | null | undefined
/** Why the last session in this tab was locked on its own (the front door shows it). Read once per page load. */
export function takeLockNote(): string | null {
  if (lockNote === undefined) {
    try {
      lockNote = sessionStorage.getItem(LOCK_NOTE_KEY)
      sessionStorage.removeItem(LOCK_NOTE_KEY)
    } catch {
      lockNote = null
    }
  }
  return lockNote
}

const REKEYED =
  'The stored vault no longer opens with this tab’s key — it was re-keyed (a member was removed, or the key was rotated) or replaced. Unlock again with your passkey or the current recovery code.'

export type RefreshOptions = UnlockOptions & {
  /** Load the stored version even over unsaved work here ("take theirs"): this tab's unsaved changes are discarded. */
  discard?: boolean
}
export type Refreshed = { version: number; by: string | null; notice: string | null; changed: boolean }

/**
 * Load the stored vault into this tab in place, under the key already in it:
 * GET the blob, open it with the session key (which authenticates its header
 * and seq), judge it against this device's memory like an unlock, replace the
 * tab's data (the screens remount), and adopt its header — passkeys another
 * member added come along. Runs with no save alongside it.
 *
 * Without `discard` it refuses a tab with unsaved work — checked again the
 * moment before the data is replaced, so an edit made while the vault
 * downloaded is never thrown away. A blob the session key no longer opens
 * means the vault was re-keyed: the session locks, back to the front door —
 * unless, without `discard`, the tab was edited while it downloaded. Then it
 * refuses as for any unsaved work (TabIsDirty), so the banner and the sheet
 * offer Download mine before anything ends; Take theirs locks.
 */
export async function refreshFromVault(o: RefreshOptions = {}): Promise<Refreshed> {
  requireSession()
  return queue.exclusive(async () => {
    const s = requireSession()
    const writes = localMode.writes
    if (!o.discard && localMode.dirty) throw new TabIsDirty()
    const info = await fetchVaultInfo()
    if (!info) throw new VaultGone()
    noteRemote(info)
    if (!o.discard && info.version === s.version) return { version: s.version, by: info.updated_by ?? null, notice: null, changed: false }
    const blob = await parseServed(info)
    try {
      const { notice } = await openAndBoot(info, blob, s.rawDataKey, o, () => {
        if (localMode.vault !== s) throw new Error('the session changed while the vault downloaded — nothing was replaced')
        if (!o.discard && (localMode.dirty || localMode.writes !== writes)) throw new TabIsDirty()
      })
      void loadHousehold()
      return { version: info.version, by: info.updated_by ?? null, notice, changed: true }
    } catch (e) {
      if (e instanceof VaultAuthError) {
        // The key failed before beforeBoot could look: look here, since locking reloads the page over the tab's data.
        if (localMode.vault !== s) throw new Error('the session changed while the vault downloaded — nothing was replaced')
        if (!o.discard && (localMode.dirty || localMode.writes !== writes)) throw new TabIsDirty()
        lockWithNote(REKEYED)
      }
      throw e
    }
  })
}

/**
 * Keep this tab's copy: save it as the next version on top of the one
 * another member stored, replacing theirs. Their header is kept (passkeys
 * they added stay); their data changes are not. Refused when the vault was
 * re-keyed meanwhile — resealing under this tab's old key would undo a
 * rotation or a member's removal. Only offered when the server keeps
 * replaced versions (vault history), so nothing is lost for good.
 *
 * Their version is judged against this device's memory like an unlock: an
 * older copy than this device saw (a restored server, or a replayed one)
 * goes ahead only if `confirmRollback` says so — else RollbackRefused — and
 * then on this tab's own header, never the older copy's, which would bring
 * back whatever changed since (a passkey removed since, say).
 */
export async function keepMine(o: UnlockOptions = {}): Promise<SaveResult> {
  const s = requireSession()
  const info = await fetchVaultInfo()
  if (!info) throw new Error('No vault is stored any more, so there is nothing to keep this tab’s copy on top of. Download it instead.')
  noteRemote(info)
  const blob = await parseServed(info)
  try {
    await openPayload(blob, s.rawDataKey) // their header is authenticated under this tab's key, or it was re-keyed
  } catch (e) {
    if (e instanceof VaultAuthError)
      throw new Error('The vault was re-keyed since this tab opened it, so keeping this tab’s copy would undo that. Take theirs, or download yours.')
    throw e
  }
  const sha256 = await sha256Hex(new TextEncoder().encode(info.data))
  const { rollback } = judgeAgainstSeen(info, blob, sha256)
  if (rollback && !(o.confirmRollback && (await o.confirmRollback(rollback)))) throw new RollbackRefused(rollback)
  const r = await queue.save(undefined, {
    rebase: { rawDataKey: s.rawDataKey, header: rollback ? requireSession().header : sessionHeader(blob, rpId()), version: info.version },
    baseSha256: sha256,
  })
  void loadHousehold()
  return r
}

/**
 * Lock: let a save already on its way finish, save anything unsaved, then
 * end the session (the page reloads to the front door, which shows `note`
 * when given). A failed save throws, and nothing locks — nor does a tab still
 * holding unsaved changes after saving.
 */
export async function lockVault(o: { note?: string } = {}): Promise<void> {
  requireSession()
  // A save already queued or uploading — a rotation, a passkey added — finishes first: the page reloads when the
  // session ends, and an upload cut off by that is one whose outcome nobody hears.
  for (let i = 0; i < 8 && queue.inFlight() > 0; i++) await queue.exclusive(async () => undefined)
  // Twice at most: a write that landed while the first save was uploading rides the second.
  for (let i = 0; i < 2 && localMode.dirty; i++) await queue.save()
  if (localMode.dirty) throw new Error('Changes kept arriving while saving, so the session wasn’t locked.')
  if (o.note) lockAndSay(o.note)
  else exitLocalMode()
}

/* ---------- idle auto-lock ---------- */

const IDLE_LOCK_KEY = 'scarab:idle-lock'
/** Where the setting lives when localStorage refuses it. */
let memoryIdle: IdleMinutes | undefined

/** "15 minutes", "1 hour", "4 hours". */
export const idleText = (m: number) => (m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`)

/** This device's idle auto-lock setting (localStorage; never, when unset or unreadable). */
export function idleLockMinutes(): IdleMinutes {
  if (memoryIdle !== undefined) return memoryIdle
  try {
    const v = localStorage.getItem(IDLE_LOCK_KEY)
    const n = v === null ? null : Number(v)
    return isIdleMinutes(n) ? n : null
  } catch {
    return null
  }
}

/** Set this device's idle auto-lock (null: never). The idle clock starts over. */
export function setIdleLockMinutes(m: IdleMinutes): void {
  try {
    if (m === null) localStorage.removeItem(IDLE_LOCK_KEY)
    else localStorage.setItem(IDLE_LOCK_KEY, String(m))
    memoryIdle = undefined
  } catch {
    /* not remembered on this device: the choice lasts until the page closes */
    memoryIdle = m
  }
  idleLock.activity()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('scarab-mode'))
}

/** Why a save failed, in a few words, for the idle banner. */
function whyNotSaved(e: unknown): string {
  const k = failureKind(e)
  if (k === 'conflict') return 'the vault moved on without this tab (another device saved first)'
  if (k === 'transient') return 'the server couldn’t be reached'
  if (k === 'toolarge') return 'the vault is over the server’s size limit'
  return e instanceof Error ? e.message : String(e)
}

/**
 * After this device's chosen minutes without input, save and lock. Never over
 * unsaved work: when the save fails, nothing locks and the banner says why.
 */
export const idleLock = createIdleLock({
  active: () => localMode.active && localMode.vault !== null,
  minutes: idleLockMinutes,
  lock: (m) => lockVault({ note: `Locked after ${idleText(m)} without activity. Unlock again with your passkey or the recovery code.` }),
  blocked: (e, m) =>
    setFollow({ idleBlocked: `Didn’t lock after ${idleText(m)} idle: the unsaved changes couldn’t be saved — ${whyNotSaved(e)}. They’re still in this tab.` }),
})

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof setInterval === 'function') {
  const poke = () => idleLock.activity()
  for (const ev of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'])
    window.addEventListener(ev, poke, { passive: true, capture: true })
  setInterval(() => void idleLock.check(), IDLE_CHECK_MS)
  // A tab coming back after a long time hidden: judge it now, not at the next tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void idleLock.check()
  })
}

/** Someone is typing (a dialog is open, or focus is in a field): remounting the screens now would lose it. */
function editing(): boolean {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return false
  if (document.querySelector('dialog[open]')) return true
  const a = document.activeElement as HTMLElement | null
  return a?.matches?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]') === true
}

function attentionFor(serverVersion: number | null, sessionVersion: number): Attention {
  return serverVersion !== null && serverVersion > sessionVersion ? { kind: 'newer', version: serverVersion } : { kind: 'gone', version: serverVersion }
}

/**
 * One check: what does the server hold? In step → nothing (a stale notice
 * clears). Newer, and this tab has nothing unsaved → load it in place and
 * say so. Otherwise → the banner, and the person decides.
 */
export async function checkForUpdates(): Promise<void> {
  if (!localMode.active || !localMode.vault) return
  let m: Mode
  try {
    m = await fetchMode()
  } catch {
    return // offline or a hiccup: the next check tries again
  }
  const s = localMode.vault
  if (!localMode.active || !s) return
  noteRemote(m.vault)
  // Someone invited hasn't answered yet: see whether they have (the avatars and the Household card follow).
  if (followState.household && followState.household.invited.length > 0) void loadHousehold()
  const serverVersion = m.vault?.version ?? null
  // Same version number, different blob: deleted and created again, or restored, under this tab.
  const known = queue.storedAs()
  const replaced = !!m.vault?.sha256 && known?.version === serverVersion && serverVersion === s.version && known.sha256 !== m.vault.sha256
  const d = decideOnPoll({ serverVersion, sessionVersion: s.version, dirty: localMode.dirty, inFlight: queue.inFlight(), replaced })
  if (d === 'none') {
    if (followState.attention && serverVersion === s.version) setFollow({ attention: null })
    return
  }
  if (d === 'banner' || editing()) {
    const a = attentionFor(serverVersion, s.version)
    if (followState.attention?.kind !== a.kind || followState.attention.version !== a.version) setFollow({ attention: a })
    return
  }
  try {
    const r = await refreshFromVault()
    if (r.changed) emitFollow({ kind: 'updated', version: r.version, by: r.by, notice: r.notice })
  } catch (e) {
    if (e instanceof SessionLocked) return // re-keyed: the page is going to the front door
    if (e instanceof RollbackRefused) setFollow({ attention: { kind: 'older', version: e.rollback.served.version } })
    else if (e instanceof VaultGone) setFollow({ attention: { kind: 'gone', version: null } })
    // Edited meanwhile, or the version didn't load (offline, a snapshot this page can't read): never silent —
    // the banner offers it, loading it says why if it fails again, and the next check tries by itself.
    else setFollow({ attention: attentionFor(serverVersion, s.version) })
  }
}

/** Every 45s while the tab is visible and holds a vault, at once on focus; never while hidden. */
const watcher = createWatcher({
  active: () => localMode.active && localMode.vault !== null,
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  poll: checkForUpdates,
})

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('scarab-mode', () => watcher.onMode())
  window.addEventListener('focus', () => watcher.wake())
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? watcher.sleep() : watcher.wake()))
}

/* ---------- vault history, and encrypted backup files ---------- */

/** One version the server keeps for this household (metadata only — the blob comes with openHistoryVersion). */
export type HistoryEntry = { version: number; sha256: string; size: number; updated_at: string; updated_by: string | null; pin: string | null }
export type HistoryPolicy = { keepLast: number; dailyDays: number; maxPins: number; byteCap: number }
export type VaultHistory = { entries: HistoryEntry[]; bytes: number; policy: HistoryPolicy }

/** The versions the server keeps for this household, newest first. Ciphertext metadata; nothing is opened. */
export const fetchHistory = () => net<VaultHistory>('/api/vault/history')

/** How a backup file was opened: with the tab's own key, a passkey, or its recovery code. */
export type OpenedVia = { kind: 'session' } | UnlockedWith

/**
 * Where an opened snapshot came from. `sealedAs` is the version its
 * authenticated header says it was sealed for (null for a v2 blob) — for a
 * history entry it should be the version the server listed it as.
 */
export type SnapshotSource =
  | { kind: 'history'; version: number; at: number | null; by: string | null; pin: string | null; sealedAs: number | null }
  | { kind: 'backup'; name: string; sealedAs: number; vaultId: string; via: OpenedVia }

/**
 * A decrypted snapshot, looked at but not loaded: an earlier version from the
 * server's history, or a backup file. `counts` are its rows per table as this
 * engine loads it (in a scratch database — the tab's is untouched); null, with
 * `unreadable` saying why, when this engine can't load it.
 */
export type OpenedSnapshot = {
  source: SnapshotSource
  dump: Dump
  exportedAt: string
  schemaVersion: number
  counts: Record<string, number> | null
  unreadable: string | null
  upgraded: number[]
}

/** Authenticated plaintext → a snapshot, or a clear refusal. */
function decodeSnapshot(plaintext: Uint8Array): Dump {
  let d: unknown
  try {
    d = decodeDump(plaintext)
  } catch {
    throw new Error('It opened, but what is inside isn’t a Scarab snapshot.')
  }
  const x = d as Partial<Dump> | null
  if (!x || x.scarab !== true || typeof x.tables !== 'object' || x.tables === null || !Number.isInteger(x.schemaVersion))
    throw new Error('It opened, but what is inside isn’t a Scarab snapshot.')
  return d as Dump
}

/** Load `dump` into a throwaway in-tab database, to count its rows and prove this engine reads it. The tab's data is untouched. */
async function inspect(dump: Dump): Promise<Pick<OpenedSnapshot, 'counts' | 'unreadable' | 'upgraded'>> {
  const [{ openBrowserDb }, { migrate }, { loadDump, TABLES }, wasmUrl] = await Promise.all([
    import('../engine/sqljs-db'),
    import('../engine/migrations'),
    import('../engine/snapshot'),
    import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
  ])
  const db = await openBrowserDb({ wasmUrl })
  try {
    migrate(db)
    const loaded = loadDump(db, dump)
    const counts: Record<string, number> = {}
    for (const t of TABLES)
      counts[t] = (db.prepare(`SELECT count(*) AS n FROM ${t}${t === 'app_meta' ? " WHERE key NOT LIKE 'basket:%'" : ''}`).get() as { n: number }).n
    return { counts, unreadable: null, upgraded: loaded.upgraded }
  } catch (e) {
    return { counts: null, unreadable: e instanceof Error ? e.message : String(e), upgraded: [] }
  } finally {
    db.close()
  }
}

async function opened(source: SnapshotSource, dump: Dump): Promise<OpenedSnapshot> {
  return { source, dump, exportedAt: typeof dump.exportedAt === 'string' ? dump.exportedAt : '', schemaVersion: dump.schemaVersion, ...(await inspect(dump)) }
}

/**
 * Fetch one version from the server's history and open it with the session
 * key, which authenticates it (a v3 header says which version it was sealed
 * for). Nothing in the tab changes.
 */
export async function openHistoryVersion(version: number): Promise<OpenedSnapshot> {
  const s = requireSession()
  const row = await net<HistoryEntry & { data: string }>(`/api/vault/history/${version}`)
  let blob: VaultBlob
  try {
    blob = parseVaultBlob(row.data)
  } catch (e) {
    if (e instanceof NewerVaultFormatError) throw new Error(`v${version} was saved by a newer Scarab than this page — reload the page to open it.`)
    throw e
  }
  let plaintext: Uint8Array
  try {
    plaintext = await openPayload(blob, s.rawDataKey)
  } catch (e) {
    if (e instanceof VaultAuthError) throw new Error(`v${version} doesn’t open with this session’s key: it was sealed under another key, or it was altered.`)
    throw e
  }
  return opened(
    { kind: 'history', version, at: parseServerTime(row.updated_at), by: row.updated_by ?? null, pin: row.pin ?? null, sealedAs: blob.v === 3 ? blob.seq : null },
    decodeSnapshot(plaintext),
  )
}

/** What a restore did: the version it saved, and the version it replaced, which the server keeps pinned. */
export type Restored = { version: number; pinned: number | null; skipped: boolean }

/**
 * Put an opened snapshot's data back as the vault's next version — never
 * destructive. Unsaved work in the tab is saved first, as a version of its
 * own; the version current before the restore stays in the server's history,
 * pinned ('pre-restore'), so the restore itself can be undone. The data is
 * resealed under the session's key and header — whatever the snapshot was
 * sealed with — so a restore never brings back a passkey removed since, nor
 * an old key: only data. Identical data uploads nothing (`skipped`).
 */
export async function restoreSnapshot(snap: OpenedSnapshot): Promise<Restored> {
  requireSession()
  if (snap.unreadable) throw new Error(`This engine can’t load it: ${snap.unreadable}`)
  if (localMode.dirty) await queue.save() // unsaved work becomes its own version first; if that fails, nothing changes
  let pinned = 0
  // Replace the tab's data with nothing else running (a refresh can't interleave), and pin what the server holds now.
  await queue.exclusive(async () => {
    const s = requireSession()
    pinned = s.version
    pendingPin = { vaultId: s.header.vaultId, version: s.version, pin: 'pre-restore' }
    try {
      await loadLocalDump(snap.dump)
    } catch (e) {
      pendingPin = null
      throw e
    }
  })
  try {
    const r = await queue.save()
    // Identical data uploads nothing, so nothing was replaced: the pin must not ride on the next ordinary save.
    if (r.skipped && pendingPin?.pin === 'pre-restore' && pendingPin.version === pinned) pendingPin = null
    if (snap.source.kind === 'backup' && pendingBackupState === snap) setPendingBackup(null)
    return { version: r.version, pinned: r.skipped ? null : pinned, skipped: r.skipped }
  } catch (e) {
    if (failureKind(e) === 'conflict')
      throw new Error(
        'It’s loaded in this tab, but the vault moved on meanwhile, so it isn’t saved yet. Review it from the banner: keep this tab’s copy (the restore), or take theirs.',
      )
    throw e
  }
}

/* ---- backup files (.scarab): the tab's data sealed like a vault version, kept by the person ---- */

/** A backup file: a v3 vault blob in a small envelope. Everything outside `vault` is unauthenticated and ignored. */
export type BackupFile = { scarab: 'backup'; format: 1; vault: VaultBlobV3 }
export const BACKUP_FORMAT = 1
/** A backup can't be larger than a vault: the courier caps blobs at 10 MB of ciphertext (≈14 MB as text). */
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024

/**
 * Seal this tab's data — unsaved changes included — under the session's key
 * and header, as a file to keep. Nothing is uploaded: the server never sees
 * it. Every passkey on the vault and the recovery code open it, as they open
 * the vault (and keep opening it after a later rotation: a backup keeps the
 * key it was sealed with). Its header shows what the stored blob shows —
 * passkey labels, the identities they belong to, the RP ID; the data is
 * ciphertext.
 */
export async function makeBackup(): Promise<{ name: string; text: string; version: number; unsaved: boolean }> {
  const s = requireSession()
  const unsaved = localMode.dirty
  const dump = await localDump()
  // Sealed for the version the tab is at: authenticated, and a different blob than the server's at that seq.
  const vault = await sealVault(s.header, s.rawDataKey, new TextEncoder().encode(JSON.stringify(dump)), Math.max(1, s.version))
  const file: BackupFile = { scarab: 'backup', format: BACKUP_FORMAT, vault }
  return { name: `scarab-backup-${todayLocal()}-v${s.version}${unsaved ? '-unsaved' : ''}.scarab`, text: JSON.stringify(file), version: s.version, unsaved }
}

/** A backup file, parsed (not yet opened: nothing in it is trusted until its payload authenticates). */
export type ParsedBackup = { name: string; blob: VaultBlobV3 }

/** The text of a .scarab file → its vault blob. Refuses anything else, with a reason a person can act on. */
export function parseBackup(text: string, name: string): ParsedBackup {
  if (text.length > MAX_BACKUP_BYTES) throw new Error('That file is too large to be a Scarab backup.')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('That isn’t a Scarab backup file (.scarab).')
  }
  const x = raw as Record<string, unknown> | null
  if (x && x.scarab === true && typeof x.tables === 'object')
    throw new Error('That is a plain export (JSON), not an encrypted backup — load it with “Load an export into this tab”.')
  if (!x || x.scarab !== 'backup' || typeof x.format !== 'number') throw new Error('That isn’t a Scarab backup file (.scarab).')
  if (x.format > BACKUP_FORMAT) throw new Error('That backup was made by a newer version of Scarab — reload the page, then open it again.')
  if (x.format !== BACKUP_FORMAT) throw new Error('That isn’t a Scarab backup file (.scarab).')
  let blob: VaultBlob
  try {
    blob = parseVaultBlob(JSON.stringify(x.vault))
  } catch (e) {
    if (e instanceof NewerVaultFormatError) throw new Error('That backup was made by a newer version of Scarab — reload the page, then open it again.')
    throw new Error(`That backup file is damaged (${e instanceof Error ? e.message : String(e)}).`)
  }
  if (blob.v !== 3) throw new Error('That backup file is damaged (not format v3).')
  return { name, blob }
}

/** The backup is sealed under another key than the tab's: it needs a passkey or its recovery code. Nothing changed. */
export class BackupNeedsKey extends Error {
  constructor() {
    super('This backup is sealed under a different key than this session’s — from before a key rotation, or another vault. Open it with a passkey or its recovery code.')
    this.name = 'BackupNeedsKey'
  }
}

/** How to open a backup: with the tab's own key (no prompt), a passkey (the backup's own list), or a recovery code. */
export type BackupKey = { kind: 'session' } | { kind: 'passkey' } | { kind: 'recovery'; code: string }

/** The key and header an opened backup was sealed with — kept out of the snapshot object, for restoring it as a new vault. */
const backupKeys = new WeakMap<OpenedSnapshot, { rawDataKey: Uint8Array; header: VaultHeader }>()

/** Decrypt a backup file in this tab. Its payload authenticates its header; nothing in the tab changes. */
export async function openBackup(p: ParsedBackup, how: BackupKey): Promise<OpenedSnapshot> {
  const blob = p.blob
  let key: Uint8Array
  let via: OpenedVia
  let checked = true
  if (how.kind === 'session') {
    key = requireSession().rawDataKey
    via = { kind: 'session' }
  } else if (how.kind === 'passkey') {
    if (!passkeysWorkHere(blob.rpId)) throw new Error(`${wrongOriginMessage(blob.rpId)} (The backup’s passkeys are the vault’s.)`)
    if (blob.keys.length === 0) throw new Error('This backup lists no passkeys — only its recovery code opens it.')
    const pk = await assertPasskey({ prfSaltB64: blob.prfSalt, credentialIds: blob.keys.map((k) => k.credentialId) })
    key = await unwrapWithPasskey(blob, pk.credentialId, pk.prfOutput)
    noteDevicePasskey(pk)
    via = { kind: 'passkey', label: blob.keys.find((k) => k.credentialId === pk.credentialId)?.label ?? '', credentialId: pk.credentialId }
  } else {
    const parsed = await parseRecoveryCode(how.code) // a typo is reported as one, before anything is tried
    key = parsed.key
    checked = parsed.checked
    via = { kind: 'recovery' }
  }
  let plaintext: Uint8Array
  try {
    plaintext = await openPayload(blob, key)
  } catch (e) {
    if (!(e instanceof VaultAuthError)) throw e
    if (how.kind === 'session') {
      // A salt is minted with its key (create, rotation), so a backup naming this vault and its current salt claims this key.
      const s = localMode.vault
      if (s && s.header.vaultId === blob.vaultId && s.header.prfSalt === blob.prfSalt)
        throw new Error('This backup says it is sealed with this vault’s current key, but it doesn’t authenticate under it: the file is damaged or was altered.')
      throw new BackupNeedsKey()
    }
    if (how.kind === 'recovery')
      throw new Error(
        checked
          ? 'That recovery code is typed correctly but doesn’t open this backup — it may be for another key (from after a rotation), or another vault.'
          : 'That code doesn’t open this backup: a typo (a 52-character code has no check group to catch one), or a code for another key.',
      )
    // A passkey unwrapped a key, and the payload still failed: the file itself was changed.
    throw new Error('The passkey opened it, but the backup’s contents don’t authenticate: the file is damaged or was altered.')
  }
  const snap = await opened({ kind: 'backup', name: p.name, sealedAs: blob.seq, vaultId: blob.vaultId, via }, decodeSnapshot(plaintext))
  backupKeys.set(snap, { rawDataKey: key, header: sessionHeader(blob, rpId()) })
  return snap
}

/**
 * How an opened backup relates to the vault open in this tab now (null: not
 * a backup, or no vault open): the same vault (its id), and the same key —
 * false for a backup sealed before a rotation. Asked when shown, since a
 * backup opened at the front door meets its session only later.
 */
export function relationOf(snap: OpenedSnapshot): { sameVault: boolean; sameKey: boolean } | null {
  const s = localMode.vault
  const k = backupKeys.get(snap)
  if (!s || !k || snap.source.kind !== 'backup') return null
  return { sameVault: s.header.vaultId === snap.source.vaultId, sameKey: sameKey(s.rawDataKey, k.rawDataKey) }
}

/* A backup opened at the front door, waiting to be offered once a session is open. */
let pendingBackupState: OpenedSnapshot | null = null
/** The backup the person opened before unlocking, to be offered for restore in the session (the preview host shows it). */
export const pendingBackup = (): OpenedSnapshot | null => pendingBackupState
export function setPendingBackup(snap: OpenedSnapshot | null): void {
  if (pendingBackupState === snap) return
  pendingBackupState = snap
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('scarab-mode'))
}

/** What opening a backup at the front door led to. */
export type BackupAtDoor =
  /** Its key opens the stored vault too: the vault is unlocked (with it), and the backup waits to be offered for restore. */
  | { kind: 'unlocked'; unlocked: Unlocked }
  /** The stored vault needs its own passkey or recovery code (the backup is from an earlier key, or another vault); the backup waits. */
  | { kind: 'locked' }
  /** No vault is stored: the backup can become it (restoreBackupAsVault). */
  | { kind: 'none' }

/**
 * The front door, after a backup was opened with a passkey or its recovery
 * code: if the same key opens the stored vault, unlock it with that key
 * (judged against this device's memory like any unlock) — one prompt, not
 * two. The backup is then offered for restore inside the session.
 */
export async function enterWithBackup(snap: OpenedSnapshot, o: UnlockOptions = {}): Promise<BackupAtDoor> {
  const k = backupKeys.get(snap)
  if (!k || snap.source.kind !== 'backup') throw new Error('Open the backup with a passkey or its recovery code first.')
  const info = await fetchVaultInfo()
  if (!info) return { kind: 'none' }
  const blob = await parseServed(info)
  try {
    const { loaded, notice } = await openAndBoot(info, blob, k.rawDataKey, o)
    const via = snap.source.via
    const label = via.kind === 'passkey' ? (blob.keys.find((w) => w.credentialId === via.credentialId)?.label ?? via.label) : ''
    setFollow({ unlockedWith: via.kind === 'passkey' ? { ...via, label } : { kind: 'recovery' } })
    void loadHousehold()
    idleLock.reset()
    setPendingBackup(snap)
    return { kind: 'unlocked', unlocked: { version: info.version, label, loaded, notice } }
  } catch (e) {
    if (!(e instanceof VaultAuthError)) throw e
    setPendingBackup(snap)
    return { kind: 'locked' }
  }
}

/**
 * This device saw the backup's vault later than the backup (null: it never
 * saw it, or not later): the version it saw, and whether the key was changed
 * since the backup was sealed — a rotation, or a member removed (null: the
 * memory predates keeping the key's salt, so it can't tell). Restoring such a
 * backup as the vault would put back its key and passkey list — a passkey
 * removed since, a recovery code retired since, would open the vault again —
 * and this device's memory of the vault would start over from it.
 */
export type BackupBehind = { seen: SeenRecord; sealedAs: number; rekeyed: boolean | null }

export function backupBehind(snap: OpenedSnapshot): BackupBehind | null {
  const k = backupKeys.get(snap)
  if (!k || snap.source.kind !== 'backup') return null
  const seen = readSeen(snap.source.vaultId)
  if (!seen) return null
  const rekeyed = seen.prfSalt === undefined ? null : seen.prfSalt !== k.header.prfSalt
  if (rekeyed !== true && seen.seq <= snap.source.sealedAs) return null
  return { seen, sealedAs: snap.source.sealedAs, rekeyed }
}

/**
 * No vault is stored (the server lost it, or it was never made here): make
 * the backup the vault, with the key and header it was sealed with — so
 * every passkey on it and its recovery code open the vault as before. Stored
 * as version 0, which the server refuses if a vault appeared meanwhile.
 *
 * Not when this device saw the vault move on since the backup (backupBehind):
 * a key changed since is never put back — newVaultFromBackup is the way — and
 * a vault that only got newer needs `overSeen`, the person's explicit yes
 * after being told. A server that "lost" the vault may be withholding it.
 */
export async function restoreBackupAsVault(snap: OpenedSnapshot, o: { overSeen?: boolean } = {}): Promise<SaveResult> {
  const k = backupKeys.get(snap)
  if (!k || snap.source.kind !== 'backup') throw new Error('Open the backup with a passkey or its recovery code first.')
  if (snap.unreadable) throw new Error(`This engine can’t load it: ${snap.unreadable}`)
  if (localMode.vault) throw new Error('This session already has a vault — restore the backup into it instead.')
  const behind = backupBehind(snap)
  if (behind?.rekeyed === true)
    throw new Error(
      `This device saw this vault at v${behind.seen.seq}, re-keyed after this backup was sealed (v${behind.sealedAs}). Restoring it as it was would bring back the retired key and the passkeys it listed — start a new vault from it instead.`,
    )
  if (behind && !o.overSeen)
    throw new Error(
      `This device saw this vault at v${behind.seen.seq}, later than this backup (v${behind.sealedAs}). Restoring it as it was needs your explicit confirmation — or start a new vault from it.`,
    )
  const existing = await fetchVaultInfo()
  if (existing) throw new Error(`A vault is stored here (v${existing.version}). Unlock it, then restore the backup into it.`)
  if (localMode.active) await loadLocalDump(snap.dump)
  else await enterLocalMode(snap.dump, null)
  let r: SaveResult
  try {
    r = await queue.save(undefined, { seed: { rawDataKey: k.rawDataKey, header: k.header, version: 0 } })
  } catch (e) {
    if (e instanceof NetError && e.status === 409)
      throw new Error('A vault was stored here in the meantime — nothing was overwritten. Unlock it, then restore the backup into it.')
    throw e
  }
  const via = snap.source.via
  setFollow({ unlockedWith: via.kind === 'passkey' ? via : { kind: 'recovery' } })
  loadOwed(k.header)
  void loadHousehold()
  idleLock.reset()
  setPendingBackup(null)
  return r
}

/**
 * No vault is stored: start a new one — a fresh key, a new vault id, this
 * device's new passkey, a new recovery code — holding an opened backup's
 * data. Nothing the backup was sealed with (its key, passkeys, recovery
 * code) opens it, and this device's memory of the backup's vault stays as it
 * was. The safe way back from a backup the vault had moved on from
 * (backupBehind). Other passkeys and members' access are added again.
 */
export async function newVaultFromBackup(snap: OpenedSnapshot, label: string): Promise<SaveResult & { recoveryCode: string }> {
  if (!backupKeys.get(snap) || snap.source.kind !== 'backup') throw new Error('Open the backup with a passkey or its recovery code first.')
  if (snap.unreadable) throw new Error(`This engine can’t load it: ${snap.unreadable}`)
  if (localMode.vault) throw new Error('This session already has a vault — restore the backup into it instead.')
  const existing = await fetchVaultInfo() // before the tab's data is touched (createVault asks again, after the passkey)
  if (existing) throw new Error(`A vault is stored here (v${existing.version}). Unlock it, then restore the backup into it.`)
  if (localMode.active) await loadLocalDump(snap.dump)
  else await enterLocalMode(snap.dump, null)
  const r = await createVault(label)
  setPendingBackup(null)
  return r
}

/* ---------- another tab of this browser ---------- */

/**
 * "Scarab is open in another tab": two sessions of one vault in one browser
 * each hold their own copy and save on their own, so the second one is told.
 * A BroadcastChannel ping carrying a random tab id — nothing leaves the browser.
 */
function watchOtherTabs(): void {
  if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return
  const ch = new BroadcastChannel('scarab-session')
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Math.random().toString(36).slice(2)
  const presence = createTabPresence(ch as unknown as PresenceChannel, {
    id,
    active: () => localMode.active,
    changed: () => setFollow({ otherTab: presence.ahead > 0 }),
  })
  presence.announce(false) // at load (the front door): is a session open elsewhere?
  let wasActive = localMode.active
  window.addEventListener('scarab-mode', () => {
    if (localMode.active && !wasActive) presence.announce(true)
    wasActive = localMode.active
  })
  window.addEventListener('pagehide', () => presence.leave())
}
watchOtherTabs()
