import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeMonthly } from '../../engine/prices'
import { addMonthsToMonth, todayLocal } from '../../shared/dates'
import type { BasketResponse, HistoryPack } from '../../shared/series-api'

// The real in-tab engine (sql.js) in node, as in dispatch.test.ts.
vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})
vi.stubGlobal('window', new EventTarget())

/* ---------- a fake server: the two shared files a tab reads ---------- */

const today = todayLocal()
const thisMonth = today.slice(0, 7)
const lastMonth = addMonthsToMonth(thisMonth, -1)
const start = addMonthsToMonth(thisMonth, -24)
const months = (n: number, from: string) => Array.from({ length: n }, (_, i) => addMonthsToMonth(from, i))

/** The file: VTI's month ends for the last two years (through last month), plus SPY. */
const packFor = (final: string): HistoryPack => ({
  v: 1,
  start,
  final,
  asOf: today,
  builtAt: new Date().toISOString(),
  stock: {
    VTI: encodeMonthly(start, months(24, start).map((month, i) => ({ month, cents: 20_000 + 100 * i }))),
    SPY: encodeMonthly(start, months(24, start).map((month, i) => ({ month, cents: 50_000 + 200 * i }))),
  },
  crypto: {},
})

type Server = { history: 'ready' | 'building' | 'down'; final: string }
const server: Server = { history: 'ready', final: lastMonth }
const asked: string[] = []
const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(input)
  asked.push(url)
  if (url === '/api/basket') {
    const body: BasketResponse = {
      builtAt: `${today}T06:00:00.000Z`,
      count: 3,
      errors: [],
      quotes: [
        { symbol: 'VTI', kind: 'stock', cents: 22_500, pricedOn: today, name: 'Vanguard Total Stock Market ETF', etf: true },
        { symbol: 'SPY', kind: 'stock', cents: 55_000, pricedOn: today, name: 'SPDR S&P 500 ETF Trust', etf: true },
        { symbol: 'NEWCO', kind: 'stock', cents: 1_500, pricedOn: today, name: 'Newco Inc.', etf: false }, // in the basket, not in the file
      ],
      history:
        server.history === 'ready'
          ? { ready: true, etag: `"${server.final}"`, final: server.final, asOf: today }
          : { ready: false, etag: null, final: null, asOf: null },
    }
    return Response.json(body)
  }
  if (url === '/api/basket/history') {
    if (server.history === 'down') throw new TypeError('Failed to fetch')
    if (server.history === 'building')
      return Response.json({ ready: false, building: true, done: 4_000, total: 12_000, reason: 'The server is still building the market history (33% done)' }, { status: 202 })
    return Response.json(packFor(server.final), { headers: { etag: `"${server.final}"` } })
  }
  throw new Error(`unexpected fetch ${url}`)
})
vi.stubGlobal('fetch', fakeFetch)

type Local = typeof import('../local')
let local: Local
let routes: typeof import('./routes-analytics')
const events: string[] = []
beforeAll(async () => {
  local = await import('../local')
  routes = await import('./routes-analytics')
  for (const t of ['scarab-mode', 'scarab-write']) window.addEventListener(t, (e) => events.push(e.type))
})
afterAll(() => vi.unstubAllGlobals())

const call = (method: string, url: string, body?: unknown) => local.localDispatch(method, url, body)
const historyFetches = () => asked.filter((u) => u === '/api/basket/history').length

/** A fresh session holding VTI bought a year ago, saved, with nothing recorded yet. */
beforeEach(async () => {
  await local.enterLocalMode(null)
  const a = (await call('POST', '/api/invest/accounts', { name: 'Taxable', kind: 'brokerage', tracking: 'lots' })) as { id: number }
  await call('POST', '/api/trades', { investAccountId: a.id, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: `${addMonthsToMonth(thisMonth, -12)}-15`, qty: '10', totalCents: 200_000 })
  local.localMode.markSaved(1)
  routes.forgetTabHistory()
  Object.assign(server, { history: 'ready', final: lastMonth })
  asked.length = 0
  events.length = 0
})

type Refresh = { updated: number; history?: { written: number; matched: number; pending: boolean; final: string | null; errors: string[] } }

describe('POST /prices/refresh brings in the monthly history by itself', () => {
  it('imports the held asset’s month ends once — the one price write that dirties the tab — and then writes nothing', async () => {
    const r0 = local.localMode.dataRevision
    const first = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(first.updated).toBe(1)
    expect(first.history).toEqual({ written: 24, matched: 1, errors: [], final: lastMonth, pending: false }) // start … last month: 24 month ends
    expect(local.localMode.dirty).toBe(true)
    expect(events).toEqual(['scarab-mode', 'scarab-write']) // one dirtying write
    expect(local.localMode.dataRevision).toBe(r0 + 2) // the import, and the refresh around it
    local.localMode.markSaved(2)
    events.length = 0

    // Every month is priced now: the next refresh doesn't ask for the file at all, and stays clean.
    const second = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(second.history).toBeUndefined()
    expect(local.localMode.dirty).toBe(false)
    expect(events).toEqual([])
    expect(local.localMode.dataRevision).toBe(r0 + 2) // today's quote again, unchanged: no row moves, so nothing re-keys
    expect(historyFetches()).toBe(1)
    // Applying the same file directly is a no-op too.
    expect(((await call('POST', '/api/prices/history')) as Refresh['history'])!.written).toBe(0)
    expect(local.localMode.dirty).toBe(false)
    // SPY never became an asset or a price row: the file stays in memory.
    const dump = await local.localDump()
    expect(dump.tables.assets!.map((a) => a.symbol)).toEqual(['VTI'])
    expect(dump.tables.app_meta).toEqual([])
  })

  it('keeps its copy while the file’s `final` is unchanged, and fetches again when the server rebuilds', async () => {
    // A basket symbol the file has no history for keeps asking, so every refresh re-applies.
    await call('POST', '/api/trades', { investAccountId: 1, symbol: 'NEWCO', assetKind: 'stock', side: 'buy', tradedOn: `${addMonthsToMonth(thisMonth, -3)}-02`, qty: '1', totalCents: 1_000 })
    await call('POST', '/api/prices/refresh')
    const again = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(again.history).toMatchObject({ written: 0, errors: ['NEWCO: not in the shared market history'] })
    expect(historyFetches()).toBe(1)
    server.final = addMonthsToMonth(lastMonth, -1) // a different file
    await call('POST', '/api/prices/refresh')
    expect(historyFetches()).toBe(2)
  })

  it('doesn’t download the file for an asset outside the basket, which the file can’t cover either', async () => {
    await call('POST', '/api/prices/refresh') // VTI's history
    await call('POST', '/api/trades', { investAccountId: 1, symbol: 'ZZZQ', assetKind: 'stock', side: 'buy', tradedOn: `${addMonthsToMonth(thisMonth, -3)}-02`, qty: '1', totalCents: 1_000 })
    routes.forgetTabHistory() // as after a reload
    asked.length = 0
    const r = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(r.history).toBeUndefined()
    expect(historyFetches()).toBe(0)
  })

  it('gives a position booked this month its price history too', async () => {
    await call('POST', '/api/prices/refresh')
    local.localMode.markSaved(2)
    // A starting position pasted as of today: its first trade is this month, and today's quote prices it,
    // but it has nothing from before to chart.
    await call('POST', '/api/trades', { investAccountId: 1, symbol: 'SPY', assetKind: 'stock', side: 'buy', tradedOn: today, qty: '1', totalCents: 40_000 })
    local.localMode.markSaved(3)
    const r = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(r.history).toMatchObject({ matched: 2, written: 24, errors: [] }) // SPY: start … last month
    expect(local.localMode.dirty).toBe(true)
    const chart = (await call('GET', '/api/charts/SPY')) as { closes: unknown[]; coverage: { source: string } }
    expect(chart.closes).toHaveLength(25) // 24 month ends, then today's quote
    expect(chart.coverage.source).toBe('quotes')
  })

  it('doesn’t ask for a file the basket says isn’t ready', async () => {
    server.history = 'building'
    const r = (await call('POST', '/api/prices/refresh')) as Refresh
    expect(r.history).toBeUndefined()
    expect(historyFetches()).toBe(0)
    expect(local.localMode.dirty).toBe(false) // basket quotes alone never dirty
  })
})

describe('benchmarks read the file in memory', () => {
  type Catalog = { entries: { id: string; group: string; available: boolean; reason?: string }[] }
  type Res = { series: { id: string; points: { t: string; v: number | null }[] }[]; warnings: string[] }

  it('serves bench:* from the file, fetching it only for requests that need it', async () => {
    const plain = (await call('GET', '/api/series?ids=nw:total')) as Res
    expect(plain.warnings).toEqual([])
    expect(historyFetches()).toBe(0)
    const res = (await call('GET', `/api/series?ids=${encodeURIComponent('bench:SPY,pos:1:value')}`)) as Res
    expect(res.warnings).toEqual([])
    expect(res.series[0]!.points[0]).toEqual({ t: start, v: 1_000_000 })
    const cat = (await call('GET', '/api/series/catalog')) as Catalog
    expect(cat.entries.find((e) => e.id === 'bench:SPY')).toMatchObject({ available: true })
    expect(historyFetches()).toBe(1) // shared by both
    expect(local.localMode.dirty).toBe(false)
  })

  it('says why while the server is still building, and asks again only after a minute', async () => {
    server.history = 'building'
    const cat = (await call('GET', '/api/series/catalog')) as Catalog
    expect(cat.entries.find((e) => e.id === 'bench:SPY')).toMatchObject({ available: false, reason: 'The server is still building the market history (33% done)' })
    const res = (await call('GET', '/api/series?ids=bench:SPY')) as Res
    expect(res.warnings).toEqual(['bench:SPY: The server is still building the market history (33% done)'])
    expect(historyFetches()).toBe(1)
    expect(await call('POST', '/api/prices/history')).toEqual({ written: 0, matched: 0, errors: [], final: null, pending: true })
    expect(local.localMode.dirty).toBe(false)
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61_000)
      server.history = 'ready'
      const later = (await call('GET', '/api/series/catalog')) as Catalog
      expect(later.entries.find((e) => e.id === 'bench:SPY')!.available).toBe(true)
      expect(historyFetches()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an unreachable server greys benchmarks out with its own reason', async () => {
    server.history = 'down'
    const cat = (await call('GET', '/api/series/catalog')) as Catalog
    expect(cat.entries.find((e) => e.id === 'bench:SPY')).toMatchObject({ available: false, reason: 'Couldn’t reach the server for market history' })
  })
})
