import { createHash, createHmac, randomBytes } from 'node:crypto'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import {
  b64decode,
  b64encode,
  b64urlEncode,
  decodeRecoveryCode,
  encodeRecoveryCode,
  openPayload,
  padBucket,
  parseVaultBlob,
  sealVault,
  sha256Hex,
  type VaultBlobV2,
  type VaultBlobV3,
} from '../shared/vault'

/**
 * Vault format v3 through the real session wiring: session.ts + saveQueue.ts
 * + the sql.js engine + the real Hono app in memory. The authenticator is a
 * fake that behaves like one — each credential holds a secret, and its PRF
 * output is HMAC(secret, salt), so a new salt (rotation) yields a new secret
 * and an old salt (an old blob) yields the old one.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

const authn = vi.hoisted(() => ({ creds: new Map<string, Buffer>(), asserts: 0, registers: 0 }))
vi.mock('./passkey', async (importOriginal) => {
  const real = await importOriginal<typeof import('./passkey')>()
  const prfFor = (id: string, saltB64: string) =>
    new Uint8Array(createHmac('sha256', authn.creds.get(id)!).update(Buffer.from(saltB64, 'base64')).digest())
  return {
    ...real,
    async registerPasskey(o: { prfSaltB64: string; label: string; excludeCredentialIds: string[] }) {
      authn.registers++
      const id = b64urlEncode(new Uint8Array(randomBytes(16)))
      authn.creds.set(id, randomBytes(32))
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64) }
    },
    async assertPasskey(o: { prfSaltB64: string; credentialIds: string[] }) {
      authn.asserts++
      const id = o.credentialIds.find((c) => authn.creds.has(c))
      if (!id) throw new Error('passkey prompt was cancelled or timed out')
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64) }
    },
  }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const location = { reload: vi.fn(), hostname: 'localhost' }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() {
    return m.size
  },
})
const local$ = new Map<string, string>()
vi.stubGlobal('sessionStorage', storage(new Map()))
vi.stubGlobal('localStorage', storage(local$))

const IDENTITY = { 'x-goog-authenticated-user-email': 'accounts.google.com:max@x' }
type App = ReturnType<typeof import('../server/app').createApp>
let app: App
let serverDb: DbLike
vi.stubGlobal(
  'fetch',
  vi.fn((url: string, init?: RequestInit) =>
    app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...IDENTITY } }),
  ),
)

let session: typeof import('./session')
let local: typeof import('./local')

type Row = { version: number; data: string; sha256: string }
const row = () => serverDb.prepare("SELECT version, data, sha256 FROM vault_blobs WHERE owner_email = 'max@x'").get() as Row
const blobOf = (r: Row) => parseVaultBlob(r.data)
const v3 = (r: Row) => blobOf(r) as VaultBlobV3
/** Another device (or whoever controls storage) uploads `data` as the next version. */
async function putRaw(data: string) {
  const r = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...IDENTITY },
    body: JSON.stringify({ data, version: row().version }),
  })
  expect(r.status).toBe(200)
}
/** A server whose stored copy changed under everyone (a restore, a bug, an attack): rewrite the row in place. */
const rewriteRow = (data: string, version = row().version) =>
  serverDb.prepare("UPDATE vault_blobs SET data = ?, version = ? WHERE owner_email = 'max@x'").run(data, version)
const seen = (vaultId: string) => JSON.parse(local$.get(`scarab:seen:${vaultId}`) ?? 'null') as { seq: number; sha256: string; creds: string[] } | null
const shaOf = (data: string) => sha256Hex(new TextEncoder().encode(data))
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const accounts = async (data: string, key: Uint8Array) =>
  ((JSON.parse(new TextDecoder().decode(await openPayload(parseVaultBlob(data), key))) as Dump).tables.accounts ?? []).map((a) => a.name)

/** Seal a format-v2 blob the way the previous release did (no AAD, no frame). */
async function sealV2(prfSalt: string, keys: VaultBlobV2['keys'], rawKey: Uint8Array, plaintext: Uint8Array): Promise<VaultBlobV2> {
  const k = await crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plaintext as BufferSource))
  return { v: 2, prfSalt, keys, payload: { iv: b64encode(iv), ct: b64encode(ct) } }
}

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
})
afterAll(() => vi.unstubAllGlobals())

describe('vault format v3, end to end', () => {
  let code = ''
  let vaultId = ''
  let keyAt2: Uint8Array
  let blobAt2 = ''
  let rotatedCode = ''

  it('creating a vault writes v3 for this origin — fresh vault id, seq 1 — and this device remembers it', async () => {
    await session.startEmpty()
    await write('Checking')
    const r = await session.createVault('Max’s Mac')
    code = r.recoveryCode
    const b = v3(row())
    expect(b).toMatchObject({ v: 3, rpId: 'localhost', enc: 'gzip+pad', seq: 1 })
    expect(row().version).toBe(1)
    vaultId = b.vaultId
    expect(b.keys.map((k) => k.label)).toEqual(['Max’s Mac'])
    expect(seen(vaultId)).toMatchObject({ seq: 1, sha256: await shaOf(row().data), creds: [b.keys[0]!.credentialId] })
    // Stored as ciphertext of a padded frame: its length is a bucket (plus the GCM tag), not the dump's.
    const ct = b64decode(b.payload.ct).length
    expect(padBucket(ct - 16)).toBe(ct - 16)
    expect(await accounts(row().data, (await decodeRecoveryCode(code)))).toEqual(['Checking'])
  })

  it('every save is sealed for the version it becomes, and moves this device’s memory with it', async () => {
    await write('Savings')
    const r = await session.saveVault()
    expect(r).toMatchObject({ version: 2, skipped: false })
    expect(v3(row())).toMatchObject({ seq: 2, vaultId })
    expect(seen(vaultId)).toMatchObject({ seq: 2, sha256: await shaOf(row().data) })
    keyAt2 = (await decodeRecoveryCode(code))
    blobAt2 = row().data
  })

  it('rotation mints a new key and salt but keeps the vault id — and this device’s memory of it', async () => {
    const before = v3(row())
    const r = await session.rotateVault()
    const after = v3(row())
    expect(after).toMatchObject({ v: 3, seq: 3, vaultId, rpId: 'localhost' })
    expect(after.prfSalt).not.toBe(before.prfSalt)
    expect(after.keys.map((k) => [k.credentialId, k.label])).toEqual([[before.keys[0]!.credentialId, 'Max’s Mac']])
    expect(await accounts(row().data, (await decodeRecoveryCode(r.recoveryCode)))).toEqual(['Checking', 'Savings'])
    await expect(openPayload(after, keyAt2)).rejects.toThrow(/failed authentication/) // the old code opens nothing new
    expect(seen(vaultId)).toMatchObject({ seq: 3 })
    code = rotatedCode = r.recoveryCode
  })

  it('a replayed older copy stops the unlock and asks; declining changes nothing', async () => {
    // The pre-rotation blob, served again as the next version. Its passkey still opens it —
    // the credential is the same, and the old salt gives the old secret — which is why this matters.
    await putRaw(blobAt2)
    expect(row().version).toBe(4)
    const tabBefore = local.localMode.vault
    const ask = vi.fn(async () => false)
    const e = await session.unlockVault({ confirmRollback: ask }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(session.RollbackRefused)
    expect(ask).toHaveBeenCalledWith({ kind: 'rollback', seen: expect.objectContaining({ seq: 3 }), served: { version: 4, seq: 2, format: 3 } })
    expect((e as Error).message).toMatch(/serving v2 of this vault, older than the v3 this device last saw/)
    expect(local.localMode.vault).toBe(tabBefore) // the tab still holds v3, under the new key
    // Nobody to ask (no callback): refused all the same.
    await expect(session.unlockWithRecoveryCode((await encodeRecoveryCode(keyAt2)))).rejects.toThrow(session.RollbackRefused)
    expect(seen(vaultId)).toMatchObject({ seq: 3 })
  })

  it('opening the older copy anyway boots it and makes it what this device knows', async () => {
    const r = await session.unlockVault({ confirmRollback: async () => true })
    expect(r).toMatchObject({ version: 4, notice: null })
    expect(local.localMode.vault).toMatchObject({ version: 4 })
    expect(local.localMode.vault!.rawDataKey).toEqual(keyAt2)
    expect(seen(vaultId)).toMatchObject({ seq: 2, sha256: await shaOf(blobAt2) })
    // Its next save goes on top of it — sealed as v5 — and reads as normal from here on.
    await write('Brokerage')
    await session.saveVault()
    expect(v3(row())).toMatchObject({ seq: 5, vaultId })
    expect(seen(vaultId)).toMatchObject({ seq: 5 })
    code = (await encodeRecoveryCode(keyAt2))
  })

  it('an old blob served at a higher version opens, with a notice', async () => {
    await putRaw(row().data) // v6 holds the blob sealed as v5
    const r = await session.unlockWithRecoveryCode(code)
    expect(r.version).toBe(6)
    expect(r.notice).toMatch(/Vault v6 holds a copy sealed as v5: an earlier version was put back/)
    // A device that never saw it gets the same notice, and nothing stops it.
    const mem = new Map(local$)
    local$.clear()
    expect((await session.unlockWithRecoveryCode(code)).notice).toMatch(/sealed as v5/)
    for (const [k, v] of mem) local$.set(k, v)
  })

  it('the same seq with different bytes is a fork', async () => {
    await write('Mine')
    await session.saveVault() // v7, sealed as 7
    expect(seen(vaultId)).toMatchObject({ seq: 7 })
    // The server now serves a different v7 (say, restored from backup, then someone else saved over it).
    const other = await sealVault(local.localMode.vault!.header, keyAt2, new TextEncoder().encode(JSON.stringify(await local.localDump())), 7)
    rewriteRow(JSON.stringify(other), 7)
    const ask = vi.fn(async () => false)
    await expect(session.unlockWithRecoveryCode(code, { confirmRollback: ask })).rejects.toThrow(/server’s v7 is not the v7 this device saw/)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fork', served: { version: 7, seq: 7, format: 3 } }))
    expect(await session.checkSeen({ ...row(), size: 0, updated_at: '' })).toMatchObject({ state: 'diverged', servedSeq: 7 })
    await session.unlockWithRecoveryCode(code, { confirmRollback: async () => true })
    expect(await session.checkSeen({ ...row(), size: 0, updated_at: '' })).toMatchObject({ state: 'same', seen: { seq: 7 } })
  })

  it('a v2 copy of a vault this device knows in v3 is a downgrade', async () => {
    const h = local.localMode.vault!.header
    const v2 = await sealV2(h.prfSalt, h.keys, keyAt2, new TextEncoder().encode(JSON.stringify(await local.localDump())))
    await putRaw(JSON.stringify(v2)) // v8, in the old format
    expect(await session.checkSeen({ ...row(), size: 0, updated_at: '' })).toMatchObject({ format: 2, state: 'downgrade' })
    const ask = vi.fn(async () => false)
    await expect(session.unlockVault({ confirmRollback: ask })).rejects.toThrow(/older-format copy of this vault, and this device has seen it at v7/)
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'downgrade', served: { version: 8, seq: null, format: 2 } }))
  })

  it('a v2 vault this device never saw opens with a notice, and its first save writes v3', async () => {
    local$.clear() // a device with no memory of this vault
    const r = await session.unlockWithRecoveryCode(code)
    expect(r.notice).toMatch(/older v2 format. Your next save rewrites it as v3/)
    expect(local.localMode.dirty).toBe(false)
    expect(local$.size).toBe(0) // nothing to remember of a v2 copy
    const v2 = blobOf(row()) as VaultBlobV2
    const v2Sha = createHash('sha256').update(row().data).digest('hex')
    const saved = await session.saveVault() // not skipped: the stored copy is v2
    expect(saved).toMatchObject({ version: 9, skipped: false })
    // No no-op baseline for a v2 copy, but the upload still names the blob it replaces.
    const put = vi.mocked(fetch).mock.calls.filter(([u, i]) => u === '/api/vault' && i?.method === 'PUT').at(-1)!
    expect(JSON.parse(String(put[1]!.body))).toMatchObject({ version: 8, baseSha256: v2Sha })
    const now = v3(row())
    expect(now).toMatchObject({ v: 3, seq: 9, rpId: 'localhost', prfSalt: v2.prfSalt, keys: v2.keys })
    expect(now.vaultId).not.toBe(vaultId) // a v2 vault had none; it gets its own from here on
    expect(seen(now.vaultId)).toMatchObject({ seq: 9 })
    // …and the passkey that opened v2 opens v3 without being registered again.
    expect(authn.registers).toBe(1)
    expect((await session.unlockVault()).notice).toBeNull()
  })

  it('passkeys stay on their domain: elsewhere, the passkey paths say where, and the recovery code still works', async () => {
    location.hostname = 'scarab-abc123-uc.a.run.app'
    try {
      const asserts = authn.asserts
      await expect(session.unlockVault()).rejects.toThrow('This vault’s passkeys belong to localhost — open it there, or use the recovery code.')
      expect(authn.asserts).toBe(asserts) // no prompt shown
      const r = await session.unlockWithRecoveryCode(code)
      expect(r.version).toBe(9)
      await expect(session.addPasskey('phone')).rejects.toThrow(/belong to localhost — manage them there/)
      await expect(session.rotateVault()).rejects.toThrow(/belong to localhost — manage them there/)
      // Saving from here keeps the vault's RP ID: the passkeys still belong where they were made.
      await write('From elsewhere')
      await session.saveVault()
      expect(v3(row())).toMatchObject({ rpId: 'localhost', seq: 10 })
    } finally {
      location.hostname = 'localhost'
    }
  })

  it('recovery codes: a typo is reported as a typo, before anything is fetched; a right code for another key says so', async () => {
    const fetches = vi.mocked(fetch)
    const c = code.replace(/-/g, '')
    const slip = c.slice(0, 9) + (c[9] === 'Z' ? 'Y' : 'Z') + c.slice(10)
    const before = fetches.mock.calls.length
    await expect(session.unlockWithRecoveryCode(slip)).rejects.toThrow(/has a typo/)
    expect(fetches.mock.calls.length).toBe(before) // refused in the tab
    // Typed perfectly, but for another key: the rotation's, which the older copy reopened above predates.
    await expect(session.unlockWithRecoveryCode(rotatedCode)).rejects.toThrow(/typed correctly but doesn’t open this vault/)
    // An older 52-character code (no check group) that doesn't open: typo or wrong key, it can't tell.
    await expect(session.unlockWithRecoveryCode(rotatedCode.replace(/-/g, '').slice(0, 52))).rejects.toThrow(/Check it for a typo/)
    expect((await session.unlockWithRecoveryCode(code.replace(/-/g, '').slice(0, 52))).version).toBe(10)
  })

  it('the drill checks a written-down code against the key in the tab, sending nothing', async () => {
    const fetches = vi.mocked(fetch)
    const before = fetches.mock.calls.length
    expect(await session.drillRecoveryCode(code)).toEqual({ ok: true, message: 'This code opens this vault.' })
    expect(await session.drillRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toMatchObject({ ok: true })
    expect(await session.drillRecoveryCode(code.replace(/-/g, '').slice(0, 52))).toMatchObject({ ok: true, message: expect.stringMatching(/older 52-character code/) })
    const c = code.replace(/-/g, '')
    expect(await session.drillRecoveryCode(c.slice(0, 20) + (c[20] === '0' ? '1' : '0') + c.slice(21))).toMatchObject({ ok: false, problem: 'typo' })
    expect(await session.drillRecoveryCode(c.slice(0, 40))).toMatchObject({ ok: false, problem: 'length' })
    expect(await session.drillRecoveryCode(rotatedCode)).toMatchObject({ ok: false, problem: 'mismatch', message: expect.stringMatching(/Typed correctly/) })
    expect(await session.recoveryCodeOfSession()).toBe(code)
    expect(fetches.mock.calls.length).toBe(before)
  })
})