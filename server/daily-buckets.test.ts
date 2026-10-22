import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { decodeDaily, encodeDaily, type DayClose } from '../engine/prices'
import { DAILY_BUCKETS, dailyBucket } from '../shared/buckets'
import type { DailyBucket } from '../shared/series-api'
import { readBudget } from './crawl-budget'
import { appendDailyQuotes, BODY_CACHE_MAX, bucketResponse, cachedBodies, dailyPending, dailyStatus, ensureDailyBuckets, isDailyBuilding, loadBucket, mergeDailyQuotes, parseSparkDaily, storeBuckets } from './daily-buckets'
import { HISTORY_BATCH, type HistoryRunOptions } from './history-pack'
import { openDb } from './migrations'

const mem = () => openDb(':memory:') as unknown as DbLike
const meta = (db: DbLike, like: string) =>
  (db.prepare('SELECT key FROM app_meta WHERE key LIKE ? ORDER BY key').all(like) as { key: string }[]).map((r) => r.key)
const NOW = new Date('2026-10-02T09:17:00Z')
const later = (ms: number, from = NOW) => new Date(from.getTime() + ms)
const DAY = 86_400_000

/** Unix seconds at a day's New York open (13:30Z in summer) — how Yahoo stamps a US daily bar — or midnight UTC for crypto. */
const dayOpen = (iso: string, hour = 13, minute = 30) => Date.parse(`${iso}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`) / 1000

/* ---------- Yahoo's daily bars ---------- */

describe('parseSparkDaily', () => {
  it('reads v8 replies: floats become cents once, a later bar for a day wins, future days and junk drop, coins at midnight UTC', () => {
    const body = {
      AAPL: { timestamp: [dayOpen('2026-09-29'), dayOpen('2026-09-30'), dayOpen('2026-10-01'), dayOpen('2026-10-01', 19, 59), dayOpen('2026-10-03')], symbol: 'AAPL', close: [229.355, null, 232.1, 233, 240] },
      'BTC-USD': { timestamp: [dayOpen('2026-09-30', 0, 0), dayOpen('2026-10-01', 0, 0)], symbol: 'BTC-USD', close: [112_000.456, 112_500.994] },
      JUNK: { timestamp: [dayOpen('2026-09-29'), dayOpen('2026-09-30')], symbol: 'JUNK', close: [0, -3] },
    }
    const got = parseSparkDaily(body, '2026-10-02')
    expect(got.get('AAPL')).toEqual([
      { d: '2026-09-29', c: 22_936 }, // 229.355 → 22935.5 rounds up; the 30th had no close
      { d: '2026-10-01', c: 23_300 }, // the day's later bar wins; the 3rd is after today
    ])
    expect(got.get('BTC-USD')).toEqual([{ d: '2026-09-30', c: 11_200_046 }, { d: '2026-10-01', c: 11_250_099 }])
    expect(got.has('JUNK')).toBe(false)
    for (const junk of [null, 'x', 42, [], { spark: { result: null } }, { A: { timestamp: 'x', close: [] } }]) expect(parseSparkDaily(junk, '2026-10-02').size).toBe(0)
  })

  it('reads v7 replies in the exchange’s own zone', () => {
    // Tokyo's session opens at 09:00 local = 00:00Z; a bar at Oct 1 00:00Z is Oct 1 in Tokyo too, but one at Sep 30 23:00Z is Oct 1 there.
    const v7 = { spark: { result: [{ symbol: '7203.T', response: [{ meta: { exchangeTimezoneName: 'Asia/Tokyo' }, timestamp: [Date.parse('2026-09-30T23:00:00Z') / 1000], indicators: { quote: [{ close: [2_800] }] } }] }] } }
    expect(parseSparkDaily(v7, '2026-10-02').get('7203.T')).toEqual([{ d: '2026-10-01', c: 280_000 }])
  })
})

/* ---------- folding the daily basket in ---------- */

const START = '2024-10-02'
const file = (bucket: number, stock: Record<string, DayClose[]> = {}, crypto: Record<string, DayClose[]> = {}): DailyBucket => ({
  v: 1,
  bucket,
  of: DAILY_BUCKETS,
  start: START,
  asOf: '2026-10-01',
  builtAt: '2026-10-01T12:00:00.000Z',
  stock: Object.fromEntries(Object.entries(stock).map(([s, rows]) => [s, encodeDaily(START, rows)])),
  crypto: Object.fromEntries(Object.entries(crypto).map(([s, rows]) => [s, encodeDaily(START, rows)])),
})
const q = (symbol: string, pricedOn: string, cents: number, kind = 'stock') => ({ symbol, kind, cents, pricedOn })

describe('mergeDailyQuotes / appendDailyQuotes', () => {
  it('extends a series over the weekend, replaces the latest day, ignores what the crawl already settled, starts a new symbol', () => {
    const f = file(0, { VTI: [{ d: '2026-09-30', c: 30_000 }, { d: '2026-10-01', c: 30_100 }] })
    expect(mergeDailyQuotes(f, [q('VTI', '2026-10-01', 30_150)], '2026-10-01')).toBe(true) // the latest day, revised
    expect(decodeDaily(START, f.stock.VTI!)!.at(-1)).toEqual({ d: '2026-10-01', c: 30_150 })
    expect(mergeDailyQuotes(f, [q('VTI', '2026-10-05', 30_500), q('NEW', '2026-10-05', 1_234), q('BTC', '2026-10-05', 6_000_000, 'crypto')], '2026-10-05')).toBe(true)
    expect(decodeDaily(START, f.stock.VTI!)).toEqual([{ d: '2026-09-30', c: 30_000 }, { d: '2026-10-01', c: 30_150 }, { d: '2026-10-05', c: 30_500 }])
    expect(f.stock.VTI!.slice(-4)).toEqual([null, null, null, 350]) // the 2nd, 3rd and 4th had no close
    expect(decodeDaily(START, f.stock.NEW!)).toEqual([{ d: '2026-10-05', c: 1_234 }])
    expect(decodeDaily(START, f.crypto.BTC!)).toEqual([{ d: '2026-10-05', c: 6_000_000 }])
    expect(f.asOf).toBe('2026-10-05')
    // A quote stamped tomorrow in UTC (a late session) is today's close, never tomorrow's.
    expect(mergeDailyQuotes(f, [q('VTI', '2026-10-06', 30_600)], '2026-10-05')).toBe(true)
    expect(decodeDaily(START, f.stock.VTI!)!.at(-1)).toEqual({ d: '2026-10-05', c: 30_600 })
    expect(f.asOf).toBe('2026-10-05')
    const before = JSON.stringify(f)
    const ignored = [
      q('VTI', '2026-09-30', 1), // a day the crawl settled
      q('VTI', '2026-10-05', 30_600), // the same close again
      q('VTI', '2026-10-05', 30_600, 'bond'),
      q('__proto__', '2026-10-05', 5),
      q('brk.b', '2026-10-05', 5),
      q('VTI', '2026-10-05', 0),
      q('VTI', '2026-10-05', 1.5),
      q('VTI', '2026-10-5', 5),
      q('VTI', '2026-10-07', 5), // two days ahead of today
      q('OLD', '2024-10-01', 5), // before the file's first day
    ]
    expect(mergeDailyQuotes(f, ignored, '2026-10-05')).toBe(false)
    expect(JSON.stringify(f)).toBe(before)
    expect(Object.getPrototypeOf(f.stock)).toBe(Object.prototype)
  })

  it('keys the head’s ETags by bucket whatever order the files are stored in, and wants the whole deal', () => {
    const db = mem()
    const files = Array.from({ length: DAILY_BUCKETS }, (_, b) => file(b))
    files[5]!.stock.ONLY5 = encodeDaily(START, [{ d: '2026-10-01', c: 1 }])
    storeBuckets(db, [...files].reverse(), '2026-10-01T12:00:00.000Z')
    const head = JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key = 'basket:daily:head'").get()!['value' as never]) as { etags: string[]; of: number }
    expect(head.of).toBe(DAILY_BUCKETS)
    const etagOf = (f: DailyBucket) => `"${createHash('sha256').update(JSON.stringify(f)).digest('hex').slice(0, 32)}"`
    expect(head.etags[5]).toBe(etagOf(files[5]!))
    expect(head.etags[0]).toBe(etagOf(files[0]!))
    expect(loadBucket(db, 5)!.stock.ONLY5).toBeDefined()
    for (const bad of [[], [file(0), file(0)], [file(1)], files.slice(0, 63)]) expect(() => storeBuckets(db, bad, 'x'), String(bad.length)).toThrow(/expected buckets/)
  })

  it('deals the basket’s quotes to their buckets, rewrites only the files that changed, and moves the head on', () => {
    const db = mem()
    expect(appendDailyQuotes(db, [q('VTI', '2026-10-02', 1)], '2026-10-02')).toBe(0) // no files yet
    expect(meta(db, 'basket:daily:%')).toEqual([])
    const files = Array.from({ length: DAILY_BUCKETS }, (_, b) => file(b))
    const vti = dailyBucket('stock', 'VTI')
    const btc = dailyBucket('crypto', 'BTC')
    files[vti]!.stock.VTI = encodeDaily(START, [{ d: '2026-10-01', c: 30_000 }])
    storeBuckets(db, files, '2026-10-01T12:00:00.000Z')
    expect(dailyStatus(db)).toEqual({ ready: true, asOf: '2026-10-01', of: DAILY_BUCKETS })
    const headBefore = JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key = 'basket:daily:head'").get()!['value' as never]) as { etags: string[] }
    expect(appendDailyQuotes(db, [q('VTI', '2026-10-02', 30_200), q('BTC', '2026-10-02', 6_000_000, 'crypto'), q('VTI', '2026-10-01', 30_000)], '2026-10-02')).toBe(2)
    const headAfter = JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key = 'basket:daily:head'").get()!['value' as never]) as { etags: string[]; asOf: string }
    expect(headAfter.asOf).toBe('2026-10-02')
    const changed = headAfter.etags.map((e, i) => (e !== headBefore.etags[i] ? i : -1)).filter((i) => i >= 0)
    expect(changed.sort((a, b) => a - b)).toEqual([...new Set([vti, btc])].sort((a, b) => a - b))
    expect(decodeDaily(START, loadBucket(db, vti)!.stock.VTI!)).toEqual([{ d: '2026-10-01', c: 30_000 }, { d: '2026-10-02', c: 30_200 }])
    expect(decodeDaily(START, loadBucket(db, btc)!.crypto.BTC!)).toEqual([{ d: '2026-10-02', c: 6_000_000 }])
    // The same quotes again change nothing.
    expect(appendDailyQuotes(db, [q('VTI', '2026-10-02', 30_200)], '2026-10-02')).toBe(0)
  })
})

/* ---------- building the files from Yahoo ---------- */

function seedBasket(db: DbLike, stocks: number) {
  const put = db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES (?, ?, ?, '2026-10-02')")
  for (let i = 0; i < stocks; i++) put.run(`S${String(i).padStart(2, '0')}`, 'stock', 50_000 + i)
  put.run('BTC', 'crypto', 11_300_000)
}

/** Fake Yahoo spark for interval=1d: closes for the ten trading days to 2026-10-01 plus Yahoo's live bar for the 2nd; `fail(n)` can refuse call n. */
function fakeYahoo(fail: (n: number) => number | 'throw' | 'garbage' | null = () => null) {
  const calls: { url: string; symbols: string[] }[] = []
  const days = ['2026-09-18', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01']
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    const symbols = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '').split(',')
    const n = calls.length
    calls.push({ url, symbols })
    const how = fail(n)
    if (how === 'throw') throw new TypeError('fetch failed')
    if (how === 'garbage') return new Response('<html>consent</html>', { status: 200 })
    if (typeof how === 'number') return new Response('{}', { status: how })
    return Response.json(
      Object.fromEntries(
        symbols.map((s) => {
          const coin = s.endsWith('-USD')
          const ts = [...days.map((d) => dayOpen(d, coin ? 0 : 13, coin ? 0 : 30)), dayOpen('2026-10-02', 15, 0)]
          return [s, { timestamp: ts, symbol: s, close: ts.map((_, i) => 100 + (s.charCodeAt(1) % 10) + i * 0.5) }]
        }),
      ),
    )
  }) as typeof fetch
  return { f, calls }
}
const quiet = (o: HistoryRunOptions = {}): HistoryRunOptions => ({ paceMs: 5, gapMs: 0, sleep: async () => {}, ...o })

describe('ensureDailyBuckets: the crawl', () => {
  afterEach(() => vi.restoreAllMocks())
  // Never start a case while a run from an earlier one is still going: ensureDailyBuckets would hand it back.
  beforeEach(async () => {
    while (isDailyBuilding()) await new Promise((r) => setTimeout(r, 1))
  })

  it('needs a basket', () => {
    const db = mem()
    const { f, calls } = fakeYahoo()
    expect(ensureDailyBuckets(db, f, NOW, quiet())).toBeNull()
    expect(calls).toHaveLength(0)
    expect(dailyPending(db, '2026-10-02')).toEqual({ ready: false, building: false, done: 0, total: 0, reason: 'The server has no price basket yet, so no daily history either' })
  })

  it('crawls two years of daily bars, 20 symbols a call, over several runs; deals the parts into buckets; folds today’s basket in', async () => {
    const db = mem()
    seedBasket(db, 45) // 46 symbols: 3 calls
    const { f, calls } = fakeYahoo()
    const run1 = await ensureDailyBuckets(db, f, NOW, quiet({ runCalls: 2 }))
    expect(run1).toEqual({ calls: 2, fetched: 40, done: false, blocked: false, errors: [] })
    expect(dailyStatus(db).ready).toBe(false)
    expect(dailyPending(db, '2026-10-02')).toEqual({ ready: false, building: true, done: 40, total: 46, reason: 'The server is still building the daily history (86% done)' })
    expect((await bucketResponse(db, '3', 'gzip', undefined)).status).toBe(202)
    expect(meta(db, 'basket:daily:part:%')).toEqual(['basket:daily:part:0'])
    expect(readBudget(db, '2026-10-02').calls).toBe(2)

    const run2 = await ensureDailyBuckets(db, f, later(60_000), quiet())
    expect(run2).toMatchObject({ calls: 1, fetched: 6, done: true })
    expect(calls.map((c) => c.symbols.length)).toEqual([20, 20, 6])
    expect(calls.every((c) => c.symbols.length <= HISTORY_BATCH && /range=2y&interval=1d$/.test(c.url))).toBe(true)
    expect(calls[2]!.symbols).toEqual(['S40', 'S41', 'S42', 'S43', 'S44', 'BTC-USD'])

    expect(dailyStatus(db)).toEqual({ ready: true, asOf: '2026-10-02', of: DAILY_BUCKETS })
    const stored = meta(db, 'basket:daily:%')
    expect(stored).toHaveLength(DAILY_BUCKETS + 1) // every file, and the head; the build's scratch rows are gone
    expect(stored).toContain('basket:daily:head')
    expect(stored.filter((k) => k.startsWith('basket:daily:file:'))).toHaveLength(DAILY_BUCKETS)
    // Each symbol is in exactly its own bucket, two years back from the crawl's day.
    let placed = 0
    for (let b = 0; b < DAILY_BUCKETS; b++) {
      const fl = loadBucket(db, b)!
      expect(fl).toMatchObject({ v: 1, bucket: b, of: DAILY_BUCKETS, start: '2024-10-02' })
      for (const kind of ['stock', 'crypto'] as const)
        for (const sym of Object.keys(fl[kind])) {
          expect(dailyBucket(kind, sym)).toBe(b)
          placed++
        }
    }
    expect(placed).toBe(46)
    const s07 = decodeDaily('2024-10-02', loadBucket(db, dailyBucket('stock', 'S07'))!.stock.S07!)!
    expect(s07[0]).toEqual({ d: '2026-09-18', c: (100 + ('S07'.charCodeAt(1) % 10)) * 100 })
    // The 2nd — today — is the basket's quote, not Yahoo's live bar.
    expect(s07.at(-1)).toEqual({ d: '2026-10-02', c: 50_007 })
    expect(decodeDaily('2024-10-02', loadBucket(db, dailyBucket('crypto', 'BTC'))!.crypto.BTC!)!.at(-1)).toEqual({ d: '2026-10-02', c: 11_300_000 })
    // Current until a month has closed.
    expect(ensureDailyBuckets(db, f, later(DAY), quiet())).toBeNull()
    // A month has closed: a new crawl is due. Await it — the crawl is one module-level run, and a run left
    // going here would be what the next test's first call gets back (it did, on a slow CI runner).
    const next = ensureDailyBuckets(db, f, new Date('2026-11-01T09:00:00Z'), quiet())
    expect(next).not.toBeNull()
    await expect(next).resolves.toMatchObject({ done: true })
  })

  it('stops for the day when Yahoo refuses, and resumes at the same batch tomorrow', async () => {
    for (const refusal of [429, 503, 'throw', 'garbage'] as const) {
      const db = mem()
      seedBasket(db, 45)
      const { f, calls } = fakeYahoo((n) => (n === 1 ? refusal : null))
      const run = await ensureDailyBuckets(db, f, NOW, quiet())
      expect(run, String(refusal)).toMatchObject({ calls: 2, fetched: 20, done: false, blocked: true })
      expect(dailyPending(db, '2026-10-02').reason).toBe('The server’s daily-history crawl paused after an upstream error (43% done); it resumes tomorrow')
      expect(ensureDailyBuckets(db, f, later(60 * 60_000), quiet())).toBeNull()
      expect(await ensureDailyBuckets(db, f, later(DAY), quiet())).toMatchObject({ calls: 2, fetched: 26, done: true })
      expect(calls[2]!.symbols[0]).toBe('S20')
    }
  })
})

/* ---------- serving ---------- */

describe('GET /api/basket/daily/:bucket', () => {
  process.env.DB_PATH = ':memory:'
  process.env.NODE_ENV = 'test'
  let db: DbLike
  let mod: typeof import('./app')
  const network = vi.fn(async () => {
    throw new Error('no network in tests')
  })
  beforeAll(async () => {
    vi.stubGlobal('fetch', network)
    mod = await import('./app')
    db = (await import('./db')).db as unknown as DbLike
  })
  const as = (email: string, extra: Record<string, string> = {}) => ({ headers: { 'x-goog-authenticated-user-email': `accounts.google.com:${email}`, ...extra } })

  it('answers 202 with the reason while there are no files, and 404 for a bucket the server doesn’t deal', async () => {
    for (const zkOnly of [false, true]) {
      const app = mod.createApp({ zkOnly })
      const r = await app.request('/api/basket/daily/3', as('max@example.com'))
      expect(r.status).toBe(202)
      expect(r.headers.get('cache-control')).toBe('no-store')
      expect(await r.json()).toEqual({ ready: false, building: false, done: 0, total: 0, reason: 'The server has no price basket yet, so no daily history either' })
      // A number the server doesn't deal is a 404; a path that isn't a number never reaches the handler on a vault-only server (403 from the allowlist).
      for (const bad of ['64', '999']) expect((await app.request(`/api/basket/daily/${bad}`, as('max@example.com'))).status, bad).toBe(404)
      for (const bad of ['-1', 'abc', '3.5', '03x']) expect((await app.request(`/api/basket/daily/${bad}`, as('max@example.com'))).status, bad).toBe(zkOnly ? 403 : 404)
    }
    expect(mod.ZK_ROUTES.test('/api/basket/daily/0')).toBe(true)
    expect(mod.ZK_ROUTES.test('/api/basket/daily/63')).toBe(true)
    expect(mod.ZK_ROUTES.test('/api/basket/daily')).toBe(false)
    expect(mod.ZK_ROUTES.test('/api/basket/daily/3/x')).toBe(false)
    expect(network).not.toHaveBeenCalled()
  })

  it('serves every caller byte-identical files: gzip when asked, 304 when unchanged, one ETag per bucket', async () => {
    const files = Array.from({ length: DAILY_BUCKETS }, (_, b) => file(b))
    files[3]!.stock.SPY = encodeDaily(START, [{ d: '2026-09-30', c: 60_000 }, { d: '2026-10-01', c: 60_100 }])
    files[3]!.asOf = '2026-10-01'
    storeBuckets(db, files, new Date().toISOString()) // built this month: no crawl is due, so the route reaches no network
    const zk = mod.createApp({ zkOnly: true })
    const a = await zk.request('/api/basket/daily/3', as('a@example.com', { 'accept-encoding': 'gzip' }))
    const b = await zk.request('/api/basket/daily/3', as('b@example.com', { 'accept-encoding': 'gzip, br' }))
    expect(a.status).toBe(200)
    expect(a.headers.get('content-encoding')).toBe('gzip')
    expect(a.headers.get('cache-control')).toBe('no-cache')
    expect(a.headers.get('vary')).toBe('accept-encoding')
    const [ga, gb] = [Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer())]
    expect(ga.equals(gb)).toBe(true)
    expect(JSON.parse(gunzipSync(ga).toString('utf8'))).toEqual(files[3])
    const etag = a.headers.get('etag')!
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/)
    expect(b.headers.get('etag')).toBe(etag)
    const plain = await zk.request('/api/basket/daily/3', as('c@example.com'))
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.json()).toEqual(files[3])
    const unchanged = await zk.request('/api/basket/daily/3', as('a@example.com', { 'if-none-match': `W/${etag}, "other"` }))
    expect(unchanged.status).toBe(304)
    expect(unchanged.headers.get('etag')).toBe(etag)
    // Another bucket has its own ETag and content; a household server answers the same bytes.
    const other = await zk.request('/api/basket/daily/4', as('a@example.com'))
    expect(other.headers.get('etag')).not.toBe(etag)
    expect(await other.json()).toEqual(files[4])
    const household = await mod.createApp({ zkOnly: false }).request('/api/basket/daily/3', as('max@example.com'))
    expect(household.headers.get('etag')).toBe(etag)
    expect(await household.json()).toEqual(files[3])
    expect(network).not.toHaveBeenCalled()
  })

  it('keeps the bodies of the most recently asked-for buckets only', async () => {
    const zk = mod.createApp({ zkOnly: true })
    for (let b = 0; b < DAILY_BUCKETS; b++) expect((await zk.request(`/api/basket/daily/${b}`, as('a@example.com'))).status).toBe(200)
    expect(cachedBodies()).toBe(BODY_CACHE_MAX)
    // Bucket 3 again: served from the store once more (its body was evicted), then cached again at the back.
    expect((await zk.request('/api/basket/daily/3', as('a@example.com'))).status).toBe(200)
    expect(cachedBodies()).toBe(BODY_CACHE_MAX)
  })
})
