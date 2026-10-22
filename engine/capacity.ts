import { addDaysIso, monthEndIso, monthsBetween } from '../shared/dates'
import type { AccountFlowRow, HarvestProfile } from '../shared/invest-api'
import { formatDollars, formatPercentMicro, formatQtyMicro } from '../shared/money'
import { listAccountFlows } from './account-flows'
import type { DbLike } from './db'
import { accountForecasts, forecastAfter, forecastLossIn, lossBetween, type AccountForecast } from './harvest'
import { loadHoldings } from './holdings'
import { saleRealized } from './lots'
import { plannedSaleGains, type PlannedGain } from './planned-sales'
import { computeTax, TAX_DATA_VINTAGE } from './tax'
import { lossCarry, twoYearContext, type Context } from './twoyear'

/**
 * Loss capacity (GET /api/tax/capacity): the plan around a managed tax-aware
 * strategy, year by year. On one side the losses — what the broker has
 * reported so far this year, the manager's forecast for the rest and for the
 * years ahead (engine/harvest.ts), and the loss carried in; on the other the
 * gains — recorded sales so far and the sales planned (engine/planned-sales.ts).
 * Each year nets the two the way Schedule D does, carries the rest forward
 * by character, and prices what is left to pay on this household's own
 * brackets (this year's tables held for later years, as the two-year view
 * holds them). A chart series carries both sides through the calendar.
 *
 * Everything here is derived on every read; the only stored inputs are the
 * four tables of migration 28 and the Taxes settings. An estimate, labelled
 * one: `basis` says what was assumed and `leavesOut` what was not modeled.
 */

/** How many years past this one the view reaches at most. */
export const MAX_HORIZON_YEARS = 5

export type CapacityYear = {
  year: number
  /** Realized so far from recorded sales in taxable lots accounts (this year only), by term. */
  salesStCents: number
  salesLtCents: number
  /** Planned sales in this year, by term, as the lots stand today. */
  plannedStCents: number
  plannedLtCents: number
  /** What brokers reported for managed accounts so far (this year only; negative = loss). */
  reportedCents: number
  /** Further losses the forecast expects in the year (negative = loss). */
  forecastCents: number
  carryInStCents: number
  carryInLtCents: number
  /** After netting short against long and the carry-in: what the return taxes. */
  netStCents: number
  netLtCents: number
  /** Net loss applied against ordinary income (at most $3,000). */
  capLossUsedCents: number
  carryOutStCents: number
  carryOutLtCents: number
  /** Losses left unused at year end — room for gains realized before Dec 31 at no tax — and what carries into the next year. */
  roomCents: number
  /** The year's whole tax with this plan, and the part of it the capital side accounts for (negative when a loss lowers ordinary income). */
  taxCents: number
  capGainsTaxCents: number
  /** Any forecast or plan in the figures (this year's facts alone: false). */
  est: boolean
}

export type CapacityAccount = {
  accountId: number
  name: string
  profile: HarvestProfile | null
  /** This year's figure as the broker reported it (negative = loss), and the day it runs through. */
  reported: { cents: number; asOf: string } | null
  flows: AccountFlowRow[]
  /** Expected further losses by year (positive cents); empty without a profile. */
  byYear: { year: number; cents: number }[]
  balanceCents: number | null
  balanceOn: string | null
  notes: string[]
}

/** A chart reading: a day, a value in cents (null breaks the line between years), estimated or not. */
export type CapacityPoint = { t: string; v: number | null; est?: boolean }

export type Capacity = {
  today: string
  thisYear: number
  years: CapacityYear[]
  sales: PlannedGain[]
  accounts: CapacityAccount[]
  series: {
    /** Losses available, cumulative within each year from its carry-in: reported, then forecast (dashed). */
    losses: CapacityPoint[]
    /** Gains realized, cumulative within each year: recorded sales, then planned ones (dashed). A step. */
    gains: CapacityPoint[]
  }
  /** One per planned sale, for the chart's markers. */
  markers: { id: string; t: string; label: string }[]
  basis: string[]
  leavesOut: string[]
  vintage: string
}

const yearOf = (iso: string) => Number(iso.slice(0, 4))

/** Where this year's reported figures run through: the latest day among the accounts that reported. */
function reportedThrough(rows: readonly { as_of: string }[]): string | null {
  let last: string | null = null
  for (const r of rows) if (last === null || r.as_of > last) last = r.as_of
  return last
}

/** The plan netted year by year — what getCapacity draws and saleCoverage reads. */
type Netted = { c: Context; thisYear: number; sales: PlannedGain[]; forecasts: AccountForecast[]; years: CapacityYear[] }

function netted(db: DbLike, today: string, c: Context): Netted {
  const { out } = c
  const thisYear = out.year
  const sales = plannedSaleGains(db, today)
  const statedYears = (db.prepare('SELECT COALESCE(MAX(tax_year), 0) AS y FROM harvest_forecasts').get() as { y: number }).y
  const lastSaleYear = sales.reduce((m, s) => Math.max(m, yearOf(s.planned_on)), 0)
  const through = Math.min(thisYear + MAX_HORIZON_YEARS, Math.max(thisYear + 1, lastSaleYear, statedYears))
  const forecasts = accountForecasts(db, today, through)
  const years: CapacityYear[] = []
  let carryIn = { st: out.incomes.carryInStCents, lt: out.incomes.carryInLtCents }
  for (let y = thisYear; y <= through; y++) {
    const isThis = y === thisYear
    const mine = sales.filter((s) => yearOf(s.planned_on) === y)
    const plannedSt = mine.reduce((s, g) => s + g.st_cents, 0)
    const plannedLt = mine.reduce((s, g) => s + g.lt_cents, 0)
    const forecast = forecastLossIn(forecasts, y)
    const salesSt = isThis ? out.incomes.realizedStCents - out.incomes.reportedStCents : 0
    const salesLt = isThis ? out.incomes.realizedLtCents - out.incomes.reportedLtCents : 0
    const reportedSt = isThis ? out.incomes.reportedStCents : 0
    const reportedLt = isThis ? out.incomes.reportedLtCents : 0
    const st = salesSt + reportedSt + plannedSt - forecast - carryIn.st
    const lt = salesLt + reportedLt + plannedLt - carryIn.lt
    const base = isThis ? c.plain.thisYear : c.plain.nextYear
    const inputs = { ...base, stGainCents: st, ltGainCents: lt }
    const tax = computeTax(inputs)
    const none = computeTax({ ...inputs, stGainCents: 0, ltGainCents: 0 })
    const carry = lossCarry(st, lt)
    years.push({
      year: y,
      salesStCents: salesSt,
      salesLtCents: salesLt,
      plannedStCents: plannedSt,
      plannedLtCents: plannedLt,
      reportedCents: reportedSt + reportedLt,
      forecastCents: 0 - forecast, // never -0
      carryInStCents: carryIn.st,
      carryInLtCents: carryIn.lt,
      netStCents: tax.netStCents,
      netLtCents: tax.netLtCents,
      capLossUsedCents: tax.capLossUsedCents,
      carryOutStCents: carry.st,
      carryOutLtCents: carry.lt,
      roomCents: carry.st + carry.lt,
      taxCents: tax.totalCents,
      capGainsTaxCents: tax.totalCents - none.totalCents,
      est: !isThis || forecast !== 0 || mine.length > 0,
    })
    carryIn = carry
  }
  return { c, thisYear, sales, forecasts, years }
}

export function getCapacity(db: DbLike, today: string): Capacity {
  const { c, thisYear, sales, forecasts, years } = netted(db, today, twoYearContext(db, today))
  const { out } = c

  // This year's recorded sales, dated, from taxable lots accounts — the gains line's solid part.
  const dated = new Map<string, number>()
  for (const h of loadHoldings(db, today)) {
    if (h.sheltered) continue
    for (const s of h.pos.sales) {
      if (yearOf(s.traded_on) !== thisYear) continue
      const r = saleRealized(s)
      dated.set(s.traded_on, (dated.get(s.traded_on) ?? 0) + r.st_cents + r.lt_cents)
    }
  }

  /* ---------- the series ---------- */
  const losses: CapacityPoint[] = []
  const gains: CapacityPoint[] = []
  const markers: Capacity['markers'] = []
  const reportedTotal = out.incomes.reportedStCents + out.incomes.reportedLtCents
  const reportedOn = reportedThrough(out.incomes.reported)
  const todayMonth = today.slice(0, 7)
  for (const row of years) {
    const y = row.year
    const isThis = y === thisYear
    const jan1 = `${y}-01-01`
    const dec31 = `${y}-12-31`
    const start = row.carryInStCents + row.carryInLtCents
    if (!isThis) {
      // A gap between years: each year's capacity starts over from its carry-in.
      losses.push({ t: jan1, v: null })
      gains.push({ t: jan1, v: null })
    }
    const first = isThis ? jan1 : addDaysIso(jan1, 1)
    losses.push({ t: first, v: start, est: !isThis })
    gains.push({ t: first, v: 0, est: !isThis })

    // Losses: the broker's figures (this year), then the forecast month by month.
    let actual = 0
    let from = `${y - 1}-12-31`
    if (isThis && reportedOn) {
      actual = -reportedTotal
      losses.push({ t: reportedOn, v: start + actual })
      from = reportedOn
    }
    const forecastAt = (through: string) => {
      let sum = 0
      for (const f of forecasts) sum += lossBetween(f.windows, forecastAfter(f, y, thisYear), through)
      return sum
    }
    const firstMonth = isThis ? (from.slice(0, 7) > todayMonth ? from.slice(0, 7) : todayMonth) : `${y}-01`
    for (const m of monthsBetween(firstMonth, `${y}-12`)) {
      const end = monthEndIso(m)
      if (end <= from) continue
      losses.push({ t: end, v: start + actual + forecastAt(end), est: true })
    }

    // Gains: recorded sales (this year) as they happened, then the planned ones — a step.
    let cum = 0
    if (isThis)
      for (const [on, cents] of [...dated.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        cum += cents
        gains.push({ t: on, v: cum })
      }
    const mine = sales.filter((s) => yearOf(s.planned_on) === y)
    for (const s of mine) {
      cum += s.st_cents + s.lt_cents
      gains.push({ t: s.planned_on, v: cum, est: true })
      markers.push({ id: `sale:${s.id}`, t: s.planned_on, label: `${s.symbol} ${formatQtyMicro(s.qty_micro)}` })
    }
    gains.push({ t: dec31, v: cum, est: !isThis || mine.length > 0 || dec31 > today })
  }

  /* ---------- the accounts ---------- */
  const accounts: CapacityAccount[] = []
  const managed = db
    .prepare("SELECT id, name FROM invest_accounts WHERE tracking = 'balance' AND kind != 'retirement' ORDER BY sort, id")
    .all() as { id: number; name: string }[]
  const latestBalance = db.prepare('SELECT balance_cents, balanced_on FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on DESC LIMIT 1')
  for (const a of managed) {
    const f: AccountForecast | undefined = forecasts.find((x) => x.accountId === a.id)
    const rep = out.incomes.reported.find((r) => r.invest_account_id === a.id)
    const bal = (latestBalance.get(a.id) as { balance_cents: number; balanced_on: string } | undefined) ?? null
    accounts.push({
      accountId: a.id,
      name: a.name,
      profile: f?.profile ?? null,
      reported: f?.reported ?? (rep ? { cents: rep.st_cents + rep.lt_cents, asOf: rep.as_of } : null),
      flows: listAccountFlows(db, today, { accountId: a.id }),
      byYear: f?.byYear ?? [],
      balanceCents: f ? f.balanceCents : bal?.balance_cents ?? null,
      balanceOn: f ? f.balanceOn : bal?.balanced_on ?? null,
      notes: f ? f.notes : ['No harvest forecast entered: its reported figures count, and nothing further is expected.'],
    })
  }

  /* ---------- what was assumed, and what was not ---------- */
  const basis: string[] = []
  const thisRow = years[0]!
  basis.push(
    `Realized so far in ${thisYear}: ${formatDollars(thisRow.salesStCents + thisRow.salesLtCents, { sign: true })} from recorded sales, ${formatDollars(thisRow.reportedCents, { sign: true })} as brokers report it${reportedOn ? ` through ${reportedOn}` : ''}`,
  )
  if (thisRow.carryInStCents + thisRow.carryInLtCents > 0)
    basis.push(`Loss carried into ${thisYear} from the last return: ${formatDollars(thisRow.carryInStCents + thisRow.carryInLtCents)} (Taxes settings)`)
  for (const f of forecasts) {
    const p = f.profile
    const stated = p.years.map((y) => `${y.tax_year} ${formatDollars(y.loss_cents)}`).join(', ')
    basis.push(
      `${f.account}: the manager's ${stated ? `figures (${stated})` : 'later rate on the standing book'}; new money ${formatPercentMicro(p.year1_micro, 0)} in its first year, ${formatPercentMicro(p.year2_micro, 0)} in its second, ${formatPercentMicro(p.later_micro, 0)} a year after${p.source ? ` — ${p.source}` : ''}, as of ${p.as_of}`,
    )
  }
  if (sales.length)
    basis.push(
      `${sales.length} planned sale${sales.length === 1 ? '' : 's'}: proceeds at the typed price or today's quote, basis from the lots as they stand (FIFO), long-term by the planned day`,
    )
  basis.push(
    `Each year nets short against long and the carry-in (§1211, §1222); a net loss offsets $3,000 of ordinary income and carries forward by character (§1212(b)); ${thisYear}'s brackets held for later years`,
  )
  const leavesOut = [
    'Forecast losses are taken as short-term — a tax-aware strategy’s usual character; the broker’s report settles the split.',
    'A withdrawal doesn’t reduce the forecast; after a large one the manager’s figures want re-entering.',
    'Prices move: a planned sale’s proceeds follow today’s quote unless a price is typed, and its lots are today’s.',
    'Wash sales, state conformity beyond the Taxes settings and later years’ brackets are not modeled.',
  ]
  return {
    today,
    thisYear,
    years,
    sales,
    accounts,
    series: { losses, gains },
    markers,
    basis,
    leavesOut,
    vintage: `${TAX_DATA_VINTAGE} — held for later years`,
  }
}

/* ======================= a planned sale on its day ======================= */

/** One planned sale against the losses its year expects by the end of its day — and by Dec 31. */
export type SaleCoverage = {
  sale: PlannedGain
  year: number
  /** Loss carried into the sale's year (from the return, or the years before netted with the plan). */
  carryInCents: number
  /** This year only: realized so far — recorded sales and broker reports together (negative = a net loss). */
  realizedCents: number
  /** The forecast's expected losses from where it takes over through the sale's day, and after it through Dec 31 (positive). */
  forecastByCents: number
  forecastAfterCents: number
  /** Planned sales before it in the year (negative = losses). */
  earlierCents: number
  /** The year's net capital position at the end of the sale's day without it: negative is room left. */
  netBeforeCents: number
  /** The sale's gain the year doesn't cover by then, and by Dec 31 with the whole forecast and the rest of the plan. */
  uncoveredCents: number
  uncoveredAtYearEndCents: number
  /** The year's tax with the sale less without it: as its day stands (no losses after it), and at Dec 31. */
  taxByThenCents: number
  taxByYearEndCents: number
  /** The forecasts it leans on: each managed account and the day its estimate was given. */
  forecasts: { account: string; asOf: string }[]
}

/**
 * Every planned sale from today on, netted against what its year holds by
 * the end of its day: the carry-in, this year's realized gains and losses,
 * the forecast's expected losses through that day, and the planned sales
 * before it. The return nets the whole year whatever the order, so a sale
 * the day doesn't cover rests on losses expected later — or is taxed. Years
 * past the capacity view's horizon are left out. `c` is the two-year context
 * when the caller has one.
 */
export function saleCoverage(db: DbLike, today: string, c: Context = twoYearContext(db, today)): SaleCoverage[] {
  const { thisYear, sales, forecasts, years } = netted(db, today, c)
  const { incomes } = c.out
  const out: SaleCoverage[] = []
  for (const s of sales) {
    const y = yearOf(s.planned_on)
    const row = years.find((r) => r.year === y)
    if (!row || s.planned_on < today) continue
    const isThis = y === thisYear
    const base = isThis ? c.plain.thisYear : c.plain.nextYear
    const facts = isThis ? { st: incomes.realizedStCents, lt: incomes.realizedLtCents } : { st: 0, lt: 0 }
    const expected = (through: string) => forecasts.reduce((sum, f) => sum + lossBetween(f.windows, forecastAfter(f, y, thisYear), through), 0)
    const byThen = expected(s.planned_on)
    const byEnd = expected(`${y}-12-31`)
    // In planned order (day, then id): the ones before it, and the rest of its year.
    const mine = sales.filter((g) => yearOf(g.planned_on) === y)
    const at = mine.findIndex((g) => g.id === s.id)
    const total = (gs: PlannedGain[]) => ({ st: gs.reduce((t, g) => t + g.st_cents, 0), lt: gs.reduce((t, g) => t + g.lt_cents, 0) })
    const earlier = total(mine.slice(0, at))
    const rest = total(mine.slice(at + 1))
    const position = (st: number, lt: number, forecast: number) => ({
      st: facts.st + st - forecast - row.carryInStCents,
      lt: facts.lt + lt - row.carryInLtCents,
    })
    const before = position(earlier.st, earlier.lt, byThen)
    const after = position(earlier.st + s.st_cents, earlier.lt + s.lt_cents, byThen)
    const endWithout = position(earlier.st + rest.st, earlier.lt + rest.lt, byEnd)
    const endWith = position(earlier.st + rest.st + s.st_cents, earlier.lt + rest.lt + s.lt_cents, byEnd)
    const net = (p: { st: number; lt: number }) => p.st + p.lt
    const uncovered = (w: { st: number; lt: number }, wo: { st: number; lt: number }) => Math.max(0, Math.max(0, net(w)) - Math.max(0, net(wo)))
    const tax = (p: { st: number; lt: number }) => computeTax({ ...base, stGainCents: p.st, ltGainCents: p.lt }).totalCents
    out.push({
      sale: s,
      year: y,
      carryInCents: row.carryInStCents + row.carryInLtCents,
      realizedCents: facts.st + facts.lt,
      forecastByCents: byThen,
      forecastAfterCents: byEnd - byThen,
      earlierCents: earlier.st + earlier.lt,
      netBeforeCents: net(before),
      uncoveredCents: uncovered(after, before),
      uncoveredAtYearEndCents: uncovered(endWith, endWithout),
      taxByThenCents: tax(after) - tax(before),
      taxByYearEndCents: tax(endWith) - tax(endWithout),
      forecasts: forecasts.filter((f) => (f.byYear.find((b) => b.year === y)?.cents ?? 0) !== 0).map((f) => ({ account: f.account, asOf: f.profile.as_of })),
    })
  }
  return out
}
