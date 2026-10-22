import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The sample household as a session (src/local.ts enterSampleMode): built in
 * the tab, clean, and never given a vault — so it has nothing to seal, queue
 * or upload, and leaving it asks nothing.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

const reload = vi.fn()
const replaced: unknown[][] = []
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload } }))
vi.stubGlobal('location', { pathname: '/', search: '', hash: '#/tax/settings' })
vi.stubGlobal('history', { state: { q: 'WHOLE FOODS' }, replaceState: (...a: unknown[]) => void replaced.push(a) })
afterAll(() => vi.unstubAllGlobals())

const load = async () => {
  vi.resetModules()
  return import('../local')
}
/** Whether leaving the page now would ask "Leave site?". */
const wouldAsk = () => !window.dispatchEvent(new Event('beforeunload', { cancelable: true }))

beforeEach(() => {
  reload.mockClear()
  replaced.length = 0
})

describe('the sample household as a session', () => {
  it('opens built and clean, with no vault', async () => {
    const local = await load()
    // A stand-in for engine/sample.ts: one account with one transaction, written straight through the engine.
    const services = await import('../../engine/services')
    await local.enterSampleMode((db) => {
      const a = services.createAccount(db, { name: 'Sample Checking', kind: 'checking' })
      services.runImport(db, { accountId: a.id, content: 'Date,Description,Amount\n2026-10-01,COSTCO WHSE,-80.00\n' }, 'alex@example.com')
    })
    expect(local.localMode.active).toBe(true)
    expect(local.localMode.sample).toBe(true)
    expect(local.localMode.vault).toBeNull()
    expect(local.localMode.dirty).toBe(false)
    expect(local.localMode.writes).toBe(0)
    expect(await local.localDispatch('GET', '/api/accounts')).toMatchObject([{ name: 'Sample Checking', balance_cents: -8000 }])
  })

  it('never takes a vault — the one way a key reaches the tab', async () => {
    const local = await load()
    await local.enterSampleMode(() => {})
    const vault = { version: 1 } as unknown as Parameters<typeof local.localMode.setVault>[0]
    expect(() => local.localMode.setVault(vault)).toThrow(/sample household is never saved/)
    expect(local.localMode.vault).toBeNull()
    local.localMode.setVault(null) // nothing to take: fine
  })

  it('lets you change things, and leaving asks nothing — the changes were never anyone’s', async () => {
    const local = await load()
    await local.enterSampleMode(() => {})
    await local.localDispatch('POST', '/api/accounts', { name: 'Mine now', kind: 'savings' })
    expect(local.localMode.dirty).toBe(true)
    expect(wouldAsk()).toBe(false)
    // A real session with the same unsaved write would ask.
    await local.enterLocalMode(null)
    expect(local.localMode.sample).toBe(false)
    await local.localDispatch('POST', '/api/accounts', { name: 'Unsaved', kind: 'savings' })
    expect(wouldAsk()).toBe(true)
  })

  it('leaves for the front door with nothing of the sample’s in the address bar or the history entry', async () => {
    const local = await load()
    await local.enterSampleMode(() => {})
    local.leaveSample()
    expect(replaced).toEqual([[null, '', '/']])
    expect(local.localMode.active).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('a build that fails leaves no session behind', async () => {
    const local = await load()
    await expect(
      local.enterSampleMode(() => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(local.localMode.active).toBe(false)
    expect(local.localMode.sample).toBe(false)
  })
})
