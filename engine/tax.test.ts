import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { createPaySource } from './paychecks'
import { addMonths, putUnvested, vestUnvested } from './services'
import {
  addlMedicareCents,
  computeHarvest,
  computeTax,
  computeTaxYear,
  estimatedSchedule,
  federalLtTax,
  FEDERAL_BRACKETS_2026,
  FEDERAL_EST_RULE,
  getTaxSettings,
  marginalRates,
  netCapitalGains,
  niitCents,
  projectVests,
  putTaxSettings,
  quarterSchedule,
  rsuStateWithholdMicro,
  stateEstRule,
  STATES,
  stateTaxCents,
  taxFromBrackets,
  type TaxInputs,
} from './tax'

const $ = (dollars: number) => Math.round(dollars * 100)

const baseInputs = (over: Partial<TaxInputs> = {}): TaxInputs => ({
  filing: 'mfj',
  ordinaryCents: 0,
  stGainCents: 0,
  ltGainCents: 0,
  investmentIncomeCents: 0,
  deductionCents: 0,
  state: { state: 'NONE', filingStatus: 'mfj', customStateRateMicro: 0 },
  ...over,
})

describe('bracket math', () => {
  it('applies 2026 MFJ brackets progressively', () => {
    // $100,000 taxable MFJ: 10% × 24,800 + 12% × 75,200 = 2,480 + 9,024
    expect(taxFromBrackets($(100_000), FEDERAL_BRACKETS_2026.mfj)).toBe($(11_504))
  })
  it('is zero at or below zero', () => {
    expect(taxFromBrackets(0, FEDERAL_BRACKETS_2026.single)).toBe(0)
    expect(taxFromBrackets(-500, FEDERAL_BRACKETS_2026.single)).toBe(0)
  })
  it('hits the top rate', () => {
    // First dollar above $768,700 MFJ is taxed at 37%
    const at = taxFromBrackets($(768_700), FEDERAL_BRACKETS_2026.mfj)
    expect(taxFromBrackets($(768_700) + 100_000, FEDERAL_BRACKETS_2026.mfj) - at).toBe(37_000)
  })
})

describe('long-term gains stacking', () => {
  it('uses the 0% band when ordinary income is low', () => {
    // MFJ, no ordinary income: first $98,900 of LT gains at 0%
    expect(federalLtTax(0, $(98_900), 'mfj')).toBe(0)
    expect(federalLtTax(0, $(98_900) + $(1_000), 'mfj')).toBe($(150))
  })
  it('stacks on top of ordinary income', () => {
    // Ordinary already fills the 0% band → all LT at 15%
    expect(federalLtTax($(200_000), $(10_000), 'mfj')).toBe($(1_500))
  })
  it('crosses into 20% above the 15% band', () => {
    expect(federalLtTax($(613_700), $(1_000), 'mfj')).toBe($(200))
  })
})

describe('NIIT', () => {
  it('kicks in only above the MAGI threshold', () => {
    expect(niitCents($(50_000), $(249_000), 'mfj')).toBe(0)
    // $10k over threshold, NII larger → 3.8% × 10,000
    expect(niitCents($(50_000), $(260_000), 'mfj')).toBe($(380))
    // NII smaller than overage → 3.8% × NII
    expect(niitCents($(5_000), $(400_000), 'mfj')).toBe($(190))
  })
})

describe('state tax', () => {
  it('is zero for no-tax states', () => {
    expect(stateTaxCents($(500_000), { state: 'TX', filingStatus: 'mfj', customStateRateMicro: 0 }).taxCents).toBe(0)
  })
  it('applies flat rates', () => {
    expect(stateTaxCents($(100_000), { state: 'IL', filingStatus: 'mfj', customStateRateMicro: 0 }).taxCents).toBe($(4_950))
  })
  it('uses the custom rate for unbundled states', () => {
    expect(stateTaxCents($(100_000), { state: 'ME', filingStatus: 'mfj', customStateRateMicro: 65_000 }).taxCents).toBe($(6_500))
  })
  it('runs California 2025 brackets and the MHST', () => {
    // MFJ $100k: deduction 11,412 → taxable 88,588:
    // 1%×22,158 + 2%×30,370 + 4%×30,376 + 6%×5,684 = 221.58+607.40+1215.04+341.04
    const r = stateTaxCents($(100_000), { state: 'CA', filingStatus: 'mfj', customStateRateMicro: 0 })
    expect(r.taxCents).toBe(238506)
    expect(r.mhstCents).toBe(0)
    const rich = stateTaxCents($(1_600_000), { state: 'CA', filingStatus: 'mfj', customStateRateMicro: 0 })
    expect(rich.mhstCents).toBeGreaterThan(0)
  })
  const st = (state: string, filingStatus: 'single' | 'mfj' | 'mfs' | 'hoh', dollars: number) =>
    stateTaxCents($(dollars), { state, filingStatus, customStateRateMicro: 0 }).taxCents
  it('New York 2026: the IT-2105-I schedule (cumulative amounts cross-check)', () => {
    // MFJ $200k − $16,050 = $183,950: the form's "$8,391 plus 5.90% over $161,550"
    // is what the bracket walk should reproduce: 8,391.20 + 22,400×5.9% = 9,712.80
    expect(st('NY', 'mfj', 200_000)).toBe(971280)
    // single and MFS share a schedule; HoH has its own
    expect(st('NY', 'mfs', 120_000)).toBe(st('NY', 'single', 120_000))
    expect(st('NY', 'hoh', 120_000)).toBeLessThan(st('NY', 'single', 120_000))
  })
  it('New Jersey: exemptions instead of a deduction, joint schedule for HoH', () => {
    // single $100k − $1,000 = $99,000: 280 + 262.50 + 175 + 1,933.75 + 1,528.80
    expect(st('NJ', 'single', 100_000)).toBe(418005)
    // HoH shares the joint schedule but gets one $1,000 exemption, not two: the extra $1,000 sits in the 5.525% band
    expect(st('NJ', 'hoh', 100_000)).toBe(st('NJ', 'mfj', 100_000) + Math.round(1_000_00 * 0.05525))
  })
  it('Oregon 2026: chart J', () => {
    // MFJ $100k − $5,800 = $94,200: 1,357 + 8.75% × 71,400 = 7,604.50
    expect(st('OR', 'mfj', 100_000)).toBe(760450)
  })
  it('Minnesota 2026', () => {
    // single $100k − $15,300 = $84,700: 5.35%×33,310 + 6.8%×51,390 = 1,782.085 + 3,494.52
    expect(st('MN', 'single', 100_000)).toBe(527661)
  })
  it('Hawaii 2026: doubled standard deduction, 1.5× HoH brackets', () => {
    // MFJ $100k − $16,000 = $84,000: 3,350.40 through the 7.2% band + 7.2%×12,000
    expect(st('HI', 'mfj', 100_000)).toBe(421440)
    expect(st('HI', 'hoh', 300_000)).toBeLessThan(st('HI', 'single', 300_000))
  })
  it('Virginia: statutory brackets, raised standard deduction', () => {
    // MFJ $100k − $17,500 = $82,500: 60 + 60 + 600 + 5.75% × 65,500
    expect(st('VA', 'mfj', 100_000)).toBe(448625)
    expect(st('VA', 'hoh', 100_000)).toBe(st('VA', 'single', 100_000))
  })
  it('Maryland: the 2025 tiers and the capital-gains surcharge', () => {
    // single $200k − $3,350 = $196,650: 20 + 30 + 40 + 4,607.50 + 1,250 + 1,312.50 + 5.5% × 46,650
    expect(st('MD', 'single', 200_000)).toBe(982575)
    const md = { state: 'MD', filingStatus: 'mfj' as const, customStateRateMicro: 0 }
    const gains = { netStCents: 0, netLtCents: $(50_000) }
    expect(stateTaxCents($(300_000), md, gains).mhstCents).toBe(0) // under the $350k AGI line
    const rich = stateTaxCents($(400_000), md, gains)
    expect(rich.mhstCents).toBe($(1_000)) // 2% × $50k
    expect(rich.taxCents).toBe(stateTaxCents($(400_000), md).taxCents + $(1_000))
    // the top tiers exist
    expect(st('MD', 'mfj', 1_300_000) - st('MD', 'mfj', 1_299_000)).toBe($(65))
  })
  it('Ohio: zero bracket then flat 2.75%', () => {
    expect(st('OH', 'single', 100_000)).toBe(203363) // 2.75% × (100,000 − 26,050)
    expect(st('OH', 'mfj', 20_000)).toBe(0)
  })
  it('Wisconsin: sliding standard deduction', () => {
    // single $100k: deduction 13,560 − 12% × 80,450 = 3,906 → taxable 96,094:
    // 513.80 + 1,575.20 + 5.3% × 45,614
    expect(st('WI', 'single', 100_000)).toBe(450654)
    // fully phased out above ~$132.5k
    expect(st('WI', 'single', 200_000)).toBe(taxFromBrackets($(200_000), [
      { upToCents: 14_680_00, rateMicro: 35_000 }, { upToCents: 50_480_00, rateMicro: 44_000 },
      { upToCents: 323_290_00, rateMicro: 53_000 }, { upToCents: null, rateMicro: 76_500 },
    ]))
    // HoH never does worse than single once its steeper phase-out has run out
    expect(st('WI', 'hoh', 120_000)).toBe(st('WI', 'single', 120_000))
    expect(st('WI', 'hoh', 30_000)).toBeLessThan(st('WI', 'single', 30_000))
  })
  it('Connecticut: exemption phase-out, then plain brackets', () => {
    // single $40k: exemption 15,000 − 10 × 1,000 = 5,000 → taxable 35,000: 200 + 1,125
    expect(st('CT', 'single', 40_000)).toBe($(1_325))
    // MFJ $300k: exemption gone → 400 + 3,600 + 5,500 + 6,000
    expect(st('CT', 'mfj', 300_000)).toBe($(15_500))
  })
  it('South Carolina 2026: two brackets, SCIAD phase-out, 44% LT exclusion', () => {
    // single $60k: reduction 15,000 × 20/55 = 5,454.54 → $5,450; SCIAD 9,550; taxable 50,450:
    // 1.99% × 30,000 + 5.21% × 20,450 = 597 + 1,065.445 — same as the form's 5.21% × 50,450 − 966
    expect(st('SC', 'single', 60_000)).toBe(166245)
    // MFJ $80k keeps the full $30,000 SCIAD → taxable 50,000: 597 + 5.21% × 20,000
    expect(st('SC', 'mfj', 80_000)).toBe($(1_639))
    expect(st('SC', 'mfj', 190_000)).toBe(Math.round($(190_000) * 0.0521) - $(966))
    // $10k of the $60k is long-term gain: 44% of it drops out of income (the deduction still keys off AGI)
    const sc = { state: 'SC', filingStatus: 'single' as const, customStateRateMicro: 0 }
    expect(stateTaxCents($(60_000), sc, { netStCents: 0, netLtCents: $(10_000) }).taxCents).toBe(143321)
  })
  it('District of Columbia 2026', () => {
    // MFJ $300k − $32,200 = $267,800: 400 + 1,800 + 1,300 + 16,150 + 9.25% × 17,800
    expect(st('DC', 'mfj', 300_000)).toBe(2129650)
    expect(st('DC', 'single', 300_000)).toBeGreaterThan(st('DC', 'mfj', 300_000)) // only the deduction differs
  })
  it('every bracketed state is monotone and its table is exposed to the UI', () => {
    for (const s of STATES.filter((s) => s.kind === 'brackets')) {
      expect(s.kind === 'brackets' && s.vintage.length).toBeGreaterThan(0)
      let prev = 0
      for (const income of [10_000, 50_000, 150_000, 400_000, 1_200_000, 3_000_000]) {
        const t = st(s.code, 'mfj', income)
        expect(t).toBeGreaterThanOrEqual(prev)
        expect(t).toBeLessThan($(income) * 0.15)
        prev = t
      }
    }
  })
})

describe('qualified dividends', () => {
  it('are taxed at the preferential rate federally and as ordinary by the state', () => {
    const mfjCa = { state: 'CA', filingStatus: 'mfj' as const, customStateRateMicro: 0 }
    const allOrdinary = computeTax(baseInputs({
      ordinaryCents: $(210_000), investmentIncomeCents: $(10_000), deductionCents: $(32_200), state: mfjCa,
    }))
    const split = computeTax(baseInputs({
      ordinaryCents: $(200_000), qualifiedDividendCents: $(10_000), investmentIncomeCents: $(10_000),
      deductionCents: $(32_200), state: mfjCa,
    }))
    expect(split.taxableLtCents).toBe($(10_000))
    expect(split.fedLtCents).toBe($(1_500)) // 15% band: ordinary already past $98,900
    expect(split.taxableOrdinaryCents).toBe($(167_800))
    expect(split.fedOrdinaryCents).toBeLessThan(allOrdinary.fedOrdinaryCents)
    expect(split.stateCents).toBe(allOrdinary.stateCents) // CA doesn't care
    expect(split.fedTotalCents).toBeLessThan(allOrdinary.fedTotalCents)
  })
  it('the deduction comes out of ordinary income before touching them', () => {
    const t = computeTax(baseInputs({ ordinaryCents: $(20_000), qualifiedDividendCents: $(30_000), deductionCents: $(32_200) }))
    expect(t.taxableOrdinaryCents).toBe(0)
    expect(t.taxableLtCents).toBe($(17_800))
    expect(t.fedLtCents).toBe(0) // inside the 0% band
  })
})

describe('estimated-payment schedules', () => {
  const base = {
    year: 2026, today: '2026-02-01', filing: 'mfj' as const, taxCents: $(40_000), withheldCents: $(20_000),
    estPaidCents: 0, priorYearTaxCents: 0, priorYearAgiOver150k: true, agiCents: $(400_000),
  }
  it('federal spreads the remainder evenly; California weights 30/40/0/30', () => {
    const fed = estimatedSchedule(FEDERAL_EST_RULE, base)
    expect(fed.requiredCents).toBe($(36_000))
    expect(fed.remainingCents).toBe($(16_000))
    expect(fed.quarters.map((q) => q.cents)).toEqual([$(4_000), $(4_000), $(4_000), $(4_000)])
    const ca = estimatedSchedule(stateEstRule('CA')!, base)
    expect(ca.weights).toEqual([30, 40, 0, 30])
    expect(ca.assumed).toBe(false)
    expect(ca.quarters.map((q) => q.cents)).toEqual([$(4_800), $(6_400), 0, $(4_800)])
  })
  it('after a due date passes, the rest is re-weighted over what is left', () => {
    // Sep 10: only Sep 15 (weight 0) and Jan 15 (weight 30) remain → everything lands in January
    const q = quarterSchedule(2026, '2026-09-10', $(10_000), [30, 40, 0, 30])
    expect(q.map((x) => x.cents)).toEqual([0, 0, 0, $(10_000)])
    expect(q.map((x) => x.past)).toEqual([true, true, false, false])
    // rounding: three equal parts of $100 sum exactly
    const f = quarterSchedule(2026, '2026-05-01', 10_000, [25, 25, 25, 25])
    expect(f.reduce((s, x) => s + x.cents, 0)).toBe(10_000)
  })
  it('California drops the prior-year harbor at $1M AGI and waives tiny shortfalls', () => {
    const rule = stateEstRule('CA')!
    const normal = estimatedSchedule(rule, { ...base, priorYearTaxCents: $(10_000) })
    expect(normal.basis).toBe('110% of last year')
    expect(normal.requiredCents).toBe($(11_000))
    const rich = estimatedSchedule(rule, { ...base, priorYearTaxCents: $(10_000), agiCents: $(1_000_000) })
    expect(rich.priorYearHarborAvailable).toBe(false)
    expect(rich.basis).toBe('90% of this year')
    const tiny = estimatedSchedule(rule, { ...base, taxCents: $(20_400) })
    expect(tiny.belowThreshold).toBe(true)
    expect(tiny.remainingCents).toBe(0)
    expect(rule.thresholdCents('mfs')).toBe($(250))
  })
  it('states without a bundled rule get the federal shape, flagged as assumed', () => {
    expect(stateEstRule('TX')).toBeNull()
    expect(stateEstRule('NY')!.assumed).toBe(true)
    expect(stateEstRule('IL')!.weights).toEqual([25, 25, 25, 25])
  })
})

describe('capital gain netting', () => {
  it('offsets ST losses against LT gains', () => {
    expect(netCapitalGains($(-10_000), $(30_000))).toEqual({
      netStCents: 0, netLtCents: $(20_000), capLossUsedCents: 0, capLossCarryCents: 0,
    })
  })
  it('offsets LT losses against ST gains', () => {
    expect(netCapitalGains($(30_000), $(-10_000))).toEqual({
      netStCents: $(20_000), netLtCents: 0, capLossUsedCents: 0, capLossCarryCents: 0,
    })
  })
  it('caps the ordinary offset at $3,000 and carries the rest', () => {
    expect(netCapitalGains($(-5_000), $(-7_000))).toEqual({
      netStCents: 0, netLtCents: 0, capLossUsedCents: $(3_000), capLossCarryCents: $(9_000),
    })
  })
})

describe('computeTax end-to-end', () => {
  it('the RSU household: high ordinary + LT gains + NIIT', () => {
    const t = computeTax(baseInputs({
      ordinaryCents: $(500_000),
      ltGainCents: $(100_000),
      deductionCents: $(32_200),
      state: { state: 'CA', filingStatus: 'mfj', customStateRateMicro: 0 },
    }))
    expect(t.taxableOrdinaryCents).toBe($(467_800))
    expect(t.taxableLtCents).toBe($(100_000))
    expect(t.fedLtCents).toBe($(15_000)) // fully inside the 15% band
    expect(t.niitCents).toBe($(3_800)) // $100k NII, MAGI $600k → all over threshold
    expect(t.stateCents).toBeGreaterThan($(45_000)) // CA taxes gains as ordinary
    expect(t.totalCents).toBe(t.fedTotalCents + t.stateCents)
  })
  it('deduction eats into LT when ordinary is small', () => {
    const t = computeTax(baseInputs({ ordinaryCents: $(10_000), ltGainCents: $(50_000), deductionCents: $(32_200) }))
    expect(t.taxableOrdinaryCents).toBe(0)
    expect(t.taxableLtCents).toBe($(27_800))
    expect(t.fedLtCents).toBe(0) // inside the 0% band
  })
})

describe('marginal rates', () => {
  it('ST marginal ≥ LT marginal for a high earner', () => {
    const m = marginalRates(baseInputs({ ordinaryCents: $(600_000), deductionCents: $(32_200) }))
    expect(m.stMicro).toBeGreaterThan(m.ltMicro)
    expect(m.ordinaryMicro).toBe(350_000) // 35% bracket at $567,800 taxable
    expect(m.ltMicro).toBe(188_000) // 15% + 3.8% NIIT
  })
})

/* ---------- ledger-derived, on a real database ---------- */

function seed(db: DbLike) {
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Brokerage', 'brokerage', 'lots')").run()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ACME', 'stock')").run()
  const trade = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, note) VALUES (1, 1, ?, ?, ?, ?, ?)',
  )
  // an RSU vest this year: 100 sh at $50k — ordinary income AND a lot
  trade.run('2026-02-01', 'buy', 100_000_000, $(50_000), 'RSU vest')
  // an old lot: 100 sh bought 2024 for $20k
  trade.run('2024-03-01', 'buy', 100_000_000, $(20_000), null)
  // sold 50 old shares this year for $25k → LT gain $15k
  trade.run('2026-05-01', 'sell', 50_000_000, $(25_000), null)
  // price today: $400/sh → vest lot ($500/sh) is under water
  db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-08-20', 40000)").run()
}

describe('the ledger-derived year picture', () => {
  it('derives RSU income, realized gains, and the withholding gap', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putTaxSettings(db, {
      filingStatus: 'mfj',
      state: 'CA',
      wagesAnnualCents: $(300_000),
      withheldFederalCents: $(70_000),
      priorYearTaxFederalCents: $(90_000),
    })
    const y = computeTaxYear(db, '2026-08-27')
    expect(y.incomes.rsuYtdCents).toBe($(50_000))
    expect(y.incomes.rsuProjectedCents).toBe(0) // no vest schedule set
    expect(y.incomes.realizedLtCents).toBe($(15_000))
    expect(y.incomes.realizedStCents).toBe(0)
    expect(y.tax.totalCents).toBeGreaterThan(0)
    expect(y.fedGapCents).toBe(y.tax.fedTotalCents - $(70_000))
    // safe harbor: 110% × 90k = 99k vs 90% of current — required is the lesser
    expect(y.safeHarbor.requiredCents).toBe(
      Math.min($(99_000), Math.round(y.tax.fedTotalCents * 0.9)),
    )
    // no quarterly amounts on dates that already passed
    for (const q of y.safeHarbor.quarters) if (q.past) expect(q.cents).toBe(0)
    // the state gets its own schedule under California's rule
    expect(y.stateSafeHarbor?.rule).toContain('California')
    expect(y.stateSafeHarbor?.weights).toEqual([30, 40, 0, 30])
    expect(y.stateGapCents).toBe(y.tax.stateCents)
  })

  it('splits dividends by the qualified share and projects scheduled vests', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    const cat = db.prepare("SELECT id FROM categories WHERE name = 'Dividends & interest'").get() as { id: number }
    db.prepare(
      "INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (1, '2026-03-15', ?, 'DIVIDEND', ?, 'h-div')",
    ).run($(4_000), cat.id)
    // 100 unvested shares, 25 every 3 months, last vested May 15 → Aug 15 is past, Nov 15 is the one left this year
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '100', nextVestOn: '2026-05-15', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')
    putTaxSettings(db, { wagesAnnualCents: $(300_000), qualifiedDividendShareMicro: 750_000 })
    const y = computeTaxYear(db, '2026-08-27')
    expect(y.incomes.dividendsYtdCents).toBe($(4_000))
    expect(y.incomes.dividendsQualifiedCents).toBe($(3_000))
    expect(y.incomes.dividendsOrdinaryCents).toBe($(1_000))
    expect(y.tax.qualifiedDividendCents).toBe($(3_000))
    expect(y.incomes.rsuProjected).toEqual([
      { symbol: 'ACME', account: 'Brokerage', account_id: 1, vest_on: '2026-11-15', qty_micro: 25_000_000, cents: $(10_000) },
    ])
    expect(y.incomes.rsuProjectedCents).toBe($(10_000))
    expect(y.incomes.totalIncomeCents).toBe($(300_000) + $(50_000) + $(10_000) + $(4_000) + $(15_000))
  })

  it('settings reject a qualified share over 100%', () => {
    const db = openDb(':memory:') as unknown as DbLike
    expect(() => putTaxSettings(db, { qualifiedDividendShareMicro: 1_000_001 })).toThrow()
    putTaxSettings(db, { qualifiedDividendShareMicro: 1_000_000, estPaidStateCents: $(500), priorYearTaxStateCents: $(9_000) })
    const s = getTaxSettings(db)
    expect(s.estPaidStateCents).toBe($(500))
    expect(s.priorYearTaxStateCents).toBe($(9_000))
  })

  it('settings round-trip and reject junk', () => {
    const db = openDb(':memory:') as unknown as DbLike
    putTaxSettings(db, { filingStatus: 'single', state: 'TX' })
    const s = getTaxSettings(db)
    expect(s.filingStatus).toBe('single')
    expect(s.state).toBe('TX')
    expect(() => putTaxSettings(db, { state: 'ZZ' })).toThrow()
    expect(() => putTaxSettings(db, { wagesAnnualCents: -5 })).toThrow()
    expect(() => putTaxSettings(db, { wagesAnnualCents: 1.5 })).toThrow()
  })
})

describe('harvesting', () => {
  it('finds loss lots, terms, and wash-sale risk from a recent vest', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    // another buy 10 days ago → wash risk on the loss lot
    db.prepare(
      "INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '2026-08-17', 'buy', 10_000_000, 500000)",
    ).run()
    const h = computeHarvest(db, '2026-08-27', { stMicro: 450_000, ltMicro: 250_000 })
    const loss = h.rows.find((r) => r.opened_on === '2026-02-01')!
    expect(loss.gain_cents).toBe($(40_000) - $(50_000)) // 100 sh: value $40k vs basis $50k
    expect(loss.term).toBe('st')
    expect(loss.wash_risk).toBe(true)
    expect(loss.tax_delta_cents).toBe(Math.round((loss.gain_cents * 450_000) / 1_000_000))
    // the 2024 lot's remaining 50 shares are a long-term gain, no wash flag
    const gain = h.rows.find((r) => r.opened_on === '2024-03-01')!
    expect(gain.term).toBe('lt')
    expect(gain.gain_cents).toBe($(20_000) - $(10_000))
    expect(gain.wash_risk).toBe(false)
    // ST losses: the vest lot (−$10k) plus the fresh 10-share lot (−$1k)
    expect(h.totals.harvestableStCents).toBe($(-11_000))
    expect(h.totals.washFlagged).toBe(1)
  })

  it('the 30-day window has a hard edge', () => {
    const db = openDb(':memory:') as unknown as DbLike
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('B', 'brokerage', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('EDGE', 'stock')").run()
    const trade = db.prepare(
      'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, ?, ?, ?, ?)',
    )
    trade.run('2025-01-01', 'buy', 100_000_000, 1_000_000) // 100 sh for $10k ($100/sh)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-08-27', 500)").run()
    const m = { stMicro: 450_000, ltMicro: 250_000 }
    // buy exactly 31 days ago: outside the window
    trade.run('2026-07-27', 'buy', 1_000_000, 10_000)
    let h = computeHarvest(db, '2026-08-27', m)
    const old = () => h.rows.find((r) => r.opened_on === '2025-01-01')!
    expect(old().wash_risk).toBe(false)
    // buy 29 days ago: inside
    trade.run('2026-07-29', 'buy', 1_000_000, 10_000)
    h = computeHarvest(db, '2026-08-27', m)
    expect(old().wash_risk).toBe(true)
  })
})

describe('vest schedules', () => {
  it('addMonths clamps to the end of the target month', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })
  it('projects every remaining event this year, capped by the unvested count', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    // 40 shares left, 25 per quarter starting Oct 1 → Oct 1 (25) and only 15 remain for Jan 1 — which is next year anyway
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '40', nextVestOn: '2026-10-01', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')
    let p = projectVests(db, '2026-08-27')
    expect(p.events.map((e) => [e.vest_on, e.qty_micro])).toEqual([['2026-10-01', 25_000_000]])
    // monthly: Oct, Nov, Dec → 25 + 15 + nothing
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '40', nextVestOn: '2026-10-01', vestEveryMonths: 1, vestQty: '25' }, '2026-08-27')
    p = projectVests(db, '2026-08-27')
    expect(p.events.map((e) => e.qty_micro)).toEqual([25_000_000, 15_000_000])
    expect(p.cents).toBe($(16_000)) // 40 sh × $400
    // an asset with no price still lists the event, flagged unpriced
    db.prepare('DELETE FROM prices').run()
    p = projectVests(db, '2026-08-27')
    expect(p.unpriced).toBe(2)
    expect(p.cents).toBe(0)
  })
  it('a qty-only update leaves the schedule alone; an empty date clears it', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '100', nextVestOn: '2026-10-01', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '90' }, '2026-08-27')
    expect(projectVests(db, '2026-08-27').events.length).toBe(1)
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '90', nextVestOn: '' }, '2026-08-27')
    expect(projectVests(db, '2026-08-27').events.length).toBe(0)
    expect(() => putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '90', nextVestOn: '2026-10-01', vestEveryMonths: 0, vestQty: '25' }, '2026-08-27')).toThrow()
    expect(() => putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '90', nextVestOn: 'soon', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')).toThrow()
  })
  it('recording a vest rolls the cadence past the vest date', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '100', nextVestOn: '2026-10-01', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')
    vestUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '25', tradedOn: '2026-10-01', totalCents: $(10_000) }, '2026-10-01')
    const row = db.prepare('SELECT qty_micro, next_vest_on FROM unvested_positions').get() as { qty_micro: number; next_vest_on: string }
    expect(row.qty_micro).toBe(75_000_000)
    expect(row.next_vest_on).toBe('2027-01-01')
    expect(projectVests(db, '2026-10-01').events.length).toBe(0)
  })
})

describe('paychecks in the year picture', () => {
  const paycheck = (db: DbLike, earner: string, over: Partial<Parameters<typeof createPaySource>[1]> = {}) =>
    createPaySource(db, {
      earner,
      cadence: 'monthly',
      paidOn: '2026-12-31', // full-year stub: the YTD column IS the year, nothing left to project
      grossCents: $(15_000),
      fedWithheldCents: $(3_000),
      stateWithheldCents: $(1_000),
      ytdGrossCents: $(180_000),
      ytdFedWithheldCents: $(36_000),
      ytdStateWithheldCents: $(12_000),
      ...over,
    })

  it('derives wages and withholding from the stubs and adds supplemental withholding on uncovered vests', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putUnvested(db, { investAccountId: 1, symbol: 'ACME', qty: '100', nextVestOn: '2026-05-15', vestEveryMonths: 3, vestQty: '25' }, '2026-08-27')
    putTaxSettings(db, { filingStatus: 'mfj', state: 'CA', wagesAnnualCents: $(999_999), withheldFederalCents: $(999_999) })
    // Earner A's employer is where the ACME RSUs vest; the stub's YTD withholding covers the $50k vest to date.
    paycheck(db, 'A', { investAccountId: 1 })
    paycheck(db, 'B', { ytdGrossCents: $(120_000), ytdFedWithheldCents: $(20_000), ytdStateWithheldCents: $(7_000) })
    const y = computeTaxYear(db, '2026-08-27')
    expect(y.incomes.wagesFromPaychecks).toBe(true)
    expect(y.incomes.wagesCents).toBe($(300_000)) // the legacy setting is ignored once stubs exist
    expect(y.payroll.earners.map((e) => e.earner)).toEqual(['A', 'B'])
    // only the projected Nov vest ($10k) needs supplemental withholding: 22% federal, CA 10.23%
    expect(y.rsuWithholding.baseCents).toBe($(10_000))
    expect(y.rsuWithholding.federalCents).toBe($(2_200))
    expect(y.rsuWithholding.stateCents).toBe($(1_023))
    expect(y.withheldFederalCents).toBe($(56_000) + $(2_200))
    expect(y.withheldStateCents).toBe($(19_000) + $(1_023))
    // Medicare wages: A $180k + $60k stock comp, B $120k = $360k → 0.9% over $250k MFJ = $990 owed,
    // withheld only by A's employer above $200k: 0.9% × $40k = $360
    expect(y.payroll.ficaWagesCents).toBe($(360_000))
    expect(y.tax.addlMedicareCents).toBe($(990))
    expect(y.payroll.addlMedicareWithheldCents).toBe($(360))
    expect(y.fedCreditsCents).toBe($(360))
    expect(y.fedGapCents).toBe(y.tax.fedTotalCents - y.withheldFederalCents - $(360))
    expect(y.safeHarbor.paidCents).toBe(y.withheldFederalCents + $(360))
    // a salary raise now carries the 0.9% surtax on top of the bracket rate
    expect(y.marginal.ordinaryMicro).toBeGreaterThanOrEqual(9_000)
  })

  it('withholds on YTD vests too when the stub cannot vouch for them', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putTaxSettings(db, { state: 'TX', rsuWithholdFederalMicro: 220_000 })
    paycheck(db, 'A', { ytdGrossCents: null }) // estimated YTD column → the $50k vest's withholding is not in it
    const y = computeTaxYear(db, '2026-08-27')
    expect(y.rsuWithholding.baseCents).toBe($(50_000))
    expect(y.rsuWithholding.federalCents).toBe($(11_000))
    expect(y.rsuWithholding.stateMicro).toBe(0)
    expect(y.rsuWithholding.stateCents).toBe(0)
  })

  it('leaves the legacy full-year settings in charge until a stub exists', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    putTaxSettings(db, { wagesAnnualCents: $(300_000), withheldFederalCents: $(70_000) })
    const y = computeTaxYear(db, '2026-08-27')
    expect(y.incomes.wagesFromPaychecks).toBe(false)
    expect(y.incomes.wagesCents).toBe($(300_000))
    expect(y.withheldFederalCents).toBe($(70_000))
    expect(y.tax.addlMedicareCents).toBe(0)
    expect(y.payroll.sources).toEqual([])
  })

  it('Additional Medicare Tax and the state supplemental rate', () => {
    expect(addlMedicareCents($(250_000), 'mfj')).toBe(0)
    expect(addlMedicareCents($(350_000), 'mfj')).toBe($(900))
    expect(addlMedicareCents($(210_000), 'single')).toBe($(90))
    const base = { ...getTaxSettings(openDb(':memory:') as unknown as DbLike) }
    expect(rsuStateWithholdMicro({ ...base, state: 'CA' })).toBe(102_300)
    expect(rsuStateWithholdMicro({ ...base, state: 'NY' })).toBe(117_000)
    expect(rsuStateWithholdMicro({ ...base, state: 'TX' })).toBe(0)
    expect(rsuStateWithholdMicro({ ...base, state: 'CO' })).toBe(STATES.find((s) => s.code === 'CO')!.kind === 'flat' ? (STATES.find((s) => s.code === 'CO') as { rateMicro: number }).rateMicro : 0)
    expect(rsuStateWithholdMicro({ ...base, state: 'CA', rsuWithholdStateMicro: 50_000 })).toBe(50_000)
    const db = openDb(':memory:') as unknown as DbLike
    putTaxSettings(db, { rsuWithholdStateMicro: 70_000 })
    expect(getTaxSettings(db).rsuWithholdStateMicro).toBe(70_000)
    putTaxSettings(db, { rsuWithholdStateMicro: null })
    expect(getTaxSettings(db).rsuWithholdStateMicro).toBeNull()
    expect(() => putTaxSettings(db, { rsuWithholdFederalMicro: 1_000_001 })).toThrow()
  })
})
