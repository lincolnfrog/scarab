import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { bucketOf, resolveBuckets } from './buckets'
import type { DbLike } from './db'
import { createPaySource } from './paychecks'
import { putPeople } from './people'
import { compareScenarios, defaultParams, listScenarios, normalizeParams, resolveTaxContext, toSimTax, updateScenario } from './scenarios'
import { claimFactorMicro, makeYearTax, rmdStartAge, taxableSocialSecurity, uniformLifetimePeriod } from './simtax'
import { simulate, type SimParams, type SimTax } from './simulate'
import { putTaxSettings } from './tax'
import { onBothEngines } from './test/parity'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'

/** Deterministic: no volatility, so every path is the same and medians are exact. */
const PLAN: SimParams = {
  startYear: 2026,
  endYear: 2070,
  liquidCents: $(2_000_000),
  propertyCents: 0,
  liabilitiesCents: 0,
  meanReturnMicro: 40_000,
  volMicro: 0,
  propertyGrowthMicro: 0,
  saveBeforeBuyCents: 0,
  saveAfterBuyCents: 0,
  buy: null,
  retireYear: 2030,
  retireSpendCents: $(100_000),
  paths: 20,
  seed: 3,
}
const TAX: SimTax = {
  taxableCents: $(1_000_000),
  taxableBasisCents: $(600_000),
  traditionalCents: $(1_000_000),
  rothCents: 0,
  traditionalSaveCents: 0,
  rothSaveCents: 0,
  filing: 'mfj',
  state: { state: 'TX', filingStatus: 'mfj', customStateRateMicro: 0 },
  workingOrdinaryCents: $(250_000),
  order: 'taxable-first',
  fillBracketMicro: 120_000,
  conversion: null,
  rmdBirthYear: null,
  socialSecurity: [],
}
const run = (t: Partial<SimTax>, p: Partial<SimParams> = {}) => simulate({ ...PLAN, ...p, tax: { ...TAX, ...t } })

describe('tax rules for the simulation', () => {
  it('reads the Uniform Lifetime Table and the RMD ages by birth year', () => {
    expect(uniformLifetimePeriod(72)).toBe(27.4)
    expect(uniformLifetimePeriod(75)).toBe(24.6)
    expect(uniformLifetimePeriod(96)).toBe(8.4)
    expect(uniformLifetimePeriod(120)).toBe(2)
    expect(uniformLifetimePeriod(125)).toBe(2)
    expect(rmdStartAge(1950)).toBe(72)
    expect(rmdStartAge(1959)).toBe(73)
    expect(rmdStartAge(1960)).toBe(75)
  })

  it('adjusts Social Security for claiming early or late', () => {
    expect(claimFactorMicro(1970, 67)).toBe(1_000_000)
    expect(claimFactorMicro(1970, 62)).toBe(700_000)
    expect(claimFactorMicro(1970, 70)).toBe(1_240_000)
    // Born 1956: full retirement age 66 and 4 months; 52 months early = 20% + 16 × 5/12%
    expect(claimFactorMicro(1956, 62)).toBe(733_333)
  })

  it('taxes up to 85% of Social Security by provisional income', () => {
    expect(taxableSocialSecurity($(40_000), $(10_000), 'mfj')).toBe(0)
    expect(taxableSocialSecurity($(40_000), $(20_000), 'mfj')).toBe($(4_000)) // provisional $40k: half of the $8k over
    expect(taxableSocialSecurity($(40_000), $(30_000), 'mfj')).toBe($(11_100))
    expect(taxableSocialSecurity($(40_000), $(500_000), 'mfj')).toBe($(34_000))
  })

  it('prices a year the way the tax engine does', () => {
    const yearTax = makeYearTax('mfj', { state: 'TX', filingStatus: 'mfj', customStateRateMicro: 0 })
    expect(yearTax($(32_200), 0)).toBe(0)
    expect(yearTax($(57_000), 0)).toBe($(2_480)) // $24,800 taxable at 10%
    expect(yearTax($(32_200), $(50_000))).toBe(0) // all of it inside the 0% band
  })
})

describe('the taxed simulation', () => {
  it('leaves the untaxed model exactly as it was', () => {
    const a = simulate(PLAN)
    expect(a.medianLifetimeTaxCents).toBeUndefined()
    expect(simulate({ ...PLAN, feeMicro: 0 })).toEqual(a)
  })

  it('is deterministic for a seed', () => {
    const p = { volMicro: 120_000, paths: 300 }
    expect(run({}, p)).toEqual(run({}, p))
  })

  it('pays nothing when everything is Roth', () => {
    const r = run({ taxableCents: 0, taxableBasisCents: 0, traditionalCents: 0, rothCents: $(2_000_000) })
    expect(r.medianLifetimeTaxCents).toBe(0)
  })

  it('more traditional at the same total means more lifetime tax and less after tax', () => {
    const mostlyTaxable = run({ taxableCents: $(1_800_000), taxableBasisCents: $(1_800_000), traditionalCents: $(200_000) })
    const mostlyTrad = run({ taxableCents: $(200_000), taxableBasisCents: $(200_000), traditionalCents: $(1_800_000) })
    expect(mostlyTrad.medianLifetimeTaxCents!).toBeGreaterThan(mostlyTaxable.medianLifetimeTaxCents!)
    expect(mostlyTrad.medianEndAfterTaxCents!).toBeLessThan(mostlyTaxable.medianEndAfterTaxCents!)
  })

  it('takes RMDs whether or not spending needs them, and conversions shrink them', () => {
    const noSpend = { retireSpendCents: 0 }
    const none = run({ rmdBirthYear: null }, noSpend)
    const rmds = run({ rmdBirthYear: 1975 }, noSpend) // RMDs from 2050 (age 75)
    expect(none.medianLifetimeTaxCents).toBe(0)
    expect(rmds.medianLifetimeTaxCents!).toBeGreaterThan(0)
    expect(rmds.medianEndBuckets!.traditional).toBeLessThan(none.medianEndBuckets!.traditional)
    const converted = run({ rmdBirthYear: 1975, conversion: { fromYear: 2031, toYear: 2049, amountCents: null, fillBracketMicro: 220_000 } }, noSpend)
    expect(converted.medianEndBuckets!.traditional).toBeLessThan(rmds.medianEndBuckets!.traditional)
    expect(converted.medianEndBuckets!.roth).toBeGreaterThan(0)
  })

  it('fills the chosen bracket with traditional before touching taxable', () => {
    const first = run({})
    const fill = run({ order: 'fill-bracket', fillBracketMicro: 220_000 })
    expect(fill.medianEndBuckets!.traditional).toBeLessThan(first.medianEndBuckets!.traditional)
    expect(fill.medianEndBuckets!.taxable).toBeGreaterThan(first.medianEndBuckets!.taxable)
    const pro = run({ order: 'pro-rata' })
    expect(pro.medianEndBuckets!.traditional).toBeLessThan(first.medianEndBuckets!.traditional)
  })

  it('lets Social Security carry part of the spending', () => {
    const without = run({})
    const withSs = run({ socialSecurity: [{ startYear: 2035, annualCents: $(40_000) }] })
    expect(withSs.medianEndCents).toBeGreaterThan(without.medianEndCents)
  })

  it('a fee drags the result down in both models', () => {
    expect(simulate({ ...PLAN, feeMicro: 10_000 }).medianEndCents).toBeLessThan(simulate(PLAN).medianEndCents)
    expect(run({}, { feeMicro: 10_000 }).medianEndCents).toBeLessThan(run({}).medianEndCents)
  })

  it('fails a path that runs dry in retirement', () => {
    const r = run({ taxableCents: $(100_000), taxableBasisCents: $(100_000), traditionalCents: $(100_000) })
    expect(r.successPct).toBe(0)
  })
})

describe('buckets from the ledger', () => {
  it('sorts accounts by type, with the taxable basis from the lots', () => {
    expect(bucketOf('401k', 'retirement')).toBe('traditional')
    expect(bucketOf('roth_ira', 'retirement')).toBe('roth')
    expect(bucketOf('hsa', 'retirement')).toBe('hsa')
    expect(bucketOf(null, 'retirement')).toBe('traditional')
    expect(bucketOf(null, 'crypto')).toBe('taxable')
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', ?)").run($(20_000))
    const acct = db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype) VALUES (?, ?, ?, ?)")
    acct.run('Schwab', 'brokerage', 'lots', 'taxable') // 1
    acct.run('401(k)', 'retirement', 'balance', '401k') // 2
    acct.run('Roth', 'retirement', 'balance', 'roth_ira') // 3
    acct.run('HSA', 'retirement', 'balance', 'hsa') // 4
    acct.run('Wealthfront', 'brokerage', 'balance', null) // 5
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('VTI', 'stock')").run()
    db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '2020-01-02', 'buy', 100000000, ?)").run($(15_000))
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-30', ?)").run($(300))
    const snap = db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (?, '2026-09-01', ?)")
    snap.run(2, $(400_000))
    snap.run(3, $(50_000))
    snap.run(4, $(10_000))
    snap.run(5, $(70_000))
    const b = resolveBuckets(db, today)
    expect(b).toMatchObject({
      taxableCents: $(20_000 + 30_000 + 70_000),
      taxableBasisCents: $(20_000 + 15_000 + 70_000),
      traditionalCents: $(400_000),
      rothCents: $(50_000),
      hsaCents: $(10_000),
      unknownBasis: ['Wealthfront'],
    })
  })
})

describe('scenarios', () => {
  it('gives old saved params the new knobs, and validates them', () => {
    const base = defaultParams(today)
    const { taxModel: _t, withdrawalOrder: _w, ...old } = base
    const p = normalizeParams(old, base)
    expect(p).toMatchObject({ taxModel: true, withdrawalOrder: 'taxable-first', conversion: null, advisorFeeMicro: 10_000, hsaAsRoth: true })
    expect(() => normalizeParams({ withdrawalOrder: 'random' }, base)).toThrow(/withdrawalOrder/)
    expect(() => normalizeParams({ fillBracketMicro: 370_000 }, base)).toThrow(/bracket/)
    expect(() => normalizeParams({ conversion: { fromYear: 2030, toYear: 2035, amountCents: 100, fillBracketMicro: 120_000 } }, base)).toThrow(/either/)
    expect(() => normalizeParams({ socialSecurity: [{ name: 'Max', fraBenefitCents: 1, claimAge: 61 }] }, base)).toThrow(/claimAge/)
  })

  it('starts Social Security at birth year + claiming age, adjusted, and needs the birth year', () => {
    const db = mem()
    createPaySource(db, { earner: 'Max', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(5_000), retirementCents: $(500), rothCents: $(250) })
    createPaySource(db, { earner: 'Nicole', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(5_000) })
    putPeople(db, { people: [{ name: 'Max', birthYear: 1975, hsaCoverage: 'self', hsaCents: $(4_000) }, { name: 'Nicole' }] }, today)
    const ctx = resolveTaxContext(db, today)
    expect(ctx.saves.rothCents).toBe(ctx.saves.traditionalCents / 2)
    const params = normalizeParams(
      { socialSecurity: [{ name: 'Max', fraBenefitCents: $(40_000), claimAge: 70 }, { name: 'Nicole', fraBenefitCents: $(20_000), claimAge: 67 }] },
      defaultParams(today),
    )
    const t = toSimTax(params, ctx)!
    expect(t.socialSecurity).toEqual([{ startYear: 2045, annualCents: $(49_600) }]) // Nicole has no birth year
    expect(t.rmdBirthYear).toBe(1975)
    expect(t.rothSaveCents).toBe(ctx.saves.rothCents + $(4_000)) // the HSA counts as Roth
    expect(toSimTax({ ...params, hsaAsRoth: false }, ctx)!.traditionalSaveCents).toBe(ctx.saves.traditionalCents + $(4_000))
    expect(toSimTax({ ...params, taxModel: false }, ctx)).toBeNull()
  })

  it('compares with lifetime tax, the after-tax end and the advisor counterfactual', () => {
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX' })
    db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', ?)").run($(500_000))
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype) VALUES ('401(k)', 'retirement', 'balance', '401k')").run()
    db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, '2026-09-01', ?)").run($(1_500_000))
    const [base] = listScenarios(db, today)
    updateScenario(db, base!.id, { params: { buyEnabled: false, retireYear: 2030, endYear: 2060, retireSpendCents: $(90_000) } }, today)
    const c = compareScenarios(db, today, {})
    const r = c.runs[0]!
    expect(c.tax.buckets.traditionalCents).toBe($(1_500_000))
    expect(r.result.medianLifetimeTaxCents!).toBeGreaterThan(0)
    expect(r.result.medianEndAfterTaxCents!).toBeLessThan(r.result.medianEndCents)
    expect(r.advisor!.costCents).toBeGreaterThan(0)
    updateScenario(db, base!.id, { params: { taxModel: false } }, today)
    expect(compareScenarios(db, today, {}).runs[0]!.result.medianLifetimeTaxCents).toBeUndefined()
  })

  it('runs the same on sql.js', async () => {
    const seed = (db: DbLike) => {
      putTaxSettings(db, { filingStatus: 'mfj', state: 'CA', wagesAnnualCents: $(200_000) })
      db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', ?)").run($(300_000))
      db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype) VALUES ('IRA', 'retirement', 'balance', 'ira')").run()
      db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, '2026-09-01', ?)").run($(800_000))
      putPeople(db, { people: [{ name: 'Max', birthYear: 1968 }] }, today)
      const [s] = listScenarios(db, today)
      updateScenario(db, s!.id, { params: { conversion: { fromYear: 2031, toYear: 2036, amountCents: null, fillBracketMicro: 220_000 }, socialSecurity: [{ name: 'Max', fraBenefitCents: $(36_000), claimAge: 67 }] } }, today)
    }
    const { server, browser } = await onBothEngines(seed, (db) => compareScenarios(db, today, {}))
    expect(browser).toEqual(server)
  })
})
