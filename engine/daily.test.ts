import { describe, expect, it } from 'vitest'
import { dailyBucket } from '../shared/buckets'
import { addDaysIso } from '../shared/dates'
import type { DailyBucket } from '../shared/series-api'
import type { DbLike } from './db'
import { bucketCloses, dayIndex, decodeDaily, encodeDaily, getChartData, isDailyBucket, type DayClose } from './prices'
import { onBothEngines } from './test/parity'

/** `n` trading days from `first` (skipping Saturdays and Sundays), the i-th close f(i). */
function tradingDays(first: string, n: number, f: (i: number) => number): DayClose[] {
  const out: DayClose[] = []
  let d = first
  while (out.length < n) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) out.push({ d, c: f(out.length) })
    d = addDaysIso(d, 1)
  }
  return out
}

describe('the daily encoding: [offset, first, Δ…] on a calendar-day axis', () => {
  it('round-trips closes with weekends, falls and a first day past `start`', () => {
    const closes = [
      { d: '2026-01-05', c: 10_000 }, // a Monday
      { d: '2026-01-06', c: 9_000 },
      { d: '2026-01-09', c: 25_000 }, // Wednesday and Thursday had no close
      { d: '2026-01-12', c: 25_000 }, // over the weekend
    ]
    const enc = encodeDaily('2026-01-01', closes)
    expect(enc).toEqual([4, 10_000, -1_000, null, null, 16_000, null, null, 0])
    expect(decodeDaily('2026-01-01', enc)).toEqual(closes)
    expect(dayIndex('2026-01-01', '2026-01-05')).toBe(4)
    expect(dayIndex('2024-02-28', '2024-03-01')).toBe(2) // a leap day in between
    // Two years of a big price, trading days only, stays exact.
    const brk = tradingDays('2024-10-21', 504, (i) => 70_000_000 + 13_579 * i * (i % 2 ? -1 : 1))
    const two = encodeDaily('2024-10-20', brk)
    expect(decodeDaily('2024-10-20', two)).toEqual(brk)
    expect(two.length).toBeLessThan(740) // ~730 calendar days: nulls for the weekends, one entry per close
    expect(encodeDaily('2026-01-01', [])).toEqual([])
  })

  it('refuses to decode a malformed array (it crossed a network) and to encode bad input', () => {
    for (const bad of ['x', null, [], [1], [-1, 5], [4001, 5], [0, 0], [0, 5, -5], [0, 5, 1.5], [0, 5, '1'], [0.5, 5]])
      expect(decodeDaily('2026-01-01', bad), JSON.stringify(bad)).toBeNull()
    expect(decodeDaily('2026-1-1', [0, 5])).toBeNull()
    expect(decodeDaily('2026-13-01', [0, 5])).toBeNull()
    expect(() => encodeDaily('2026-01-01', [{ d: '2026-01-02', c: 5 }, { d: '2026-01-01', c: 5 }])).toThrow(/out of order/)
    expect(() => encodeDaily('2026-01-01', [{ d: '2026-01-02', c: 5 }, { d: '2026-01-02', c: 6 }])).toThrow(/out of order/)
    expect(() => encodeDaily('2026-01-01', [{ d: '2025-12-31', c: 5 }])).toThrow(/out of order/)
    expect(() => encodeDaily('2026-01-01', [{ d: '2026-01-02', c: 0 }])).toThrow(/bad close/)
    expect(() => encodeDaily('2026-01-01', [{ d: '2026-01-02', c: 1.5 }])).toThrow(/bad close/)
  })

  it('reads a bucket file by kind and symbol, and recognises one off the wire', () => {
    const file: DailyBucket = {
      v: 1,
      bucket: 3,
      of: 64,
      start: '2024-10-01',
      asOf: '2026-09-22',
      builtAt: '2026-09-01T00:00:00.000Z',
      stock: { SPY: encodeDaily('2024-10-01', [{ d: '2026-09-21', c: 60_000 }, { d: '2026-09-22', c: 60_100 }]), BTC: [0, 4_000] },
      crypto: { BTC: [8, 6_000_000] },
    }
    expect(isDailyBucket(file)).toBe(true)
    expect(bucketCloses(file, 'stock', 'SPY')).toEqual([{ d: '2026-09-21', c: 60_000 }, { d: '2026-09-22', c: 60_100 }])
    expect(bucketCloses(file, 'stock', 'BTC')).toEqual([{ d: '2024-10-01', c: 4_000 }])
    expect(bucketCloses(file, 'crypto', 'BTC')).toEqual([{ d: '2024-10-09', c: 6_000_000 }])
    expect(bucketCloses(file, 'crypto', 'SPY')).toBeNull()
    for (const nope of ['NOPE', '__proto__', 'constructor', 'toString']) expect(bucketCloses(file, 'stock', nope)).toBeNull()
    for (const bad of [
      null,
      [],
      { ...file, v: 2 },
      { ...file, bucket: 64 },
      { ...file, bucket: -1 },
      { ...file, of: 0 },
      { ...file, start: '2024-10' },
      { ...file, asOf: 'today' },
      { ...file, stock: [] },
      { ...file, crypto: null },
    ])
      expect(isDailyBucket(bad), JSON.stringify(bad)).toBe(false)
  })
})

/* ---------- the chart: a bucket's closes as the spine ---------- */

const TODAY = '2026-09-22'

/** One brokerage account, VTI bought in 2024, then the price rows given. */
function seed(db: DbLike, rows: { table: 'prices' | 'prices_daily'; d: string; c: number }[]) {
  db.prepare("INSERT INTO invest_accounts (id, name, kind, tracking) VALUES (1, 'Taxable', 'brokerage', 'lots')").run()
  db.prepare("INSERT INTO assets (id, symbol, kind) VALUES (1, 'VTI', 'stock')").run()
  db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '2024-03-15', 'buy', 10000000, 2000000)").run()
  for (const r of rows) db.prepare(`INSERT INTO ${r.table} (asset_id, priced_on, close_cents) VALUES (1, ?, ?)`).run(r.d, r.c)
}

/** The bucket's closes for VTI: every trading day from 2024-10-21 to 2026-09-21 (yesterday); the crawl is a day behind the basket. */
const MARKET: DayClose[] = (() => {
  const out: DayClose[] = []
  let d = '2024-10-21'
  while (d <= '2026-09-21') {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (dow !== 0 && dow !== 6) out.push({ d, c: 20_000 + out.length })
    d = addDaysIso(d, 1)
  }
  return out
})()

describe('getChartData with a bucket’s closes', () => {
  const own = [
    // Month ends from the monthly history import, years before the bucket reaches; one inside its range.
    { table: 'prices' as const, d: '2023-12-31', c: 18_000 },
    { table: 'prices' as const, d: '2024-06-30', c: 19_000 },
    { table: 'prices' as const, d: '2024-10-31', c: 1 }, // inside the spine's first month: left out
    { table: 'prices' as const, d: '2025-03-31', c: 1 }, // inside the spine's range: the spine's day wins by being the spine
    // The basket quotes this tab has collected: an overlapping day (the bucket's close wins) and today (only the tab has it).
    { table: 'prices_daily' as const, d: '2026-09-21', c: 99_999 },
    { table: 'prices_daily' as const, d: '2026-09-22', c: 30_500 },
    { table: 'prices' as const, d: '2026-09-22', c: 30_500 },
  ]

  it('joins the bucket with the tab’s own daily quotes, fills the years before from month ends, and says where the history starts', async () => {
    const { server, browser } = await onBothEngines(
      (db) => seed(db, own),
      (db) => getChartData(db, 'vti', [], MARKET),
    )
    expect(browser).toEqual(server) // the join is the engine's: identical on both engines
    const closes = server.closes
    expect(closes[0]).toEqual({ d: '2023-12-31', c: 18_000 })
    expect(closes[1]).toEqual({ d: '2024-06-30', c: 19_000 })
    expect(closes[2]).toEqual({ d: '2024-10-21', c: 20_000 }) // the spine starts; 2024-10-31's month-end row is left out
    expect(closes.find((p) => p.d === '2025-03-31')).toEqual(MARKET.find((p) => p.d === '2025-03-31')) // not the quote table's 1¢
    expect(closes.find((p) => p.d === '2026-09-21')).toEqual({ d: '2026-09-21', c: MARKET.at(-1)!.c }) // the bucket's close, not the tab's quote
    expect(closes.at(-1)).toEqual({ d: '2026-09-22', c: 30_500 }) // today: the tab's own quote, after the bucket's last day
    expect(closes).toHaveLength(2 + MARKET.length + 1)
    expect(server.coverage).toEqual({ firstOn: '2023-12-31', days: closes.length, source: 'quotes', dailyFrom: '2024-10-21' })
    expect(server.kind).toBe('stock')
  })

  it('without a bucket draws what the tab has, as before', async () => {
    const { server, browser } = await onBothEngines(
      (db) => seed(db, own),
      (db) => [getChartData(db, 'VTI'), getChartData(db, 'VTI', [], null), getChartData(db, 'VTI', [], [])],
    )
    expect(browser).toEqual(server)
    for (const r of server) {
      expect(r.closes.map((p) => p.d)).toEqual(['2023-12-31', '2024-06-30', '2024-10-31', '2025-03-31', '2026-09-21', '2026-09-22'])
      expect(r.coverage).toEqual({ firstOn: '2023-12-31', days: 6, source: 'quotes', dailyFrom: '2026-09-21' })
    }
  })

  it('a bucket alone is the whole chart, dated daily', async () => {
    const { server, browser } = await onBothEngines(
      (db) => seed(db, []),
      (db) => getChartData(db, 'VTI', [], MARKET.slice(-5)),
    )
    expect(browser).toEqual(server)
    expect(server.closes).toEqual(MARKET.slice(-5))
    expect(server.coverage).toEqual({ firstOn: MARKET.at(-5)!.d, days: 5, source: 'daily', dailyFrom: MARKET.at(-5)!.d })
  })

  it('the bucket a symbol is read from is the one the shared function names, on both engines', async () => {
    const { server, browser } = await onBothEngines(
      () => {},
      () => ['SPY', 'VTI', 'BRK.B', 'BRK-B', 'BTC'].map((s) => dailyBucket('stock', s)),
    )
    expect(browser).toEqual(server)
    expect(server[2]).toBe(server[3])
  })
})
