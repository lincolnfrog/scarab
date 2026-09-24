import { describe, expect, it } from 'vitest'
import {
  b64decode,
  b64encode,
  b64urlDecode,
  b64urlEncode,
  canonicalHeader,
  decodeRecoveryCode,
  encodeRecoveryCode,
  isSeenRecord,
  judgeServed,
  MAX_PLAINTEXT_BYTES,
  newVault,
  NewerVaultFormatError,
  openPayload,
  packFrame,
  padBucket,
  PAD_FLOOR,
  parseRecoveryCode,
  parseVaultBlob,
  RecoveryCodeError,
  sameKey,
  sealVault,
  sessionHeader,
  sha256Hex,
  unpackFrame,
  unwrapWithPasskey,
  VaultAuthError,
  wrapForPasskey,
  type SeenRecord,
  type VaultBlob,
  type VaultBlobV2,
  type VaultBlobV3,
  type VaultHeader,
} from './vault'

const text = (s: string) => new TextEncoder().encode(s)
const utf8 = (b: Uint8Array) => new TextDecoder().decode(b)
const prf = (seed: number) => new Uint8Array(32).map((_, i) => (seed * 31 + i * 7) & 0xff) // a stand-in for WebAuthn PRF output
const cred = (n: number) => b64urlEncode(new Uint8Array(16).fill(n))
const RP = 'scarab.one'

/** What src/session.ts does end to end, minus the authenticator. */
async function makeVault(payload: string | Uint8Array, passkeys: { id: string; prf: Uint8Array; label: string }[], seq = 1) {
  const { rawDataKey, header } = newVault(RP)
  for (const p of passkeys) header.keys.push(await wrapForPasskey(rawDataKey, p.prf, { credentialId: p.id, label: p.label }))
  const blob = await sealVault(header, rawDataKey, typeof payload === 'string' ? text(payload) : payload, seq)
  return { rawDataKey, header, blob }
}

/** A blob as the courier would hand it back: through JSON, then mutated. */
const through = <T>(b: T): T => JSON.parse(JSON.stringify(b)) as T
const opens = async (blob: VaultBlob, key: Uint8Array) => utf8(await openPayload(through(blob), key))
const AUTH = /failed authentication/

describe('vault v3', () => {
  it('unlocks with a registered passkey', async () => {
    const { blob } = await makeVault('{"hello":"world"}', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    expect(blob).toMatchObject({ v: 3, rpId: RP, enc: 'gzip+pad', seq: 1 })
    expect(blob.vaultId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    const key = await unwrapWithPasskey(blob, cred(1), prf(1))
    expect(await opens(blob, key)).toBe('{"hello":"world"}')
  })

  it('every passkey on the vault opens the same payload; a stranger does not', async () => {
    const { blob } = await makeVault('ledger', [
      { id: cred(1), prf: prf(1), label: 'Mac' },
      { id: cred(2), prf: prf(2), label: 'partner phone' },
    ])
    for (const n of [1, 2]) expect(await opens(blob, await unwrapWithPasskey(blob, cred(n), prf(n)))).toBe('ledger')
    await expect(unwrapWithPasskey(blob, cred(3), prf(3))).rejects.toThrow(/not registered/)
    await expect(unwrapWithPasskey(blob, cred(1), prf(2))).rejects.toThrow(/did not unlock/)
  })

  it('unlocks with the recovery code, which survives typing quirks', async () => {
    const { rawDataKey, blob } = await makeVault('ledger', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const code = await encodeRecoveryCode(rawDataKey)
    expect(code).toMatch(/^([0-9A-Z]{4}-){13}[0-9A-Z]{2}$/) // 52 key characters, then the 2-character check group
    expect(await decodeRecoveryCode(code)).toEqual(rawDataKey)
    const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')
    expect(await parseRecoveryCode(sloppy)).toEqual({ key: rawDataKey, checked: true })
    expect(await opens(blob, await decodeRecoveryCode(code))).toBe('ledger')
    await expect(decodeRecoveryCode(code.slice(0, 20))).rejects.toThrow(/54 characters .* this has 16/)
    await expect(decodeRecoveryCode(code.replace(/[0-9A-Z]/, 'U'))).rejects.toThrow(/invalid character: U/)
  })

  it('recovery codes round-trip every byte value', async () => {
    for (const fill of [0x00, 0xff, 0x55, 0xaa]) {
      const k = new Uint8Array(32).fill(fill)
      expect(await decodeRecoveryCode(await encodeRecoveryCode(k))).toEqual(k)
    }
    for (let i = 0; i < 20; i++) {
      const rnd = globalThis.crypto.getRandomValues(new Uint8Array(32))
      expect(await parseRecoveryCode(await encodeRecoveryCode(rnd))).toEqual({ key: rnd, checked: true })
    }
  })

  it('detects payload and wrapping tampering (GCM authentication)', async () => {
    const { blob } = await makeVault('secret', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const key = await unwrapWithPasskey(blob, cred(1), prf(1))
    const ct = b64decode(blob.payload.ct)
    ct[0]! ^= 0xff
    await expect(openPayload({ ...blob, payload: { ...blob.payload, ct: b64encode(ct) } }, key)).rejects.toThrow(AUTH)
    const iv = b64decode(blob.payload.iv)
    iv[0]! ^= 0x01
    await expect(openPayload({ ...blob, payload: { ...blob.payload, iv: b64encode(iv) } }, key)).rejects.toThrow(AUTH)
    const wk = b64decode(blob.keys[0]!.wrappedKey.ct)
    wk[3]! ^= 0x01
    const tamperedWrap = { ...blob, keys: [{ ...blob.keys[0]!, wrappedKey: { ...blob.keys[0]!.wrappedKey, ct: b64encode(wk) } }] }
    await expect(unwrapWithPasskey(tamperedWrap, cred(1), prf(1))).rejects.toThrow(/did not unlock/)
    await expect(openPayload(tamperedWrap, key)).rejects.toThrow(AUTH) // and the header no longer authenticates either
  })

  it('a wrapping is bound to its credential id', async () => {
    // Same PRF bytes under a different id must not unwrap: HKDF salts on the id.
    const { blob } = await makeVault('secret', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const moved = { ...blob, keys: [{ ...blob.keys[0]!, credentialId: cred(9) }] }
    await expect(unwrapWithPasskey(moved, cred(9), prf(1))).rejects.toThrow(/did not unlock/)
  })

  it('reseals under the same key: adding a passkey later never re-encrypts the other wrappings', async () => {
    const { rawDataKey, header, blob } = await makeVault('first', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    header.keys.push(await wrapForPasskey(rawDataKey, prf(2), { credentialId: cred(2), label: 'partner' }))
    const next = await sealVault(header, rawDataKey, text('second — edited in a zero-knowledge session'), 2)
    expect(next).toMatchObject({ vaultId: blob.vaultId, prfSalt: blob.prfSalt, seq: 2 })
    expect(next.keys[0]).toEqual(blob.keys[0])
    expect(next.payload.iv).not.toBe(blob.payload.iv) // fresh nonce every seal
    for (const n of [1, 2]) expect(await opens(next, await unwrapWithPasskey(next, cred(n), prf(n)))).toContain('second')
    expect(await opens(next, rawDataKey)).toContain('second')
    await expect(sealVault(header, rawDataKey.slice(0, 16), text('x'), 3)).rejects.toThrow(/32 bytes/)
    await expect(wrapForPasskey(rawDataKey, prf(1).slice(0, 8), { credentialId: cred(1), label: 'x' })).rejects.toThrow(/PRF output/)
  })

  it('salts, keys, vault ids and ciphertext are unique per vault; nothing recognizable leaks', async () => {
    const a = await makeVault('same payload', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    const b = await makeVault('same payload', [{ id: cred(1), prf: prf(1), label: 'Mac' }])
    expect(a.blob.payload.ct).not.toBe(b.blob.payload.ct)
    expect(a.blob.prfSalt).not.toBe(b.blob.prfSalt)
    expect(a.blob.vaultId).not.toBe(b.blob.vaultId)
    expect(a.rawDataKey).not.toEqual(b.rawDataKey)
    expect(a.blob.keys[0]!.wrappedKey.ct).not.toBe(b.blob.keys[0]!.wrappedKey.ct)
    expect(utf8(b64decode(a.blob.payload.ct))).not.toContain('same payload')
    expect(JSON.stringify(a.blob)).not.toContain(b64encode(a.rawDataKey))
  })

  it('a 2.5MB dump round-trips through gzip, and is stored far smaller', async () => {
    // Shaped like a real snapshot: many similar rows.
    const rows = Array.from({ length: 25_000 }, (_, i) => ({
      id: i,
      posted_on: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      amount_cents: (i * 7919) % 250_000 - 90_000,
      description: `POS PURCHASE ${['TRADER JOES', 'SAFEWAY', 'SHELL OIL', 'NETFLIX'][i % 4]} #${(i * 31) % 9999}`,
    }))
    const dump = JSON.stringify({ scarab: true, schemaVersion: 20, tables: { transactions: rows } })
    expect(dump.length).toBeGreaterThan(2_500_000)
    const { rawDataKey, blob } = await makeVault(dump, [])
    expect(await opens(blob, rawDataKey)).toBe(dump)
    const stored = b64decode(blob.payload.ct).length
    expect(stored).toBe(padBucket(stored - 16) + 16) // exactly a bucket, plus the GCM tag
    expect(stored).toBeLessThan(dump.length / 4)
  }, 30_000)

  it('multi-megabyte incompressible payloads round-trip too', async () => {
    const big = new Uint8Array(3_000_000)
    for (let i = 0; i < big.length; i += 65_536) globalThis.crypto.getRandomValues(big.subarray(i, i + 65_536))
    const { rawDataKey, blob } = await makeVault(big, [])
    const back = await openPayload(blob, rawDataKey)
    expect(back.length).toBe(big.length)
    expect(await sha256Hex(back)).toBe(await sha256Hex(big))
  }, 30_000)

  it('base64url matches WebAuthn credential ids', () => {
    const id = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01])
    expect(b64urlEncode(id)).toBe('-_-_AAE')
    expect(b64urlDecode('-_-_AAE')).toEqual(id)
  })
})

describe('v3 header authentication', () => {
  const two = () =>
    makeVault('ledger', [
      { id: cred(1), prf: prf(1), label: 'Max’s Mac' },
      { id: cred(2), prf: prf(2), label: 'nicole@example.com' },
    ], 42)

  it('an edited label fails', async () => {
    const { rawDataKey, blob } = await two()
    const b = through(blob)
    b.keys[1]!.label = 'Max’s iPhone'
    await expect(openPayload(b, rawDataKey)).rejects.toThrow(AUTH)
    // the passkey itself still unwraps (labels aren't in the KEK) — only the payload refuses
    expect(await unwrapWithPasskey(b, cred(2), prf(2))).toEqual(rawDataKey)
  })

  it('tampering with seq fails, in either direction', async () => {
    const { rawDataKey, blob } = await two()
    expect(await opens(blob, rawDataKey)).toBe('ledger')
    for (const seq of [41, 43, 1, 1_000_000]) await expect(openPayload({ ...through(blob), seq }, rawDataKey)).rejects.toThrow(AUTH)
  })

  it('the vault id, RP ID, salt and every wrapping field are authenticated', async () => {
    const { rawDataKey, blob } = await two()
    const other = await makeVault('x', [{ id: cred(3), prf: prf(3), label: 'intruder' }])
    const edits: ((b: VaultBlobV3) => void)[] = [
      (b) => (b.vaultId = other.blob.vaultId),
      (b) => (b.rpId = 'evil.example'),
      (b) => (b.prfSalt = other.blob.prfSalt),
      (b) => b.keys.push(other.blob.keys[0]!), // a wrapping injected by whoever controls storage
      (b) => b.keys.pop(), // a wrapping dropped
      (b) => (b.keys[0]!.addedAt = '2020-01-01T00:00:00.000Z'),
      (b) => (b.keys[0]!.wrappedKey = other.blob.keys[0]!.wrappedKey),
      (b) => (b.keys[0]!.credentialId = cred(9)),
    ]
    for (const edit of edits) {
      const b = through(blob)
      edit(b)
      await expect(openPayload(b, rawDataKey)).rejects.toThrow(AUTH)
    }
  })

  it('a blob cannot be relabelled as another format or encoding', async () => {
    const { rawDataKey, blob } = await two()
    await expect(openPayload({ ...through(blob), enc: 'none' as never }, rawDataKey)).rejects.toThrow(/unknown payload encoding/)
    // Presented as v2, the ciphertext needs the header as AAD and fails.
    await expect(openPayload({ ...(through(blob) as unknown as VaultBlobV2), v: 2 }, rawDataKey)).rejects.toThrow(AUTH)
    await expect(openPayload({ ...through(blob), v: 4 as never }, rawDataKey)).rejects.toThrow(/unsupported vault version 4/)
    await expect(openPayload({ ...through(blob), v: 1 as never }, rawDataKey)).rejects.toThrow(/unsupported vault version 1/)
  })

  it('order is not meaning: reordered wrappings and reordered JSON fields still open', async () => {
    const { rawDataKey, blob } = await two()
    const b = through(blob)
    b.keys.reverse()
    expect(await opens(b, rawDataKey)).toBe('ledger')
    const shuffled = JSON.parse(
      JSON.stringify({
        payload: blob.payload,
        keys: blob.keys.map((k) => ({ wrappedKey: { ct: k.wrappedKey.ct, iv: k.wrappedKey.iv }, addedAt: k.addedAt, label: k.label, credentialId: k.credentialId })),
        seq: blob.seq,
        enc: blob.enc,
        prfSalt: blob.prfSalt,
        rpId: blob.rpId,
        vaultId: blob.vaultId,
        v: 3,
      }),
    ) as VaultBlobV3
    expect(await opens(shuffled, rawDataKey)).toBe('ledger')
    expect(canonicalHeader(shuffled)).toEqual(canonicalHeader(blob))
  })

  it('canonical order is code-unit order, not locale order', () => {
    const w = (id: string) => ({ credentialId: id, label: id, addedAt: 'a', wrappedKey: { iv: '', ct: '' } })
    const h = { v: 3 as const, vaultId: cred(1), rpId: RP, prfSalt: b64encode(new Uint8Array(32)), enc: 'gzip+pad' as const, seq: 7 }
    const bytes = canonicalHeader({ ...h, keys: ['a', '_', 'B', '-', 'b', 'A'].map(w) })
    const ids = (JSON.parse(utf8(bytes)) as { keys: { credentialId: string }[] }).keys.map((k) => k.credentialId)
    expect(ids).toEqual(['-', 'A', 'B', '_', 'a', 'b'])
    expect(utf8(bytes).startsWith('{"v":3,"vaultId":')).toBe(true)
  })

  it('refuses a header that lists the same passkey twice, or is malformed', async () => {
    const { rawDataKey, blob } = await two()
    const dup = through(blob)
    dup.keys.push({ ...dup.keys[0]! })
    await expect(openPayload(dup, rawDataKey)).rejects.toThrow(/wrapped twice/)
    const cases: Record<string, unknown>[] = [
      { seq: 0 },
      { seq: -3 },
      { seq: 1.5 },
      { seq: '42' },
      { vaultId: 'short' },
      { vaultId: undefined },
      { rpId: '' },
      { prfSalt: 'not base64!' },
      { prfSalt: b64encode(new Uint8Array(16)) },
      { keys: 'none' },
    ]
    for (const c of cases) await expect(openPayload({ ...through(blob), ...c } as VaultBlobV3, rawDataKey)).rejects.toThrow(/malformed vault/)
  })

  it('fields it does not know are neither authenticated nor carried into the next seal', async () => {
    const { rawDataKey, blob } = await two()
    const b = { ...through(blob), note: 'added by the server', keys: blob.keys.map((k) => ({ ...k, extra: 1 })) }
    expect(await opens(b, rawDataKey)).toBe('ledger')
    const h = sessionHeader(b, 'ignored')
    expect(Object.keys(h).sort()).toEqual(['enc', 'keys', 'prfSalt', 'rpId', 'v', 'vaultId'])
    expect(Object.keys(h.keys[0]!).sort()).toEqual(['addedAt', 'credentialId', 'label', 'wrappedKey'])
    const next = await sealVault({ ...h, ...{ note: 'x' } } as VaultHeader, rawDataKey, text('next'), 43)
    expect(JSON.stringify(next)).not.toContain('note')
    expect(JSON.stringify(next)).not.toContain('extra')
  })

  it('a header without identities has exactly the canonical bytes it had before identities existed', () => {
    // Frozen: every v3 blob sealed before wrappings named their identity authenticates these bytes.
    const h = {
      v: 3 as const,
      vaultId: 'AAAAAAAAAAAAAAAAAAAAAA',
      rpId: RP,
      prfSalt: b64encode(new Uint8Array(32).fill(7)),
      enc: 'gzip+pad' as const,
      seq: 5,
      keys: [{ credentialId: cred(2), label: 'Max’s Mac', addedAt: '2026-09-01T00:00:00.000Z', wrappedKey: { iv: 'aXY=', ct: 'Y3Q=' } }],
    }
    expect(utf8(canonicalHeader(h))).toBe(
      '{"v":3,"vaultId":"AAAAAAAAAAAAAAAAAAAAAA","rpId":"scarab.one","prfSalt":"BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=","enc":"gzip+pad","seq":5,' +
        '"keys":[{"credentialId":"AgICAgICAgICAgICAgICAg","label":"Max’s Mac","addedAt":"2026-09-01T00:00:00.000Z","wrappedKey":{"iv":"aXY=","ct":"Y3Q="}}]}',
    )
    const bound = { ...h, keys: [{ ...h.keys[0]!, identity: 'max@x.com' }] }
    expect(utf8(canonicalHeader(bound))).toContain('"addedAt":"2026-09-01T00:00:00.000Z","identity":"max@x.com","wrappedKey"')
  })

  it('whose passkey it is (identity) is authenticated: it cannot be added, changed, moved or stripped', async () => {
    const { rawDataKey, header } = newVault(RP)
    header.keys.push(await wrapForPasskey(rawDataKey, prf(1), { credentialId: cred(1), label: 'Max’s Mac', identity: ' Max@X.com ' }))
    header.keys.push(await wrapForPasskey(rawDataKey, prf(2), { credentialId: cred(2), label: 'her phone', identity: 'nicole@x.com' }))
    header.keys.push(await wrapForPasskey(rawDataKey, prf(3), { credentialId: cred(3), label: 'old tablet' })) // from before identities
    expect(header.keys.map((k) => k.identity)).toEqual(['max@x.com', 'nicole@x.com', undefined])
    expect('identity' in header.keys[2]!).toBe(false)
    const blob = await sealVault(header, rawDataKey, text('ledger'), 9)
    expect(await opens(blob, rawDataKey)).toBe('ledger')

    const edits: ((b: VaultBlobV3) => void)[] = [
      (b) => (b.keys[1]!.identity = 'mallory@x.com'), // her passkey claimed by someone else
      (b) => delete b.keys[1]!.identity, // stripped: would read as a pre-binding (owner's) passkey
      (b) => (b.keys[2]!.identity = 'nicole@x.com'), // a binding added
      (b) => ([b.keys[0]!.identity, b.keys[1]!.identity] = [b.keys[1]!.identity, b.keys[0]!.identity]), // swapped between wrappings
    ]
    for (const edit of edits) {
      const b = through(blob)
      edit(b)
      await expect(openPayload(b, rawDataKey)).rejects.toThrow(AUTH)
      // the wrapping itself still unwraps: identity, like the label, is not in the KEK — only the payload refuses
      expect(await unwrapWithPasskey(b, cred(2), prf(2))).toEqual(rawDataKey)
    }

    // Carried from one seal to the next through the session header, exactly.
    const h = sessionHeader(blob, 'ignored')
    expect(h.keys.map((k) => k.identity)).toEqual(['max@x.com', 'nicole@x.com', undefined])
    expect('identity' in h.keys[2]!).toBe(false)
    const next = await sealVault(h, rawDataKey, text('next'), 10)
    expect(next.keys.map((k) => k.identity)).toEqual(['max@x.com', 'nicole@x.com', undefined])
    expect(await opens(next, rawDataKey)).toBe('next')
  })

  it('an identity must be a lowercase email: anything else is a malformed header, never authenticated', async () => {
    const { rawDataKey, blob } = await two()
    for (const bad of [null, 42, '', 'no-at-sign', 'Max@x.com', 'max @x.com', ' max@x.com', `${'a'.repeat(250)}@x.com`, ['max@x.com']]) {
      const b = through(blob)
      ;(b.keys[0] as unknown as Record<string, unknown>).identity = bad
      await expect(openPayload(b, rawDataKey), JSON.stringify(bad)).rejects.toThrow(/malformed vault: a wrapping names an identity/)
    }
    await expect(wrapForPasskey(rawDataKey, prf(1), { credentialId: cred(1), label: 'x', identity: 'not an email' })).rejects.toThrow(/not a sign-in identity/)
    // Blank means unknown, not an identity.
    expect('identity' in (await wrapForPasskey(rawDataKey, prf(1), { credentialId: cred(1), label: 'x', identity: '  ' }))).toBe(false)
    expect('identity' in (await wrapForPasskey(rawDataKey, prf(1), { credentialId: cred(1), label: 'x', identity: null }))).toBe(false)
  })

  it('seals only v3 headers at a valid seq', async () => {
    const { rawDataKey, header } = await two()
    await expect(sealVault({ v: 2, prfSalt: header.prfSalt, keys: [] } as unknown as VaultHeader, rawDataKey, text('x'), 1)).rejects.toThrow(/only format v3/)
    for (const seq of [0, -1, 1.5, Number.NaN]) await expect(sealVault(header, rawDataKey, text('x'), seq)).rejects.toThrow(/seq/)
  })

  it('the session header drops seq, and sealing stamps the version it was made for', async () => {
    const { rawDataKey, blob } = await two()
    const h = sessionHeader(blob, 'ignored for v3')
    expect(h).toEqual({ v: 3, vaultId: blob.vaultId, rpId: RP, prfSalt: blob.prfSalt, enc: 'gzip+pad', keys: blob.keys })
    const next = await sealVault(h, rawDataKey, text('v43'), 43)
    expect(next.seq).toBe(43)
    expect(await opens(next, rawDataKey)).toBe('v43')
  })
})

describe('size padding', () => {
  it('padBucket: a 32 KiB floor, then eighth steps of the power of two below', () => {
    const table: [number, number][] = [
      [0, 32_768],
      [1, 32_768],
      [10_000, 32_768],
      [32_768, 32_768],
      [32_769, 36_864],
      [36_864, 36_864],
      [36_865, 40_960],
      [65_535, 65_536],
      [65_536, 65_536],
      [65_537, 73_728],
      [1_000_000, 1_048_576],
      [2_500_000, 2_621_440],
      [10 * 1024 * 1024, 10 * 1024 * 1024],
    ]
    for (const [n, want] of table) expect([n, padBucket(n)]).toEqual([n, want])
    for (let n = 0; n < 5_000_000; n += 7_919) {
      const b = padBucket(n)
      expect(b).toBeGreaterThanOrEqual(n)
      expect(b).toBeGreaterThanOrEqual(PAD_FLOOR)
      if (n > PAD_FLOOR) expect(b - n).toBeLessThanOrEqual(n / 8)
      expect(padBucket(b)).toBe(b) // buckets are fixed points
    }
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) expect(() => padBucket(bad)).toThrow(/non-negative integer/)
  })

  const noise = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)) // incompressible: padding does the work

  it('10KB and 11KB plaintexts store at the same length', async () => {
    const { rawDataKey, header } = newVault(RP)
    const a = await sealVault(header, rawDataKey, noise(10_000), 1)
    const b = await sealVault(header, rawDataKey, noise(11_000), 1)
    expect(a.payload.ct.length).toBe(b.payload.ct.length)
    expect(b64decode(a.payload.ct).length).toBe(PAD_FLOOR + 16)
    expect(await openPayload(a, rawDataKey)).toHaveLength(10_000)
  })

  it('sizes inside one bucket are indistinguishable; the next bucket is not', async () => {
    const { rawDataKey, header } = newVault(RP)
    const len = async (n: number) => b64decode((await sealVault(header, rawDataKey, noise(n), 1)).payload.ct).length
    const [a, b, c] = [await len(37_000), await len(40_000), await len(42_000)]
    expect(a).toBe(b)
    expect(a).toBe(40_960 + 16)
    expect(c).toBe(45_056 + 16)
  })

  it('the frame is [u32 length][gzip][zeros], and unpacking is strict', async () => {
    const f = await packFrame(text('hello, frame'))
    expect(f.length).toBe(PAD_FLOOR)
    const len = new DataView(f.buffer).getUint32(0)
    expect([f[4], f[5]]).toEqual([0x1f, 0x8b]) // gzip magic right after the length
    expect(f.subarray(4 + len).every((x) => x === 0)).toBe(true)
    expect(utf8(await unpackFrame(f))).toBe('hello, frame')

    await expect(unpackFrame(f.subarray(0, 3))).rejects.toThrow(/too short/)
    const long = f.slice()
    new DataView(long.buffer).setUint32(0, f.length)
    await expect(unpackFrame(long)).rejects.toThrow(/runs past its end/)
    const dirty = f.slice()
    dirty[f.length - 1] = 1
    await expect(unpackFrame(dirty)).rejects.toThrow(/padding is not zeros/)
    const junk = f.slice()
    junk[4] = 0 // no longer gzip
    await expect(unpackFrame(junk)).rejects.toThrow(/not valid gzip/)
    const cut = f.slice()
    new DataView(cut.buffer).setUint32(0, len - 4) // a truncated gzip stream
    await expect(unpackFrame(cut)).rejects.toThrow(/not valid gzip|padding is not zeros/)
  })

  it('refuses to inflate a gzip bomb past the cap', async () => {
    const zeros = new Uint8Array(4_000_000) // gzips to a few KB
    const f = await packFrame(zeros)
    expect(f.length).toBe(PAD_FLOOR)
    await expect(unpackFrame(f, 1_000_000)).rejects.toThrow(/inflates past 1000000 bytes/)
    expect(await unpackFrame(f)).toHaveLength(4_000_000)
    expect(MAX_PLAINTEXT_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024)
  })
})

/**
 * A blob sealed by the v2 implementation (shared/vault.ts at 541bf24), frozen
 * here: key bytes (i*37+11)&0xff, PRF output (i*7+31)&0xff for the one
 * passkey. Opening it proves old vaults stay readable, byte for byte.
 */
const V2_FIXTURE = {
  code: '1CR5-AYMZ-RKMG-WCTR-FPHC-FV0H-6SDR-19EA-XWA3-JQM3-N36Z-45SW-C630',
  credentialId: 'BwcHBwcHBwcHBwcHBwcHBw',
  prf: new Uint8Array(32).map((_, i) => (i * 7 + 31) & 0xff),
  plaintext: '{"scarab":true,"note":"sealed by the v2 implementation"}',
  blob: {
    v: 2,
    prfSalt: 'WlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlo=',
    keys: [
      {
        credentialId: 'BwcHBwcHBwcHBwcHBwcHBw',
        label: 'Max’s Mac',
        addedAt: '2026-09-23T10:46:16.439Z',
        wrappedKey: { iv: 'MgQVU7z17r1ts/ca', ct: 'mCK8IbkP+b7OkG1O0Airz6VP6mCKknaqwkrKerckZVOli5D9ZYbsmwlc4NdrUu/U' },
      },
    ],
    payload: {
      iv: 'ywe+bbkFG2oEhMgH',
      ct: '1BPlvh/TJ1WdhwDHMv6J2uQlGRsxswWFcxwGSrvCGTqoRaFwIG9WAsB2RJl+0y+8zG74KWdtbmr+fekgQFjVbhYzin774Yfa',
    },
  },
}

describe('v2 compatibility', () => {
  const v2 = () => parseVaultBlob(JSON.stringify(V2_FIXTURE.blob))

  it('a v2 blob opens, with its recovery code and with its passkey', async () => {
    const blob = v2()
    expect(blob.v).toBe(2)
    const key = await decodeRecoveryCode(V2_FIXTURE.code)
    expect(await opens(blob, key)).toBe(V2_FIXTURE.plaintext)
    expect(await unwrapWithPasskey(blob, V2_FIXTURE.credentialId, V2_FIXTURE.prf)).toEqual(key)
  })

  it('v2 tampering is still detected', async () => {
    const blob = v2()
    const ct = b64decode(blob.payload.ct)
    ct[5]! ^= 0x10
    await expect(openPayload({ ...blob, payload: { ...blob.payload, ct: b64encode(ct) } }, await decodeRecoveryCode(V2_FIXTURE.code))).rejects.toThrow(AUTH)
  })

  it('opening one upgrades the session header, and the first save writes v3 that every key still opens', async () => {
    const blob = v2()
    const key = await decodeRecoveryCode(V2_FIXTURE.code)
    const h = sessionHeader(blob, 'localhost')
    expect(h).toMatchObject({ v: 3, rpId: 'localhost', enc: 'gzip+pad', prfSalt: blob.prfSalt, keys: blob.keys })
    expect(h.vaultId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(sessionHeader(blob, 'localhost').vaultId).not.toBe(h.vaultId) // minted per opening, fixed from the first v3 save on
    const next = await sealVault(h, key, text('now v3'), 8)
    expect(next).toMatchObject({ v: 3, seq: 8, vaultId: h.vaultId })
    expect(await opens(next, key)).toBe('now v3')
    // The old passkey wrapping carries over untouched: no re-registration needed.
    expect(await unwrapWithPasskey(next, V2_FIXTURE.credentialId, V2_FIXTURE.prf)).toEqual(key)
  })

  it('an identity slipped into a v2 header (which nothing authenticates) is not carried into the v3 that would vouch for it', async () => {
    const key = await decodeRecoveryCode(V2_FIXTURE.code)
    for (const injected of ['mallory@x.com', 'Not An Email', 7]) {
      const raw = { ...V2_FIXTURE.blob, keys: V2_FIXTURE.blob.keys.map((k) => ({ ...k, identity: injected })) }
      const blob = parseVaultBlob(JSON.stringify(raw)) // v2 identities are never read, so never refused either
      expect(await opens(blob, key)).toBe(V2_FIXTURE.plaintext)
      const h = sessionHeader(blob, 'localhost')
      expect('identity' in h.keys[0]!).toBe(false)
      const next = await sealVault(h, key, text('v3 now'), 2)
      expect(JSON.stringify(next)).not.toContain('identity')
    }
  })
})

describe('parseVaultBlob', () => {
  it('reads v2 and v3, and names what it refuses', async () => {
    const { blob } = await makeVault('x', [])
    expect(parseVaultBlob(JSON.stringify(blob))).toEqual(blob)
    expect(() => parseVaultBlob('{not json')).toThrow(/malformed vault: not JSON/)
    expect(() => parseVaultBlob('[]')).toThrow(/malformed vault/)
    expect(() => parseVaultBlob(JSON.stringify({ ...blob, payload: undefined }))).toThrow(/no payload/)
    expect(() => parseVaultBlob(JSON.stringify({ ...blob, v: 1 }))).toThrow(/unsupported vault format 1/)
    expect(() => parseVaultBlob(JSON.stringify({ ...blob, v: '3' }))).toThrow(/unsupported vault format "3"/)
    expect(() => parseVaultBlob(JSON.stringify({ ...blob, seq: 0 }))).toThrow(/seq/)
    const newer = () => parseVaultBlob(JSON.stringify({ ...blob, v: 4 }))
    expect(newer).toThrow(NewerVaultFormatError)
    expect(newer).toThrow(/newer version of Scarab \(format v4\)/)
  })
})

describe('rollback judgement', () => {
  const h3 = (seq: number) => ({ v: 3 as const, vaultId: cred(1), rpId: RP, prfSalt: '', enc: 'gzip+pad' as const, seq, keys: [] })
  const seen = (seq: number, sha256 = 'a'.repeat(64)): SeenRecord => ({ seq, sha256, at: '2026-09-22T10:00:00Z', creds: [cred(1)] })
  const sha = 'a'.repeat(64)

  it('a first sight is trusted, and says so when the copy was sealed for another version', () => {
    expect(judgeServed({ header: h3(42), version: 42, sha256: sha }, null)).toEqual({ kind: 'ok', restored: false })
    // An old blob served at a higher version: opens, with the notice.
    expect(judgeServed({ header: h3(40), version: 45, sha256: sha }, null)).toEqual({ kind: 'ok', restored: true })
    expect(judgeServed({ header: h3(46), version: 45, sha256: sha }, null)).toEqual({ kind: 'ok', restored: true })
  })

  it('an older seq than this device saw is a rollback; the same seq with other bytes is a fork', () => {
    expect(judgeServed({ header: h3(41), version: 41, sha256: sha }, seen(42))).toEqual({ kind: 'rollback', seen: seen(42) })
    expect(judgeServed({ header: h3(40), version: 45, sha256: sha }, seen(42))).toMatchObject({ kind: 'rollback' })
    expect(judgeServed({ header: h3(42), version: 42, sha256: 'b'.repeat(64) }, seen(42))).toMatchObject({ kind: 'fork' })
    expect(judgeServed({ header: h3(42), version: 42, sha256: sha }, seen(42))).toEqual({ kind: 'ok', restored: false })
    expect(judgeServed({ header: h3(43), version: 43, sha256: 'c'.repeat(64) }, seen(42))).toEqual({ kind: 'ok', restored: false })
  })

  it('a v2 copy of a vault this device knows as v3 is a downgrade', () => {
    const v2h = { v: 2 as const, prfSalt: '', keys: [] }
    expect(judgeServed({ header: v2h, version: 50, sha256: sha }, seen(42))).toMatchObject({ kind: 'downgrade' })
    expect(judgeServed({ header: v2h, version: 50, sha256: sha }, null)).toEqual({ kind: 'ok', restored: false })
  })

  it('isSeenRecord accepts only well-formed memory', () => {
    expect(isSeenRecord(seen(1))).toBe(true)
    expect(isSeenRecord({ ...seen(1), prfSalt: 'c2FsdA==' })).toBe(true) // which key it saw (records from before it was kept have none)
    for (const bad of [
      null,
      'x',
      { ...seen(1), seq: '1' },
      { ...seen(1), sha256: 'zz' },
      { ...seen(1), creds: [1] },
      { ...seen(1), at: 5 },
      { ...seen(1), prfSalt: 7 },
    ])
      expect(isSeenRecord(bad)).toBe(false)
  })
})

describe('recovery code check group', () => {
  const key = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff) // the v2 fixture's key
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const chars = async () => (await encodeRecoveryCode(key)).replace(/-/g, '')

  it('grows the code from 52 to 54 characters; the old 52-character code still reads, unchecked', async () => {
    const c = await chars()
    expect(c).toHaveLength(54)
    expect(c.slice(0, 52)).toBe(V2_FIXTURE.code.replace(/-/g, '')) // the key part is unchanged
    expect(await parseRecoveryCode(V2_FIXTURE.code)).toEqual({ key, checked: false })
    expect(await parseRecoveryCode(c)).toEqual({ key, checked: true })
  })

  it('reports a typo as a typo — almost every single-character slip in the key part is caught', async () => {
    const c = await chars()
    let caught = 0
    let same = 0
    let missed = 0
    for (let i = 0; i < 52; i++)
      for (const ch of ALPHABET) {
        if (ch === c[i]) continue
        const typo = c.slice(0, i) + ch + c.slice(i + 1)
        try {
          const r = await parseRecoveryCode(typo)
          if (sameKey(r.key, key)) same++ // the last key character's four padding bits: the same key
          else missed++
        } catch (e) {
          expect(e).toBeInstanceOf(RecoveryCodeError)
          expect((e as RecoveryCodeError).problem).toBe('typo')
          expect((e as Error).message).toMatch(/has a typo/)
          caught++
        }
      }
    expect(caught + same + missed).toBe(52 * 31)
    expect(same).toBe(15) // only the padding bits of character 52
    expect(missed / (caught + missed)).toBeLessThan(0.005) // a 10-bit check: about 1 in 1024
  })

  it('catches a slip in the check group itself, and swapped neighbours', async () => {
    const c = await chars()
    for (const ch of ALPHABET)
      if (ch !== c[53]) await expect(parseRecoveryCode(c.slice(0, 53) + ch)).rejects.toThrow(/has a typo/)
    let caught = 0
    let swaps = 0
    for (let i = 0; i < 51; i++) {
      if (c[i] === c[i + 1]) continue
      swaps++
      const t = c.slice(0, i) + c[i + 1] + c[i] + c.slice(i + 2)
      if (await parseRecoveryCode(t).then(() => false, () => true)) caught++
    }
    expect(caught).toBeGreaterThanOrEqual(swaps - 1)
  })

  it('names what is wrong with the length and the alphabet before checking anything', async () => {
    const c = await chars()
    const problem = (code: string) => parseRecoveryCode(code).then(() => 'ok', (e: RecoveryCodeError) => e.problem)
    expect(await problem(c.slice(0, 53))).toBe('length')
    expect(await problem(c + '0')).toBe('length')
    expect(await problem(c.slice(0, 53) + 'U')).toBe('character')
    expect(await problem(c)).toBe('ok')
  })

  it('a wrong key fails as authentication, a typed error the session tells apart from a typo', async () => {
    const { blob } = await makeVault('x', [])
    const e = await openPayload(blob, key).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(VaultAuthError)
    const v2e = await openPayload(parseVaultBlob(JSON.stringify(V2_FIXTURE.blob)), new Uint8Array(32)).catch((x: unknown) => x)
    expect(v2e).toBeInstanceOf(VaultAuthError)
  })

  it('sameKey compares every byte', () => {
    const a = new Uint8Array(32).fill(7)
    expect(sameKey(a, a.slice())).toBe(true)
    for (const i of [0, 17, 31]) {
      const b = a.slice()
      b[i] = 8
      expect(sameKey(a, b)).toBe(false)
    }
    expect(sameKey(a, a.slice(0, 31))).toBe(false)
  })
})
