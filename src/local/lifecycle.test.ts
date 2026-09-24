import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Entering and leaving the in-tab engine (src/local.ts): re-entry frees the
 * database it replaces, and the front door's household hatch ends a session
 * that booted behind it — landing the reload in household mode, once.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

const reload = vi.fn()
const store = new Map<string, string>()
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload } }))
vi.stubGlobal('sessionStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})
afterAll(() => vi.unstubAllGlobals())

/** A fresh local.ts, as a page load finds it. */
const load = async () => {
  vi.resetModules()
  return import('../local')
}

beforeEach(() => {
  reload.mockClear()
  store.clear()
})

describe('entering local mode again', () => {
  it('closes the database it replaces (a Create vault that failed, then another try)', async () => {
    const local = await load()
    const { openBrowserDb } = await import('../../engine/sqljs-db')
    const closes: string[] = []
    let opened = 0
    vi.doMock('../../engine/sqljs-db', () => ({
      openBrowserDb: async (o: Parameters<typeof openBrowserDb>[0]) => {
        const db = await openBrowserDb(o)
        const name = `db${opened++}`
        const close = db.close.bind(db)
        db.close = () => {
          closes.push(name)
          close()
        }
        return db
      },
    }))
    await local.enterLocalMode(null)
    await local.localDispatch('POST', '/api/accounts', { name: 'First', kind: 'checking' })
    expect(closes).toEqual([])
    await local.enterLocalMode(null)
    expect(closes).toEqual(['db0'])
    // The new database is the one answering, and it starts empty.
    expect(await local.localDispatch('GET', '/api/accounts')).toEqual([])
    vi.doUnmock('../../engine/sqljs-db')
  })
})

describe('the household hatch with a session running behind the front door', () => {
  it('ends the session with a reload that lands in household mode', async () => {
    const local = await load()
    await local.enterLocalMode(null)
    expect(local.localMode.active).toBe(true)
    local.exitToHousehold()
    expect(local.localMode.active).toBe(false)
    expect(local.localMode.dirty).toBe(false) // no "leave site?" prompt for an empty session
    expect(reload).toHaveBeenCalledTimes(1)

    const next = await load() // the reloaded page
    expect(next.takeHouseholdChoice()).toBe(true)
    expect(next.takeHouseholdChoice()).toBe(true) // stable for the life of the load (StrictMode re-runs initializers)
    const after = await load() // and a later reload asks again
    expect(after.takeHouseholdChoice()).toBe(false)
  })

  it('a load that did not follow the hatch is not household by choice', async () => {
    const local = await load()
    expect(local.takeHouseholdChoice()).toBe(false)
  })
})
