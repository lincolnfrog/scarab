import { isRealIsoDay } from '../shared/dates'
import type { DbLike } from './db'
import { addMonths, ApiError } from './services'

/**
 * Per-person paychecks. Same rules as the rest of engine/: isomorphic,
 * synchronous, DbLike only, integer cents, rates in micro (1e6 = 100%).
 *
 * A pay source is one earner at one employer, transcribed from the latest
 * paystub: what a regular paycheck looks like, plus (optionally) the
 * year-to-date column, anchored on that stub's pay date. Everything the tax
 * layer needs — full-year wages, withholding, payroll taxes, the Additional
 * Medicare gap — is derived here by walking the pay cadence to Dec 31. No
 * projected number is stored.
 */

/* ================================ data ================================ */

export type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'
export const PAY_CADENCES: PayCadence[] = ['weekly', 'biweekly', 'semimonthly', 'monthly']
export const PERIODS_PER_YEAR: Record<PayCadence, number> = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 }

// 2026 payroll-tax parameters. Social Security wage base per the SSA's
// October 2025 COLA announcement; the Medicare rates are statutory.
export const PAYROLL_VINTAGE = 'Payroll: 2026 (SSA wage base $184,500)'
export const SS_WAGE_BASE_2026 = 184_500_00
export const SS_RATE_MICRO = 62_000
export const MEDICARE_RATE_MICRO = 14_500
export const ADDL_MEDICARE_RATE_MICRO = 9_000
/** Employers must withhold the extra 0.9% above this, per employer, regardless of filing status. */
export const ADDL_MEDICARE_WITHHOLD_THRESHOLD = 200_000_00

export type PaySource = {
  id: number
  earner: string
  employer: string
  cadence: PayCadence
  paidOn: string // pay date of the stub these numbers came from
  grossCents: number // per paycheck, EXCLUDING stock comp (that comes from the ledger)
  retirementCents: number // pre-tax retirement (401k/403b): reduces income-tax wages only
  benefitsCents: number // §125 premiums, HSA, FSA: reduce income-tax AND payroll-tax wages
  fedWithheldCents: number
  stateWithheldCents: number
  ytdGrossCents: number | null // NULL = not entered; assume every paycheck this year matched
  ytdRetirementCents: number | null
  ytdBenefitsCents: number | null
  ytdFedWithheldCents: number | null // as printed on the stub — includes any RSU supplemental withholding to date
  ytdStateWithheldCents: number | null
  investAccountId: number | null // the account this employer's RSUs vest into
  sort: number
}

type Row = {
  id: number
  earner: string
  employer: string
  cadence: PayCadence
  paid_on: string
  gross_cents: number
  retirement_cents: number
  benefits_cents: number
  fed_withheld_cents: number
  state_withheld_cents: number
  ytd_gross_cents: number | null
  ytd_retirement_cents: number | null
  ytd_benefits_cents: number | null
  ytd_fed_withheld_cents: number | null
  ytd_state_withheld_cents: number | null
  invest_account_id: number | null
  sort: number
}

const SELECT = `SELECT id, earner, employer, cadence, paid_on, gross_cents, retirement_cents, benefits_cents,
  fed_withheld_cents, state_withheld_cents, ytd_gross_cents, ytd_retirement_cents, ytd_benefits_cents,
  ytd_fed_withheld_cents, ytd_state_withheld_cents, invest_account_id, sort FROM pay_sources`

const fromRow = (r: Row): PaySource => ({
  id: r.id,
  earner: r.earner,
  employer: r.employer,
  cadence: r.cadence,
  paidOn: r.paid_on,
  grossCents: r.gross_cents,
  retirementCents: r.retirement_cents,
  benefitsCents: r.benefits_cents,
  fedWithheldCents: r.fed_withheld_cents,
  stateWithheldCents: r.state_withheld_cents,
  ytdGrossCents: r.ytd_gross_cents,
  ytdRetirementCents: r.ytd_retirement_cents,
  ytdBenefitsCents: r.ytd_benefits_cents,
  ytdFedWithheldCents: r.ytd_fed_withheld_cents,
  ytdStateWithheldCents: r.ytd_state_withheld_cents,
  investAccountId: r.invest_account_id,
  sort: r.sort,
})

export function listPaySources(db: DbLike): PaySource[] {
  return (db.prepare(`${SELECT} ORDER BY sort, id`).all() as Row[]).map(fromRow)
}

/* ============================== writes =============================== */

const bad = (msg: string): never => {
  throw new ApiError(400, msg)
}

export type PaySourceInput = {
  earner?: string
  employer?: string
  cadence?: string
  paidOn?: string
  grossCents?: number
  retirementCents?: number
  benefitsCents?: number
  fedWithheldCents?: number
  stateWithheldCents?: number
  ytdGrossCents?: number | null
  ytdRetirementCents?: number | null
  ytdBenefitsCents?: number | null
  ytdFedWithheldCents?: number | null
  ytdStateWithheldCents?: number | null
  investAccountId?: number | null
}

const cents = (v: unknown, name: string, fallback: number): number => {
  if (v === undefined) return fallback
  if (!Number.isSafeInteger(v) || (v as number) < 0) bad(`${name} must be a non-negative integer (cents)`)
  return v as number
}
const optCents = (v: unknown, name: string, fallback: number | null): number | null => {
  if (v === undefined) return fallback
  if (v === null || v === '') return null
  return cents(v, name, 0)
}

function validate(db: DbLike, b: PaySourceInput, cur: PaySource | null): Omit<PaySource, 'id' | 'sort'> {
  const earner = (b.earner ?? cur?.earner ?? '').trim().slice(0, 40)
  if (!earner) bad('earner required')
  const employer = (b.employer ?? cur?.employer ?? '').trim().slice(0, 60)
  const cadence = (b.cadence ?? cur?.cadence) as PayCadence | undefined
  if (!cadence || !PAY_CADENCES.includes(cadence)) bad('cadence must be weekly, biweekly, semimonthly or monthly')
  const paidOn = b.paidOn ?? cur?.paidOn
  if (!isRealIsoDay(paidOn)) bad('paidOn must be a real YYYY-MM-DD day (the pay date on the stub)')
  const grossCents = cents(b.grossCents, 'grossCents', cur?.grossCents ?? -1)
  if (grossCents <= 0) bad('grossCents must be positive')
  const retirementCents = cents(b.retirementCents, 'retirementCents', cur?.retirementCents ?? 0)
  const benefitsCents = cents(b.benefitsCents, 'benefitsCents', cur?.benefitsCents ?? 0)
  if (retirementCents + benefitsCents > grossCents) bad('pre-tax deductions exceed gross')
  const investAccountId = b.investAccountId === undefined ? (cur?.investAccountId ?? null) : b.investAccountId
  if (investAccountId !== null) {
    if (!Number.isSafeInteger(investAccountId)) bad('investAccountId must be an integer or null')
    if (!db.prepare('SELECT id FROM invest_accounts WHERE id = ?').get(investAccountId))
      throw new ApiError(404, 'no such investment account')
  }
  const ytd = {
    ytdGrossCents: optCents(b.ytdGrossCents, 'ytdGrossCents', cur?.ytdGrossCents ?? null),
    ytdRetirementCents: optCents(b.ytdRetirementCents, 'ytdRetirementCents', cur?.ytdRetirementCents ?? null),
    ytdBenefitsCents: optCents(b.ytdBenefitsCents, 'ytdBenefitsCents', cur?.ytdBenefitsCents ?? null),
    ytdFedWithheldCents: optCents(b.ytdFedWithheldCents, 'ytdFedWithheldCents', cur?.ytdFedWithheldCents ?? null),
    ytdStateWithheldCents: optCents(b.ytdStateWithheldCents, 'ytdStateWithheldCents', cur?.ytdStateWithheldCents ?? null),
  }
  // The YTD column is all-or-nothing: gross anchors it, the rest default to 0.
  if (ytd.ytdGrossCents === null) {
    ytd.ytdRetirementCents = null
    ytd.ytdBenefitsCents = null
    ytd.ytdFedWithheldCents = null
    ytd.ytdStateWithheldCents = null
  } else {
    ytd.ytdRetirementCents ??= 0
    ytd.ytdBenefitsCents ??= 0
    ytd.ytdFedWithheldCents ??= 0
    ytd.ytdStateWithheldCents ??= 0
    if (ytd.ytdGrossCents < grossCents) bad('year-to-date gross is less than one paycheck')
    if (ytd.ytdRetirementCents + ytd.ytdBenefitsCents > ytd.ytdGrossCents) bad('year-to-date pre-tax deductions exceed gross')
  }
  return {
    earner, employer, cadence: cadence!, paidOn: paidOn!, grossCents, retirementCents, benefitsCents,
    fedWithheldCents: cents(b.fedWithheldCents, 'fedWithheldCents', cur?.fedWithheldCents ?? 0),
    stateWithheldCents: cents(b.stateWithheldCents, 'stateWithheldCents', cur?.stateWithheldCents ?? 0),
    ...ytd,
    investAccountId,
  }
}

const COLS = [
  'earner', 'employer', 'cadence', 'paid_on', 'gross_cents', 'retirement_cents', 'benefits_cents',
  'fed_withheld_cents', 'state_withheld_cents', 'ytd_gross_cents', 'ytd_retirement_cents', 'ytd_benefits_cents',
  'ytd_fed_withheld_cents', 'ytd_state_withheld_cents', 'invest_account_id',
] as const
const values = (v: Omit<PaySource, 'id' | 'sort'>) => [
  v.earner, v.employer, v.cadence, v.paidOn, v.grossCents, v.retirementCents, v.benefitsCents,
  v.fedWithheldCents, v.stateWithheldCents, v.ytdGrossCents, v.ytdRetirementCents, v.ytdBenefitsCents,
  v.ytdFedWithheldCents, v.ytdStateWithheldCents, v.investAccountId,
]

export function createPaySource(db: DbLike, b: PaySourceInput): PaySource {
  const v = validate(db, b, null)
  const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM pay_sources').get() as { s: number }).s
  const r = db
    .prepare(`INSERT INTO pay_sources (${COLS.join(', ')}, sort) VALUES (${COLS.map(() => '?').join(', ')}, ?)`)
    .run(...values(v), sort)
  return fromRow(db.prepare(`${SELECT} WHERE id = ?`).get(Number(r.lastInsertRowid)) as Row)
}

export function updatePaySource(db: DbLike, id: number, b: PaySourceInput): PaySource {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row | undefined
  if (!row) throw new ApiError(404, 'no such pay source')
  const v = validate(db, b, fromRow(row))
  db.prepare(`UPDATE pay_sources SET ${COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...values(v), id)
  return fromRow(db.prepare(`${SELECT} WHERE id = ?`).get(id) as Row)
}

export function deletePaySource(db: DbLike, id: number) {
  const r = db.prepare('DELETE FROM pay_sources WHERE id = ?').run(id)
  if (r.changes === 0) throw new ApiError(404, 'no such pay source')
  return { ok: true as const }
}

/* ============================ pay calendar ============================ */

const DAY = 86400000
const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10)
const lastDayOf = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate() // m is 1-based
const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** The pay date one step forward (+1) or back (-1). Semi-monthly pairs are
 *  (d, d+15) with the second capped to month end; the "15th and last day"
 *  schedule is by far the commonest, so a month-end date pairs with the 15th. */
export function stepPayDate(iso: string, cadence: PayCadence, dir: 1 | -1 = 1): string {
  if (cadence === 'weekly') return shiftDays(iso, 7 * dir)
  if (cadence === 'biweekly') return shiftDays(iso, 14 * dir)
  if (cadence === 'monthly') return addMonths(iso, dir)
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
  const last = lastDayOf(y, m)
  if (dir === 1) {
    if (d <= 15) return ymd(y, m, d === 15 ? last : Math.min(d + 15, last))
    const ny = m === 12 ? y + 1 : y
    const nm = m === 12 ? 1 : m + 1
    return ymd(ny, nm, d === last ? 15 : d - 15)
  }
  if (d > 15) return ymd(y, m, d === last ? 15 : d - 15)
  const py = m === 1 ? y - 1 : y
  const pm = m === 1 ? 12 : m - 1
  const plast = lastDayOf(py, pm)
  return ymd(py, pm, d === 15 ? plast : Math.min(d + 15, plast))
}

/** Pay dates strictly after `anchor`, through `through` (inclusive). */
export function payDatesAfter(anchor: string, cadence: PayCadence, through: string): string[] {
  const out: string[] = []
  let d = anchor
  let guard = 0
  while (guard++ < 400) {
    d = stepPayDate(d, cadence, 1)
    if (d > through) break
    out.push(d)
  }
  return out
}

/** Pay dates on or before `anchor`, back to `from` (inclusive), newest first. */
export function payDatesThrough(anchor: string, cadence: PayCadence, from: string): string[] {
  const out: string[] = []
  let d = anchor
  let guard = 0
  while (d >= from && guard++ < 400) {
    out.push(d)
    d = stepPayDate(d, cadence, -1)
  }
  return out
}

/* ============================= projection ============================= */

export type PayAmounts = {
  grossCents: number
  retirementCents: number
  benefitsCents: number
  fedWithheldCents: number
  stateWithheldCents: number
}

export type PayProjection = PaySource & {
  /** The stub predates this tax year: its YTD column is ignored and every pay date this year is projected. */
  stale: boolean
  ytdEstimated: boolean
  periodsElapsed: number
  periodsRemaining: number
  ytd: PayAmounts
  projected: PayAmounts & {
    taxableWagesCents: number // Box 1 shape: gross − retirement − benefits
    ficaWagesCents: number // Social Security / Medicare wages: gross − benefits
  }
}

const times = (a: PayAmounts, n: number): PayAmounts => ({
  grossCents: a.grossCents * n,
  retirementCents: a.retirementCents * n,
  benefitsCents: a.benefitsCents * n,
  fedWithheldCents: a.fedWithheldCents * n,
  stateWithheldCents: a.stateWithheldCents * n,
})
const plus = (a: PayAmounts, b: PayAmounts): PayAmounts => ({
  grossCents: a.grossCents + b.grossCents,
  retirementCents: a.retirementCents + b.retirementCents,
  benefitsCents: a.benefitsCents + b.benefitsCents,
  fedWithheldCents: a.fedWithheldCents + b.fedWithheldCents,
  stateWithheldCents: a.stateWithheldCents + b.stateWithheldCents,
})
const ZERO: PayAmounts = { grossCents: 0, retirementCents: 0, benefitsCents: 0, fedWithheldCents: 0, stateWithheldCents: 0 }

export function projectPaySource(s: PaySource, year: number): PayProjection {
  const jan1 = `${year}-01-01`
  const dec31 = `${year}-12-31`
  const perPeriod: PayAmounts = {
    grossCents: s.grossCents,
    retirementCents: s.retirementCents,
    benefitsCents: s.benefitsCents,
    fedWithheldCents: s.fedWithheldCents,
    stateWithheldCents: s.stateWithheldCents,
  }
  const stale = s.paidOn < jan1
  const elapsed = stale ? 0 : payDatesThrough(s.paidOn, s.cadence, jan1).length
  const remaining = payDatesAfter(stale ? lastBefore(s, jan1) : s.paidOn, s.cadence, dec31).length
  const ytdEstimated = stale || s.ytdGrossCents === null
  const ytd: PayAmounts = stale
    ? ZERO
    : s.ytdGrossCents === null
      ? times(perPeriod, elapsed)
      : {
          grossCents: s.ytdGrossCents,
          retirementCents: s.ytdRetirementCents ?? 0,
          benefitsCents: s.ytdBenefitsCents ?? 0,
          fedWithheldCents: s.ytdFedWithheldCents ?? 0,
          stateWithheldCents: s.ytdStateWithheldCents ?? 0,
        }
  const projected = plus(ytd, times(perPeriod, remaining))
  return {
    ...s,
    stale,
    ytdEstimated,
    periodsElapsed: elapsed,
    periodsRemaining: remaining,
    ytd,
    projected: {
      ...projected,
      taxableWagesCents: projected.grossCents - projected.retirementCents - projected.benefitsCents,
      ficaWagesCents: projected.grossCents - projected.benefitsCents,
    },
  }
}

/** For a stale stub, the last pay date on the cadence before `jan1`, so the
 *  walk forward from it lands on this year's actual pay dates. */
function lastBefore(s: PaySource, jan1: string): string {
  let d = s.paidOn
  let guard = 0
  while (guard++ < 400) {
    const n = stepPayDate(d, s.cadence, 1)
    if (n >= jan1) return d
    d = n
  }
  return d
}

/* ============================ payroll taxes =========================== */

export type EarnerPayroll = {
  earner: string
  wagesCents: number // income-tax wages (Box 1 shape), paychecks only
  rsuCents: number // stock comp vesting through this earner's linked accounts (YTD + projected)
  ficaWagesCents: number // paycheck FICA wages + linked stock comp
  fedWithheldCents: number
  stateWithheldCents: number
  socialSecurityCents: number // liability, capped at the wage base across employers
  socialSecurityWithheldCents: number // capped per employer — the excess is a refundable credit
  medicareCents: number
  addlMedicareWithheldCents: number // 0.9% above $200k, per employer
}

export type Payroll = {
  sources: PayProjection[]
  earners: EarnerPayroll[]
  wagesCents: number
  fedWithheldCents: number
  stateWithheldCents: number
  ficaWagesCents: number // household Medicare wages incl. all stock comp (linked or not)
  socialSecurityCents: number
  excessSocialSecurityCents: number
  medicareCents: number
  addlMedicareCents: number // liability on household wages over the filing-status threshold
  addlMedicareWithheldCents: number
  stale: number
}

const pct = (cents: number, micro: number) => Math.round((cents * micro) / 1_000_000)

/**
 * Household payroll picture. `rsuByAccount` is this year's stock-comp income
 * (YTD + projected) keyed by invest account; income in accounts no pay source
 * links to still counts toward the household Additional Medicare base.
 */
export function computePayroll(
  sources: PaySource[],
  year: number,
  rsuByAccount: Map<number, number>,
  addlMedicareThresholdCents: number,
): Payroll {
  const projections = sources.map((s) => projectPaySource(s, year))
  const byEarner = new Map<string, EarnerPayroll>()
  const linkedAccounts = new Set<number>()
  for (const p of projections) {
    const rsu = p.investAccountId !== null && !linkedAccounts.has(p.investAccountId) ? (rsuByAccount.get(p.investAccountId) ?? 0) : 0
    if (p.investAccountId !== null) linkedAccounts.add(p.investAccountId)
    const employerFica = p.projected.ficaWagesCents + rsu
    const e = byEarner.get(p.earner) ?? {
      earner: p.earner, wagesCents: 0, rsuCents: 0, ficaWagesCents: 0, fedWithheldCents: 0, stateWithheldCents: 0,
      socialSecurityCents: 0, socialSecurityWithheldCents: 0, medicareCents: 0, addlMedicareWithheldCents: 0,
    }
    e.wagesCents += p.projected.taxableWagesCents
    e.rsuCents += rsu
    e.ficaWagesCents += employerFica
    e.fedWithheldCents += p.projected.fedWithheldCents
    e.stateWithheldCents += p.projected.stateWithheldCents
    e.socialSecurityWithheldCents += pct(Math.min(employerFica, SS_WAGE_BASE_2026), SS_RATE_MICRO)
    e.addlMedicareWithheldCents += pct(Math.max(0, employerFica - ADDL_MEDICARE_WITHHOLD_THRESHOLD), ADDL_MEDICARE_RATE_MICRO)
    byEarner.set(p.earner, e)
  }
  const earners = [...byEarner.values()].map((e) => ({
    ...e,
    socialSecurityCents: pct(Math.min(e.ficaWagesCents, SS_WAGE_BASE_2026), SS_RATE_MICRO),
    medicareCents: pct(e.ficaWagesCents, MEDICARE_RATE_MICRO),
  }))
  let unlinkedRsu = 0
  for (const [acct, c] of rsuByAccount) if (!linkedAccounts.has(acct)) unlinkedRsu += c
  const sum = (f: (e: EarnerPayroll) => number) => earners.reduce((s, e) => s + f(e), 0)
  const ficaWages = sum((e) => e.ficaWagesCents) + unlinkedRsu
  return {
    sources: projections,
    earners,
    wagesCents: sum((e) => e.wagesCents),
    fedWithheldCents: sum((e) => e.fedWithheldCents),
    stateWithheldCents: sum((e) => e.stateWithheldCents),
    ficaWagesCents: ficaWages,
    socialSecurityCents: sum((e) => e.socialSecurityCents),
    excessSocialSecurityCents: sum((e) => Math.max(0, e.socialSecurityWithheldCents - e.socialSecurityCents)),
    medicareCents: sum((e) => e.medicareCents) + pct(unlinkedRsu, MEDICARE_RATE_MICRO),
    addlMedicareCents: sources.length ? pct(Math.max(0, ficaWages - addlMedicareThresholdCents), ADDL_MEDICARE_RATE_MICRO) : 0,
    addlMedicareWithheldCents: sum((e) => e.addlMedicareWithheldCents),
    stale: projections.filter((p) => p.stale).length,
  }
}
