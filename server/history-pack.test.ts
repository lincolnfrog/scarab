import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { seedHousehold } from '../engine/test/household'
import { decodeMonthly, encodeMonthly, packMarket, type MonthClose } from '../engine/prices'
import { addMonthsToMonth } from '../shared/dates'
import type { HistoryPack } from '../shared/series-api'
import {
  appendToHistory,
  applyServerHistory,
  ensureHistoryPack,
  HISTORY_BATCH,
  HISTORY_KEY,
  historyPending,
  historyStatus,
  loadPack,
  mergeQuotes,
  packResponse,
  parseSparkHistory,
  serverMarket,
  storePack,
  type HistoryRunOptions,
} from './history-pack'
import { openDb } from './migrations'

const mem = () => openDb(':memory:') as unknown as DbLike
const meta = (db: DbLike, like: string) =>
  (db.prepare('SELECT key FROM app_meta WHERE key LIKE ? ORDER BY key').all(like) as { key: string }[]).map((r) => r.key)

/** `n` consecutive months from `first`, the i-th close f(i). */
const monthsOf = (first: string, n: number, f: (i: number) => number): MonthClose[] =>
  Array.from({ length: n }, (_, i) => ({ month: addMonthsToMonth(first, i), cents: f(i) }))

/* ---------- the file's encoding ---------- */

describe('the monthly encoding: [offset, first, Δ…]', () => {
  it('round-trips closes with gaps, falls and a first month past `start`', () => {
    const closes = [
      { month: '2017-01', cents: 10_000 },
      { month: '2017-02', cents: 9_000 },
      { month: '2017-05', cents: 25_000 }, // March and April had no close
      { month: '2017-06', cents: 25_000 },
    ]
    const enc = encodeMonthly('2016-09', closes)
    expect(enc).toEqual([4, 10_000, -1_000, null, null, 16_000, 0])
    expect(decodeMonthly('2016-09', enc)).toEqual(closes)
    // Ten years of a big price stays exact.
    const brk = monthsOf('2016-09', 121, (i) => 20_000_000 + 13_579 * i * (i % 2 ? -1 : 1) + 70_000_000)
    expect(decodeMonthly('2016-09', encodeMonthly('2016-09', brk))).toEqual(brk)
    expect(encodeMonthly('2016-09', [])).toEqual([])
  })

  it('refuses to decode a malformed array (it crossed a network) and to encode bad input', () => {
    for (const bad of ['x', null, [], [1], [-1, 5], [1201, 5], [0, 0], [0, 5, -5], [0, 5, 1.5], [0, 5, '1'], [0.5, 5]])
      expect(decodeMonthly('2016-09', bad), JSON.stringify(bad)).toBeNull()
    expect(decodeMonthly('2016-9', [0, 5])).toBeNull()
    expect(() => encodeMonthly('2016-09', [{ month: '2017-02', cents: 5 }, { month: '2017-01', cents: 5 }])).toThrow(/out of order/)
    expect(() => encodeMonthly('2016-09', [{ month: '2017-02', cents: 5 }, { month: '2017-02', cents: 6 }])).toThrow(/out of order/)
    expect(() => encodeMonthly('2016-09', [{ month: '2016-08', cents: 5 }])).toThrow(/out of order/)
    expect(() => encodeMonthly('2016-09', [{ month: '2017-02', cents: 0 }])).toThrow(/bad close/)
    expect(() => encodeMonthly('2016-09', [{ month: '2017-02', cents: 1.5 }])).toThrow(/bad close/)
  })

  it('reads as the series layer’s MarketHistory: month ends, the month in progress at asOf, a coin by kind', () => {
    const pack: HistoryPack = {
      v: 1,
      start: '2026-01',
      final: '2026-08',
      asOf: '2026-09-22',
      builtAt: '2026-09-01T00:00:00.000Z',
      stock: { SPY: encodeMonthly('2026-01', monthsOf('2026-07', 3, (i) => 60_000 + i)), BTC: [0, 4_000] },
      crypto: { BTC: [8, 6_000_000] },
    }
    const m = packMarket(pack)
    expect(m.closes('SPY')).toEqual([
      { on: '2026-07-31', cents: 60_000 },
      { on: '2026-08-31', cents: 60_001 },
      { on: '2026-09-22', cents: 60_002 },
    ])
    expect(m.closes('BTC')).toEqual([{ on: '2026-01-31', cents: 4_000 }]) // no kind: the stock
    expect(m.closes('BTC', 'crypto')).toEqual([{ on: '2026-09-22', cents: 6_000_000 }])
    expect(m.closes('SPY', 'crypto')).toBeNull()
    for (const nope of ['NOPE', '__proto__', 'constructor', 'toString']) expect(m.closes(nope)).toBeNull()
  })
})

/* ---------- Yahoo spark replies ---------- */

/** Unix seconds at a month's first day, `hour` UTC — how Yahoo stamps a monthly bar (04:00Z is New York's midnight in summer). */
const monthOpen = (month: string, hour: number) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, hour) / 1000
const dayAt = (iso: string, hour: number) => Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`) / 1000

/** A v8 spark reply: { SYM: { symbol, timestamp, close, … } }, one bar per month plus Yahoo's live bar when given. */
function sparkV8(series: Record<string, { first: string; closes: (number | null)[]; live?: [day: string, close: number] }>) {
  return Object.fromEntries(
    Object.entries(series).map(([sym, s]) => {
      const hour = sym.endsWith('-USD') ? 0 : 4
      const ts = s.closes.map((_, i) => monthOpen(addMonthsToMonth(s.first, i), hour))
      const close = [...s.closes]
      if (s.live) {
        ts.push(dayAt(s.live[0], 15))
        close.push(s.live[1])
      }
      return [sym, { timestamp: ts, symbol: sym, end: null, dataGranularity: 300, previousClose: null, chartPreviousClose: close[0], close }]
    }),
  )
}

describe('parseSparkHistory', () => {
  it('reads v8 replies: floats become cents once, the live bar wins its month, nulls and future months drop', () => {
    const body = sparkV8({
      AAPL: { first: '2026-06', closes: [201.255, null, 229.35, 232.1], live: ['2026-09-22', 245.5] },
      'BTC-USD': { first: '2026-07', closes: [117_000.456, 108_000.1, 112_000], live: ['2026-09-22', 112_500.994] },
      JUNK: { first: '2026-06', closes: [0, -3, Number.NaN] },
    })
    const got = parseSparkHistory(body, '2026-09-22')
    expect(got.get('AAPL')).toEqual([
      { month: '2026-06', cents: 20_126 }, // 201.255 → 20125.5 rounds up; July had no close
      { month: '2026-08', cents: 22_935 },
      { month: '2026-09', cents: 24_550 }, // the live bar replaces September's opening bar
    ])
    expect(got.get('BTC-USD')).toEqual([
      { month: '2026-07', cents: 11_700_046 },
      { month: '2026-08', cents: 10_800_010 },
      { month: '2026-09', cents: 11_250_099 },
    ])
    expect(got.has('JUNK')).toBe(false)
    // A bar dated after today's month is dropped.
    expect(parseSparkHistory(sparkV8({ X: { first: '2026-09', closes: [10, 11] } }), '2026-09-22').get('X')).toEqual([{ month: '2026-09', cents: 1_000 }])
  })

  it('reads v7 replies in the exchange’s own zone, and survives garbage', () => {
    // Tokyo's March bar opens at local midnight, which is Feb 28 15:00 UTC.
    const v7 = {
      spark: {
        result: [
          {
            symbol: '7203.T',
            response: [
              {
                meta: { exchangeTimezoneName: 'Asia/Tokyo' },
                timestamp: [dayAt('2026-02-28', 15), dayAt('2026-03-31', 15)],
                indicators: { quote: [{ close: [2_800, 2_900] }] },
              },
            ],
          },
          { symbol: 'BROKEN', response: 'nope' },
        ],
      },
    }
    expect(parseSparkHistory(v7, '2026-09-22').get('7203.T')).toEqual([
      { month: '2026-03', cents: 280_000 },
      { month: '2026-04', cents: 290_000 },
    ])
    for (const junk of [null, 'x', 42, [], { spark: { result: null } }, { A: { timestamp: 'x', close: [] } }])
      expect(parseSparkHistory(junk, '2026-09-22').size).toBe(0)
  })
})

/* ---------- merging the daily basket into the file ---------- */

describe('mergeQuotes / appendToHistory', () => {
  const base = (): HistoryPack => ({
    v: 1,
    start: '2026-01',
    final: '2026-06',
    asOf: '2026-07-10',
    builtAt: '2026-07-01T06:00:00.000Z',
    stock: { VTI: encodeMonthly('2026-01', monthsOf('2026-05', 3, (i) => 30_000 + 100 * i)) }, // May, June, July so far
    crypto: {},
  })
  const q = (symbol: string, pricedOn: string, cents: number, kind = 'stock') => ({ symbol, kind, cents, pricedOn })

  it('keeps the month in progress current, starts new months after gaps, and never touches months through `final`', () => {
    const pack = base()
    expect(mergeQuotes(pack, [q('VTI', '2026-07-15', 30_500)], '2026-07-15')).toBe(true)
    expect(decodeMonthly(pack.start, pack.stock.VTI)!.at(-1)).toEqual({ month: '2026-07', cents: 30_500 })
    expect(pack.asOf).toBe('2026-07-15')
    // September, with no August close in between; then a new listing and a coin.
    expect(mergeQuotes(pack, [q('VTI', '2026-09-01', 31_000), q('NEW', '2026-09-02', 1_234), q('BTC', '2026-09-02', 6_000_000, 'crypto')], '2026-09-02')).toBe(true)
    expect(pack.stock.VTI).toEqual([4, 30_000, 100, 400, null, 500])
    expect(decodeMonthly(pack.start, pack.stock.NEW)).toEqual([{ month: '2026-09', cents: 1_234 }])
    expect(decodeMonthly(pack.start, pack.crypto.BTC)).toEqual([{ month: '2026-09', cents: 6_000_000 }])
    const before = JSON.stringify(pack)
    // Ignored: a month through `final`, a month older than the symbol's latest, the same close again, and malformed rows.
    const ignored = [
      q('VTI', '2026-06-30', 1),
      q('VTI', '2026-08-15', 1),
      q('VTI', '2026-09-01', 31_000),
      q('VTI', '2026-09-01', 31_000, 'bond'),
      q('__proto__', '2026-09-01', 5),
      q('brk.b', '2026-09-01', 5),
      q('VTI', '2026-09-01', 0),
      q('VTI', '2026-09-01', -5),
      q('VTI', '2026-09-01', 1.5),
      q('VTI', '2026-9-1', 5),
      q('VTI', '2026-09-05', 5), // three days ahead of today
      q('OLD', '2025-12-31', 5), // before the file's first month
    ]
    expect(mergeQuotes(pack, ignored, '2026-09-02')).toBe(false)
    expect(JSON.stringify(pack)).toBe(before)
    expect(Object.getPrototypeOf(pack.stock)).toBe(Object.prototype)
  })

  it('stores the merged file (a new ETag) and does nothing without one', () => {
    const db = mem()
    expect(appendToHistory(db, [q('VTI', '2026-07-15', 1)], '2026-07-15')).toBe(false)
    expect(meta(db, 'basket:history%')).toEqual([])
    storePack(db, base())
    const tag = historyStatus(db).etag
    expect(appendToHistory(db, [q('VTI', '2026-07-10', 30_200)], '2026-07-10')).toBe(false) // unchanged
    expect(historyStatus(db).etag).toBe(tag)
    expect(appendToHistory(db, [q('VTI', '2026-07-16', 30_600)], '2026-07-16')).toBe(true)
    expect(historyStatus(db)).toMatchObject({ ready: true, final: '2026-06', asOf: '2026-07-16' })
    expect(historyStatus(db).etag).not.toBe(tag)
    expect(decodeMonthly('2026-01', loadPack(db)!.stock.VTI)!.at(-1)).toEqual({ month: '2026-07', cents: 30_600 })
  })
})

/* ---------- building the file from Yahoo ---------- */

const NOW = new Date('2026-09-23T12:00:00Z')
const later = (ms: number, from = NOW) => new Date(from.getTime() + ms)
const DAY = 86_400_000

/** A basket of `stocks` symbols (S00, S01, …) plus bitcoin, quoted on 2026-09-22. */
function seedBasket(db: DbLike, stocks: number) {
  const put = db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES (?, ?, ?, '2026-09-22')")
  for (let i = 0; i < stocks; i++) put.run(`S${String(i).padStart(2, '0')}`, 'stock', 50_000 + i)
  put.run('BTC', 'crypto', 11_300_000)
}

/** Each symbol's monthly closes, as the fake Yahoo answers them: 36 months to August plus a live September bar. */
const closeOf = (sym: string, i: number) => 10 + (sym.charCodeAt(1) % 10) + i * 0.25

type Call = { url: string; symbols: string[] }
/** Fake Yahoo spark. `fail(n)` can answer the n-th call (0-based) with a status, a thrown error or garbage. */
function fakeYahoo(fail: (n: number, symbols: string[]) => number | 'throw' | 'garbage' | null = () => null) {
  const calls: Call[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    const symbols = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '').split(',')
    const n = calls.length
    calls.push({ url, symbols })
    const how = fail(n, symbols)
    if (how === 'throw') throw new TypeError('fetch failed')
    if (how === 'garbage') return new Response('<html>consent</html>', { status: 200 })
    if (typeof how === 'number') return new Response(JSON.stringify({ spark: { result: null, error: { code: 'x' } } }), { status: how })
    const series = Object.fromEntries(
      symbols.map((s) => [s, { first: '2023-09', closes: Array.from({ length: 36 }, (_, i) => closeOf(s, i)), live: ['2026-09-22', 99] as [string, number] }]),
    )
    return Response.json(sparkV8(series))
  }) as typeof fetch
  return { f, calls }
}

const quiet = (o: HistoryRunOptions = {}): HistoryRunOptions => ({ paceMs: 5, gapMs: 0, sleep: async () => {}, ...o })

describe('ensureHistoryPack: a gentle, resumable build', () => {
  afterEach(() => vi.restoreAllMocks())

  it('needs a basket, and never builds without one', async () => {
    const db = mem()
    const { f, calls } = fakeYahoo()
    expect(ensureHistoryPack(db, f, NOW, quiet())).toBeNull()
    expect(calls).toHaveLength(0)
    expect(historyPending(db, '2026-09-23')).toEqual({
      ready: false,
      building: false,
      done: 0,
      total: 0,
      reason: 'The server has no price basket yet, so no market history either',
    })
    seedBasket(db, 1)
    expect(historyPending(db, '2026-09-23').reason).toBe('The server hasn’t built the market history yet')
  })

  it('fetches ≤20 symbols a call, paced, over several runs; saves progress; swaps the file in only when complete', async () => {
    const db = mem()
    seedBasket(db, 45) // 46 symbols: 3 calls
    const { f, calls } = fakeYahoo()
    const sleeps: number[] = []
    const opts = quiet({ runCalls: 2, sleep: async (ms) => void sleeps.push(ms) })

    const run1 = await ensureHistoryPack(db, f, NOW, opts)
    expect(run1).toEqual({ calls: 2, fetched: 40, done: false, blocked: false, errors: [] })
    expect(sleeps).toEqual([5]) // one pause, between the two calls
    expect(historyStatus(db).ready).toBe(false)
    expect(historyPending(db, '2026-09-23')).toEqual({
      ready: false,
      building: true,
      done: 40,
      total: 46,
      reason: 'The server is still building the market history (86% done)',
    })
    const pending = await packResponse(db, 'gzip', undefined)
    expect(pending.status).toBe(202)
    expect(pending.headers.get('cache-control')).toBe('no-store')
    expect(((await pending.json()) as { done: number }).done).toBe(40)
    expect(meta(db, 'basket:history:part:%')).toEqual(['basket:history:part:0'])

    const run2 = await ensureHistoryPack(db, f, later(60_000), opts)
    expect(run2).toMatchObject({ calls: 1, fetched: 6, done: true })
    // Every call: at most HISTORY_BATCH symbols, ten years of months, coins as SYM-USD.
    expect(calls.map((c) => c.symbols.length)).toEqual([20, 20, 6])
    expect(calls.every((c) => c.symbols.length <= HISTORY_BATCH && /range=10y&interval=1mo$/.test(c.url))).toBe(true)
    expect(calls[0]!.url.startsWith('https://query1.finance.yahoo.com/v8/finance/spark?symbols=S00%2CS01%2C')).toBe(true)
    expect(calls[2]!.symbols).toEqual(['S40', 'S41', 'S42', 'S43', 'S44', 'BTC-USD'])

    const pack = loadPack(db)!
    expect(pack).toMatchObject({ v: 1, start: '2016-09', final: '2026-08', asOf: '2026-09-23' })
    expect(Object.keys(pack.stock)).toHaveLength(45)
    expect(Object.keys(pack.crypto)).toEqual(['BTC'])
    const s07 = decodeMonthly(pack.start, pack.stock.S07)!
    expect(s07[0]).toEqual({ month: '2023-09', cents: Math.round(closeOf('S07', 0) * 100) })
    expect(s07.find((r) => r.month === '2026-08')!.cents).toBe(Math.round(closeOf('S07', 35) * 100))
    // September — in progress — is today's basket quote, not Yahoo's live bar.
    expect(s07.at(-1)).toEqual({ month: '2026-09', cents: 50_007 })
    expect(decodeMonthly(pack.start, pack.crypto.BTC)!.at(-1)).toEqual({ month: '2026-09', cents: 11_300_000 })
    // The build's scratch rows are gone; the file and its head stay.
    expect(meta(db, 'basket:history%')).toEqual(['basket:history:head', HISTORY_KEY])
    expect(historyStatus(db)).toMatchObject({ ready: true, final: '2026-08', asOf: '2026-09-23' })
    // Current through last month: nothing is due until October.
    expect(ensureHistoryPack(db, f, later(DAY), opts)).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it('never runs twice at once, and waits out the gap between runs', async () => {
    const db = mem()
    seedBasket(db, 45)
    const { f, calls } = fakeYahoo()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const opts: HistoryRunOptions = { paceMs: 5, runCalls: 1, sleep: async () => {} }
    const slow = (async (...a: Parameters<typeof fetch>) => {
      await gate
      return f(...a)
    }) as typeof fetch
    const a = ensureHistoryPack(db, slow, NOW, opts)
    const b = ensureHistoryPack(db, slow, NOW, opts)
    expect(a).not.toBeNull()
    expect(b).toBe(a) // the caller joins the running build
    release()
    await a
    expect(calls).toHaveLength(1)
    expect(ensureHistoryPack(db, f, later(5 * 60_000), opts)).toBeNull() // default gap: 20 minutes
    expect(await ensureHistoryPack(db, f, later(21 * 60_000), opts)).toMatchObject({ calls: 1, done: false })
    expect(calls).toHaveLength(2)
  })

  it('stops for the day when Yahoo refuses, and retries the same batch tomorrow', async () => {
    for (const refusal of [429, 403, 503, 'throw', 'garbage'] as const) {
      const db = mem()
      seedBasket(db, 45)
      const { f, calls } = fakeYahoo((n) => (n === 1 ? refusal : null))
      const run = await ensureHistoryPack(db, f, NOW, quiet())
      expect(run, String(refusal)).toMatchObject({ calls: 2, fetched: 20, done: false, blocked: true })
      expect(run!.errors).toHaveLength(1)
      expect(historyPending(db, '2026-09-23').reason).toBe(
        'The server’s market-history build paused after an upstream error (43% done); it resumes tomorrow',
      )
      expect(ensureHistoryPack(db, f, later(60 * 60_000), quiet())).toBeNull()
      const next = await ensureHistoryPack(db, f, later(DAY), quiet())
      expect(next).toMatchObject({ calls: 2, fetched: 26, done: true, blocked: false })
      expect(calls[2]!.symbols[0]).toBe('S20') // the refused batch, again
      expect(Object.keys(loadPack(db)!.stock)).toHaveLength(45)
    }
  })

  it('skips a batch Yahoo answers with a plain error, and keeps to the day’s call budget', async () => {
    const db = mem()
    seedBasket(db, 45)
    const { f, calls } = fakeYahoo((n) => (n === 0 ? 404 : null))
    const run1 = await ensureHistoryPack(db, f, NOW, quiet({ dayCalls: 2 }))
    expect(run1).toEqual({ calls: 2, fetched: 20, done: false, blocked: false, errors: ['history: batch S00… HTTP 404'] })
    expect(ensureHistoryPack(db, f, later(60_000), quiet({ dayCalls: 2 }))).toBeNull() // today's budget is spent
    expect(await ensureHistoryPack(db, f, later(DAY), quiet({ dayCalls: 2 }))).toMatchObject({ calls: 1, done: true })
    expect(calls).toHaveLength(3)
    const pack = loadPack(db)!
    // Skipped, not retried: the skipped symbols carry only today's basket quote until the next build.
    expect(decodeMonthly(pack.start, pack.stock.S00)).toEqual([{ month: '2026-09', cents: 50_000 }])
    expect(decodeMonthly(pack.start, pack.stock.S19)).toEqual([{ month: '2026-09', cents: 50_019 }])
    expect(decodeMonthly(pack.start, pack.stock.S20)).toHaveLength(37) // 2023-09 … 2026-09
    expect(Object.keys(pack.stock)).toHaveLength(45)
  })

  it('rebuilds once a month has closed, and serves the old file until the new one is complete', async () => {
    const db = mem()
    seedBasket(db, 45)
    const old: HistoryPack = { v: 1, start: '2016-08', final: '2026-07', asOf: '2026-08-31', builtAt: '2026-08-01T00:00:00.000Z', stock: { S00: [0, 1] }, crypto: {} }
    storePack(db, old)
    const { f, calls } = fakeYahoo()
    const run = await ensureHistoryPack(db, f, NOW, quiet({ runCalls: 1 }))
    expect(run).toMatchObject({ calls: 1, done: false })
    const served = await packResponse(db, undefined, undefined)
    expect(served.status).toBe(200)
    expect(await served.json()).toEqual(old)
    await ensureHistoryPack(db, f, later(60_000), quiet())
    expect(calls).toHaveLength(3)
    expect(loadPack(db)!.final).toBe('2026-08')
  })

  it('starts over when its saved state is unreadable', async () => {
    const db = mem()
    seedBasket(db, 3)
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:history:build', ?)").run(
      JSON.stringify({ v: 1, startedOn: '2026-09-23', start: '2016-09', next: 0, parts: 0, day: '2026-09-23', calls: 0, lastRunAt: null, blockedOn: null, missing: 0, errors: [] }),
    )
    const { f, calls } = fakeYahoo()
    expect(await ensureHistoryPack(db, f, NOW, quiet())).toMatchObject({ calls: 0, done: false, errors: ['history: build state unreadable; starting over'] })
    expect(await ensureHistoryPack(db, f, later(1), quiet())).toMatchObject({ calls: 1, done: true })
    expect(calls).toHaveLength(1)
  })
})

/* ---------- serving: one file for everyone ---------- */

const FILE: HistoryPack = {
  v: 1,
  start: '2016-09',
  final: '2026-08',
  asOf: '2026-09-22',
  builtAt: '2026-09-01T06:00:00.000Z',
  stock: {
    SPY: encodeMonthly('2016-09', monthsOf('2024-01', 33, (i) => 47_000 + 300 * i)),
    VTI: encodeMonthly('2016-09', monthsOf('2024-01', 33, (i) => 20_000 + 150 * i)),
    QQQ: encodeMonthly('2016-09', monthsOf('2026-01', 9, (i) => 45_000 + 500 * i)),
  },
  crypto: { BTC: encodeMonthly('2016-09', monthsOf('2025-01', 21, (i) => 6_000_000 + 10_000 * i)) },
}

describe('compressing the file: once per file, off the event loop', () => {
  /** 2,000 symbols × ten years (~0.7 MB of JSON; the real file is ~3.5 MB): enough that gzip takes real time. */
  const months = monthsOf('2016-09', 120, () => 1).map((m) => m.month)
  const bigFile = (salt: number): HistoryPack => ({
    ...FILE,
    builtAt: `2026-09-01T06:00:0${salt}.000Z`,
    stock: Object.fromEntries(
      Array.from({ length: 2_000 }, (_, i) => [
        `S${i}`,
        encodeMonthly('2016-09', months.map((month, m) => ({ month, cents: 1_000 + ((i * 7919 + m * 104_729 + salt) % 50_000) }))),
      ]),
    ),
  })

  it('gzips at level 6, and a request waiting for it never blocks the rest of the server', async () => {
    const db = mem()
    const file = bigFile(1)
    storePack(db, file) // starts the compression; the request below arrives while it runs
    const order: string[] = []
    setTimeout(() => order.push('another request'), 0)
    const r = await packResponse(db, 'gzip', undefined)
    order.push('history served')
    expect(order).toEqual(['another request', 'history served'])
    expect(r.headers.get('content-encoding')).toBe('gzip')
    const gz = Buffer.from(await r.arrayBuffer())
    expect(gz.equals(gzipSync(JSON.stringify(file), { level: 6 }))).toBe(true)
  })

  it('after a restart (a file stored by an earlier process) the first request compresses it, off the event loop', async () => {
    const db = mem()
    const file = bigFile(2)
    // Written the way storePack writes it, but without this process's cache: what a fresh boot finds.
    const scratch = mem()
    storePack(scratch, file)
    for (const key of [HISTORY_KEY, 'basket:history:head']) {
      const { value } = scratch.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string }
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(key, value)
    }
    storePack(mem(), bigFile(3)) // the cache now holds some other file
    const order: string[] = []
    setTimeout(() => order.push('another request'), 0)
    const [a, b] = await Promise.all([packResponse(db, 'gzip', undefined), packResponse(db, 'gzip, br', undefined)])
    order.push('history served')
    expect(order).toEqual(['another request', 'history served'])
    const [ga, gb] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())]
    expect(ga.equals(gb)).toBe(true)
    expect(JSON.parse(gunzipSync(ga).toString('utf8'))).toEqual(file)
  })
})

describe('GET /api/basket/history and the routes around it', () => {
  process.env.DB_PATH = ':memory:'
  process.env.NODE_ENV = 'test'
  let db: DbLike
  let mod: typeof import('./app')
  // Nothing here may reach the network: the singleton database never gets a basket, so no build is ever due.
  const network = vi.fn(async () => {
    throw new Error('no network in tests')
  })
  beforeAll(async () => {
    vi.stubGlobal('fetch', network)
    mod = await import('./app')
    db = (await import('./db')).db as unknown as DbLike
  })
  const as = (email: string, extra: Record<string, string> = {}) => ({ headers: { 'x-goog-authenticated-user-email': `accounts.google.com:${email}`, ...extra } })

  it('answers 202 with the reason while there is no file, on both kinds of server', async () => {
    for (const zkOnly of [false, true]) {
      const r = await mod.createApp({ zkOnly }).request('/api/basket/history', as('max@example.com'))
      expect(r.status).toBe(202)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.json()).toEqual({
        ready: false,
        building: false,
        done: 0,
        total: 0,
        reason: 'The server has no price basket yet, so no market history either',
      })
    }
    expect(serverMarket(db)).toEqual({ marketPending: 'The server has no price basket yet, so no market history either' })
    expect(applyServerHistory(db)).toEqual({ written: 0, matched: 0, errors: [], final: null, pending: true })
  })

  it('serves a vault-only server’s callers byte-identical files: gzip when asked, 304 when unchanged', async () => {
    storePack(db, FILE)
    const zk = mod.createApp({ zkOnly: true })
    const bodies: Buffer[] = []
    const tags: (string | null)[] = []
    for (const who of ['max@example.com', 'nicole@example.com']) {
      const r = await zk.request('/api/basket/history', as(who, { 'accept-encoding': 'gzip, deflate, br' }))
      expect(r.status).toBe(200)
      expect(r.headers.get('content-encoding')).toBe('gzip')
      expect(r.headers.get('cache-control')).toBe('no-cache')
      bodies.push(Buffer.from(await r.arrayBuffer()))
      tags.push(r.headers.get('etag'))
    }
    expect(bodies[1]!.equals(bodies[0]!)).toBe(true)
    expect(tags[1]).toBe(tags[0])
    expect(tags[0]).toMatch(/^"[0-9a-f]{32}"$/)
    expect(JSON.parse(gunzipSync(bodies[0]!).toString('utf8'))).toEqual(FILE)
    // Without gzip: the same JSON, for either identity.
    const plain = await Promise.all(['max@example.com', 'nicole@example.com'].map(async (w) => (await zk.request('/api/basket/history', as(w))).text()))
    expect(plain[1]).toBe(plain[0])
    expect(JSON.parse(plain[0]!)).toEqual(FILE)
    // Revalidation: an unchanged file is a 304 with no body, weak tag or not.
    for (const inm of [tags[0]!, `W/${tags[0]}`, `"other", ${tags[0]}`]) {
      const r = await zk.request('/api/basket/history', as('max@example.com', { 'if-none-match': inm }))
      expect(r.status, inm).toBe(304)
      expect(await r.text()).toBe('')
    }
    expect((await zk.request('/api/basket/history', as('max@example.com', { 'if-none-match': '"stale"' }))).status).toBe(200)
    // The basket says which file is current, so a tab asks only when there is one. (Stamp today's
    // basket attempt first, so GET /api/basket doesn't start a real build.)
    db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('basket:attempted_on', ?)").run(new Date().toISOString().slice(0, 10))
    const basket = (await (await zk.request('/api/basket', as('max@example.com'))).json()) as { history: unknown }
    expect(basket.history).toEqual({ ready: true, etag: tags[0], final: '2026-08', asOf: '2026-09-22' })
    // Only the file is on the vault-only list: applying it and the series stay plaintext-only.
    for (const [method, path] of [['POST', '/api/prices/history'], ['GET', '/api/series?ids=bench:SPY'], ['GET', '/api/series/catalog']])
      expect((await zk.request(path!, { method, ...as('max@example.com') })).status, path).toBe(403)
  })

  it('gives a household server benchmarks from the file in memory, and POST /api/prices/history writes only held assets', async () => {
    storePack(db, FILE)
    seedHousehold(db) // VTI, QQQ and bitcoin; no SPY
    const app = mod.createApp({ zkOnly: false })
    const pricesBefore = (db.prepare('SELECT count(*) AS n FROM prices').get() as { n: number }).n

    const res = (await (await app.request('/api/series?ids=bench:SPY,bench:BTC')).json()) as { series: { id: string; points: { t: string; v: number }[] }[]; warnings: string[] }
    expect(res.warnings).toEqual([])
    expect(res.series.map((s) => [s.id, s.points[0]])).toEqual([
      ['bench:SPY', { t: '2024-01', v: 1_000_000 }],
      ['bench:BTC', { t: '2025-01', v: 1_000_000 }],
    ])
    const catalog = (await (await app.request('/api/series/catalog')).json()) as { entries: { id: string; available: boolean }[] }
    expect(catalog.entries.find((e) => e.id === 'bench:SPY')?.available).toBe(true)
    expect((db.prepare('SELECT count(*) AS n FROM prices').get() as { n: number }).n).toBe(pricesBefore) // reading writes nothing

    const applied = await app.request('/api/prices/history', { method: 'POST' })
    expect(applied.status).toBe(200)
    // VTI 2024-01 … 2026-08 less the household's two month ends; QQQ 2026-01 … 08; bitcoin 2025-01 … 2026-08.
    expect(await applied.json()).toEqual({ written: 30 + 8 + 20, matched: 3, errors: [], final: '2026-08', pending: false })
    expect((db.prepare("SELECT count(*) AS n FROM assets WHERE symbol = 'SPY'").get() as { n: number }).n).toBe(0)
    const again = (await (await app.request('/api/prices/history', { method: 'POST' })).json()) as { written: number }
    expect(again.written).toBe(0)
    expect(network).not.toHaveBeenCalled()
  })
})
