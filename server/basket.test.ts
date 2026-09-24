import { describe, expect, it } from 'vitest'
import type { DbLike } from '../engine/db'
import { applyBasket, upsertPrices } from '../engine/services'
import { dumpDb } from '../engine/snapshot'
import { serverHasData } from './api8'
import {
  basketStatus,
  buildBasket,
  cleanSecurityName,
  ensureBasket,
  fetchStockBasket,
  getBasket,
  parseCoinGeckoMarkets,
  parseSpark,
  parseSymbolDirectory,
  parseV7Quotes,
  storeBasket,
  toYahooSymbol,
} from './basket'
import { openDb } from './migrations'
import { BACKFILL_RETRY_DAYS, backfillMonthlyHistory, parseYahooHistory, type QuoteResult } from './prices'

const mem = () => openDb(':memory:') as unknown as DbLike

/* ---------- fixtures shaped like the real responses ---------- */

const NASDAQ_LISTED = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N
QQQ|Invesco QQQ Trust, Series 1|G|N|N|100|Y|N
ZTEST|NASDAQ TEST STOCK|G|Y|N|100|N|N
AACIU|Armada Acquisition Corp. III - Units|G|N|N|100|N|N
AACIW|Armada Acquisition Corp. III - Warrant|G|N|N|100|N|N
File Creation Time: 0908202521:30|||||||`

const OTHER_LISTED = `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
BRK.B|Berkshire Hathaway Inc. Class B|N|BRK B|N|100|N|BRK=B
BAC$B|Bank of America Corporation Depositary Shares, each representing a 1/1,000th interest in a share of 6.000% Non-Cumulative Preferred Stock, Series GG|N|BAC pB|N|100|N|BAC-B
SPY|SPDR S&P 500 ETF Trust|P|SPY|Y|100|N|SPY
AAPL|Apple Inc. (dup listing on another venue)|Z|AAPL|N|100|N|AAPL
File Creation Time: 0908202521:30|||||||`

const spark = (rows: [string, number, number][]) => ({
  spark: {
    result: rows.map(([symbol, px, t]) => ({ symbol, response: [{ meta: { regularMarketPrice: px, regularMarketTime: t } }] })),
  },
})
const v7 = (rows: [string, number, number][]) => ({
  quoteResponse: { result: rows.map(([symbol, px, t]) => ({ symbol, regularMarketPrice: px, regularMarketTime: t })), error: null },
})
const T = 1757458800 // 2025-09-09 23:00 UTC

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const text = (body: string, status = 200) => new Response(body, { status })

/** A fake upstream: routes by URL, records what it was asked. */
function fakeNet(overrides: Partial<Record<'nasdaq' | 'other' | 'spark' | 'crumbCookie' | 'crumb' | 'v7' | 'cg', (url: string) => Response>> = {}) {
  const calls: string[] = []
  const f = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('nasdaqlisted')) return (overrides.nasdaq ?? (() => text(NASDAQ_LISTED)))(url)
    if (url.includes('otherlisted')) return (overrides.other ?? (() => text(OTHER_LISTED)))(url)
    if (url.includes('/v8/finance/spark')) {
      if (overrides.spark) return overrides.spark(url)
      const syms = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '').split(',')
      return json(spark(syms.map((s, i) => [s, 100 + i, T])))
    }
    if (url.startsWith('https://fc.yahoo.com')) {
      if (overrides.crumbCookie) return overrides.crumbCookie(url)
      const r = new Response('', { status: 404 })
      r.headers.append('set-cookie', 'A3=d=abc; Path=/; Domain=.yahoo.com')
      return r
    }
    if (url.includes('getcrumb')) return (overrides.crumb ?? (() => text('Xy/z.crumb')))(url)
    if (url.includes('/v7/finance/quote')) {
      if (overrides.v7) return overrides.v7(url)
      const syms = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '').split(',')
      return json(v7(syms.map((s, i) => [s, 200 + i, T])))
    }
    if (url.includes('coingecko')) {
      if (overrides.cg) return overrides.cg(url)
      const page = new URL(url).searchParams.get('page')
      return json(
        page === '1'
          ? [
              { symbol: 'btc', name: 'Bitcoin', current_price: 111234.56, last_updated: '2025-09-09T22:58:01.000Z' },
              { symbol: 'eth', name: 'Ethereum', current_price: 4321.1, last_updated: '2025-09-09T22:58:01.000Z' },
              { symbol: 'btc', name: 'Batcoin', current_price: 1.0, last_updated: '2025-09-09T22:58:01.000Z' }, // a lookalike token
            ]
          : [{ symbol: 'sol', current_price: 210.05, last_updated: '2025-09-09T22:58:01.000Z' }],
      )
    }
    return text('not found', 404)
  }) as unknown as typeof fetch
  return { f, calls }
}

/* ---------- parsers ---------- */

describe('symbol directory', () => {
  it('reads both file layouts, drops test issues, preferreds, units and warrants, and spells like Yahoo', () => {
    const a = parseSymbolDirectory(NASDAQ_LISTED)
    expect(a.map((l) => l.symbol)).toEqual(['AAPL', 'QQQ'])
    expect(a[1]!.etf).toBe(true)
    const b = parseSymbolDirectory(OTHER_LISTED)
    expect(b.map((l) => l.symbol)).toEqual(['BRK-B', 'SPY', 'AAPL'])
    expect(toYahooSymbol(' brk.b ')).toBe('BRK-B')
    expect(parseSymbolDirectory('garbage')).toEqual([])
  })
})

describe('quote parsers', () => {
  it('spark and v7 both yield integer cents and the quote day', () => {
    const s = parseSpark(spark([['AAPL', 234.567, T]]))
    expect(s).toEqual([{ symbol: 'AAPL', kind: 'stock', cents: 23457, pricedOn: '2025-09-09' }])
    expect(parseV7Quotes(v7([['SPY', 650.001, T]]))).toEqual([{ symbol: 'SPY', kind: 'stock', cents: 65000, pricedOn: '2025-09-09' }])
    expect(parseSpark({ spark: { result: [{ symbol: 'DEAD', response: [{ meta: {} }] }] } })).toEqual([])
    expect(parseSpark(null)).toEqual([])
    expect(parseV7Quotes({ quoteResponse: { result: [{ symbol: 'NEG', regularMarketPrice: -1 }] } })).toEqual([])
  })

  it('coingecko: uppercase symbols, first (largest) wins on clashes, day from last_updated', () => {
    const seen = new Set<string>()
    const q = parseCoinGeckoMarkets(
      [
        { symbol: 'btc', current_price: 111234.56, last_updated: '2025-09-09T22:58:01.000Z' },
        { symbol: 'btc', current_price: 1.0, last_updated: '2025-09-09T22:58:01.000Z' },
      ],
      seen,
    )
    expect(q).toEqual([{ symbol: 'BTC', kind: 'crypto', cents: 11123456, pricedOn: '2025-09-09' }])
    expect(parseCoinGeckoMarkets([{ symbol: 'x', current_price: 2 }], seen)[0]!.pricedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(parseCoinGeckoMarkets({ not: 'an array' })).toEqual([])
  })
})

/* ---------- fetching ---------- */

describe('fetchStockBasket', () => {
  it('batches through spark with bounded concurrency', async () => {
    const { f, calls } = fakeNet()
    const symbols = Array.from({ length: 450 }, (_, i) => `S${i}`)
    const r = await fetchStockBasket(symbols, f, { batch: 200, concurrency: 2 })
    expect(r.quotes).toHaveLength(450)
    expect(r.errors).toEqual([])
    expect(calls.filter((u) => u.includes('spark'))).toHaveLength(3)
    expect(calls.some((u) => u.includes('v7'))).toBe(false)
  })

  it('falls back to v7 with a crumb when spark is gone, minting the crumb once', async () => {
    const { f, calls } = fakeNet({ spark: () => text('nope', 404) })
    const r = await fetchStockBasket(['AAPL', 'SPY', 'BRK-B'], f, { batch: 2, concurrency: 1 })
    expect(r.quotes.map((q) => q.symbol)).toEqual(['AAPL', 'SPY', 'BRK-B'])
    expect(calls.filter((u) => u.includes('getcrumb'))).toHaveLength(1)
    expect(calls.filter((u) => u.includes('v7'))).toHaveLength(2)
    expect(calls.find((u) => u.includes('v7'))).toContain('crumb=Xy%2Fz.crumb')
  })

  it('reports batches that fail everywhere, and keeps the rest', async () => {
    const { f } = fakeNet({ spark: () => text('nope', 500), crumbCookie: () => new Response('', { status: 404 }) })
    const r = await fetchStockBasket(['AAPL', 'SPY'], f, { batch: 1 })
    expect(r.quotes).toEqual([])
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]).toMatch(/returned nothing/)
  })
})

/* ---------- build, store, ensure ---------- */

describe('buildBasket', () => {
  it('assembles the universe, quotes it, adds crypto, stores it, and dedupes cross-venue listings', async () => {
    const db = mem()
    const { f } = fakeNet()
    const r = await buildBasket(db, f)
    expect(r.universe).toBe(4) // AAPL QQQ BRK-B SPY — AAPL's second venue collapsed
    expect(r.stocks).toBe(4)
    expect(r.crypto).toBe(3)
    expect(r.errors).toEqual([])
    const b = getBasket(db)
    expect(b.count).toBe(7)
    expect(b.builtAt).toBeTruthy()
    expect(b.quotes.find((q) => q.symbol === 'BTC')).toEqual({
      symbol: 'BTC',
      kind: 'crypto',
      cents: 11123456,
      pricedOn: '2025-09-09',
      name: 'Bitcoin',
      etf: false,
    })
    expect(b.quotes.find((q) => q.symbol === 'BRK-B')?.kind).toBe('stock')
    // Names and the ETF flag ride along from the symbol directory (A8).
    const named = Object.fromEntries(b.quotes.map((q) => [q.symbol, [q.name, q.etf]]))
    expect(named).toEqual({
      AAPL: ['Apple Inc.', false],
      'BRK-B': ['Berkshire Hathaway Inc. Class B', false],
      QQQ: ['Invesco QQQ Trust, Series 1', true],
      SPY: ['SPDR S&P 500 ETF Trust', true],
      BTC: ['Bitcoin', false],
      ETH: ['Ethereum', false],
      SOL: [null, false], // CoinGecko sent no name
    })
  })

  it('security names lose the share-class boilerplate, nothing else', () => {
    expect(cleanSecurityName('Apple Inc. - Common Stock')).toBe('Apple Inc.')
    expect(cleanSecurityName('Alphabet Inc. - Class A Common Stock')).toBe('Alphabet Inc. Class A')
    expect(cleanSecurityName('Armada Acquisition Corp. III - Class A Ordinary Shares')).toBe('Armada Acquisition Corp. III Class A')
    expect(cleanSecurityName('Brookfield Corp Class A Common Shares')).toBe('Brookfield Corp Class A')
    expect(cleanSecurityName('Berkshire Hathaway Inc. New Common Stock')).toBe('Berkshire Hathaway Inc.')
    expect(cleanSecurityName('Alphabet Inc. - Class C Capital Stock')).toBe('Alphabet Inc. Class C')
    expect(cleanSecurityName('Brown Forman Inc Class B Common Stock')).toBe('Brown Forman Inc Class B')
    expect(cleanSecurityName('Taiwan Semiconductor Manufacturing Company Ltd. - American Depositary Shares')).toBe(
      'Taiwan Semiconductor Manufacturing Company Ltd.',
    )
    expect(cleanSecurityName('Alibaba Group Holding Limited American Depositary Shares each representing eight Ordinary share')).toBe(
      'Alibaba Group Holding Limited',
    )
    expect(cleanSecurityName('  Vanguard  Total Stock Market ETF ')).toBe('Vanguard Total Stock Market ETF')
    expect(cleanSecurityName('Common Stock')).toBe('Common Stock')
    expect(cleanSecurityName('Invesco QQQ Trust, Series 1')).toBe('Invesco QQQ Trust, Series 1')
  })

  it('a source that fails outright leaves its kind’s rows; a symbol a build misses keeps its quote for two weeks', () => {
    const db = mem()
    const q = (symbol: string, kind: 'stock' | 'crypto', cents: number, pricedOn: string, name?: string) => ({ symbol, kind, cents, pricedOn, name })
    storeBasket(
      db,
      [q('AAPL', 'stock', 100, '2025-09-01', 'Apple Inc.'), q('OLDCO', 'stock', 5, '2025-08-28'), q('BTC', 'crypto', 9, '2025-09-01')],
      [],
      '2025-09-01T21:00:00.000Z',
    )
    // Next build: stocks only (crypto failed), and AAPL's batch came back without a name.
    storeBasket(db, [q('AAPL', 'stock', 101, '2025-09-09'), q('SPY', 'stock', 650, '2025-09-09')], ['crypto: CoinGecko page 1 HTTP 429'], '2025-09-09T21:00:00.000Z')
    const rows = () => getBasket(db).quotes.map((r) => `${r.kind}:${r.symbol}:${r.cents}:${r.pricedOn}:${r.name}`)
    expect(rows()).toEqual([
      'crypto:BTC:9:2025-09-01:null', // crypto untouched
      'stock:AAPL:101:2025-09-09:Apple Inc.', // refreshed, keeps its name
      'stock:OLDCO:5:2025-08-28:null', // missed by this build, still under two weeks old
      'stock:SPY:650:2025-09-09:null',
    ])
    expect(basketStatus(db).builtAt).toBe('2025-09-09T21:00:00.000Z')
    // A build more than two weeks after OLDCO's last quote drops it.
    storeBasket(db, [q('AAPL', 'stock', 102, '2025-09-12')], [], '2025-09-12T21:00:00.000Z')
    expect(rows().filter((r) => r.includes('OLDCO'))).toEqual([])
    expect(rows()).toContain('stock:SPY:650:2025-09-09:null')
  })

  it('ensureBasket({ force }) rebuilds after today’s attempt, and joins a build already running', async () => {
    const db = mem()
    const { f, calls } = fakeNet()
    await ensureBasket(db, f, '2025-09-09')
    expect(ensureBasket(db, f, '2025-09-09')).toBeNull()
    const forced = ensureBasket(db, f, '2025-09-09', { force: true })
    expect(forced).not.toBeNull()
    expect(ensureBasket(db, f, '2025-09-09', { force: true })).toBe(forced) // same in-flight build
    await forced
    expect(calls.filter((u) => u.includes('nasdaqlisted'))).toHaveLength(2)
  })

  it('keeps yesterday’s basket when every source fails, and says why', async () => {
    const db = mem()
    storeBasket(db, [{ symbol: 'AAPL', kind: 'stock', cents: 1, pricedOn: '2025-09-08' }], [], '2025-09-08T21:00:00.000Z')
    const dead = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch
    const r = await buildBasket(db, dead)
    expect(r.stocks + r.crypto).toBe(0)
    expect(r.errors.length).toBeGreaterThanOrEqual(3)
    const s = basketStatus(db)
    expect(s.count).toBe(1)
    expect(s.builtAt).toBe('2025-09-08T21:00:00.000Z')
    expect(s.errors[0]).toMatch(/ECONNRESET/)
  })

  it('ensureBasket builds once per day, coalesces concurrent callers, and retries tomorrow', async () => {
    const db = mem()
    const { f, calls } = fakeNet()
    const a = ensureBasket(db, f, '2025-09-09')
    const b = ensureBasket(db, f, '2025-09-09')
    expect(a).not.toBeNull()
    expect(b).toBe(a) // same in-flight build
    await a
    const universeCalls = () => calls.filter((u) => u.includes('nasdaqlisted')).length
    expect(universeCalls()).toBe(1)
    expect(ensureBasket(db, f, '2025-09-09')).toBeNull() // done for today
    await ensureBasket(db, f, '2025-09-10')
    expect(universeCalls()).toBe(2)
  })

  it('the basket never rides the snapshot (shared infrastructure, not household data)', async () => {
    const db = mem()
    await buildBasket(db, fakeNet().f)
    expect(Object.keys(dumpDb(db).tables)).not.toContain('basket_quotes')
  })
})

/* ---------- engine side: picking symbols out ---------- */

describe('applyBasket', () => {
  it('prices this household’s assets from the shared list, matching Yahoo spelling', () => {
    const db = mem()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('BRK.B', 'stock'), ('spy', 'stock'), ('BTC', 'crypto'), ('OBSCURE', 'stock')").run()
    const basket = {
      builtAt: '2025-09-09T21:00:00.000Z',
      quotes: [
        { symbol: 'BRK-B', kind: 'stock' as const, cents: 46000, pricedOn: '2025-09-09' },
        { symbol: 'SPY', kind: 'stock' as const, cents: 65000, pricedOn: '2025-09-09' },
        { symbol: 'BTC', kind: 'crypto' as const, cents: 11123456, pricedOn: '2025-09-09' },
      ],
    }
    const r = applyBasket(db, basket)
    expect(r.updated).toBe(3)
    expect(r.errors).toEqual(['OBSCURE: not in today’s basket'])
    const rows = db.prepare('SELECT a.symbol, p.close_cents FROM prices p JOIN assets a ON a.id = p.asset_id ORDER BY a.symbol').all()
    expect(rows).toEqual([
      { symbol: 'BRK.B', close_cents: 46000 },
      { symbol: 'BTC', close_cents: 11123456 },
      { symbol: 'spy', close_cents: 65000 },
    ])
    expect(applyBasket(db, { builtAt: null, quotes: [] }).errors[0]).toMatch(/empty/)
    expect(applyBasket(mem(), basket).errors[0]).toMatch(/no assets/)
  })

  it('also accrues each matched quote into prices_daily, so a tab builds chart history day by day', () => {
    const db = mem()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('BTC', 'crypto')").run()
    const day = (pricedOn: string, vti: number) => ({
      builtAt: `${pricedOn}T21:00:00.000Z`,
      quotes: [
        { symbol: 'VTI', kind: 'stock' as const, cents: vti, pricedOn },
        { symbol: 'BTC', kind: 'crypto' as const, cents: 11_000_000, pricedOn },
      ],
    })
    const both = () => ({
      prices: db.prepare('SELECT asset_id, priced_on, close_cents FROM prices ORDER BY asset_id, priced_on').all(),
      daily: db.prepare('SELECT asset_id, priced_on, close_cents FROM prices_daily ORDER BY asset_id, priced_on').all(),
    })
    expect(applyBasket(db, day('2025-09-09', 30_000)).updated).toBe(2)
    const once = both()
    expect(once.daily).toEqual(once.prices)
    expect(once.daily).toEqual([
      { asset_id: 1, priced_on: '2025-09-09', close_cents: 30_000 },
      { asset_id: 2, priced_on: '2025-09-09', close_cents: 11_000_000 },
    ])
    // Idempotent within a day: the same basket again changes nothing.
    applyBasket(db, day('2025-09-09', 30_000))
    expect(both()).toEqual(once)
    // A later build the same day updates that day's close in both tables.
    applyBasket(db, day('2025-09-09', 30_100))
    expect(both().daily).toEqual([
      { asset_id: 1, priced_on: '2025-09-09', close_cents: 30_100 },
      { asset_id: 2, priced_on: '2025-09-09', close_cents: 11_000_000 },
    ])
    expect(both().prices).toEqual(both().daily)
    // The next day adds a row to each.
    applyBasket(db, day('2025-09-10', 30_200))
    expect(both().daily).toHaveLength(4)
    expect(both().prices).toHaveLength(4)
  })

  it('skips malformed basket rows instead of writing them (the basket crosses the network into the tab)', () => {
    const db = mem()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('AAA', 'stock'), ('BBB', 'stock'), ('CCC', 'stock')").run()
    const r = applyBasket(db, {
      builtAt: null,
      quotes: [
        { symbol: 'AAA', kind: 'stock', cents: 12.5, pricedOn: '2025-09-09' }, // float cents
        { symbol: 'BBB', kind: 'stock', cents: 100, pricedOn: 'yesterday' },
        { symbol: 'CCC', kind: 'stock', cents: 100, pricedOn: '2025-09-09' },
      ],
    })
    expect(r.updated).toBe(1)
    expect(r.errors).toEqual(['AAA: malformed quote in today’s basket', 'BBB: malformed quote in today’s basket'])
    expect(db.prepare('SELECT count(*) AS n FROM prices_daily').get()).toEqual({ n: 1 })
  })
})

/* ---------- the front door's question ---------- */

describe('serverHasData', () => {
  it('is false for an empty server and for one holding only ciphertext; true once any plaintext row exists', () => {
    const db = mem()
    expect(serverHasData(db)).toBe(false)
    db.prepare("INSERT INTO vault_blobs (owner_email, version, sha256, size, data) VALUES ('a@b', 1, 'x', 1, '{}')").run()
    expect(serverHasData(db)).toBe(false)
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    expect(serverHasData(db)).toBe(true)
  })
})

/* ---------- price ingestion hygiene (server/prices.ts) ---------- */

describe('parseYahooHistory monthly bars', () => {
  const chart = (tz: string | undefined, bars: [number, number | null][]) => ({
    chart: {
      result: [
        {
          meta: tz ? { exchangeTimezoneName: tz } : {},
          timestamp: bars.map(([t]) => t),
          indicators: { quote: [{ close: bars.map(([, c]) => c) }] },
        },
      ],
    },
  })

  it('stamps each bar at its month’s end (not its open), and the month in progress at today', () => {
    const body = chart('America/New_York', [
      [1704085200, 100.5], // 2024-01-01 05:00Z — midnight in New York, winter
      [1706763600, null], // February: no close → skipped
      [1719806400, 200], // 2024-07-01 04:00Z — midnight in New York, summer
      [1725163200, 210], // 2024-09-01: the month in progress…
      [1726689600, 211.11], // …and Yahoo's live bar for it, which wins
    ])
    expect(parseYahooHistory('VTI', body, { monthly: true, today: '2024-09-18' })).toEqual([
      { symbol: 'VTI', cents: 10050, pricedOn: '2024-01-31' },
      { symbol: 'VTI', cents: 20000, pricedOn: '2024-07-31' },
      { symbol: 'VTI', cents: 21111, pricedOn: '2024-09-18' },
    ])
    // Daily mode (charts.ts) is unchanged: the timestamp's UTC day.
    expect(parseYahooHistory('VTI', body).map((q) => q.pricedOn)).toEqual(['2024-01-01', '2024-07-01', '2024-09-01', '2024-09-18'])
  })

  it('reads the month in the exchange’s zone: a bar at local midnight east of UTC is the previous day in UTC', () => {
    const body = chart('Asia/Tokyo', [[1719759600, 50]]) // 2024-06-30 15:00Z = July 1, 00:00 in Tokyo
    expect(parseYahooHistory('7203.T', body, { monthly: true, today: '2024-09-18' })[0]!.pricedOn).toBe('2024-07-31')
    // No zone (or a bogus one): UTC.
    expect(parseYahooHistory('X', chart(undefined, [[1719759600, 50]]), { monthly: true, today: '2024-09-18' })[0]!.pricedOn).toBe('2024-06-30')
    expect(parseYahooHistory('X', chart('Not/AZone', [[1719759600, 50]]), { monthly: true, today: '2024-09-18' })[0]!.pricedOn).toBe('2024-06-30')
  })
})

describe('backfillMonthlyHistory (household refresh)', () => {
  const setup = () => {
    const db = mem()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('GONE', 'stock')").run()
    const calls: string[] = []
    const fetchHistory = async (symbol: string, _kind: 'stock' | 'crypto', _f?: typeof fetch, today?: string): Promise<QuoteResult> => {
      calls.push(`${symbol}@${today}`)
      if (symbol === 'GONE') return { quotes: [], errors: ['GONE: Yahoo history HTTP 404'] }
      return { quotes: [{ symbol, cents: 20_000, pricedOn: '2026-08-31' }], errors: [] }
    }
    const assets = [
      { symbol: 'VTI', kind: 'stock' as const },
      { symbol: 'GONE', kind: 'stock' as const },
    ]
    const meta = () => db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'backfill%' ORDER BY key").all() as { key: string; value: string }[]
    const run = (today: string) => backfillMonthlyHistory(db, assets, upsertPrices, { today, fetchHistory })
    return { db, calls, meta, run }
  }

  it('backfills once per asset under the v2 flag; a failure is stamped and retried weekly, not every refresh', async () => {
    const { db, calls, meta, run } = setup()
    // An asset backfilled before v2 (month-open stamps) refetches once.
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('backfilled:VTI', '2026-01-01 00:00:00')").run()

    const first = await run('2026-09-01')
    expect(first).toMatchObject({ backfilled: 1, errors: ['GONE: Yahoo history HTTP 404'], skipped: [] })
    expect(calls).toEqual(['VTI@2026-09-01', 'GONE@2026-09-01'])
    expect(meta().map((m) => m.key)).toEqual(['backfill_failed:GONE', 'backfilled:VTI', 'backfilled:v2:VTI'])
    expect(meta().find((m) => m.key === 'backfill_failed:GONE')!.value).toBe('2026-09-01')
    expect(db.prepare('SELECT priced_on, close_cents FROM prices').all()).toEqual([{ priced_on: '2026-08-31', close_cents: 20_000 }])

    // Refreshes inside the week fetch nothing at all.
    const quiet = await run('2026-09-07')
    expect(quiet).toEqual({ backfilled: 0, errors: [], skipped: ['GONE'] })
    expect(calls).toHaveLength(2)

    // A week on, the failed symbol is tried again (still failing → restamped).
    await run(`2026-09-0${1 + BACKFILL_RETRY_DAYS}`)
    expect(calls.slice(2)).toEqual(['GONE@2026-09-08'])
    expect(meta().find((m) => m.key === 'backfill_failed:GONE')!.value).toBe('2026-09-08')
  })

  it('a retry that succeeds clears the failure stamp', async () => {
    const { db, meta } = setup()
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('backfill_failed:VTI', '2026-08-01'), ('backfilled:v2:GONE', 'x')").run()
    const r = await backfillMonthlyHistory(db, [{ symbol: 'VTI', kind: 'stock' }], upsertPrices, {
      today: '2026-09-01',
      fetchHistory: async (symbol) => ({ quotes: [{ symbol, cents: 1, pricedOn: '2026-08-31' }], errors: [] }),
    })
    expect(r.backfilled).toBe(1)
    expect(meta().map((m) => m.key)).toEqual(['backfilled:v2:GONE', 'backfilled:v2:VTI'])
  })
})
