import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import { b64urlEncode, decodeRecoveryCode, openPayload, parseVaultBlob, sealVault, sessionHeader } from '../shared/vault'
import { countRows } from './screens/vault/versions'

/**
 * Vault history end to end (Z8): the real session.ts + saveQueue.ts + sql.js
 * engine + the Hono app in memory. Every save keeps the version it replaced;
 * a kept version opens with the session key, compares with the tab, and can
 * be restored — as the next version, sealed under the current key and
 * header, with the version it replaced kept pinned.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

// One snapshot version back is readable here, with a no-op tier-C upgrade: how a real upgrade will look to the session.
vi.mock('../engine/upgrades', async (importOriginal) => {
  const real = await importOriginal<typeof import('../engine/upgrades')>()
  return { ...real, SNAPSHOT_COMPAT: { minReadable: real.CURRENT_VERSION - 1, upgrades: { [real.CURRENT_VERSION]: { after: () => {} } } } }
})

// A fake authenticator: each credential holds a secret; its PRF output is HMAC(secret, salt).
const authn = vi.hoisted(() => ({ creds: new Map<string, Buffer>() }))
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
const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
  app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...as('max@x') } }),
)
vi.stubGlobal('fetch', fetchMock)

let session: typeof import('./session')
let local: typeof import('./local')
let key: Uint8Array
let code = ''

type Row = { version: number; data: string }
const row = () => serverDb.prepare("SELECT version, data FROM vault_blobs WHERE owner_email = 'max@x'").get() as Row
const stored = async (k = key) => JSON.parse(new TextDecoder().decode(await openPayload(parseVaultBlob(row().data), k))) as Dump
const names = (d: Dump) => (d.tables.accounts ?? []).map((a) => a.name)
const tabAccounts = async () => names(await local.localDump())
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const puts = () => fetchMock.mock.calls.filter(([u, i]) => u === '/api/vault' && i?.method === 'PUT').length
const pins = () =>
  Object.fromEntries(
    (serverDb.prepare("SELECT version, pin FROM vault_history WHERE owner_email = 'max@x'").all() as { version: number; pin: string | null }[]).map((r) => [r.version, r.pin]),
  )
const historyVersions = async () => (await session.fetchHistory()).entries.map((e) => e.version)

/** Another device of the household saves the next version: an edit on what is stored, sealed for version + 1. */
async function otherDeviceSaves(edit: (d: Dump) => void, who = 'nicole@x') {
  const r = row()
  const blob = parseVaultBlob(r.data)
  const dump = JSON.parse(new TextDecoder().decode(await openPayload(blob, key))) as Dump
  edit(dump)
  const data = JSON.stringify(await sealVault(sessionHeader(blob, 'localhost'), key, new TextEncoder().encode(JSON.stringify(dump)), r.version + 1))
  const res = await app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json', ...as(who) }, body: JSON.stringify({ data, version: r.version }) })
  expect(res.status).toBe(200)
}
const addAccount = (name: string) => (d: Dump) => {
  const rows = d.tables.accounts!
  rows.push({ ...rows[0]!, id: Math.max(...rows.map((a) => Number(a.id))) + 1, name })
}

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  local.localMode.setIdentity('max@x')
})
afterAll(() => vi.unstubAllGlobals())

describe('vault history (Z8)', () => {
  it('every save keeps the version it replaced; a kept version opens with the session key and compares with the tab — nothing changes', async () => {
    await session.startEmpty()
    await write('Checking')
    const r = await session.createVault('Max’s Mac')
    code = r.recoveryCode
    key = await decodeRecoveryCode(code)
    await write('Savings')
    await session.saveVault()
    await write('Brokerage')
    await session.saveVault()
    expect(row().version).toBe(3)
    const h = await session.fetchHistory()
    expect(h.entries.map((e) => [e.version, e.updated_by, e.pin])).toEqual([
      [2, 'max@x', null],
      [1, 'max@x', null],
    ])
    expect(h.bytes).toBe(h.entries.reduce((n, e) => n + e.size, 0))
    expect(h.policy).toMatchObject({ keepLast: 20, dailyDays: 30 })

    const before = puts()
    const snap = await session.openHistoryVersion(1)
    expect(snap.source).toMatchObject({ kind: 'history', version: 1, sealedAs: 1, by: 'max@x', pin: null })
    expect(snap.unreadable).toBeNull()
    expect(snap.counts!.accounts).toBe(1)
    expect(names(snap.dump)).toEqual(['Checking'])
    // Looking changes nothing: no upload, the tab still holds v3 and is clean.
    expect(puts()).toBe(before)
    expect(await tabAccounts()).toEqual(['Checking', 'Savings', 'Brokerage'])
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault!.version).toBe(3)
    expect(countRows(await local.localDump()).accounts).toBe(3)
  })

  it('restore: the data comes back as the next version, under the current key and header; the version it replaced is kept, pinned', async () => {
    await session.addPasskey('Max’s phone') // v4: a header change after v1
    expect(row().version).toBe(4)
    const epoch = local.localMode.dataEpoch
    const r = await session.restoreSnapshot(await session.openHistoryVersion(1))
    expect(r).toEqual({ version: 5, pinned: 4, skipped: false })
    expect(await tabAccounts()).toEqual(['Checking'])
    expect(local.localMode.dataEpoch).toBeGreaterThan(epoch) // the screens remount on the restored data
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault!.version).toBe(5)
    // What the server stores: v1's data, sealed for v5 under the same key, with today's header (the phone passkey stays).
    expect(names(await stored())).toEqual(['Checking'])
    const blob = parseVaultBlob(row().data)
    expect(blob.v === 3 && blob.seq).toBe(5)
    expect(blob.keys.map((k) => k.label)).toEqual(['Max’s Mac', 'Max’s phone'])
    expect(pins()).toMatchObject({ 4: 'pre-restore' })
    expect(JSON.parse(local$.get(`scarab:seen:${blob.v === 3 ? blob.vaultId : ''}`)!)).toMatchObject({ seq: 5 })

    // …and the restore itself can be undone: v4 is right there.
    await session.restoreSnapshot(await session.openHistoryVersion(4))
    expect(await tabAccounts()).toEqual(['Checking', 'Savings', 'Brokerage'])
    expect(row().version).toBe(6)
    expect(pins()).toMatchObject({ 4: 'pre-restore', 5: 'pre-restore' })
    // An ordinary save afterwards pins nothing.
    await write('After')
    await session.saveVault()
    expect(pins()[6]).toBeNull()
  })

  it('unsaved work is saved first, as a version of its own; identical data uploads nothing and pins nothing', async () => {
    await write('Unsaved')
    const at = row().version // 7
    const r = await session.restoreSnapshot(await session.openHistoryVersion(1))
    expect(r).toEqual({ version: at + 2, pinned: at + 1, skipped: false })
    await expect(session.openHistoryVersion(at + 1).then((s) => names(s.dump))).resolves.toContain('Unsaved')
    expect(pins()[at + 1]).toBe('pre-restore')

    const before = puts()
    const same = await session.restoreSnapshot(await session.openHistoryVersion(1)) // the tab already holds v1's data
    expect(same).toMatchObject({ skipped: true, pinned: null, version: at + 2 })
    expect(puts()).toBe(before)
    expect(local.localMode).toMatchObject({ dirty: false })
    await write('Next')
    await session.saveVault()
    expect(pins()[at + 2]).toBeNull() // the skipped restore's pin didn't ride on this save
  })

  it('a version this engine can’t load is shown as such, and restoring it is refused with nothing changed', async () => {
    const r = row()
    const blob = parseVaultBlob(r.data)
    const newer = { ...(await stored()), schemaVersion: 999 }
    const data = JSON.stringify(await sealVault(sessionHeader(blob, 'localhost'), key, new TextEncoder().encode(JSON.stringify(newer)), 1))
    serverDb
      .prepare("INSERT INTO vault_history (owner_email, version, sha256, size, data, updated_at) VALUES ('max@x', 0, 'x', ?, ?, datetime('now'))")
      .run(data.length, data)
    const snap = await session.openHistoryVersion(0)
    expect(snap.counts).toBeNull()
    expect(snap.unreadable).toMatch(/newer than this engine/)
    const [before, tab] = [puts(), await tabAccounts()]
    await expect(session.restoreSnapshot(snap)).rejects.toThrow(/can’t load it/)
    expect([puts(), await tabAccounts(), local.localMode.dirty]).toEqual([before, tab, false])
    serverDb.prepare("DELETE FROM vault_history WHERE owner_email = 'max@x' AND version = 0").run()
  })

  it('the server can’t pass one version off as another, nor slip in an altered or foreign one', async () => {
    const [v1, v2] = [1, 2].map(
      (v) => (serverDb.prepare("SELECT data FROM vault_history WHERE owner_email = 'max@x' AND version = ?").get(v) as { data: string } | undefined)?.data,
    )
    if (!v1 || !v2) throw new Error('v1 and v2 should still be kept')
    const put = (v: number, data: string) => serverDb.prepare("UPDATE vault_history SET data = ? WHERE owner_email = 'max@x' AND version = ?").run(data, v)
    try {
      // v2's blob served as v1: it opens (same key), and its authenticated seq says what it really is.
      put(1, v2)
      expect((await session.openHistoryVersion(1)).source).toMatchObject({ version: 1, sealedAs: 2 })
      // A relabelled passkey in the header, a flipped payload byte, or a blob sealed under another key: never opens.
      const b = JSON.parse(v1)
      put(1, JSON.stringify({ ...b, keys: b.keys.map((k: { label: string }) => ({ ...k, label: 'evil' })) }))
      await expect(session.openHistoryVersion(1)).rejects.toThrow(/doesn’t open with this session’s key/)
      const ct: string = b.payload.ct
      put(1, JSON.stringify({ ...b, payload: { ...b.payload, ct: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) } }))
      await expect(session.openHistoryVersion(1)).rejects.toThrow(/doesn’t open with this session’s key/)
      const foreign = await sealVault(sessionHeader(parseVaultBlob(v1), 'localhost'), new Uint8Array(randomBytes(32)), new TextEncoder().encode('{}'), 1)
      put(1, JSON.stringify(foreign))
      await expect(session.openHistoryVersion(1)).rejects.toThrow(/doesn’t open with this session’s key/)
    } finally {
      put(1, v1)
    }
    await expect(session.openHistoryVersion(99)).rejects.toThrow(/not in this vault’s history/)
  })

  it('a restore racing another member’s save is loaded but not saved, and the conflict sheet’s Keep mine keeps it', async () => {
    await session.addMember('nicole@x')
    // …and she accepts on her own device: invitations are consent-based.
    expect(
      (
        await app.request('/api/vault/invites/accept', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...as('nicole@x') },
          body: JSON.stringify({ household: 'max@x' }),
        })
      ).status,
    ).toBe(200)
    const snap = await session.openHistoryVersion(1)
    await otherDeviceSaves(addAccount('Nicole’s'))
    await expect(session.restoreSnapshot(snap)).rejects.toThrow(/moved on meanwhile/)
    expect(await tabAccounts()).toEqual(['Checking'])
    expect(local.localMode.dirty).toBe(true)
    expect(session.autosave.status).toBe('conflict')
    await session.checkForUpdates()
    expect(session.follow.remote).toMatchObject({ by: 'nicole@x', keepsHistory: true }) // Keep mine is offered now
    const theirs = row().version
    const r = await session.keepMine()
    expect(r.version).toBe(theirs + 1)
    expect(names(await stored())).toEqual(['Checking'])
    expect(await session.openHistoryVersion(theirs).then((s) => names(s.dump))).toContain('Nicole’s') // theirs is kept
  })

  it('an unlock that upgrades the snapshot pins the copy the older engine wrote, on the save that rewrites it', async () => {
    const { CURRENT_VERSION } = await import('../engine/upgrades')
    await otherDeviceSaves((d) => {
      d.schemaVersion = CURRENT_VERSION - 1 // an older engine wrote this one
    })
    const older = row().version
    local.exitLocalMode() // back to the front door (reload is a no-op here)
    const u = await session.unlockWithRecoveryCode(code)
    expect(u.loaded.upgraded).toEqual([CURRENT_VERSION])
    expect(local.localMode.dirty).toBe(true) // the stored copy is still the older one
    await session.saveVault()
    expect(row().version).toBe(older + 1)
    expect(pins()[older]).toBe('pre-upgrade')
    expect((await stored()).schemaVersion).toBe(CURRENT_VERSION)
    await write('Later')
    await session.saveVault()
    expect(pins()[older + 1]).toBeNull()
  })

  it('re-keying deletes the history: it is sealed under the key being retired', async () => {
    expect((await historyVersions()).length).toBeGreaterThan(3)
    await session.rotateVault()
    expect(await historyVersions()).toEqual([])
    await write('After rotation')
    await session.saveVault()
    expect(await historyVersions()).toEqual([row().version - 1])
  })
})
