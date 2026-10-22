import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { addBasketAsk, basketAsks, basketExtras, buildBasket, MAX_BASKET_EXTRAS, parseSpark } from './basket'
import { openDb } from './migrations'

const mem = () => openDb(':memory:') as unknown as DbLike
const appMeta = (db: DbLike) => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all() as { key: string; value: string }[]

describe('basket extras: the asks, kept whole', () => {
  it('keeps each ask’s symbols together — no identity, no time — and evicts the oldest asks whole when the cap forces it', () => {
    const db = mem()
    db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES ('SPY', 'stock', 1, '2026-10-02')").run()
    expect(basketAsks(db)).toEqual([])
    expect(addBasketAsk(db, ['VFIAX', 'vfiax', 'SPY', 'brk.b', 'SWPPX', '__proto__', 'bad symbol', 'TOOLONGTICKER'])).toEqual({ added: 3, total: 4, evicted: 0 })
    expect(basketAsks(db)).toEqual([['VFIAX', 'SPY', 'BRK-B', 'SWPPX']]) // the ask as named (SPY counts as nothing new, but stays with its ask)
    expect(basketExtras(db)).toEqual(['VFIAX', 'SPY', 'BRK-B', 'SWPPX'])
    expect(addBasketAsk(db, ['VFIAX', 'FXAIX'])).toEqual({ added: 1, total: 5, evicted: 0 })
    expect(basketAsks(db)).toEqual([['VFIAX', 'SPY', 'BRK-B', 'SWPPX'], ['VFIAX', 'FXAIX']])
    const rows = appMeta(db)
    expect(rows.map((r) => r.key)).toEqual(['basket:extra:asks'])
    expect(rows[0]!.value).not.toMatch(/@|\d{4}-\d{2}-\d{2}/) // nothing that looks like an email or a time
    // The cap: asks of 32, 125 of them fill it; the next evicts the two oldest asks, whole, and the first ask's
    // symbols go with it even though one of them (VFIAX) was also in the second — that one stays, with its ask.
    for (let a = 0; a < 123; a++) addBasketAsk(db, Array.from({ length: 32 }, (_, i) => `Z${(a * 32 + i).toString(36).toUpperCase()}`))
    expect(basketExtras(db)).toHaveLength(5 + 123 * 32) // 3941
    const r = addBasketAsk(db, Array.from({ length: 64 }, (_, i) => `Y${i.toString(36).toUpperCase()}`))
    expect(r.evicted).toBe(2)
    expect(r.total).toBeLessThanOrEqual(MAX_BASKET_EXTRAS)
    expect(basketAsks(db)[0]).toEqual(Array.from({ length: 32 }, (_, i) => `Z${i.toString(36).toUpperCase()}`)) // the first Z ask is now the oldest
    expect(basketExtras(db)).not.toContain('SWPPX')
    expect(basketExtras(db)).not.toContain('FXAIX')
  })

  it('the build quotes the extras with the universe, names them from the quote source, and keeps one Yahoo can’t quote', async () => {
    const db = mem()
    addBasketAsk(db, ['VFIAX', 'GONEX'])
    const asked: string[][] = []
    const f = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('nasdaqlisted')) return new Response('Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nAAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N\n')
      if (url.includes('otherlisted')) return new Response('ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n')
      if (url.includes('coingecko')) return Response.json([])
      if (url.includes('/spark')) {
        const symbols = decodeURIComponent(new URL(url).searchParams.get('symbols') ?? '').split(',')
        asked.push(symbols)
        return Response.json({
          spark: {
            result: symbols
              .filter((s) => s !== 'GONEX')
              .map((s) => ({ symbol: s, response: [{ meta: { regularMarketPrice: s === 'VFIAX' ? 512.34 : 230.1, regularMarketTime: 1_759_440_000, chartPreviousClose: 500, shortName: s === 'VFIAX' ? 'Vanguard 500 Index Admiral' : undefined, longName: s === 'VFIAX' ? 'Vanguard 500 Index Fund Admiral Shares' : undefined } }] })),
          },
        })
      }
      throw new Error(`unexpected ${url}`)
    }) as typeof fetch
    for (let i = 0; i < 4; i++) {
      const r = await buildBasket(db, f)
      expect(r.stocks).toBe(2)
    }
    expect(asked[0]).toEqual(['AAPL', 'VFIAX', 'GONEX']) // the universe, then the extras
    const rows = db.prepare("SELECT symbol, name, etf FROM basket_quotes WHERE kind = 'stock' ORDER BY symbol").all()
    expect(rows).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', etf: 0 },
      { symbol: 'VFIAX', name: 'Vanguard 500 Index Fund Admiral Shares', etf: 0 }, // the fund: named by Yahoo, since no directory lists it
    ])
    // GONEX is still asked for after four builds without a quote: the ask stays whole (which symbols quoted is the basket's to show, not a second record).
    expect(basketAsks(db)).toEqual([['VFIAX', 'GONEX']])
    // A spark reply with no name leaves the quote nameless (the directory names listed symbols).
    expect(parseSpark({ spark: { result: [{ symbol: 'X', response: [{ meta: { regularMarketPrice: 1, longName: '  ' } }] }] } })[0]).not.toHaveProperty('name')
  })
})

describe('POST /api/basket/suggest', () => {
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
  const post = (app: ReturnType<typeof mod.createApp>, email: string, body: unknown) =>
    app.request('/api/basket/suggest', {
      method: 'POST',
      headers: { 'x-goog-authenticated-user-email': `accounts.google.com:${email}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('takes k distinct tickers, adds them all alike, records no identity, refuses a lone symbol, and brakes at one a minute', async () => {
    expect(mod.ZK_ROUTES.test('/api/basket/suggest')).toBe(true)
    const app = mod.createApp({ zkOnly: true })
    expect((await post(app, 'a@example.com', { symbols: ['VFIAX'] })).status).toBe(400) // one symbol names it outright
    expect((await post(app, 'a@example.com', { symbols: ['VFIAX', 'VFIAX'] })).status).toBe(400) // not distinct
    expect((await post(app, 'a@example.com', { symbols: ['VFIAX', 'not a ticker'] })).status).toBe(400)
    expect((await post(app, 'a@example.com', { symbols: Array.from({ length: 65 }, (_, i) => `F${i}`) })).status).toBe(400)
    expect((await post(app, 'a@example.com', {})).status).toBe(400)
    const ok = await post(app, 'a@example.com', { symbols: ['VFIAX', 'SWPPX', 'FXAIX'] })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, named: 3, added: 3 })
    expect(basketAsks(db)).toEqual([['VFIAX', 'SWPPX', 'FXAIX']])
    const stored = appMeta(db)
      .filter((r) => r.key.startsWith('basket:'))
      .map((r) => r.value)
      .join(' ')
    expect(stored).not.toContain('a@example.com')
    // The brake: a second suggestion within a minute is refused, whoever asks.
    const soon = await post(app, 'b@example.com', { symbols: ['VBTLX', 'VTSAX'] })
    expect(soon.status).toBe(429)
    expect(soon.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(basketExtras(db)).toHaveLength(3)
    expect(basketAsks(db)).toHaveLength(1)
    // A household server takes it too (the same list); the body cap applies before the handler.
    expect((await post(mod.createApp({ zkOnly: false }), 'max@example.com', { symbols: ['A', 'B'] })).status).toBe(429)
    expect(network).not.toHaveBeenCalled()
  })
})
