import { CAP_LOSS_LIMIT_CENTS } from '../shared/capgains'
import { addDaysIso } from '../shared/dates'
import { formatDollars } from '../shared/money'
import { deferralLimit } from './contributions'
import type { DbLike } from './db'
import { bad } from './errors'
import { listPaySources, PERIODS_PER_YEAR } from './paychecks'
import { ageInYear, listPeople, personNamed } from './people'
import { computeTax, marginalRates, projectVests, taxYear, TAX_DATA_VINTAGE, type TaxComputed, type TaxInputs } from './tax'

/**
 * The two-year tax view (copilot §4e): next year projected on the same
 * settings, with this year's capital-loss carryforward flowing in, so a
 * choice about *when* — realize a gain now or in January, take the bonus in
 * December or January, convert this year or next — is priced as the change
 * in the two years' tax together.
 *
 * Next year reuses this year's tables: they're indexed and next year's
 * aren't bundled until they're published, so the comparison isolates the
 * timing, not inflation. Same rules as the rest of engine/: synchronous,
 * integer cents, derived on every read.
 */

export type YearView = {
  year: number
  wagesCents: number
  rsuCents: number
  dividendsCents: number
  otherCents: number
  stGainCents: number
  ltGainCents: number
  /** Capital loss carried in from the year before (short-term, long-term). */
  carryInStCents: number
  carryInLtCents: number
  deductionCents: number
  tax: TaxComputed
  marginal: { ordinaryMicro: number; stMicro: number; ltMicro: number }
}

export type TwoYear = {
  thisYear: YearView
  nextYear: YearView
  /** What next year's column assumed, line by line. */
  basis: string[]
  vintage: string
}

/** This year's net capital loss carried into next year, kept by character (§1212(b)): the $3,000 used against ordinary income comes out of short-term loss first. */
export function lossCarry(stCents: number, ltCents: number): { st: number; lt: number } {
  let st = stCents
  let lt = ltCents
  if (st < 0 && lt > 0) {
    lt += st
    st = 0
    if (lt < 0) {
      st = lt
      lt = 0
    }
  } else if (lt < 0 && st > 0) {
    st += lt
    lt = 0
    if (st < 0) {
      lt = st
      st = 0
    }
  }
  const stLoss = Math.max(0, -st)
  const ltLoss = Math.max(0, -lt)
  const used = Math.min(CAP_LOSS_LIMIT_CENTS, stLoss + ltLoss)
  const usedSt = Math.min(stLoss, used)
  return { st: stLoss - usedSt, lt: ltLoss - (used - usedSt) }
}

type Context = {
  thisInputs: TaxInputs
  nextBase: TaxInputs
  view: TwoYear
}

function context(db: DbLike, today: string): Context {
  const { out, inputs } = taxYear(db, today)
  const year = out.year
  const next = year + 1
  const settings = out.settings
  const basis: string[] = []

  // Wages: each paycheck for a full year, pre-tax deferrals capped at next year's limit for the earner's age.
  const sources = listPaySources(db)
  let wages = settings.wagesAnnualCents
  let ficaWages: number | undefined
  if (sources.length) {
    const people = listPeople(db)
    const pretaxBy = new Map<string, number>()
    let gross = 0
    let benefits = 0
    for (const s of sources) {
      const n = PERIODS_PER_YEAR[s.cadence]
      gross += s.grossCents * n
      benefits += s.benefitsCents * n
      const k = s.earner.trim().toLowerCase()
      pretaxBy.set(k, (pretaxBy.get(k) ?? 0) + s.retirementCents * n)
    }
    let pretax = 0
    for (const [k, cents] of pretaxBy) pretax += Math.min(cents, deferralLimit(ageInYear(personNamed(people, k), next)).limitCents)
    wages = gross - benefits - pretax
    ficaWages = gross - benefits
    basis.push(`Wages: each paycheck × its pay dates in a year (${sources.length} paycheck${sources.length > 1 ? 's' : ''}), pre-tax deferrals capped at the limit`)
  } else basis.push('Wages: the salary setting')

  // Stock comp: the grants' schedules walked through next Dec 31, after this year's vests have taken their shares.
  const vests = projectVests(db, today, `${next}-12-31`).events.filter((e) => e.vest_on > `${year}-12-31`)
  const rsu = vests.reduce((s, e) => s + (e.cents ?? 0), 0)
  if (vests.length) basis.push(`Stock comp: ${vests.length} scheduled vest${vests.length > 1 ? 's' : ''} at today's price`)

  // Dividends & interest: the last twelve months, split qualified / ordinary by the setting.
  const div = (
    db
      .prepare(
        `SELECT COALESCE(SUM(t.amount_cents), 0) AS s FROM transactions t JOIN categories c ON c.id = t.category_id
         WHERE c.name = 'Dividends & interest' AND t.amount_cents > 0 AND t.posted_on > ? AND t.posted_on <= ?`,
      )
      .get(addDaysIso(today, -365), today) as { s: number }
  ).s
  const divQualified = Math.round((div * settings.qualifiedDividendShareMicro) / 1_000_000)
  basis.push('Dividends & interest: the last twelve months')
  if (settings.otherIncomeCents) basis.push('Other income: the setting, again')

  const carry = lossCarry(inputs.stGainCents, inputs.ltGainCents)
  if (carry.st + carry.lt > 0)
    basis.push(
      `Capital loss carried in from ${year}: ${[carry.st ? `${formatDollars(carry.st)} short-term` : '', carry.lt ? `${formatDollars(carry.lt)} long-term` : ''].filter(Boolean).join(', ')}`,
    )
  basis.push('No sales planned yet; the same deduction; this year’s brackets')

  const nextBase: TaxInputs = {
    filing: settings.filingStatus,
    ordinaryCents: wages + settings.otherIncomeCents + rsu + (div - divQualified),
    stGainCents: -carry.st,
    ltGainCents: -carry.lt,
    qualifiedDividendCents: divQualified,
    investmentIncomeCents: div,
    deductionCents: inputs.deductionCents,
    ...(ficaWages !== undefined ? { medicareWagesCents: ficaWages + rsu } : {}),
    state: settings,
  }
  const view = (y: number, i: TaxInputs, w: number, r: number, d: number, carryIn: { st: number; lt: number }, st: number, lt: number): YearView => ({
    year: y,
    wagesCents: w,
    rsuCents: r,
    dividendsCents: d,
    otherCents: settings.otherIncomeCents,
    stGainCents: st,
    ltGainCents: lt,
    carryInStCents: carryIn.st,
    carryInLtCents: carryIn.lt,
    deductionCents: i.deductionCents,
    tax: computeTax(i),
    marginal: marginalRates(i),
  })
  return {
    thisInputs: inputs,
    nextBase,
    view: {
      thisYear: view(year, inputs, out.incomes.wagesCents, out.incomes.rsuYtdCents + out.incomes.rsuProjectedCents, out.incomes.dividendsYtdCents, { st: 0, lt: 0 }, inputs.stGainCents, inputs.ltGainCents),
      nextYear: view(next, nextBase, wages, rsu, div, carry, 0, 0),
      basis,
      vintage: `${TAX_DATA_VINTAGE} — held for ${next}`,
    },
  }
}

export function getTwoYear(db: DbLike, today: string): TwoYear {
  return context(db, today).view
}

/* ============================== timing ============================== */

export type TimingKind = 'lt-gain' | 'st-gain' | 'loss' | 'bonus' | 'conversion'
const KINDS: readonly TimingKind[] = ['lt-gain', 'st-gain', 'loss', 'bonus', 'conversion']

export type Timing = {
  kind: TimingKind
  amountCents: number
  /** Tax over both years with the amount in this year — next year feels it through the carryforward. */
  nowCents: { thisYear: number; nextYear: number; total: number }
  /** …and with it in next year instead. */
  laterCents: { thisYear: number; nextYear: number; total: number }
  /** later.total − now.total: positive means doing it this year costs less over the two. */
  nowSavesCents: number
}

/** The inputs with `amount` of `kind` added. A loss is a short-term loss (the commonest harvest). */
function withAmount(i: TaxInputs, kind: TimingKind, amount: number): TaxInputs {
  switch (kind) {
    case 'lt-gain':
      return { ...i, ltGainCents: i.ltGainCents + amount }
    case 'st-gain':
      return { ...i, stGainCents: i.stGainCents + amount }
    case 'loss':
      return { ...i, stGainCents: i.stGainCents - amount }
    case 'bonus':
      return { ...i, ordinaryCents: i.ordinaryCents + amount, ...(i.medicareWagesCents !== undefined ? { medicareWagesCents: i.medicareWagesCents + amount } : {}) }
    case 'conversion':
      return { ...i, ordinaryCents: i.ordinaryCents + amount }
  }
}

/** Next year's inputs with this year's carryforward recomputed from `thisYear` (a loss taken now carries). */
function nextWith(c: Context, thisYear: TaxInputs): TaxInputs {
  const carry = lossCarry(thisYear.stGainCents, thisYear.ltGainCents)
  const base = lossCarry(c.thisInputs.stGainCents, c.thisInputs.ltGainCents)
  return { ...c.nextBase, stGainCents: c.nextBase.stGainCents + base.st - carry.st, ltGainCents: c.nextBase.ltGainCents + base.lt - carry.lt }
}

/** POST /api/tax/timing (read-like): the same amount, this year or next, priced over both years. */
export function priceTiming(db: DbLike, today: string, b: { kind?: unknown; amountCents?: unknown }): Timing {
  if (!KINDS.includes(b?.kind as TimingKind)) bad(`kind must be one of ${KINDS.join(', ')}`)
  if (!Number.isSafeInteger(b.amountCents) || (b.amountCents as number) <= 0) bad('amountCents must be a positive integer')
  const kind = b.kind as TimingKind
  const amount = b.amountCents as number
  const c = context(db, today)
  const tax = (i: TaxInputs) => computeTax(i).totalCents
  const nowThis = withAmount(c.thisInputs, kind, amount)
  const now = { thisYear: tax(nowThis), nextYear: tax(nextWith(c, nowThis)) }
  const later = { thisYear: tax(c.thisInputs), nextYear: tax(withAmount(nextWith(c, c.thisInputs), kind, amount)) }
  const nowTotal = now.thisYear + now.nextYear
  const laterTotal = later.thisYear + later.nextYear
  return {
    kind,
    amountCents: amount,
    nowCents: { ...now, total: nowTotal },
    laterCents: { ...later, total: laterTotal },
    nowSavesCents: laterTotal - nowTotal,
  }
}
