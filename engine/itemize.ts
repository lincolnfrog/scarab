import { addDaysIso } from '../shared/dates'
import { categorySpend, resolveRoles, type Roles } from './checkup-settings'
import type { DbLike } from './db'

/**
 * Itemized deductions derived from the ledger: mortgage interest from the
 * loans' rates and recorded balances, property tax and charitable giving from
 * their categories (engine/checkup-settings.ts roles), state income tax from
 * the estimate — SALT capped per the bundled vintage. Taxes uses the total as
 * the itemized figure when none is typed; a typed figure overrides it.
 *
 * Same rules as the rest of engine/: isomorphic, synchronous, integer cents,
 * rates in micro (1e6 = 100%), nothing stored.
 */

export const ITEMIZE_VINTAGE = 'Itemized deductions: tax year 2026 (P.L. 119-21)'

/**
 * State and local taxes (§164(b)(7) as amended in 2025): a $40,400 cap for
 * 2026, cut by 30% of modified AGI over $505,000 but never below $10,000.
 * Married filing separately halves every figure.
 */
export const SALT_2026 = { capCents: 40_400_00, floorCents: 10_000_00, phaseoutStartCents: 505_000_00, phaseoutMicro: 300_000 }
/** Home acquisition debt whose interest is deductible (§163(h)(3)(F)): $750,000; $375,000 married filing separately. */
export const MORTGAGE_DEBT_LIMIT_CENTS = 750_000_00
/** From 2026 an itemizer's charitable deduction counts only above 0.5% of AGI (§170(b)(1)(I)). */
export const CHARITY_AGI_FLOOR_MICRO = 5_000

export function saltCapCents(filing: string, magiCents: number): number {
  const half = filing === 'mfs' ? 2 : 1
  const cap = SALT_2026.capCents / half
  const floor = SALT_2026.floorCents / half
  const over = Math.max(0, magiCents - SALT_2026.phaseoutStartCents / half)
  return Math.max(floor, cap - Math.round((over * SALT_2026.phaseoutMicro) / 1_000_000))
}

export type LoanInterest = { name: string; rateMicro: number; avgBalanceCents: number; interestCents: number }

/**
 * A year of interest on every loan against a property: each month, the
 * latest recorded balance on or before the 1st × the rate ÷ 12. Months before
 * a loan's first recorded balance count at that balance only when the
 * property was owned by then (or its purchase date is unknown). A loan without
 * a rate can't be priced and is counted in `unrated`.
 */
export function mortgageInterestYear(db: DbLike, year: number): { loans: LoanInterest[]; unrated: string[] } {
  const loans = db
    .prepare(
      `SELECT l.id, l.name, l.rate_micro, p.purchased_on FROM liabilities l
       JOIN properties p ON p.id = l.property_id ORDER BY l.id`,
    )
    .all() as { id: number; name: string; rate_micro: number | null; purchased_on: string | null }[]
  const balances = db.prepare('SELECT balanced_on, balance_cents FROM liability_balances WHERE liability_id = ? ORDER BY balanced_on')
  const out: LoanInterest[] = []
  const unrated: string[] = []
  for (const l of loans) {
    const rows = balances.all(l.id) as { balanced_on: string; balance_cents: number }[]
    if (rows.length === 0) continue
    if (!l.rate_micro) {
      unrated.push(l.name)
      continue
    }
    let interest = 0
    let balanceMonths = 0
    for (let m = 1; m <= 12; m++) {
      const first = `${year}-${String(m).padStart(2, '0')}-01`
      let bal: number | null = null
      for (const r of rows) if (r.balanced_on <= first) bal = r.balance_cents
      if (bal === null && (l.purchased_on === null || l.purchased_on <= first)) bal = rows[0]!.balance_cents
      if (bal === null || bal <= 0) continue
      interest += Math.round((bal * l.rate_micro) / 12_000_000)
      balanceMonths += bal
    }
    if (interest > 0) out.push({ name: l.name, rateMicro: l.rate_micro, avgBalanceCents: Math.round(balanceMonths / 12), interestCents: interest })
  }
  return { loans: out, unrated }
}

export type ItemizedBreakdown = {
  /** The trailing year the category roles are summed over: (from, through]. */
  window: { from: string; through: string }
  loans: LoanInterest[]
  unratedLoans: string[]
  mortgageInterestCents: number // before the debt limit
  mortgageDebtLimitCents: number
  mortgageDeductibleCents: number
  stateIncomeTaxCents: number
  propertyTaxCents: number
  saltCapCents: number
  saltCents: number
  charityCents: number
  charityFloorCents: number
  charityDeductibleCents: number
  totalCents: number
  roles: Roles
}

/**
 * The itemized total the ledger supports this year. `stateIncomeTaxCents` is
 * the year's state estimate; `agiCents` the year's total income (for the SALT
 * phase-down and the charitable floor). Property tax and giving are the
 * trailing twelve months, so an installment paid last December still counts
 * as this year's bill.
 */
export function deriveItemized(
  db: DbLike,
  today: string,
  filing: string,
  stateIncomeTaxCents: number,
  agiCents: number,
  roles: Roles = resolveRoles(db),
): ItemizedBreakdown {
  const from = addDaysIso(today, -365)
  const { loans, unrated } = mortgageInterestYear(db, Number(today.slice(0, 4)))
  const interest = loans.reduce((s, l) => s + l.interestCents, 0)
  const avgDebt = loans.reduce((s, l) => s + l.avgBalanceCents, 0)
  const limit = MORTGAGE_DEBT_LIMIT_CENTS / (filing === 'mfs' ? 2 : 1)
  const mortgageDeductible = avgDebt > limit ? Math.round((interest * limit) / avgDebt) : interest

  const propertyTax = roles.propertyTax ? categorySpend(db, roles.propertyTax.id, from, today) : 0
  const cap = saltCapCents(filing, agiCents)
  const salt = Math.min(cap, Math.max(0, stateIncomeTaxCents) + propertyTax)

  const charity = roles.charity ? categorySpend(db, roles.charity.id, from, today) : 0
  const charityFloor = Math.round((Math.max(0, agiCents) * CHARITY_AGI_FLOOR_MICRO) / 1_000_000)
  const charityDeductible = Math.max(0, charity - charityFloor)

  return {
    window: { from, through: today },
    loans,
    unratedLoans: unrated,
    mortgageInterestCents: interest,
    mortgageDebtLimitCents: limit,
    mortgageDeductibleCents: mortgageDeductible,
    stateIncomeTaxCents: Math.max(0, stateIncomeTaxCents),
    propertyTaxCents: propertyTax,
    saltCapCents: cap,
    saltCents: salt,
    charityCents: charity,
    charityFloorCents: charityFloor,
    charityDeductibleCents: charityDeductible,
    totalCents: mortgageDeductible + salt + charityDeductible,
    roles,
  }
}
