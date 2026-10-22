import { afterAll, describe, expect, it, vi } from 'vitest'

/**
 * The sample household never touches a vault: creating one from it, saving
 * it and autosave all stop in the tab, and no request ever goes to the
 * courier. (The browser-level proof, against the real vault-only server, is
 * e2e/sample.spec.ts.)
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

const storage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), key: () => null, length: 0 }
}
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { reload: () => {}, hostname: 'localhost' } }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
vi.stubGlobal('sessionStorage', storage())
vi.stubGlobal('localStorage', storage())
/** Every request the tab sends, by method and path. Nothing is stored on the other end: no vault exists. */
const sent: string[] = []
vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
  sent.push(`${init?.method ?? 'GET'} ${url}`)
  return new Response(JSON.stringify({ error: 'no vault' }), { status: 404, headers: { 'content-type': 'application/json' } })
})
afterAll(() => vi.unstubAllGlobals())

describe('a sample session', () => {
  it('refuses to become a vault or be saved, and its edits never leave the tab', async () => {
    const local = await import('./local')
    const session = await import('./session')
    const { buildSampleHousehold } = await import('../engine/sample')
    await local.enterSampleMode((db, today) => buildSampleHousehold(db, today))
    expect(local.localMode.sample).toBe(true)

    await expect(session.createVault('this device', { empty: true })).rejects.toThrow(/sample household is never saved/)
    await expect(session.createVault('this device')).rejects.toThrow(/sample household is never saved/)
    await expect(session.saveVault()).rejects.toThrow(/sample household is never saved/)

    // Edits, then well past the autosave delay (and a tab going into the background, which flushes it).
    await local.localDispatch('POST', '/api/accounts', { name: 'Mine now', kind: 'savings' })
    await local.localDispatch('PUT', '/api/setup', { hidden: true })
    expect(local.localMode.dirty).toBe(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((r) => setTimeout(r, 2_000))
    expect(session.autosave.status).toBe('idle')
    expect(sent.filter((r) => r.includes('/api/vault'))).toEqual([])
    expect(sent.filter((r) => !r.startsWith('GET '))).toEqual([])
  }, 15_000)
})
