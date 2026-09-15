/**
 * The Scarab vault, v2: envelope encryption unlocked by passkeys.
 *
 *   passkey ──WebAuthn PRF(salt)──▶ 32 bytes ──HKDF──▶ KEK ──unwraps──▶ data key ──▶ payload
 *
 * A random 256-bit AES-GCM data key encrypts the payload. The data key is
 * wrapped once per passkey, under a key derived from that passkey's PRF
 * output for this vault's salt. Adding a device or a household member is
 * adding a wrapping; nothing is ever re-encrypted. The raw data key, shown
 * once as a typed recovery code, is the break-glass path: zero-knowledge
 * means there is no reset.
 *
 * This file is pure crypto and isomorphic (browser and Node ≥20,
 * globalThis.crypto). WebAuthn itself — the part that talks to the
 * authenticator and produces `prfOutput` — lives in src/passkey.ts.
 */

export type Box = { iv: string; ct: string }

/** One passkey's wrapping of the data key. Nothing here is secret. */
export type PasskeyWrap = {
  credentialId: string // base64url, as WebAuthn reports it
  label: string // "Max's iPhone", "partner@gmail.com" — for the members list
  addedAt: string // ISO
  wrappedKey: Box
}

export type VaultHeader = {
  v: 2
  /** PRF evaluation input, the same for every passkey on this vault. */
  prfSalt: string // base64, 32 bytes
  keys: PasskeyWrap[]
}

export type VaultBlob = VaultHeader & { payload: Box }

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

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<Box> {
  const iv = random(12)
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource)
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) }
}

async function aesDecrypt(key: CryptoKey, box: Box): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64decode(box.iv) as BufferSource },
    key,
    b64decode(box.ct) as BufferSource,
  )
  return new Uint8Array(pt)
}

const importDataKey = (raw: Uint8Array, usage: KeyUsage[]) =>
  subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, usage)

/**
 * PRF output → KEK. HKDF binds the derived key to this credential and this
 * purpose, so the same PRF bytes can never wrap anything else.
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

/* ---------- the vault API ---------- */

/** A brand-new vault: fresh data key, fresh PRF salt, no passkeys yet. */
export function newVault(): { rawDataKey: Uint8Array; header: VaultHeader } {
  return { rawDataKey: random(32), header: { v: 2, prfSalt: b64encode(random(32)), keys: [] } }
}

/** Wrap the data key under a passkey's PRF output. Append the result to `header.keys`. */
export async function wrapForPasskey(
  rawDataKey: Uint8Array,
  prfOutput: Uint8Array,
  meta: { credentialId: string; label: string },
): Promise<PasskeyWrap> {
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  const kek = await kekFromPrf(prfOutput, meta.credentialId)
  return {
    credentialId: meta.credentialId,
    label: meta.label,
    addedAt: new Date().toISOString(),
    wrappedKey: await aesEncrypt(kek, rawDataKey),
  }
}

/** Recover the data key from a passkey's PRF output. Throws if it isn't the right passkey. */
export async function unwrapWithPasskey(header: VaultHeader, credentialId: string, prfOutput: Uint8Array): Promise<Uint8Array> {
  const wrap = header.keys.find((k) => k.credentialId === credentialId)
  if (!wrap) throw new Error('this passkey is not registered on the vault')
  const kek = await kekFromPrf(prfOutput, credentialId)
  try {
    return await aesDecrypt(kek, wrap.wrappedKey)
  } catch {
    throw new Error('passkey did not unlock the vault (wrong credential or a tampered header)')
  }
}

/** Decrypt the payload with the raw data key — the last step of every unlock, passkey or recovery code. */
export async function openPayload(blob: VaultBlob, rawDataKey: Uint8Array): Promise<Uint8Array> {
  if (blob.v !== 2) throw new Error(`unsupported vault version ${(blob as { v: unknown }).v}`)
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  try {
    return await aesDecrypt(await importDataKey(rawDataKey, ['decrypt']), blob.payload)
  } catch {
    throw new Error('vault payload failed authentication — wrong key or tampered data')
  }
}

/**
 * Seal a payload under the data key with the given header. Every save does
 * this; every registered passkey and the recovery code keep working because
 * the key never changes (fresh GCM nonce each time).
 */
export async function sealVault(header: VaultHeader, rawDataKey: Uint8Array, plaintext: Uint8Array): Promise<VaultBlob> {
  if (header.v !== 2) throw new Error(`unsupported vault version ${(header as { v: unknown }).v}`)
  if (rawDataKey.length !== 32) throw new Error('data key must be 32 bytes')
  const key = await importDataKey(rawDataKey, ['encrypt'])
  return { v: 2, prfSalt: header.prfSalt, keys: header.keys, payload: await aesEncrypt(key, plaintext) }
}

export const headerOf = (blob: VaultBlob): VaultHeader => ({ v: blob.v, prfSalt: blob.prfSalt, keys: blob.keys })

/* ---------- the recovery code ---------- */

// Crockford base32 minus nothing: no vowel confusion matters because the
// decoder folds case and the I/L/O ambiguities. 32 bytes → 52 characters,
// shown in groups of four. Typed, not scanned: break-glass only.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const FOLD: Record<string, string> = { O: '0', I: '1', L: '1' }

export function encodeRecoveryCode(rawDataKey: Uint8Array): string {
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
  return out.match(/.{1,4}/g)!.join('-')
}

export function decodeRecoveryCode(code: string): Uint8Array {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/[OIL]/g, (c) => FOLD[c]!)
  if (clean.length !== 52) throw new Error('a recovery code has 52 characters (13 groups of 4)')
  const out = new Uint8Array(32)
  let bits = 0
  let acc = 0
  let i = 0
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) throw new Error(`recovery code contains an invalid character: ${ch}`)
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      out[i++] = (acc >>> (bits - 8)) & 0xff
      bits -= 8
    }
    acc &= (1 << bits) - 1
  }
  return out
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await subtle().digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
