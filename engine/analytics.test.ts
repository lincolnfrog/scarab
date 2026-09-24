import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { dayNumber, xirr } from '../shared/perf'
import { MAX_SERIES_IDS, type Series, type SeriesPoint } from '../shared/series-api'
import { monthsBetween } from '../shared/dates'
import { CHART_VIEWS_KEY, getChartViews, getSeries, getSeriesCatalog, parseSeriesQuery, putChartViews, type MarketHistory } from './analytics'
import type { DbLike } from './db'
import { ApiError } from './errors'
import { deleteInvestAccount, getPortfolio, listInvestAccounts, OPENING_NOTE } from './invest'
import { netWorthSeries, type NetWorthPoint } from './networth'
import { getHoldingsReturns } from './returns'
import { cashflowMonthly, getGoal } from './services'
import { seedHousehold } from './test/household'

const TODAY = '2026-09-22'
const NW_IDS = ['nw:total', 'nw:cash', 'nw:brokerage', 'nw:retirement', 'nw:crypto', 'nw:property', 'nw:liabilities', 'nw:equity']
const BENCH_IDS = ['bench:SPY', 'bench:QQQ', 'bench:VTI', 'bench:VXUS', 'bench:AGG', 'bench:BTC']

const mem = () => openDb(':memory:') as unknown as DbLike
const seeded = () => {
  const db = mem()
  seedHousehold(db)
  return db
}
/** Every id, fetched within the per-request cap. */
const fetchAll = (db: DbLike) =>
  [NW_IDS.slice(0, MAX_SERIES_IDS), NW_IDS.slice(MAX_SERIES_IDS)].flatMap((ids) => getSeries(db, TODAY, { ids }).series)
const status = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ApiError ? e.status : e
  }
  return 'no error'
}

describe('series v0: the net-worth family', () => {
  it('the catalog offers one id per netWorthSeries component, plus total and home equity', () => {
    const db = seeded()
    const nw = netWorthSeries(db, TODAY)
    const catalog = getSeriesCatalog(db, TODAY)
    const ids = catalog.entries.map((e) => e.id)

    expect(catalog.asOf).toBe(TODAY)
    expect(ids.filter((id) => id.startsWith('nw:'))).toEqual(NW_IDS)
    expect(ids.slice(0, NW_IDS.length)).toEqual(NW_IDS) // net worth leads the catalog
    // Drift guard: a component added to netWorthSeries must get an id here.
    for (const field of Object.keys(nw[0]!).filter((k) => k !== 'month')) expect(ids).toContain(`nw:${field}`)
    for (const e of catalog.entries.filter((x) => x.id.startsWith('nw:')))
      expect(e).toEqual({
        id: e.id,
        label: expect.any(String),
        group: 'Net worth',
        unit: 'cents',
        kind: 'level',
        firstMonth: '2026-02',
        lastMonth: '2026-09',
        available: true,
      })
  })

  it('each series equals its netWorthSeries component, month for month', () => {
    const db = seeded()
    const nw = netWorthSeries(db, TODAY)
    const byId = new Map(fetchAll(db).map((s) => [s.id, s]))
    const expected = (v: (p: NetWorthPoint) => number) => nw.map((p) => ({ t: p.month, v: v(p) }))

    expect([...byId.keys()]).toEqual(NW_IDS)
    for (const field of ['total', 'cash', 'brokerage', 'retirement', 'crypto', 'property', 'liabilities'] as const)
      expect(byId.get(`nw:${field}`)!.points, field).toEqual(expected((p) => p[field]))
    expect(byId.get('nw:equity')!.points).toEqual(expected((p) => p.property + p.liabilities))
    for (const s of byId.values()) expect(s).toMatchObject({ unit: 'cents', kind: 'level' })

    // The seed exercises every part: nothing here is a flat zero line.
    for (const id of NW_IDS) expect(byId.get(id)!.points.some((p) => p.v !== 0), id).toBe(true)
    expect(byId.get('nw:liabilities')!.points.at(-1)!.v).toBe(-63_500_000) // as it enters the sum
    expect(byId.get('nw:equity')!.points.at(-1)!.v).toBe(85_000_000 - 63_500_000)
  })

  it('unknown ids become warnings, never errors, and the known ones still answer', () => {
    const db = seeded()
    const r = getSeries(db, TODAY, { ids: ['nw:total', 'nw:bogus', 'bogus', 'inv:all:bogus', 'nw:hasOwnProperty', ':total'] })
    expect(r.series.map((s) => s.id)).toEqual(['nw:total'])
    expect(r.warnings).toEqual([
      'unknown series: nw:bogus',
      'unknown series: bogus',
      'unknown series: inv:all:bogus',
      'unknown series: nw:hasOwnProperty',
      'unknown series: :total',
    ])
    // Prototype names are not families.
    expect(getSeries(db, TODAY, { ids: ['constructor:x', 'toString'] }).warnings).toHaveLength(2)
  })

  it('trims to the inclusive month window and drops duplicate ids', () => {
    const db = seeded()
    const months = (q: { from?: string; to?: string }) =>
      getSeries(db, TODAY, { ids: ['nw:total'], ...q }).series[0]!.points.map((p) => p.t)

    expect(months({ from: '2026-04', to: '2026-06' })).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(months({ from: '2026-08' })).toEqual(['2026-08', '2026-09'])
    expect(months({ to: '2026-03' })).toEqual(['2026-02', '2026-03'])
    expect(months({ from: '2020-01', to: '2021-12' })).toEqual([])
    const dup = getSeries(db, TODAY, { ids: ['nw:cash', 'nw:total', 'nw:cash'] })
    expect(dup.series.map((s) => s.id)).toEqual(['nw:cash', 'nw:total'])
  })

  it('refuses a malformed request with a 400', () => {
    const db = seeded()
    const seven = [...NW_IDS.slice(0, 6), 'nw:equity']
    expect(status(() => getSeries(db, TODAY, { ids: seven }))).toBe(400)
    expect(status(() => getSeries(db, TODAY, { ids: [...NW_IDS.slice(0, 6), 'nw:total'] }))).toBe('no error') // 6 once deduped
    expect(status(() => getSeries(db, TODAY, { ids: ['nw:total'], from: '2026-4' }))).toBe(400)
    expect(status(() => getSeries(db, TODAY, { ids: ['nw:total'], to: '2026-04-01' }))).toBe(400)
    expect(status(() => getSeries(db, TODAY, { ids: ['nw:total'], from: '2026-06', to: '2026-05' }))).toBe(400)
  })

  it('an empty household: everything unavailable, fetches answer with no points', () => {
    const db = mem()
    const { entries } = getSeriesCatalog(db, TODAY)
    // Nothing recorded: net worth and the fixed families, all greyed out.
    expect(entries.map((e) => e.id)).toEqual([
      ...NW_IDS,
      'inv:all:value', 'inv:all:cost', 'inv:all:twr',
      ...BENCH_IDS,
      'cf:income', 'cf:spend', 'cf:net', 'goal:fund',
    ])
    for (const e of entries) expect(e).toMatchObject({ available: false, reason: expect.any(String), firstMonth: null, lastMonth: null })
    expect(entries.find((e) => e.id === 'bench:SPY')!.reason).toBe('No price history for SPY yet')
    for (const e of entries.filter((x) => x.id.startsWith('nw:'))) expect(e.reason).toMatch(/^Nothing dated yet/)
    expect(getSeries(db, TODAY, { ids: ['nw:total'] })).toEqual({
      series: [{ id: 'nw:total', label: 'Net worth', unit: 'cents', kind: 'level', points: [] }],
      warnings: [],
    })
  })

  it('a part that is zero in every month is greyed out with a reason; equity needs a property', () => {
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', 5000)").run()
    db.prepare(
      "INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (1, '2026-06-02', 1000, 'x', 'h')",
    ).run()
    db.prepare("INSERT INTO liabilities (name) VALUES ('Car loan')").run()
    db.prepare("INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (1, '2026-06-01', 900000)").run()

    const meta = new Map(getSeriesCatalog(db, TODAY).entries.filter((e) => e.id.startsWith('nw:')).map((e) => [e.id, e]))
    const offered = [...meta.values()].filter((e) => e.available).map((e) => e.id)
    expect(offered).toEqual(['nw:total', 'nw:cash', 'nw:liabilities'])
    expect(meta.get('nw:crypto')).toMatchObject({ available: false, reason: 'No crypto holdings', firstMonth: '2026-06' })
    expect(meta.get('nw:equity')).toMatchObject({ available: false, reason: 'No properties recorded' })
    for (const e of meta.values()) expect('reason' in e).toBe(!e.available)
    // Greyed out in the picker, but still fetchable.
    expect(getSeries(db, TODAY, { ids: ['nw:crypto'] }).series[0]!.points).toEqual([
      { t: '2026-06', v: 0 },
      { t: '2026-07', v: 0 },
      { t: '2026-08', v: 0 },
      { t: '2026-09', v: 0 },
    ])
  })
})

describe('parseSeriesQuery', () => {
  it('splits and trims ids, dropping empties; absent or empty bounds are omitted', () => {
    expect(parseSeriesQuery({ ids: ' nw:total, nw:cash,,', from: '2026-01', to: '' })).toEqual({
      ids: ['nw:total', 'nw:cash'],
      from: '2026-01',
    })
    expect(parseSeriesQuery({})).toEqual({ ids: [] })
    expect(parseSeriesQuery({ ids: null, from: null, to: '2026-03' })).toEqual({ ids: [], to: '2026-03' })
  })

  it("puts back a '+' that query-string decoding turned into a space", () => {
    expect(parseSeriesQuery({ ids: 'set:1 2 3:value,nw:total' }).ids).toEqual(['set:1+2+3:value', 'nw:total'])
    expect(new URLSearchParams('ids=set:1+2:value').get('ids')).toBe('set:1 2:value') // why
  })
})

/* ---------- series v1 (A3) ---------- */

/** Every catalog id, fetched MAX_SERIES_IDS at a time. */
const fetchIds = (db: DbLike, ids: string[], today = TODAY) => {
  const out: { series: Series[]; warnings: string[] } = { series: [], warnings: [] }
  for (let i = 0; i < ids.length; i += MAX_SERIES_IDS) {
    const r = getSeries(db, today, { ids: ids.slice(i, i + MAX_SERIES_IDS) })
    out.series.push(...r.series)
    out.warnings.push(...r.warnings)
  }
  return out
}
const one = (db: DbLike, id: string, today = TODAY) => {
  const r = getSeries(db, today, { ids: [id] })
  expect(r.warnings, id).toEqual([])
  return r.series[0]!
}
const values = (s: Series) => Object.fromEntries(s.points.map((p) => [p.t, p.v]))
const estMonths = (s: Series) => s.points.filter((p) => p.est).map((p) => p.t)
/** The seeded household, with the goal funded from Checking plus $50 earmarked elsewhere. */
const funded = () => {
  const db = seeded()
  db.prepare("INSERT INTO goal_settings (key, value) VALUES ('goal', ?)").run(JSON.stringify({ fundAccountIds: [1], fundExtraCents: 5_000 }))
  return db
}

describe('series v1: the catalog', () => {
  it('lists every family for the seeded household, and every id in it can be fetched', () => {
    const db = funded()
    const { entries } = getSeriesCatalog(db, TODAY)
    const ids = entries.map((e) => e.id)
    expect(ids).toEqual([
      ...NW_IDS,
      'inv:all:value', 'inv:all:cost', 'inv:all:twr',
      // The accounts in the account strip's order (sort, then id), however each is tracked:
      'inv:1:value', 'inv:1:cost', 'inv:1:twr', 'inv:2:value', 'inv:2:cost', 'inv:2:twr',
      'inv:3:value', // the balance-tracked 401(k): a value, no cost basis, no time-weighted return
      'inv:4:value', 'inv:4:cost', 'inv:4:twr',
      'cash:1',
      'pos:1:value', 'pos:1:cost', 'pos:1:twr', 'pos:2:value', 'pos:2:cost', 'pos:2:twr', 'pos:3:value', 'pos:3:cost', 'pos:3:twr',
      'px:1', 'px:2', 'px:3',
      ...BENCH_IDS,
      'prop:1:value', 'prop:1:equity', 'liab:1',
      'cf:income', 'cf:spend', 'cf:net',
      'goal:fund',
    ])
    expect(new Set(ids).size).toBe(ids.length)

    const { series, warnings } = fetchIds(db, ids)
    // The seed's prices are sparse, so no holdings scope has 90% of its value priced: every
    // time-weighted return is withheld, with the reason (its catalog entry is greyed out too).
    const twrIds = ids.filter((id) => id.endsWith(':twr'))
    expect(warnings.map((w) => w.slice(0, w.indexOf(': ')))).toEqual(twrIds)
    for (const w of warnings) expect(w).toMatch(/: only \d+% of the value in these months had a market price; a time-weighted return needs 90%$/)
    expect(series.map((s) => s.id)).toEqual(ids)
    const byId = new Map(series.map((s) => [s.id, s]))
    for (const e of entries) {
      const s = byId.get(e.id)!
      expect(s, e.id).toMatchObject({ label: e.label, unit: e.unit, kind: e.kind })
      // The entry's month range is exactly the series' range.
      expect(s.points[0]?.t ?? null, e.id).toBe(e.firstMonth)
      expect(s.points.at(-1)?.t ?? null, e.id).toBe(e.lastMonth)
      // Contiguous months, no gaps.
      for (let i = 1; i < s.points.length; i++) expect(s.points[i]!.t > s.points[i - 1]!.t).toBe(true)
      if (e.available) expect(s.points.length, e.id).toBeGreaterThan(0)
      for (const p of s.points) expect(twrIds.includes(e.id) ? p.v === null : Number.isSafeInteger(p.v), `${e.id} ${p.t}`).toBe(true)
    }
    // BTC has never been priced: offered greyed out, still fetchable (empty).
    expect(entries.find((e) => e.id === 'px:3')).toMatchObject({ available: false, reason: 'No prices recorded yet', firstMonth: null })
    expect(byId.get('px:3')!.points).toEqual([])
    // VTI and QQQ are held and priced, so their benchmarks have history; BTC is held but never priced.
    const benchUnavailable = BENCH_IDS.filter((id) => id !== 'bench:VTI' && id !== 'bench:QQQ')
    expect(entries.filter((e) => !e.available).map((e) => e.id)).toEqual([...twrIds, 'px:3', ...benchUnavailable])
    for (const id of twrIds) expect(entries.find((e) => e.id === id)!.reason, id).toMatch(/^Too little price history: only \d+% of the value had a market price; a time-weighted return needs 90%$/)
  })

  it('groups, units and kinds follow the contract', () => {
    const { entries } = getSeriesCatalog(funded(), TODAY)
    const of = (id: string) => entries.find((e) => e.id === id)!
    expect(of('inv:all:value')).toMatchObject({ group: 'Accounts', unit: 'cents', kind: 'level', label: 'Portfolio · value' })
    expect(of('inv:1:cost')).toMatchObject({ group: 'Accounts', label: 'Taxable · cost basis' })
    expect(of('cash:1')).toMatchObject({ group: 'Accounts', label: 'Checking' })
    expect(of('pos:1:value')).toMatchObject({ group: 'Holdings', label: 'VTI · value' })
    expect(of('px:1')).toMatchObject({ group: 'Prices', unit: 'cents_per_share', label: 'VTI price' })
    expect(of('prop:1:equity')).toMatchObject({ group: 'Property', label: 'House · equity' })
    expect(of('liab:1')).toMatchObject({ group: 'Property', label: 'House · Mortgage owed' })
    expect(of('cf:spend')).toMatchObject({ group: 'Cash flow', kind: 'flow', label: 'Spending' })
    expect(of('goal:fund')).toMatchObject({ group: 'Goal', kind: 'level' })
  })

  it('lists the accounts in the account strip’s order: sort, then id', () => {
    const db = seeded()
    // Reordered on the strip: Coinbase first, the 401(k) second, then the two left at 0 by id.
    db.prepare('UPDATE invest_accounts SET sort = CASE id WHEN 4 THEN -2 WHEN 3 THEN -1 ELSE 0 END').run()
    const strip = listInvestAccounts(db).map((a) => a.id)
    expect(strip).toEqual([4, 3, 1, 2])
    const accounts = getSeriesCatalog(db, TODAY)
      .entries.map((e) => /^inv:(\d+):/.exec(e.id)?.[1])
      .filter((id): id is string => id !== undefined)
    expect([...new Set(accounts)].map(Number)).toEqual(strip)
  })

  it("two loans with the same name read apart: each says its property, and any still alike get a number", () => {
    const db = seeded() // House (1) with its Mortgage (1)
    db.prepare("INSERT INTO properties (name, purchased_on, purchase_cents) VALUES ('Test Cabin', '2026-05-01', 30000000)").run() // 2
    db.prepare("INSERT INTO liabilities (property_id, name) VALUES (2, 'Mortgage')").run() // 2
    db.prepare("INSERT INTO liabilities (name) VALUES ('Car loan')").run() // 3: no property
    db.prepare("INSERT INTO liabilities (property_id, name) VALUES (2, 'Mortgage')").run() // 4: a second one on the cabin
    for (const id of [2, 3, 4]) db.prepare("INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (?, '2026-06-01', 100)").run(id)
    const labels = new Map(getSeriesCatalog(db, TODAY).entries.filter((e) => e.id.startsWith('liab:')).map((e) => [e.id, e.label]))
    expect(Object.fromEntries(labels)).toEqual({
      'liab:1': 'House · Mortgage owed',
      'liab:2': 'Test Cabin · Mortgage owed (1)',
      'liab:3': 'Car loan · owed',
      'liab:4': 'Test Cabin · Mortgage owed (2)',
    })
    // A fetched series is labelled exactly as the catalog lists it.
    expect(fetchIds(db, [...labels.keys()]).series.map((x) => [x.id, x.label])).toEqual([...labels])
  })

  it('greys out what has nothing to draw, with a reason', () => {
    const db = seeded() // no goal settings
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Empty IRA', 'retirement', 'lots')").run() // 5
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Pension', 'retirement', 'balance')").run() // 6
    db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Savings', 'savings', 0)").run() // 2
    db.prepare("INSERT INTO properties (name) VALUES ('Lot')").run() // 2: no price, no valuation
    db.prepare("INSERT INTO liabilities (name) VALUES ('Car loan')").run() // 2: no balances
    db.prepare("INSERT INTO properties (name, purchased_on, purchase_cents) VALUES ('Cabin', '2026-11-01', 100)").run() // 3: future
    const meta = new Map(getSeriesCatalog(db, TODAY).entries.map((e) => [e.id, e]))
    expect(meta.get('inv:5:value')).toMatchObject({ available: false, reason: 'No trades in this account yet', firstMonth: null })
    expect(meta.get('inv:6:value')).toMatchObject({ available: false, reason: 'No balances recorded yet' })
    expect(meta.has('inv:6:cost')).toBe(false)
    expect(meta.get('cash:2')).toMatchObject({ available: false, reason: 'No transactions in this account yet' })
    expect(meta.get('prop:2:value')).toMatchObject({ available: false, reason: 'No purchase price or valuation recorded' })
    expect(meta.get('liab:2')).toMatchObject({ available: false, reason: 'No balances recorded yet' })
    expect(meta.get('prop:3:value')).toMatchObject({ available: false, reason: 'Nothing dated on or before today', firstMonth: null })
    expect(meta.get('goal:fund')).toMatchObject({ available: false, reason: 'Choose the accounts that fund the goal on the Goal screen' })
    // …and each still answers.
    const r = fetchIds(db, ['inv:5:value', 'inv:6:value', 'cash:2', 'prop:2:value', 'liab:2', 'prop:3:value', 'goal:fund'])
    expect(r.warnings).toEqual([])
    const [inv5, inv6, savings, lot, car, cabin, fund] = r.series.map((s) => s.points)
    expect([inv5, inv6, lot, car, cabin]).toEqual([[], [], [], [], []])
    expect(savings).toHaveLength(8) // the net-worth months, all zero
    expect(savings!.every((p) => p.v === 0)).toBe(true)
    expect(fund!.every((p) => p.v === 0)).toBe(true) // no fund accounts, nothing earmarked
  })
})

describe('series v1: holdings (inv, pos, set)', () => {
  it('values each holding at month end: price × shares, at cost (est) until priced', () => {
    const db = seeded()
    const vti = one(db, 'pos:1:value')
    // Feb: bought, no price yet → cost. Jul: 4 of 10 sold. Sep (now): the latest quote.
    expect(values(vti)).toEqual({
      '2026-02': 200_000,
      '2026-03': 210_000, '2026-04': 210_000, '2026-05': 210_000,
      '2026-06': 235_000,
      '2026-07': 141_000, '2026-08': 141_000,
      '2026-09': 148_800,
    })
    expect(estMonths(vti)).toEqual(['2026-02'])
    expect(values(one(db, 'pos:1:cost'))).toEqual({
      '2026-02': 200_000, '2026-03': 200_000, '2026-04': 200_000, '2026-05': 200_000, '2026-06': 200_000,
      '2026-07': 120_000, '2026-08': 120_000, '2026-09': 120_000,
    })
    expect(estMonths(one(db, 'pos:1:cost'))).toEqual([]) // cost is never an estimate
    const qqq = one(db, 'pos:2:value')
    expect(values(qqq)).toEqual({ '2026-04': 180_000, '2026-05': 188_000, '2026-06': 188_000, '2026-07': 188_000, '2026-08': 188_000, '2026-09': 188_000 })
    expect(estMonths(qqq)).toEqual(['2026-04'])
    // BTC is never priced: at cost, every month an estimate.
    const btc = one(db, 'pos:3:value')
    expect(btc.points).toEqual(['2026-06', '2026-07', '2026-08', '2026-09'].map((t) => ({ t, v: 650_000, est: true })))
  })

  it('inv:all:value in the current month is the portfolio total, to the cent', () => {
    const db = seeded()
    const pf = getPortfolio(db, TODAY)
    const value = one(db, 'inv:all:value')
    const cost = one(db, 'inv:all:cost')
    expect(pf.totals.value).toBe(986_800) // not vacuous
    expect(value.points.at(-1)).toEqual({ t: '2026-09', v: pf.totals.value, est: true }) // BTC is at cost
    expect(cost.points.at(-1)).toEqual({ t: '2026-09', v: pf.totals.cost })
    // …and after the next quote lands, still.
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (3, '2026-09-23', 6_000_000)").run() // BTC, stamped tomorrow (UTC)
    const later = getPortfolio(db, TODAY)
    expect(one(db, 'inv:all:value').points.at(-1)).toEqual({ t: '2026-09', v: later.totals.value })
    expect(later.totals.value).toBe(148_800 + 188_000 + 600_000)
  })

  it('sums: inv:all is every lots account; set:A+B is pos:A + pos:B, month by month', () => {
    const db = seeded()
    const all = one(db, 'inv:all:value')
    const accounts = [1, 2, 4].map((id) => values(one(db, `inv:${id}:value`)))
    for (const p of all.points) expect(p.v, p.t).toBe(accounts.reduce((s, a) => s + (a[p.t] ?? 0), 0))

    for (const metric of ['value', 'cost'] as const) {
      const set = one(db, `set:1+2:${metric}`)
      const a = one(db, `pos:1:${metric}`)
      const b = one(db, `pos:2:${metric}`)
      const at = (s: Series, t: string): SeriesPoint | undefined => s.points.find((p) => p.t === t)
      expect(set.points[0]!.t).toBe('2026-02') // from the earlier member's first month
      expect(set.points.at(-1)!.t).toBe('2026-09')
      for (const p of set.points) {
        expect(p.v, `${metric} ${p.t}`).toBe((at(a, p.t)?.v ?? 0) + (at(b, p.t)?.v ?? 0))
        expect(p.est ?? false, `${metric} ${p.t}`).toBe((at(a, p.t)?.est ?? false) || (at(b, p.t)?.est ?? false))
      }
    }
    expect(one(db, 'set:1+2:value').label).toBe('VTI + QQQ · value')
    // A repeated member counts once; the id comes back exactly as asked.
    const twice = one(db, 'set:2+1+2:value')
    expect(twice.id).toBe('set:2+1+2:value')
    expect(twice.points).toEqual(one(db, 'set:1+2:value').points)
    // A set of one is its holding.
    expect(one(db, 'set:3:value').points).toEqual(one(db, 'pos:3:value').points)
  })

  it('a balance-tracked account is its snapshots, with no cost basis', () => {
    const db = seeded()
    expect(values(one(db, 'inv:3:value'))).toEqual({
      '2026-03': 4_200_000, '2026-04': 4_200_000, '2026-05': 4_200_000,
      '2026-06': 4_450_000, '2026-07': 4_450_000, '2026-08': 4_450_000, '2026-09': 4_450_000,
    })
    expect(getSeries(db, TODAY, { ids: ['inv:3:cost'] })).toEqual({
      series: [],
      warnings: ['inv:3:cost: 401(k) tracks a balance, not trades, so it has no cost basis'],
    })
  })

  it('cuts each month at its last day; the current month is as of today', () => {
    const db = mem()
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock')").run()
    const trade = db.prepare('INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, ?, ?, ?, ?)')
    trade.run('2026-07-31', 'buy', 1_000_000, 10_000) // the last day of July: in July
    trade.run('2026-09-25', 'buy', 1_000_000, 11_000) // after today: hasn't happened
    const price = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, ?, ?)')
    price.run('2026-08-01', 12_000) // the first of August: not July's price
    price.run('2026-09-23', 13_000) // tomorrow's UTC stamp: today's price
    expect(one(db, 'pos:1:value').points).toEqual([
      { t: '2026-07', v: 10_000, est: true },
      { t: '2026-08', v: 12_000 },
      { t: '2026-09', v: 13_000 },
    ])
    expect(values(one(db, 'px:1'))).toEqual({ '2026-08': 12_000, '2026-09': 13_000 })
    // The same cutoffs as net worth.
    expect(netWorthSeries(db, TODAY).map((p) => p.brokerage)).toEqual([10_000, 12_000, 13_000])
  })

  it("a deleted account's ids come back as warnings, never errors", () => {
    const db = seeded()
    deleteInvestAccount(db, 1) // Taxable: VTI's only account, so VTI and its prices go too
    const ids = ['inv:1:value', 'inv:1:cost', 'pos:1:value', 'px:1', 'set:1+2:value', 'inv:all:value']
    const r = getSeries(db, TODAY, { ids })
    expect(r.series.map((s) => s.id)).toEqual(['inv:all:value'])
    expect(r.warnings).toEqual(ids.slice(0, 5).map((id) => `unknown series: ${id}`))
    const catalog = getSeriesCatalog(db, TODAY).entries.map((e) => e.id)
    for (const id of ids.slice(0, 5)) expect(catalog).not.toContain(id)
  })

  it('reads ids strictly: one spelling per series', () => {
    const db = seeded()
    const odd = [
      'pos:01:value', 'pos:1:TWR', 'pos:1', 'inv:all', 'inv:all:twr:x', 'set:1++2:value', 'set:+1:value', 'px:1:value', 'px:0', 'cash:1.0',
      'liab:x', 'goal:bogus', 'cf:gross', 'prop:1:cost', 'prop:1:twr', 'bench:', 'bench:spy', 'bench:BRK.B', 'bench:BRK-', 'bench:A B', `bench:${'X'.repeat(13)}`,
    ]
    const r = fetchIds(db, odd)
    expect(r.series).toEqual([])
    expect(r.warnings).toEqual(odd.map((id) => `unknown series: ${id}`))
  })
})

describe('series v1: cash, property, cash flow, goal', () => {
  it('cash:<id> sums to nw:cash; goal:fund is the fund accounts plus what is earmarked, as the Goal screen totals it', () => {
    const db = funded()
    const nwCash = values(one(db, 'nw:cash'))
    const checking = one(db, 'cash:1')
    expect(values(checking)).toEqual(nwCash)
    expect(values(checking)).toEqual({
      '2026-02': 100_000, '2026-03': 600_000, '2026-04': 600_000, '2026-05': 480_000,
      '2026-06': 480_000, '2026-07': 480_000, '2026-08': 730_000, '2026-09': 730_000,
    })
    const fund = one(db, 'goal:fund')
    expect(fund.points).toEqual(checking.points.map((p) => ({ t: p.t, v: p.v! + 5_000 })))
    expect(fund.points.at(-1)!.v).toBe(getGoal(db).fundTotal)
  })

  it('prop:<id>:value follows net worth’s rule; equity subtracts the loans on it; liab:<id> is negative, as it enters net worth', () => {
    const db = seeded()
    expect(values(one(db, 'prop:1:value'))).toEqual({
      '2026-04': 80_000_000, '2026-05': 80_000_000, '2026-06': 80_000_000,
      '2026-07': 85_000_000, '2026-08': 85_000_000, '2026-09': 85_000_000,
    })
    expect(values(one(db, 'liab:1'))).toEqual({
      '2026-04': -64_000_000, '2026-05': -64_000_000, '2026-06': -64_000_000, '2026-07': -64_000_000,
      '2026-08': -63_500_000, '2026-09': -63_500_000,
    })
    const equity = one(db, 'prop:1:equity')
    const nwEquity = values(one(db, 'nw:equity'))
    for (const p of equity.points) expect(p.v, p.t).toBe(nwEquity[p.t]) // one house, one mortgage
    expect(equity.points.at(-1)!.v).toBe(21_500_000)
  })

  it('cf:* is zero-filled monthly income, spending and net, transfers excluded', () => {
    const db = seeded()
    const cat = (db.prepare("SELECT id FROM categories WHERE kind = 'transfer' LIMIT 1").get() as { id: number }).id
    db.prepare(
      "INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash, category_id) VALUES (1, '2026-06-03', -99999, 'TO SAVINGS', 'h9', ?)",
    ).run(cat)
    const income = one(db, 'cf:income')
    expect(income.kind).toBe('flow')
    expect(values(income)).toEqual({ '2026-03': 500_000, '2026-04': 0, '2026-05': 0, '2026-06': 0, '2026-07': 0, '2026-08': 250_000, '2026-09': 0 })
    expect(values(one(db, 'cf:spend'))).toEqual({ '2026-03': 0, '2026-04': 0, '2026-05': 120_000, '2026-06': 0, '2026-07': 0, '2026-08': 0, '2026-09': 0 })
    expect(values(one(db, 'cf:net'))).toEqual({ '2026-03': 500_000, '2026-04': 0, '2026-05': -120_000, '2026-06': 0, '2026-07': 0, '2026-08': 250_000, '2026-09': 0 })
  })

  it('cf:* draws exactly the Cash screen bars: a refund nets against its category, not income', () => {
    const db = seeded()
    const cat = (kind: string) => (db.prepare('SELECT id FROM categories WHERE kind = ? ORDER BY id LIMIT 1').get(kind) as { id: number }).id
    const add = db.prepare(
      'INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash, category_id) VALUES (1, ?, ?, ?, ?, ?)',
    )
    add.run('2026-07-02', -40_000, 'STORE', 'r1', cat('expense'))
    add.run('2026-07-20', 15_000, 'STORE REFUND', 'r2', cat('expense')) // a refund, not income
    add.run('2026-07-25', 300_000, 'PAYROLL', 'r3', cat('income'))
    const bars = new Map(cashflowMonthly(db, { months: 120 }).map((m) => [m.month, m]))
    const [income, spend, net] = getSeries(db, TODAY, { ids: ['cf:income', 'cf:spend', 'cf:net'] }).series
    expect(values(income!)['2026-07']).toBe(300_000)
    expect(values(spend!)['2026-07']).toBe(25_000)
    for (const p of income!.points) if (bars.has(p.t)) expect(p.v, p.t).toBe(bars.get(p.t)!.income_cents)
    for (const p of spend!.points) if (bars.has(p.t)) expect(p.v, p.t).toBe(bars.get(p.t)!.spend_cents)
    for (const p of net!.points) expect(p.v, p.t).toBe(values(income!)[p.t]! - values(spend!)[p.t]!)
    // Every month the Cash bars show is in the series (the series also zero-fills through this month).
    for (const m of bars.keys()) expect(income!.points.some((p) => p.t === m), m).toBe(true)
  })
})

/* ---------- performance (A6): :twr ---------- */

/**
 * A blank household with a Taxable (1) and a Roth (2) account and VTI (1) and QQQ (2);
 * trades and closes by hand. Shares are whole numbers here: `shares` × 1e6 micro.
 */
const book = () => {
  const db = mem()
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots'), ('Roth', 'retirement', 'lots')").run()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('QQQ', 'stock')").run()
  const insert = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, acquired_on, basis_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const trade = (account: number, asset: number, on: string, side: 'buy' | 'sell', shares: number, cents: number, o: { acquired?: string; basis?: number; note?: string } = {}) =>
    insert.run(account, asset, on, side, shares * 1_000_000, cents, o.acquired ?? null, o.basis ?? null, o.note ?? null)
  const price = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)')
  const close = (asset: number, on: string, cents: number) => price.run(asset, on, cents)
  return { db, trade, close }
}
/** VTI's month-end closes, Jan–Sep 2026: +10% in Jan (from the $100 buy), flat, +10%, −5%, flat to Aug, back to $120. */
const VTI_CLOSES: [string, number][] = [
  ['2026-01-30', 11_000], ['2026-02-27', 11_000], ['2026-03-31', 12_100], ['2026-04-30', 11_495],
  ['2026-05-29', 11_495], ['2026-06-30', 11_495], ['2026-07-31', 11_495], ['2026-08-31', 11_495], ['2026-09-21', 12_000],
]
const twr = (db: DbLike, id: string, q: { from?: string; to?: string } = {}) => {
  const r = getSeries(db, TODAY, { ids: [id], ...q })
  return { series: r.series[0]!, warnings: r.warnings }
}

describe('series: time-weighted return (:twr)', () => {
  it('a deposit or a withdrawal at the going price does not move it; only price moves do', () => {
    const plain = book()
    plain.trade(1, 1, '2026-01-05', 'buy', 10, 100_000)
    for (const [on, c] of VTI_CLOSES) plain.close(1, on, c)

    const busy = book()
    busy.trade(1, 1, '2026-01-05', 'buy', 10, 100_000)
    busy.trade(1, 1, '2026-02-12', 'buy', 10, 110_000) // mid-February, at February's (flat) price
    busy.trade(1, 1, '2026-03-31', 'buy', 5, 60_500) // on March's last day, at its close
    busy.trade(1, 1, '2026-04-30', 'sell', 3, 34_485) // on April's last day, at its close
    busy.trade(1, 1, '2026-06-15', 'sell', 12, 137_940) // mid-June, at June's (flat) price
    for (const [on, c] of VTI_CLOSES) busy.close(1, on, c)

    const expected = [1_100_000, 1_100_000, 1_210_000, 1_149_500, 1_149_500, 1_149_500, 1_149_500, 1_149_500, 1_200_000]
    for (const id of ['pos:1:twr', 'inv:1:twr', 'inv:all:twr', 'set:1:twr']) {
      const a = twr(plain.db, id)
      const b = twr(busy.db, id)
      expect(a.warnings, id).toEqual([])
      expect(b.warnings, id).toEqual([])
      expect(a.series.points.map((p) => p.v), id).toEqual(expected)
      expect(b.series.points, id).toEqual(a.series.points)
    }
    // …while the value series plainly moves with the money.
    expect(one(busy.db, 'pos:1:value').points.at(-1)!.v).toBe(10 * 12_000)
    expect(twr(busy.db, 'pos:1:twr').series).toMatchObject({ unit: 'index_micro', kind: 'level' })
  })

  it('a flat price gives exactly 1_000_000 in every month, whatever is bought and sold across accounts', () => {
    const { db, trade, close } = book()
    trade(1, 1, '2026-01-05', 'buy', 10, 100_000)
    trade(1, 1, '2026-02-17', 'buy', 5, 50_000)
    trade(1, 1, '2026-04-08', 'sell', 12, 120_000)
    trade(2, 1, '2026-06-03', 'buy', 20, 200_000)
    trade(1, 1, '2026-07-30', 'sell', 3, 30_000) // Taxable sold out
    trade(2, 2, '2026-03-10', 'buy', 4, 40_000)
    for (const m of ['01-30', '02-27', '03-31', '04-30', '05-29', '06-30', '07-31', '08-31', '09-21']) {
      close(1, `2026-${m}`, 10_000)
      close(2, `2026-${m}`, 10_000)
    }
    for (const id of ['pos:1:twr', 'pos:2:twr', 'inv:1:twr', 'inv:2:twr', 'inv:all:twr', 'set:1+2:twr']) {
      const { series, warnings } = twr(db, id)
      expect(warnings, id).toEqual([])
      expect(series.points.length, id).toBeGreaterThan(0)
      for (const p of series.points) expect(p, `${id} ${p.t}`).toEqual({ t: p.t, v: 1_000_000 })
    }
    // Taxable holds nothing from August: the index waits, flat.
    expect(twr(db, 'inv:1:twr').series.points.map((p) => p.t)).toEqual(monthsBetween('2026-01', '2026-09'))
  })

  it('is withheld (null, with the reason) when less than 90% of the value in the window had a market price', () => {
    const db = seeded()
    // VTI: February valued at cost, March its first quote — so neither month's return counts.
    const full = twr(db, 'pos:1:twr')
    expect(full.series.points.map((p) => p.t)).toEqual(monthsBetween('2026-02', '2026-09'))
    expect(full.series.points.every((p) => p.v === null && p.est === undefined)).toBe(true)
    expect(full.warnings).toEqual(['pos:1:twr: only 72% of the value in these months had a market price; a time-weighted return needs 90%'])
    const entry = getSeriesCatalog(db, TODAY).entries.find((e) => e.id === 'pos:1:twr')!
    expect(entry).toMatchObject({ available: false, firstMonth: '2026-02', lastMonth: '2026-09', unit: 'index_micro' })
    expect(entry.reason).toBe('Too little price history: only 72% of the value had a market price; a time-weighted return needs 90%')

    // From April on every month counts: the index, and no warning.
    const recent = twr(db, 'pos:1:twr', { from: '2026-04' })
    expect(recent.warnings).toEqual([])
    expect(recent.series.points.slice(0, 3)).toEqual([
      { t: '2026-04', v: 1_000_000 },
      { t: '2026-05', v: 1_000_000 },
      { t: '2026-06', v: 1_119_048 }, // 235,000 / 210,000
    ])
    for (const p of recent.series.points) expect(Number.isSafeInteger(p.v), p.t).toBe(true)
    // BTC, never priced: withheld in any window.
    expect(twr(db, 'pos:3:twr', { from: '2026-09' }).warnings).toEqual([
      'pos:3:twr: only 0% of the value in these months had a market price; a time-weighted return needs 90%',
    ])
  })

  it('90% is enough: the threshold is inclusive', () => {
    const at = (qqqCost: number) => {
      const { db, trade, close } = book()
      trade(1, 1, '2026-09-01', 'buy', 9, 90_000)
      trade(1, 2, '2026-09-01', 'buy', 1, qqqCost) // never priced: at cost
      close(1, '2026-09-21', 10_000)
      return twr(db, 'inv:1:twr')
    }
    expect(at(10_000)).toEqual({ series: expect.objectContaining({ points: [{ t: '2026-09', v: 1_000_000, est: true }] }), warnings: [] })
    expect(at(10_001).series.points).toEqual([{ t: '2026-09', v: null }])
    expect(at(10_001).warnings).toHaveLength(1)
  })

  it('a holding joins from its first priced month end: the jump from cost to its first quote is not a return (est until then)', () => {
    const { db, trade, close } = book()
    trade(1, 1, '2026-01-05', 'buy', 100, 1_000_000)
    for (const [on, c] of VTI_CLOSES) close(1, on, c)
    trade(1, 2, '2026-03-10', 'buy', 1, 10_000) // QQQ: at cost until its first quote in May, which doubles it
    close(2, '2026-05-29', 20_000)
    close(2, '2026-06-30', 22_000)
    const vti = twr(db, 'pos:1:twr').series.points
    const acct = twr(db, 'inv:1:twr')
    expect(acct.warnings).toEqual([])
    const byMonth = new Map(acct.series.points.map((p) => [p.t, p]))
    // March–May leave QQQ out (at cost at one end or the other): VTI's index alone, marked est.
    for (const t of ['2026-03', '2026-04', '2026-05']) {
      expect(byMonth.get(t)!.est, t).toBe(true)
      expect(byMonth.get(t)!.v, t).toBe(vti.find((p) => p.t === t)!.v)
    }
    // June counts QQQ's +10% alongside VTI's flat month.
    expect(byMonth.get('2026-06')).toEqual({ t: '2026-06', v: Math.round((1_149_500 * (1_149_500 + 22_000)) / (1_149_500 + 20_000)) })
    expect(byMonth.get('2026-02')!.est).toBeUndefined()
  })

  it('sales count only the shares that left the lots', () => {
    const { db, trade, close } = book()
    trade(1, 1, '2026-01-05', 'buy', 10, 100_000)
    // Shares Scarab never held (explicit basis), and a sale of more than is held: flat prices, so neither may read as a gain.
    trade(1, 1, '2026-02-10', 'sell', 5, 50_000, { acquired: '2019-05-01', basis: 20_000 })
    trade(1, 1, '2026-03-10', 'sell', 15, 150_000)
    for (const m of ['01-30', '02-27', '03-31', '09-21']) close(1, `2026-${m}`, 10_000)
    expect(twr(db, 'pos:1:twr').series.points.map((p) => p.v)).toEqual(Array(9).fill(1_000_000))
  })

  it('a starting position enters at its market value on the as-of day, not at its historical cost', () => {
    const { db, trade, close } = book()
    close(1, '2026-01-30', 30_000)
    close(1, '2026-02-27', 31_500)
    close(1, '2026-03-31', 33_075)
    // Bought for $100 a share in 2015 and recorded as of Feb 2, when a close from Jan 30 (3 days old) prices it.
    trade(1, 1, '2026-02-02', 'buy', 10, 100_000, { acquired: '2015-03-01', note: OPENING_NOTE })
    expect(twr(db, 'pos:1:twr').series.points.slice(0, 2)).toEqual([
      { t: '2026-02', v: 1_050_000 }, // $3,000 → $3,150, not $1,000 → $3,150
      { t: '2026-03', v: 1_102_500 },
    ])
    // A back-dated buy (acquired before it was recorded) is booked the same way.
    const other = book()
    for (const [on, c] of [['2026-01-30', 30_000], ['2026-02-27', 31_500], ['2026-03-31', 33_075]] as const) other.close(1, on, c)
    other.trade(1, 1, '2026-02-02', 'buy', 10, 100_000, { acquired: '2015-03-01' })
    expect(twr(other.db, 'pos:1:twr').series.points).toEqual(twr(db, 'pos:1:twr').series.points)

    // Recorded as of Feb 20: the last close is three weeks old, so February can't be measured for it.
    const late = book()
    for (const [on, c] of [['2026-01-30', 30_000], ['2026-02-27', 31_500], ['2026-03-31', 33_075]] as const) late.close(1, on, c)
    late.trade(1, 1, '2026-02-20', 'buy', 10, 100_000, { acquired: '2015-03-01', note: OPENING_NOTE })
    expect(twr(late.db, 'pos:1:twr').warnings).toHaveLength(1) // February is an eighth of the value, and most of it is flat carry
    expect(twr(late.db, 'pos:1:twr', { to: '2026-03', from: '2026-03' }).series.points).toEqual([{ t: '2026-03', v: 1_050_000 }])
    expect(twr(late.db, 'pos:1:twr', { from: '2026-02', to: '2026-02' }).series.points).toEqual([{ t: '2026-02', v: null }])
  })

  it('the index does not depend on the window, only whether it is shown does', () => {
    const { db, trade, close } = book()
    trade(1, 1, '2026-01-05', 'buy', 10, 100_000)
    for (const [on, c] of VTI_CLOSES) close(1, on, c)
    const full = twr(db, 'pos:1:twr').series.points
    expect(twr(db, 'pos:1:twr', { from: '2026-03', to: '2026-05' }).series.points).toEqual(full.filter((p) => p.t >= '2026-03' && p.t <= '2026-05'))
  })

  it('labels accounts "securities only" until brokerage cash is tracked; a balance account has none', () => {
    const db = seeded()
    const of = new Map(getSeriesCatalog(db, TODAY).entries.map((e) => [e.id, e]))
    expect(of.get('inv:all:twr')).toMatchObject({ group: 'Accounts', unit: 'index_micro', kind: 'level', label: 'Portfolio · time-weighted return (securities only)' })
    expect(of.get('inv:1:twr')).toMatchObject({ group: 'Accounts', label: 'Taxable · time-weighted return (securities only)' })
    expect(of.get('pos:1:twr')).toMatchObject({ group: 'Holdings', label: 'VTI · time-weighted return' })
    expect(of.has('inv:3:twr')).toBe(false)
    expect(getSeries(db, TODAY, { ids: ['inv:3:twr', 'set:1+2:twr'] })).toMatchObject({
      series: [{ id: 'set:1+2:twr', label: 'VTI + QQQ · time-weighted return' }],
      warnings: [
        'inv:3:twr: 401(k) tracks a balance, not trades, so it has no time-weighted return',
        expect.stringMatching(/^set:1\+2:twr: only \d+% of the value/),
      ],
    })
    // Deleted: unknown, like the value.
    deleteInvestAccount(db, 1)
    expect(getSeries(db, TODAY, { ids: ['inv:1:twr', 'pos:1:twr'] }).warnings).toEqual(['unknown series: inv:1:twr', 'unknown series: pos:1:twr'])
  })
})

/* ---------- benchmarks (A6): bench:<SYMBOL> ---------- */

describe('series: benchmarks (bench:<SYMBOL>)', () => {
  it("indexes a held symbol's closes to 100 at its first month, with the valuation cutoffs", () => {
    const db = seeded()
    const vti = one(db, 'bench:VTI')
    expect(vti).toMatchObject({ label: 'US total market (VTI)', unit: 'index_micro', kind: 'level' })
    expect(values(vti)).toEqual({
      '2026-03': 1_000_000, '2026-04': 1_000_000, '2026-05': 1_000_000,
      '2026-06': 1_119_048, '2026-07': 1_119_048, '2026-08': 1_119_048, // 23,500 / 21,000
      '2026-09': 1_180_952, // 24,800 / 21,000
    })
    // A daily close wins its day over a quote, and fills a month the quote table skipped.
    db.prepare("INSERT INTO prices_daily (asset_id, priced_on, close_cents) VALUES (1, '2026-06-30', 23_100), (1, '2026-05-28', 22_050)").run()
    expect(values(one(db, 'bench:VTI'))).toMatchObject({ '2026-05': 1_050_000, '2026-06': 1_100_000 })
  })

  it('reads the market history handed to it, merged under the household’s own rows', () => {
    const db = seeded()
    const market: MarketHistory = {
      closes: (s) =>
        s === 'SPY'
          ? [{ on: '2026-01-30', cents: 50_000 }, { on: '2026-06-30', cents: 55_000 }, { on: '2026-07-31', cents: 0 }, { on: 'soon', cents: 60_000 }]
          : s === 'VTI'
            ? [{ on: '2025-12-31', cents: 20_000 }, { on: '2026-03-31', cents: 99_999 }]
            : null,
    }
    const r = getSeries(db, TODAY, { ids: ['bench:SPY', 'bench:VTI'], market })
    expect(r.warnings).toEqual([])
    const [spy, vti] = r.series
    expect(spy!.label).toBe('S&P 500 (SPY)')
    expect(values(spy!)).toEqual({
      '2026-01': 1_000_000, '2026-02': 1_000_000, '2026-03': 1_000_000, '2026-04': 1_000_000, '2026-05': 1_000_000,
      '2026-06': 1_100_000, '2026-07': 1_100_000, '2026-08': 1_100_000, '2026-09': 1_100_000, // malformed rows ignored
    })
    // The market history reaches back further; the household's own March close wins its day.
    expect(values(vti!)).toMatchObject({ '2025-12': 1_000_000, '2026-03': 1_050_000, '2026-09': 1_240_000 })
    const catalog = new Map(getSeriesCatalog(db, TODAY, { market }).entries.map((e) => [e.id, e]))
    expect(catalog.get('bench:SPY')).toMatchObject({ available: true, firstMonth: '2026-01', lastMonth: '2026-09', group: 'Benchmarks' })
    expect(catalog.get('bench:AGG')).toMatchObject({ available: false, reason: 'No price history for AGG yet' })
    // Without it, SPY has nothing here: greyed out, and an empty series (not an error).
    expect(new Map(getSeriesCatalog(db, TODAY).entries.map((e) => [e.id, e])).get('bench:SPY')!.available).toBe(false)
    expect(getSeries(db, TODAY, { ids: ['bench:SPY'] })).toEqual({
      series: [{ id: 'bench:SPY', label: 'S&P 500 (SPY)', unit: 'index_micro', kind: 'level', points: [] }],
      warnings: [],
    })
  })

  it('says why a benchmark is empty while the shared history is still being built', () => {
    const db = seeded()
    const marketPending = 'The server is still building the market history (40% done)'
    const catalog = new Map(getSeriesCatalog(db, TODAY, { marketPending }).entries.map((e) => [e.id, e]))
    expect(catalog.get('bench:SPY')).toMatchObject({ available: false, reason: marketPending })
    expect(catalog.get('bench:VTI')).toMatchObject({ available: true }) // held: its own prices draw it anyway
    expect(catalog.get('bench:VTI')!.reason).toBeUndefined()
    const r = getSeries(db, TODAY, { ids: ['bench:SPY', 'bench:VTI'], marketPending })
    expect(r.warnings).toEqual([`bench:SPY: ${marketPending}`])
    expect(r.series.map((s) => [s.id, s.points.length > 0])).toEqual([
      ['bench:SPY', false],
      ['bench:VTI', true],
    ])
    // A market history that has the symbol wins over a stale reason.
    const market: MarketHistory = { closes: (s) => (s === 'SPY' ? [{ on: '2026-08-31', cents: 60_000 }] : null) }
    expect(getSeries(db, TODAY, { ids: ['bench:SPY'], market, marketPending }).warnings).toEqual([])
  })

  it('asks the market history for the kind it means: the coin the household holds, else the catalog’s kind', () => {
    const db = seeded() // holds BTC the coin
    const asked: [string, string | undefined][] = []
    const market: MarketHistory = {
      closes: (s, kind) => {
        asked.push([s, kind])
        return kind === 'crypto' ? [{ on: '2026-08-31', cents: 6_000_000 }] : [{ on: '2026-08-31', cents: 4_000 }]
      },
    }
    getSeries(db, TODAY, { ids: ['bench:BTC', 'bench:VTI', 'bench:ETH', 'bench:ZZZ'], market })
    expect(asked).toEqual([
      ['BTC', 'crypto'], // held as a coin
      ['VTI', 'stock'], // held as a stock
      ['ETH', undefined], // neither held nor in the catalog: the market history decides
      ['ZZZ', undefined],
    ])
    asked.length = 0
    getSeries(mem(), TODAY, { ids: ['bench:BTC', 'bench:SPY'], market }) // nothing held: the catalog's kinds
    expect(asked).toEqual([
      ['BTC', 'crypto'],
      ['SPY', 'stock'],
    ])
  })

  it('spells symbols the market way: BRK-B finds a BRK.B holding; any symbol can be asked for', () => {
    const { db, trade, close } = book()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('BRK.B', 'stock')").run() // 3
    trade(1, 3, '2026-08-03', 'buy', 1, 40_000)
    close(3, '2026-08-31', 40_000)
    close(3, '2026-09-21', 42_000)
    expect(one(db, 'bench:BRK-B')).toMatchObject({ label: 'BRK-B', points: [{ t: '2026-08', v: 1_000_000 }, { t: '2026-09', v: 1_050_000 }] })
    expect(getSeries(db, TODAY, { ids: ['bench:BRK.B'] }).warnings).toEqual(['unknown series: bench:BRK.B'])
  })

  it('a holding bought at a close tracks its own benchmark exactly', () => {
    const { db, trade, close } = book()
    trade(1, 1, '2026-01-30', 'buy', 10, 110_000) // at January's close
    for (const [on, c] of VTI_CLOSES) close(1, on, c)
    const mine = twr(db, 'pos:1:twr').series.points
    expect(mine.map((p) => p.v)).toEqual(one(db, 'bench:VTI').points.map((p) => p.v))
    expect(mine.at(-1)!.v).toBe(1_090_909) // 12,000 / 11,000
  })
})

/* ---------- saved views ---------- */

const view = (over: Record<string, unknown> = {}) => ({ id: 'v1', name: 'Stocks vs house', ids: ['pos:1:value', 'prop:1:value'], mode: 'rebased', ...over })
const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

describe('saved chart views', () => {
  it('stores the whole list, stamping new views with who saved them and when', () => {
    const db = mem()
    expect(getChartViews(db)).toEqual([])
    const saved = putChartViews(db, [view({ by: 'forged@x', created_at: '1999-01-01', extra: 1 }), view({ id: 'v2', name: ' Net ', ids: ['nw:total'], mode: 'value', from: '2026-01', to: null })], {
      by: 'max@example.com',
      now: '2026-09-22T10:00:00.000Z',
    })
    expect(saved).toEqual([
      { id: 'v1', name: 'Stocks vs house', ids: ['pos:1:value', 'prop:1:value'], mode: 'rebased', by: 'max@example.com', created_at: '2026-09-22T10:00:00.000Z' },
      { id: 'v2', name: 'Net', ids: ['nw:total'], mode: 'value', from: '2026-01', by: 'max@example.com', created_at: '2026-09-22T10:00:00.000Z' },
    ])
    expect(getChartViews(db)).toEqual(saved)

    // Nicole renames one and adds another: v1 keeps Max's stamp.
    const next = putChartViews(db, [view({ name: 'Renamed' }), view({ id: 'v3', ids: ['set:1+2:value', 'bench:^GSPC'], mode: 'diff' })], {
      by: 'nicole@example.com',
      now: '2026-09-23T08:00:00.000Z',
    })
    expect(next.map((v) => [v.id, v.name, v.by, v.created_at])).toEqual([
      ['v1', 'Renamed', 'max@example.com', '2026-09-22T10:00:00.000Z'],
      ['v3', 'Stocks vs house', 'nicole@example.com', '2026-09-23T08:00:00.000Z'],
    ])
    // A tab with no identity saves as null.
    expect(putChartViews(db, [view({ id: 'v4' })], { by: null, now: 'x' })[0]!.by).toBeNull()
  })

  it('an unchanged list writes nothing (never dirties a vault session); an empty one removes the key', () => {
    const db = mem()
    putChartViews(db, [view()], { by: 'a', now: 't0' })
    const before = changes(db)
    putChartViews(db, [view({ by: 'someone else' })], { by: 'b', now: 't1' })
    expect(changes(db)).toBe(before)
    expect(getChartViews(db)[0]).toMatchObject({ by: 'a', created_at: 't0' })

    putChartViews(db, [], { by: 'a', now: 't2' })
    expect(db.prepare('SELECT count(*) AS n FROM app_meta WHERE key = ?').get(CHART_VIEWS_KEY)).toEqual({ n: 0 })
    const cleared = changes(db)
    putChartViews(db, [], { by: 'a', now: 't3' })
    expect(changes(db)).toBe(cleared)
  })

  it('refuses a malformed list with a 400, before writing anything', () => {
    const db = mem()
    putChartViews(db, [view()], { by: 'a', now: 't0' })
    const before = changes(db)
    const bad = [
      {},
      null,
      'x',
      [null],
      [view({ id: 'has space' })],
      [view({ id: '' })],
      [view({ name: '   ' })],
      [view({ name: 'x'.repeat(81) })],
      [view({ ids: [] })],
      [view({ ids: ['nw total'] })],
      [view({ ids: ['nw:total,nw:cash'] })],
      [view({ ids: [42] })],
      [view({ ids: ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'a:7'] })],
      [view({ mode: 'log' })],
      [view({ from: '2026-13' })],
      [view({ from: '2026-06', to: '2026-05' })],
      [view(), view()],
      Array.from({ length: 51 }, (_, i) => view({ id: `v${i}` })),
    ]
    for (const body of bad) expect(status(() => putChartViews(db, body, { by: 'b', now: 't1' })), JSON.stringify(body)?.slice(0, 60)).toBe(400)
    expect(changes(db)).toBe(before)
    expect(getChartViews(db)).toHaveLength(1)
  })

  it('reads a damaged stored list as far as it can', () => {
    const db = mem()
    const put = (v: string) => db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)').run(CHART_VIEWS_KEY, v)
    put('not json')
    expect(getChartViews(db)).toEqual([])
    put('{"a":1}')
    expect(getChartViews(db)).toEqual([])
    put(JSON.stringify([{ ...view(), by: null, created_at: 't' }, { ...view({ id: 'v2' }), created_at: 't' }, { ...view({ id: 'v3', mode: 'x' }), by: 'a', created_at: 't' }]))
    expect(getChartViews(db).map((v) => v.id)).toEqual(['v1'])
  })
})

/* ---------- holdings returns (A4) ---------- */

describe('holdings returns', () => {
  it('is money-weighted per holding from its open lots; the rows sum to the portfolio totals', () => {
    const db = seeded()
    const r = getHoldingsReturns(db, TODAY)
    const pf = getPortfolio(db, TODAY)
    expect(r.as_of).toBe(TODAY)
    expect(r.rows.map((x) => x.symbol)).toEqual(pf.positions.map((p) => p.symbol))
    expect(r.totals).toMatchObject({ value_cents: pf.totals.value, cost_cents: pf.totals.cost, unrealized_cents: pf.totals.unrealized })
    expect(r.rows.reduce((s, x) => s + x.value_cents, 0)).toBe(r.totals.value_cents)

    const vti = r.rows.find((x) => x.symbol === 'VTI')!
    // 6 shares left from the Feb 10 buy (cost $1,200), worth $1,488: 224 days, so not annualized.
    expect(vti).toEqual({
      asset_id: 1, symbol: 'VTI', value_cents: 148_800, cost_cents: 120_000, unrealized_cents: 28_800,
      unrealized_micro: 240_000, irr_micro: 240_000, annualized: false, held_days: 224,
      weight_micro: Math.round((148_800 / 986_800) * 1e6), priced: true,
    })
    const qqq = r.rows.find((x) => x.symbol === 'QQQ')!
    expect(qqq).toMatchObject({ irr_micro: 44_444, unrealized_micro: 44_444, annualized: false, held_days: 160, priced: true })
    // BTC has no price: at cost, no rate.
    expect(r.rows.find((x) => x.symbol === 'BTC')).toMatchObject({
      value_cents: 650_000, cost_cents: 650_000, unrealized_cents: 0, unrealized_micro: null, irr_micro: null, annualized: false, priced: false,
    })
    // The totals' rate covers the priced holdings, over the oldest one's holding period.
    const held = dayNumber(TODAY) - dayNumber('2026-02-10')
    expect(r.totals.irr_micro).toBe(
      xirr([{ day: dayNumber('2026-02-10'), cents: -120_000 }, { day: dayNumber('2026-04-15'), cents: -180_000 }, { day: dayNumber(TODAY), cents: 336_800 }], { basisDays: held }),
    )
    expect(r.totals.annualized).toBe(false)
    expect(r.totals.irr_micro!).toBeGreaterThan(Math.round((36_800 / 300_000) * 1e6)) // the later dollars had less time
  })

  it('annualizes once the oldest open lot is a year old', () => {
    const db = mem()
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Roth', 'retirement', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('BND', 'stock')").run()
    const trade = db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, ?, ?, 'buy', ?, ?)")
    trade.run(1, 1, '2024-09-22', 1_000_000, 100_000) // two years ago
    trade.run(2, 2, '2025-09-22', 1_000_000, 100_000) // exactly 365 days ago
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-21', 121_000), (2, '2026-09-21', 105_000)").run()
    const r = getHoldingsReturns(db, TODAY)
    expect(r.rows.find((x) => x.symbol === 'VTI')).toMatchObject({ held_days: 730, annualized: true, irr_micro: 100_000, unrealized_micro: 210_000 })
    expect(r.rows.find((x) => x.symbol === 'BND')).toMatchObject({ held_days: 365, annualized: true, irr_micro: 50_000 })
    expect(r.totals.annualized).toBe(true)
    expect(r.totals.irr_micro!).toBeGreaterThan(50_000)
    expect(r.totals.irr_micro!).toBeLessThan(100_000)
  })

  it('pools one symbol across accounts; bought today it is simply value against cost; empty is empty', () => {
    const db = mem()
    expect(getHoldingsReturns(db, TODAY)).toEqual({
      as_of: TODAY,
      rows: [],
      totals: { value_cents: 0, cost_cents: 0, unrealized_cents: 0, irr_micro: null, annualized: false },
    })
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('A', 'brokerage', 'lots'), ('B', 'retirement', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock')").run()
    const trade = db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, 1, ?, 'buy', 1000000, 100000)")
    trade.run(1, TODAY)
    trade.run(2, TODAY)
    db.prepare(`INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '${TODAY}', 101000)`).run()
    const r = getHoldingsReturns(db, TODAY)
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({ value_cents: 202_000, cost_cents: 200_000, held_days: 0, irr_micro: 10_000, annualized: false, weight_micro: 1_000_000 })
    expect(r.totals.irr_micro).toBe(10_000)
  })

  it('a starting position without its acquisition date enters at market value on its as-of day, not as a windfall', () => {
    const db = mem()
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock'), ('AAPL', 'stock'), ('ZZZ', 'stock'), ('NEW', 'stock')").run()
    const trade = db.prepare(
      "INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, note, acquired_on) VALUES (1, ?, ?, 'buy', ?, ?, ?, ?)",
    )
    // VTI: pasted as of Jun 1 with a $1,000 basis paid long ago; $300 a share (10 shares = $3,000) that week, $330 now.
    trade.run(1, '2026-06-01', 10_000_000, 100_000, OPENING_NOTE, null)
    // AAPL: pasted with its true acquisition date, so its historical cost on that date is a real flow.
    trade.run(2, '2026-06-01', 1_000_000, 10_000, OPENING_NOTE, '2021-09-22')
    // ZZZ: pasted as of Jun 1, but no close within a week of it: no rate.
    trade.run(3, '2026-06-01', 1_000_000, 5_000, OPENING_NOTE, null)
    // NEW: pasted today, so it enters at today's price.
    trade.run(4, TODAY, 2_000_000, 1_000, OPENING_NOTE, null)
    db.prepare(
      `INSERT INTO prices (asset_id, priced_on, close_cents) VALUES
        (1, '2026-05-29', 30_000), (1, '${TODAY}', 33_000),
        (2, '${TODAY}', 20_000),
        (3, '2026-05-20', 7_000), (3, '${TODAY}', 8_000),
        (4, '${TODAY}', 5_000)`.replace(/(\d)_(\d)/g, '$1$2'),
    ).run()
    const r = getHoldingsReturns(db, TODAY)
    const row = (s: string) => r.rows.find((x) => x.symbol === s)!
    const heldVti = dayNumber(TODAY) - dayNumber('2026-06-01')
    // $3,000 in on Jun 1 → $3,300 today: 10% over the holding period (the old reading was +230%).
    expect(row('VTI')).toMatchObject({ value_cents: 330_000, cost_cents: 100_000, unrealized_micro: 2_300_000, irr_micro: 100_000, annualized: false, held_days: heldVti })
    // Cost basis and unrealized gain stay the portfolio's: only the rate's entry flow changes.
    expect(r.totals).toMatchObject(pick(getPortfolio(db, TODAY).totals))
    // $100 on 2021-09-22 → $200 today, five years: annualized from the true date.
    expect(row('AAPL')).toMatchObject({ annualized: true, held_days: dayNumber(TODAY) - dayNumber('2021-09-22') })
    expect(row('AAPL').irr_micro).toBe(xirr([{ day: dayNumber('2021-09-22'), cents: -10_000 }, { day: dayNumber(TODAY), cents: 20_000 }]))
    // The close before Jun 1 is 12 days old: the entry can't be priced, so no rate — and it is left out of the totals' rate.
    expect(row('ZZZ')).toMatchObject({ priced: true, irr_micro: null, annualized: false, value_cents: 8_000 })
    // Booked today at today's price: nothing earned yet.
    expect(row('NEW')).toMatchObject({ held_days: 0, irr_micro: 0, unrealized_micro: 9_000_000 })
    expect(r.totals.irr_micro).toBe(
      xirr([
        { day: dayNumber('2026-06-01'), cents: -300_000 },
        { day: dayNumber('2021-09-22'), cents: -10_000 },
        { day: dayNumber(TODAY), cents: -10_000 },
        { day: dayNumber(TODAY), cents: 330_000 + 20_000 + 10_000 },
      ]),
    )
    expect(r.totals.annualized).toBe(true)
  })
})

const pick = (t: { value: number; cost: number; unrealized: number }) => ({ value_cents: t.value, cost_cents: t.cost, unrealized_cents: t.unrealized })
