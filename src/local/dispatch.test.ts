import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The real in-tab engine (sql.js) in node. Vite's '?url' import yields a dev
// server URL; node needs the file itself.
vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

// One extra route no server has: a write that waits on a gate the test opens,
// standing in for any handler that awaits before it writes.
let atGate = false
let openGate: () => void = () => {}
let failAfterGate = false
vi.mock('./routes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./routes')>()
  const { r } = await import('./table')
  const slow = r('POST', '/test/slow-write', async (c) => {
    await new Promise<void>((resolve) => {
      openGate = resolve
      atGate = true
    })
    atGate = false
    if (failAfterGate) throw new Error('gave up')
    c.db.prepare("INSERT INTO app_meta (key, value) VALUES ('test:slow', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(Date.now()))
    return { ok: true }
  })
  return { ...actual, loadRoutes: async () => [...(await actual.loadRoutes()), slow] }
})

// local.ts announces on `window`; an EventTarget is all it needs.
vi.stubGlobal('window', new EventTarget())

type Local = typeof import('../local')
let local: Local
const events: string[] = []
const record = (e: Event) => events.push(e.type)
const count = (type: string) => events.filter((t) => t === type).length

beforeAll(async () => {
  local = await import('../local')
  for (const t of ['scarab-mode', 'scarab-write', 'scarab-data']) window.addEventListener(t, record)
})
afterAll(() => vi.unstubAllGlobals())

const call = (method: string, url: string, body?: unknown) => local.localDispatch(method, url, body)
const get = <T>(url: string) => call('GET', url) as Promise<T>

/** A fresh, empty session with nothing unsaved and no events recorded yet. */
async function cleanSession() {
  await local.enterLocalMode(null)
  local.localMode.setIdentity(null)
  local.localMode.markSaved(1)
  events.length = 0
}

const lotsAccount = async (name = 'Taxable') =>
  (await call('POST', '/api/invest/accounts', { name, kind: 'brokerage', tracking: 'lots' })) as { id: number }

beforeEach(cleanSession)
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('localDispatch: what dirties the tab', () => {
  it('a real write dirties it', async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    expect(local.localMode.dirty).toBe(true)
    expect(local.localMode.writes).toBe(1)
    expect(await get<{ name: string }[]>('/api/accounts')).toMatchObject([{ name: 'Checking' }])
  })

  it('counts a write only once it is applied, so a save racing it cannot swallow it', async () => {
    const write = call('POST', '/api/test/slow-write')
    await vi.waitFor(() => expect(atGate).toBe(true))
    // A save runs while the handler is still waiting to write: it reads the
    // counter, dumps, uploads and marks saved. The old dispatcher had already
    // counted the write by now, so this save cleared it without uploading it.
    const writesAtDump = local.localMode.writes
    const dump = await local.localDump()
    expect(dump.tables.app_meta?.some((row) => row.key === 'test:slow')).toBe(false)
    local.localMode.markSaved(2, writesAtDump)
    openGate()
    await write
    expect(local.localMode.writes).toBe(writesAtDump + 1)
    expect(local.localMode.dirty).toBe(true) // still owed to the vault
    expect(events).toEqual(['scarab-mode', 'scarab-mode', 'scarab-write'])
  })

  it('a slow write that fails before writing leaves the tab clean', async () => {
    failAfterGate = true
    try {
      const write = call('POST', '/api/test/slow-write')
      await vi.waitFor(() => expect(atGate).toBe(true))
      openGate()
      await expect(write).rejects.toThrow('gave up')
    } finally {
      failAfterGate = false
    }
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
  })

  it("fires 'scarab-write' once per write and 'scarab-mode' only on the clean → dirty turn", async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    expect(events).toEqual(['scarab-mode', 'scarab-write'])
    await lotsAccount()
    // A trade inserts its asset and the trade row: two changes, one write.
    await call('POST', '/api/trades', {
      investAccountId: 1, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-10', qty: '10', totalCents: 200_000,
    })
    expect(count('scarab-write')).toBe(3)
    expect(count('scarab-mode')).toBe(1)
    expect(local.localMode.writes).toBe(3)
  })

  it('a write that fails validation leaves the tab clean', async () => {
    await expect(call('POST', '/api/trades', {})).rejects.toThrow(/required/)
    await expect(call('POST', '/api/trades', { investAccountId: 99, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-10', qty: '1', totalCents: 1 }))
      .rejects.toThrow(/no such lots-tracked/)
    await expect(call('DELETE', '/api/loans/42')).rejects.toThrow('no such loan option')
    expect(local.localMode.dirty).toBe(false)
    expect(local.localMode.writes).toBe(0)
    expect(events).toEqual([])
  })

  it('turns engine errors into plain Errors carrying the message, as a failed fetch does', async () => {
    const err = await call('POST', '/api/trades', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).constructor).toBe(Error)
  })

  it('a write that changes nothing leaves the tab clean', async () => {
    expect(await call('PUT', '/api/goal', {})).toEqual({ ok: true })
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
  })

  it('reads never dirty it', async () => {
    for (const url of ['/api/accounts', '/api/networth', '/api/portfolio', '/api/tax', '/api/digest', '/api/scenarios', '/api/series/catalog'])
      await get(url)
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
  })

  it('a price refresh stores the quotes but never dirties the tab', async () => {
    await lotsAccount()
    await call('POST', '/api/trades', {
      investAccountId: 1, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-10', qty: '10', totalCents: 200_000,
    })
    local.localMode.markSaved(2)
    events.length = 0
    const basket = { builtAt: '2026-09-22', quotes: [{ symbol: 'VTI', kind: 'stock', cents: 24_800, pricedOn: '2026-09-22' }] }
    const fetchBasket = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(basket)))
    try {
      // Opening Investments five times: five refreshes, no unsaved work.
      for (let i = 0; i < 5; i++) expect(await call('POST', '/api/prices/refresh')).toMatchObject({ updated: 1, errors: [] })
      expect(fetchBasket).toHaveBeenCalledTimes(5)
      expect(fetchBasket).toHaveBeenCalledWith('/api/basket')
    } finally {
      fetchBasket.mockRestore()
    }
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
    // …and the quote is really in the tab, riding along with the next save.
    const pf = await get<{ positions: { symbol: string; price_cents: number | null }[] }>('/api/portfolio')
    expect(pf.positions).toMatchObject([{ symbol: 'VTI', price_cents: 24_800 }])
  })

  it('scenario comparison, pricing and simulation are read-like', async () => {
    // On an empty tab both seed the Baseline scenario first (the one write a
    // read performs): a real change, and still not unsaved work.
    await expect(call('POST', '/api/scenarios/price', { event: {} })).rejects.toThrow('nothing to project yet')
    await cleanSession()
    expect(await call('POST', '/api/scenarios/compare', {})).toMatchObject({ runs: [] })
    await expect(call('POST', '/api/simulate', {})).rejects.toThrow('startYear/endYear out of range')
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
    expect(await get<{ name: string }[]>('/api/scenarios')).toMatchObject([{ name: 'Baseline' }])
  })
})

describe('localDispatch: routing', () => {
  it('reaches only the exact route: no prefix fallthrough', async () => {
    const { id } = await lotsAccount()
    local.localMode.markSaved(2)
    // Paths that share a prefix with DELETE /invest/accounts/:id must not reach it.
    await expect(call('DELETE', `/api/invest/accounts/${id}/x`)).rejects.toThrow('local mode has no handler for DELETE /invest/accounts/')
    await expect(call('DELETE', `/api/invest/accounts/${id}/x/y`)).rejects.toThrow(/no handler/)
    // Two segments deeper is its own exact route, which answers for itself.
    await expect(call('DELETE', `/api/invest/balances/${id}/2026-06-30`)).rejects.toThrow('no balance is recorded')
    expect(await get<{ id: number }[]>('/api/invest/accounts')).toMatchObject([{ id }])
    expect(local.localMode.dirty).toBe(false)
  })

  it('passes params and query strings through as the server does', async () => {
    const { id } = await lotsAccount()
    expect(await call('PATCH', `/api/invest/accounts/${id}`, { name: 'Brokerage' })).toBeTruthy()
    expect(await get<{ name: string }[]>('/api/invest/accounts')).toMatchObject([{ name: 'Brokerage' }])
    await expect(get('/api/charts/nope')).rejects.toThrow('no such asset')
    const series = await get<{ series: unknown[]; warnings: string[] }>('/api/series?ids=nw:total,nw:bogus&from=2026-01')
    expect(series.warnings).toEqual(['unknown series: nw:bogus'])
  })

  it('says so when a path belongs to the network', async () => {
    await expect(get('/api/basket/status')).rejects.toThrow('GET /api/basket/status is served by the network')
    await expect(get('/api/mode')).rejects.toThrow(/served by the network/)
    await expect(get('/apiary')).rejects.toThrow(/answers \/api paths only/)
  })

  it('api.ts sends network-only paths to the server, even in a session', async () => {
    const api = await import('../api')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ builtAt: '2026-09-23' }))
    try {
      expect(await api.get('/api/basket/status')).toEqual({ builtAt: '2026-09-23' })
      await api.get('/api/mode')
      await api.get('/api/vault/members')
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(['/api/basket/status', '/api/mode', '/api/vault/members'])
      // Everything else stays in the tab.
      expect(await api.get('/api/accounts')).toEqual([])
      expect(fetchSpy).toHaveBeenCalledTimes(3)
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it("dates the tab's day in its own zone, not UTC", async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T05:30:00Z')) // 22:30 on Sep 22 in Los Angeles
    expect((await get<{ asOf: string }>('/api/series/catalog')).asOf).toBe('2026-09-22')
  })
})

describe('localDispatch: identity', () => {
  it('answers /me with the signed-in identity', async () => {
    expect(await get('/api/me')).toEqual({ email: 'you · local tab' })
    local.localMode.setIdentity('max@example.com')
    expect(local.localMode.identity).toBe('max@example.com')
    expect(events).toEqual(['scarab-mode'])
    expect(await get('/api/me')).toEqual({ email: 'max@example.com' })
    local.localMode.setIdentity('max@example.com') // unchanged: no announcement
    local.localMode.setIdentity('  ')
    expect(local.localMode.identity).toBeNull()
    expect(events).toEqual(['scarab-mode', 'scarab-mode'])
  })

  it("keeps one digest mark per member: Max's 'caught up' leaves Nicole's digest alone", async () => {
    const since = async (who: string | null) => {
      local.localMode.setIdentity(who)
      return (await get<{ since: string }>('/api/digest')).since
    }
    vi.useFakeTimers({ toFake: ['Date'] })
    // A mark written before the tab knew who was signed in: shared by both.
    vi.setSystemTime(new Date('2026-09-01T12:00:00Z'))
    await call('POST', '/api/digest/ack')
    expect(await since(null)).toBe('2026-09-01 12:00:00')

    // Each member inherits it on their first digest…
    expect(await since('max@example.com')).toBe('2026-09-01 12:00:00')
    expect(await since('nicole@example.com')).toBe('2026-09-01 12:00:00')

    // …and from then on moves only their own.
    vi.setSystemTime(new Date('2026-09-20T08:00:00Z'))
    local.localMode.setIdentity('max@example.com')
    await call('POST', '/api/digest/ack')
    expect(await since('max@example.com')).toBe('2026-09-20 08:00:00')
    expect(await since('nicole@example.com')).toBe('2026-09-01 12:00:00')
    expect(await since(null)).toBe('2026-09-01 12:00:00')
  })

  it('attributes statement imports to the signed-in identity', async () => {
    const acct = (await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })) as { id: number }
    const csv = 'Date,Description,Amount\n2026-09-01,COFFEE,-4.50\n'
    local.localMode.setIdentity('nicole@example.com')
    await call('POST', '/api/imports', { accountId: acct.id, filename: 'sep.csv', content: csv })
    local.localMode.setIdentity(null)
    await call('POST', '/api/imports', { accountId: acct.id, filename: 'sep2.csv', content: csv })
    const imports = await get<{ filename: string; imported_by: string }[]>('/api/imports')
    expect(imports.map((i) => [i.filename, i.imported_by])).toEqual([
      ['sep2.csv', 'local'],
      ['sep.csv', 'nicole@example.com'],
    ])
  })
})

describe('data replacement', () => {
  it('loadLocalDump bumps dataEpoch and announces it; the caller decides dirty', async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    const dump = await local.localDump()
    const epoch = local.localMode.dataEpoch
    local.localMode.markSaved(2)
    events.length = 0
    await local.loadLocalDump(dump)
    expect(local.localMode.dataEpoch).toBe(epoch + 1)
    expect(events).toEqual(['scarab-data', 'scarab-mode', 'scarab-write'])
    expect(local.localMode.dirty).toBe(true)
  })

  it('POST /import replaces the data like the server does, bumping dataEpoch', async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    const dump = await local.localDump()
    await call('POST', '/api/accounts', { name: 'Savings', kind: 'savings' })
    local.localMode.markSaved(2)
    events.length = 0
    const epoch = local.localMode.dataEpoch

    await expect(call('POST', '/api/import', dump)).rejects.toThrow(/confirm: "REPLACE"/)
    await expect(call('POST', '/api/import', { confirm: 'REPLACE' })).rejects.toThrow('not a Scarab export')
    expect(local.localMode.dataEpoch).toBe(epoch)
    expect(local.localMode.dirty).toBe(false)

    const res = (await call('POST', '/api/import', { ...dump, confirm: 'REPLACE' })) as { ok: boolean; restored: Record<string, number> }
    expect(res.ok).toBe(true)
    expect(res.restored.accounts).toBe(1)
    expect(await get<{ name: string }[]>('/api/accounts')).toMatchObject([{ name: 'Checking' }])
    expect(local.localMode.dataEpoch).toBe(epoch + 1)
    expect(local.localMode.dirty).toBe(true)
    expect(events).toEqual(['scarab-mode', 'scarab-write', 'scarab-data'])
  })
})

describe('dataRevision: every change to the data, unsaved work or not', () => {
  const revisions: number[] = []
  /** Each 'scarab-revision', as the revision a listener reads then. */
  const onRevision = () => revisions.push(local.localMode.dataRevision)
  beforeEach(() => {
    revisions.length = 0
    window.addEventListener('scarab-revision', onRevision)
  })
  afterEach(() => window.removeEventListener('scarab-revision', onRevision))

  const buyVti = () =>
    call('POST', '/api/trades', {
      investAccountId: 1, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-10', qty: '10', totalCents: 200_000,
    })

  it("moves when a 'never' price refresh rewrites quotes, though the tab stays clean", async () => {
    await lotsAccount()
    await buyVti()
    local.localMode.markSaved(2)
    events.length = 0
    revisions.length = 0
    const before = local.localMode.dataRevision
    const basket = (cents: number) => ({ builtAt: '2026-09-22', quotes: [{ symbol: 'VTI', kind: 'stock', cents, pricedOn: '2026-09-22' }] })
    let cents = 24_800
    const fetchBasket = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(basket(cents))))
    try {
      await call('POST', '/api/prices/refresh')
      cents = 25_100 // a later build of the same day: the quote is rewritten in place
      await call('POST', '/api/prices/refresh')
    } finally {
      fetchBasket.mockRestore()
    }
    expect(local.localMode.dataRevision).toBe(before + 2)
    expect(revisions).toEqual([before + 1, before + 2])
    expect(local.localMode.dirty).toBe(false)
    expect(local.localMode.writes).toBe(2) // the account and the trade; the quotes aren't unsaved work
    expect(events).toEqual([])
  })

  it("moves once per applied write, already moved when 'scarab-write' fires; not for a failed or empty write", async () => {
    const seen: number[] = []
    const onWrite = () => seen.push(local.localMode.dataRevision)
    window.addEventListener('scarab-write', onWrite)
    try {
      const r0 = local.localMode.dataRevision
      await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
      expect(local.localMode.dataRevision).toBe(r0 + 1)
      expect(seen).toEqual([r0 + 1])
      await expect(call('POST', '/api/trades', {})).rejects.toThrow(/required/)
      expect(await call('PUT', '/api/goal', {})).toEqual({ ok: true })
      expect(local.localMode.dataRevision).toBe(r0 + 1)
      expect(revisions).toEqual([r0 + 1])
    } finally {
      window.removeEventListener('scarab-write', onWrite)
    }
  })

  it('stays put across reads and read-like POSTs once the Baseline scenario is seeded', async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    await lotsAccount()
    await buyVti()
    const reads = ['/api/accounts', '/api/networth', '/api/portfolio', '/api/tax', '/api/digest', '/api/scenarios', '/api/series/catalog', '/api/goal', '/api/invest/checkin']
    const readLike = async () => {
      for (const url of reads) await get(url)
      await call('POST', '/api/scenarios/compare', {})
      await call('POST', '/api/trades/preview', { investAccountId: 1, symbol: 'VTI', side: 'sell', qty: '1', totalCents: 2_500, tradedOn: '2026-09-01' }).catch(() => null)
    }
    const r0 = local.localMode.dataRevision
    await readLike() // the first scenario read seeds the Baseline: a real change
    const seeded = local.localMode.dataRevision
    expect(seeded).toBe(r0 + 1)
    await readLike()
    await readLike()
    expect(local.localMode.dataRevision).toBe(seeded) // a cache keyed on it holds
  })

  it('moves on entering, on a data swap and on POST /import, and never goes back', async () => {
    await call('POST', '/api/accounts', { name: 'Checking', kind: 'checking' })
    const dump = await local.localDump()
    const r0 = local.localMode.dataRevision
    revisions.length = 0
    await local.loadLocalDump(dump)
    const swapped = local.localMode.dataRevision
    expect(swapped).toBe(r0 + 1)
    // A fresh session starts its write count over; the revision carries on, so no old key can match the new data.
    await local.enterLocalMode(null)
    expect(local.localMode.writes).toBe(0)
    const entered = local.localMode.dataRevision
    expect(entered).toBe(swapped + 1)
    await call('POST', '/api/import', { ...dump, confirm: 'REPLACE' })
    expect(local.localMode.dataRevision).toBe(entered + 1)
    expect(revisions).toEqual([r0 + 1, swapped + 1, entered + 1])
  })
})

describe('api.ts: the household write signal', () => {
  it("counts this tab's writes to the server — not reads, read-like POSTs, failures, or a session's writes", async () => {
    const api = await import('../api')
    const seen: number[] = []
    const onWrite = (e: Event) => seen.push((e as CustomEvent<number>).detail)
    window.addEventListener('scarab-server-write', onWrite)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url) => (String(url).includes('/nope') ? Response.json({ error: 'no such thing' }, { status: 404 }) : Response.json({ ok: true })))
    const household = vi.spyOn(local.localMode, 'active', 'get').mockReturnValue(false)
    try {
      const start = api.serverWriteCount()
      await api.get('/api/accounts')
      await api.post('/api/scenarios/compare', {})
      await api.post('/api/simulate?paths=200', {})
      await expect(api.del('/api/nope/1')).rejects.toThrow('no such thing')
      expect(api.serverWriteCount()).toBe(start)
      expect(seen).toEqual([])

      await api.post('/api/trades', {})
      await api.put('/api/goal', {})
      await api.post('/api/prices/refresh', {}) // rewrites prices on the server
      expect(api.serverWriteCount()).toBe(start + 3)
      expect(seen).toEqual([start + 1, start + 2, start + 3])

      // In a session the tab's own counter (localMode.writes) is the signal instead.
      household.mockRestore()
      await api.post('/api/accounts', { name: 'Checking', kind: 'checking' })
      expect(local.localMode.writes).toBeGreaterThan(0)
      expect(api.serverWriteCount()).toBe(start + 3)
      expect(fetchSpy).toHaveBeenCalledTimes(7)
    } finally {
      household.mockRestore()
      fetchSpy.mockRestore()
      window.removeEventListener('scarab-server-write', onWrite)
    }
  })

  it("treats as read-like exactly the tab table's 'never' writes, bar the price refresh", async () => {
    const { READ_LIKE_WRITES } = await import('../api')
    const { loadRoutes } = await import('./routes')
    const { policyOf } = await import('./table')
    const never = (await loadRoutes()).filter((rt) => rt.method !== 'GET' && policyOf(rt) === 'never').map((rt) => rt.path)
    expect(never).toContain('/prices/refresh')
    expect([...READ_LIKE_WRITES].sort()).toEqual(never.filter((p) => p !== '/prices/refresh').sort())
  })
})
