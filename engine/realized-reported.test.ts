import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { deleteInvestAccount, getPortfolio, listInvestAccounts, updateInvestAccount } from './invest'
import { deleteReportedRealized, listReportedRealized, putReportedRealized } from './realized-reported'
import { dumpDb, loadDump } from './snapshot'
import { computeTax, computeTaxYear, getRealizedReport, putTaxSettings, taxYear } from './tax'
import { getTwoYear } from './twoyear'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'

/** A Texas household on $300k of other income, a lots brokerage (1), a managed strategy tracked by balance (2) and a 401(k) (3). */
function household() {
  const db = mem()
  putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', wagesAnnualCents: $(300_000) })
  const acct = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  acct.run('Schwab', 'brokerage', 'lots')
  acct.run('Flex 250', 'brokerage', 'balance')
  acct.run('401(k)', 'retirement', 'balance')
  return db
}
/** A short-term gain in the lots account this year. */
function stGain(db: DbLike, gain: number) {
  db.prepare("INSERT OR IGNORE INTO assets (id, symbol, kind) VALUES (1, 'XYZ', 'stock')").run()
  const t = db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, ?, ?, 1000000, ?)")
  t.run('2026-02-01', 'buy', $(10_000))
  t.run('2026-06-01', 'sell', $(10_000 + gain))
}

describe('reported realized gains: what can be entered', () => {
  it('takes a year’s figures for a taxable balance account, defaulting the day, and replaces them', () => {
    const db = household()
    const r = putReportedRealized(db, 2, '2026', { stCents: -$(40_000), ltCents: $(1_500) }, today)
    expect(r).toMatchObject({ changed: true, row: { account: 'Flex 250', tax_year: 2026, st_cents: -$(40_000), lt_cents: $(1_500), as_of: today, sheltered: false } })
    expect(putReportedRealized(db, 2, 2026, { stCents: -$(40_000), ltCents: $(1_500), asOf: today }, today).changed).toBe(false)
    putReportedRealized(db, 2, 2026, { stCents: -$(52_000), ltCents: 0, asOf: '2026-09-30' }, today)
    putReportedRealized(db, 2, 2025, { stCents: -$(30_000), ltCents: 0 }, today)
    expect(listReportedRealized(db, { accountId: 2 }).map((x) => [x.tax_year, x.st_cents, x.as_of])).toEqual([
      [2026, -$(52_000), '2026-09-30'],
      [2025, -$(30_000), '2025-12-31'], // a year that has ended runs through Dec 31
    ])
    expect(listInvestAccounts(db).find((a) => a.id === 2)!.counts.reported).toBe(2)
  })

  it('refuses a lots account, a retirement account, bad figures, years and days', () => {
    const db = household()
    const put = (id: number, year: unknown, b: Record<string, unknown>) => () => putReportedRealized(db, id, year, b, today)
    expect(put(1, 2026, { stCents: 0, ltCents: 0 })).toThrow(/tracks trades/)
    expect(put(3, 2026, { stCents: 0, ltCents: 0 })).toThrow(/tax-advantaged/)
    expect(put(9, 2026, { stCents: 0, ltCents: 0 })).toThrow(/no such investment account/)
    expect(put(2, 2027, { stCents: 0, ltCents: 0 })).toThrow(/from 1900 to 2026/)
    expect(put(2, 'x', { stCents: 0, ltCents: 0 })).toThrow(/tax year/)
    expect(put(2, 2026, { stCents: 1.5, ltCents: 0 })).toThrow(/whole number of cents/)
    expect(put(2, 2026, { ltCents: 0 })).toThrow(/stCents/)
    expect(put(2, 2026, { stCents: 0, ltCents: 0, asOf: '2026-10-02' })).toThrow(/through today/)
    expect(put(2, 2026, { stCents: 0, ltCents: 0, asOf: '2025-12-31' })).toThrow(/within 2026/)
    expect(put(2, 2025, { stCents: 0, ltCents: 0, asOf: '2026-01-15' })).toThrow(/within 2025/)
    expect(put(2, 2026, { stCents: 0, ltCents: 0, asOf: '2026-02-30' })).toThrow(/real yyyy-mm-dd/)
    expect(() => deleteReportedRealized(db, 2, 2026, today)).toThrow(/no realized gains reported/)
  })

  it('keeps tracking from switching under them, and goes with the account', () => {
    const db = household()
    putReportedRealized(db, 2, 2026, { stCents: -$(1_000), ltCents: 0 }, today)
    expect(() => updateInvestAccount(db, 2, { tracking: 'lots' })).toThrow(/realized gains reported for 1 year/)
    expect(deleteInvestAccount(db, 2).removed.reported).toBe(1)
    expect(listReportedRealized(db)).toEqual([])
  })

  it('a kind changed to retirement leaves them sheltered: off the bill', () => {
    const db = household()
    putReportedRealized(db, 2, 2026, { stCents: -$(9_000), ltCents: 0 }, today)
    updateInvestAccount(db, 2, { kind: 'retirement' })
    const y = computeTaxYear(db, today)
    expect([y.incomes.realizedStCents, y.incomes.realizedShelteredCents, y.incomes.reported]).toEqual([0, -$(9_000), []])
    expect(getPortfolio(db, today).totals.ytd_sheltered).toBe(-$(9_000))
  })

  it('survives a snapshot round trip, and an older snapshot without the table loads empty', () => {
    const db = household()
    putReportedRealized(db, 2, 2026, { stCents: -$(1_000), ltCents: $(2) }, today)
    const dump = dumpDb(db)
    const other = mem()
    loadDump(other, dump)
    expect(listReportedRealized(other)).toEqual(listReportedRealized(db))
    const { realized_reported: _, ...older } = dump.tables
    loadDump(other, { ...dump, tables: older })
    expect(listReportedRealized(other)).toEqual([])
  })
})

describe('reported realized gains and the carryover on the tax bill', () => {
  it('nets the broker’s loss against recorded gains, exactly as one sale would', () => {
    const db = household()
    stGain(db, 20_000)
    const before = computeTaxYear(db, today).tax.totalCents
    putReportedRealized(db, 2, 2026, { stCents: -$(35_000), ltCents: 0 }, today)
    const y = taxYear(db, today)
    expect(y.out.incomes).toMatchObject({ realizedStCents: -$(15_000), reportedStCents: -$(35_000), reportedLtCents: 0 })
    expect(y.out.tax).toMatchObject({ capLossUsedCents: $(3_000), capLossCarryCents: $(12_000) })
    expect(y.out.tax.totalCents).toBeLessThan(before)
    // The same picture as computing it by hand.
    expect(y.out.tax.totalCents).toBe(computeTax({ ...y.inputs, stGainCents: $(20_000) - $(35_000) }).totalCents)
  })

  it('applies last year’s carryover by character, and only in the year it was entered for', () => {
    const db = household()
    stGain(db, 5_000)
    putTaxSettings(db, { carryInYear: 2026, carryInStCents: $(2_000), carryInLtCents: $(10_000) })
    const y = taxYear(db, today)
    expect([y.inputs.stGainCents, y.inputs.ltGainCents]).toEqual([$(3_000), -$(10_000)])
    expect(y.out.incomes).toMatchObject({ carryInStCents: $(2_000), carryInLtCents: $(10_000) })
    // Short nets against long: the $7,000 net loss takes $3,000 of income and carries $4,000.
    expect(y.out.tax).toMatchObject({ capLossUsedCents: $(3_000), capLossCarryCents: $(4_000) })
    // Next year: the stale carryover no longer applies.
    expect(taxYear(db, '2027-03-01').out.incomes.carryInLtCents).toBe(0)
  })

  it('refuses a carryover without its year', () => {
    const db = household()
    expect(() => putTaxSettings(db, { carryInStCents: $(1_000) })).toThrow(/carryInYear/)
    expect(() => putTaxSettings(db, { carryInYear: 26, carryInStCents: $(1_000) })).toThrow(/carryInYear must be a year/)
    expect(() => putTaxSettings(db, { carryInYear: 2026, carryInStCents: -1 })).toThrow(/non-negative/)
  })

  it('the two-year view carries this year’s whole net loss into next year', () => {
    const db = household()
    putReportedRealized(db, 2, 2026, { stCents: -$(50_000), ltCents: -$(4_000) }, today)
    putTaxSettings(db, { carryInYear: 2026, carryInStCents: 0, carryInLtCents: $(6_000) })
    const v = getTwoYear(db, today)
    // $60,000 of net loss: $3,000 used this year (from short-term first), $57,000 carried in by character.
    expect([v.nextYear.carryInStCents, v.nextYear.carryInLtCents]).toEqual([$(47_000), $(10_000)])
    expect(v.thisYear).toMatchObject({ stGainCents: -$(50_000), ltGainCents: -$(4_000), carryInStCents: 0, carryInLtCents: $(6_000) })
  })

  it('the realized report lists them apart from the lines, nets them in, and offers their years', () => {
    const db = household()
    stGain(db, 1_000)
    putReportedRealized(db, 2, 2024, { stCents: -$(8_000), ltCents: $(500) }, today)
    putReportedRealized(db, 2, 2026, { stCents: -$(5_000), ltCents: 0 }, today)
    const r = getRealizedReport(db, 2026, today)
    expect(r.lines).toHaveLength(1)
    expect(r.reported.map((x) => [x.account, x.st_cents])).toEqual([['Flex 250', -$(5_000)]])
    expect(r.netted).toMatchObject({ capLossUsedCents: $(3_000), capLossCarryCents: $(1_000) })
    expect(r.years).toEqual([2026, 2024])
    expect(getRealizedReport(db, 2024, today)).toMatchObject({ lines: [], reported: [{ st_cents: -$(8_000), lt_cents: $(500) }] })
  })

  it('the household portfolio totals carry this year’s reported part', () => {
    const db = household()
    stGain(db, 1_000)
    putReportedRealized(db, 2, 2026, { stCents: -$(5_000), ltCents: $(700) }, today)
    putReportedRealized(db, 2, 2025, { stCents: -$(9_999), ltCents: 0 }, today)
    expect(getPortfolio(db, today).totals).toMatchObject({ ytd_st: -$(4_000), ytd_lt: $(700), ytd_reported_st: -$(5_000), ytd_reported_lt: $(700) })
  })
})
