import { CAP_LOSS_LIMIT_CENTS } from '../shared/capgains'
import { addDaysIso } from '../shared/dates'
import { formatDollars } from '../shared/money'
import type { DbLike } from './db'
import { bad } from './errors'
import { accountForecasts, forecastLossIn } from './harvest'
import { deferChecks, excessPretax, listPaySources, PERIODS_PER_YEAR } from './paychecks'
import { ageInYear, listPeople, personNamed } from './people'
import { plannedSaleGains } from './planned-sales'
import { computeTax, deferralLimit, marginalRates, projectVests, taxYear, TAX_DATA_VINTAGE, type TaxComputed, type TaxInputs } from './tax'

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
  /** The plan's part of the year: sales planned for it, by term, and the harvest forecast's expected further losses (positive). */
  plannedStCents: number
  plannedLtCents: number
  forecastLossCents: number
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

/** What the plan adds to one tax year: the sales planned for it by term, and the harvest forecast's expected further losses. */
export type YearPlan = { plannedStCents: number; plannedLtCents: number; forecastLossCents: number; sales: number; accounts: string[] }

/**
 * The plan by year (engine/planned-sales.ts, engine/harvest.ts): planned
 * sales priced off the lots as they stand, and each managed account's
 * expected further losses — this year after the broker's figure, later years
 * whole. Years are keyed as given; one entry each.
 */
export function yearPlans(db: DbLike, today: string, years: readonly number[]): Map<number, YearPlan> {
  const last = Math.max(...years)
  const gains = plannedSaleGains(db, today)
  const forecasts = accountForecasts(db, today, last)
  const out = new Map<number, YearPlan>()
  for (const y of years) {
    const mine = gains.filter((g) => Number(g.planned_on.slice(0, 4)) === y)
    out.set(y, {
      plannedStCents: mine.reduce((s, g) => s + g.st_cents, 0),
      plannedLtCents: mine.reduce((s, g) => s + g.lt_cents, 0),
      forecastLossCents: forecastLossIn(forecasts, y),
      sales: mine.length,
      accounts: forecasts.filter((f) => (f.byYear.find((b) => b.year === y)?.cents ?? 0) !== 0).map((f) => f.account),
    })
  }
  return out
}

/** The basis lines a year's plan adds, when it has one. */
function planLines(year: number, p: YearPlan, isThisYear: boolean): string[] {
  const lines: string[] = []
  if (p.sales > 0)
    lines.push(
      `${year}: ${p.sales} planned sale${p.sales === 1 ? '' : 's'} — ${formatDollars(p.plannedStCents + p.plannedLtCents, { sign: true })} realized as the lots stand today`,
    )
  if (p.forecastLossCents !== 0)
    lines.push(
      `${year}: ${formatDollars(p.forecastLossCents)} of further losses${isThisYear ? ' over the rest of the year' : ''} expected from ${p.accounts.join(', ')} — the manager’s estimate, not a fact${isThisYear ? '; the Projected tax card shows what is realized so far' : ''}`,
    )
  return lines
}

export type Context = {
  /** This year's inputs with the plan in them (the two-year view's left column); `plain` is the same without the plan. */
  thisInputs: TaxInputs
  nextBase: TaxInputs
  plain: { thisYear: TaxInputs; nextYear: TaxInputs }
  out: ReturnType<typeof taxYear>['out']
  view: TwoYear
}

function context(db: DbLike, today: string, picture: ReturnType<typeof taxYear> = taxYear(db, today)): Context {
  const { out, inputs } = picture
  const year = out.year
  const next = year + 1
  const settings = out.settings
  const basis: string[] = []

  // The plan: sales planned for each year and the losses a managed account's manager expects — this year's rest and
  // next year whole. Both columns feel them; the Projected tax card keeps to what has happened.
  const plans = yearPlans(db, today, [year, next])
  const planThis = plans.get(year)!
  const planNext = plans.get(next)!
  const planned: TaxInputs = {
    ...inputs,
    stGainCents: inputs.stGainCents + planThis.plannedStCents - planThis.forecastLossCents,
    ltGainCents: inputs.ltGainCents + planThis.plannedLtCents,
  }

  // Wages: each paycheck for a full year, its deferrals stopping at the earner's limit for their age next year — the
  // walk this year's projection takes (engine/paychecks.ts), so two years alike come out alike.
  const sources = listPaySources(db)
  let wages = settings.wagesAnnualCents
  let ficaWages: number | undefined
  if (sources.length) {
    const people = listPeople(db)
    let gross = 0
    let benefits = 0
    const plans = sources.map((s) => {
      const n = PERIODS_PER_YEAR[s.cadence]
      gross += s.grossCents * n
      benefits += s.benefitsCents * n
      const limitCents = deferralLimit(ageInYear(personNamed(people, s.earner), next)).limitCents
      const d = deferChecks(s, n, limitCents)
      return { earner: s.earner, limitCents, cents: d.cents, pretaxCents: d.pretaxCents }
    })
    let excess = 0
    for (const cents of excessPretax(plans).values()) excess += cents
    wages = gross - benefits - plans.reduce((sum, p) => sum + p.pretaxCents, 0) + excess
    ficaWages = gross - benefits
    basis.push(
      `Wages: each paycheck × its pay dates in a year (${sources.length} paycheck${sources.length > 1 ? 's' : ''}), deferrals stopping at ${year}'s limit for each earner's age in ${next}`,
    )
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

  const carry = lossCarry(planned.stGainCents, planned.ltGainCents)
  if (carry.st + carry.lt > 0)
    basis.push(
      `Capital loss carried in from ${year}: ${[carry.st ? `${formatDollars(carry.st)} short-term` : '', carry.lt ? `${formatDollars(carry.lt)} long-term` : ''].filter(Boolean).join(', ')}`,
    )
  for (const line of planLines(year, planThis, true)) basis.push(line)
  for (const line of planLines(next, planNext, false)) basis.push(line)
  if (planThis.sales + planNext.sales === 0) basis.push('No sales planned yet')
  basis.push('The same deduction; this year’s brackets')

  const nextBase: TaxInputs = {
    filing: settings.filingStatus,
    ordinaryCents: wages + settings.otherIncomeCents + rsu + (div - divQualified),
    stGainCents: -carry.st + planNext.plannedStCents - planNext.forecastLossCents,
    ltGainCents: -carry.lt + planNext.plannedLtCents,
    qualifiedDividendCents: divQualified,
    investmentIncomeCents: div,
    deductionCents: inputs.deductionCents,
    ...(ficaWages !== undefined ? { medicareWagesCents: ficaWages + rsu } : {}),
    state: settings,
  }
  const view = (y: number, i: TaxInputs, w: number, r: number, d: number, carryIn: { st: number; lt: number }, st: number, lt: number, p: YearPlan): YearView => ({
    year: y,
    wagesCents: w,
    rsuCents: r,
    dividendsCents: d,
    otherCents: settings.otherIncomeCents,
    stGainCents: st,
    ltGainCents: lt,
    plannedStCents: p.plannedStCents,
    plannedLtCents: p.plannedLtCents,
    forecastLossCents: p.forecastLossCents,
    carryInStCents: carryIn.st,
    carryInLtCents: carryIn.lt,
    deductionCents: i.deductionCents,
    tax: computeTax(i),
    marginal: marginalRates(i),
  })
  return {
    thisInputs: planned,
    nextBase,
    plain: { thisYear: inputs, nextYear: { ...nextBase, stGainCents: 0, ltGainCents: 0 } },
    out,
    view: {
      // This year's realized gains apart from the carryover the return brought in (Taxes' setting): the inputs net the two.
      thisYear: view(
        year,
        planned,
        out.incomes.wagesCents,
        out.incomes.rsuYtdCents + out.incomes.rsuProjectedCents,
        out.incomes.dividendsYtdCents,
        { st: out.incomes.carryInStCents, lt: out.incomes.carryInLtCents },
        out.incomes.realizedStCents,
        out.incomes.realizedLtCents,
        planThis,
      ),
      nextYear: view(next, nextBase, wages, rsu, div, carry, 0, 0, planNext),
      basis,
      vintage: `${TAX_DATA_VINTAGE} — held for ${next}`,
    },
  }
}

export function getTwoYear(db: DbLike, today: string): TwoYear {
  return context(db, today).view
}

/** The two-year context for other derivations (engine/capacity.ts, the Checkup): the inputs with and without the plan, and the year picture — built on `picture` when the caller already has it. */
export function twoYearContext(db: DbLike, today: string, picture?: ReturnType<typeof taxYear>): Context {
  return context(db, today, picture)
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

/** The same change made this year (`now`; next year feels it through the carryforward) or next year instead (`later`), over both years' tax. */
function bothYears(c: Context, now: (i: TaxInputs) => TaxInputs, later: (i: TaxInputs) => TaxInputs = now): Omit<Timing, 'kind' | 'amountCents'> {
  const tax = (i: TaxInputs) => computeTax(i).totalCents
  const nowThis = now(c.thisInputs)
  const n = { thisYear: tax(nowThis), nextYear: tax(nextWith(c, nowThis)) }
  const l = { thisYear: tax(c.thisInputs), nextYear: tax(later(nextWith(c, c.thisInputs))) }
  const nowTotal = n.thisYear + n.nextYear
  const laterTotal = l.thisYear + l.nextYear
  return { nowCents: { ...n, total: nowTotal }, laterCents: { ...l, total: laterTotal }, nowSavesCents: laterTotal - nowTotal }
}

/** POST /api/tax/timing (read-like): the same amount, this year or next, priced over both years. */
export function priceTiming(db: DbLike, today: string, b: { kind?: unknown; amountCents?: unknown }): Timing {
  if (!KINDS.includes(b?.kind as TimingKind)) bad(`kind must be one of ${KINDS.join(', ')}`)
  if (!Number.isSafeInteger(b.amountCents) || (b.amountCents as number) <= 0) bad('amountCents must be a positive integer')
  const kind = b.kind as TimingKind
  const amount = b.amountCents as number
  return { kind, amountCents: amount, ...bothYears(context(db, today), (i) => withAmount(i, kind, amount)) }
}

/**
 * Capital gains or losses (negative) realized before Dec 31 — `now`, by
 * term — or in January instead, where a lot may count long-term by then
 * (`later`): the timing question for lots, over both years.
 */
export function priceCapitalTiming(c: Context, now: { stCents: number; ltCents: number }, later: { stCents: number; ltCents: number } = now) {
  const add = (x: { stCents: number; ltCents: number }) => (i: TaxInputs): TaxInputs => ({
    ...i,
    stGainCents: i.stGainCents + x.stCents,
    ltGainCents: i.ltGainCents + x.ltCents,
  })
  return bothYears(c, add(now), add(later))
}
