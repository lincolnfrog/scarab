/**
 * The Scarab vault: envelope encryption unlocked by passkeys.
 *
 *   passkey ──WebAuthn PRF(salt)──▶ 32 bytes ──HKDF──▶ KEK ──unwraps──▶ data key ──▶ payload
 *
 * A random 256-bit AES-GCM data key encrypts the payload. The data key is
 * wrapped once per passkey, under a key derived from that passkey's PRF
 * output for this vault's salt. Adding a device or a household member is
 * adding a wrapping; the data key never changes for it (v3 reseals the
 * payload under the same key, because the header is authenticated — below).
 * The raw data key, as a typed recovery code (shown at creation, and again
 * only after a fresh passkey check), is the break-glass path: zero-knowledge
 * means there is no reset.
 *
 * Format v3 (written by every save) authenticates the whole header: the
 * payload's AES-GCM additional data is `canonicalHeader(header)` — vault id,
 * RP ID, PRF salt, encoding, sequence number and every wrapping (sorted by
 * credential id, each with its label, date and — when it has one — the
 * identity it belongs to). Relabelling a passkey, adding or dropping a wrapping,
 * swapping the salt or replaying the payload under another sequence number
 * all fail authentication. `seq` is the courier version the blob was sealed
 * for (the expected version + 1), so a device that remembers the last `seq`
 * it saw can tell an older copy from the current one. The plaintext is
 * framed as [u32 length][gzip][zeros] and padded to a size bucket
 * (`padBucket`), so the stored size says roughly how big the vault is, never
 * exactly. Wrappings carry no additional data: each KEK already binds the
 * PRF salt (the PRF input) and its credential id (the HKDF salt).
 *
 * Format v2 (no header authentication, no compression) stays readable; the
 * first save after opening one writes v3.
 *
 * This file is pure crypto and isomorphic (browser and Node ≥20,
 * globalThis.crypto and CompressionStream). WebAuthn itself — the part that
 * talks to the authenticator and produces `prfOutput` — lives in
 * src/passkey.ts.
 */

export type Box = { iv: string; ct: string }

/** One passkey's wrapping of the data key. Nothing here is secret. */
export type PasskeyWrap = {
  credentialId: string // base64url, as WebAuthn reports it
  label: string // "Max's iPhone", "partner@gmail.com" — free text, renamable
  addedAt: string // ISO
  /**
   * The household identity (sign-in email, lowercase) whose passkey this is:
   * the owner or a member. It is how the members panel ties passkeys to
   * people — never the label, which is free text. In v3 it is authenticated
   * with the rest of the header. Absent on wrappings made before passkeys were
   * bound to identities, and never read from a v2 header (unauthenticated).
   */
  identity?: string
  wrappedKey: Box
}

/** A wrapping's identity: an email-shaped sign-in name, lowercase, no spaces. */
export const isWrapIdentity = (s: unknown): s is string =>
  typeof s === 'string' && s.length >= 3 && s.length <= 254 && s === s.toLowerCase() && /^[^\s@]+@[^\s@]+$/.test(s)

/** Format v2: read-only. Its header is not authenticated and its payload is the raw plaintext. */
export type VaultHeaderV2 = {
  v: 2
  /** PRF evaluation input, the same for every passkey on this vault. */
  prfSalt: string // base64, 32 bytes
  keys: PasskeyWrap[]
}

/** Format v3: the header is the payload's additional data, so every field of it is authenticated. */
export type VaultHeaderV3 = {
  v: 3
  /** Random, fixed for the vault's life (rotation keeps it): what this device's rollback memory is keyed by. */
  vaultId: string // base64url, 16 bytes
  /** The WebAuthn RP ID its passkeys were registered under (src/passkey.ts rpIdFor). */
  rpId: string
  prfSalt: string // base64, 32 bytes
  enc: 'gzip+pad'
  /** The courier version this blob was sealed to be stored as (expected version + 1). */
  seq: number
  keys: PasskeyWrap[]
}

export type VaultBlobV2 = VaultHeaderV2 & { payload: Box }
export type VaultBlobV3 = VaultHeaderV3 & { payload: Box }
export type VaultBlob = VaultBlobV2 | VaultBlobV3

/** What a session holds and seals with: a v3 header minus `seq`, which each seal stamps. */
export type VaultHeader = Omit<VaultHeaderV3, 'seq'>

/* ---------- base64 helpers (chunked — payloads are megabytes) ---------- */

export function b64encode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(out)
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const b64urlEncode = (bytes: Uint8Array): string =>
  b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const b64urlDecode = (s: string): Uint8Array =>
  b64decode(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))

/* ---------- key machinery ---------- */

const subtle = () => globalThis.crypto.subtle
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array, aad?: Uint8Array): Promise<Box> {
  const iv = random(12)
  const params: AesGcmParams = { name: 'AES-GCM', iv: iv as BufferSource }
  if (aad) params.additionalData = aad as BufferSource
  const ct = await subtle().encrypt(params, key, plaintext as BufferSource)
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) }
}

async function aesDecrypt(key: CryptoKey, box: Box, aad?: Uint8Array): Promise<Uint8Array> {
  const params: AesGcmParams = { name: 'AES-GCM', iv: b64decode(box.iv) as BufferSource }
  if (aad) params.additionalData = aad as BufferSource
  const pt = await subtle().decrypt(params, key, b64decode(box.ct) as BufferSource)
  return new Uint8Array(pt)
}

const importDataKey = (raw: Uint8Array, usage: KeyUsage[]) =>
  subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, usage)

/**
 * PRF output → KEK. HKDF binds the derived key to this credential and this
 * purpose, so the same PRF bytes can never wrap anything else. (The info
 * string predates v3 and stays: existing wrappings must keep unwrapping.)
 */
async function kekFromPrf(prfOutput: Uint8Array, credentialId: string): Promise<CryptoKey> {
  if (prfOutput.length !== 32) throw new Error('PRF output must be 32 bytes')
  const base = await subtle().importKey('raw', prfOutput as BufferSource, 'HKDF', false, ['deriveKey'])
  return subtle().deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(credentialId),
      info: new TextEncoder().encode('scarab-vault-v2-kek'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/* ---------- header shape ---------- */

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
function malformed(what: string): never {
  throw new Error(`malformed vault: ${what}`)
}

function checkBox(b: unknown, what: string): Box {
  if (!isObj(b) || typeof b.iv !== 'string' || typeof b.ct !== 'string') malformed(what)
  return b as Box
}

function checkSalt(s: unknown): void {
  let ok = false
  try {
    ok = typeof s === 'string' && b64decode(s).length === 32
  } catch {
    ok = false
  }
  if (!ok) malformed('prfSalt must be 32 bytes of base64')
}

/** `v3`: identities are read (and must be well formed); a v2 header's are never read, so never checked. */
function checkKeys(keys: unknown, v3: boolean): PasskeyWrap[] {
  if (!Array.isArray(keys)) malformed('keys must be a list')
  const seen = new Set<string>()
  for (const k of keys as unknown[]) {
    if (!isObj(k) || typeof k.credentialId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(k.credentialId))
      malformed('a wrapping has no valid credentialId')
    const w = k as Record<string, unknown>
    if (typeof w.label !== 'string' || typeof w.addedAt !== 'string') malformed('a wrapping has no label or date')
    if (v3 && w.identity !== undefined && !isWrapIdentity(w.identity)) malformed('a wrapping names an identity that is not a lowercase email')
    checkBox(w.wrappedKey, 'a wrapping has no wrapped key')
    if (seen.has(w.credentialId as string)) malformed('the same passkey is wrapped twice')
    seen.add(w.credentialId as string)
  }
  return keys as PasskeyWrap[]
}

/** Throws unless `h` is a well-formed v3 header (extra fields are ignored — and never authenticated or carried forward). */
function checkHeaderV3(h: unknown): asserts h is VaultHeaderV3 {
  if (!isObj(h) || h.v !== 3) malformed('not a v3 header')
  const x = h as Record<string, unknown>
  if (typeof x.vaultId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(x.vaultId)) malformed('vaultId')
  if (typeof x.rpId !== 'string' || x.rpId.length === 0 || x.rpId.length > 253) malformed('rpId')
  checkSalt(x.prfSalt)
  if (x.enc !== 'gzip+pad') malformed(`unknown payload encoding ${JSON.stringify(x.enc)}`)
  if (!Number.isSafeInteger(x.seq) || (x.seq as number) < 1) malformed('seq must be a positive integer')
  checkKeys(x.keys, true)
}

function checkHeaderV2(h: unknown): asserts h is VaultHeaderV2 {
  if (!isObj(h) || h.v !== 2) malformed('not a v2 header')
  checkSalt(h.prfSalt)
  checkKeys(h.keys, false)
}

/** The formats this code can open. */
export const READABLE_FORMATS = [2, 3] as const

/** The payload didn't authenticate under this key: the wrong key, or the blob (payload or v3 header) was altered. */
export class VaultAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultAuthError'
  }
}

/** A vault written by a newer Scarab than this page (a later format): reloading picks up the code that reads it. */
export class NewerVaultFormatError extends Error {
  constructor(readonly format: number) {
    super(`this vault was written by a newer version of Scarab (format v${format}); this page reads v2 and v3 — reload to update`)
    this.name = 'NewerVaultFormatError'
  }
}

/**
 * The courier's `data` string → a checked blob, v2 or v3. Nothing in it is
 * trusted yet: a v3 header is authenticated only when its payload opens.
 */
export function parseVaultBlob(data: string): VaultBlob {
  let raw: unknown
  try {
    raw = JSON.parse(data)
  } catch {
    malformed('not JSON')
  }
  if (!isObj(raw)) malformed('not an object')
  const r = raw as Record<string, unknown>
  checkBox(r.payload, 'no payload')
  if (r.v === 3) checkHeaderV3(r)
  else if (r.v === 2) checkHeaderV2(r)
  else if (typeof r.v === 'number' && Number.isInteger(r.v) && r.v > 3) throw new NewerVaultFormatError(r.v)
  else throw new Error(`unsupported vault format ${JSON.stringify(r.v)} — only passkey vaults (v2, v3) can be opened`)
  return r as unknown as VaultBlob
}

/**
 * The exact bytes a v3 payload authenticates: the header as canonical JSON —
 * fixed field order, wrappings sorted by credential id (code-unit order, not
 * locale), and only the known fields. A wrapping's `identity` is included
 * only when it has one, so headers from before identities existed keep their
 * exact bytes (and every blob sealed then still opens). Throws on a
 * malformed header.
 */
export function canonicalHeader(h: VaultHeaderV3): Uint8Array {
  checkHeaderV3(h)
  const keys = [...h.keys].sort((a, b) => (a.credentialId < b.credentialId ? -1 : a.credentialId > b.credentialId ? 1 : 0))
  const doc = {
    v: 3,
    vaultId: h.vaultId,
    rpId: h.rpId,
    prfSalt: h.prfSalt,
    enc: h.enc,
    seq: h.seq,
    keys: keys.map((k) => ({
      credentialId: k.credentialId,
      label: k.label,
      addedAt: k.addedAt,
      // Only when present, so a header without identities (every blob sealed before they existed) has the same bytes as before.
      ...(k.identity !== undefined ? { identity: k.identity } : {}),
      wrappedKey: { iv: k.wrappedKey.iv, ct: k.wrappedKey.ct },
    })),
  }
  return new TextEncoder().encode(JSON.stringify(doc))
}

/* ---------- the payload frame: [u32 length][gzip][zeros] ---------- */

/** Smallest padded size; also the first power of two the 1/8 steps start from. */
export const PAD_FLOOR = 32 * 1024
/** Refuse to inflate past this: an authenticated payload can still be a gzip bomb if a key holder made it one. */
export const MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024

/**
 * The padded frame size for `n` bytes: at least 32 KiB, otherwise the next
 * eighth-of-a-power-of-two step at or above n (≤ 12.5% overhead). 10 KB and
 * 11 KB both store as 32 KiB; 2.5 MB stores as 2.5 MiB.
 */
export function padBucket(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('padBucket: size must be a non-negative integer')
  if (n <= PAD_FLOOR) return PAD_FLOOR
  let p = PAD_FLOOR // the largest power of two ≤ n
  while (p * 2 <= n) p *= 2
  const step = p / 8
  return p + Math.ceil((n - p) / step) * step
}

/** Run bytes through a (De)CompressionStream, refusing output past `limit`. */
async function through(ts: TransformStream<Uint8Array, Uint8Array>, input: Uint8Array, limit: number): Promise<Uint8Array> {
  const writer = ts.writable.getWriter()
  const written = writer.write(input).then(() => writer.close())
  written.catch(() => undefined) // a stream error surfaces through the reader below
  const reader = ts.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error(`vault payload inflates past ${limit} bytes — refusing it`)
      chunks.push(value)
    }
  } catch (e) {
    await reader.cancel().catch(() => undefined)
    throw e
  }
  await written
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const gzip = (bytes: Uint8Array) =>
  through(new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>, bytes, Number.MAX_SAFE_INTEGER)

/** Plaintext → the padded frame that gets encrypted. */
export async function packFrame(plaintext: Uint8Array): Promise<Uint8Array> {
  const gz = await gzip(plaintext)
  if (gz.length > 0xffffffff) throw new Error('vault payload too large to frame')
  const frame = new Uint8Array(padBucket(4 + gz.length)) // zero-filled
  new DataView(frame.buffer).setUint32(0, gz.length) // big-endian
  frame.set(gz, 4)
  return frame
}

/** The decrypted frame → plaintext. Strict: the length must fit, the padding must be zeros, the gzip must be whole. */
export async function unpackFrame(frame: Uint8Array, maxBytes = MAX_PLAINTEXT_BYTES): Promise<Uint8Array> {
  if (frame.length < 4) malformed('payload frame too short')
  const len = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0)
  if (4 + len > frame.length) malformed('payload frame length runs past its end')
  for (let i = 4 + len; i < frame.length; i++) if (frame[i] !== 0) malformed('payload padding is not zeros')
  try {
    return await through(
      new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
      frame.subarray(4, 4 + len),
      maxBytes,
    )
  } catch (e) {
    if (e instanceof Error && /inflates past/.test(e.message)) throw e
    return malformed('payload is not valid gzip')
  }
}

/* ---------- the vault API ---------- */

const newVaultId = () => b64urlEncode(random(16))

/** A brand-new vault: fresh data key, fresh PRF salt, fresh vault id, no passkeys yet. */
export function newVault(rpId: string): { rawDataKey: Uint8Array; header: VaultHeader } {
  if (!rpId) throw new Error('a vault needs the RP ID its passkeys will belong to')
  return {
    rawDataKey: random(32),
    header: { v: 3, vaultId: newVaultId(), rpId, prfSalt: b64encode(random(32)), enc: 'gzip+pad', keys: [] },
  }
}

/**
 * Wrap the data key under a passkey's PRF output. Append the result to
 * `header.keys` (then reseal). `identity` is whose passkey it is (trimmed and
 * lowercased; left off when unknown).
 */
export async function wrapForPasskey(
  rawDataKey: Uint8Array,
  prfOutput: Uint8Array,
  meta: { credentialId: string; label: string; identity?: string | null },
): Promise<PasskeyWrap> {
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  const identity = meta.identity?.trim().toLowerCase() || undefined
  if (identity !== undefined && !isWrapIdentity(identity)) throw new Error(`not a sign-in identity: ${JSON.stringify(meta.identity)}`)
  const kek = await kekFromPrf(prfOutput, meta.credentialId)
  return {
    credentialId: meta.credentialId,
    label: meta.label,
    addedAt: new Date().toISOString(),
    ...(identity !== undefined ? { identity } : {}),
    wrappedKey: await aesEncrypt(kek, rawDataKey),
  }
}

/** Recover the data key from a passkey's PRF output. Throws if it isn't the right passkey. */
export async function unwrapWithPasskey(
  header: { keys: PasskeyWrap[] },
  credentialId: string,
  prfOutput: Uint8Array,
): Promise<Uint8Array> {
  const wrap = header.keys.find((k) => k.credentialId === credentialId)
  if (!wrap) throw new Error('this passkey is not registered on the vault')
  const kek = await kekFromPrf(prfOutput, credentialId)
  try {
    return await aesDecrypt(kek, wrap.wrappedKey)
  } catch {
    throw new Error('passkey did not unlock the vault (wrong credential or a tampered header)')
  }
}

/**
 * Decrypt the payload with the raw data key — the last step of every unlock,
 * passkey or recovery code. For v3 this also authenticates the header
 * (`seq`, labels, wrappings …): the caller may trust them only after this
 * resolves.
 */
export async function openPayload(blob: VaultBlob, rawDataKey: Uint8Array): Promise<Uint8Array> {
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  const v = (blob as { v: unknown }).v
  if (v === 2) {
    try {
      return await aesDecrypt(await importDataKey(rawDataKey, ['decrypt']), blob.payload)
    } catch {
      throw new VaultAuthError('vault payload failed authentication — wrong key or tampered data')
    }
  }
  if (v !== 3) throw new Error(`unsupported vault version ${String(v)}`)
  const aad = canonicalHeader(blob as VaultBlobV3)
  let frame: Uint8Array
  try {
    frame = await aesDecrypt(await importDataKey(rawDataKey, ['decrypt']), checkBox(blob.payload, 'no payload'), aad)
  } catch {
    throw new VaultAuthError('vault payload failed authentication — wrong key, or the data or its header was tampered with')
  }
  return unpackFrame(frame)
}

/**
 * Seal a payload as format v3, to be stored as courier version `seq` (the
 * version the upload expects + 1). Every save does this; every registered
 * passkey and the recovery code keep working because the key never changes
 * (fresh GCM nonce each time).
 */
export async function sealVault(header: VaultHeader, rawDataKey: Uint8Array, plaintext: Uint8Array, seq: number): Promise<VaultBlobV3> {
  if ((header as { v: unknown }).v !== 3) throw new Error('only format v3 is written — open a v2 vault through sessionHeader() first')
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  const h: VaultHeaderV3 = {
    v: 3,
    vaultId: header.vaultId,
    rpId: header.rpId,
    prfSalt: header.prfSalt,
    enc: 'gzip+pad',
    seq,
    keys: header.keys.map((k) => copyWrap(k, true)),
  }
  const aad = canonicalHeader(h) // validates every field, seq included
  const key = await importDataKey(rawDataKey, ['encrypt'])
  return { ...h, payload: await aesEncrypt(key, await packFrame(plaintext), aad) }
}

/** A wrapping's known fields. `identity` only from an authenticated (v3) header — a v2 header can't vouch for one. */
const copyWrap = (k: PasskeyWrap, withIdentity: boolean): PasskeyWrap => ({
  credentialId: k.credentialId,
  label: k.label,
  addedAt: k.addedAt,
  ...(withIdentity && k.identity !== undefined ? { identity: k.identity } : {}),
  wrappedKey: { iv: k.wrappedKey.iv, ct: k.wrappedKey.ct },
})

/**
 * The header a session keeps after opening `blob`: its v3 header without
 * `seq` (known fields only). A v2 vault is upgraded here — a fresh vault id,
 * `upgradeRpId` as the RP ID — and its next save writes v3. Its wrappings
 * carry over unchanged: a KEK depends only on the PRF secret and the
 * credential id.
 */
export function sessionHeader(blob: VaultBlob, upgradeRpId: string): VaultHeader {
  if (blob.v === 3)
    return { v: 3, vaultId: blob.vaultId, rpId: blob.rpId, prfSalt: blob.prfSalt, enc: blob.enc, keys: blob.keys.map((k) => copyWrap(k, true)) }
  // v2's header was never authenticated: nothing but the fields v2 had carries into the v3 that authenticates it.
  return { v: 3, vaultId: newVaultId(), rpId: upgradeRpId, prfSalt: blob.prfSalt, enc: 'gzip+pad', keys: blob.keys.map((k) => copyWrap(k, false)) }
}

/* ---------- this device's memory of the vault (rollback detection) ---------- */

/**
 * The last v3 state of a vault this device opened or saved (src/session.ts
 * keeps it in localStorage as `scarab:seen:<vaultId>`). `sha256` is of the
 * courier's `data` string, computed on this device; `creds` are the
 * credential ids the header listed, which is how an older-format copy of the
 * same vault is recognised. `prfSalt` is the header's (minted with its key,
 * so it names the key without revealing it): whether the vault was re-keyed
 * since a copy was made. Absent on records written before it was kept.
 */
export type SeenRecord = { seq: number; sha256: string; at: string; creds: string[]; prfSalt?: string }

export function isSeenRecord(x: unknown): x is SeenRecord {
  return (
    isObj(x) &&
    Number.isSafeInteger(x.seq) &&
    typeof x.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(x.sha256) &&
    typeof x.at === 'string' &&
    Array.isArray(x.creds) &&
    x.creds.every((c) => typeof c === 'string') &&
    (x.prfSalt === undefined || typeof x.prfSalt === 'string')
  )
}

/**
 * What to make of a served vault, given what this device last saw of it:
 *
 *   ok        — nothing older than known. `restored` when the blob was sealed
 *               for another version than the one it is served as (an earlier
 *               copy put back): worth a notice, not a stop.
 *   rollback  — sealed for an earlier seq than this device already saw.
 *   fork      — the seq this device saw, but different ciphertext: the
 *               history diverged (typically a server restored from backup
 *               that others have saved over since).
 *   downgrade — a v2 copy of a vault this device knows in v3, which v2
 *               predates.
 *
 * Only an authenticated header may be judged: call this after openPayload.
 */
export type ServedVerdict =
  | { kind: 'ok'; restored: boolean }
  | { kind: 'rollback' | 'fork' | 'downgrade'; seen: SeenRecord }

export function judgeServed(
  served: { header: VaultHeaderV2 | VaultHeaderV3; version: number; sha256: string },
  seen: SeenRecord | null,
): ServedVerdict {
  const h = served.header
  if (h.v === 2) return seen ? { kind: 'downgrade', seen } : { kind: 'ok', restored: false }
  if (seen && h.seq < seen.seq) return { kind: 'rollback', seen }
  if (seen && h.seq === seen.seq && served.sha256 !== seen.sha256) return { kind: 'fork', seen }
  return { kind: 'ok', restored: h.seq !== served.version }
}

/* ---------- the recovery code ---------- */

// Crockford base32 minus nothing: no vowel confusion matters because the
// decoder folds case and the I/L/O ambiguities. 32 bytes → 52 characters,
// then a 2-character check group — 10 bits of SHA-256(key) — so 54 in all,
// shown as 13 groups of four and the check group. Typed, not scanned:
// break-glass only. A code from before the check group (52 characters)
// still opens its vault; it just can't tell a typo from a wrong code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const FOLD: Record<string, string> = { O: '0', I: '1', L: '1' }
const KEY_CHARS = 52
const CHECK_CHARS = 2

/** Why a typed code was refused before it was ever tried against the vault. */
export type RecoveryCodeProblem = 'length' | 'character' | 'typo'
export class RecoveryCodeError extends Error {
  constructor(
    readonly problem: RecoveryCodeProblem,
    message: string,
  ) {
    super(message)
    this.name = 'RecoveryCodeError'
  }
}

/** The check group of a key: the first 10 bits of its SHA-256, as two characters. */
async function checkGroup(rawDataKey: Uint8Array): Promise<string> {
  const h = new Uint8Array(await subtle().digest('SHA-256', rawDataKey as BufferSource))
  const bits = (h[0]! << 2) | (h[1]! >> 6)
  return ALPHABET[bits >> 5]! + ALPHABET[bits & 31]!
}

export async function encodeRecoveryCode(rawDataKey: Uint8Array): Promise<string> {
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  let bits = 0
  let acc = 0
  let out = ''
  for (const byte of rawDataKey) {
    acc = (acc << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31]
      bits -= 5
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31]
  out += await checkGroup(rawDataKey)
  return out.match(/.{1,4}/g)!.join('-')
}

/**
 * A typed code → the key, and whether a check group vouched for the typing
 * (`checked`: false for an older 52-character code). Throws
 * RecoveryCodeError for a wrong length, a character outside the alphabet, or
 * a check group that doesn't match — a typo, reported as one.
 */
export async function parseRecoveryCode(code: string): Promise<{ key: Uint8Array; checked: boolean }> {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[OIL]/g, (c) => FOLD[c]!)
  if (clean.length !== KEY_CHARS + CHECK_CHARS && clean.length !== KEY_CHARS)
    throw new RecoveryCodeError(
      'length',
      `a recovery code has 54 characters — 13 groups of 4 and one of 2 (older codes: 52) — and this has ${clean.length}`,
    )
  const bad = [...clean].find((ch) => !ALPHABET.includes(ch))
  if (bad) throw new RecoveryCodeError('character', `recovery code contains an invalid character: ${bad}`)
  const key = new Uint8Array(32)
  let bits = 0
  let acc = 0
  let i = 0
  for (const ch of clean.slice(0, KEY_CHARS)) {
    acc = (acc << 5) | ALPHABET.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      key[i++] = (acc >>> (bits - 8)) & 0xff
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  if (clean.length === KEY_CHARS) return { key, checked: false }
  if (clean.slice(KEY_CHARS) !== (await checkGroup(key)))
    throw new RecoveryCodeError('typo', 'that recovery code has a typo — its last group doesn’t match the rest; check each group against your copy')
  return { key, checked: true }
}

/** The key a typed recovery code stands for (see parseRecoveryCode for what is refused). */
export async function decodeRecoveryCode(code: string): Promise<Uint8Array> {
  return (await parseRecoveryCode(code)).key
}

/** Two keys are the same bytes, compared without an early exit. */
export function sameKey(a: Uint8Array, b: Uint8Array): boolean {
  let d = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return d === 0
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await subtle().digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
