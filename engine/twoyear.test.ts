import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { createPaySource } from './paychecks'
import { putTaxSettings } from './tax'
import { onBothEngines } from './test/parity'
import { getTwoYear, lossCarry, priceTiming } from './twoyear'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'

/** A Texas household, one earner at $10,000 every two weeks deferring $1,000 a check. */
function household(db: DbLike, deferral = 1_000) {
  putTaxSettings(db, { filingStatus: 'mfj', state: 'TX' })
  createPaySource(db, { earner: 'Max', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(10_000), retirementCents: $(deferral) })
}
/** A taxable sale this year: bought at `cost`, sold for `proceeds`. */
function sale(db: DbLike, boughtOn: string, cost: number, proceeds: number) {
  db.prepare("INSERT OR IGNORE INTO invest_accounts (id, name, kind, tracking) VALUES (1, 'Schwab', 'brokerage', 'lots')").run()
  db.prepare("INSERT OR IGNORE INTO assets (id, symbol, kind) VALUES (1, 'XYZ', 'stock')").run()
  const t = db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, ?, ?, 1000000, ?)")
  t.run(boughtOn, 'buy', $(cost))
  t.run('2026-06-01', 'sell', $(proceeds))
}

describe('loss carryforward', () => {
  it('keeps its character, the $3,000 taken from short-term first (§1212(b))', () => {
    expect(lossCarry(-$(10_000), 0)).toEqual({ st: $(7_000), lt: 0 })
    expect(lossCarry(-$(2_000), -$(5_000))).toEqual({ st: 0, lt: $(4_000) })
    expect(lossCarry($(5_000), -$(20_000))).toEqual({ st: 0, lt: $(12_000) })
    expect(lossCarry($(5_000), -$(4_000))).toEqual({ st: 0, lt: 0 })
    expect(lossCarry(-$(1_000), -$(1_000))).toEqual({ st: 0, lt: 0 })
  })
})

describe('next year', () => {
  it('annualizes the paychecks, capping pre-tax deferrals at the limit', () => {
    const db = mem()
    household(db)
    const v = getTwoYear(db, today)
    expect(v.nextYear.year).toBe(2027)
    // 26 checks: $260,000 gross, $26,000 deferral capped at $24,500
    expect(v.nextYear.wagesCents).toBe($(235_500))
    expect(v.nextYear.tax.totalCents).toBeGreaterThan(0)
  })

  it('carries this year’s capital loss into next year', () => {
    const db = mem()
    household(db)
    sale(db, '2026-01-05', 30_000, 10_000) // a $20,000 short-term loss
    const v = getTwoYear(db, today)
    expect(v.thisYear.stGainCents).toBe(-$(20_000))
    expect(v.nextYear.carryInStCents).toBe($(17_000))
    expect(v.basis.some((x) => x.includes('$17,000 short-term'))).toBe(true)
  })

  it('counts next year’s scheduled vests after this year’s', () => {
    const db = mem()
    household(db)
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking, stock_plan) VALUES ('MS', 'brokerage', 'lots', 1)").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ACME', 'stock')").run()
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-30', ?)").run($(100))
    // 400 shares left, 100 every 3 months from Nov 15: Nov 15 this year, then Feb, May, Aug next year.
    db.prepare(
      "INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on, next_vest_on, vest_every_months, vest_qty_micro) VALUES (1, 1, 400000000, '2026-09-01', '2026-11-15', 3, 100000000)",
    ).run()
    const v = getTwoYear(db, today)
    expect(v.thisYear.rsuCents).toBe($(10_000))
    expect(v.nextYear.rsuCents).toBe($(30_000))
  })
})

describe('now or in January', () => {
  it('a loss taken now offsets this year’s gains; next year it would only meet $3,000 of pay', () => {
    const db = mem()
    household(db)
    sale(db, '2020-01-02', 10_000, 60_000) // a $50,000 long-term gain this year
    const t = priceTiming(db, today, { kind: 'loss', amountCents: $(40_000) })
    expect(t.nowCents.thisYear).toBeLessThan(t.laterCents.thisYear)
    expect(t.nowSavesCents).toBeGreaterThan(0)
  })

  it('a bonus is cheaper in the lower-income year', () => {
    const db = mem()
    household(db)
    sale(db, '2026-01-05', 10_000, 210_000) // $200,000 short-term this year, none planned next
    const t = priceTiming(db, today, { kind: 'bonus', amountCents: $(30_000) })
    expect(t.nowSavesCents).toBeLessThan(0) // January wins
    expect(t.laterCents.total).toBeLessThan(t.nowCents.total)
  })

  it('is the same either way when the years look alike', () => {
    const db = mem()
    household(db, 500) // under the deferral limit
    expect(priceTiming(db, today, { kind: 'conversion', amountCents: $(20_000) }).nowSavesCents).toBe(0)
    // Over it too: this year's projection stops the plan at $24,500 the way next year's does, so the years agree.
    const db2 = mem()
    household(db2)
    const v = getTwoYear(db2, today)
    expect(v.thisYear.wagesCents).toBe($(235_500))
    expect(v.nextYear.wagesCents).toBe(v.thisYear.wagesCents)
    expect(v.nextYear.tax.totalCents).toBe(v.thisYear.tax.totalCents)
    expect(priceTiming(db2, today, { kind: 'conversion', amountCents: $(20_000) }).nowSavesCents).toBe(0)
  })

  it('stops next year’s plans the way this year’s stop: Roth shares the limit, two jobs over it count as wages', () => {
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX' })
    // 26 checks of $600 pre-tax + $600 Roth would be $31,200: the plan stops at $24,500, half of it pre-tax.
    createPaySource(db, { earner: 'Max', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(10_000), retirementCents: $(600), rothCents: $(600) })
    expect(getTwoYear(db, today).nextYear.wagesCents).toBe($(260_000) - $(12_250))
    // A second job deferring $500 a month: $6,000 more, all of it over the limit together — wages after all.
    createPaySource(db, { earner: 'Max', employer: 'Side gig', cadence: 'monthly', paidOn: '2026-09-30', grossCents: $(5_000), retirementCents: $(500) })
    const v = getTwoYear(db, today)
    expect(v.nextYear.wagesCents).toBe($(320_000) - $(12_250) - $(6_000) + $(6_000))
    expect(v.thisYear.wagesCents).toBe(v.nextYear.wagesCents)
  })

  it('validates', () => {
    const db = mem()
    expect(() => priceTiming(db, today, { kind: 'lottery', amountCents: 1 })).toThrow(/kind/)
    expect(() => priceTiming(db, today, { kind: 'bonus', amountCents: 0 })).toThrow(/amountCents/)
  })

  it('reads the same on sql.js', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        household(db)
        sale(db, '2026-01-05', 30_000, 10_000)
      },
      (db) => ({ view: getTwoYear(db, today), timing: priceTiming(db, today, { kind: 'lt-gain', amountCents: $(25_000) }) }),
    )
    expect(browser).toEqual(server)
  })
})
