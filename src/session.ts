import type { Dump } from '../engine/snapshot'
import {
  decodeRecoveryCode,
  encodeRecoveryCode,
  headerOf,
  newVault,
  openPayload,
  sealVault,
  unwrapWithPasskey,
  wrapForPasskey,
  type PasskeyWrap,
  type VaultBlob,
  type VaultHeader,
} from '../shared/vault'
import { enterLocalMode, loadLocalDump, localDump, localMode, type VaultSession } from './local'
import { assertPasskey, registerPasskey } from './passkey'

/**
 * The zero-knowledge session, end to end:
 *
 *   unlock  — fetch ciphertext → a passkey tap yields the PRF secret → unwrap
 *             the data key → decrypt in this tab → boot the in-tab engine.
 *             The server never receives plaintext; nothing reloads.
 *   save    — dump the in-tab database → reseal under the key kept from
 *             unlock → upload ciphertext. The only way local work persists.
 *   add     — a second device or a household member: one more passkey
 *             wrapping in the header, then a save. Nothing is re-encrypted.
 *
 * /api/vault is the one path that always goes to the network — the
 * encrypted-blob courier — so these work identically in both modes.
 */

export type VaultInfo = { version: number; sha256: string; size: number; data: string; updated_at: string }

async function net<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { headers: init?.body ? { 'content-type': 'application/json' } : undefined, ...init })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${r.status} ${r.statusText}`)
  }
  return r.json() as Promise<T>
}

/** The stored vault, or null when none exists yet. */
export async function fetchVaultInfo(): Promise<VaultInfo | null> {
  const r = await fetch('/api/vault')
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`vault: ${r.status} ${r.statusText}`)
  return r.json() as Promise<VaultInfo>
}

function parseBlob(info: VaultInfo): VaultBlob {
  const blob = JSON.parse(info.data) as VaultBlob
  if (blob.v !== 2) throw new Error(`this vault is format v${(blob as { v: unknown }).v}; only passkey vaults (v2) can be opened`)
  return blob
}

/** Every passkey registered on the stored vault — readable without unlocking (nothing in the header is secret). */
export async function fetchVaultKeys(): Promise<{ version: number; keys: PasskeyWrap[] } | null> {
  const info = await fetchVaultInfo()
  if (!info) return null
  return { version: info.version, keys: parseBlob(info).keys }
}

async function boot(dump: Dump, session: VaultSession): Promise<void> {
  if (localMode.active) {
    await loadLocalDump(dump)
    localMode.setVault(session)
    localMode.markSaved(session.version)
  } else {
    await enterLocalMode(dump, session)
  }
}

const decodeDump = (plaintext: Uint8Array) => JSON.parse(new TextDecoder().decode(plaintext)) as Dump

/** One passkey tap: decrypt the stored vault in this tab and run on it. Replaces the tab's data if a session is already on. */
export async function unlockVault(): Promise<{ version: number; label: string }> {
  const info = await fetchVaultInfo()
  if (!info) throw new Error('no vault stored yet')
  const blob = parseBlob(info)
  if (blob.keys.length === 0) throw new Error('this vault has no passkeys — only its recovery code can open it')
  const { credentialId, prfOutput } = await assertPasskey({ prfSaltB64: blob.prfSalt, credentialIds: blob.keys.map((k) => k.credentialId) })
  const rawDataKey = await unwrapWithPasskey(blob, credentialId, prfOutput)
  const dump = decodeDump(await openPayload(blob, rawDataKey))
  await boot(dump, { rawDataKey, header: headerOf(blob), version: info.version })
  return { version: info.version, label: blob.keys.find((k) => k.credentialId === credentialId)?.label ?? '' }
}

/** Break-glass: the typed recovery code is the raw data key. */
export async function unlockWithRecoveryCode(code: string): Promise<{ version: number }> {
  const rawDataKey = decodeRecoveryCode(code)
  const info = await fetchVaultInfo()
  if (!info) throw new Error('no vault stored yet')
  const blob = parseBlob(info)
  const dump = decodeDump(await openPayload(blob, rawDataKey))
  await boot(dump, { rawDataKey, header: headerOf(blob), version: info.version })
  return { version: info.version }
}

/** Boot an empty in-tab database: a session that starts with no plaintext anywhere. */
export async function startEmpty(): Promise<void> {
  await enterLocalMode(null, null)
}

export type SaveResult = { version: number; sha256: string; bytes: number }

// Saves run one at a time. Autosave and a manual save can be requested in the
// same instant; the second waits and then seals whatever the tab holds by the
// time it runs, against the version the first one just established.
let saveChain: Promise<unknown> = Promise.resolve()

/**
 * Seal the tab's database under the session key with the given header and
 * upload it. `version` defaults to what the session has seen most recently,
 * read when this save actually runs (after any save ahead of it).
 */
function seal(header: VaultHeader, rawDataKey: Uint8Array, version?: number): Promise<SaveResult> {
  const job = async (): Promise<SaveResult> => {
    const writesAtDump = localMode.writes
    const dump = await localDump()
    const plaintext = new TextEncoder().encode(JSON.stringify(dump))
    const blob = await sealVault(header, rawDataKey, plaintext)
    // Version check: the server refuses stale writes, so a second device can't
    // silently clobber this one. Base it on what this session last saw.
    const r = await net<{ ok: true; version: number; sha256: string }>('/api/vault', {
      method: 'PUT',
      body: JSON.stringify({ data: JSON.stringify(blob), version: version ?? localMode.vault?.version ?? 0 }),
    })
    localMode.setVault({ rawDataKey, header: headerOf(blob), version: r.version })
    localMode.markSaved(r.version, writesAtDump)
    return { version: r.version, sha256: r.sha256, bytes: plaintext.length }
  }
  const next = saveChain.then(job, job)
  saveChain = next.catch(() => undefined)
  return next
}

/* ---------- autosave ---------- */

/**
 * Once a session holds a key, every write is uploaded on its own: a short
 * debounce after the last write, or at once when the tab goes into the
 * background. A failure (typically a version conflict — another device saved
 * first) is shown, not retried in a loop; the next write or a manual save
 * tries again. Nothing here changes what "save" means: same key, reseal.
 */
export const autosave = {
  status: 'idle' as 'idle' | 'saving' | 'error',
  error: null as string | null,
  lastSavedAt: null as Date | null,
}
const AUTOSAVE_DELAY_MS = 1500
let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function announce() {
  window.dispatchEvent(new Event('scarab-mode'))
}

async function runAutosave(): Promise<void> {
  autosaveTimer = null
  if (!localMode.active || !localMode.vault || !localMode.dirty || autosave.status === 'saving') return
  autosave.status = 'saving'
  announce()
  try {
    await saveVault()
    autosave.status = 'idle'
    autosave.error = null
    autosave.lastSavedAt = new Date()
  } catch (e) {
    autosave.status = 'error'
    autosave.error = e instanceof Error ? e.message : String(e)
  }
  announce()
  // Writes that arrived mid-upload left the tab dirty: go again.
  if (autosave.status === 'idle' && localMode.dirty) scheduleAutosave()
}

function scheduleAutosave(): void {
  // An error is sticky: retrying a version conflict every second helps nobody.
  // A manual save (or a fresh unlock) clears it.
  if (!localMode.active || !localMode.vault || !localMode.dirty || autosave.status === 'error') return
  if (autosaveTimer) clearTimeout(autosaveTimer)
  autosaveTimer = setTimeout(() => void runAutosave(), AUTOSAVE_DELAY_MS)
}

if (typeof window !== 'undefined') {
  // The engine fires this when the tab turns dirty (and on every save); the
  // debounce absorbs bursts such as a statement import.
  window.addEventListener('scarab-mode', () => {
    if (autosave.status === 'error' && !localMode.dirty) {
      autosave.status = 'idle' // a manual save or a new unlock cleared it
      autosave.error = null
    }
    if (autosave.status !== 'saving') scheduleAutosave()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && localMode.dirty && localMode.vault) {
      if (autosaveTimer) clearTimeout(autosaveTimer)
      void runAutosave()
    }
  })
}

function requireSession(): VaultSession {
  if (!localMode.active) throw new Error('not in a zero-knowledge session')
  const s = localMode.vault
  if (!s) throw new Error('no vault yet — create one first')
  return s
}

/** Persist the in-tab database. Reseals under the session key; every passkey and the recovery code keep working. */
export async function saveVault(): Promise<SaveResult> {
  const s = requireSession()
  return seal(s.header, s.rawDataKey)
}

/**
 * First save of a session that has no vault: mint a data key, register this
 * device's passkey as its first wrapping, seal, upload. Returns the recovery
 * code — the one time it is offered unprompted.
 */
export async function createVault(label: string): Promise<SaveResult & { recoveryCode: string }> {
  if (!localMode.active) throw new Error('not in a zero-knowledge session')
  if (localMode.vault) throw new Error('this session already has a vault')
  const { rawDataKey, header } = newVault()
  const pk = await registerPasskey({ prfSaltB64: header.prfSalt, label, excludeCredentialIds: [] })
  header.keys.push(await wrapForPasskey(rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label }))
  const version = (await fetchVaultInfo())?.version ?? 0
  const r = await seal(header, rawDataKey, version)
  return { ...r, recoveryCode: encodeRecoveryCode(rawDataKey) }
}

/**
 * Register one more passkey on the vault — this device's, or a household
 * member's phone via the browser's QR hybrid prompt — and save. Same
 * mechanism either way; the label is what the members list will show.
 */
export async function addPasskey(label: string): Promise<PasskeyWrap> {
  const s = requireSession()
  const pk = await registerPasskey({
    prfSaltB64: s.header.prfSalt,
    label,
    excludeCredentialIds: s.header.keys.map((k) => k.credentialId),
  })
  const wrap = await wrapForPasskey(s.rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label })
  const header: VaultHeader = { ...s.header, keys: [...s.header.keys, wrap] }
  await seal(header, s.rawDataKey)
  return wrap
}

/** Drop a passkey's wrapping and save. The last one stays: without it only the recovery code could open the vault. */
export async function removePasskey(credentialId: string): Promise<void> {
  const s = requireSession()
  if (!s.header.keys.some((k) => k.credentialId === credentialId)) throw new Error('that passkey is not on the vault')
  if (s.header.keys.length === 1) throw new Error('cannot remove the only passkey on the vault')
  const header: VaultHeader = { ...s.header, keys: s.header.keys.filter((k) => k.credentialId !== credentialId) }
  await seal(header, s.rawDataKey)
}

/**
 * Rotate: a new data key, new PRF salt, new recovery code. The passkey that
 * answers the prompt is re-wrapped; every other passkey drops off and must
 * be added again. For when a recovery code may have leaked.
 */
export async function rotateVault(): Promise<{ version: number; recoveryCode: string; kept: string }> {
  const s = requireSession()
  const fresh = newVault()
  const pk = await assertPasskey({ prfSaltB64: fresh.header.prfSalt, credentialIds: s.header.keys.map((k) => k.credentialId) })
  const old = s.header.keys.find((k) => k.credentialId === pk.credentialId)!
  fresh.header.keys.push(await wrapForPasskey(fresh.rawDataKey, pk.prfOutput, { credentialId: pk.credentialId, label: old.label }))
  const r = await seal(fresh.header, fresh.rawDataKey)
  return { version: r.version, recoveryCode: encodeRecoveryCode(fresh.rawDataKey), kept: old.label }
}

/** The recovery code of the unlocked vault. Only an unlocked session can ask; show it, never store it. */
export function recoveryCodeOfSession(): string {
  return encodeRecoveryCode(requireSession().rawDataKey)
}

/* ---------- household members (server-side routing, no secrets) ---------- */

export type Member = { email: string; added_by: string; added_at: string }
export const fetchMembers = () => net<{ household: string; members: Member[] }>('/api/vault/members')
export const addMember = (email: string) => net<{ ok: true }>('/api/vault/members', { method: 'POST', body: JSON.stringify({ email }) })
export const removeMember = (email: string) =>
  net<{ ok: true }>(`/api/vault/members/${encodeURIComponent(email)}`, { method: 'DELETE' })

/**
 * Server-side state the front door needs: is there a vault, whose household
 * this identity belongs to, does the server hold any plaintext, and is it a
 * vault-only server (no household escape hatch)?
 */
export type Mode = {
  vault: { version: number; updated_at: string } | null
  household: string | null
  serverHasData: boolean
  zkOnly: boolean
}
export const fetchMode = () => net<Mode>('/api/mode')
