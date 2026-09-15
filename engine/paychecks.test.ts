import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import {
  computePayroll,
  createPaySource,
  deletePaySource,
  listPaySources,
  payDatesAfter,
  payDatesThrough,
  projectPaySource,
  stepPayDate,
  updatePaySource,
  type PaySource,
} from './paychecks'

const $ = (dollars: number) => Math.round(dollars * 100)

const source = (over: Partial<PaySource> = {}): PaySource => ({
  id: 1,
  earner: 'A',
  employer: 'Acme',
  cadence: 'biweekly',
  paidOn: '2026-08-21',
  grossCents: $(5_000),
  retirementCents: $(500),
  benefitsCents: $(200),
  fedWithheldCents: $(900),
  stateWithheldCents: $(300),
  ytdGrossCents: null,
  ytdRetirementCents: null,
  ytdBenefitsCents: null,
  ytdFedWithheldCents: null,
  ytdStateWithheldCents: null,
  investAccountId: null,
  sort: 1,
  ...over,
})

describe('pay calendar', () => {
  it('walks weekly, biweekly and monthly cadences', () => {
    expect(stepPayDate('2026-08-21', 'weekly')).toBe('2026-08-28')
    expect(stepPayDate('2026-08-21', 'biweekly')).toBe('2026-09-04')
    expect(stepPayDate('2026-08-31', 'monthly')).toBe('2026-09-30')
    expect(stepPayDate('2026-08-21', 'biweekly', -1)).toBe('2026-08-07')
    expect(payDatesAfter('2026-08-21', 'biweekly', '2026-12-31')).toHaveLength(9)
    expect(payDatesThrough('2026-08-21', 'biweekly', '2026-01-01')).toHaveLength(17)
    expect(payDatesAfter('2026-08-31', 'monthly', '2026-12-31')).toHaveLength(4)
    expect(payDatesAfter('2026-12-25', 'weekly', '2026-12-31')).toHaveLength(0)
  })
  it('pairs semi-monthly dates as (d, d+15) with month-end meaning the 15th-and-last schedule', () => {
    expect(stepPayDate('2026-08-31', 'semimonthly')).toBe('2026-09-15')
    expect(stepPayDate('2026-09-15', 'semimonthly')).toBe('2026-09-30')
    expect(stepPayDate('2026-02-15', 'semimonthly')).toBe('2026-02-28')
    expect(stepPayDate('2026-02-28', 'semimonthly')).toBe('2026-03-15')
    expect(stepPayDate('2026-12-31', 'semimonthly')).toBe('2027-01-15')
    expect(stepPayDate('2026-01-01', 'semimonthly')).toBe('2026-01-16')
    expect(stepPayDate('2026-01-16', 'semimonthly')).toBe('2026-02-01')
    expect(stepPayDate('2026-03-15', 'semimonthly', -1)).toBe('2026-02-28')
    expect(stepPayDate('2026-01-15', 'semimonthly', -1)).toBe('2025-12-31')
    expect(stepPayDate('2026-01-31', 'semimonthly', -1)).toBe('2026-01-15')
    expect(stepPayDate('2026-02-01', 'semimonthly', -1)).toBe('2026-01-16')
    expect(payDatesAfter('2026-08-31', 'semimonthly', '2026-12-31')).toHaveLength(8)
    expect(payDatesThrough('2026-08-31', 'semimonthly', '2026-01-01')).toHaveLength(16)
  })
})

describe('projecting one stub to Dec 31', () => {
  it('assumes every paycheck matched when the YTD column is blank', () => {
    const p = projectPaySource(source(), 2026)
    expect(p.stale).toBe(false)
    expect(p.ytdEstimated).toBe(true)
    expect(p.periodsElapsed).toBe(17)
    expect(p.periodsRemaining).toBe(9)
    expect(p.ytd.grossCents).toBe($(85_000))
    expect(p.projected.grossCents).toBe($(130_000))
    expect(p.projected.fedWithheldCents).toBe($(23_400))
    expect(p.projected.stateWithheldCents).toBe($(7_800))
    expect(p.projected.taxableWagesCents).toBe($(111_800)) // − 401k − §125
    expect(p.projected.ficaWagesCents).toBe($(124_800)) // − §125 only
  })
  it('anchors on the printed YTD column when given', () => {
    const p = projectPaySource(
      source({ ytdGrossCents: $(90_000), ytdRetirementCents: $(9_000), ytdBenefitsCents: $(3_400), ytdFedWithheldCents: $(17_000), ytdStateWithheldCents: $(5_000) }),
      2026,
    )
    expect(p.ytdEstimated).toBe(false)
    expect(p.projected.grossCents).toBe($(135_000))
    expect(p.projected.fedWithheldCents).toBe($(25_100))
    expect(p.projected.taxableWagesCents).toBe($(135_000) - $(13_500) - $(5_200))
  })
  it('ignores a stub from last year and projects the whole year on its cadence', () => {
    const p = projectPaySource(source({ paidOn: '2025-12-26', ytdGrossCents: $(120_000) }), 2026)
    expect(p.stale).toBe(true)
    expect(p.ytdEstimated).toBe(true)
    expect(p.periodsElapsed).toBe(0)
    expect(p.periodsRemaining).toBe(26)
    expect(p.ytd.grossCents).toBe(0)
    expect(p.projected.grossCents).toBe($(130_000))
  })
})

describe('household payroll taxes', () => {
  const fullYear = (id: number, earner: string, gross: number, over: Partial<PaySource> = {}): PaySource =>
    source({
      id, earner, cadence: 'monthly', paidOn: '2026-12-31',
      grossCents: $(1_000), retirementCents: 0, benefitsCents: 0, fedWithheldCents: 0, stateWithheldCents: 0,
      ytdGrossCents: $(gross), ytdRetirementCents: 0, ytdBenefitsCents: 0, ytdFedWithheldCents: 0, ytdStateWithheldCents: 0,
      ...over,
    })

  it('caps Social Security per person, withholds the Medicare surtax per employer, and owes it per household', () => {
    const rsu = new Map([[1, $(60_000)], [2, $(10_000)]])
    const p = computePayroll(
      [
        fullYear(1, 'A', 190_000, { investAccountId: 1, ytdFedWithheldCents: $(40_000), ytdStateWithheldCents: $(12_000) }),
        fullYear(2, 'B', 150_000, { ytdFedWithheldCents: $(30_000), ytdStateWithheldCents: $(9_000) }),
      ],
      2026,
      rsu,
      $(250_000),
    )
    expect(p.wagesCents).toBe($(340_000))
    expect(p.fedWithheldCents).toBe($(70_000))
    expect(p.stateWithheldCents).toBe($(21_000))
    const a = p.earners.find((e) => e.earner === 'A')!
    expect(a.rsuCents).toBe($(60_000))
    expect(a.ficaWagesCents).toBe($(250_000))
    expect(a.socialSecurityCents).toBe($(11_439)) // 6.2% × $184,500
    expect(a.medicareCents).toBe($(3_625))
    expect(a.addlMedicareWithheldCents).toBe($(450)) // 0.9% × $50k over $200k
    const b = p.earners.find((e) => e.earner === 'B')!
    expect(b.socialSecurityCents).toBe($(9_300))
    expect(b.addlMedicareWithheldCents).toBe(0)
    // unlinked stock comp still counts toward the household surtax base
    expect(p.ficaWagesCents).toBe($(410_000))
    expect(p.addlMedicareCents).toBe($(1_440))
    expect(p.addlMedicareWithheldCents).toBe($(450))
    expect(p.medicareCents).toBe($(3_625) + $(2_175) + $(145))
    expect(p.excessSocialSecurityCents).toBe(0)
  })
  it('credits Social Security withheld past the wage base across two employers', () => {
    const p = computePayroll([fullYear(1, 'C', 120_000), fullYear(2, 'C', 120_000)], 2026, new Map(), $(250_000))
    expect(p.earners).toHaveLength(1)
    expect(p.earners[0]!.socialSecurityWithheldCents).toBe($(14_880))
    expect(p.socialSecurityCents).toBe($(11_439))
    expect(p.excessSocialSecurityCents).toBe($(3_441))
  })
  it('is empty without stubs', () => {
    const p = computePayroll([], 2026, new Map([[1, $(50_000)]]), $(250_000))
    expect(p.addlMedicareCents).toBe(0)
    expect(p.wagesCents).toBe(0)
  })
})

describe('pay source CRUD', () => {
  it('round-trips, defaults the YTD column as a unit, and validates', () => {
    const db = openDb(':memory:') as unknown as DbLike
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Brokerage', 'brokerage', 'lots')").run()
    const a = createPaySource(db, { earner: ' A ', employer: 'Acme', cadence: 'biweekly', paidOn: '2026-08-21', grossCents: $(5_000), fedWithheldCents: $(900), ytdGrossCents: $(90_000), investAccountId: 1 })
    expect(a.earner).toBe('A')
    expect(a.ytdFedWithheldCents).toBe(0) // gross anchors the column; the rest default to 0
    const b = updatePaySource(db, a.id, { ytdGrossCents: null, ytdFedWithheldCents: $(5) })
    expect(b.ytdGrossCents).toBeNull()
    expect(b.ytdFedWithheldCents).toBeNull() // blank gross blanks the column
    expect(b.investAccountId).toBe(1)
    expect(updatePaySource(db, a.id, { investAccountId: null }).investAccountId).toBeNull()
    expect(listPaySources(db)).toHaveLength(1)
    expect(() => createPaySource(db, { earner: '', cadence: 'weekly', paidOn: '2026-01-02', grossCents: 1 })).toThrow('earner')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'daily', paidOn: '2026-01-02', grossCents: 1 })).toThrow('cadence')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'weekly', paidOn: 'Jan 2', grossCents: 1 })).toThrow('paidOn')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'weekly', paidOn: '2026-01-02', grossCents: 0 })).toThrow('positive')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'weekly', paidOn: '2026-01-02', grossCents: 100, retirementCents: 101 })).toThrow('exceed')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'weekly', paidOn: '2026-01-02', grossCents: 100, ytdGrossCents: 50 })).toThrow('year-to-date')
    expect(() => createPaySource(db, { earner: 'X', cadence: 'weekly', paidOn: '2026-01-02', grossCents: 100, investAccountId: 9 })).toThrow('no such')
    expect(() => updatePaySource(db, 99, { grossCents: 1 })).toThrow('no such')
    deletePaySource(db, a.id)
    expect(listPaySources(db)).toHaveLength(0)
    expect(() => deletePaySource(db, a.id)).toThrow('no such')
  })
})
