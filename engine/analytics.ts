import { monthEndIso, monthsBetween } from '../shared/dates'
import { dayNumber, linkReturns, type PeriodFlow, type ReturnPeriod } from '../shared/perf'
import {
  MAX_SERIES_IDS,
  type ChartView,
  type Series,
  type SeriesCatalogResponse,
  type SeriesMeta,
  type SeriesPoint,
  type SeriesResponse,
  type SeriesUnit,
} from '../shared/series-api'
import type { DbLike } from './db'
import { ApiError, bad, isoDay, isoMonth } from './errors'
import { loadHoldings, type HoldingRow } from './holdings'
import { OPENING_NOTE } from './invest'
import { computePosition, positionValueCents, type Position } from './lots'
import { netWorthSeries, type NetWorthPoint } from './networth'
import { cashflowByMonth } from './services'

/**
 * The series layer behind Compare and the trend cards (contract:
 * shared/series-api.ts). Every series is derived from the ledger and prices on
 * request, monthly, with the same month-end cutoffs as netWorthSeries; nothing
 * here is stored.
 *
 * Ids dispatch on their prefix (`nw:total` → the `nw` family). Each family
 * lists its catalog entries and resolves its own ids; an id no family knows
 * becomes a warning, never an error, because saved views outlive the accounts
 * they name.
 *
 * Month-end semantics, shared with netWorthSeries: a past month is valued at
 * its last day — trades, transactions and balances dated on or before it, each
 * price at its latest close on or before it. The current month is as of today:
 * trades dated after today haven't happened, and prices are the latest known
 * (a quote stamped with tomorrow's UTC date is still today's price). Holdings
 * with no price by then are carried at cost and flagged `est: true`.
 *
 * Ranges: each series runs from the month of its own first fact to this month,
 * with every month in between (no gaps). The exceptions are the cash-based
 * series — cash:<id> and goal:fund — which run over the net-worth months,
 * because opening balances are undated and net worth counts them from its
 * first month on.
 *
 * Performance (`:twr`) is a time-weighted index of the holdings in scope —
 * price moves only, with buys and sales taken out as flows (shared/perf.ts
 * linkReturns) — and benchmarks (`bench:<SYMBOL>`) are a market price as the
 * same kind of index, so the two overlay. See the sections below.
 */

/**
 * Month-end market closes from outside the ledger, by symbol (Yahoo spelling
 * for stocks, BRK-B; the bare ticker for crypto). The shared monthly history
 * pack plugs in here: it is read in memory, so benchmarks never enter the
 * database or the vault. Rows oldest first; null when the symbol isn't known.
 * `kind` picks between a stock and a coin that share a ticker (the BTC trust vs
 * bitcoin); without it a stock wins (engine/prices.ts packMarket).
 */
export type MarketHistory = {
  closes(symbol: string, kind?: 'stock' | 'crypto'): readonly { on: string; cents: number }[] | null
}

/**
 * GET /api/series, parsed. getSeries validates it. `market` is supplied by the
 * caller, never parsed from a request; `marketPending` is the caller's reason
 * there is no market history yet (a benchmark with no closes says it).
 */
export type SeriesQuery = { ids: string[]; from?: string; to?: string; market?: MarketHistory; marketPending?: string }

/** One request's shared state: families memoize their ledger passes here, so several ids cost one pass. */
type Ctx = {
  db: DbLike
  today: string
  thisMonth: string
  /** The requested month window (performance coverage is judged inside it); absent for the catalog. */
  from?: string
  to?: string
  market?: MarketHistory
  marketPending?: string
  nw: () => NetWorthPoint[]
  book: () => Book
  bank: () => Bank
  estate: () => Estate
  flows: () => MonthFlow[]
}

/**
 * A family's answer: the series; the series with a warning explaining it
 * (a performance index whose points are null for lack of prices); a specific
 * warning alone (the id is known but can't be drawn); or null (not an id it serves).
 */
type Resolved = Series | { series: Series; warning: string } | string | null

type Family = {
  catalog: (ctx: Ctx) => SeriesMeta[]
  resolve: (ctx: Ctx, id: string) => Resolved
}

const once = <T>(f: () => T): (() => T) => {
  let v: { value: T } | undefined
  return () => (v ??= { value: f() }).value
}

type MarketOpts = { market?: MarketHistory; marketPending?: string }

function context(db: DbLike, today: string, o: { from?: string; to?: string } & MarketOpts = {}): Ctx {
  const ctx: Ctx = {
    db,
    today,
    thisMonth: today.slice(0, 7),
    ...o,
    nw: once(() => netWorthSeries(db, today)),
    book: once(() => loadBook(ctx)),
    bank: once(() => loadBank(db)),
    estate: once(() => loadEstate(db)),
    flows: once(() => loadCashflow(ctx)),
  }
  return ctx
}

/* ---------- month machinery ---------- */

// The same string-compare sentinels as engine/networth.ts.
const endOf = (month: string) => `${month}-99` // after any day in the month
const LATEST = '9999-99-99' // after any date at all

/** A dated amount: a close, a balance, a valuation, a transaction. */
type Dated = { on: string; cents: number }

/** The last row dated on or before `cutoff`, from rows sorted by `on` (dates are unique per entity). */
function lastOnOrBefore(rows: Dated[], cutoff: string): Dated | undefined {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid]!.on <= cutoff) lo = mid + 1
    else hi = mid
  }
  return lo > 0 ? rows[lo - 1] : undefined
}

const monthOf = (iso: string) => iso.slice(0, 7)
const minMonth = (ms: (string | null | undefined)[]): string | null =>
  ms.reduce<string | null>((lo, m) => (m && (lo === null || m < lo) ? m : lo), null)
/** Every month from `first` through this month; [] without a first month. */
const monthsFrom = (ctx: Ctx, first: string | null) => (first === null ? [] : monthsBetween(first, ctx.thisMonth))

/** Canonical positive integer ids only: '7', never '07' or '7.0', so one row has one id. */
const ID = '[1-9][0-9]{0,15}'

const NOTHING_DATED = 'Nothing dated yet: import a statement, record a trade or add a property'

function meta(
  ctx: Ctx,
  m: { id: string; label: string; group: SeriesMeta['group']; unit?: SeriesUnit; kind?: 'level' | 'flow'; first: string | null; reason?: string },
): SeriesMeta {
  const firstMonth = m.first !== null && m.first <= ctx.thisMonth ? m.first : null
  // Only facts dated after this month: nothing to draw yet.
  const reason = m.reason ?? (firstMonth === null && m.first !== null ? 'Nothing dated on or before today' : undefined)
  return {
    id: m.id,
    label: m.label,
    group: m.group,
    unit: m.unit ?? 'cents',
    kind: m.kind ?? 'level',
    firstMonth,
    lastMonth: firstMonth === null ? null : ctx.thisMonth,
    available: reason === undefined,
    ...(reason === undefined ? {} : { reason }),
  }
}

/* ---------- nw:* — net worth and its parts ---------- */

type NwPart = 'total' | 'cash' | 'brokerage' | 'retirement' | 'crypto' | 'property' | 'liabilities' | 'equity'

// Catalog order. Values are exactly the netWorthSeries fields (liabilities
// negative, as they enter the sum); equity is the Dashboard's home equity,
// property value less every liability.
const NW_PARTS: Record<NwPart, { label: string; value: (p: NetWorthPoint) => number; none?: string }> = {
  total: { label: 'Net worth', value: (p) => p.total },
  cash: { label: 'Cash', value: (p) => p.cash, none: 'No bank balances recorded' },
  brokerage: { label: 'Brokerage', value: (p) => p.brokerage, none: 'Nothing held in brokerage accounts' },
  retirement: { label: 'Retirement', value: (p) => p.retirement, none: 'Nothing held in retirement accounts' },
  crypto: { label: 'Crypto', value: (p) => p.crypto, none: 'No crypto holdings' },
  property: { label: 'Property value', value: (p) => p.property, none: 'No properties recorded' },
  liabilities: { label: 'Liabilities', value: (p) => p.liabilities, none: 'No loan balances recorded' },
  equity: { label: 'Home equity', value: (p) => p.property + p.liabilities, none: 'No properties recorded' },
}
const isNwPart = (s: string): s is NwPart => Object.hasOwn(NW_PARTS, s)

/**
 * Why a part isn't worth offering, or undefined when it is. The total always
 * is once anything is dated; a part that is zero in every month has nothing to
 * plot; equity needs a property, however much is owed.
 */
function nwUnavailable(nw: NetWorthPoint[], part: NwPart): string | undefined {
  if (nw.length === 0) return NOTHING_DATED
  const { none } = NW_PARTS[part]
  if (none === undefined) return undefined
  const basis = NW_PARTS[part === 'equity' ? 'property' : part].value
  return nw.every((p) => basis(p) === 0) ? none : undefined
}

const netWorth: Family = {
  catalog(ctx) {
    const nw = ctx.nw()
    return (Object.keys(NW_PARTS) as NwPart[]).map((part): SeriesMeta => {
      const reason = nwUnavailable(nw, part)
      return {
        id: `nw:${part}`,
        label: NW_PARTS[part].label,
        group: 'Net worth',
        unit: 'cents',
        kind: 'level',
        firstMonth: nw[0]?.month ?? null,
        lastMonth: nw[nw.length - 1]?.month ?? null,
        available: reason === undefined,
        ...(reason === undefined ? {} : { reason }),
      }
    })
  },
  resolve(ctx, id) {
    const part = id.slice('nw:'.length)
    if (!isNwPart(part)) return null
    const { label, value } = NW_PARTS[part]
    return { id, label, unit: 'cents', kind: 'level', points: ctx.nw().map((p) => ({ t: p.month, v: value(p) })) }
  },
}

/* ---------- the investment book: holdings per (account, asset), by month ---------- */

/** One lots-tracked (account, asset) pair: the unit every holdings series sums. */
type Line = {
  accountId: number
  assetId: number
  first: string // month of its first trade
  trades: HoldingRow['trades'] // dated on or before today, oldest first
}
/** One line at one month end. `unpriced`: shares held with no price on or before the cutoff, so value = cost. */
type Cell = { value: number; cost: number; unpriced: boolean }
const EMPTY: Cell = { value: 0, cost: 0, unpriced: false }

type BookAccount = { id: number; name: string } & ({ tracking: 'lots' } | { tracking: 'balance'; snaps: Dated[] })

type Book = {
  lines: Line[]
  /** The first trade's month through this month: the grid every line's cells align to. */
  months: string[]
  cells: (line: Line) => Cell[]
  /** A line's trades as flows, by index into `months` (see lineFlows). */
  flows: (line: Line) => Map<number, PeriodFlow[] | null>
  /** The time-weighted index of some lines (see twrCalc), memoized by the set of lines. */
  twr: (lines: Line[]) => TwrCalc
  /** Every investment account, in the account strip's order (sort, then id): lots-tracked ones by their trades, balance-tracked ones by their snapshots. */
  accounts: BookAccount[]
  assets: Map<number, { symbol: string; prices: Dated[] }>
}

function loadBook(ctx: Ctx): Book {
  const { db } = ctx
  // One pass over the trades (loadHoldings as of today), cut at each month end
  // below: the same positions loadHoldings({ asOf: monthEnd }) would give, and
  // the same per-account pooling as the portfolio and net worth.
  const lines: Line[] = loadHoldings(db, ctx.today).map((h) => ({
    accountId: h.investAccountId,
    assetId: h.assetId,
    first: monthOf(h.trades[0]!.traded_on),
    trades: h.trades,
  }))
  const accounts = db.prepare('SELECT id, name, tracking FROM invest_accounts ORDER BY sort, id').all() as {
    id: number
    name: string
    tracking: 'lots' | 'balance'
  }[]
  const snaps = db
    .prepare('SELECT invest_account_id AS id, balanced_on AS "on", balance_cents AS cents FROM balance_snapshots ORDER BY balanced_on')
    .all() as ({ id: number } & Dated)[]
  const assetRows = db.prepare('SELECT id, symbol FROM assets ORDER BY id').all() as { id: number; symbol: string }[]
  const priceRows = db
    .prepare('SELECT asset_id AS id, priced_on AS "on", close_cents AS cents FROM prices ORDER BY asset_id, priced_on')
    .all() as ({ id: number } & Dated)[]

  const assets = new Map(assetRows.map((a) => [a.id, { symbol: a.symbol, prices: [] as Dated[] }]))
  for (const p of priceRows) assets.get(p.id)?.prices.push({ on: p.on, cents: p.cents })
  const months = monthsFrom(ctx, minMonth(lines.map((l) => l.first)))

  const memo = new Map<Line, Cell[]>()
  const cells = (line: Line) => {
    let c = memo.get(line)
    if (!c) memo.set(line, (c = lineCells(ctx, months, line, assets.get(line.assetId)?.prices ?? [])))
    return c
  }
  const flowMemo = new Map<Line, Map<number, PeriodFlow[] | null>>()
  const flows = (line: Line) => {
    let f = flowMemo.get(line)
    if (!f) flowMemo.set(line, (f = lineFlows(ctx, months, line, assets.get(line.assetId)?.prices ?? [])))
    return f
  }
  const twrMemo = new Map<string, TwrCalc>()
  const book: Book = {
    lines,
    months,
    cells,
    flows,
    twr: (scope) => {
      const key = scope.map((l) => lines.indexOf(l)).join(',')
      let t = twrMemo.get(key)
      if (!t) twrMemo.set(key, (t = twrCalc(ctx, book, scope)))
      return t
    },
    accounts: accounts.map(({ id, name, tracking }): BookAccount =>
      tracking === 'lots'
        ? { id, name, tracking }
        : { id, name, tracking, snaps: snaps.filter((s) => s.id === id).map(({ on, cents }) => ({ on, cents })) },
    ),
    assets,
  }
  return book
}

/** A line's value and cost at each month end of the book's grid; EMPTY before its first trade and once it is sold out. */
function lineCells(ctx: Ctx, months: string[], line: Line, prices: Dated[]): Cell[] {
  let taken = -1
  let pos: Position | undefined
  return months.map((m) => {
    if (m < line.first) return EMPTY
    const current = m === ctx.thisMonth
    const cutoff = current ? ctx.today : endOf(m)
    let n = taken < 0 ? 0 : taken
    while (n < line.trades.length && line.trades[n]!.traded_on <= cutoff) n++
    // Trades are oldest first, so each month is a prefix; recompute only when it grows.
    if (n !== taken || !pos) {
      pos = computePosition(line.trades.slice(0, n), ctx.today)
      taken = n
    }
    if (pos.qty_micro === 0) return EMPTY
    const price = lastOnOrBefore(prices, current ? LATEST : endOf(m))
    return price
      ? { value: positionValueCents(pos.qty_micro, price.cents), cost: pos.cost_cents, unpriced: false }
      : { value: pos.cost_cents, cost: pos.cost_cents, unpriced: true }
  })
}

type Metric = 'value' | 'cost'
const METRIC_LABEL: Record<Metric, string> = { value: 'value', cost: 'cost basis' }

/** The sum of some lines, month by month, from the first one's first month. `est` marks months valued partly at cost. */
function sumLines(book: Book, lines: Line[], metric: Metric): SeriesPoint[] {
  const first = minMonth(lines.map((l) => l.first))
  if (first === null) return []
  const cols = lines.map((l) => book.cells(l))
  const points: SeriesPoint[] = []
  for (let i = book.months.indexOf(first); i >= 0 && i < book.months.length; i++) {
    let v = 0
    let est = false
    for (const col of cols) {
      const cell = col[i]!
      v += cell[metric]
      if (metric === 'value' && cell.unpriced) est = true
    }
    points.push(est ? { t: book.months[i]!, v, est: true } : { t: book.months[i]!, v })
  }
  return points
}

const holdingsSeries = (book: Book, id: string, label: string, lines: Line[], metric: Metric): Series => ({
  id,
  label: `${label} · ${METRIC_LABEL[metric]}`,
  unit: 'cents',
  kind: 'level',
  points: sumLines(book, lines, metric),
})

/** What a holdings id can ask for: its value, its cost basis, or its time-weighted return. */
type Measure = Metric | 'twr'

/** Resolves a holdings id: value and cost sum the lines; twr indexes them (see below). */
const holdingsMeasure = (ctx: Ctx, book: Book, id: string, label: string, lines: Line[], measure: Measure, securitiesOnly = false): Resolved =>
  measure === 'twr' ? twrSeries(ctx, book, id, label, lines, securitiesOnly) : holdingsSeries(book, id, label, lines, measure)

/* ---------- :twr — time-weighted return of a set of lines ---------- */

// Monthly periods, chain-linked (shared/perf.ts linkReturns): each month's
// return is Modified Dietz over the lines in scope, with their trades as the
// flows — a buy puts money to work, a sale takes it out — so buying more is not
// a gain and selling is not a loss. The index is index_micro: 1_000_000 (= 100)
// just before the scope's first trade, so its first point already carries the
// first (partial) month's return.
//
// Month-end prices are all there is (no valuation on each trade day), so this
// is the standard approximation: exact when trades fall at month ends or the
// month's prices are flat; otherwise a trade is taken to earn the month's
// return in proportion to the days it was in. Fees count against the return.
//
// Only priced value counts. A line joins the index from its first month-end
// with a market price: a month whose start or end values it at cost leaves it
// out (with its flows), because a jump from cost to the first quote is not a
// return. Such months, and months that can't be measured at all, are marked
// `est`. When less than 90% of the value in the window (month-end values,
// summed over its months) had its return counted, every point is null and a
// warning says why: an index of a sliver of the holdings is not the holdings'.
//
// Securities only: a sale's proceeds leave the scope, as if withdrawn. Once
// brokerage accounts carry their cash (the B12 cash anchor), an account's
// index can include it; until then inv:* labels say "securities only".

/** Below this share of value priced at market over the window (micro), the index is withheld. */
export const TWR_MIN_COVERAGE_MICRO = 900_000
/** How old a close may be and still price a starting position on its as-of day. */
const ENTRY_PRICE_MAX_DAYS = 7

/** A scope's time-weighted index over the book's months, from the scope's first month. */
type TwrCalc = {
  first: number // index into book.months of the scope's first month; -1 when it has no trades
  index: number[] // index_micro at each month end from `first`
  est: boolean[] // the month's return leaves part of the scope out, or couldn't be measured
  covered: number[] // month-end value (cents) whose return counted
  total: number[] // month-end value (cents) in scope, unpriced shares at cost
}

/** Days in a month's period: the whole month, or up to today for the current one. */
const periodDays = (ctx: Ctx, month: string) => Number((month === ctx.thisMonth ? ctx.today : monthEndIso(month)).slice(8, 10))

/** A buy that was booked rather than bought: a starting position, or shares acquired before they were recorded. */
const isBooked = (t: Line['trades'][number]) =>
  t.side === 'buy' && (t.note === OPENING_NOTE || (t.acquired_on != null && t.acquired_on < t.traded_on))

/**
 * A line's trades as flows, by index into the book's months. Buys put their
 * cost to work and sales take out their proceeds, but only for shares that
 * really moved: a sale with explicit basis (shares Scarab never held), or the
 * excess of one that sells more than is held, leaves the position alone, so it
 * is no flow. A booked buy (see isBooked) carries its historical cost, not the
 * money put in that day, so its shares enter at market value on the day they
 * were booked — from a close at most a week old (any quote for a position
 * booked today). With no such close, that month's flows are null: the line's
 * return can't be measured that month.
 */
function lineFlows(ctx: Ctx, months: string[], line: Line, prices: Dated[]): Map<number, PeriodFlow[] | null> {
  const monthIndex = new Map(months.map((m, i) => [m, i]))
  const out = new Map<number, PeriodFlow[] | null>()
  // One replay of the line. Its sales come in the order its sells do (both
  // oldest first, by traded_on then id), and a sale resolves only against
  // what came before it, so each is exactly what a replay up to that sell
  // would say.
  const sales = computePosition(line.trades, ctx.today).sales
  let sold = 0
  line.trades.forEach((t) => {
    const sale = t.side === 'sell' ? sales[sold++]! : null
    const i = monthIndex.get(monthOf(t.traded_on))!
    if (out.get(i) === null) return
    let cents: number | null
    if (sale) {
      // Shares that left the lots, 0…qty: none for an explicit basis (shares
      // Scarab never held), and never the excess no lot covered.
      const removed = t.basis_cents != null && t.acquired_on ? 0 : sale.qty_micro - sale.zero_basis_qty_micro
      cents = removed <= 0 ? 0 : removed === t.qty_micro ? -t.total_cents : -Math.round((t.total_cents * removed) / t.qty_micro)
    } else if (isBooked(t)) {
      const close = lastOnOrBefore(prices, t.traded_on === ctx.today ? LATEST : t.traded_on)
      const fresh = close !== undefined && (t.traded_on === ctx.today || dayNumber(t.traded_on) - dayNumber(close.on) <= ENTRY_PRICE_MAX_DAYS)
      cents = fresh ? positionValueCents(t.qty_micro, close.cents) : null
    } else cents = t.total_cents
    if (cents === null) out.set(i, null)
    else out.set(i, [...(out.get(i) ?? []), { day: Number(t.traded_on.slice(8, 10)), cents }])
  })
  return out
}

/** The time-weighted index of some lines: one Modified Dietz period per month, over the lines priced at both ends of it. */
function twrCalc(ctx: Ctx, book: Book, lines: Line[]): TwrCalc {
  const firstMonth = minMonth(lines.map((l) => l.first))
  const first = firstMonth === null ? -1 : book.months.indexOf(firstMonth)
  if (first < 0) return { first: -1, index: [], est: [], covered: [], total: [] }
  const cols = lines.map((l) => book.cells(l))
  const flows = lines.map((l) => book.flows(l))
  const periods: ReturnPeriod[] = []
  const est: boolean[] = []
  const covered: number[] = []
  const total: number[] = []
  for (let i = first; i < book.months.length; i++) {
    let start = 0
    let end = 0
    let cov = 0
    let tot = 0
    let partial = false
    const moved: PeriodFlow[] = []
    lines.forEach((_, j) => {
      const before = i > 0 ? cols[j]![i - 1]! : EMPTY
      const now = cols[j]![i]!
      const f = flows[j]!.get(i)
      tot += now.value
      if (before.unpriced || now.unpriced || f === null) {
        if (before.value !== 0 || now.value !== 0 || f !== undefined) partial = true
        return
      }
      start += before.value
      end += now.value
      cov += now.value
      if (f) moved.push(...f)
    })
    periods.push({ start, end, days: periodDays(ctx, book.months[i]!), flows: moved })
    est.push(partial)
    covered.push(cov)
    total.push(tot)
  }
  const { index, measured } = linkReturns(periods)
  measured.forEach((ok, k) => {
    if (ok) return
    est[k] = true
    covered[k] = 0
  })
  return { first, index, est, covered, total }
}

/** The share of value (micro, floored) whose return counted over the months of `calc` inside [from, to]; null when nothing was held there. */
function twrCoverage(book: Book, calc: TwrCalc, from?: string, to?: string): number | null {
  let covered = 0
  let total = 0
  calc.index.forEach((_, k) => {
    const t = book.months[calc.first + k]!
    if ((from !== undefined && t < from) || (to !== undefined && t > to)) return
    covered += calc.covered[k]!
    total += calc.total[k]!
  })
  if (total <= 0) return null
  return Number((BigInt(covered) * 1_000_000n) / BigInt(total)) // sums of cents stay safe; their product with 1e6 may not
}

/** "only 72% of the value [in these months] had a market price; a time-weighted return needs 90%" */
const twrTooThin = (coverage: number, where: string) =>
  `only ${Math.floor(coverage / 10_000)}% of the value${where} had a market price; a time-weighted return needs ${TWR_MIN_COVERAGE_MICRO / 10_000}%`

const twrLabel = (label: string, securitiesOnly: boolean) => `${label} · time-weighted return${securitiesOnly ? ' (securities only)' : ''}`

/** Why a scope's index isn't worth offering over its whole history, or undefined when it is. */
function twrUnavailable(book: Book, lines: Line[]): string | undefined {
  const coverage = twrCoverage(book, book.twr(lines))
  if (coverage === null || coverage >= TWR_MIN_COVERAGE_MICRO) return undefined
  return `Too little price history: ${twrTooThin(coverage, '')}`
}

/**
 * A scope's index as a series, judged over the requested window: with enough
 * of its value priced there, the index (est where part of the scope was left
 * out); otherwise every point null, with the reason as a warning.
 */
function twrSeries(ctx: Ctx, book: Book, id: string, label: string, lines: Line[], securitiesOnly: boolean): Resolved {
  const calc = book.twr(lines)
  const coverage = twrCoverage(book, calc, ctx.from, ctx.to)
  const ok = coverage === null || coverage >= TWR_MIN_COVERAGE_MICRO
  const series: Series = {
    id,
    label: twrLabel(label, securitiesOnly),
    unit: 'index_micro',
    kind: 'level',
    points: calc.index.map((v, k): SeriesPoint => {
      const t = book.months[calc.first + k]!
      if (!ok) return { t, v: null }
      return calc.est[k] ? { t, v, est: true } : { t, v }
    }),
  }
  if (ok) return series
  return { series, warning: `${id}: ${twrTooThin(coverage, ' in these months')}` }
}

/* ---------- inv:* — the portfolio and each investment account ---------- */

const INV = new RegExp(`^inv:(all|${ID}):(value|cost|twr)$`)
const NO_TRADES = 'No trades recorded yet'

/** Catalog entries for one holdings scope: value, cost basis and time-weighted return, in that order. */
function holdingsEntries(ctx: Ctx, o: { prefix: string; name: string; group: SeriesMeta['group']; lines: Line[]; none: string; securitiesOnly: boolean }): SeriesMeta[] {
  const book = ctx.book()
  const first = minMonth(o.lines.map((l) => l.first))
  const reason = first === null ? o.none : undefined
  return [
    meta(ctx, { id: `${o.prefix}:value`, label: `${o.name} · ${METRIC_LABEL.value}`, group: o.group, first, reason }),
    meta(ctx, { id: `${o.prefix}:cost`, label: `${o.name} · ${METRIC_LABEL.cost}`, group: o.group, first, reason }),
    meta(ctx, {
      id: `${o.prefix}:twr`,
      label: twrLabel(o.name, o.securitiesOnly),
      group: o.group,
      unit: 'index_micro',
      first,
      reason: reason ?? twrUnavailable(book, o.lines),
    }),
  ]
}

const investments: Family = {
  catalog(ctx) {
    const book = ctx.book()
    const entries: SeriesMeta[] = []
    entries.push(...holdingsEntries(ctx, { prefix: 'inv:all', name: 'Portfolio', group: 'Accounts', lines: book.lines, none: NO_TRADES, securitiesOnly: true }))
    // In the account strip's order, whichever way each account is tracked.
    for (const a of book.accounts) {
      if (a.tracking === 'lots') {
        const lines = book.lines.filter((l) => l.accountId === a.id)
        entries.push(...holdingsEntries(ctx, { prefix: `inv:${a.id}`, name: a.name, group: 'Accounts', lines, none: 'No trades in this account yet', securitiesOnly: true }))
      } else {
        const first = a.snaps[0] ? monthOf(a.snaps[0].on) : null
        entries.push(meta(ctx, { id: `inv:${a.id}:value`, label: `${a.name} · value`, group: 'Accounts', first, reason: first === null ? 'No balances recorded yet' : undefined }))
      }
    }
    return entries
  },
  resolve(ctx, id) {
    const m = INV.exec(id)
    if (!m) return null
    const [, who, measure] = m as unknown as [string, string, Measure]
    const book = ctx.book()
    if (who === 'all') return holdingsMeasure(ctx, book, id, 'Portfolio', book.lines, measure, true)
    const accountId = Number(who)
    const a = book.accounts.find((x) => x.id === accountId)
    if (!a) return null
    if (a.tracking === 'lots') return holdingsMeasure(ctx, book, id, a.name, book.lines.filter((l) => l.accountId === accountId), measure, true)
    if (measure === 'cost') return `${id}: ${a.name} tracks a balance, not trades, so it has no cost basis`
    // Without trades there are no flows to separate from growth.
    if (measure === 'twr') return `${id}: ${a.name} tracks a balance, not trades, so it has no time-weighted return`
    // Balance-tracked: the latest snapshot on or before each month end, as net worth reads it.
    const first = a.snaps[0] ? monthOf(a.snaps[0].on) : null
    return {
      id,
      label: `${a.name} · value`,
      unit: 'cents',
      kind: 'level',
      points: monthsFrom(ctx, first).map((t) => ({ t, v: lastOnOrBefore(a.snaps, endOf(t))?.cents ?? 0 })),
    }
  },
}

/* ---------- pos:* and set:* — one holding, or several summed ---------- */

const POS = new RegExp(`^pos:(${ID}):(value|cost|twr)$`)
const SET = new RegExp(`^set:(${ID}(?:\\+${ID})*):(value|cost|twr)$`)

const positions: Family = {
  catalog(ctx) {
    const book = ctx.book()
    const assetIds = [...new Set(book.lines.map((l) => l.assetId))].sort((a, b) => a - b)
    return assetIds.flatMap((assetId) =>
      holdingsEntries(ctx, {
        prefix: `pos:${assetId}`,
        name: book.assets.get(assetId)?.symbol ?? `#${assetId}`,
        group: 'Holdings',
        lines: book.lines.filter((l) => l.assetId === assetId),
        none: NO_TRADES,
        securitiesOnly: false,
      }),
    )
  },
  resolve(ctx, id) {
    const m = POS.exec(id)
    if (!m) return null
    const book = ctx.book()
    const assetId = Number(m[1])
    const lines = book.lines.filter((l) => l.assetId === assetId)
    if (lines.length === 0) return null
    return holdingsMeasure(ctx, book, id, book.assets.get(assetId)?.symbol ?? `#${assetId}`, lines, m[2] as Measure)
  },
}

// Not in the catalog (the picker composes them from pos:* entries). Every
// member must still be a holding: a set naming one that is gone is reported,
// not quietly summed without it.
const sets: Family = {
  catalog: () => [],
  resolve(ctx, id) {
    const m = SET.exec(id)
    if (!m) return null
    const book = ctx.book()
    const assetIds = [...new Set(m[1]!.split('+').map(Number))]
    const lines = book.lines.filter((l) => assetIds.includes(l.assetId))
    const missing = assetIds.filter((a) => !lines.some((l) => l.assetId === a))
    if (missing.length > 0) return null
    const label = assetIds.map((a) => book.assets.get(a)?.symbol ?? `#${a}`).join(' + ')
    return holdingsMeasure(ctx, book, id, label, lines, m[2] as Measure)
  },
}

/* ---------- px:* — an asset's month-end price ---------- */

const PX = new RegExp(`^px:(${ID})$`)

const pricesFamily: Family = {
  catalog(ctx) {
    const book = ctx.book()
    return [...book.assets.entries()].map(([assetId, a]) =>
      meta(ctx, {
        id: `px:${assetId}`,
        label: `${a.symbol} price`,
        group: 'Prices',
        unit: 'cents_per_share',
        first: a.prices[0] ? monthOf(a.prices[0].on) : null,
        reason: a.prices.length === 0 ? 'No prices recorded yet' : undefined,
      }),
    )
  },
  resolve(ctx, id) {
    const m = PX.exec(id)
    if (!m) return null
    const a = ctx.book().assets.get(Number(m[1]))
    if (!a) return null
    const first = a.prices[0] ? monthOf(a.prices[0].on) : null
    return {
      id,
      label: `${a.symbol} price`,
      unit: 'cents_per_share',
      kind: 'level',
      points: monthsFrom(ctx, first).map((t) => ({
        t,
        v: lastOnOrBefore(a.prices, t === ctx.thisMonth ? LATEST : endOf(t))!.cents,
      })),
    }
  },
}

/* ---------- bench:* — a market benchmark as a growth index ---------- */

// A benchmark is a market price made into the same kind of index as :twr —
// index_micro, 1_000_000 (= 100) at its first month, then close ÷ first close —
// so "these holdings vs SPY" overlays once both are rebased to a common month
// (Compare's Rebased mode). Price only: dividends are in neither.
//
// Closes come from two places, merged by day: the MarketHistory passed with
// the request (the shared monthly history, for any symbol it covers), and this
// household's own price tables — prices and prices_daily — for a symbol it
// holds or held. On the same day the household's own row wins, and a daily
// close beats a refresh quote. A symbol neither knows answers with no points.
// Month ends use the valuation cutoffs (px:<assetId> reads the same way).

/** The catalog's benchmarks. Any other symbol can still be asked for by id. */
const BENCHMARKS: readonly { symbol: string; label: string; kind: 'stock' | 'crypto' }[] = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)', kind: 'stock' },
  { symbol: 'QQQ', label: 'Nasdaq-100 (QQQ)', kind: 'stock' },
  { symbol: 'VTI', label: 'US total market (VTI)', kind: 'stock' },
  { symbol: 'VXUS', label: 'International stocks (VXUS)', kind: 'stock' },
  { symbol: 'AGG', label: 'US bonds (AGG)', kind: 'stock' },
  { symbol: 'BTC', label: 'Bitcoin (BTC)', kind: 'crypto' },
]

// Upper case, Yahoo spelling: SPY, BRK-B, ^GSPC, BTC. One spelling per series,
// so BRK.B is not an id (it is asked for as BRK-B and matches a BRK.B holding).
const BENCH = /^bench:(\^?[A-Z0-9]{1,12}(?:[-=][A-Z0-9]{1,12})*)$/
const BENCH_MAX_SYMBOL = 24

/** An asset's market spelling, as the shared basket spells it (applyBasket matches the same way). */
const marketSymbol = (a: { symbol: string; kind: 'stock' | 'crypto' }) =>
  a.kind === 'stock' ? a.symbol.toUpperCase().replace(/\./g, '-') : a.symbol.toUpperCase()

const isClose = (r: { on: unknown; cents: unknown }): r is Dated =>
  typeof r.on === 'string' && isoDay.test(r.on) && Number.isSafeInteger(r.cents) && (r.cents as number) > 0

/**
 * A symbol's closes, oldest first, from the market history and the household's
 * own price tables. A ticker that is both a stock and a coin means the one the
 * household holds; otherwise the catalog's own kind (BTC is bitcoin), else the stock.
 */
function benchCloses(ctx: Ctx, symbol: string): Dated[] {
  const byDay = new Map<string, number>()
  const assets = ctx.db.prepare('SELECT id, symbol, kind FROM assets ORDER BY id').all() as { id: number; symbol: string; kind: 'stock' | 'crypto' }[]
  const asset = assets.find((a) => marketSymbol(a) === symbol)
  const kind = asset?.kind ?? BENCHMARKS.find((b) => b.symbol === symbol)?.kind
  for (const r of ctx.market?.closes(symbol, kind) ?? []) if (isClose(r)) byDay.set(r.on, r.cents)
  if (asset)
    for (const table of ['prices', 'prices_daily'] as const) // later wins the day
      for (const r of ctx.db.prepare(`SELECT priced_on AS "on", close_cents AS cents FROM ${table} WHERE asset_id = ?`).all(asset.id) as Dated[])
        if (isClose(r)) byDay.set(r.on, r.cents)
  return [...byDay].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([on, cents]) => ({ on, cents }))
}

const benchLabel = (symbol: string) => BENCHMARKS.find((b) => b.symbol === symbol)?.label ?? symbol

const benchmarks: Family = {
  catalog(ctx) {
    return BENCHMARKS.map(({ symbol, label }) => {
      const closes = benchCloses(ctx, symbol)
      return meta(ctx, {
        id: `bench:${symbol}`,
        label,
        group: 'Benchmarks',
        unit: 'index_micro',
        first: closes[0] ? monthOf(closes[0].on) : null,
        reason: closes.length === 0 ? (ctx.marketPending ?? `No price history for ${symbol} yet`) : undefined,
      })
    })
  },
  resolve(ctx, id) {
    const m = BENCH.exec(id)
    if (!m || m[1]!.length > BENCH_MAX_SYMBOL) return null
    const symbol = m[1]!
    const closes = benchCloses(ctx, symbol)
    const base = closes[0]
    const series: Series = {
      id,
      label: benchLabel(symbol),
      unit: 'index_micro',
      kind: 'level',
      points: monthsFrom(ctx, base ? monthOf(base.on) : null).map((t) => {
        const close = lastOnOrBefore(closes, t === ctx.thisMonth ? LATEST : endOf(t))!
        // close × 1e6 can pass 2^53 (BRK-A); round half up in BigInt.
        return { t, v: Number((BigInt(close.cents) * 2_000_000n + BigInt(base!.cents)) / (2n * BigInt(base!.cents))) }
      }),
    }
    // No closes because the shared history isn't there yet: say so, rather than an unexplained empty line.
    return !base && ctx.marketPending ? { series, warning: `${id}: ${ctx.marketPending}` } : series
  },
}

/* ---------- cash:* and goal:fund — bank balances ---------- */

type Bank = { accounts: { id: number; name: string; opening: number; txs: Dated[] }[] }

function loadBank(db: DbLike): Bank {
  const accounts = db.prepare('SELECT id, name, opening_cents FROM accounts ORDER BY id').all() as {
    id: number
    name: string
    opening_cents: number
  }[]
  const txs = db
    .prepare('SELECT account_id AS id, posted_on AS "on", amount_cents AS cents FROM transactions ORDER BY posted_on, id')
    .all() as ({ id: number } & Dated)[]
  return {
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      opening: a.opening_cents,
      txs: txs.filter((t) => t.id === a.id).map(({ on, cents }) => ({ on, cents })),
    })),
  }
}

/** An account's balance at each month end: its opening balance plus every transaction posted by then (net worth's arithmetic). */
function balances(months: string[], opening: number, txs: Dated[]): number[] {
  let i = 0
  let run = opening
  return months.map((m) => {
    const cutoff = endOf(m)
    while (i < txs.length && txs[i]!.on <= cutoff) run += txs[i++]!.cents
    return run
  })
}

const CASH = new RegExp(`^cash:(${ID})$`)

const cash: Family = {
  catalog(ctx) {
    const first = ctx.nw()[0]?.month ?? null
    return ctx.bank().accounts.map((a) =>
      meta(ctx, {
        id: `cash:${a.id}`,
        label: a.name,
        group: 'Accounts',
        first,
        reason: first === null ? NOTHING_DATED : a.txs.length === 0 && a.opening === 0 ? 'No transactions in this account yet' : undefined,
      }),
    )
  },
  resolve(ctx, id) {
    const m = CASH.exec(id)
    if (!m) return null
    const a = ctx.bank().accounts.find((x) => x.id === Number(m[1]))
    if (!a) return null
    const months = ctx.nw().map((p) => p.month)
    const bal = balances(months, a.opening, a.txs)
    return { id, label: a.name, unit: 'cents', kind: 'level', points: months.map((t, i) => ({ t, v: bal[i]! })) }
  },
}

/**
 * The Goal screen's fund settings, read straight from goal_settings with the
 * same defaults (no accounts, nothing earmarked). A malformed value reads as
 * the default rather than failing the whole series request.
 */
function fundSettings(db: DbLike): { accountIds: number[]; extraCents: number } {
  const row = db.prepare("SELECT value FROM goal_settings WHERE key = 'goal'").get() as { value: string } | undefined
  let goal: Record<string, unknown> = {}
  try {
    const parsed: unknown = row ? JSON.parse(row.value) : {}
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) goal = parsed as Record<string, unknown>
  } catch {
    // a malformed setting reads as the defaults
  }
  const ids = Array.isArray(goal.fundAccountIds) ? goal.fundAccountIds.filter((v): v is number => Number.isSafeInteger(v)) : []
  const extra = Number.isSafeInteger(goal.fundExtraCents) ? (goal.fundExtraCents as number) : 0
  return { accountIds: ids, extraCents: extra }
}

const goalFund: Family = {
  catalog(ctx) {
    const { accountIds } = fundSettings(ctx.db)
    const funded = ctx.bank().accounts.some((a) => accountIds.includes(a.id))
    const first = ctx.nw()[0]?.month ?? null
    return [
      meta(ctx, {
        id: 'goal:fund',
        label: 'Goal fund',
        group: 'Goal',
        first,
        reason: first === null ? NOTHING_DATED : !funded ? 'Choose the accounts that fund the goal on the Goal screen' : undefined,
      }),
    ]
  },
  resolve(ctx, id) {
    if (id !== 'goal:fund') return null
    // As the Goal screen totals it: the chosen bank accounts plus whatever is earmarked elsewhere.
    const { accountIds, extraCents } = fundSettings(ctx.db)
    const months = ctx.nw().map((p) => p.month)
    const sum = months.map(() => extraCents)
    for (const a of ctx.bank().accounts)
      if (accountIds.includes(a.id)) balances(months, a.opening, a.txs).forEach((b, i) => (sum[i]! += b))
    return { id, label: 'Goal fund', unit: 'cents', kind: 'level', points: months.map((t, i) => ({ t, v: sum[i]! })) }
  },
}

/* ---------- prop:* and liab:* — property values, equity, loan balances ---------- */

type Estate = {
  props: { id: number; name: string; purchasedOn: string | null; purchaseCents: number | null; vals: Dated[] }[]
  liabs: { id: number; name: string; propertyId: number | null; bals: Dated[] }[]
}

function loadEstate(db: DbLike): Estate {
  const props = db.prepare('SELECT id, name, purchased_on, purchase_cents FROM properties ORDER BY id').all() as {
    id: number
    name: string
    purchased_on: string | null
    purchase_cents: number | null
  }[]
  const vals = db
    .prepare('SELECT property_id AS id, valued_on AS "on", value_cents AS cents FROM property_valuations ORDER BY valued_on')
    .all() as ({ id: number } & Dated)[]
  const liabs = db.prepare('SELECT id, name, property_id FROM liabilities ORDER BY id').all() as {
    id: number
    name: string
    property_id: number | null
  }[]
  const bals = db
    .prepare('SELECT liability_id AS id, balanced_on AS "on", balance_cents AS cents FROM liability_balances ORDER BY balanced_on')
    .all() as ({ id: number } & Dated)[]
  const strip = ({ on, cents }: Dated): Dated => ({ on, cents })
  return {
    props: props.map((p) => ({
      id: p.id,
      name: p.name,
      purchasedOn: p.purchased_on,
      purchaseCents: p.purchase_cents,
      vals: vals.filter((v) => v.id === p.id).map(strip),
    })),
    liabs: liabs.map((l) => ({ id: l.id, name: l.name, propertyId: l.property_id, bals: bals.filter((b) => b.id === l.id).map(strip) })),
  }
}

type Prop = Estate['props'][number]
type Liab = Estate['liabs'][number]

/** Net worth's rule: the latest valuation, else the purchase price once purchased, else nothing. */
const propValue = (p: Prop, month: string): number => {
  const cutoff = endOf(month)
  const val = lastOnOrBefore(p.vals, cutoff)
  if (val) return val.cents
  return p.purchasedOn && p.purchasedOn <= cutoff && p.purchaseCents ? p.purchaseCents : 0
}
const propFirst = (p: Prop) => minMonth([p.vals[0]?.on, p.purchasedOn && p.purchaseCents ? p.purchasedOn : null].map((d) => (d ? monthOf(d) : null)))
/** Owed at a month end, negative as it enters net worth. */
const owed = (l: Liab, month: string) => -(lastOnOrBefore(l.bals, endOf(month))?.cents ?? 0)
const liabFirst = (l: Liab) => (l.bals[0] ? monthOf(l.bals[0].on) : null)

/**
 * A loan's name in Compare. Most are called "Mortgage", so one secured by a
 * property says which ("Test Cabin · Mortgage owed"); any still alike after
 * that are told apart by a number, in id order.
 */
function liabLabels(e: Estate): Map<number, string> {
  const base = new Map(
    e.liabs.map((l) => {
      const p = l.propertyId === null ? undefined : e.props.find((x) => x.id === l.propertyId)
      return [l.id, p ? `${p.name} · ${l.name} owed` : `${l.name} · owed`]
    }),
  )
  const seen = new Map<string, number>()
  const total = new Map<string, number>()
  for (const label of base.values()) total.set(label, (total.get(label) ?? 0) + 1)
  const out = new Map<number, string>()
  for (const l of [...e.liabs].sort((a, b) => a.id - b.id)) {
    const label = base.get(l.id)!
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    out.set(l.id, total.get(label)! > 1 ? `${label} (${n})` : label)
  }
  return out
}

const PROP = new RegExp(`^prop:(${ID}):(value|equity)$`)
const LIAB = new RegExp(`^liab:(${ID})$`)
const NO_PROP_FACTS = 'No purchase price or valuation recorded'

const property: Family = {
  catalog(ctx) {
    const { props, liabs } = ctx.estate()
    const entries: SeriesMeta[] = []
    for (const p of props) {
      const first = propFirst(p)
      const reason = first === null ? NO_PROP_FACTS : undefined
      entries.push(meta(ctx, { id: `prop:${p.id}:value`, label: `${p.name} · value`, group: 'Property', first, reason }))
      const eqFirst = minMonth([first, ...liabs.filter((l) => l.propertyId === p.id).map(liabFirst)])
      entries.push(meta(ctx, { id: `prop:${p.id}:equity`, label: `${p.name} · equity`, group: 'Property', first: eqFirst, reason }))
    }
    const labels = liabLabels(ctx.estate())
    for (const l of liabs) {
      const first = liabFirst(l)
      entries.push(
        meta(ctx, { id: `liab:${l.id}`, label: labels.get(l.id)!, group: 'Property', first, reason: first === null ? 'No balances recorded yet' : undefined }),
      )
    }
    return entries
  },
  resolve(ctx, id) {
    const { props, liabs } = ctx.estate()
    const pm = PROP.exec(id)
    if (pm) {
      const p = props.find((x) => x.id === Number(pm[1]))
      if (!p) return null
      if (pm[2] === 'value')
        return { id, label: `${p.name} · value`, unit: 'cents', kind: 'level', points: monthsFrom(ctx, propFirst(p)).map((t) => ({ t, v: propValue(p, t) })) }
      // Equity: the value less what is owed on the loans secured by this property.
      const mine = liabs.filter((l) => l.propertyId === p.id)
      const first = minMonth([propFirst(p), ...mine.map(liabFirst)])
      return {
        id,
        label: `${p.name} · equity`,
        unit: 'cents',
        kind: 'level',
        points: monthsFrom(ctx, first).map((t) => ({ t, v: mine.reduce((s, l) => s + owed(l, t), propValue(p, t)) })),
      }
    }
    const lm = LIAB.exec(id)
    if (!lm) return null
    const l = liabs.find((x) => x.id === Number(lm[1]))
    if (!l) return null
    return { id, label: liabLabels(ctx.estate()).get(l.id)!, unit: 'cents', kind: 'level', points: monthsFrom(ctx, liabFirst(l)).map((t) => ({ t, v: owed(l, t) })) }
  },
}

/* ---------- cf:* — monthly cash flow ---------- */

type CfPart = 'income' | 'spend' | 'net'
const CF_LABEL: Record<CfPart, string> = { income: 'Income', spend: 'Spending', net: 'Net cash flow' }
const isCfPart = (s: string): s is CfPart => Object.hasOwn(CF_LABEL, s)

/**
 * Income and spending per month, exactly the Cash screen's bars
 * (engine/services.ts cashflowByMonth, the definition cashflowMonthly uses):
 * transfers left out, a refund nets against its expense category rather than
 * counting as income. Months with none are zero.
 */
type MonthFlow = { t: string; income: number; spend: number }
function loadCashflow(ctx: Ctx): MonthFlow[] {
  const rows = cashflowByMonth(ctx.db) // oldest first
  const byMonth = new Map(rows.map((r) => [r.month, r]))
  return monthsFrom(ctx, rows[0]?.month ?? null).map((t) => ({
    t,
    income: byMonth.get(t)?.income_cents ?? 0,
    spend: byMonth.get(t)?.spend_cents ?? 0,
  }))
}

const cashFlow: Family = {
  catalog(ctx) {
    const first = ctx.flows()[0]?.t ?? null
    return (Object.keys(CF_LABEL) as CfPart[]).map((part) =>
      meta(ctx, {
        id: `cf:${part}`,
        label: CF_LABEL[part],
        group: 'Cash flow',
        kind: 'flow',
        first,
        reason: first === null ? 'No transactions imported yet' : undefined,
      }),
    )
  },
  resolve(ctx, id) {
    const part = id.slice('cf:'.length)
    if (!isCfPart(part)) return null
    const v = (m: MonthFlow) => (part === 'income' ? m.income : part === 'spend' ? m.spend : m.income - m.spend)
    return { id, label: CF_LABEL[part], unit: 'cents', kind: 'flow', points: ctx.flows().map((m) => ({ t: m.t, v: v(m) })) }
  },
}

/* ---------- dispatch ---------- */

// Catalog order: net worth, accounts, holdings, prices, benchmarks, property, cash flow, goal.
const FAMILIES = new Map<string, Family>([
  ['nw', netWorth],
  ['inv', investments],
  ['cash', cash],
  ['pos', positions],
  ['set', sets],
  ['px', pricesFamily],
  ['bench', benchmarks],
  ['prop', property],
  ['liab', { catalog: () => [], resolve: property.resolve }], // listed with their property
  ['cf', cashFlow],
  ['goal', goalFund],
])

const familyOf = (id: string) => {
  const colon = id.indexOf(':')
  return colon > 0 ? FAMILIES.get(id.slice(0, colon)) : undefined
}

/**
 * GET /api/series/catalog: every series this household can draw right now.
 * `market` (the shared monthly history, when the caller has it) makes more
 * benchmarks available; it is never read from the request. `marketPending`
 * becomes the reason a benchmark without closes is greyed out.
 */
export function getSeriesCatalog(db: DbLike, today: string, opts: MarketOpts = {}): SeriesCatalogResponse {
  const ctx = context(db, today, marketOpts(opts))
  return { asOf: today, entries: [...FAMILIES.values()].flatMap((f) => f.catalog(ctx)) }
}

const marketOpts = (o: MarketOpts): MarketOpts => ({
  ...(o.market ? { market: o.market } : {}),
  ...(o.marketPending ? { marketPending: o.marketPending } : {}),
})

/**
 * GET /api/series: the requested series in request order (duplicates
 * dropped), each trimmed to the inclusive from…to month window. Unknown ids
 * become warnings; a malformed window or more than MAX_SERIES_IDS ids is a 400.
 * A performance index with too little price coverage in the window comes back
 * with null points and a warning saying why.
 */
export function getSeries(db: DbLike, today: string, q: SeriesQuery): SeriesResponse {
  const ids = [...new Set(q.ids)]
  const { from, to } = q
  if (ids.length > MAX_SERIES_IDS) bad(`at most ${MAX_SERIES_IDS} series per request`)
  for (const m of [from, to]) if (m !== undefined && !isoMonth.test(m)) bad('from and to must be YYYY-MM')
  if (from !== undefined && to !== undefined && from > to) bad('from must not be after to')
  const inWindow = (t: string) => (from === undefined || t >= from) && (to === undefined || t <= to)

  // The window travels with the request: a performance index is judged by the price coverage inside it.
  const ctx = context(db, today, { ...(from ? { from } : {}), ...(to ? { to } : {}), ...marketOpts(q) })
  const series: Series[] = []
  const warnings: string[] = []
  const trim = (s: Series): Series => ({ ...s, points: s.points.filter((p) => inWindow(p.t)) })
  for (const id of ids) {
    const s = familyOf(id)?.resolve(ctx, id) ?? null
    if (s === null) warnings.push(`unknown series: ${id}`)
    else if (typeof s === 'string') warnings.push(s)
    else if ('warning' in s) {
      series.push(trim(s.series))
      warnings.push(s.warning)
    } else series.push(trim(s))
  }
  return { series, warnings }
}

/**
 * Reads GET /api/series's query string — `ids=a,b&from=YYYY-MM&to=YYYY-MM` —
 * for both the server route and the tab's local dispatcher. Ids never contain
 * whitespace, so a space inside one is a '+' that the query-string decoding
 * turned into a space (`set:1+2:value` sent unencoded); it is put back.
 */
export function parseSeriesQuery(q: { ids?: string | null; from?: string | null; to?: string | null }): SeriesQuery {
  const ids = (q.ids ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\s/g, '+'))
    .filter(Boolean)
  return { ids, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}) }
}

/* ---------- saved chart views (GET/PUT /api/series/views) ---------- */

/**
 * Compare's saved views live in app_meta under this key, so they ride the
 * vault with everything else (only basket:* keys stay out of snapshots).
 */
export const CHART_VIEWS_KEY = 'ui:chart-views'
export const MAX_CHART_VIEWS = 50
const VIEW_MODES: readonly ChartView['mode'][] = ['value', 'rebased', 'pct', 'diff']
const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/
// A family prefix, then anything a query string can carry unescaped between commas.
const SERIES_ID = /^[a-z]+:[^\s,]{1,160}$/
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

type ViewShape = Omit<ChartView, 'by' | 'created_at'>

/** One view from a PUT body, checked and normalized; `by` and `created_at` are the server's to set. */
function parseView(raw: unknown, n: number): ViewShape {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) bad(`view ${n} must be an object`)
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !VIEW_ID.test(r.id)) bad(`view ${n}: id must be 1–64 letters, digits, '-' or '_'`)
  const name = typeof r.name === 'string' ? r.name.trim() : ''
  if (name.length === 0 || name.length > 80) bad(`view ${n}: name must be 1–80 characters`)
  if (!Array.isArray(r.ids) || r.ids.length === 0) bad(`view "${name}": pick at least one series`)
  for (const id of r.ids as unknown[])
    if (typeof id !== 'string' || !SERIES_ID.test(id)) bad(`view "${name}": ${JSON.stringify(id)} is not a series id`)
  const ids = [...new Set(r.ids as string[])]
  if (ids.length > MAX_SERIES_IDS) bad(`view "${name}": at most ${MAX_SERIES_IDS} series`)
  if (!VIEW_MODES.includes(r.mode as ChartView['mode'])) bad(`view "${name}": mode must be one of ${VIEW_MODES.join(', ')}`)
  const bound = (k: 'from' | 'to') => {
    const v = r[k]
    if (v === undefined || v === null || v === '') return undefined
    if (typeof v !== 'string' || !MONTH.test(v)) bad(`view "${name}": ${k} must be YYYY-MM`)
    return v as string
  }
  const from = bound('from')
  const to = bound('to')
  if (from !== undefined && to !== undefined && from > to) bad(`view "${name}": from must not be after to`)
  // A fixed key order, so an unchanged list serializes identically and writes nothing.
  return { id: r.id, name, ids, mode: r.mode as ChartView['mode'], ...(from ? { from } : {}), ...(to ? { to } : {}) }
}

/** GET /api/series/views: the saved views, in the order they were saved. Anything unreadable is left out. */
export function getChartViews(db: DbLike): ChartView[] {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CHART_VIEWS_KEY) as { value: string } | undefined
  if (!row) return []
  let stored: unknown
  try {
    stored = JSON.parse(row.value)
  } catch {
    return []
  }
  if (!Array.isArray(stored)) return []
  return stored.flatMap((raw, i): ChartView[] => {
    try {
      const v = parseView(raw, i + 1)
      const { by, created_at } = raw as Record<string, unknown>
      if ((by !== null && typeof by !== 'string') || typeof created_at !== 'string') return []
      return [{ ...v, by: by as string | null, created_at }]
    } catch (e) {
      if (e instanceof ApiError) return []
      throw e
    }
  })
}

/**
 * PUT /api/series/views: replace the whole list. Views keep who saved them
 * and when: an id already stored keeps its `by` and `created_at`; a new one
 * gets the caller's identity (`by`, null in a tab with none) and `now`.
 * Whatever the body says for those two is ignored. Validated in full before
 * anything is written; an unchanged list writes nothing, so re-saving never
 * dirties a vault session. Returns the list as stored.
 */
export function putChartViews(db: DbLike, body: unknown, who: { by: string | null; now: string }): ChartView[] {
  if (!Array.isArray(body)) bad('send the whole list of views as a JSON array')
  if (body.length > MAX_CHART_VIEWS) bad(`at most ${MAX_CHART_VIEWS} saved views`)
  const stored = new Map(getChartViews(db).map((v) => [v.id, v]))
  const seen = new Set<string>()
  const next: ChartView[] = (body as unknown[]).map((raw, i) => {
    const v = parseView(raw, i + 1)
    if (seen.has(v.id)) bad(`view ${v.id} appears twice`)
    seen.add(v.id)
    const prev = stored.get(v.id)
    return { ...v, by: prev ? prev.by : who.by, created_at: prev ? prev.created_at : who.now }
  })

  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(CHART_VIEWS_KEY) as { value: string } | undefined
  if (next.length === 0) {
    if (row) db.prepare('DELETE FROM app_meta WHERE key = ?').run(CHART_VIEWS_KEY)
  } else {
    const json = JSON.stringify(next)
    if (row?.value !== json)
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
        CHART_VIEWS_KEY,
        json,
      )
  }
  return next
}
