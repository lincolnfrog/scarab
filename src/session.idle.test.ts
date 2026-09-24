import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { encodeRecoveryCode, newVault, sealVault } from '../shared/vault'

/**
 * Idle auto-lock (Z12) through the real wiring: session.ts + saveQueue.ts +
 * the in-tab engine (sql.js) + the real server app, with fetch routed into
 * Hono and only the clock faked. The vault is opened with its recovery code.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

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
const local$ = new Map<string, string>()
vi.stubGlobal('sessionStorage', storage(new Map()))
vi.stubGlobal('localStorage', storage(local$))

type App = ReturnType<typeof import('../server/app').createApp>
let app: App
let serverDb: DbLike
const net = { offline: false }
const IDENTITY = { 'x-goog-authenticated-user-email': 'accounts.google.com:max@x' }
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  if (net.offline) throw new TypeError('Failed to fetch')
  return app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...IDENTITY } })
})

let session: typeof import('./session')
let local: typeof import('./local')
let code: string
const MIN = 60_000
const version = () => (serverDb.prepare("SELECT version FROM vault_blobs WHERE owner_email = 'max@x'").get() as { version: number }).version
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  const { dumpDb } = await import('../engine/snapshot')
  const fresh = newVault('localhost')
  code = await encodeRecoveryCode(fresh.rawDataKey)
  const blob = await sealVault(fresh.header, fresh.rawDataKey, new TextEncoder().encode(JSON.stringify(dumpDb(serverDb))), 1)
  const r = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...IDENTITY },
    body: JSON.stringify({ data: JSON.stringify(blob), version: 0 }),
  })
  expect(r.status).toBe(200)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.parse('2026-09-23T12:00:00Z'))
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('idle auto-lock, wired to the real session', () => {
  it('is off until chosen; the setting is this device’s (localStorage) and only takes the listed values', () => {
    expect(session.idleLockMinutes()).toBeNull()
    session.setIdleLockMinutes(60)
    expect(local$.get('scarab:idle-lock')).toBe('60')
    expect(session.idleLockMinutes()).toBe(60)
    local$.set('scarab:idle-lock', '7') // tampered or from a future version: never
    expect(session.idleLockMinutes()).toBeNull()
    session.setIdleLockMinutes(null)
    expect(local$.has('scarab:idle-lock')).toBe(false)
  })

  it('after the chosen minutes without input: saves what is unsaved, locks, and the front door says why', async () => {
    await session.unlockWithRecoveryCode(code)
    session.setIdleLockMinutes(15)
    expect(await session.idleLock.check()).toBe('idle') // the session's start starts the clock
    await write('Checking')
    vi.setSystemTime(Date.now() + 14 * MIN)
    window.dispatchEvent(new Event('keydown')) // someone typed: the clock starts over
    vi.setSystemTime(Date.now() + 14 * MIN)
    expect(await session.idleLock.check()).toBe('idle')
    expect(reload).not.toHaveBeenCalled()
    const before = version()
    vi.setSystemTime(Date.now() + MIN)
    expect(await session.idleLock.check()).toBe('locked')
    expect(version()).toBe(before + 1) // the unsaved write went into the vault first
    expect(reload).toHaveBeenCalledTimes(1)
    expect(session.takeLockNote()).toMatch(/Locked after 15 minutes without activity/)
  })

  it('never over unsaved work: a save that fails locks nothing and the banner says why — then it locks once the save goes through', async () => {
    reload.mockClear()
    await session.unlockWithRecoveryCode(code)
    expect(await session.idleLock.check()).toBe('idle')
    net.offline = true
    await write('Savings')
    const before = version()
    vi.setSystemTime(Date.now() + 15 * MIN)
    expect(await session.idleLock.check()).toBe('blocked')
    expect(reload).not.toHaveBeenCalled()
    expect(local.localMode).toMatchObject({ active: true, dirty: true })
    expect(session.follow.idleBlocked).toMatch(/Didn’t lock after 15 minutes idle: .* the server couldn’t be reached\. They’re still in this tab\./)
    net.offline = false
    vi.setSystemTime(Date.now() + MIN)
    expect(await session.idleLock.check()).toBe('locked')
    expect(version()).toBe(before + 1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a save that lands on its own clears the banner', async () => {
    reload.mockClear()
    await session.unlockWithRecoveryCode(code)
    expect(await session.idleLock.check()).toBe('idle')
    net.offline = true
    await write('Brokerage')
    vi.setSystemTime(Date.now() + 15 * MIN)
    expect(await session.idleLock.check()).toBe('blocked')
    expect(session.follow.idleBlocked).not.toBeNull()
    net.offline = false
    window.dispatchEvent(new Event('pointerdown')) // the person is back
    await session.saveVault()
    expect(session.follow.idleBlocked).toBeNull()
    expect(await session.idleLock.check()).toBe('idle') // they just did something
    session.setIdleLockMinutes(null)
  })
})
