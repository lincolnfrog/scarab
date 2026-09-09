import { describe, expect, it } from 'vitest'
import type { DbLike } from '../engine/db'
import { applyBasket } from '../engine/services'
import { dumpDb } from '../engine/snapshot'
import { serverHasData } from './api8'
import {
  basketStatus,
  buildBasket,
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
              { symbol: 'btc', current_price: 111234.56, last_updated: '2025-09-09T22:58:01.000Z' },
              { symbol: 'eth', current_price: 4321.1, last_updated: '2025-09-09T22:58:01.000Z' },
              { symbol: 'btc', current_price: 1.0, last_updated: '2025-09-09T22:58:01.000Z' }, // a lookalike token
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
    expect(b.quotes.find((q) => q.symbol === 'BTC')).toEqual({ symbol: 'BTC', kind: 'crypto', cents: 11123456, pricedOn: '2025-09-09' })
    expect(b.quotes.find((q) => q.symbol === 'BRK-B')?.kind).toBe('stock')
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
