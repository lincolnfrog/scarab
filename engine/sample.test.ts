import { describe, expect, it } from 'vitest'
import { monthEndIso } from '../shared/dates'
import { openDb } from '../server/migrations'
import type { MarketHistory } from './analytics'
import { getCheckup } from './checkup'
import type { DbLike } from './db'
import { getUnvested } from './invest'
import { listPaySources } from './paychecks'
import { buildSampleHousehold } from './sample'
import { getNetworth, getPortfolio } from './services'
import { getSetup } from './setup'
import { dumpDb } from './snapshot'
import { onBothEngines } from './test/parity'

const TODAY = '2026-10-22'
const built = (today = TODAY, market?: MarketHistory) => {
  const db = openDb(':memory:') as unknown as DbLike
  buildSampleHousehold(db, today, { market })
  return db
}
const all = <T>(db: DbLike, sql: string) => db.prepare(sql).all() as T[]
const one = <T>(db: DbLike, sql: string) => db.prepare(sql).get() as T

describe('the sample household', () => {
  const db = built()

  it('has what every step of the setup checklist asks for', () => {
    const s = getSetup(db, 'visitor@example.com')
    expect(s.steps.filter((x) => !x.done)).toEqual([])
  })

  it('covers two years, month by month, with nothing dated after today', () => {
    const nw = getNetworth(db, TODAY)
    expect(nw.series.map((p) => p.month)).toHaveLength(25)
    expect(nw.series[0]!.month).toBe('2024-10')
    expect(nw.current!.month).toBe('2026-10')
    for (const p of nw.series) {
      expect(p.cash, `${p.month}: cash on hand`).toBeGreaterThan(0)
      expect(p.brokerage, `${p.month}: the brokerage`).toBeGreaterThan(0)
      expect(p.retirement, `${p.month}: the 401(k) and 403(b)`).toBeGreaterThan(0)
      expect(p.property + p.liabilities, `${p.month}: home equity`).toBeGreaterThan(0)
    }
    // A plausible two-income household: well into seven figures, and growing.
    expect(nw.current!.total).toBeGreaterThan(nw.series[0]!.total)
    expect(nw.current!.total).toBeGreaterThan(100_000_000)
    expect(nw.current!.total).toBeLessThan(250_000_000)
    for (const [table, col] of [
      ['transactions', 'posted_on'],
      ['trades', 'traded_on'],
      ['balance_snapshots', 'balanced_on'],
      ['property_valuations', 'valued_on'],
      ['liability_balances', 'balanced_on'],
      ['prices', 'priced_on'],
    ])
      expect(one<{ d: string }>(db, `SELECT max(${col}) AS d FROM ${table}`).d <= TODAY, `${table}.${col}`).toBe(true)
  })

  it('has two years of bank and card transactions, filed by the seed rules and a few of its own — all but a handful of new ones', () => {
    const rows = all<{ account: string; n: number }>(db, 'SELECT a.name AS account, count(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id GROUP BY a.id ORDER BY a.id')
    expect(rows.map((r) => r.account)).toEqual(['Everyday Checking', 'High-Yield Savings', 'Rewards Visa'])
    expect(rows.reduce((s, r) => s + r.n, 0)).toBeGreaterThan(1_000)
    const loose = all<{ posted_on: string }>(db, 'SELECT posted_on FROM transactions WHERE category_id IS NULL')
    expect(loose.length).toBeGreaterThan(0) // something for the categorizer to show off
    expect(loose.length).toBeLessThan(10)
    expect(loose.every((t) => t.posted_on >= '2026-10-01')).toBe(true)
    // Checking keeps a cushion: its running balance never dips below zero.
    const lows = all<{ low: number }>(
      db,
      `SELECT min(run) AS low FROM (SELECT a.opening_cents + sum(t.amount_cents) OVER (ORDER BY t.posted_on, t.id) AS run
         FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.kind = 'checking')`,
    )
    expect(lows[0]!.low).toBeGreaterThan(0)
    // The card is paid in full each month, and both sides of every payment pair up as transfers.
    const payments = all<{ cat: string }>(db, "SELECT c.name AS cat FROM transactions t JOIN categories c ON c.id = t.category_id WHERE t.description IN ('PAYMENT THANK YOU', 'RWRDS VISA AUTOPAY')")
    expect(payments.length).toBeGreaterThan(40)
    expect(new Set(payments.map((p) => p.cat))).toEqual(new Set(['Transfer']))
  })

  it('pays two earners, one of them partly in RSUs that keep vesting, held in a plan priced by hand', () => {
    expect(listPaySources(db).map((p) => [p.earner, p.cadence])).toEqual([
      ['Alex', 'biweekly'],
      ['Sam', 'semimonthly'],
    ])
    const grants = getUnvested(db).rows
    expect(grants).toHaveLength(2)
    expect(grants.every((g) => g.symbol === 'LRKS' && g.next_vest_on! > TODAY)).toBe(true)
    const p = getPortfolio(db, TODAY)
    expect(p.positions.map((x) => x.symbol).sort()).toEqual(['BND', 'LRKS', 'VTI', 'VXUS'])
    expect(p.positions.find((x) => x.symbol === 'LRKS')!.price_manual).toBe(true) // a made-up company has no quote
    expect(p.totals.ytd_lt).toBeGreaterThan(0) // this year's sale of long-held shares
  })

  it('gives the Checkup something to say', () => {
    const kinds = getCheckup(db, TODAY, 'visitor@example.com').findings.map((f) => f.kind)
    expect(kinds).toEqual(expect.arrayContaining(['concentration', 'allocation-drift', 'price-creep', 'deferral-room']))
  })

  it('is made up: no one’s names, and only example.com addresses', () => {
    const text = JSON.stringify(dumpDb(db))
    expect(text).not.toMatch(/\b(max|nicole)\b/i)
    for (const m of text.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) expect(m[1]).toBe('example.com')
  })

  it('is the same household every time it is built for the same day', () => {
    const facts = (d: DbLike) => all(d, 'SELECT account_id, posted_on, amount_cents, description, category_id FROM transactions ORDER BY id')
    const again = built()
    expect(facts(again)).toEqual(facts(db))
    expect(getNetworth(again, TODAY)).toEqual(getNetworth(db, TODAY))
  })

  it('dates itself back from whatever day it is opened', () => {
    for (const day of ['2027-01-03', '2026-12-31', '2028-02-29', '2031-07-15']) {
      const d = built(day)
      expect(getSetup(d, 'v').done, day).toBe(6)
      expect(getNetworth(d, day).series, day).toHaveLength(25)
    }
  })
})

describe('the sample household’s prices', () => {
  /** A market where every fund closed each month at a distinctive price, through the month of `TODAY`. */
  const market: MarketHistory = {
    closes: (symbol) =>
      ({ VTI: 50_000, VXUS: 9_000, BND: 8_000 })[symbol] === undefined
        ? null
        : Array.from({ length: 40 }, (_, k) => {
            const n = 2024 * 12 + 1 + k // 2024-02 onward
            const month = `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`
            return { on: month === '2026-10' ? '2026-10-21' : monthEndIso(month), cents: ({ VTI: 50_000, VXUS: 9_000, BND: 8_000 } as Record<string, number>)[symbol]! }
          }).filter((c) => c.on <= TODAY),
  }

  it('takes the funds’ month-end closes from the market when the tab has it, and invests at them', () => {
    const db = built(TODAY, market)
    const closes = all<{ on: string; cents: number }>(
      db,
      "SELECT p.priced_on AS \"on\", p.close_cents AS cents FROM prices p JOIN assets a ON a.id = p.asset_id WHERE a.symbol = 'VTI' ORDER BY p.priced_on",
    )
    expect(new Set(closes.map((c) => c.cents))).toEqual(new Set([50_000]))
    expect(closes.at(-1)!.on).toBe('2026-10-21') // the month in progress, as of the market's last close
    const buys = all<{ qty_micro: number; total_cents: number }>(
      db,
      "SELECT t.qty_micro, t.total_cents FROM trades t JOIN assets a ON a.id = t.asset_id WHERE a.symbol = 'VTI' AND t.side = 'buy' AND t.acquired_on IS NULL",
    )
    expect(buys.length).toBeGreaterThan(20)
    for (const b of buys) expect(Math.round((b.total_cents * 1_000_000) / b.qty_micro)).toBe(50_000)
    // The employer's stock is made up: the market never prices it.
    expect(getPortfolio(db, TODAY).positions.find((x) => x.symbol === 'LRKS')!.price_cents).not.toBe(50_000)
  })

  it('prices itself without one, carrying each fund from a plausible level', () => {
    const db = built()
    const vti = one<{ cents: number }>(db, "SELECT p.close_cents AS cents FROM prices p JOIN assets a ON a.id = p.asset_id WHERE a.symbol = 'VTI' ORDER BY p.priced_on DESC LIMIT 1")
    expect(vti.cents).toBeGreaterThan(25_000)
    expect(vti.cents).toBeLessThan(50_000)
  })
})

describe('sample parity: better-sqlite3 vs sql.js', () => {
  it('builds the same household on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => buildSampleHousehold(db, TODAY),
      (db) => ({ nw: getNetworth(db, TODAY), portfolio: getPortfolio(db, TODAY), setup: getSetup(db, 'v') }),
    )
    expect(browser).toEqual(server)
  })
})
