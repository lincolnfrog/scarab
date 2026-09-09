import { describe, expect, it } from 'vitest'
import { b64decode, b64encode, createVault, openVault, openVaultKey, sealVault } from './vault'

const text = (s: string) => new TextEncoder().encode(s)
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b)

describe('vault', () => {
  it('round-trips with the passphrase', async () => {
    const { blob } = await createVault('correct horse battery', text('{"hello":"world"}'))
    expect(utf8(await openVault(blob, { passphrase: 'correct horse battery' }))).toBe('{"hello":"world"}')
  })

  it('round-trips with the recovery key', async () => {
    const { blob, recoveryKeyB64 } = await createVault('correct horse battery', text('ledger'))
    expect(utf8(await openVault(blob, { recoveryKeyB64 }))).toBe('ledger')
  })

  it('rejects a wrong passphrase without leaking anything else', async () => {
    const { blob } = await createVault('correct horse battery', text('secret'))
    await expect(openVault(blob, { passphrase: 'wrong horse' })).rejects.toThrow(/wrong passphrase/)
  })

  it('detects payload tampering (GCM authentication)', async () => {
    const { blob } = await createVault('correct horse battery', text('secret'))
    const ct = b64decode(blob.payload.ct)
    ct[0]! ^= 0xff
    blob.payload.ct = b64encode(ct)
    await expect(openVault(blob, { passphrase: 'correct horse battery' })).rejects.toThrow(/authentication/)
  })

  it('ciphertext reveals nothing recognizable and salts/keys are unique per vault', async () => {
    const a = await createVault('correct horse battery', text('same payload'))
    const b = await createVault('correct horse battery', text('same payload'))
    expect(a.blob.payload.ct).not.toBe(b.blob.payload.ct)
    expect(a.blob.kdf.salt).not.toBe(b.blob.kdf.salt)
    expect(a.recoveryKeyB64).not.toBe(b.recoveryKeyB64)
    expect(a.blob.payload.ct).not.toContain('payload')
  })

  it('reseals under the same key: passphrase and recovery key both still open the new payload', async () => {
    const { blob, recoveryKeyB64 } = await createVault('correct horse battery', text('v1'))
    const { rawDataKey } = await openVaultKey(blob, { passphrase: 'correct horse battery' })
    const next = await sealVault(blob, rawDataKey, text('v2 — edited in a zero-knowledge session'))
    expect(next.kdf).toEqual(blob.kdf)
    expect(next.wrappedKey).toEqual(blob.wrappedKey)
    expect(next.payload.ct).not.toBe(blob.payload.ct)
    expect(next.payload.iv).not.toBe(blob.payload.iv) // fresh nonce every seal
    expect(utf8(await openVault(next, { passphrase: 'correct horse battery' }))).toContain('v2')
    expect(utf8(await openVault(next, { recoveryKeyB64 }))).toContain('v2')
    await expect(sealVault(blob, rawDataKey.slice(0, 16), text('x'))).rejects.toThrow(/32 bytes/)
  })

  it('refuses trivial passphrases and handles multi-megabyte payloads', async () => {
    await expect(createVault('short', text('x'))).rejects.toThrow(/8 characters/)
    const big = new Uint8Array(2_500_000).fill(42)
    const { blob } = await createVault('correct horse battery', big)
    const back = await openVault(blob, { passphrase: 'correct horse battery' })
    expect(back.length).toBe(big.length)
    expect(back[1_234_567]).toBe(42)
  }, 30_000)
})
