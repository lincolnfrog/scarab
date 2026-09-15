import { describe, expect, it } from 'vitest'
import {
  b64decode,
  b64encode,
  b64urlDecode,
  b64urlEncode,
  decodeRecoveryCode,
  encodeRecoveryCode,
  headerOf,
  newVault,
  openPayload,
  sealVault,
  unwrapWithPasskey,
  wrapForPasskey,
} from './vault'

const text = (s: string) => new TextEncoder().encode(s)
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b)
const prf = (seed: number) => new Uint8Array(32).map((_, i) => (seed * 31 + i * 7) & 0xff) // a stand-in for WebAuthn PRF output
const cred = (n: number) => b64urlEncode(new Uint8Array(16).fill(n))

/** What src/session.ts does end to end, minus the authenticator. */
async function makeVault(payload: string, passkeys: { id: string; prf: Uint8Array; label: string }[]) {
  const { rawDataKey, header } = newVault()
  for (const p of passkeys) header.keys.push(await wrapForPasskey(rawDataKey, p.prf, { credentialId: p.id, label: p.label }))
  return { rawDataKey, blob: await sealVault(header, rawDataKey, text(payload)) }
}

describe('vault v2', () => {
  it('unlocks with a registered passkey', async () => {
    const { blob } = await makeVault('{"hello":"world"}', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const key = await unwrapWithPasskey(headerOf(blob), cred(1), prf(1))
    expect(utf8(await openPayload(blob, key))).toBe('{"hello":"world"}')
  })

  it('every passkey on the vault opens the same payload; a stranger does not', async () => {
    const { blob } = await makeVault('ledger', [
      { id: cred(1), prf: prf(1), label: 'Mac' },
      { id: cred(2), prf: prf(2), label: 'partner phone' },
    ])
    for (const n of [1, 2]) expect(utf8(await openPayload(blob, await unwrapWithPasskey(blob, cred(n), prf(n))))).toBe('ledger')
    await expect(unwrapWithPasskey(blob, cred(3), prf(3))).rejects.toThrow(/not registered/)
    await expect(unwrapWithPasskey(blob, cred(1), prf(2))).rejects.toThrow(/did not unlock/)
  })

  it('unlocks with the recovery code, which survives typing quirks', async () => {
    const { rawDataKey, blob } = await makeVault('ledger', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const code = encodeRecoveryCode(rawDataKey)
    expect(code).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/)
    expect(decodeRecoveryCode(code)).toEqual(rawDataKey)
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(decodeRecoveryCode(sloppy)).toEqual(rawDataKey)
    expect(utf8(await openPayload(blob, decodeRecoveryCode(code)))).toBe('ledger')
    expect(() => decodeRecoveryCode(code.slice(0, 20))).toThrow(/52 characters/)
    expect(() => decodeRecoveryCode(code.replace(/[0-9A-Z]/, 'U'))).toThrow(/invalid character/)
  })

  it('recovery codes round-trip every byte value', () => {
    for (const fill of [0x00, 0xff, 0x55, 0xaa]) {
      const k = new Uint8Array(32).fill(fill)
      expect(decodeRecoveryCode(encodeRecoveryCode(k))).toEqual(k)
    }
    const rnd = globalThis.crypto.getRandomValues(new Uint8Array(32))
    expect(decodeRecoveryCode(encodeRecoveryCode(rnd))).toEqual(rnd)
  })

  it('detects payload and header tampering (GCM authentication)', async () => {
    const { blob } = await makeVault('secret', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const ct = b64decode(blob.payload.ct)
    ct[0]! ^= 0xff
    const tamperedPayload = { ...blob, payload: { ...blob.payload, ct: b64encode(ct) } }
    const key = await unwrapWithPasskey(blob, cred(1), prf(1))
    await expect(openPayload(tamperedPayload, key)).rejects.toThrow(/authentication/)
    const wk = b64decode(blob.keys[0]!.wrappedKey.ct)
    wk[3]! ^= 0x01
    const tamperedHeader = { ...blob, keys: [{ ...blob.keys[0]!, wrappedKey: { ...blob.keys[0]!.wrappedKey, ct: b64encode(wk) } }] }
    await expect(unwrapWithPasskey(tamperedHeader, cred(1), prf(1))).rejects.toThrow(/did not unlock/)
  })

  it('a wrapping is bound to its credential id', async () => {
    // Same PRF bytes under a different id must not unwrap: HKDF salts on the id.
    const { blob } = await makeVault('secret', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const moved = { ...blob, keys: [{ ...blob.keys[0]!, credentialId: cred(9) }] }
    await expect(unwrapWithPasskey(moved, cred(9), prf(1))).rejects.toThrow(/did not unlock/)
  })

  it('reseals under the same key: adding a passkey later never re-encrypts', async () => {
    const { rawDataKey, blob } = await makeVault('v1', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const header = headerOf(blob)
    header.keys.push(await wrapForPasskey(rawDataKey, prf(2), { credentialId: cred(2), label: 'partner' }))
    const next = await sealVault(header, rawDataKey, text('v2 — edited in a zero-knowledge session'))
    expect(next.prfSalt).toBe(blob.prfSalt)
    expect(next.keys[0]).toEqual(blob.keys[0])
    expect(next.payload.ct).not.toBe(blob.payload.ct)
    expect(next.payload.iv).not.toBe(blob.payload.iv) // fresh nonce every seal
    for (const n of [1, 2]) expect(utf8(await openPayload(next, await unwrapWithPasskey(next, cred(n), prf(n))))).toContain('v2')
    expect(utf8(await openPayload(next, rawDataKey))).toContain('v2')
    await expect(sealVault(header, rawDataKey.slice(0, 16), text('x'))).rejects.toThrow(/32 bytes/)
    await expect(wrapForPasskey(rawDataKey, prf(1).slice(0, 8), { credentialId: cred(1), label: 'x' })).rejects.toThrow(/PRF output/)
  })

  it('salts, keys and ciphertext are unique per vault; nothing recognizable leaks', async () => {
    const a = await makeVault('same payload', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const b = await makeVault('same payload', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    expect(a.blob.payload.ct).not.toBe(b.blob.payload.ct)
    expect(a.blob.prfSalt).not.toBe(b.blob.prfSalt)
    expect(a.rawDataKey).not.toEqual(b.rawDataKey)
    expect(a.blob.keys[0]!.wrappedKey.ct).not.toBe(b.blob.keys[0]!.wrappedKey.ct)
    expect(a.blob.payload.ct).not.toContain('payload')
    expect(JSON.stringify(headerOf(a.blob))).not.toContain(b64encode(a.rawDataKey))
  })

  it('rejects other versions and handles multi-megabyte payloads', async () => {
    const { rawDataKey, blob } = await makeVault('x', [])
    await expect(openPayload({ ...blob, v: 1 as never }, rawDataKey)).rejects.toThrow(/unsupported vault version 1/)
    const big = new Uint8Array(2_500_000).fill(42)
    const sealed = await sealVault(headerOf(blob), rawDataKey, big)
    const back = await openPayload(sealed, rawDataKey)
    expect(back.length).toBe(big.length)
    expect(back[1_234_567]).toBe(42)
  }, 30_000)

  it('base64url matches WebAuthn credential ids', () => {
    const id = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01])
    expect(b64urlEncode(id)).toBe('-_-_AAE')
    expect(b64urlDecode('-_-_AAE')).toEqual(id)
  })
})
