import type { Dump } from '../engine/snapshot'
import { b64decode, createVault, openVaultKey, sealVault, type VaultBlob, type VaultSecret } from '../shared/vault'
import { enterLocalMode, loadLocalDump, localDump, localMode } from './local'

/**
 * The zero-knowledge session, end to end:
 *
 *   unlock  — fetch ciphertext → decrypt in this tab → boot the in-tab engine
 *             on it. The server never receives plaintext; nothing reloads.
 *   save    — dump the in-tab database → reseal under the key kept from
 *             unlock (or create a vault under a passphrase) → upload
 *             ciphertext. This is the only way local work persists.
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

/** Decrypt the stored vault in this tab and run on it. Replaces the tab's data if local mode is already on. */
export async function unlockVault(secret: VaultSecret): Promise<{ version: number }> {
  const info = await fetchVaultInfo()
  if (!info) throw new Error('no vault stored yet')
  const blob = JSON.parse(info.data) as VaultBlob
  const { plaintext, rawDataKey } = await openVaultKey(blob, secret)
  const dump = JSON.parse(new TextDecoder().decode(plaintext)) as Dump
  const session = { rawDataKey, header: { v: blob.v, kdf: blob.kdf, wrappedKey: blob.wrappedKey }, version: info.version }
  if (localMode.active) {
    await loadLocalDump(dump)
    localMode.setVault(session)
    localMode.markSaved(info.version)
  } else {
    await enterLocalMode(dump, session)
  }
  return { version: info.version }
}

/** Boot an empty in-tab database: a session that starts with no plaintext anywhere. */
export async function startEmpty(): Promise<void> {
  await enterLocalMode(null, null)
}

export type SaveResult = { version: number; sha256: string; bytes: number; recoveryKeyB64: string | null }

/**
 * Persist the in-tab database to the vault. With a session key from unlock
 * the payload is resealed under it (no passphrase, no new recovery key);
 * otherwise a passphrase creates a new vault and returns its recovery key
 * for the caller to hand to the person. `rotate` forces the latter.
 */
export async function saveVault(opts: { passphrase?: string; rotate?: boolean } = {}): Promise<SaveResult> {
  if (!localMode.active) throw new Error('not in a zero-knowledge session')
  const dump = await localDump()
  const plaintext = new TextEncoder().encode(JSON.stringify(dump))
  const session = localMode.vault
  let blob: VaultBlob
  let recoveryKeyB64: string | null = null
  let rawDataKey: Uint8Array
  if (session && !opts.rotate) {
    blob = await sealVault(session.header, session.rawDataKey, plaintext)
    rawDataKey = session.rawDataKey
  } else {
    if (!opts.passphrase) throw new Error('a passphrase is needed to create the vault')
    const made = await createVault(opts.passphrase, plaintext)
    blob = made.blob
    recoveryKeyB64 = made.recoveryKeyB64
    rawDataKey = b64decode(made.recoveryKeyB64)
  }
  // Version check: the server refuses stale writes, so a second device can't
  // silently clobber this one. Base it on what this session last saw.
  const version = session?.version ?? (await fetchVaultInfo())?.version ?? 0
  const r = await net<{ ok: true; version: number; sha256: string }>('/api/vault', {
    method: 'PUT',
    body: JSON.stringify({ data: JSON.stringify(blob), version }),
  })
  localMode.setVault({ rawDataKey, header: { v: blob.v, kdf: blob.kdf, wrappedKey: blob.wrappedKey }, version: r.version })
  localMode.markSaved(r.version)
  return { version: r.version, sha256: r.sha256, bytes: plaintext.length, recoveryKeyB64 }
}

/**
 * Server-side state the front door needs: is there a vault, does the server
 * hold any plaintext, and is it a vault-only server (no household escape hatch)?
 */
export type Mode = { vault: { version: number; updated_at: string } | null; serverHasData: boolean; zkOnly: boolean }
export const fetchMode = () => net<Mode>('/api/mode')
