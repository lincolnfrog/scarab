import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import {
  computeHarvest,
  computeTax,
  computeTaxYear,
  federalLtTax,
  FEDERAL_BRACKETS_2026,
  getTaxSettings,
  marginalRates,
  netCapitalGains,
  niitCents,
  putTaxSettings,
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
    expect(stateTaxCents($(100_000), { state: 'NY', filingStatus: 'mfj', customStateRateMicro: 65_000 }).taxCents).toBe($(6_500))
  })
  it('runs California brackets and the MHST', () => {
    // MFJ $100k: deduction 11,080 → taxable 88,920: 1%×21,512 + 2%×29,486 + 4%×29,492 + 6%×8,430 = 215.12+589.72+1179.68+505.80
    const r = stateTaxCents($(100_000), { state: 'CA', filingStatus: 'mfj', customStateRateMicro: 0 })
    expect(r.taxCents).toBe(249032)
    expect(r.mhstCents).toBe(0)
    const rich = stateTaxCents($(1_600_000), { state: 'CA', filingStatus: 'mfj', customStateRateMicro: 0 })
    expect(rich.mhstCents).toBeGreaterThan(0)
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
