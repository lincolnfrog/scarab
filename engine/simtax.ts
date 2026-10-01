import {
  FEDERAL_BRACKETS_2026,
  FEDERAL_STD_DEDUCTION_2026,
  federalLtTax,
  niitCents,
  stateTaxCents,
  taxFromBrackets,
  type FilingStatus,
  type TaxSettings,
} from './tax'

/**
 * The tax rules Future v3 (copilot §4c) runs each simulated year through:
 * a lean year-tax function over the engine's own bracket tables, required
 * minimum distributions, and Social Security's claiming adjustments and
 * taxable share. Isomorphic and synchronous like the rest of engine/.
 *
 * The simulation is in real (today's) dollars and the tables are indexed for
 * inflation, so they are held constant across years — never deflated. The
 * Social Security provisional-income thresholds are the exception the law
 * makes (they aren't indexed); they're held constant too, which understates
 * how much of a benefit becomes taxable decades out.
 */

export const SIMTAX_VINTAGE = 'RMDs: IRS Pub. 590-B Table III (2022+); Social Security: 42 U.S.C. §402, §415; IRC §86'

/* =========================== year tax =========================== */

/**
 * Federal (ordinary brackets, long-term stacking, NIIT) plus state tax on a
 * year's ordinary income and long-term gains, with the standard deduction —
 * the same functions computeTax uses, without its allocations, because the
 * simulation calls this millions of times.
 */
export function makeYearTax(filing: FilingStatus, state: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>) {
  const brackets = FEDERAL_BRACKETS_2026[filing]
  const deduction = FEDERAL_STD_DEDUCTION_2026[filing]
  const gains = { netStCents: 0, netLtCents: 0 }
  return (ordinaryCents: number, ltGainCents: number): number => {
    const ord = Math.max(0, ordinaryCents)
    const lt = Math.max(0, ltGainCents)
    const total = ord + lt
    const taxable = Math.max(0, total - deduction)
    const pref = Math.min(lt, taxable)
    const taxableOrd = taxable - pref
    gains.netLtCents = lt
    return (
      taxFromBrackets(taxableOrd, brackets) +
      federalLtTax(taxableOrd, pref, filing) +
      niitCents(lt, total, filing) +
      stateTaxCents(total, state, gains).taxCents
    )
  }
}

/** The top of the federal ordinary bracket taxed at `rateMicro`, as gross ordinary income (deduction added back); null for the top bracket. */
export function bracketTopGross(filing: FilingStatus, rateMicro: number): number | null {
  const b = FEDERAL_BRACKETS_2026[filing].find((x) => x.rateMicro === rateMicro)
  if (!b || b.upToCents === null) return null
  return b.upToCents + FEDERAL_STD_DEDUCTION_2026[filing]
}

/* ============================== RMDs ============================== */

/** IRS Pub. 590-B Appendix B, Table III (Uniform Lifetime), distribution periods for ages 72–120, ×10. */
const UNIFORM_LIFETIME_X10 = [
  274, 265, 255, 246, 237, 229, 220, 211, 202, 194, 185, 177, 168, 160, 152, 144, 137, 129, 122, 115, 108, 101, 95, 89, 84,
  78, 73, 68, 64, 60, 56, 52, 49, 46, 43, 41, 39, 37, 35, 34, 33, 31, 30, 29, 28, 27, 25, 23, 20,
]

/** The distribution period for an age (72 → 27.4 … 120 and over → 2.0). */
export function uniformLifetimePeriod(age: number): number {
  const i = Math.min(UNIFORM_LIFETIME_X10.length - 1, Math.max(0, age - 72))
  return UNIFORM_LIFETIME_X10[i]! / 10
}

/**
 * The age RMDs start, by birth year (SECURE 2.0 §107): 75 for those born in
 * 1960 or later, 73 for 1951–1959, 72 before (who are already taking them).
 */
export function rmdStartAge(birthYear: number): number {
  return birthYear >= 1960 ? 75 : birthYear >= 1951 ? 73 : 72
}

/* ========================= Social Security ========================= */

/** Full retirement age in months, by birth year (42 U.S.C. §416(l)). */
export function fullRetirementAgeMonths(birthYear: number): number {
  if (birthYear >= 1960) return 67 * 12
  if (birthYear >= 1955) return 66 * 12 + (birthYear - 1954) * 2
  if (birthYear >= 1943) return 66 * 12
  return 66 * 12
}

/**
 * The benefit when claiming at `claimAge` (whole years, 62–70), as a micro
 * multiple of the benefit at full retirement age: 5/9 of 1% less a month for
 * the first 36 months early and 5/12 of 1% for each month beyond; 2/3 of 1%
 * more a month after it (8% a year), to 70.
 */
export function claimFactorMicro(birthYear: number, claimAge: number): number {
  const fra = fullRetirementAgeMonths(birthYear)
  const at = Math.min(70, Math.max(62, claimAge)) * 12
  if (at < fra) {
    const early = fra - at
    const first = Math.min(36, early)
    return Math.round(1_000_000 - (first * 1_000_000 * 5) / 900 - ((early - first) * 1_000_000 * 5) / 1200)
  }
  return Math.round(1_000_000 + ((at - fra) * 1_000_000 * 2) / 300)
}

/** IRC §86 base and adjusted-base amounts, in cents (not indexed). */
const SS_THRESHOLDS: Record<FilingStatus, [number, number]> = {
  single: [25_000_00, 34_000_00],
  hoh: [25_000_00, 34_000_00],
  mfj: [32_000_00, 44_000_00],
  mfs: [0, 0], // living with a spouse: 85% from the first dollar of provisional income
}

/**
 * The taxable part of a year's Social Security (IRC §86): provisional income
 * is the other income plus half the benefits; none is taxable under the base
 * amount, up to half between the base and adjusted base, and up to 85% above.
 */
export function taxableSocialSecurity(benefitsCents: number, otherIncomeCents: number, filing: FilingStatus): number {
  if (benefitsCents <= 0) return 0
  const [base, adjusted] = SS_THRESHOLDS[filing]
  const provisional = otherIncomeCents + benefitsCents / 2
  if (provisional <= base) return 0
  if (provisional <= adjusted) return Math.round(Math.min(0.5 * (provisional - base), 0.5 * benefitsCents))
  return Math.round(Math.min(0.85 * benefitsCents, 0.85 * (provisional - adjusted) + Math.min(0.5 * benefitsCents, 0.5 * (adjusted - base))))
}
