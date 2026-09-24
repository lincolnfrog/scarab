import { describe, expect, it } from 'vitest'
import { addMonthsToMonth } from '../shared/dates'
import { MAX_SERIES_IDS, type HistoryPack } from '../shared/series-api'
import { getChartViews, getSeries, getSeriesCatalog, putChartViews, type MarketHistory } from './analytics'
import type { DbLike } from './db'
import { ApiError } from './errors'
import { getPortfolio } from './invest'
import { netWorthSeries } from './networth'
import {
  applyBasket,
  applyMonthlyHistory,
  encodeMonthly,
  getChartData,
  needsMonthlyHistory,
  packMarket,
  type MonthClose,
} from './prices'
import { getHoldingsReturns } from './returns'
import { type Dump, dumpDb, loadDump, TABLES } from './snapshot'
import { onBothEngines } from './test/parity'
import { seedHousehold } from './test/household'

const TODAY = '2026-09-22'

/** The seeded household, plus a funded goal, a transfer, a same-symbol lot in a second account and a sell by lot. */
const seedWide = (db: DbLike) => {
  seedHousehold(db)
  db.prepare("INSERT INTO goal_settings (key, value) VALUES ('goal', ?)").run(JSON.stringify({ fundAccountIds: [1], fundExtraCents: 5_000 }))
  const transfer = (db.prepare("SELECT id FROM categories WHERE kind = 'transfer' LIMIT 1").get() as { id: number }).id
  db.prepare(
    "INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash, category_id) VALUES (1, '2026-06-03', -99999, 'TO SAVINGS', 'hw', ?)",
  ).run(transfer)
  const trade = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  trade.run(2, 1, '2025-08-01', 'buy', 3_000_000, 51_000, null) // VTI in the Roth too, over a year ago
  trade.run(2, 2, '2026-08-12', 'buy', 1_000_000, 49_000, null) // id 6
  trade.run(2, 2, '2026-09-01', 'sell', 1_000_000, 50_500, 6) // sells that lot
}

/** Every catalog id, MAX_SERIES_IDS per request. */
const everySeries = (db: DbLike, from?: string) => {
  const catalog = getSeriesCatalog(db, TODAY)
  const ids = [...catalog.entries.map((e) => e.id), 'set:1+2:value', 'set:1+2+3:cost', 'inv:3:cost', 'inv:99:value']
  const responses = []
  for (let i = 0; i < ids.length; i += MAX_SERIES_IDS)
    responses.push(getSeries(db, TODAY, { ids: ids.slice(i, i + MAX_SERIES_IDS), ...(from ? { from } : {}) }))
  return { catalog, ids, responses }
}

describe('analytics parity: better-sqlite3 vs sql.js', () => {
  it('serves an identical series catalog and identical series on both engines', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => everySeries(db, '2026-03'))
    expect(browser).toEqual(server)
    // Not vacuous: every catalog id came back, trimmed to the window.
    const all = server.responses.flatMap((r) => r.series)
    expect(all.map((s) => s.id)).toEqual([...server.catalog.entries.map((e) => e.id), 'set:1+2:value', 'set:1+2+3:cost'])
    expect(all.filter((s) => s.id.startsWith('nw:')).every((s) => s.points.length === 7)).toBe(true) // 2026-03 … 2026-09
    expect(all.every((s) => s.points.every((p) => p.t >= '2026-03'))).toBe(true)
    // The seed's sparse prices withhold every time-weighted return (null points, with the reason).
    const twrIds = server.catalog.entries.map((e) => e.id).filter((id) => id.endsWith(':twr'))
    expect(twrIds.length).toBe(7)
    const warnings = server.responses.flatMap((r) => r.warnings)
    expect(warnings.filter((w) => !twrIds.some((id) => w.startsWith(`${id}: only `)))).toEqual([
      'inv:3:cost: 401(k) tracks a balance, not trades, so it has no cost basis',
      'unknown series: inv:99:value',
    ])
    expect(warnings).toHaveLength(twrIds.length + 2)
  })

  it('computes every v1 family identically on both engines, from full history', async () => {
    const { server, browser } = await onBothEngines(seedWide, (db) => ({
      ...everySeries(db),
      portfolio: getPortfolio(db, TODAY).totals,
    }))
    expect(browser).toEqual(server)
    const byId = new Map(server.responses.flatMap((r) => r.series).map((s) => [s.id, s]))
    // Not vacuous: holdings start with the Roth's 2025 VTI lot, every family has points, the invariant holds.
    expect(byId.get('inv:all:value')!.points[0]!.t).toBe('2025-08')
    expect(byId.get('inv:all:value')!.points.at(-1)!.v).toBe(server.portfolio.value)
    expect(byId.get('inv:all:cost')!.points.at(-1)!.v).toBe(server.portfolio.cost)
    for (const id of ['inv:2:value', 'pos:1:value', 'set:1+2:value', 'px:1', 'cash:1', 'prop:1:equity', 'liab:1', 'cf:net', 'goal:fund'])
      expect(byId.get(id)!.points.length, id).toBeGreaterThan(0)
    expect(byId.get('cf:spend')!.points.find((p) => p.t === '2026-06')!.v).toBe(0) // the transfer is not spending
  })

  it('computes holdings returns and stores saved views identically on both engines', async () => {
    const { server, browser } = await onBothEngines(seedWide, (db) => {
      const views = putChartViews(
        db,
        [{ id: 'v1', name: 'Stocks', ids: ['set:1+2:value', 'nw:total'], mode: 'rebased', from: '2026-01' }],
        { by: 'max@example.com', now: '2026-09-22T10:00:00.000Z' },
      )
      return { returns: getHoldingsReturns(db, TODAY), views, read: getChartViews(db) }
    })
    expect(browser).toEqual(server)
    // Not vacuous.
    expect(server.returns.rows.map((r) => r.symbol)).toEqual(['BTC', 'VTI', 'QQQ']) // by value, as the portfolio lists them
    const vti = server.returns.rows.find((r) => r.symbol === 'VTI')!
    expect(vti).toMatchObject({ held_days: 417, annualized: true, priced: true }) // the Roth's 2025 lot
    expect(vti.irr_micro).not.toBeNull()
    expect(server.returns.totals.irr_micro).not.toBeNull()
    expect(server.read).toEqual(server.views)
    expect(server.views[0]).toMatchObject({ by: 'max@example.com', ids: ['set:1+2:value', 'nw:total'] })
  })
})

/* ---------- performance and benchmarks (A6) ---------- */

/**
 * A priced book: VTI across two accounts with a deposit, a sale, a starting
 * position (booked at its historical cost) and a sale with explicit basis;
 * QQQ joining late; month-end closes in both tables.
 */
const seedPerformance = (db: DbLike) => {
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots'), ('Roth', 'retirement', 'lots')").run()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('QQQ', 'stock')").run()
  const trade = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, acquired_on, basis_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  trade.run(1, 1, '2026-01-05', 'buy', 10_000_000, 100_000, null, null, null)
  trade.run(1, 1, '2026-02-12', 'buy', 5_500_000, 60_830, null, null, null) // fractional shares, with a fee
  trade.run(2, 1, '2026-03-02', 'buy', 4_000_000, 100_000, '2016-06-01', null, 'Opening position') // booked at 2016 cost
  trade.run(1, 1, '2026-05-14', 'sell', 3_250_000, 37_000, null, null, null)
  trade.run(1, 1, '2026-06-09', 'sell', 1_000_000, 11_400, '2018-01-02', 5_000, null) // explicit basis: no shares move
  trade.run(2, 2, '2026-04-20', 'buy', 2_000_000, 90_000, null, null, null)
  const price = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)')
  const daily = db.prepare('INSERT INTO prices_daily (asset_id, priced_on, close_cents) VALUES (?, ?, ?)')
  const vti: [string, number][] = [
    ['2026-01-30', 10_700], ['2026-02-27', 11_050], ['2026-03-31', 10_850], ['2026-04-30', 11_300], ['2026-05-29', 11_210],
    ['2026-06-30', 11_640], ['2026-07-31', 11_900], ['2026-08-31', 11_725], ['2026-09-21', 12_040],
  ]
  for (const [on, c] of vti) price.run(1, on, c)
  daily.run(1, '2026-02-27', 11_060) // a daily close wins its day for benchmarks (valuation reads the quote table)
  for (const [on, c] of vti.slice(3)) price.run(2, on, Math.round(c * 4.1))
}

describe('performance parity: better-sqlite3 vs sql.js', () => {
  it('computes time-weighted returns and benchmarks identically on both engines', async () => {
    const market: MarketHistory = { closes: (s) => (s === 'SPY' ? [{ on: '2025-12-31', cents: 60_000 }, { on: '2026-06-30', cents: 63_210 }] : null) }
    const ids = ['inv:all:twr', 'inv:1:twr', 'inv:2:twr', 'pos:1:twr', 'pos:2:twr', 'set:1+2:twr']
    const { server, browser } = await onBothEngines(seedPerformance, (db) => ({
      catalog: getSeriesCatalog(db, TODAY, { market }).entries.filter((e) => e.id.endsWith(':twr') || e.id.startsWith('bench:')),
      twr: getSeries(db, TODAY, { ids }),
      window: getSeries(db, TODAY, { ids: ['inv:all:twr'], from: '2026-04', to: '2026-06' }),
      bench: getSeries(db, TODAY, { ids: ['bench:SPY', 'bench:VTI', 'bench:QQQ'], market }),
    }))
    expect(browser).toEqual(server)
    // Not vacuous: every index is drawn, integer, and moved; the benchmarks are there too.
    expect(server.twr.warnings).toEqual([])
    expect(server.twr.series.map((s) => s.id)).toEqual(ids)
    for (const s of server.twr.series) {
      expect(s.points.length, s.id).toBeGreaterThan(0)
      for (const p of s.points) expect(Number.isSafeInteger(p.v), `${s.id} ${p.t}`).toBe(true)
      expect(new Set(s.points.map((p) => p.v)).size, s.id).toBeGreaterThan(2)
    }
    expect(server.catalog.filter((e) => e.id.endsWith(':twr')).every((e) => e.available)).toBe(true)
    expect(server.window.series[0]!.points.map((p) => p.t)).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(server.bench.series.map((s) => s.points.length)).toEqual([10, 9, 6])
    expect(server.bench.series[0]!.points.at(-1)!.v).toBe(1_053_500)
  })
})

/* ---------- price history: the basket accrues daily closes (A2) ---------- */

const basketOn = (pricedOn: string, vti: number, qqq: number) => ({
  builtAt: `${pricedOn}T21:00:00.000Z`,
  quotes: [
    { symbol: 'VTI', kind: 'stock' as const, cents: vti, pricedOn },
    { symbol: 'QQQ', kind: 'stock' as const, cents: qqq, pricedOn },
    { symbol: 'ETH', kind: 'crypto' as const, cents: 400_000, pricedOn }, // not held
  ],
})
const rows = (db: DbLike, table: 'prices' | 'prices_daily') =>
  db.prepare(`SELECT asset_id, priced_on, close_cents FROM ${table} ORDER BY asset_id, priced_on`).all()

describe('price history parity: better-sqlite3 vs sql.js', () => {
  it('re-applying an identical basket changes no rows on either engine (the tab data revision stays put)', async () => {
    const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      applyBasket(db, basketOn('2026-09-21', 24_900, 50_100))
      const before = changes(db)
      const again = applyBasket(db, basketOn('2026-09-21', 24_900, 50_100)) // the same quotes, refreshed again
      const same = changes(db) - before
      applyBasket(db, basketOn('2026-09-21', 24_950, 50_100)) // one close moved
      return { same, moved: changes(db) - before - same, updated: again.updated }
    })
    expect(browser).toEqual(server)
    expect(server.same).toBe(0)
    expect(server.moved).toBe(2) // VTI in prices and in prices_daily
    expect(server.updated).toBe(2) // still reports what it matched
  })

  it('applyBasket writes prices and prices_daily identically, and the chart reads them identically', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      const first = applyBasket(db, basketOn('2026-09-21', 24_900, 50_100))
      applyBasket(db, basketOn('2026-09-21', 24_950, 50_150)) // same day again: an update, not a new row
      applyBasket(db, basketOn('2026-09-22', 25_000, 50_200))
      return {
        first,
        prices: rows(db, 'prices'),
        daily: rows(db, 'prices_daily'),
        charts: ['VTI', 'qqq', 'BTC'].map((s) => getChartData(db, s)),
      }
    })
    expect(browser).toEqual(server)
    // Not vacuous.
    expect(server.first.updated).toBe(2)
    expect(server.first.errors).toEqual(['BTC: not in today’s basket'])
    expect(server.daily).toEqual([
      { asset_id: 1, priced_on: '2026-09-21', close_cents: 24_950 },
      { asset_id: 1, priced_on: '2026-09-22', close_cents: 25_000 },
      { asset_id: 2, priced_on: '2026-09-21', close_cents: 50_150 },
      { asset_id: 2, priced_on: '2026-09-22', close_cents: 50_200 },
    ])
    const [vti, qqq, btc] = server.charts
    // VTI: the seed's quotes from months before the daily history, then the daily closes.
    expect(vti!.closes).toEqual([
      { d: '2026-03-31', c: 21_000 },
      { d: '2026-06-30', c: 23_500 },
      { d: '2026-09-21', c: 24_950 },
      { d: '2026-09-22', c: 25_000 },
    ])
    expect(vti!.coverage).toEqual({ firstOn: '2026-03-31', days: 4, source: 'quotes', dailyFrom: '2026-09-21' })
    expect(qqq!.symbol).toBe('QQQ')
    expect(qqq!.coverage).toEqual({ firstOn: '2026-05-29', days: 3, source: 'quotes', dailyFrom: '2026-09-21' })
    expect(btc!.coverage).toEqual({ firstOn: null, days: 0, source: 'daily', dailyFrom: null })
  })
})

describe('getChartData', () => {
  const seed = (db: DbLike) => {
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock')").run()
    const px = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, ?, ?)')
    const daily = db.prepare('INSERT INTO prices_daily (asset_id, priced_on, close_cents) VALUES (1, ?, ?)')
    return { px, daily }
  }

  it('falls back to the quote table when there is no daily history at all', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        const { px } = seed(db)
        px.run('2026-07-31', 100)
        px.run('2026-08-31', 110)
        px.run('2026-09-22', 120)
      },
      (db) => getChartData(db, 'vti'),
    )
    expect(browser).toEqual(server)
    expect(server).toEqual({
      symbol: 'VTI',
      kind: 'stock',
      closes: [
        { d: '2026-07-31', c: 100 },
        { d: '2026-08-31', c: 110 },
        { d: '2026-09-22', c: 120 },
      ],
      errors: [],
      coverage: { firstOn: '2026-07-31', days: 3, source: 'quotes', dailyFrom: null },
    })
  })

  it('uses the daily table alone when it covers everything the quote table has', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        const { px, daily } = seed(db)
        // A household: an old monthly row dated at its month's open (pre-v2
        // backfill), in the same month the daily history starts. Left out.
        px.run('2001-06-01', 5_000)
        px.run('2026-09-22', 30_000) // today's refresh, also in the daily table
        for (const [d, c] of [['2001-06-15', 5_100], ['2001-06-18', 5_150], ['2026-09-22', 30_010]] as const) daily.run(d, c)
      },
      (db) => getChartData(db, 'VTI', ['upstream note']),
    )
    expect(browser).toEqual(server)
    expect(server.closes.map((c) => c.d)).toEqual(['2001-06-15', '2001-06-18', '2026-09-22'])
    expect(server.closes[2]!.c).toBe(30_010) // the daily close wins on a shared day
    expect(server.errors).toEqual(['upstream note'])
    expect(server.coverage).toEqual({ firstOn: '2001-06-15', days: 3, source: 'daily', dailyFrom: '2001-06-15' })
  })

  it('fills in quote rows before the daily history’s first month and after its last day', async () => {
    const { server } = await onBothEngines(
      (db) => {
        const { px, daily } = seed(db)
        px.run('2026-06-30', 90) // before → kept
        px.run('2026-08-31', 95) // before → kept
        px.run('2026-09-01', 96) // same month as the first daily close → left out
        daily.run('2026-09-10', 97)
        daily.run('2026-09-11', 98)
        px.run('2026-09-12', 99) // after the last daily close → kept
      },
      (db) => getChartData(db, 'VTI'),
    )
    expect(server.closes.map((c) => c.d)).toEqual(['2026-06-30', '2026-08-31', '2026-09-10', '2026-09-11', '2026-09-12'])
    expect(server.coverage).toEqual({ firstOn: '2026-06-30', days: 5, source: 'quotes', dailyFrom: '2026-09-10' })
  })

  it('a refresh quote newer than the last daily fetch extends the series without changing its source', async () => {
    const { server } = await onBothEngines(
      (db) => {
        const { px, daily } = seed(db)
        daily.run('2026-09-18', 100)
        daily.run('2026-09-21', 101)
        px.run('2026-09-21', 101)
        px.run('2026-09-22', 102) // today's refresh; the daily history was fetched yesterday
      },
      (db) => getChartData(db, 'VTI'),
    )
    expect(server.closes).toEqual([
      { d: '2026-09-18', c: 100 },
      { d: '2026-09-21', c: 101 },
      { d: '2026-09-22', c: 102 },
    ])
    expect(server.coverage).toEqual({ firstOn: '2026-09-18', days: 3, source: 'daily', dailyFrom: '2026-09-18' })
  })

  it('404s an unknown symbol', async () => {
    const { server, browser } = await onBothEngines(seed, (db) => {
      try {
        getChartData(db, 'NOPE')
        return 'no error'
      } catch (e) {
        return `${(e as { status?: number }).status} ${(e as Error).message}`
      }
    })
    expect(server).toBe('404 no such asset')
    expect(browser).toBe(server)
  })
})

/* ---------- snapshot hygiene (A7): loadDump trusts the schema, not the row keys ---------- */

describe('loadDump hygiene, on both engines', () => {
  const tryLoad = (db: DbLike, dump: Dump) => {
    try {
      loadDump(db, dump)
      return 'loaded'
    } catch (e) {
      return (e as Error).message
    }
  }
  const counts = (db: DbLike) =>
    Object.fromEntries(['accounts', 'invest_accounts', 'assets', 'trades'].map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]))
  const withRows = (dump: Dump, table: string, rows: unknown[]): Dump => ({ ...dump, tables: { ...dump.tables, [table]: rows as Record<string, unknown>[] } })

  it('refuses a row key that is not a column — checked on every row — and leaves the data untouched', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      const dump = dumpDb(db)
      const before = counts(db)
      const asset = dump.tables.assets![0]!
      return {
        before,
        // A key that isn't a column, on a LATER row (the old code read only the first row's keys).
        unknown: tryLoad(db, withRows(dump, 'assets', [asset, { ...dump.tables.assets![1]!, colour: 'red' }])),
        // A key crafted as SQL.
        injected: tryLoad(db, withRows(dump, 'assets', [{ ...asset, "symbol) VALUES ('X'); DROP TABLE trades; --": 1 }])),
        malformedValue: tryLoad(db, withRows(dump, 'assets', [{ ...asset, name: { nested: true } }])),
        malformedRow: tryLoad(db, withRows(dump, 'assets', [null])),
        notAList: tryLoad(db, { ...dump, tables: { ...dump.tables, assets: 'nope' as unknown as Record<string, unknown>[] } }),
        after: counts(db),
      }
    })
    expect(browser).toEqual(server)
    expect(server.unknown).toBe('snapshot has an unknown column: assets.colour')
    expect(server.injected).toMatch(/^snapshot has an unknown column: assets\.symbol\) VALUES/)
    expect(server.malformedValue).toBe('snapshot has a malformed value in assets.name')
    expect(server.malformedRow).toBe('snapshot has a malformed row in assets')
    expect(server.notAList).toBe('snapshot table assets is not a list of rows')
    expect(server.after).toEqual(server.before) // every refusal happened before the first write
    expect(server.before.trades).toBe(4) // not vacuous
  })

  it('inserts each row with its own keys: a later row’s extra column is kept, a missing one takes its DEFAULT', async () => {
    const { server, browser } = await onBothEngines(
      () => {},
      (db) => {
        const dump = dumpDb(db)
        const loaded = tryLoad(
          db,
          withRows(dump, 'invest_accounts', [
            { id: 1, name: 'Joint taxable', kind: 'brokerage', tracking: 'lots' }, // no owner, no sort
            { id: 2, name: 'Max 401(k)', kind: 'retirement', tracking: 'balance', owner: 'max', sort: 3 },
          ]),
        )
        return { loaded, rows: db.prepare('SELECT id, name, owner, sort, stock_plan FROM invest_accounts ORDER BY id').all() }
      },
    )
    expect(browser).toEqual(server)
    expect(server).toEqual({
      loaded: 'loaded',
      rows: [
        { id: 1, name: 'Joint taxable', owner: null, sort: 0, stock_plan: 0 },
        { id: 2, name: 'Max 401(k)', owner: 'max', sort: 3, stock_plan: 0 },
      ],
    })
  })

  it('no longer carries onchain_daily, and ignores it in an older snapshot', async () => {
    // The dumps are compared across engines, so every datetime('now') default the seed leaves (created_at…)
    // is pinned: the two seeds run moments apart and could straddle a second.
    const seedPinned = (db: DbLike) => {
      seedHousehold(db)
      for (const t of TABLES)
        for (const c of db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; dflt_value: string | null }[])
          if (c.dflt_value?.includes("'now'")) db.prepare(`UPDATE ${t} SET ${c.name} = '2026-09-22 12:00:00'`).run()
    }
    const { server, browser } = await onBothEngines(seedPinned, (db) => {
      const dump = dumpDb(db)
      const older = { ...dump, tables: { ...dump.tables, onchain_daily: [{ metric: 'mvrv', day: '2026-09-01', value: 1_800_000 }] } }
      return {
        keys: Object.keys(dump.tables),
        loaded: tryLoad(db, older),
        onchain: (db.prepare('SELECT count(*) AS n FROM onchain_daily').get() as { n: number }).n,
        roundTrip: dumpDb(db).tables,
        original: dump.tables,
      }
    })
    expect(browser).toEqual(server)
    expect(TABLES).not.toContain('onchain_daily')
    expect(server.keys).not.toContain('onchain_daily')
    expect(server.loaded).toBe('loaded')
    expect(server.onchain).toBe(0)
    expect(server.roundTrip).toEqual(server.original)
    expect(server.original.accounts![0]).toMatchObject({ created_at: '2026-09-22 12:00:00' }) // the pin took
  })

  it('keeps the server’s basket:* keys and never takes them from a snapshot', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      const put = db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)')
      put.run('basket:history:v1', 'the server’s file')
      put.run('basket:built_at', '2026-09-22T06:00:00Z')
      const dump = dumpDb(db)
      const crafted = withRows(dump, 'app_meta', [
        ...(dump.tables.app_meta ?? []),
        { key: 'basket:history:v1', value: 'a file smuggled in a snapshot' }, // would collide with the server's row
        { key: 'Basket:history:head', value: '{}' }, // LIKE is case-insensitive: also the basket's
        { key: 'ui:chart-views', value: '[]' },
      ])
      const meta = () => db.prepare('SELECT key, value FROM app_meta ORDER BY key').all()
      return { exported: dump.tables.app_meta!.map((r) => r.key), loaded: tryLoad(db, crafted), meta: meta() }
    })
    expect(browser).toEqual(server)
    expect(server.exported).not.toContain('basket:history:v1')
    expect(server.loaded).toBe('loaded')
    expect(server.meta).toEqual(
      expect.arrayContaining([
        { key: 'basket:built_at', value: '2026-09-22T06:00:00Z' },
        { key: 'basket:history:v1', value: 'the server’s file' },
        { key: 'ui:chart-views', value: '[]' },
      ]),
    )
    expect(server.meta).not.toContainEqual({ key: 'Basket:history:head', value: '{}' })
  })
})

/* ---------- the shared monthly market history (A5) ---------- */

/** `n` consecutive months from `first`, the i-th close f(i). */
const monthsOf = (first: string, n: number, f: (i: number) => number): MonthClose[] =>
  Array.from({ length: n }, (_, i) => ({ month: addMonthsToMonth(first, i), cents: f(i) }))

const START = '2016-09'
/** A small file shaped like the server's: months through `final` are true month ends; September is in progress. */
const PACK: HistoryPack = {
  v: 1,
  start: START,
  final: '2026-08',
  asOf: '2026-09-22',
  builtAt: '2026-09-01T06:00:00.000Z',
  stock: {
    VTI: encodeMonthly(START, monthsOf('2024-10', 24, (i) => 18_000 + 250 * i)), // 2024-10 … 2026-09
    QQQ: encodeMonthly(START, monthsOf('2026-01', 9, (i) => 45_000 + 500 * i)),
    SPY: encodeMonthly(START, monthsOf('2024-01', 33, (i) => 47_000 + 300 * i)),
    BTC: encodeMonthly(START, monthsOf('2024-01', 33, () => 4_000)), // the bitcoin trust: a stock that shares the ticker
  },
  crypto: {
    BTC: encodeMonthly(START, monthsOf('2025-01', 21, (i) => 6_000_000 + 10_000 * i)),
    ETH: encodeMonthly(START, monthsOf('2025-01', 21, () => 400_000)),
  },
}

const totalChanges = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

describe('monthly market history parity: better-sqlite3 vs sql.js', () => {
  it('writes month-end closes for traded assets only, never over a close already there; a second apply writes nothing', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      const assetsBefore = db.prepare('SELECT id, symbol, kind FROM assets ORDER BY id').all()
      const neededBefore = needsMonthlyHistory(db, TODAY)
      const first = applyMonthlyHistory(db, PACK)
      const mid = totalChanges(db)
      const again = applyMonthlyHistory(db, PACK)
      return {
        neededBefore,
        neededAfter: needsMonthlyHistory(db, TODAY),
        first,
        again,
        changedByAgain: totalChanges(db) - mid,
        assetsBefore,
        assetsAfter: db.prepare('SELECT id, symbol, kind FROM assets ORDER BY id').all(),
        prices: rows(db, 'prices') as { asset_id: number; priced_on: string; close_cents: number }[],
      }
    })
    expect(browser).toEqual(server)
    // VTI 2024-10 … 2026-08 less the two month ends the household already had; QQQ 2026-01 … 08; bitcoin 2025-01 … 2026-08.
    expect(server.first).toEqual({ written: 21 + 8 + 20, matched: 3, errors: [], final: '2026-08', pending: false })
    expect(server.again).toEqual({ ...server.first, written: 0 })
    expect(server.changedByAgain).toBe(0) // a vault session stays clean
    expect(server.neededBefore).toBe(true)
    expect(server.neededAfter).toBe(false)
    // Only this household's assets: SPY, ETH and the BTC trust never become rows of any kind.
    expect(server.assetsAfter).toEqual(server.assetsBefore)
    expect(new Set(server.prices.map((p) => p.asset_id))).toEqual(new Set([1, 2, 3]))
    // Each row at its month's last day, nothing past `final` but the household's own quote.
    const vti = server.prices.filter((p) => p.asset_id === 1)
    expect(vti[0]).toEqual({ asset_id: 1, priced_on: '2024-10-31', close_cents: 18_000 })
    expect(vti.find((p) => p.priced_on === '2025-02-28')?.close_cents).toBe(19_000)
    expect(vti.at(-1)).toEqual({ asset_id: 1, priced_on: '2026-09-19', close_cents: 24_800 })
    expect(server.prices.filter((p) => p.priced_on > '2026-08-31').map((p) => p.priced_on)).toEqual(['2026-09-19'])
    // The household's own closes win their day.
    expect(vti.find((p) => p.priced_on === '2026-03-31')?.close_cents).toBe(21_000)
    expect(vti.find((p) => p.priced_on === '2026-06-30')?.close_cents).toBe(23_500)
    // Bitcoin the coin, not the trust.
    expect(server.prices.find((p) => p.asset_id === 3 && p.priced_on === '2025-01-31')?.close_cents).toBe(6_000_000)
  })

  it('leaves out an asset the history lacks or disagrees with, and refuses a malformed file before writing', async () => {
    const seed = (db: DbLike) => {
      seedHousehold(db)
      db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ACME', 'stock')").run() // 4: off-universe
      db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 4, '2026-01-05', 'buy', 1000000, 1000)").run()
      db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-20', 60000)").run() // VTI far above the file
    }
    const { server, browser } = await onBothEngines(seed, (db) => {
      const before = totalChanges(db)
      const refused = [{ v: 2 }, null, 'nope', { ...PACK, final: '2026-8' }].map((p) => {
        try {
          applyMonthlyHistory(db, p)
          return 'applied'
        } catch (e) {
          return e instanceof ApiError ? `${e.status} ${e.message}` : `? ${(e as Error).message}`
        }
      })
      const untouched = totalChanges(db) === before
      const damaged = applyMonthlyHistory(db, { ...PACK, stock: { ...PACK.stock, QQQ: [0, -5] } })
      return { refused, untouched, damaged }
    })
    expect(browser).toEqual(server)
    expect(server.refused).toEqual(Array(4).fill('400 malformed market history'))
    expect(server.untouched).toBe(true)
    expect(server.damaged.errors).toEqual([
      'VTI: the shared market history is far from this household’s own 2026-09-20 price, so it was left out',
      'QQQ: not in the shared market history', // an unreadable array is no history, not an error
      'ACME: not in the shared market history',
    ])
    expect(server.damaged).toMatchObject({ matched: 1, written: 20 }) // bitcoin alone
  })

  it('fills the months before the first quote, so net worth has no cliff', async () => {
    // A back-dated buy in a tab whose first refresh was this month: before the
    // history, every month up to August is valued at cost and September jumps.
    const seed = (db: DbLike) => {
      db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
      db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock')").run()
      db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '2025-03-10', 'buy', 10000000, 200000)").run()
      db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-19', 24800)").run()
    }
    const { server, browser } = await onBothEngines(seed, (db) => {
      const pos = () => getSeries(db, TODAY, { ids: ['pos:1:value'] }).series[0]!.points
      const before = { nw: netWorthSeries(db, TODAY).map((p) => [p.month, p.brokerage]), pos: pos(), needed: needsMonthlyHistory(db, TODAY) }
      applyMonthlyHistory(db, PACK)
      const after = { nw: netWorthSeries(db, TODAY).map((p) => [p.month, p.brokerage]), pos: pos(), needed: needsMonthlyHistory(db, TODAY) }
      return { before, after }
    })
    expect(browser).toEqual(server)
    const { before, after } = server
    expect(before.needed).toBe(true)
    expect(after.needed).toBe(false)
    // Before: cost, cost, …, then the cliff.
    expect(before.nw.slice(0, -1).every(([, v]) => v === 200_000)).toBe(true)
    expect(before.nw.at(-1)).toEqual(['2026-09', 248_000])
    expect(before.pos.slice(0, -1).every((p) => p.est === true)).toBe(true)
    // After: 10 shares at each month's close (2025-03 is the file's month 5), then the household's own quote.
    const expected = before.nw.map(([m], i) => [m, i === before.nw.length - 1 ? 248_000 : 10 * (18_000 + 250 * (5 + i))])
    expect(after.nw).toEqual(expected)
    expect(after.nw).toHaveLength(19) // 2025-03 … 2026-09
    expect(after.pos.some((p) => p.est)).toBe(false)
    // No month moves by more than the price did: the largest step is September's real move to the quote.
    const steps = after.nw.slice(1).map(([, v], i) => (v as number) - (after.nw[i]![1] as number))
    expect(Math.max(...steps.slice(0, -1))).toBe(2_500)
  })

  it('asks for the file while a traded asset the basket covers has nothing from before its first trade', async () => {
    const seed = (db: DbLike) => {
      db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
      db.prepare("INSERT INTO assets (symbol, kind) VALUES ('SPY', 'stock')").run()
      // Pasted as of today and priced by today's quote: valued fine, but nothing to chart.
      db.prepare(`INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '${TODAY}', 'buy', 1000000, 50000)`).run()
      db.prepare(`INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '${TODAY}', 56000)`).run()
    }
    const { server, browser } = await onBothEngines(seed, (db) => {
      const inBasket = new Set(['stock:SPY'])
      const before = {
        plain: needsMonthlyHistory(db, TODAY),
        covered: needsMonthlyHistory(db, TODAY, { covered: inBasket }),
        notInBasket: needsMonthlyHistory(db, TODAY, { covered: new Set(['stock:VTI', 'crypto:SPY']) }),
        future: needsMonthlyHistory(db, '2026-08-31'), // the trade hasn't happened then
      }
      const applied = applyMonthlyHistory(db, PACK)
      return { before, applied, after: needsMonthlyHistory(db, TODAY, { covered: inBasket }) }
    })
    expect(browser).toEqual(server)
    expect(server.before).toEqual({ plain: true, covered: true, notInBasket: false, future: false })
    expect(server.applied).toMatchObject({ matched: 1, written: 32 }) // SPY 2024-01 … 2026-08
    expect(server.after).toBe(false)
  })

  it('reads benchmarks from the file in memory and writes nothing', async () => {
    const { server, browser } = await onBothEngines(seedHousehold, (db) => {
      const before = { prices: rows(db, 'prices'), assets: db.prepare('SELECT * FROM assets').all(), changes: totalChanges(db) }
      const market = packMarket(PACK)
      const res = getSeries(db, TODAY, { ids: ['bench:SPY', 'bench:BTC', 'bench:ETH'], market })
      const catalog = getSeriesCatalog(db, TODAY, { market }).entries.filter((e) => e.group === 'Benchmarks')
      return {
        res,
        catalog,
        unchanged:
          JSON.stringify(before) === JSON.stringify({ prices: rows(db, 'prices'), assets: db.prepare('SELECT * FROM assets').all(), changes: totalChanges(db) }),
      }
    })
    expect(browser).toEqual(server)
    expect(server.unchanged).toBe(true)
    expect(server.res.warnings).toEqual([])
    const [spy, btc, eth] = server.res.series
    expect(spy!.points[0]).toEqual({ t: '2024-01', v: 1_000_000 })
    expect(spy!.points).toHaveLength(33) // 2024-01 … 2026-09
    expect(spy!.points.at(-1)).toEqual({ t: '2026-09', v: Math.round(((47_000 + 300 * 32) / 47_000) * 1e6) })
    // The household holds bitcoin the coin, so bench:BTC is the coin (the trust sits flat at $40).
    expect(btc!.points[0]).toEqual({ t: '2025-01', v: 1_000_000 })
    expect(btc!.points.at(-1)!.v).toBe(Math.round((6_200_000 / 6_000_000) * 1e6))
    expect(eth!.points.every((p) => p.v === 1_000_000)).toBe(true) // any symbol the file has, held or not
    expect(server.catalog.map((e) => [e.id, e.available])).toEqual([
      ['bench:SPY', true],
      ['bench:QQQ', true],
      ['bench:VTI', true],
      ['bench:VXUS', false],
      ['bench:AGG', false],
      ['bench:BTC', true],
    ])
  })
})
