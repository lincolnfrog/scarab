import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import { encodeRecoveryCode, newVault, openPayload, parseVaultBlob, sealVault, type VaultHeader } from '../shared/vault'

/**
 * The real session wiring, end to end in node: session.ts + saveQueue.ts +
 * the in-tab engine (sql.js) + the real server app (better-sqlite3, in
 * memory), with fetch routed straight into Hono. No passkeys: the vault is
 * opened with its recovery code, the way the browser verifies it too.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

// Just enough browser: events on window and document, a reload to observe, a hostname, sessionStorage and localStorage.
const reload = vi.fn()
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload, hostname: 'localhost' } }))
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
const store = new Map<string, string>()
vi.stubGlobal('sessionStorage', storage(store))
vi.stubGlobal('localStorage', storage(new Map()))

type App = ReturnType<typeof import('../server/app').createApp>
let app: App
let serverDb: DbLike
/** Network conditions for the tab's fetches. */
const net = { offline: false, loseNextPut: false, puts: 0 }
const IDENTITY = { 'x-goog-authenticated-user-email': 'accounts.google.com:max@x' }

vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (net.offline) throw new TypeError('Failed to fetch')
  const r = await app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...IDENTITY } })
  if (init?.method === 'PUT' && url === '/api/vault') {
    net.puts++
    if (net.loseNextPut) {
      net.loseNextPut = false
      throw new TypeError('network connection was lost') // it landed; the tab never hears
    }
  }
  return r
})

let session: typeof import('./session')
let local: typeof import('./local')
let key: Uint8Array
let code: string

/** What the server holds, decrypted with the vault key. */
async function stored(): Promise<{ version: number; dump: Dump }> {
  const row = serverDb.prepare("SELECT version, data FROM vault_blobs WHERE owner_email = 'max@x'").get() as { version: number; data: string }
  const blob = parseVaultBlob(row.data)
  return { version: row.version, dump: JSON.parse(new TextDecoder().decode(await openPayload(blob, key))) as Dump }
}
const accounts = (d: Dump) => (d.tables.accounts ?? []).map((a) => a.name)
let header: VaultHeader
/** Store a vault over whatever is there, sealed under `key` for the version it will be, as another device would. */
async function storeFromElsewhere(dump: Dump, version: number) {
  const blob = await sealVault(header, key, new TextEncoder().encode(JSON.stringify(dump)), version + 1)
  const r = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...IDENTITY },
    body: JSON.stringify({ data: JSON.stringify(blob), version }),
  })
  expect(r.status).toBe(200)
}
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  // A vault made elsewhere: the server's empty schema, sealed under a fresh key.
  const { dumpDb } = await import('../engine/snapshot')
  const fresh = newVault('localhost')
  key = fresh.rawDataKey
  header = fresh.header
  code = await encodeRecoveryCode(key)
  await storeFromElsewhere(dumpDb(serverDb), 0)
})
afterAll(() => vi.unstubAllGlobals())

describe('the session, wired to the real server', () => {
  it('unlocks with the recovery code, and a save before any edit uploads nothing', async () => {
    const r = await session.unlockWithRecoveryCode(code)
    expect(r.version).toBe(1)
    expect(local.localMode).toMatchObject({ active: true, dirty: false })
    const saved = await session.saveVault()
    expect(saved).toMatchObject({ version: 1, skipped: true })
    expect(net.puts).toBe(0)
  })

  it('autosaves 1.5s after a write; the client and server agree on the hash', async () => {
    await write('Checking')
    expect(local.localMode.dirty).toBe(true)
    await vi.waitFor(() => expect(local.localMode.dirty).toBe(false), { timeout: 4000 })
    const s = await stored()
    expect(s.version).toBe(2)
    expect(accounts(s.dump)).toEqual(['Checking'])
    expect(session.autosave.status).toBe('idle')
    expect(local.localMode.vault!.version).toBe(2)
  })

  it('offline: retries by itself, and saves the moment the browser is back online', async () => {
    net.offline = true
    await write('Savings')
    await vi.waitFor(() => expect(session.autosave.status).toBe('retrying'), { timeout: 4000 })
    expect(session.autosave.error).toMatch(/couldn’t reach the server/)
    net.offline = false
    window.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(session.autosave.status).toBe('idle'), { timeout: 2000 })
    expect(local.localMode.dirty).toBe(false)
    const s = await stored()
    expect(s.version).toBe(3)
    expect(accounts(s.dump)).toEqual(['Checking', 'Savings'])
  })

  it('a lost response is adopted through the server’s serverSha256, not reported as a conflict', async () => {
    net.loseNextPut = true
    await write('Brokerage cash')
    await vi.waitFor(() => expect(session.autosave.status).toBe('retrying'), { timeout: 4000 })
    expect((await stored()).version).toBe(4) // it landed
    expect(local.localMode.vault!.version).toBe(3)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(session.autosave.status).toBe('idle'), { timeout: 2000 })
    expect(local.localMode.vault!.version).toBe(4)
    expect(local.localMode.dirty).toBe(false)
    expect((await stored()).version).toBe(4) // adopted, nothing re-sent
  })

  it('another device saving first makes the next save a sticky conflict', async () => {
    const theirs = (await stored()).dump
    await storeFromElsewhere(theirs, 4) // v5, not from this tab
    const puts = net.puts
    await write('Mine')
    await vi.waitFor(() => expect(session.autosave.status).toBe('conflict'), { timeout: 4000 })
    await write('More of mine')
    window.dispatchEvent(new Event('online'))
    await settle(1800)
    expect(net.puts).toBe(puts + 1) // no retries
    expect(session.autosave.status).toBe('conflict')
    expect(local.localMode.dirty).toBe(true)
  })

  it('creating a vault refuses before any passkey prompt when one is stored', async () => {
    local.exitLocalMode() // reload is stubbed; the tab's engine is gone
    expect(reload).toHaveBeenCalledTimes(1)
    await session.startEmpty()
    await expect(session.createVault('Max’s Mac')).rejects.toThrow(/already stored here \(v5\)/)
    await expect(session.createVault('Max’s Mac', { replace: 4 })).rejects.toThrow(/changed since you confirmed/)
    expect((await stored()).version).toBe(5)
  })

  it('a vault saved by a newer Scarab reloads the page once, then says what to do', async () => {
    const newer = { ...(await stored()).dump, schemaVersion: 99 }
    await storeFromElsewhere(newer, 5)
    reload.mockClear()
    void session.unlockWithRecoveryCode(code) // never settles: the page is going away
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(store.has('scarab:reloaded-for-newer-vault')).toBe(true)
    // Straight after that reload, the same vault: no second reload.
    await expect(session.unlockWithRecoveryCode(code)).rejects.toThrow(/newer version of Scarab.*reloading didn’t bring one/)
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
