import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { createAccountFlow } from './account-flows'
import type { DbLike } from './db'
import { accountForecasts, deleteHarvestProfile, forecastLossIn, getHarvestProfile, listHarvestProfiles, lossBetween, lossSchedule, putHarvestProfile } from './harvest'
import { deleteInvestAccount, getInvestAccount, updateInvestAccount } from './invest'
import { putReportedRealized } from './realized-reported'
import { dumpDb, loadDump } from './snapshot'
import { getTwoYear } from './twoyear'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const pct = (p: number) => p * 10_000
const today = '2026-10-11'

/** A lots brokerage (1), a managed strategy tracked by balance (2) and a 401(k) (3). */
function household() {
  const db = mem()
  const acct = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  acct.run('Schwab', 'brokerage', 'lots')
  acct.run('Flex 250', 'brokerage', 'balance')
  acct.run('401(k)', 'retirement', 'balance')
  return db
}

/** The manager's estimate as it arrived: given Aug 31; the rest of 2026, 2027 and 2028 for the standing book; 70/39/25 on new money. */
const ESTIMATE = {
  asOf: '2026-08-31',
  year1Micro: pct(70),
  year2Micro: pct(39),
  laterMicro: pct(25),
  source: 'Manager email, 2026-08-31',
  years: [
    { taxYear: 2026, lossCents: $(350_000) },
    { taxYear: 2027, lossCents: $(670_000) },
    { taxYear: 2028, lossCents: $(540_000) },
  ],
}

describe('the harvest forecast: what can be entered', () => {
  it('takes the estimate for a taxable balance account, sorts its years, and replaces it', () => {
    const db = household()
    const r = putHarvestProfile(db, 2, { ...ESTIMATE, years: [...ESTIMATE.years].reverse(), source: '  Manager email, 2026-08-31 ' }, today)
    expect(r.changed).toBe(true)
    expect(r.profile).toEqual({
      invest_account_id: 2,
      as_of: '2026-08-31',
      year1_micro: pct(70),
      year2_micro: pct(39),
      later_micro: pct(25),
      source: 'Manager email, 2026-08-31',
      years: [
        { tax_year: 2026, loss_cents: $(350_000) },
        { tax_year: 2027, loss_cents: $(670_000) },
        { tax_year: 2028, loss_cents: $(540_000) },
      ],
    })
    expect(putHarvestProfile(db, 2, ESTIMATE, today).changed).toBe(false)
    const again = putHarvestProfile(db, 2, { ...ESTIMATE, years: [{ taxYear: '2027', lossCents: $(700_000) }], source: null }, today)
    expect(again.changed).toBe(true)
    expect(again.profile.years).toEqual([{ tax_year: 2027, loss_cents: $(700_000) }])
    expect(again.profile.source).toBeNull()
    expect(getInvestAccount(db, 2, today).harvest).toEqual(again.profile)
    expect(getInvestAccount(db, 1, today).harvest).toBeNull()
    expect(listHarvestProfiles(db).map((p) => p.account.name)).toEqual(['Flex 250'])
  })

  it('refuses a lots account, a retirement account, a future or bad day, an absurd rate and bad years', () => {
    const db = household()
    const put = (id: number, b: Record<string, unknown>) => () => putHarvestProfile(db, id, { ...ESTIMATE, ...b }, today)
    expect(put(1, {})).toThrow(/tracks trades/)
    expect(put(3, {})).toThrow(/tax-advantaged/)
    expect(put(9, {})).toThrow(/no such investment account/)
    expect(put(2, { asOf: '2026-10-12' })).toThrow(/on or before today/)
    expect(put(2, { asOf: '2026-02-30' })).toThrow(/real yyyy-mm-dd/)
    expect(put(2, { year1Micro: pct(301) })).toThrow(/year1Micro/)
    expect(put(2, { laterMicro: -1 })).toThrow(/laterMicro/)
    expect(put(2, { laterMicro: 0.5 })).toThrow(/laterMicro/)
    expect(put(2, { years: [{ taxYear: 2025, lossCents: 1 }] })).toThrow(/from 2026/)
    expect(put(2, { years: [{ taxYear: 2040, lossCents: 1 }] })).toThrow(/to 2036/)
    expect(put(2, { years: [{ taxYear: 2027, lossCents: -1 }] })).toThrow(/zero or more/)
    expect(put(2, { years: [{ taxYear: 2027, lossCents: 1 }, { taxYear: 2027, lossCents: 2 }] })).toThrow(/listed twice/)
    expect(put(2, { years: Array.from({ length: 11 }, (_, i) => ({ taxYear: 2026 + i, lossCents: 1 })) })).toThrow(/at most 10/)
    expect(put(2, { source: 3 })).toThrow(/source must be text/)
    expect(() => deleteHarvestProfile(db, 2)).toThrow(/no harvest forecast/)
  })

  it('is removed on its own, keeps tracking from switching, and goes with the account', () => {
    const db = household()
    putHarvestProfile(db, 2, ESTIMATE, today)
    expect(() => updateInvestAccount(db, 2, { tracking: 'lots' })).toThrow(/has a harvest forecast/)
    expect(deleteHarvestProfile(db, 2).removed.years).toHaveLength(3)
    expect(getHarvestProfile(db, 2)).toBeNull()
    putHarvestProfile(db, 2, ESTIMATE, today)
    expect(deleteInvestAccount(db, 2).removed.forecast).toBe(1)
    expect(listHarvestProfiles(db)).toEqual([])
  })

  it('survives a snapshot round trip', () => {
    const db = household()
    putHarvestProfile(db, 2, ESTIMATE, today)
    const other = mem()
    loadDump(other, dumpDb(db))
    expect(getHarvestProfile(other, 2)).toEqual(getHarvestProfile(db, 2))
  })
})

describe('the schedule', () => {
  const profile = {
    as_of: '2026-08-31',
    year1_micro: pct(70),
    year2_micro: pct(39),
    later_micro: pct(25),
    years: [
      { tax_year: 2026, loss_cents: $(350_000) },
      { tax_year: 2027, loss_cents: $(670_000) },
      { tax_year: 2028, loss_cents: $(540_000) },
    ],
  }

  it('spreads each figure over its days: a stated year whole, a deposit by its age, the standing book extrapolated', () => {
    const { windows, notes } = lossSchedule({
      profile,
      flows: [
        { flowed_on: '2026-04-01', amount_cents: $(1_500_000) }, // before the estimate: already in its figures
        { flowed_on: '2026-09-15', amount_cents: $(200_000) },
        { flowed_on: '2027-06-01', amount_cents: -$(50_000) }, // a withdrawal: ignored
        { flowed_on: '2027-01-05', amount_cents: $(1_600_000) }, // planned
      ],
      balanceCents: $(2_000_000),
      throughYear: 2029,
    })
    expect(windows).toEqual([
      { from: '2026-08-31', through: '2026-12-31', cents: $(350_000), what: 'stated' },
      { from: '2027-01-01', through: '2027-12-31', cents: $(670_000), what: 'stated' },
      { from: '2028-01-01', through: '2028-12-31', cents: $(540_000), what: 'stated' },
      { from: '2029-01-01', through: '2029-12-31', cents: $(500_000), what: 'extrapolated' },
      { from: '2026-09-15', through: '2027-09-14', cents: $(140_000), what: 'deposit' },
      { from: '2027-09-15', through: '2028-09-14', cents: $(78_000), what: 'deposit' },
      { from: '2028-09-15', through: '2029-09-14', cents: $(50_000), what: 'deposit' },
      { from: '2029-09-15', through: '2030-09-14', cents: $(50_000), what: 'deposit' },
      { from: '2027-01-05', through: '2028-01-04', cents: $(1_120_000), what: 'deposit' },
      { from: '2028-01-05', through: '2029-01-04', cents: $(624_000), what: 'deposit' },
      { from: '2029-01-05', through: '2030-01-04', cents: $(400_000), what: 'deposit' },
    ])
    expect(notes).toEqual([
      'No figure for 2029: the standing book is taken at the later rate on its balance as of the estimate.',
      '1 deposit on or before the estimate\'s day is already in the manager\'s figures.',
      '1 withdrawal recorded; a withdrawal doesn\'t reduce the forecast.',
    ])
  })

  it('without a balance, says what it can’t fill in', () => {
    const { windows, notes } = lossSchedule({ profile: { ...profile, years: [] }, flows: [], balanceCents: null, throughYear: 2027 })
    expect(windows).toEqual([])
    expect(notes[0]).toMatch(/No figure for 2026, 2027 and no balance recorded/)
  })

  it('integrates by day: a whole window is its figure, part of one its share', () => {
    const w = [{ from: '2027-01-01', through: '2027-12-31', cents: 36_500, what: 'stated' as const }]
    expect(lossBetween(w, '2026-12-31', '2027-12-31')).toBe(36_500)
    expect(lossBetween(w, '2027-03-31', '2027-04-30')).toBe(3_000) // 30 days at $1 a day
    expect(lossBetween(w, '2027-12-31', '2028-12-31')).toBe(0)
    expect(lossBetween(w, '2026-01-01', '2026-12-31')).toBe(0)
    expect(lossBetween(w, '2027-06-30', '2027-06-30')).toBe(0)
    const d = [{ from: '2026-09-15', through: '2027-09-14', cents: 70_000, what: 'deposit' as const }]
    expect(lossBetween(d, '2026-09-14', '2026-09-15')).toBe(192) // one day of 365
    expect(lossBetween(d, '2026-01-01', '2028-01-01')).toBe(70_000)
  })
})

describe('per account, against the ledger', () => {
  function managed() {
    const db = household()
    db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (2, '2026-08-31', ?)").run($(2_000_000))
    putHarvestProfile(db, 2, ESTIMATE, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_500_000) }, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-09-15', amountCents: $(200_000) }, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2027-01-05', amountCents: $(1_600_000) }, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2027-06-01', amountCents: -$(50_000) }, today)
    putReportedRealized(db, 2, 2026, { stCents: -$(500_000), ltCents: 0, asOf: '2026-09-18' }, today)
    return db
  }

  it('takes over the day after the broker’s figure, and expects each later year whole', () => {
    const db = managed()
    const [f] = accountForecasts(db, today, 2028)
    expect(f).toMatchObject({ account: 'Flex 250', reported: { cents: -$(500_000), asOf: '2026-09-18' }, from: '2026-09-18', balanceCents: $(2_000_000), balanceOn: '2026-08-31' })
    // Checked against an independent day-by-day calculation (python): the rest of 2026 after Sept 18, then 2027 and 2028 whole.
    expect(f!.byYear).toEqual([
      { year: 2026, cents: 33_582_537 },
      { year: 2027, cents: 189_931_776 },
      { year: 2028, cents: 123_923_243 },
    ])
    expect(forecastLossIn([f!], 2027)).toBe(189_931_776)
    expect(forecastLossIn([f!], 2030)).toBe(0)
  })

  it('without a broker figure, starts at the estimate’s day; a retirement account is left out', () => {
    const db = managed()
    db.prepare('DELETE FROM realized_reported').run()
    const [f] = accountForecasts(db, today, 2027)
    expect(f!.reported).toBeNull()
    expect(f!.from).toBe('2026-08-31')
    expect(f!.byYear[0]!.cents).toBeGreaterThan(33_582_537) // more of 2026 ahead
    updateInvestAccount(db, 2, { kind: 'retirement' })
    expect(accountForecasts(db, today, 2027)).toEqual([])
  })

  it('reaches the two-year view: next year carries the planned deposit’s harvest and the standing book', () => {
    const db = managed()
    const v = getTwoYear(db, today)
    expect(v.thisYear.forecastLossCents).toBe(33_582_537)
    expect(v.nextYear.forecastLossCents).toBe(189_931_776)
    expect(v.nextYear.stGainCents).toBe(0) // the plan is its own line
    expect(v.basis.find((b) => b.startsWith('2027:'))).toMatch(/\$1,899,318 of further losses expected from Flex 250 — the manager’s estimate/)
    expect(v.basis.find((b) => b.startsWith('2026:'))).toMatch(/over the rest of the year/)
  })
})
