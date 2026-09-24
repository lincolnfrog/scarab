import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import { b64encode, b64urlEncode, decodeRecoveryCode, openPayload, parseVaultBlob, RecoveryCodeError, type VaultBlobV3 } from '../shared/vault'

/**
 * Encrypted backup files end to end (Z10): the real session.ts +
 * saveQueue.ts + sql.js engine + the Hono app in memory, with a fake
 * authenticator. A .scarab file is the tab sealed like a vault version and
 * never uploaded; it opens with the tab's key, a passkey that was on the
 * vault, or the recovery code from then; it goes back only by an explicit
 * restore — into the vault under its current key, or as the vault itself
 * when none is stored.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

const authn = vi.hoisted(() => ({ creds: new Map<string, Buffer>(), asserts: 0 }))
vi.mock('./passkey', async (importOriginal) => {
  const real = await importOriginal<typeof import('./passkey')>()
  const prfFor = (id: string, saltB64: string) =>
    new Uint8Array(createHmac('sha256', authn.creds.get(id)!).update(Buffer.from(saltB64, 'base64')).digest())
  return {
    ...real,
    async registerPasskey(o: { prfSaltB64: string }) {
      const id = b64urlEncode(new Uint8Array(randomBytes(16)))
      authn.creds.set(id, randomBytes(32))
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64), attachment: 'platform' as const }
    },
    async assertPasskey(o: { prfSaltB64: string; credentialIds: string[] }) {
      authn.asserts++
      const id = o.credentialIds.find((c) => authn.creds.has(c))
      if (!id) throw new Error('passkey prompt was cancelled or timed out')
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64), attachment: 'platform' as const }
    },
  }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload: vi.fn(), hostname: 'localhost' } }))
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

const as = (who: string) => ({ 'x-goog-authenticated-user-email': `accounts.google.com:${who}` })
let app: ReturnType<typeof import('../server/app').createApp>
let serverDb: DbLike
/** Runs once, just before this tab's next PUT reaches the server. */
const net = { beforePut: null as null | (() => Promise<unknown>) }
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/vault' && init?.method === 'PUT' && net.beforePut) {
    const f = net.beforePut
    net.beforePut = null
    await f()
  }
  return app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...as('max@x') } })
})
vi.stubGlobal('fetch', fetchMock)

let session: typeof import('./session')
let local: typeof import('./local')

type Row = { version: number; data: string }
const row = () => serverDb.prepare("SELECT version, data FROM vault_blobs WHERE owner_email = 'max@x'").get() as Row | undefined
const storedWith = async (k: Uint8Array) => JSON.parse(new TextDecoder().decode(await openPayload(parseVaultBlob(row()!.data), k))) as Dump
const names = (d: Dump) => (d.tables.accounts ?? []).map((a) => a.name)
const tabAccounts = async () => names(await local.localDump())
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const puts = () => fetchMock.mock.calls.filter(([u, i]) => u === '/api/vault' && i?.method === 'PUT').length
const envelope = (text: string) => JSON.parse(text) as { scarab: string; format: number; vault: VaultBlobV3 }
const refile = (text: string, edit: (v: VaultBlobV3) => VaultBlobV3) => {
  const f = envelope(text)
  return JSON.stringify({ ...f, vault: edit(f.vault) })
}
/** A typo in one character of a code's key part (the check group then disagrees). */
const typo = (c: string) => (c[0] === 'A' ? 'B' : 'A') + c.slice(1)

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  local.localMode.setIdentity('max@x')
})
afterAll(() => vi.unstubAllGlobals())

/** Shared across the tests, in order: the vault's first key and its backup, then the key after a rotation. */
let code1 = ''
let key1: Uint8Array
let backup1 = { name: '', text: '' }
let code2 = ''
let key2: Uint8Array

describe('encrypted backup files (Z10)', () => {
  it('seals this tab — unsaved changes included — without uploading anything; the file holds no plaintext', async () => {
    await session.startEmpty()
    await write('Checking')
    const created = await session.createVault('Max’s Mac')
    code1 = created.recoveryCode
    key1 = await decodeRecoveryCode(code1)
    await write('Unsaved-Secret-Account')
    const before = puts()
    const b = await session.makeBackup()
    backup1 = { name: b.name, text: b.text }
    expect(puts()).toBe(before) // nothing went to the server
    expect(b).toMatchObject({ version: 1, unsaved: true })
    expect(b.name).toMatch(/^scarab-backup-\d{4}-\d\d-\d\d-v1-unsaved\.scarab$/)
    expect(b.text).not.toMatch(/Unsaved-Secret-Account|Checking/)
    // The envelope holds a v3 blob of this vault: its header, sealed for the tab's version, padded.
    const f = envelope(b.text)
    expect(f).toMatchObject({ scarab: 'backup', format: 1 })
    const s = local.localMode.vault!
    expect(f.vault).toMatchObject({ v: 3, vaultId: s.header.vaultId, prfSalt: s.header.prfSalt, rpId: 'localhost', enc: 'gzip+pad', seq: 1 })
    expect(f.vault.keys.map((k) => k.label)).toEqual(['Max’s Mac'])
    expect(atob(f.vault.payload.ct).length).toBeGreaterThanOrEqual(32 * 1024) // the padded frame: no exact size
    expect(local.localMode.dirty).toBe(true) // making a backup is not a save
  })

  it('opens with the session key — no prompt — and shows what it holds; nothing in the tab changes', async () => {
    const asserts = authn.asserts
    const snap = await session.openBackup(session.parseBackup(backup1.text, backup1.name), { kind: 'session' })
    expect(authn.asserts).toBe(asserts)
    expect(snap.source).toMatchObject({ kind: 'backup', name: backup1.name, sealedAs: 1, via: { kind: 'session' } })
    expect(session.relationOf(snap)).toEqual({ sameVault: true, sameKey: true })
    expect(snap.counts!.accounts).toBe(2)
    expect(names(snap.dump)).toEqual(['Checking', 'Unsaved-Secret-Account'])
    expect(snap.unreadable).toBeNull()
    expect(local.localMode.dirty).toBe(true)
    await session.saveVault() // v2
  })

  it('a changed file never opens: its header, seq, payload, salt or vault id — by any key', async () => {
    const tampered: [string, (v: VaultBlobV3) => VaultBlobV3][] = [
      ['a relabelled passkey', (v) => ({ ...v, keys: v.keys.map((k) => ({ ...k, label: 'evil' })) })],
      ['another seq', (v) => ({ ...v, seq: v.seq + 1 })],
      ['a flipped payload byte', (v) => ({ ...v, payload: { ...v.payload, ct: (v.payload.ct[0] === 'A' ? 'B' : 'A') + v.payload.ct.slice(1) } })],
      ['an injected wrapping', (v) => ({ ...v, keys: [...v.keys, { ...v.keys[0]!, credentialId: 'injected', label: 'intruder' }] })],
      ['another RP ID', (v) => ({ ...v, rpId: 'evil.example' })],
    ]
    for (const [what, edit] of tampered) {
      const p = session.parseBackup(refile(backup1.text, edit), 'x.scarab')
      await expect(session.openBackup(p, { kind: 'session' }), what).rejects.toThrow(/damaged or was altered/)
      await expect(session.openBackup(p, { kind: 'recovery', code: code1 }), what).rejects.toThrow(/doesn’t open this backup/)
    }
    // With a passkey: the wrapping still unwraps (it wasn't touched), and the payload refuses the changed header.
    const relabelled = session.parseBackup(refile(backup1.text, tampered[0]![1]), 'x.scarab')
    await expect(session.openBackup(relabelled, { kind: 'passkey' })).rejects.toThrow(/damaged or was altered/)
    // Another salt or vault id: it no longer claims this key, so the tab asks for one — and none opens it.
    for (const edit of [(v: VaultBlobV3) => ({ ...v, prfSalt: b64encode(new Uint8Array(randomBytes(32))) }), (v: VaultBlobV3) => ({ ...v, vaultId: 'BBBBBBBBBBBBBBBBBBBBBB' })]) {
      const p = session.parseBackup(refile(backup1.text, edit), 'x.scarab')
      await expect(session.openBackup(p, { kind: 'session' })).rejects.toBeInstanceOf(session.BackupNeedsKey)
      await expect(session.openBackup(p, { kind: 'recovery', code: code1 })).rejects.toThrow(/doesn’t open this backup/)
    }
  })

  it('refuses what isn’t a backup, saying what it is', () => {
    const parse = (text: string) => () => session.parseBackup(text, 'f')
    expect(parse('not json')).toThrow(/isn’t a Scarab backup/)
    expect(parse('{"scarab":true,"schemaVersion":20,"tables":{}}')).toThrow(/plain export/)
    expect(parse(JSON.stringify({ ...envelope(backup1.text), format: 2 }))).toThrow(/newer version of Scarab/)
    expect(parse(JSON.stringify({ ...envelope(backup1.text), format: 0 }))).toThrow(/isn’t a Scarab backup/)
    expect(parse(refile(backup1.text, (v) => ({ ...v, v: 4 }) as unknown as VaultBlobV3))).toThrow(/newer version of Scarab/)
    const { vaultId, rpId, enc, seq, ...v2 } = envelope(backup1.text).vault
    void [vaultId, rpId, enc, seq]
    expect(parse(JSON.stringify({ scarab: 'backup', format: 1, vault: { ...v2, v: 2 } }))).toThrow(/not format v3/)
    expect(parse(refile(backup1.text, (v) => ({ ...v, keys: 'nope' }) as unknown as VaultBlobV3))).toThrow(/damaged/)
    expect(parse(JSON.stringify(envelope(backup1.text).vault))).toThrow(/isn’t a Scarab backup/) // a bare blob is not a backup file
    expect(parse(' '.repeat(session.MAX_BACKUP_BYTES + 1))).toThrow(/too large/)
  })

  it('after a rotation: the old backup needs its own key (its recovery code, or a passkey from then) and restores under the new key', async () => {
    const r = await session.rotateVault()
    code2 = r.recoveryCode
    key2 = await decodeRecoveryCode(code2)
    const p = session.parseBackup(backup1.text, backup1.name)
    await expect(session.openBackup(p, { kind: 'session' })).rejects.toBeInstanceOf(session.BackupNeedsKey)
    await expect(session.openBackup(p, { kind: 'recovery', code: code2 })).rejects.toThrow(/typed correctly but doesn’t open this backup/)
    await expect(session.openBackup(p, { kind: 'recovery', code: typo(code1) })).rejects.toBeInstanceOf(RecoveryCodeError)
    const byPasskey = await session.openBackup(p, { kind: 'passkey' }) // the passkey is the same one; its old wrapping, the old salt
    expect(byPasskey.source).toMatchObject({ via: { kind: 'passkey', label: 'Max’s Mac' } })
    expect(session.relationOf(byPasskey)).toEqual({ sameVault: true, sameKey: false })
    const snap = await session.openBackup(p, { kind: 'recovery', code: code1 })
    expect(snap.source).toMatchObject({ via: { kind: 'recovery' } })
    expect(session.relationOf(snap)).toEqual({ sameVault: true, sameKey: false })

    await write('Since the rotation')
    const at = row()!.version
    const restored = await session.restoreSnapshot(snap)
    expect(restored).toEqual({ version: at + 2, pinned: at + 1, skipped: false }) // unsaved work first, then the backup
    expect(await tabAccounts()).toEqual(['Checking', 'Unsaved-Secret-Account'])
    // Stored under the NEW key with today's header: the old code opens nothing new.
    expect(names(await storedWith(key2))).toEqual(['Checking', 'Unsaved-Secret-Account'])
    await expect(storedWith(key1)).rejects.toThrow(/failed authentication/)
    expect(parseVaultBlob(row()!.data).prfSalt).toBe(local.localMode.vault!.header.prfSalt)
    const pin = serverDb.prepare("SELECT pin FROM vault_history WHERE owner_email = 'max@x' AND version = ?").get(at + 1) as { pin: string }
    expect(pin.pin).toBe('pre-restore')
  })

  it('front door, same key: opening the backup also unlocks the stored vault — one prompt — and the backup waits to be offered', async () => {
    const b2 = await session.makeBackup() // under key2, the stored vault's key
    local.exitLocalMode() // to the front door (reload is a no-op here)
    expect(local.localMode.active).toBe(false)
    const snap = await session.openBackup(session.parseBackup(b2.text, b2.name), { kind: 'recovery', code: code2 })
    expect(session.relationOf(snap)).toBeNull() // nothing to compare with before a session
    const r = await session.enterWithBackup(snap)
    expect(r.kind).toBe('unlocked')
    expect(session.relationOf(snap)).toEqual({ sameVault: true, sameKey: true }) // …and once the vault is open, it is this one
    expect(local.localMode.vault!.version).toBe(row()!.version)
    expect(session.pendingBackup()).toBe(snap)
    expect(session.follow.unlockedWith).toEqual({ kind: 'recovery' })
    session.setPendingBackup(null) // "Not now"
  })

  it('front door, another key: the vault stays locked and the backup waits; once unlocked, it restores', async () => {
    local.exitLocalMode()
    const snap = await session.openBackup(session.parseBackup(backup1.text, backup1.name), { kind: 'recovery', code: code1 })
    expect(await session.enterWithBackup(snap)).toEqual({ kind: 'locked' })
    expect(local.localMode.active).toBe(false)
    expect(session.pendingBackup()).toBe(snap)
    await session.unlockWithRecoveryCode(code2)
    expect(session.pendingBackup()).toBe(snap)
    expect(session.relationOf(snap)).toEqual({ sameVault: true, sameKey: false })
    await write('Extra')
    await session.saveVault()
    await session.restoreSnapshot(snap)
    expect(await tabAccounts()).toEqual(['Checking', 'Unsaved-Secret-Account'])
    expect(session.pendingBackup()).toBeNull()
  })

  it('no vault stored: the backup becomes the vault — same key, same passkeys — and never over one that appeared meanwhile', async () => {
    const b2 = await session.makeBackup()
    const vaultId = local.localMode.vault!.header.vaultId
    const del = await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(del.status).toBe(200)
    local.exitLocalMode()
    const snap = await session.openBackup(session.parseBackup(b2.text, b2.name), { kind: 'passkey' })
    expect(await session.enterWithBackup(snap)).toEqual({ kind: 'none' })

    // Someone creates a vault between the check and the upload: refused, nothing overwritten.
    net.beforePut = async () =>
      app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ data: '{"v":3}', version: 0 }) })
    await expect(session.restoreBackupAsVault(snap)).rejects.toThrow(/stored here in the meantime — nothing was overwritten/)
    expect(row()!.data).toBe('{"v":3}')
    await expect(session.restoreBackupAsVault(snap)).rejects.toThrow(/A vault is stored here \(v1\)/)
    await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })

    local.exitLocalMode()
    const r = await session.restoreBackupAsVault(snap)
    expect(r.version).toBe(1)
    // The same key (code2 opens it), the same vault id and passkeys; this device remembers it at seq 1.
    expect(names(await storedWith(key2))).toEqual(['Checking', 'Unsaved-Secret-Account']) // what the tab held when b2 was made
    const blob = parseVaultBlob(row()!.data) as VaultBlobV3
    expect(blob).toMatchObject({ vaultId, seq: 1 })
    expect(blob.keys.map((k) => k.label)).toEqual(['Max’s Mac'])
    expect(JSON.parse(local$.get(`scarab:seen:${vaultId}`)!)).toMatchObject({ seq: 1 })
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(session.follow.unlockedWith).toMatchObject({ kind: 'passkey', label: 'Max’s Mac' })
    // And it is an ordinary vault from here: a passkey unlock works, and it saves.
    local.exitLocalMode()
    await session.unlockVault()
    await write('After the restore')
    expect((await session.saveVault()).version).toBe(2)
  })
  it('a backup older than what this device saw is not put back as the vault without a yes — and never from before a re-key', async () => {
    const del = () =>
      app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    const vaultId = local.localMode.vault!.header.vaultId
    const seen = () => JSON.parse(local$.get(`scarab:seen:${vaultId}`)!) as { seq: number; prfSalt?: string }
    const older = await session.makeBackup() // sealed as v2, under key2
    await write('Newer than the backup')
    await session.saveVault() // v3: this device has seen the vault later than the backup
    expect(seen()).toMatchObject({ seq: 3, prfSalt: local.localMode.vault!.header.prfSalt })
    expect((await del()).status).toBe(200) // the server "lost" it — or is withholding it
    local.exitLocalMode()
    const snap = await session.openBackup(session.parseBackup(older.text, older.name), { kind: 'recovery', code: code2 })
    expect(await session.enterWithBackup(snap)).toEqual({ kind: 'none' })
    expect(session.backupBehind(snap)).toMatchObject({ seen: { seq: 3 }, sealedAs: 2, rekeyed: false })
    await expect(session.restoreBackupAsVault(snap)).rejects.toThrow(/saw this vault at v3, later than this backup \(v2\)/)
    expect(row()).toBeUndefined() // nothing uploaded
    expect(seen()).toMatchObject({ seq: 3 }) // …and the memory is untouched
    // Told, and said yes: the same key comes back (nothing was retired since), and the memory starts over from it.
    expect((await session.restoreBackupAsVault(snap, { overSeen: true })).version).toBe(1)
    expect(names(await storedWith(key2))).toEqual(['Checking', 'Unsaved-Secret-Account', 'After the restore'])
    expect(seen()).toMatchObject({ seq: 1 })

    // Now a backup, then a re-key, then the vault goes missing.
    const beforeRekey = await session.makeBackup()
    const code3 = (await session.rotateVault()).recoveryCode
    const rekeyed = seen()
    expect(rekeyed.prfSalt).not.toBe(envelope(beforeRekey.text).vault.prfSalt)
    expect((await del()).status).toBe(200)
    local.exitLocalMode()
    const pre = await session.openBackup(session.parseBackup(beforeRekey.text, beforeRekey.name), { kind: 'recovery', code: code2 })
    expect(await session.enterWithBackup(pre)).toEqual({ kind: 'none' })
    expect(session.backupBehind(pre)).toMatchObject({ seen: { seq: 2 }, sealedAs: 1, rekeyed: true })
    // Never as it was: that would bring back the retired key (code2 opens it) and the passkeys it listed.
    await expect(session.restoreBackupAsVault(pre, { overSeen: true })).rejects.toThrow(/re-keyed after this backup was sealed/)
    expect(row()).toBeUndefined()

    // A new vault from it: the data, under a fresh key and a new vault id; nothing the backup was sealed with opens it.
    const passkeysBefore = authn.creds.size
    const made = await session.newVaultFromBackup(pre, 'Max’s Mac')
    const key4 = await decodeRecoveryCode(made.recoveryCode)
    const blob = parseVaultBlob(row()!.data) as VaultBlobV3
    expect(blob.vaultId).not.toBe(vaultId)
    expect(names(await storedWith(key4))).toEqual(['Checking', 'Unsaved-Secret-Account', 'After the restore'])
    await expect(storedWith(key2)).rejects.toThrow(/failed authentication/)
    await expect(storedWith(await decodeRecoveryCode(code3))).rejects.toThrow(/failed authentication/)
    expect(authn.creds.size).toBe(passkeysBefore + 1) // a new passkey on this device, and only it
    expect(blob.keys).toHaveLength(1)
    expect(seen()).toEqual(rekeyed) // this device's memory of the old vault is as it was
    expect(session.pendingBackup()).toBeNull()
  })
})
