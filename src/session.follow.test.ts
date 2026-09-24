import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import {
  b64encode,
  b64urlEncode,
  decodeRecoveryCode,
  encodeRecoveryCode,
  newVault,
  openPayload,
  parseVaultBlob,
  sealVault,
  sessionHeader,
  type PasskeyWrap,
  type VaultHeader,
} from '../shared/vault'

/**
 * Following the other member's saves, through the real wiring: session.ts +
 * saveQueue.ts + the sql.js engine + the real Hono app in memory. This tab is
 * Max's; Nicole's device is simulated the way it would behave — it opens what
 * the server stores with the vault key, applies her edit, seals it for the
 * next version and uploads it as nicole@x (a household member).
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
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
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64) }
    },
    async assertPasskey(o: { prfSaltB64: string; credentialIds: string[] }) {
      const id = o.credentialIds.find((c) => authn.creds.has(c))
      if (!id) throw new Error('passkey prompt was cancelled or timed out')
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64) }
    },
  }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const reload = vi.fn()
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload, hostname: 'localhost' } }))
/** querySelector is set only while a test pretends a dialog is open. */
const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', querySelector: undefined as undefined | ((s: string) => unknown) })
vi.stubGlobal('document', doc)
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() {
    return m.size
  },
})
const session$ = new Map<string, string>()
const local$ = new Map<string, string>()
vi.stubGlobal('sessionStorage', storage(session$))
vi.stubGlobal('localStorage', storage(local$))

const as = (who: string) => ({ 'x-goog-authenticated-user-email': `accounts.google.com:${who}` })
type App = ReturnType<typeof import('../server/app').createApp>
let app: App
let serverDb: DbLike
/** Network conditions for this tab's fetches. */
const net = { offline: false, beforeVaultGet: null as null | (() => Promise<unknown>), holdPut: null as null | Promise<void> }
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (net.offline) throw new TypeError('Failed to fetch')
  if (url === '/api/vault' && (init?.method ?? 'GET') === 'GET' && net.beforeVaultGet) {
    const f = net.beforeVaultGet
    net.beforeVaultGet = null
    await f()
  }
  if (url === '/api/vault' && init?.method === 'PUT' && net.holdPut) await net.holdPut
  return app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...as('max@x') } })
})
vi.stubGlobal('fetch', fetchMock)

let session: typeof import('./session')
let local: typeof import('./local')
/** The vault's data key, as Nicole's device has it (from the recovery code). */
let key: Uint8Array
let vaultId = ''

type Row = { version: number; data: string; updated_by: string | null }
const row = () => serverDb.prepare("SELECT version, data, updated_by FROM vault_blobs WHERE owner_email = 'max@x'").get() as Row | undefined
const names = (d: Dump) => (d.tables.accounts ?? []).map((a) => a.name)
const stored = async (k = key) => JSON.parse(new TextDecoder().decode(await openPayload(parseVaultBlob(row()!.data), k))) as Dump
const tabAccounts = async () => names(await local.localDump())
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const seen = () => JSON.parse(local$.get(`scarab:seen:${vaultId}`) ?? 'null') as { seq: number } | null
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fetches = (path: string) => fetchMock.mock.calls.filter(([u]) => u === path).length

/** A wrapping another member's device added (its secret is theirs; this tab just carries it). */
const wrapFor = (label: string): PasskeyWrap => ({
  credentialId: b64urlEncode(new Uint8Array(randomBytes(16))),
  label,
  addedAt: new Date().toISOString(),
  wrappedKey: { iv: b64encode(new Uint8Array(randomBytes(12))), ct: b64encode(new Uint8Array(randomBytes(48))) },
})
const addAccount = (name: string) => (d: Dump) => {
  const rows = d.tables.accounts!
  rows.push({ ...rows[0]!, id: Math.max(...rows.map((a) => Number(a.id))) + 1, name })
}

/** Nicole says yes to Max's invitation, from her own device — the only way she becomes a member. */
async function nicoleAccepts() {
  const res = await app.request('/api/vault/invites/accept', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...as('nicole@x') },
    body: JSON.stringify({ household: 'max@x' }),
  })
  expect(res.status).toBe(200)
}

/** Nicole's device saves the next version: her edit on what is stored, sealed for version + 1, uploaded as her. */
async function nicoleSaves(edit: (d: Dump) => void, o: { header?: (h: VaultHeader) => VaultHeader; sealKey?: Uint8Array; data?: string } = {}) {
  const r = row()!
  let data = o.data
  if (!data) {
    const blob = parseVaultBlob(r.data)
    const dump = JSON.parse(new TextDecoder().decode(await openPayload(blob, key))) as Dump
    edit(dump)
    const h = sessionHeader(blob, 'localhost')
    data = JSON.stringify(await sealVault(o.header ? o.header(h) : h, o.sealKey ?? key, new TextEncoder().encode(JSON.stringify(dump)), r.version + 1))
  }
  const res = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...as('nicole@x') },
    body: JSON.stringify({ data, version: r.version }),
  })
  expect(res.status).toBe(200)
}

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  local.localMode.setIdentity('max@x') // App does this from /api/me
})
afterAll(() => vi.unstubAllGlobals())

describe('following the other member’s saves', () => {
  it('Max creates the vault and adds Nicole: the session knows who is in it and how it was opened', async () => {
    await session.startEmpty()
    await write('Checking')
    const r = await session.createVault('Max’s Mac')
    key = await decodeRecoveryCode(r.recoveryCode)
    vaultId = (parseVaultBlob(row()!.data) as { vaultId: string }).vaultId
    expect(session.follow.unlockedWith).toEqual({ kind: 'passkey', label: 'Max’s Mac', credentialId: expect.any(String) })
    expect(session.follow.remote).toMatchObject({ version: 1, by: 'max@x', keepsHistory: false })
    expect(session.follow.storedBytes).toBe(row()!.data.length)
    expect(row()!.updated_by).toBe('max@x')
    await session.addMember('nicole@x')
    // Invited, not yet a member: she has to say yes on her own device.
    await vi.waitFor(() => expect(session.follow.household).toEqual({ owner: 'max@x', members: [], invited: ['nicole@x'] }))
    const joined: import('./session').FollowEvent[] = []
    const stop = session.onFollow((e) => joined.push(e))
    await nicoleAccepts()
    await session.checkForUpdates() // the poll notices, since someone invited hadn't answered
    await vi.waitFor(() => expect(session.follow.household).toEqual({ owner: 'max@x', members: ['nicole@x'], invited: [] }))
    expect(joined).toEqual([{ kind: 'joined', emails: ['nicole@x'] }])
    stop()
    expect(session.follow.remote).toMatchObject({ version: 1, by: 'max@x', keepsHistory: true }) // the poll's answer
  })

  it('a clean tab follows her save in place: her data, the passkey she added, and who saved it', async () => {
    const events: import('./session').FollowEvent[] = []
    const off = session.onFollow((e) => events.push(e))
    const epoch = local.localMode.dataEpoch
    await nicoleSaves(addAccount('Nicole’s savings'), { header: (h) => ({ ...h, keys: [...h.keys, wrapFor('nicole-phone')] }) })
    await session.checkForUpdates()
    expect(local.localMode.vault).toMatchObject({ version: 2 })
    expect(local.localMode.dirty).toBe(false)
    expect(local.localMode.dataEpoch).toBeGreaterThan(epoch) // the screens remount on the new data
    expect(await tabAccounts()).toEqual(['Checking', 'Nicole’s savings'])
    expect(local.localMode.vault!.header.keys.map((k) => k.label)).toEqual(['Max’s Mac', 'nicole-phone'])
    expect(events).toEqual([{ kind: 'updated', version: 2, by: 'nicole@x', notice: null }])
    expect(session.follow.remote).toMatchObject({ version: 2, by: 'nicole@x' })
    expect(session.follow.attention).toBeNull()
    expect(seen()).toMatchObject({ seq: 2 })
    // Following it needs no save of its own…
    expect(await session.saveVault()).toMatchObject({ version: 2, skipped: true })
    // …and a check while in step is a heartbeat: one /api/mode, no blob download, nothing to say.
    const [modes, blobs] = [fetches('/api/mode'), fetches('/api/vault')]
    await session.checkForUpdates()
    expect([fetches('/api/mode') - modes, fetches('/api/vault') - blobs]).toEqual([1, 0])
    expect(events).toHaveLength(1)
    off()
  })

  it('mid-edit (a dialog open), it shows the banner instead of replacing the screens under the person', async () => {
    doc.querySelector = (sel: string) => (sel === 'dialog[open]' ? {} : null)
    try {
      await nicoleSaves(addAccount('Nicole v3'))
      await session.checkForUpdates()
      expect(session.follow.attention).toEqual({ kind: 'newer', version: 3 })
      expect(local.localMode.vault!.version).toBe(2)
    } finally {
      doc.querySelector = undefined
    }
    await session.checkForUpdates() // the dialog closed: the next check follows along
    expect(local.localMode.vault!.version).toBe(3)
    expect(session.follow.attention).toBeNull()
  })

  it('over unsaved work: the banner, a refused save, then Take theirs — never a dead end', async () => {
    await write('Mine')
    await nicoleSaves(addAccount('Nicole v4'))
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'newer', version: 4 })
    expect(local.localMode.dirty).toBe(true)
    expect(await tabAccounts()).toContain('Mine') // nothing replaced

    const modes = fetches('/api/mode')
    await expect(session.saveVault()).rejects.toMatchObject({ status: 409 })
    expect(session.autosave.status).toBe('conflict')
    await vi.waitFor(() => expect(fetches('/api/mode')).toBe(modes + 1)) // a refused save asks who saved what, at once

    await expect(session.refreshFromVault()).rejects.toBeInstanceOf(session.TabIsDirty)
    const r = await session.refreshFromVault({ discard: true })
    expect(r).toMatchObject({ version: 4, by: 'nicole@x', changed: true })
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault!.version).toBe(4)
    expect(await tabAccounts()).toEqual(['Checking', 'Nicole’s savings', 'Nicole v3', 'Nicole v4'])
    expect(session.autosave.status).toBe('idle')
    expect(session.follow.attention).toBeNull()
    await settle(1700) // the debounce from 'Mine' finds nothing left to save
    expect(row()!.version).toBe(4)
  })

  it('Keep mine: this tab’s copy goes on top of theirs, keeping the passkey they added', async () => {
    await write('Mine, kept')
    await nicoleSaves(addAccount('Nicole v5'), { header: (h) => ({ ...h, keys: [...h.keys, wrapFor('nicole-laptop')] }) })
    await expect(session.saveVault()).rejects.toMatchObject({ status: 409 })
    const r = await session.keepMine()
    expect(r).toMatchObject({ version: 6, skipped: false })
    expect(names(await stored())).toEqual(['Checking', 'Nicole’s savings', 'Nicole v3', 'Nicole v4', 'Mine, kept'])
    expect(parseVaultBlob(row()!.data).keys.map((k) => k.label)).toEqual(['Max’s Mac', 'nicole-phone', 'nicole-laptop'])
    expect(row()).toMatchObject({ version: 6, updated_by: 'max@x' })
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault).toMatchObject({ version: 6 })
    expect(local.localMode.vault!.header.keys.map((k) => k.label)).toContain('nicole-laptop')
    expect(session.autosave.status).toBe('idle')
    expect(seen()).toMatchObject({ seq: 6 })
    expect(session.follow.remote).toMatchObject({ version: 6, by: 'max@x' })
  })

  it('Take theirs waits for a save already uploading, so what it loads includes that save', async () => {
    await write('Held upload')
    let release = () => {}
    net.holdPut = new Promise<void>((r) => (release = r))
    const saving = session.saveVault()
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/vault' && i?.method === 'PUT')).toBe(true))
    const taking = session.refreshFromVault({ discard: true })
    await settle(20)
    net.holdPut = null
    release()
    expect(await saving).toMatchObject({ version: 7, skipped: false })
    expect(await taking).toMatchObject({ version: 7 })
    expect(await tabAccounts()).toContain('Held upload') // loaded after the upload, not from before it
    expect(names(await stored())).toContain('Held upload')
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault!.version).toBe(7)
  })

  it('an edit made while the vault downloads is never thrown away: the check backs off to the banner', async () => {
    await nicoleSaves(addAccount('Nicole v8'))
    net.beforeVaultGet = () => write('Typed meanwhile')
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'newer', version: 8 })
    expect(local.localMode.dirty).toBe(true)
    expect(local.localMode.vault!.version).toBe(7)
    expect(await tabAccounts()).toContain('Typed meanwhile')
    expect((await session.refreshFromVault({ discard: true })).version).toBe(8)
  })

  it('an older copy served as a newer version is not loaded on its own; opening it anyway asks first', async () => {
    const old = row()!.data // sealed as v8
    await write('Newest')
    await session.saveVault() // v9: this device has now seen seq 9
    await nicoleSaves(() => {}, { data: old }) // v10 holds the v8 copy
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'older', version: 10 })
    expect(local.localMode.vault!.version).toBe(9)
    const ask = vi.fn(async () => true)
    const r = await session.refreshFromVault({ discard: true, confirmRollback: ask })
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rollback', served: { version: 10, seq: 8, format: 3 } }))
    expect(r).toMatchObject({ version: 10, changed: true, notice: null }) // the person just confirmed it: no second notice
    expect(await tabAccounts()).not.toContain('Newest')
    expect(session.follow.attention).toBeNull()
  })

  it('a re-keyed vault is never resealed under the old key: Keep mine refuses, Take theirs locks to the front door', async () => {
    const fresh = newVault('localhost')
    await nicoleSaves(addAccount('After rotation'), {
      sealKey: fresh.rawDataKey,
      header: (h) => ({ ...fresh.header, vaultId: h.vaultId, keys: [wrapFor('nicole-phone')] }),
    })
    await write('Mine, again')
    await expect(session.keepMine()).rejects.toThrow(/re-keyed since this tab opened it/)
    expect(row()!.version).toBe(11)
    reload.mockClear()
    await expect(session.refreshFromVault({ discard: true })).rejects.toBeInstanceOf(session.SessionLocked)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(local.localMode.active).toBe(false)
    expect(session.takeLockNote()).toMatch(/re-keyed.*Unlock again/)
    expect(session.takeLockNote()).toMatch(/re-keyed/) // once per page load, however often it's asked (StrictMode)

    // The new recovery code opens it; the session says how it was opened.
    key = fresh.rawDataKey
    expect((await session.unlockWithRecoveryCode(await encodeRecoveryCode(key))).version).toBe(11)
    expect(session.follow.unlockedWith).toEqual({ kind: 'recovery' })
    expect(await tabAccounts()).toContain('After rotation')
  })

  it('a clean tab whose vault is re-keyed again locks on its own at the next check', async () => {
    const fresher = newVault('localhost')
    await nicoleSaves(addAccount('Rotated again'), {
      sealKey: fresher.rawDataKey,
      header: (h) => ({ ...fresher.header, vaultId: h.vaultId, keys: [wrapFor('nicole-phone')] }),
    })
    session$.delete('scarab:lock-note')
    reload.mockClear()
    await session.checkForUpdates()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(local.localMode.active).toBe(false)
    expect(session$.get('scarab:lock-note')).toMatch(/re-keyed/)
    key = fresher.rawDataKey
  })

  it('a deleted vault: the banner says so and nothing is loaded', async () => {
    await session.unlockWithRecoveryCode(await encodeRecoveryCode(key))
    expect(await session.saveVault()).toMatchObject({ skipped: true }) // the unlock's baseline is recorded: nothing queued
    const del = await app.request('/api/vault', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...as('max@x') },
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    expect(del.status).toBe(200)
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'gone', version: null })
    expect(session.follow.remote).toBeNull()
    expect(local.localMode.vault!.version).toBe(12)
    await expect(session.refreshFromVault({ discard: true })).rejects.toBeInstanceOf(session.VaultGone)
  })

  it('Lock saves unsaved work first; a save that fails locks nothing', async () => {
    local.exitLocalMode()
    await session.startEmpty()
    await session.createVault('Max’s Mac')
    key = local.localMode.vault!.rawDataKey
    await write('Before locking')
    reload.mockClear()
    net.offline = true
    await expect(session.lockVault()).rejects.toThrow(/couldn’t reach the server/)
    expect(local.localMode.active).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    net.offline = false
    await session.lockVault()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(row()!.version).toBe(2)
  })

  it('a newer version that fails to load is never silent: the banner offers it, and loading it says why', async () => {
    await session.unlockWithRecoveryCode(await encodeRecoveryCode(key))
    expect(await session.saveVault()).toMatchObject({ version: 2, skipped: true })
    await session.addMember('nicole@x') // deleting the vault earlier removed her membership
    await nicoleAccepts()
    await nicoleSaves((d) => {
      const rows = d.tables.accounts!
      rows.push({ ...rows[0]!, id: 999, nickname: 'a column this schema lacks' })
    })
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'newer', version: 3 })
    expect(local.localMode).toMatchObject({ dirty: false })
    expect(local.localMode.vault!.version).toBe(2)
    expect(await tabAccounts()).toEqual(['Before locking']) // untouched: the snapshot is checked before any write
    await expect(session.refreshFromVault()).rejects.toThrow(/nickname/)
    // Her next save loads fine, and the notice goes with it.
    await nicoleSaves((d) => void (d.tables.accounts = d.tables.accounts!.filter((a) => a.id !== 999)))
    await session.checkForUpdates()
    expect(local.localMode.vault!.version).toBe(4)
    expect(session.follow.attention).toBeNull()
  })

  it('a vault deleted and created again up to this tab’s version: noticed, never overwritten, and Take theirs locks', async () => {
    expect(local.localMode.vault!.version).toBe(4)
    const del = await app.request('/api/vault', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...as('max@x') },
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    expect(del.status).toBe(200)
    // Start over on another device: a new key, and four saves — v4 again, another blob.
    const other = newVault('localhost')
    for (let v = 0; v < 4; v++) {
      const data = JSON.stringify(await sealVault(other.header, other.rawDataKey, new TextEncoder().encode(`{"n":${v}}`), v + 1))
      const res = await app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ data, version: v }) })
      expect(res.status).toBe(200)
    }
    const theirs = row()!.data
    await session.checkForUpdates()
    expect(session.follow.attention).toEqual({ kind: 'gone', version: 4 }) // same number, not the blob this tab knows
    await write('Stale tab edit')
    await expect(session.saveVault()).rejects.toMatchObject({ status: 409 })
    expect(row()).toMatchObject({ version: 4, data: theirs }) // the new vault is untouched
    expect(session.autosave.status).toBe('conflict')
    reload.mockClear()
    await expect(session.refreshFromVault({ discard: true })).rejects.toBeInstanceOf(session.SessionLocked)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ version: 4, data: theirs })
  })
  it('Keep mine over an older copy than this device saw: it asks first, then keeps this tab’s passkey list — a removed passkey stays removed', async () => {
    const del = await app.request('/api/vault', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', ...as('max@x') },
      body: JSON.stringify({ confirm: 'DELETE' }),
    })
    expect(del.status).toBe(200)
    await session.startEmpty()
    await write('Checking')
    key = await decodeRecoveryCode((await session.createVault('Max’s Mac')).recoveryCode)
    vaultId = (parseVaultBlob(row()!.data) as { vaultId: string }).vaultId
    await session.addMember('nicole@x')
    await nicoleAccepts()
    const laptop = await session.addPasskey('Lost laptop') // v2
    await write('a')
    await session.saveVault() // v3
    const old = row()!.data // sealed as v3, and it lists the laptop
    await session.removePasskey(laptop.credentialId) // v4: the laptop is off the vault (no re-key)
    await write('b')
    await session.saveVault() // v5: this device has seen seq 5
    await nicoleSaves(() => {}, { data: old }) // v6 holds the v3 copy: a server restored from backup, or a replay
    await write('Unsaved')
    await expect(session.saveVault()).rejects.toMatchObject({ status: 409 })

    await expect(session.keepMine()).rejects.toBeInstanceOf(session.RollbackRefused) // nobody to ask: refused
    const no = vi.fn(async () => false)
    await expect(session.keepMine({ confirmRollback: no })).rejects.toBeInstanceOf(session.RollbackRefused)
    expect(no).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rollback', seen: expect.objectContaining({ seq: 5 }), served: { version: 6, seq: 3, format: 3 } }))
    expect(row()!.version).toBe(6) // nothing saved
    expect(local.localMode.dirty).toBe(true)

    const yes = vi.fn(async () => true)
    expect(await session.keepMine({ confirmRollback: yes })).toMatchObject({ version: 7, skipped: false })
    expect(parseVaultBlob(row()!.data).keys.map((k) => k.label)).toEqual(['Max’s Mac']) // not the older copy's list
    expect(local.localMode.vault!.header.keys.map((k) => k.label)).toEqual(['Max’s Mac'])
    expect(names(await stored())).toEqual(['Checking', 'a', 'b', 'Unsaved'])
    expect(seen()).toMatchObject({ seq: 7 })
    expect(local.localMode.dirty).toBe(false)
  })

  it('a re-key noticed while an edit lands mid-download keeps the tab open with the banner; Take theirs is what locks', async () => {
    expect(local.localMode.dirty).toBe(false)
    const fresh = newVault('localhost')
    await nicoleSaves(addAccount('Re-keyed elsewhere'), {
      sealKey: fresh.rawDataKey,
      header: (h) => ({ ...fresh.header, vaultId: h.vaultId, keys: [wrapFor('nicole-phone')] }),
    })
    net.beforeVaultGet = () => write('Typed meanwhile')
    reload.mockClear()
    await session.checkForUpdates() // clean at the check, so it loads — and the edit lands while the blob downloads
    expect(reload).not.toHaveBeenCalled()
    expect(local.localMode.active).toBe(true)
    expect(local.localMode.dirty).toBe(true)
    expect(await tabAccounts()).toContain('Typed meanwhile')
    expect(session.follow.attention).toEqual({ kind: 'newer', version: 8 }) // the sheet offers Download mine
    await expect(session.refreshFromVault()).rejects.toBeInstanceOf(session.TabIsDirty) // "Load it" without discarding: still refused
    expect(reload).not.toHaveBeenCalled()
    await expect(session.refreshFromVault({ discard: true })).rejects.toBeInstanceOf(session.SessionLocked) // the person chose to discard
    expect(reload).toHaveBeenCalledTimes(1)
    expect(local.localMode.active).toBe(false)
    key = fresh.rawDataKey
  })
})
