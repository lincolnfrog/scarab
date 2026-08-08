/**
 * The Scarab vault: envelope encryption, entirely client-side.
 *
 *   passphrase ──PBKDF2-SHA256 (600k)──▶ KEK ──unwraps──▶ data key ──▶ payload
 *
 * A random 256-bit AES-GCM data key encrypts the payload; the data key is
 * wrapped by a key derived from the passphrase. Only ciphertext and the KDF
 * parameters ever leave the device. The raw data key doubles as the recovery
 * key — zero-knowledge means there is no reset, so the recovery kit matters.
 *
 * Format is versioned: v1 = PBKDF2 (WebCrypto-native, Bitwarden-default
 * iteration count). Argon2id or WebAuthn-PRF wrapping can ship as v2 without
 * breaking old blobs. Isomorphic: browser and Node ≥20 (globalThis.crypto).
 */

export type VaultBlob = {
  v: 1
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  wrappedKey: { iv: string; ct: string }
  payload: { iv: string; ct: string }
}

const ITERATIONS = 600_000

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

/* ---------- key machinery ---------- */

const subtle = () => globalThis.crypto.subtle

async function deriveKek(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ])
  return subtle().deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function aesEncrypt(key: CryptoKey, plaintext: Uint8Array): Promise<{ iv: string; ct: string }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, plaintext as BufferSource)
  return { iv: b64encode(iv), ct: b64encode(new Uint8Array(ct)) }
}

async function aesDecrypt(key: CryptoKey, box: { iv: string; ct: string }): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: b64decode(box.iv) as BufferSource },
    key,
    b64decode(box.ct) as BufferSource,
  )
  return new Uint8Array(pt)
}

/* ---------- the vault API ---------- */

/** Encrypt a payload under a passphrase. Returns the blob and the recovery key. */
export async function createVault(
  passphrase: string,
  plaintext: Uint8Array,
): Promise<{ blob: VaultBlob; recoveryKeyB64: string }> {
  if (passphrase.length < 8) throw new Error('passphrase must be at least 8 characters')
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const kek = await deriveKek(passphrase, salt, ITERATIONS)
  const dataKey = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const rawDataKey = new Uint8Array(await subtle().exportKey('raw', dataKey))
  const blob: VaultBlob = {
    v: 1,
    kdf: { name: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64encode(salt) },
    wrappedKey: await aesEncrypt(kek, rawDataKey),
    payload: await aesEncrypt(dataKey, plaintext),
  }
  return { blob, recoveryKeyB64: b64encode(rawDataKey) }
}

/** Decrypt with either the passphrase or the recovery key. Throws on tamper/wrong secret. */
export async function openVault(
  blob: VaultBlob,
  secret: { passphrase: string } | { recoveryKeyB64: string },
): Promise<Uint8Array> {
  if (blob.v !== 1) throw new Error(`unsupported vault version ${blob.v}`)
  let rawDataKey: Uint8Array
  if ('recoveryKeyB64' in secret) {
    rawDataKey = b64decode(secret.recoveryKeyB64)
  } else {
    const kek = await deriveKek(secret.passphrase, b64decode(blob.kdf.salt), blob.kdf.iterations)
    try {
      rawDataKey = await aesDecrypt(kek, blob.wrappedKey)
    } catch {
      throw new Error('wrong passphrase (or the vault header was tampered with)')
    }
  }
  const dataKey = await subtle().importKey('raw', rawDataKey as BufferSource, 'AES-GCM', false, ['decrypt'])
  try {
    return await aesDecrypt(dataKey, blob.payload)
  } catch {
    throw new Error('vault payload failed authentication — wrong key or tampered data')
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const h = await subtle().digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
