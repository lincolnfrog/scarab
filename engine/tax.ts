import type { DbLike } from './db'
import { computePosition, positionValueCents, type TradeInput } from './lots'
import { addMonths, ApiError } from './services'

/**
 * Tax intelligence. Same rules as the rest of engine/: isomorphic, synchronous,
 * DbLike only, integer cents, rates in micro (1e6 = 100%). Everything is
 * DERIVED at read time from the ledger (trades, vests, transactions, prices) +
 * one settings blob — no tax number is ever stored.
 *
 * This is estimation for planning, not tax preparation. Every bracket table
 * carries a vintage and the UI must say so.
 */

/* ================================ data ================================ */

export const TAX_DATA_VINTAGE = 'Federal: tax year 2026 (Rev. Proc. 2025-32)'

export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh'

type Bracket = { upToCents: number | null; rateMicro: number } // null = ∞
const b = (upToDollars: number | null, ratePct: number): Bracket => ({
  upToCents: upToDollars === null ? null : upToDollars * 100,
  rateMicro: Math.round(ratePct * 10_000),
})

// 2026 federal ordinary-income brackets (IRS Rev. Proc. 2025-32).
export const FEDERAL_BRACKETS_2026: Record<FilingStatus, Bracket[]> = {
  single: [b(12_400, 10), b(50_400, 12), b(105_700, 22), b(201_775, 24), b(256_225, 32), b(640_600, 35), b(null, 37)],
  mfj: [b(24_800, 10), b(100_800, 12), b(211_400, 22), b(403_550, 24), b(512_450, 32), b(768_700, 35), b(null, 37)],
  mfs: [b(12_400, 10), b(50_400, 12), b(105_700, 22), b(201_775, 24), b(256_225, 32), b(384_350, 35), b(null, 37)],
  hoh: [b(17_700, 10), b(67_450, 12), b(105_700, 22), b(201_775, 24), b(256_200, 32), b(640_600, 35), b(null, 37)],
}

export const FEDERAL_STD_DEDUCTION_2026: Record<FilingStatus, number> = {
  single: 16_100_00,
  mfj: 32_200_00,
  mfs: 16_100_00,
  hoh: 24_150_00,
}

// Long-term capital gains (and qualified dividends) stack on top of ordinary
// taxable income. [end of 0% band, end of 15% band] in cents; above → 20%.
export const FEDERAL_LT_THRESHOLDS_2026: Record<FilingStatus, [number, number]> = {
  single: [49_450_00, 545_500_00],
  mfj: [98_900_00, 613_700_00],
  mfs: [49_450_00, 306_850_00],
  hoh: [66_200_00, 579_600_00],
}

// Net investment income tax: 3.8% over MAGI threshold (statutory, not indexed).
export const NIIT_RATE_MICRO = 38_000
export const NIIT_THRESHOLD: Record<FilingStatus, number> = {
  single: 200_000_00,
  mfj: 250_000_00,
  mfs: 125_000_00,
  hoh: 200_000_00,
}

/* ------------------------- state bracket tables ------------------------- */

/** What the state-level hooks get to see beyond the income total. */
export type StateCtx = { incomeCents: number; netStCents: number; netLtCents: number }

export type StateTable = {
  vintage: string
  brackets: Record<FilingStatus, Bracket[]>
  /** Standard deduction (or, where the state has none, the personal exemption) in cents. */
  deduction: Record<FilingStatus, number>
  /** Income-dependent deduction (WI's sliding scale, CT's exemption phase-out, SC's SCIAD); wins over `deduction`. */
  deductionFor?: (incomeCents: number, filing: FilingStatus) => number
  /** Income the state doesn't tax (SC excludes 44% of net long-term gains). Returns cents to subtract. */
  exclusion?: (ctx: StateCtx) => number
  /** Anything the estimate leaves out that a filer in this state should know. */
  note: string
  /** Extra tax (CA's Mental Health Services Tax on taxable income, MD's capital-gains surcharge). */
  surtax?: (taxableCents: number, ctx: StateCtx) => number
}

const dollars = (cents: number) => cents / 100

// California — FTB 2025 Tax Rate Schedules X/Y/Z and 2025 standard deduction.
// The FTB publishes each year's indexed schedule late in that year; as of
// September 2026 the 2026 schedule is not out (the EDD's 2026 withholding
// tables still carry these thresholds). To swap in 2026: replace the four
// arrays and the deduction line below and bump the vintage — nothing else
// references them.
const CA_SINGLE = [b(11_079, 1), b(26_264, 2), b(41_452, 4), b(57_542, 6), b(72_724, 8), b(371_479, 9.3), b(445_771, 10.3), b(742_953, 11.3), b(null, 12.3)]
const CA_MHST_THRESHOLD = 1_000_000_00 // 1% on taxable income above $1M, every status
const CA_MHST_RATE_MICRO = 10_000
const CA: StateTable = {
  vintage: 'CA 2025 (FTB; 2026 schedule not yet published)',
  brackets: {
    single: CA_SINGLE,
    mfs: CA_SINGLE,
    mfj: [b(22_158, 1), b(52_528, 2), b(82_904, 4), b(115_084, 6), b(145_448, 8), b(742_958, 9.3), b(891_542, 10.3), b(1_485_906, 11.3), b(null, 12.3)],
    hoh: [b(22_173, 1), b(52_530, 2), b(67_716, 4), b(83_805, 6), b(98_990, 8), b(505_208, 9.3), b(606_251, 10.3), b(1_010_417, 11.3), b(null, 12.3)],
  },
  deduction: { single: 5_706_00, mfs: 5_706_00, mfj: 11_412_00, hoh: 11_412_00 },
  note: 'Includes the 1% Mental Health Services Tax above $1M taxable. Exemption credits are not modeled.',
  surtax: (taxable) =>
    taxable > CA_MHST_THRESHOLD ? Math.round(((taxable - CA_MHST_THRESHOLD) * CA_MHST_RATE_MICRO) / 1_000_000) : 0,
}

// New York — 2026 rate schedules from Form IT-2105-I (the five lowest rates
// dropped 0.1 pt for 2026 under the FY2026 budget; another 0.1 pt in 2027).
const NY_SINGLE = [b(8_500, 3.9), b(11_700, 4.4), b(13_900, 5.15), b(80_650, 5.4), b(215_400, 5.9), b(1_077_550, 6.85), b(5_000_000, 9.65), b(25_000_000, 10.3), b(null, 10.9)]
const NY: StateTable = {
  vintage: 'NY 2026 (Form IT-2105-I)',
  brackets: {
    single: NY_SINGLE,
    mfs: NY_SINGLE,
    mfj: [b(17_150, 3.9), b(23_600, 4.4), b(27_900, 5.15), b(161_550, 5.4), b(323_200, 5.9), b(2_155_350, 6.85), b(5_000_000, 9.65), b(25_000_000, 10.3), b(null, 10.9)],
    hoh: [b(12_800, 3.9), b(17_650, 4.4), b(20_900, 5.15), b(107_650, 5.4), b(269_300, 5.9), b(1_616_450, 6.85), b(5_000_000, 9.65), b(25_000_000, 10.3), b(null, 10.9)],
  },
  deduction: { single: 8_000_00, mfs: 8_000_00, mfj: 16_050_00, hoh: 11_200_00 },
  note: 'New York City and Yonkers resident taxes are not modeled, nor is the tax-benefit recapture that flattens the rate above ~$107k of NY AGI — high earners will see a slightly low estimate.',
}

// New Jersey — gross income tax, statutory (not indexed). No standard
// deduction; the $1,000-per-taxpayer personal exemption stands in.
const NJ_SINGLE = [b(20_000, 1.4), b(35_000, 1.75), b(40_000, 3.5), b(75_000, 5.525), b(500_000, 6.37), b(1_000_000, 8.97), b(null, 10.75)]
const NJ_JOINT = [b(20_000, 1.4), b(50_000, 1.75), b(70_000, 2.45), b(80_000, 3.5), b(150_000, 5.525), b(500_000, 6.37), b(1_000_000, 8.97), b(null, 10.75)]
const NJ: StateTable = {
  vintage: 'NJ 2026 (statutory)',
  brackets: { single: NJ_SINGLE, mfs: NJ_SINGLE, mfj: NJ_JOINT, hoh: NJ_JOINT },
  deduction: { single: 1_000_00, mfs: 1_000_00, mfj: 2_000_00, hoh: 1_000_00 },
  note: 'New Jersey has no standard deduction (personal exemptions applied instead) and neither nets capital losses against other income nor carries them forward — a net-loss year is estimated low.',
}

// Oregon — 2026 rate charts S and J from Publication OR-ESTIMATE.
const OR_S = [b(4_550, 4.75), b(11_400, 6.75), b(125_000, 8.75), b(null, 9.9)]
const OR_J = [b(9_100, 4.75), b(22_800, 6.75), b(250_000, 8.75), b(null, 9.9)]
const OR: StateTable = {
  vintage: 'OR 2026 (Publication OR-ESTIMATE)',
  brackets: { single: OR_S, mfs: OR_S, mfj: OR_J, hoh: OR_J },
  deduction: { single: 2_900_00, mfs: 2_900_00, mfj: 5_800_00, hoh: 4_650_00 },
  note: "Oregon's federal-tax subtraction (up to $8,750), the $260-per-exemption credit, and Portland-area local taxes are not modeled.",
}

// Minnesota — 2026 brackets and standard deduction (Dept. of Revenue, Dec 2025).
const MN: StateTable = {
  vintage: 'MN 2026 (Dept. of Revenue)',
  brackets: {
    single: [b(33_310, 5.35), b(109_430, 6.8), b(203_150, 7.85), b(null, 9.85)],
    mfj: [b(48_700, 5.35), b(193_480, 6.8), b(337_930, 7.85), b(null, 9.85)],
    mfs: [b(24_350, 5.35), b(96_740, 6.8), b(168_965, 7.85), b(null, 9.85)],
    hoh: [b(41_010, 5.35), b(164_800, 6.8), b(270_060, 7.85), b(null, 9.85)],
  },
  deduction: { single: 15_300_00, mfs: 15_300_00, mfj: 30_600_00, hoh: 23_000_00 },
  note: "Minnesota's 1% tax on net investment income above $1M and the standard-deduction phase-out for high incomes are not modeled.",
}

// Hawaii — Act 46 (2024) schedule in force for 2025–2026; the standard
// deduction doubled for 2026. Brackets widen again in 2027, 2029, 2031.
const HI_SINGLE = [b(9_600, 1.4), b(14_400, 3.2), b(19_200, 5.5), b(24_000, 6.4), b(36_000, 6.8), b(48_000, 7.2), b(125_000, 7.6), b(175_000, 7.9), b(225_000, 8.25), b(275_000, 9), b(325_000, 10), b(null, 11)]
const HI: StateTable = {
  vintage: 'HI 2026 (Act 46 schedule)',
  brackets: {
    single: HI_SINGLE,
    mfs: HI_SINGLE,
    mfj: [b(19_200, 1.4), b(28_800, 3.2), b(38_400, 5.5), b(48_000, 6.4), b(72_000, 6.8), b(96_000, 7.2), b(250_000, 7.6), b(350_000, 7.9), b(450_000, 8.25), b(550_000, 9), b(650_000, 10), b(null, 11)],
    hoh: [b(14_400, 1.4), b(21_600, 3.2), b(28_800, 5.5), b(36_000, 6.4), b(54_000, 6.8), b(72_000, 7.2), b(187_500, 7.6), b(262_500, 7.9), b(337_500, 8.25), b(412_500, 9), b(487_500, 10), b(null, 11)],
  },
  deduction: { single: 8_000_00, mfs: 8_000_00, mfj: 16_000_00, hoh: 12_000_00 },
  note: "Hawaii's 7.25% alternative rate on long-term gains is not modeled — a gains-heavy year is estimated high. Brackets widen again in 2027 (Act 46).",
}

// Virginia — statutory brackets (never indexed); the standard deduction was
// raised to $8,750/$17,500 for tax years 2025–2026 by the 2025 budget.
const VA_ALL = [b(3_000, 2), b(5_000, 3), b(17_000, 5), b(null, 5.75)]
const VA: StateTable = {
  vintage: 'VA 2026 (statutory; 2025–26 standard deduction)',
  brackets: { single: VA_ALL, mfs: VA_ALL, mfj: VA_ALL, hoh: VA_ALL },
  deduction: { single: 8_750_00, mfs: 8_750_00, mfj: 17_500_00, hoh: 8_750_00 },
  note: "Virginia's $930-per-person exemption is not modeled.",
}

// Maryland — the FY2026 budget (2025) added 6.25% and 6.5% tiers, raised the
// standard deduction to $3,350/$6,700, and put a 2% surcharge on net capital
// gains for filers over $350k federal AGI. County income tax comes on top.
const MD_SINGLE = [b(1_000, 2), b(2_000, 3), b(3_000, 4), b(100_000, 4.75), b(125_000, 5), b(150_000, 5.25), b(250_000, 5.5), b(500_000, 5.75), b(1_000_000, 6.25), b(null, 6.5)]
const MD_JOINT = [b(1_000, 2), b(2_000, 3), b(3_000, 4), b(150_000, 4.75), b(175_000, 5), b(225_000, 5.25), b(300_000, 5.5), b(600_000, 5.75), b(1_200_000, 6.25), b(null, 6.5)]
const MD_SURCHARGE_AGI = 350_000_00
const MD: StateTable = {
  vintage: 'MD 2026 (2025 budget act)',
  brackets: { single: MD_SINGLE, mfs: MD_SINGLE, mfj: MD_JOINT, hoh: MD_JOINT },
  deduction: { single: 3_350_00, mfs: 3_350_00, mfj: 6_700_00, hoh: 6_700_00 },
  note: 'Includes the 2% capital-gains surcharge above $350k AGI. County income tax (2.25%–3.3%) and the $3,200-per-person exemption are not modeled — the estimate runs low by roughly the county rate.',
  surtax: (_taxable, ctx) =>
    ctx.incomeCents > MD_SURCHARGE_AGI
      ? Math.round((Math.max(0, ctx.netStCents + ctx.netLtCents) * 20_000) / 1_000_000)
      : 0,
}

// Ohio — HB 96 (2025): from 2026 a flat 2.75% on nonbusiness income above the
// unindexed $26,050 zero bracket.
const OH_ALL = [b(26_050, 0), b(null, 2.75)]
const OH: StateTable = {
  vintage: 'OH 2026 (HB 96 flat rate)',
  brackets: { single: OH_ALL, mfs: OH_ALL, mfj: OH_ALL, hoh: OH_ALL },
  deduction: { single: 0, mfs: 0, mfj: 0, hoh: 0 },
  note: 'Personal exemptions ($1,900–$2,400 each, gone above $500k) and school-district/municipal income taxes are not modeled.',
}

// Wisconsin — 2025 rate schedules and the sliding standard deduction from the
// 2025 Form 1 instructions (max − rate × (income − start), floored at zero;
// head of household never gets less than a single filer would).
const WI_SINGLE = [b(14_680, 3.5), b(50_480, 4.4), b(323_290, 5.3), b(null, 7.65)]
const WI_SLIDE: Record<FilingStatus, [max: number, rateMicro: number, start: number]> = {
  single: [13_560_00, 120_000, 19_550_00],
  hoh: [17_520_00, 225_150, 19_550_00],
  mfj: [25_110_00, 197_780, 28_210_00],
  mfs: [11_930_00, 197_780, 13_390_00],
}
const wiDeduction = (incomeCents: number, f: FilingStatus): number => {
  const [max, rate, start] = WI_SLIDE[f]
  return Math.max(0, max - Math.round((Math.max(0, incomeCents - start) * rate) / 1_000_000))
}
const WI: StateTable = {
  vintage: 'WI 2025 (Form 1 instructions)',
  brackets: {
    single: WI_SINGLE,
    hoh: WI_SINGLE,
    mfj: [b(19_580, 3.5), b(67_300, 4.4), b(431_060, 5.3), b(null, 7.65)],
    mfs: [b(9_790, 3.5), b(33_650, 4.4), b(215_530, 5.3), b(null, 7.65)],
  },
  deduction: { single: 0, mfs: 0, mfj: 0, hoh: 0 },
  deductionFor: (income, f) => (f === 'hoh' ? Math.max(wiDeduction(income, 'hoh'), wiDeduction(income, 'single')) : wiDeduction(income, f)),
  note: "Wisconsin's sliding standard deduction is modeled (it reaches zero around $133k single / $155k joint). 2026 indexed figures are not yet folded in.",
}

// Connecticut — statutory rates (unchanged since the 2024 cut). No standard
// deduction; the personal exemption loses $1,000 for each $1,000 (or part) of
// AGI over a threshold, so it is gone for anyone this app is built for.
const CT_EXEMPTION: Record<FilingStatus, [base: number, start: number]> = {
  single: [15_000_00, 30_000_00],
  mfs: [12_000_00, 24_000_00],
  mfj: [24_000_00, 48_000_00],
  hoh: [19_000_00, 38_000_00],
}
const CT: StateTable = {
  vintage: 'CT 2026 (statutory)',
  brackets: {
    single: [b(10_000, 2), b(50_000, 4.5), b(100_000, 5.5), b(200_000, 6), b(250_000, 6.5), b(500_000, 6.9), b(null, 6.99)],
    mfs: [b(10_000, 2), b(50_000, 4.5), b(100_000, 5.5), b(200_000, 6), b(250_000, 6.5), b(500_000, 6.9), b(null, 6.99)],
    mfj: [b(20_000, 2), b(100_000, 4.5), b(200_000, 5.5), b(400_000, 6), b(500_000, 6.5), b(1_000_000, 6.9), b(null, 6.99)],
    hoh: [b(16_000, 2), b(80_000, 4.5), b(160_000, 5.5), b(320_000, 6), b(400_000, 6.5), b(800_000, 6.9), b(null, 6.99)],
  },
  deduction: { single: 0, mfs: 0, mfj: 0, hoh: 0 },
  deductionFor: (income, f) => {
    const [base, start] = CT_EXEMPTION[f]
    const steps = Math.ceil(Math.max(0, income - start) / 1_000_00)
    return Math.max(0, base - steps * 1_000_00)
  },
  note: "Connecticut's benefit recapture (which phases out the lower rates above $105k/$168k/$210k of AGI for single/HoH/joint filers) is not modeled — high earners are estimated slightly low.",
}

// South Carolina — Act 110 (H.4216, signed March 2026): two brackets from 2026
// and the SC Income Adjusted Deduction, which shrinks with federal AGI (the
// reduction rounds down to $10). 44% of net long-term gains stay untaxed.
const SC_ALL = [b(30_000, 1.99), b(null, 5.21)]
const SCIAD: Record<FilingStatus, [base: number, start: number, span: number]> = {
  single: [15_000_00, 40_000_00, 55_000_00],
  mfs: [15_000_00, 40_000_00, 55_000_00],
  hoh: [22_500_00, 60_000_00, 82_500_00],
  mfj: [30_000_00, 80_000_00, 110_000_00],
}
const SC: StateTable = {
  vintage: 'SC 2026 (Act 110)',
  brackets: { single: SC_ALL, mfs: SC_ALL, mfj: SC_ALL, hoh: SC_ALL },
  deduction: { single: 0, mfs: 0, mfj: 0, hoh: 0 },
  deductionFor: (income, f) => {
    const [base, start, span] = SCIAD[f]
    if (income <= start) return base
    if (income >= start + span) return 0
    const reduction = Math.floor((base * (income - start)) / span / 10_00) * 10_00
    return base - reduction
  },
  exclusion: (ctx) => Math.round((Math.max(0, ctx.netLtCents) * 440_000) / 1_000_000),
  note: 'Includes the 44% long-term gain exclusion and the income-adjusted deduction. Dependent exemptions are not modeled.',
}

// District of Columbia — 2026 D-40ES rate table; DC set its own standard
// deduction ($16,100 / $24,150 / $32,200) after decoupling from OBBBA.
const DC_ALL = [b(10_000, 4), b(40_000, 6), b(60_000, 6.5), b(250_000, 8.5), b(500_000, 9.25), b(1_000_000, 9.75), b(null, 10.75)]
const DC: StateTable = {
  vintage: 'DC 2026 (D-40ES booklet)',
  brackets: { single: DC_ALL, mfs: DC_ALL, mfj: DC_ALL, hoh: DC_ALL },
  deduction: { single: 16_100_00, mfs: 16_100_00, mfj: 32_200_00, hoh: 24_150_00 },
  note: 'DC has no personal exemption and taxes gains as ordinary income.',
}

export const STATE_TABLES: Record<string, StateTable> = { CA, NY, NJ, OR, MN, HI, VA, MD, OH, WI, CT, SC, DC }

export type StateInfo =
  | { code: string; name: string; kind: 'none' }
  | { code: string; name: string; kind: 'flat'; rateMicro: number }
  | { code: string; name: string; kind: 'brackets'; vintage: string; note: string }
  | { code: string; name: string; kind: 'custom' }

const flat = (code: string, name: string, ratePct: number): StateInfo => ({
  code, name, kind: 'flat', rateMicro: Math.round(ratePct * 10_000),
})
const none = (code: string, name: string): StateInfo => ({ code, name, kind: 'none' })
const custom = (code: string, name: string): StateInfo => ({ code, name, kind: 'custom' })
const bracketed = (code: string, name: string): StateInfo => {
  const t = STATE_TABLES[code]
  if (!t) throw new Error(`no bracket table for ${code}`)
  return { code, name, kind: 'brackets', vintage: t.vintage, note: t.note }
}

// States where wages + capital gains face no broad income tax. (WA levies a
// 7%+ excise on large LT gains and MA adds a 4% surtax over ~$1M — both noted
// in the UI, neither modeled.)
export const STATES: StateInfo[] = [
  none('NONE', 'No state'),
  bracketed('CA', 'California'),
  bracketed('CT', 'Connecticut'), bracketed('DC', 'District of Columbia'), bracketed('HI', 'Hawaii'),
  bracketed('MD', 'Maryland'), bracketed('MN', 'Minnesota'), bracketed('NJ', 'New Jersey'),
  bracketed('NY', 'New York'), bracketed('OH', 'Ohio'), bracketed('OR', 'Oregon'),
  bracketed('SC', 'South Carolina'), bracketed('VA', 'Virginia'), bracketed('WI', 'Wisconsin'),
  none('AK', 'Alaska'), none('FL', 'Florida'), none('NV', 'Nevada'), none('NH', 'New Hampshire'),
  none('SD', 'South Dakota'), none('TN', 'Tennessee'), none('TX', 'Texas'), none('WA', 'Washington'), none('WY', 'Wyoming'),
  flat('AZ', 'Arizona', 2.5), flat('CO', 'Colorado', 4.4), flat('GA', 'Georgia', 5.19), flat('ID', 'Idaho', 5.695),
  flat('IL', 'Illinois', 4.95), flat('IN', 'Indiana', 3.0), flat('IA', 'Iowa', 3.8), flat('KY', 'Kentucky', 4.0),
  flat('LA', 'Louisiana', 3.0), flat('MA', 'Massachusetts', 5.0), flat('MI', 'Michigan', 4.25), flat('MS', 'Mississippi', 4.4),
  flat('NC', 'North Carolina', 4.25), flat('PA', 'Pennsylvania', 3.07), flat('UT', 'Utah', 4.55),
  custom('AL', 'Alabama'), custom('AR', 'Arkansas'), custom('DE', 'Delaware'), custom('KS', 'Kansas'),
  custom('ME', 'Maine'), custom('MO', 'Missouri'), custom('MT', 'Montana'), custom('NE', 'Nebraska'),
  custom('NM', 'New Mexico'), custom('ND', 'North Dakota'), custom('OK', 'Oklahoma'),
  custom('RI', 'Rhode Island'), custom('VT', 'Vermont'), custom('WV', 'West Virginia'),
]

/* ------------------------ estimated-payment rules ------------------------ */

export type EstRule = {
  label: string
  /** Share of the required annual payment due at each of the four dates (percent). */
  weights: [number, number, number, number]
  /** No estimated payments are required when tax less withholding is under this. */
  thresholdCents: (f: FilingStatus) => number
  /** Prior-year multiplier (micro) for filers whose prior-year AGI was over $150k ($75k MFS). */
  highIncomePriorMicro: number
  /** Current-year AGI at or above which the prior-year safe harbor is unavailable. */
  forceCurrentAgiCents?: (f: FilingStatus) => number
  /** True when we don't have this state's actual rule and are assuming the federal shape. */
  assumed: boolean
}

export const FEDERAL_EST_RULE: EstRule = {
  label: 'Federal (Form 1040-ES)',
  weights: [25, 25, 25, 25],
  thresholdCents: () => 1_000_00,
  highIncomePriorMicro: 1_100_000,
  assumed: false,
}

// California, Form 540-ES: installments 30/40/0/30; 110% of prior year when
// prior AGI > $150k ($75k MFS); filers with current AGI ≥ $1M ($500k MFS) must
// use 90% of the current year; nothing due if the shortfall is under $500 ($250 MFS).
const CA_EST_RULE: EstRule = {
  label: 'California (Form 540-ES)',
  weights: [30, 40, 0, 30],
  thresholdCents: (f) => (f === 'mfs' ? 250_00 : 500_00),
  highIncomePriorMicro: 1_100_000,
  forceCurrentAgiCents: (f) => (f === 'mfs' ? 500_000_00 : 1_000_000_00),
  assumed: false,
}

const GENERIC_STATE_EST_RULE: EstRule = {
  label: 'State (federal-style schedule assumed)',
  weights: [25, 25, 25, 25],
  thresholdCents: () => 1_000_00,
  highIncomePriorMicro: 1_100_000,
  assumed: true,
}

export function stateEstRule(stateCode: string): EstRule | null {
  const info = STATES.find((s) => s.code === stateCode)
  if (!info || info.kind === 'none') return null
  return stateCode === 'CA' ? CA_EST_RULE : GENERIC_STATE_EST_RULE
}

/* ============================== settings ============================== */

export type TaxSettings = {
  filingStatus: FilingStatus
  state: string // code from STATES
  customStateRateMicro: number // marginal rate used when the state is 'custom'
  wagesAnnualCents: number // projected full-year W-2 gross, EXCLUDING RSU vests
  otherIncomeCents: number // interest/other ordinary income not in the ledger
  deductionMode: 'standard' | 'itemized'
  itemizedCents: number
  withheldFederalCents: number // projected full-year federal withholding (incl. RSU supplemental)
  withheldStateCents: number
  estPaidFederalCents: number // federal estimated payments already made this year
  estPaidStateCents: number // state estimated payments already made this year
  priorYearTaxFederalCents: number // total federal tax from last year's return (safe harbor)
  priorYearTaxStateCents: number // total state tax from last year's return (state safe harbor)
  priorYearAgiOver150k: boolean // 110% safe harbor instead of 100%
  qualifiedDividendShareMicro: number // share of 'Dividends & interest' that is qualified (0 = all ordinary)
}

export const TAX_DEFAULTS: TaxSettings = {
  filingStatus: 'mfj',
  state: 'CA',
  customStateRateMicro: 0,
  wagesAnnualCents: 0,
  otherIncomeCents: 0,
  deductionMode: 'standard',
  itemizedCents: 0,
  withheldFederalCents: 0,
  withheldStateCents: 0,
  estPaidFederalCents: 0,
  estPaidStateCents: 0,
  priorYearTaxFederalCents: 0,
  priorYearTaxStateCents: 0,
  priorYearAgiOver150k: true,
  qualifiedDividendShareMicro: 0,
}

const SETTINGS_KEY = 'tax'

export function getTaxSettings(db: DbLike): TaxSettings {
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(SETTINGS_KEY) as
    | { value: string }
    | undefined
  if (!row) return { ...TAX_DEFAULTS }
  try {
    return { ...TAX_DEFAULTS, ...(JSON.parse(row.value) as Partial<TaxSettings>) }
  } catch {
    return { ...TAX_DEFAULTS }
  }
}

export function putTaxSettings(db: DbLike, body: Partial<TaxSettings>) {
  const cur = getTaxSettings(db)
  const next: TaxSettings = { ...cur }
  if (body.filingStatus !== undefined) {
    if (!['single', 'mfj', 'mfs', 'hoh'].includes(body.filingStatus)) throw new ApiError(400, 'bad filingStatus')
    next.filingStatus = body.filingStatus
  }
  if (body.state !== undefined) {
    if (!STATES.some((s) => s.code === body.state)) throw new ApiError(400, 'unknown state code')
    next.state = body.state
  }
  if (body.deductionMode !== undefined) {
    if (!['standard', 'itemized'].includes(body.deductionMode)) throw new ApiError(400, 'bad deductionMode')
    next.deductionMode = body.deductionMode
  }
  if (body.priorYearAgiOver150k !== undefined) next.priorYearAgiOver150k = !!body.priorYearAgiOver150k
  const ints: (keyof TaxSettings)[] = [
    'customStateRateMicro', 'wagesAnnualCents', 'otherIncomeCents', 'itemizedCents',
    'withheldFederalCents', 'withheldStateCents', 'estPaidFederalCents', 'estPaidStateCents',
    'priorYearTaxFederalCents', 'priorYearTaxStateCents', 'qualifiedDividendShareMicro',
  ]
  for (const k of ints) {
    const v = body[k]
    if (v === undefined) continue
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ApiError(400, `${k} must be a non-negative integer`)
    ;(next as Record<string, unknown>)[k] = v
  }
  if (next.qualifiedDividendShareMicro > 1_000_000)
    throw new ApiError(400, 'qualifiedDividendShareMicro must be at most 1000000 (100%)')
  db.prepare(
    'INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(SETTINGS_KEY, JSON.stringify(next))
  return { ok: true as const, settings: next }
}

/* ============================ bracket math ============================ */

export function taxFromBrackets(taxableCents: number, brackets: Bracket[]): number {
  if (taxableCents <= 0) return 0
  let tax = 0
  let prev = 0
  for (const br of brackets) {
    const top = br.upToCents ?? Infinity
    const slice = Math.min(taxableCents, top) - prev
    if (slice <= 0) break
    tax += (slice * br.rateMicro) / 1_000_000
    prev = top
  }
  return Math.round(tax)
}

/** LT gains and qualified dividends stack on top of ordinary taxable income
 *  across the 0/15/20 bands. */
export function federalLtTax(ordTaxableCents: number, ltTaxableCents: number, filing: FilingStatus): number {
  if (ltTaxableCents <= 0) return 0
  const [t0, t15] = FEDERAL_LT_THRESHOLDS_2026[filing]
  const start = Math.max(0, ordTaxableCents)
  const end = start + ltTaxableCents
  const inBand = (lo: number, hi: number) => Math.max(0, Math.min(end, hi) - Math.max(start, lo))
  return Math.round((inBand(t0, t15) * 150_000 + inBand(t15, Infinity) * 200_000) / 1_000_000)
}

export function niitCents(niiCents: number, magiCents: number, filing: FilingStatus): number {
  if (niiCents <= 0) return 0
  const over = magiCents - NIIT_THRESHOLD[filing]
  if (over <= 0) return 0
  return Math.round((Math.min(niiCents, over) * NIIT_RATE_MICRO) / 1_000_000)
}

/** State income tax on total income (states tax gains and qualified
 *  dividends as ordinary, with the exceptions the tables encode).
 *  `mhstCents` is any surtax (CA MHST, MD gains surcharge), included in `taxCents`. */
export function stateTaxCents(
  totalIncomeCents: number,
  settings: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>,
  gains: { netStCents: number; netLtCents: number } = { netStCents: 0, netLtCents: 0 },
): { taxCents: number; mhstCents: number } {
  const info = STATES.find((s) => s.code === settings.state)
  if (!info || info.kind === 'none') return { taxCents: 0, mhstCents: 0 }
  if (info.kind === 'flat')
    return { taxCents: Math.round((Math.max(0, totalIncomeCents) * info.rateMicro) / 1_000_000), mhstCents: 0 }
  if (info.kind === 'custom')
    return {
      taxCents: Math.round((Math.max(0, totalIncomeCents) * settings.customStateRateMicro) / 1_000_000),
      mhstCents: 0,
    }
  const table = STATE_TABLES[info.code]!
  const ctx: StateCtx = { incomeCents: totalIncomeCents, ...gains }
  const f = settings.filingStatus
  const deduction = table.deductionFor ? table.deductionFor(totalIncomeCents, f) : table.deduction[f]
  const excluded = table.exclusion ? table.exclusion(ctx) : 0
  const taxable = Math.max(0, totalIncomeCents - excluded - deduction)
  const base = taxFromBrackets(taxable, table.brackets[f])
  const surtax = table.surtax ? table.surtax(taxable, ctx) : 0
  return { taxCents: base + surtax, mhstCents: surtax }
}

/* ======================= the whole-year picture ======================= */

export type TaxInputs = {
  filing: FilingStatus
  ordinaryCents: number // wages + RSU vests + other ordinary + non-qualified div/interest
  stGainCents: number // net short-term (may be negative)
  ltGainCents: number // net long-term (may be negative)
  qualifiedDividendCents?: number // taxed at LT rates federally; ordinary for states; NOT in ordinaryCents
  investmentIncomeCents: number // all dividends/interest, qualified or not (for NIIT)
  deductionCents: number
  state: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>
}

export type TaxComputed = {
  netStCents: number
  netLtCents: number
  capLossUsedCents: number // capital loss applied against ordinary (≤ $3,000)
  capLossCarryCents: number
  taxableOrdinaryCents: number
  taxableLtCents: number // everything taxed at the preferential 0/15/20 rates: LT gains + qualified dividends
  qualifiedDividendCents: number
  fedOrdinaryCents: number
  fedLtCents: number
  niitCents: number
  fedTotalCents: number
  stateCents: number
  mhstCents: number
  totalCents: number
}

const CAP_LOSS_LIMIT = 3_000_00

/** Capital-gain netting per §1211/1222: ST and LT net separately, then a net
 *  loss on one side offsets the other; an overall net loss offsets up to
 *  $3,000 of ordinary income, the rest carries forward. */
export function netCapitalGains(stCents: number, ltCents: number) {
  let st = stCents
  let lt = ltCents
  if (st < 0 && lt > 0) { lt += st; st = 0; if (lt < 0) { st = lt; lt = 0 } }
  else if (lt < 0 && st > 0) { st += lt; lt = 0; if (st < 0) { lt = st; st = 0 } }
  const netTotal = st + lt
  let capLossUsed = 0
  let capLossCarry = 0
  if (netTotal < 0) {
    capLossUsed = Math.min(CAP_LOSS_LIMIT, -netTotal)
    capLossCarry = -netTotal - capLossUsed
    st = 0
    lt = 0
  }
  return { netStCents: st, netLtCents: lt, capLossUsedCents: capLossUsed, capLossCarryCents: capLossCarry }
}

export function computeTax(i: TaxInputs): TaxComputed {
  const qualified = Math.max(0, i.qualifiedDividendCents ?? 0)
  const netted = netCapitalGains(i.stGainCents, i.ltGainCents)
  const ordinaryAfterLoss = i.ordinaryCents - netted.capLossUsedCents
  const totalIncome = ordinaryAfterLoss + netted.netStCents + netted.netLtCents + qualified
  const taxableTotal = Math.max(0, totalIncome - i.deductionCents)
  // The deduction comes out of ordinary income first; what's left at the
  // preferential rates is LT gains + qualified dividends.
  const taxablePreferred = Math.min(netted.netLtCents + qualified, taxableTotal)
  const taxableOrd = taxableTotal - taxablePreferred
  const fedOrdinary = taxFromBrackets(taxableOrd, FEDERAL_BRACKETS_2026[i.filing])
  const fedLt = federalLtTax(taxableOrd, taxablePreferred, i.filing)
  const nii = Math.max(0, netted.netStCents + netted.netLtCents + Math.max(0, i.investmentIncomeCents))
  const niit = niitCents(nii, totalIncome, i.filing)
  const st = stateTaxCents(totalIncome, i.state, { netStCents: netted.netStCents, netLtCents: netted.netLtCents })
  const fedTotal = fedOrdinary + fedLt + niit
  return {
    ...netted,
    taxableOrdinaryCents: taxableOrd,
    taxableLtCents: taxablePreferred,
    qualifiedDividendCents: qualified,
    fedOrdinaryCents: fedOrdinary,
    fedLtCents: fedLt,
    niitCents: niit,
    fedTotalCents: fedTotal,
    stateCents: st.taxCents,
    mhstCents: st.mhstCents,
    totalCents: fedTotal + st.taxCents,
  }
}

/** Marginal rates by finite difference: the tax on the next $1,000 of each
 *  kind of income, expressed in micro. Robust to bracket edges and NIIT. */
export function marginalRates(i: TaxInputs) {
  const D = 1_000_00
  const base = computeTax(i).totalCents
  const bump = (patch: Partial<TaxInputs>) =>
    Math.round(((computeTax({ ...i, ...patch }).totalCents - base) * 1_000_000) / D)
  return {
    ordinaryMicro: bump({ ordinaryCents: i.ordinaryCents + D }),
    stMicro: bump({ stGainCents: i.stGainCents + D }),
    ltMicro: bump({ ltGainCents: i.ltGainCents + D }),
  }
}

/* ===================== ledger-derived year picture ==================== */

const DAY = 86400000
const shiftDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10)

/** Sum of this year's RSU vest income: vest trades are buys at vest-day value,
 *  identifiable by their note or by the legacy rsu_vests linkage. */
function rsuIncomeYtd(db: DbLike, year: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(total_cents), 0) AS s FROM trades
       WHERE side = 'buy' AND traded_on LIKE ?
         AND (note = 'RSU vest'
              OR id IN (SELECT converted_trade_id FROM rsu_vests WHERE converted_trade_id IS NOT NULL))`,
    )
    .get(`${year}%`) as { s: number }
  return r.s
}

export type VestEvent = {
  symbol: string
  account: string
  vest_on: string
  qty_micro: number
  cents: number | null // null when the asset has no price yet
}

/** The rest of this year's vests, from each unvested position's cadence
 *  ("N shares every M months, next on D"), valued at the latest price.
 *  Events on or before today are skipped — those belong to the ledger. */
export function projectVests(db: DbLike, today: string): { events: VestEvent[]; cents: number; unpriced: number } {
  const rows = db
    .prepare(
      `SELECT u.qty_micro, u.next_vest_on, u.vest_every_months, u.vest_qty_micro, a.symbol, ia.name AS account,
              (SELECT close_cents FROM prices WHERE asset_id = a.id ORDER BY priced_on DESC LIMIT 1) AS price_cents
       FROM unvested_positions u
       JOIN assets a ON a.id = u.asset_id
       JOIN invest_accounts ia ON ia.id = u.invest_account_id
       WHERE u.next_vest_on IS NOT NULL AND u.vest_every_months > 0 AND u.vest_qty_micro > 0
       ORDER BY a.symbol, ia.name`,
    )
    .all() as {
    qty_micro: number
    next_vest_on: string
    vest_every_months: number
    vest_qty_micro: number
    symbol: string
    account: string
    price_cents: number | null
  }[]
  const yearEnd = `${today.slice(0, 4)}-12-31`
  const events: VestEvent[] = []
  let unpriced = 0
  for (const r of rows) {
    let d = r.next_vest_on
    let guard = 0
    while (d <= today && guard++ < 400) d = addMonths(d, r.vest_every_months)
    let remaining = r.qty_micro
    while (d <= yearEnd && remaining > 0 && guard++ < 400) {
      const q = Math.min(r.vest_qty_micro, remaining)
      const cents = r.price_cents === null ? null : positionValueCents(q, r.price_cents)
      if (cents === null) unpriced++
      events.push({ symbol: r.symbol, account: r.account, vest_on: d, qty_micro: q, cents })
      remaining -= q
      d = addMonths(d, r.vest_every_months)
    }
  }
  events.sort((x, y) => (x.vest_on < y.vest_on ? -1 : x.vest_on > y.vest_on ? 1 : 0))
  return { events, cents: events.reduce((s, e) => s + (e.cents ?? 0), 0), unpriced }
}

/** Dividends & interest that landed in cash accounts this year. */
function dividendsYtd(db: DbLike, year: string): number {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(t.amount_cents), 0) AS s
       FROM transactions t JOIN categories c ON c.id = t.category_id
       WHERE c.name = 'Dividends & interest' AND t.amount_cents > 0 AND t.posted_on LIKE ?`,
    )
    .get(`${year}%`) as { s: number }
  return r.s
}

/** Realized YTD short/long-term gains across every lots-tracked asset. */
function realizedYtd(db: DbLike, today: string): { stCents: number; ltCents: number } {
  const assets = db.prepare('SELECT id FROM assets').all() as { id: number }[]
  const tradesFor = db.prepare(
    'SELECT id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, acquired_on, basis_cents FROM trades WHERE asset_id = ? ORDER BY traded_on',
  )
  let st = 0
  let lt = 0
  for (const a of assets) {
    const pos = computePosition(tradesFor.all(a.id) as TradeInput[], today)
    st += pos.realized_ytd_st_cents
    lt += pos.realized_ytd_lt_cents
  }
  return { stCents: st, ltCents: lt }
}

/** Spread what's still owed over the due dates that haven't passed, in
 *  proportion to the rule's installment weights (federal 25/25/25/25,
 *  California 30/40/0/30). The last date absorbs rounding so the parts sum. */
export function quarterSchedule(
  year: number,
  today: string,
  remainingCents: number,
  weights: [number, number, number, number] = FEDERAL_EST_RULE.weights,
) {
  const due = [`${year}-04-15`, `${year}-06-15`, `${year}-09-15`, `${year + 1}-01-15`]
  const remaining = Math.max(0, remainingCents)
  const upcoming = due.map((d, i) => (d >= today ? i : -1)).filter((i) => i >= 0)
  const weightSum = upcoming.reduce((s, i) => s + weights[i]!, 0)
  const last = upcoming[upcoming.length - 1]
  let allocated = 0
  return due.map((d, i) => {
    if (d < today) return { due: d, past: true, cents: 0, weightPct: weights[i]! }
    let cents = weightSum > 0 ? Math.round((remaining * weights[i]!) / weightSum) : 0
    if (i === last) cents = remaining - allocated
    allocated += cents
    return { due: d, past: false, cents, weightPct: weights[i]! }
  })
}

export type SafeHarbor = ReturnType<typeof estimatedSchedule>

/** Safe-harbor check + payment schedule under one jurisdiction's rule: the
 *  required annual payment is the lesser of 90% of this year's tax and
 *  100/110% of last year's (unless the rule bars the prior-year harbor at
 *  this income); withholding + payments to date count against it; the
 *  remainder is spread over the dates still ahead. */
export function estimatedSchedule(
  rule: EstRule,
  a: {
    year: number
    today: string
    filing: FilingStatus
    taxCents: number
    withheldCents: number
    estPaidCents: number
    priorYearTaxCents: number
    priorYearAgiOver150k: boolean
    agiCents: number
  },
) {
  const paidCents = a.withheldCents + a.estPaidCents
  const fromCurrent = Math.round(a.taxCents * 0.9)
  const priorYearHarborAvailable = !(rule.forceCurrentAgiCents && a.agiCents >= rule.forceCurrentAgiCents(a.filing))
  const priorMicro = a.priorYearAgiOver150k ? rule.highIncomePriorMicro : 1_000_000
  const fromPrior =
    priorYearHarborAvailable && a.priorYearTaxCents > 0
      ? Math.round((a.priorYearTaxCents * priorMicro) / 1_000_000)
      : null
  const requiredCents = fromPrior === null ? fromCurrent : Math.min(fromPrior, fromCurrent)
  const basis =
    fromPrior !== null && fromPrior <= fromCurrent ? `${priorMicro / 10_000}% of last year` : '90% of this year'
  const thresholdCents = rule.thresholdCents(a.filing)
  const belowThreshold = a.taxCents - a.withheldCents < thresholdCents
  const remainingCents = belowThreshold ? 0 : Math.max(0, requiredCents - paidCents)
  return {
    rule: rule.label,
    weights: rule.weights,
    assumed: rule.assumed,
    requiredCents,
    basis,
    paidCents,
    remainingCents,
    thresholdCents,
    belowThreshold,
    priorYearHarborAvailable,
    quarters: quarterSchedule(a.year, a.today, remainingCents, rule.weights),
  }
}

export function computeTaxYear(db: DbLike, today: string) {
  const settings = getTaxSettings(db)
  const year = today.slice(0, 4)
  const realized = realizedYtd(db, today)
  const rsuYtd = rsuIncomeYtd(db, year)
  const projected = projectVests(db, today)
  const divYtd = dividendsYtd(db, year)
  const divQualified = Math.round((divYtd * settings.qualifiedDividendShareMicro) / 1_000_000)
  const divOrdinary = divYtd - divQualified
  const deduction =
    settings.deductionMode === 'itemized'
      ? settings.itemizedCents
      : FEDERAL_STD_DEDUCTION_2026[settings.filingStatus]
  const inputs: TaxInputs = {
    filing: settings.filingStatus,
    ordinaryCents: settings.wagesAnnualCents + settings.otherIncomeCents + rsuYtd + projected.cents + divOrdinary,
    stGainCents: realized.stCents,
    ltGainCents: realized.ltCents,
    qualifiedDividendCents: divQualified,
    investmentIncomeCents: divYtd,
    deductionCents: deduction,
    state: settings,
  }
  const tax = computeTax(inputs)
  const marginal = marginalRates(inputs)

  const totalIncome =
    inputs.ordinaryCents - tax.capLossUsedCents + tax.netStCents + tax.netLtCents + divQualified

  const fedGap = tax.fedTotalCents - settings.withheldFederalCents - settings.estPaidFederalCents
  const stateGap = tax.stateCents - settings.withheldStateCents - settings.estPaidStateCents

  const common = {
    year: Number(year),
    today,
    filing: settings.filingStatus,
    priorYearAgiOver150k: settings.priorYearAgiOver150k,
    agiCents: totalIncome,
  }
  const safeHarbor = estimatedSchedule(FEDERAL_EST_RULE, {
    ...common,
    taxCents: tax.fedTotalCents,
    withheldCents: settings.withheldFederalCents,
    estPaidCents: settings.estPaidFederalCents,
    priorYearTaxCents: settings.priorYearTaxFederalCents,
  })
  const stateRule = stateEstRule(settings.state)
  const stateSafeHarbor = stateRule
    ? estimatedSchedule(stateRule, {
        ...common,
        taxCents: tax.stateCents,
        withheldCents: settings.withheldStateCents,
        estPaidCents: settings.estPaidStateCents,
        priorYearTaxCents: settings.priorYearTaxStateCents,
      })
    : null

  return {
    year: Number(year),
    settings,
    incomes: {
      wagesCents: settings.wagesAnnualCents,
      otherCents: settings.otherIncomeCents,
      rsuYtdCents: rsuYtd,
      rsuProjectedCents: projected.cents,
      rsuProjected: projected.events,
      rsuUnpriced: projected.unpriced,
      dividendsYtdCents: divYtd,
      dividendsQualifiedCents: divQualified,
      dividendsOrdinaryCents: divOrdinary,
      realizedStCents: realized.stCents,
      realizedLtCents: realized.ltCents,
      totalIncomeCents: totalIncome,
      deductionCents: deduction,
    },
    tax,
    marginal,
    effRateMicro: totalIncome > 0 ? Math.round((tax.totalCents * 1_000_000) / totalIncome) : 0,
    withheldFederalCents: settings.withheldFederalCents,
    withheldStateCents: settings.withheldStateCents,
    estPaidFederalCents: settings.estPaidFederalCents,
    estPaidStateCents: settings.estPaidStateCents,
    fedGapCents: fedGap,
    stateGapCents: stateGap,
    safeHarbor,
    stateSafeHarbor,
  }
}

/* ========================= harvesting advisor ========================= */

export type HarvestLot = {
  symbol: string
  trade_id: number | null
  opened_on: string
  qty_micro: number
  cost_cents: number
  value_cents: number
  gain_cents: number
  term: 'st' | 'lt'
  days_to_lt: number // 0 when already long-term
  wash_risk: boolean // another buy of this asset within the past 30 days
  tax_delta_cents: number // >0 tax owed if sold · <0 tax saved by harvesting
  after_tax_cents: number // proceeds net of the estimated tax effect
}

export function computeHarvest(
  db: DbLike,
  today: string,
  marginal: { stMicro: number; ltMicro: number },
) {
  const assets = db.prepare('SELECT id, symbol FROM assets ORDER BY symbol').all() as {
    id: number
    symbol: string
  }[]
  const tradesFor = db.prepare(
    'SELECT id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, acquired_on, basis_cents FROM trades WHERE asset_id = ? ORDER BY traded_on',
  )
  const latestPrice = db.prepare(
    'SELECT close_cents FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1',
  )
  const cutoff = shiftDays(today, -30)
  const rows: HarvestLot[] = []
  for (const a of assets) {
    const trades = tradesFor.all(a.id) as TradeInput[]
    if (trades.length === 0) continue
    const pos = computePosition(trades, today)
    if (pos.lots.length === 0) continue
    const price = latestPrice.get(a.id) as { close_cents: number } | undefined
    if (!price) continue
    const recentBuys = trades.filter((t) => t.side === 'buy' && t.traded_on >= cutoff && t.traded_on <= today)
    for (const lot of pos.lots) {
      const value = positionValueCents(lot.qty_micro, price.close_cents)
      const gain = value - lot.cost_cents
      const heldDays = Math.floor((Date.parse(today) - Date.parse(lot.opened_on)) / DAY)
      const isLt = heldDays > 365
      const rate = isLt ? marginal.ltMicro : marginal.stMicro
      const taxDelta = Math.round((gain * rate) / 1_000_000)
      rows.push({
        symbol: a.symbol,
        trade_id: lot.trade_id ?? null,
        opened_on: lot.opened_on,
        qty_micro: lot.qty_micro,
        cost_cents: lot.cost_cents,
        value_cents: value,
        gain_cents: gain,
        term: isLt ? 'lt' : 'st',
        days_to_lt: isLt ? 0 : 366 - heldDays,
        wash_risk: gain < 0 && recentBuys.some((b) => b.id !== lot.trade_id),
        tax_delta_cents: taxDelta,
        after_tax_cents: value - Math.max(0, taxDelta),
      })
    }
  }
  const losses = rows.filter((r) => r.gain_cents < 0)
  const totals = {
    harvestableStCents: losses.filter((r) => r.term === 'st').reduce((s, r) => s + r.gain_cents, 0),
    harvestableLtCents: losses.filter((r) => r.term === 'lt').reduce((s, r) => s + r.gain_cents, 0),
    estTaxSavedCents: -losses.reduce((s, r) => s + Math.min(0, r.tax_delta_cents), 0),
    washFlagged: losses.filter((r) => r.wash_risk).length,
  }
  rows.sort((x, y) => x.gain_cents - y.gain_cents)
  return { rows, totals }
}

/* ============================ the endpoint ============================ */

export function getTax(db: DbLike, today: string) {
  const year = computeTaxYear(db, today)
  const harvest = computeHarvest(db, today, year.marginal)
  const info = STATES.find((s) => s.code === year.settings.state)
  const stateVintage =
    info?.kind === 'brackets' ? info.vintage : info?.kind === 'flat' ? 'flat-state rates: 2025' : null
  return {
    vintage: stateVintage ? `${TAX_DATA_VINTAGE} · ${stateVintage}` : TAX_DATA_VINTAGE,
    states: STATES,
    ...year,
    harvest,
  }
}
