import type { DbLike } from './db'
import { computePosition, positionValueCents, type TradeInput } from './lots'
import { ApiError } from './services'

/**
 * Tax intelligence. Same rules as the rest of engine/: isomorphic, synchronous,
 * DbLike only, integer cents, rates in micro (1e6 = 100%). Everything is
 * DERIVED at read time from the ledger (trades, vests, transactions, prices) +
 * one settings blob — no tax number is ever stored.
 *
 * This is estimation for planning, not tax preparation. The bracket data has a
 * vintage (below) and the UI must say so.
 */

/* ================================ data ================================ */

export const TAX_DATA_VINTAGE =
  'Federal: tax year 2026 (Rev. Proc. 2025-32) · CA: 2025 (HoH estimated) · flat-state rates: 2025'

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

// Long-term capital gains stack on top of ordinary taxable income.
// [end of 0% band, end of 15% band] in cents; above the second → 20%.
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

// California (FTB, 2025; HoH thresholds are 2024-based estimates).
// The 1% Mental Health Services Tax over $1M is applied separately.
const CA_BRACKETS: Record<FilingStatus, Bracket[]> = {
  single: [b(10_756, 1), b(25_499, 2), b(40_245, 4), b(55_866, 6), b(70_612, 8), b(360_659, 9.3), b(432_787, 10.3), b(721_314, 11.3), b(null, 12.3)],
  mfs: [b(10_756, 1), b(25_499, 2), b(40_245, 4), b(55_866, 6), b(70_612, 8), b(360_659, 9.3), b(432_787, 10.3), b(721_314, 11.3), b(null, 12.3)],
  mfj: [b(21_512, 1), b(50_998, 2), b(80_490, 4), b(111_732, 6), b(141_224, 8), b(721_318, 9.3), b(865_574, 10.3), b(1_442_628, 11.3), b(null, 12.3)],
  hoh: [b(21_527, 1), b(51_000, 2), b(65_744, 4), b(81_364, 6), b(96_107, 8), b(490_493, 9.3), b(588_593, 10.3), b(980_987, 11.3), b(null, 12.3)],
}
const CA_STD_DEDUCTION: Record<FilingStatus, number> = { single: 5_540_00, mfs: 5_540_00, mfj: 11_080_00, hoh: 11_080_00 }
const CA_MHST_THRESHOLD = 1_000_000_00 // 1% on taxable income above $1M, every status
const CA_MHST_RATE_MICRO = 10_000

export type StateInfo =
  | { code: string; name: string; kind: 'none' }
  | { code: string; name: string; kind: 'flat'; rateMicro: number }
  | { code: string; name: string; kind: 'brackets' }
  | { code: string; name: string; kind: 'custom' }

const flat = (code: string, name: string, ratePct: number): StateInfo => ({
  code, name, kind: 'flat', rateMicro: Math.round(ratePct * 10_000),
})
const none = (code: string, name: string): StateInfo => ({ code, name, kind: 'none' })
const custom = (code: string, name: string): StateInfo => ({ code, name, kind: 'custom' })

// States where wages + capital gains face no broad income tax. (WA levies a
// 7%+ excise on large LT gains and MA adds a 4% surtax over ~$1M — both noted
// in the UI, neither modeled.)
export const STATES: StateInfo[] = [
  none('NONE', 'No state'),
  { code: 'CA', name: 'California', kind: 'brackets' },
  none('AK', 'Alaska'), none('FL', 'Florida'), none('NV', 'Nevada'), none('NH', 'New Hampshire'),
  none('SD', 'South Dakota'), none('TN', 'Tennessee'), none('TX', 'Texas'), none('WA', 'Washington'), none('WY', 'Wyoming'),
  flat('AZ', 'Arizona', 2.5), flat('CO', 'Colorado', 4.4), flat('GA', 'Georgia', 5.19), flat('ID', 'Idaho', 5.695),
  flat('IL', 'Illinois', 4.95), flat('IN', 'Indiana', 3.0), flat('IA', 'Iowa', 3.8), flat('KY', 'Kentucky', 4.0),
  flat('LA', 'Louisiana', 3.0), flat('MA', 'Massachusetts', 5.0), flat('MI', 'Michigan', 4.25), flat('MS', 'Mississippi', 4.4),
  flat('NC', 'North Carolina', 4.25), flat('PA', 'Pennsylvania', 3.07), flat('UT', 'Utah', 4.55),
  custom('AL', 'Alabama'), custom('AR', 'Arkansas'), custom('CT', 'Connecticut'), custom('DE', 'Delaware'),
  custom('DC', 'District of Columbia'), custom('HI', 'Hawaii'), custom('KS', 'Kansas'), custom('ME', 'Maine'),
  custom('MD', 'Maryland'), custom('MN', 'Minnesota'), custom('MO', 'Missouri'), custom('MT', 'Montana'),
  custom('NE', 'Nebraska'), custom('NJ', 'New Jersey'), custom('NM', 'New Mexico'), custom('NY', 'New York'),
  custom('ND', 'North Dakota'), custom('OH', 'Ohio'), custom('OK', 'Oklahoma'), custom('OR', 'Oregon'),
  custom('RI', 'Rhode Island'), custom('SC', 'South Carolina'), custom('VT', 'Vermont'), custom('VA', 'Virginia'),
  custom('WV', 'West Virginia'), custom('WI', 'Wisconsin'),
]

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
  priorYearTaxFederalCents: number // total federal tax from last year's return (safe harbor)
  priorYearAgiOver150k: boolean // 110% safe harbor instead of 100%
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
  priorYearTaxFederalCents: 0,
  priorYearAgiOver150k: true,
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
    'withheldFederalCents', 'withheldStateCents', 'estPaidFederalCents', 'priorYearTaxFederalCents',
  ]
  for (const k of ints) {
    const v = body[k]
    if (v === undefined) continue
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw new ApiError(400, `${k} must be a non-negative integer`)
    ;(next as Record<string, unknown>)[k] = v
  }
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

/** LT gains stack on top of ordinary taxable income across the 0/15/20 bands. */
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

/** State income tax on total taxable income (states tax gains as ordinary). */
export function stateTaxCents(
  totalIncomeCents: number,
  settings: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>,
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
  // California
  const taxable = Math.max(0, totalIncomeCents - CA_STD_DEDUCTION[settings.filingStatus])
  const base = taxFromBrackets(taxable, CA_BRACKETS[settings.filingStatus])
  const mhst = taxable > CA_MHST_THRESHOLD
    ? Math.round(((taxable - CA_MHST_THRESHOLD) * CA_MHST_RATE_MICRO) / 1_000_000)
    : 0
  return { taxCents: base + mhst, mhstCents: mhst }
}

/* ======================= the whole-year picture ======================= */

export type TaxInputs = {
  filing: FilingStatus
  ordinaryCents: number // wages + RSU vests + other ordinary + non-qualified div/interest
  stGainCents: number // net short-term (may be negative)
  ltGainCents: number // net long-term (may be negative)
  investmentIncomeCents: number // dividends/interest portion of ordinary (for NIIT)
  deductionCents: number
  state: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>
}

export type TaxComputed = {
  netStCents: number
  netLtCents: number
  capLossUsedCents: number // capital loss applied against ordinary (≤ $3,000)
  capLossCarryCents: number
  taxableOrdinaryCents: number
  taxableLtCents: number
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
  const netted = netCapitalGains(i.stGainCents, i.ltGainCents)
  const ordinaryAfterLoss = i.ordinaryCents - netted.capLossUsedCents
  const totalIncome = ordinaryAfterLoss + netted.netStCents + netted.netLtCents
  const taxableTotal = Math.max(0, totalIncome - i.deductionCents)
  const taxableLt = Math.min(netted.netLtCents, taxableTotal)
  const taxableOrd = taxableTotal - taxableLt
  const fedOrdinary = taxFromBrackets(taxableOrd, FEDERAL_BRACKETS_2026[i.filing])
  const fedLt = federalLtTax(taxableOrd, taxableLt, i.filing)
  const nii = Math.max(0, netted.netStCents + netted.netLtCents + Math.max(0, i.investmentIncomeCents))
  const niit = niitCents(nii, totalIncome, i.filing)
  const st = stateTaxCents(totalIncome, i.state)
  const fedTotal = fedOrdinary + fedLt + niit
  return {
    ...netted,
    taxableOrdinaryCents: taxableOrd,
    taxableLtCents: taxableLt,
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

function quarterSchedule(year: number, today: string, remainingCents: number) {
  const due = [
    `${year}-04-15`,
    `${year}-06-15`,
    `${year}-09-15`,
    `${year + 1}-01-15`,
  ]
  const upcoming = due.filter((d) => d >= today).length
  const per = upcoming > 0 ? Math.round(Math.max(0, remainingCents) / upcoming) : 0
  return due.map((d) => ({ due: d, past: d < today, cents: d < today ? 0 : per }))
}

export function computeTaxYear(db: DbLike, today: string) {
  const settings = getTaxSettings(db)
  const year = today.slice(0, 4)
  const realized = realizedYtd(db, today)
  const rsuYtd = rsuIncomeYtd(db, year)
  const divYtd = dividendsYtd(db, year)
  const deduction =
    settings.deductionMode === 'itemized'
      ? settings.itemizedCents
      : FEDERAL_STD_DEDUCTION_2026[settings.filingStatus]
  const inputs: TaxInputs = {
    filing: settings.filingStatus,
    ordinaryCents: settings.wagesAnnualCents + settings.otherIncomeCents + rsuYtd + divYtd,
    stGainCents: realized.stCents,
    ltGainCents: realized.ltCents,
    investmentIncomeCents: divYtd,
    deductionCents: deduction,
    state: settings,
  }
  const tax = computeTax(inputs)
  const marginal = marginalRates(inputs)

  const paidFederal = settings.withheldFederalCents + settings.estPaidFederalCents
  const fedGap = tax.fedTotalCents - paidFederal
  const stateGap = tax.stateCents - settings.withheldStateCents

  // Federal safe harbor: the lesser of 90% of this year's tax and 100/110% of
  // last year's. Withholding counts as paid evenly; the remainder is spread
  // over the remaining quarterly due dates.
  const priorPct = settings.priorYearAgiOver150k ? 1_100_000 : 1_000_000
  const fromPrior =
    settings.priorYearTaxFederalCents > 0
      ? Math.round((settings.priorYearTaxFederalCents * priorPct) / 1_000_000)
      : null
  const fromCurrent = Math.round(tax.fedTotalCents * 0.9)
  const requiredCents = fromPrior === null ? fromCurrent : Math.min(fromPrior, fromCurrent)
  const basis = fromPrior !== null && fromPrior <= fromCurrent
    ? (settings.priorYearAgiOver150k ? '110% of last year' : '100% of last year')
    : '90% of this year'
  const remaining = Math.max(0, requiredCents - paidFederal)
  const quarters = quarterSchedule(Number(year), today, remaining)

  const totalIncome =
    inputs.ordinaryCents - tax.capLossUsedCents + tax.netStCents + tax.netLtCents
  return {
    year: Number(year),
    settings,
    incomes: {
      wagesCents: settings.wagesAnnualCents,
      otherCents: settings.otherIncomeCents,
      rsuYtdCents: rsuYtd,
      dividendsYtdCents: divYtd,
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
    fedGapCents: fedGap,
    stateGapCents: stateGap,
    safeHarbor: {
      requiredCents,
      basis,
      paidCents: paidFederal,
      remainingCents: remaining,
      quarters,
    },
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
  return {
    vintage: TAX_DATA_VINTAGE,
    states: STATES,
    ...year,
    harvest,
  }
}
