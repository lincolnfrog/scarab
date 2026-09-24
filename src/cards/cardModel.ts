/**
 * Pure logic behind the Dashboard and screen chart cards, kept out of the
 * components so it runs in node tests. Money is integer cents throughout.
 */
import type { PortfolioPosition, TradeRow } from '../../shared/invest-api'
import { formatQtyMicro } from '../../shared/money'
import { dayNumber } from '../../shared/perf'
import { changeMicro, sumAsOf } from '../../shared/series'
import type { HoldingReturn, ReturnsResponse, SeriesPoint } from '../../shared/series-api'
import type { RouteTarget } from '../router'
import { SLOT_VAR } from '../chart/palette'

/** One month-end of GET /api/networth (the current month is as of today). Liabilities are negative. */
export type NetWorthPoint = {
  month: string
  cash: number
  brokerage: number
  retirement: number
  crypto: number
  property: number
  liabilities: number
  total: number
}

export type TileGroup = { key: string; label: string; color: string; to: RouteTarget; of: (p: NetWorthPoint) => number }

/**
 * The Dashboard tiles, grouped as in the mockup: Brokerage s1, Retirement s2,
 * Home equity s3 (only with a property), Cash + crypto s5. A group that is $0
 * in every month of `recent` is left out (bug #69: $0 tiles), and Cash +
 * crypto names — and links to — only the half that exists.
 */
export function tileGroups(recent: readonly NetWorthPoint[]): TileGroup[] {
  const any = (f: (p: NetWorthPoint) => number) => recent.some((p) => f(p) !== 0)
  const hasCash = any((p) => p.cash)
  const hasCrypto = any((p) => p.crypto)
  const groups: TileGroup[] = [
    { key: 'brokerage', label: 'Brokerage', color: SLOT_VAR[1], to: { screen: 'invest' }, of: (p) => p.brokerage },
    { key: 'retirement', label: 'Retirement', color: SLOT_VAR[2], to: { screen: 'invest' }, of: (p) => p.retirement },
  ]
  if (any((p) => p.property))
    groups.push({ key: 'equity', label: 'Home equity', color: SLOT_VAR[3], to: { screen: 're' }, of: (p) => p.property + p.liabilities })
  groups.push({
    key: 'liquid',
    label: hasCash && hasCrypto ? 'Cash + crypto' : hasCrypto ? 'Crypto' : 'Cash',
    color: SLOT_VAR[5],
    to: { screen: hasCash || !hasCrypto ? 'cash' : 'invest' },
    of: (p) => p.cash + p.crypto,
  })
  return groups.filter((g) => any(g.of))
}

/** The grid class that shares one row evenly among n tiles. */
export function tileSpan(n: number): 'c3' | 'c4' | 'c6' | 'c12' {
  return n <= 1 ? 'c12' : n === 2 ? 'c6' : n === 3 ? 'c4' : 'c3'
}

/**
 * How far ahead the goal's plan line is drawn, in months. It runs all the way
 * to the ETA when that is within five years or twice the fund's history
 * (whichever is longer), so the ETA marker shows; otherwise it stops at twice
 * the history, at least three years — a distant ETA must not flatten the
 * months that actually happened into a sliver. Never more than ten years.
 */
export function projectionHorizon(historyMonths: number, etaMonths: number | null = null): number {
  const twice = 2 * Math.max(0, Math.floor(historyMonths))
  if (etaMonths !== null && etaMonths >= 1 && etaMonths <= Math.min(120, Math.max(60, twice))) return etaMonths
  return Math.min(120, Math.max(36, twice))
}

/** floor(v / target) in whole percent, exact (BigInt); 0 for no target or a non-positive v. */
export function pctOfTarget(v: number, target: number): number {
  if (!Number.isSafeInteger(v) || !Number.isSafeInteger(target) || target <= 0 || v <= 0) return 0
  return Number((BigInt(v) * 100n) / BigInt(target))
}

/* ---------------- Investments cards (C6) ---------------- */

/**
 * The tooltip's "Unrealized" figure for a month: value − cost, and that as a
 * micro-fraction of the cost. Null when either reading is missing; the
 * percent is null when there is no cost to measure against.
 */
export function unrealizedAt(value: number | null | undefined, cost: number | null | undefined): { cents: number; micro: number | null } | null {
  if (typeof value !== 'number' || typeof cost !== 'number' || !Number.isSafeInteger(value) || !Number.isSafeInteger(cost)) return null
  return { cents: value - cost, micro: cost > 0 ? changeMicro(value, cost) : null }
}

/**
 * Several accounts' monthly series added up month by month — inv:<id>:value
 * (or :cost) for each account an owner pill covers, standing in for the
 * inv:all series of just those accounts. An account's series starts at its
 * own first fact, so a month before it adds nothing; a month is an estimate
 * when any part of it is. Months come out in order.
 */
export function sumSeries(list: readonly (readonly SeriesPoint[])[]): SeriesPoint[] {
  const by = new Map<string, { v: number | null; est: boolean }>()
  for (const points of list)
    for (const p of points) {
      const m = by.get(p.t) ?? { v: null, est: false }
      if (typeof p.v === 'number') m.v = (m.v ?? 0) + p.v
      if (p.est) m.est = true
      by.set(p.t, m)
    }
  return [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([t, m]) => (m.est ? { t, v: m.v, est: true } : { t, v: m.v }))
}

/** Starting positions are recorded as buys with this note (engine/invest.ts OPENING_NOTE). */
const OPENING = 'Opening position'

/**
 * The portfolio chart's trade rug: one neutral tick per trade on its own day
 * (▲ buy, ▼ sell), labelled for the tooltip — 'Bought 10 VTI · Vanguard'.
 * A starting position reads as such rather than as a purchase that day.
 */
export function tradeRug(trades: readonly TradeRow[]): { id: string; t: string; shape: 'up' | 'down'; label: string }[] {
  return [...trades]
    .sort((a, b) => (a.traded_on < b.traded_on ? -1 : a.traded_on > b.traded_on ? 1 : a.id - b.id))
    .map((r) => {
      const verb = r.side === 'sell' ? 'Sold' : r.note === OPENING ? 'Starting position:' : 'Bought'
      return { id: `trade-${r.id}`, t: r.traded_on, shape: r.side === 'sell' ? 'down' : 'up', label: `${verb} ${formatQtyMicro(r.qty_micro)} ${r.symbol} · ${r.account_name}` }
    })
}

export type ReturnBar = HoldingReturn & {
  /** Where the bar starts and how wide it is, in percent of the track; w = 0 draws no bar. */
  x: number
  w: number
}

/**
 * The return-by-holding bars: sorted best to worst by unrealized return on
 * cost, unpriced holdings last (carried at cost, they have no return yet —
 * drawn hollow). One shared scale spans the largest loss to the largest
 * gain, so the zero line sits where the data puts it: at the left edge when
 * nothing is down, mid-track when gains and losses match. 2% margins keep
 * the ends off the labels, and a real return is never thinner than a
 * hairline.
 */
export function returnBars(rows: readonly HoldingReturn[]): { bars: ReturnBar[]; zeroPct: number } {
  const ret = (r: HoldingReturn) => (r.priced && r.unrealized_micro !== null ? r.unrealized_micro : null)
  const vals = rows.map(ret).filter((m): m is number => m !== null)
  const up = Math.max(0, ...vals)
  const down = Math.max(0, ...vals.map((m) => -m))
  const span = up + down || 1
  const zeroPct = 2 + (down / span) * 96
  const rank = (r: HoldingReturn) => (ret(r) === null ? 1 : 0)
  const bars = [...rows]
    .sort((a, b) => rank(a) - rank(b) || (ret(b) ?? 0) - (ret(a) ?? 0) || b.value_cents - a.value_cents)
    .map((r) => {
      const m = ret(r) ?? 0
      const w = m === 0 ? 0 : Math.max(0.8, (Math.abs(m) / span) * 96)
      return { ...r, x: m < 0 ? zeroPct - w : zeroPct, w }
    })
  return { bars, zeroPct }
}

/** A return-by-holding row, possibly narrowed to some accounts. */
export type ScopedReturn = HoldingReturn & {
  /** Also held in accounts outside the scope: its figures are the scope's share, and it has no rate here. */
  shared?: boolean
}
export type ScopedReturns = Omit<ReturnsResponse, 'rows'> & { rows: ScopedReturn[] }

/**
 * Return by holding narrowed to some accounts (Investments' owner pills).
 * GET /api/portfolio/returns pools every account, so each row's value, cost
 * and unrealized are re-summed from the portfolio's per-account split for
 * these accounts — the engine's own figures, nothing re-priced (as
 * ownerFilter's scopePortfolio does for the holdings table).
 *
 * A holding wholly inside the scope keeps its money-weighted rate: the same
 * lots, so the same flows. One also held outside it has no rate here
 * (`shared`), since its flows can't be split without the entry prices the
 * engine used. The totals keep the household's rate only when the scope
 * holds everything; otherwise they have none. A row the positions don't know
 * (a reload landing between the two reads) is left out.
 */
export function scopeReturns(data: ReturnsResponse, positions: readonly PortfolioPosition[], ids: ReadonlySet<number>): ScopedReturns {
  const byAsset = new Map(positions.map((p) => [p.asset_id, p]))
  const asOf = dayNumber(data.as_of)
  const rows: ScopedReturn[] = []
  for (const r of data.rows) {
    const p = byAsset.get(r.asset_id)
    const accounts = p ? p.accounts.filter((a) => ids.has(a.invest_account_id)) : []
    if (!p || accounts.length === 0) continue
    if (accounts.length === p.accounts.length) {
      rows.push({ ...r })
      continue
    }
    const value = accounts.reduce((s, a) => s + a.value_cents, 0)
    const cost = accounts.reduce((s, a) => s + a.cost_cents, 0)
    const opened = p.lots.filter((l) => ids.has(l.invest_account_id)).map((l) => dayNumber(l.opened_on))
    rows.push({
      ...r,
      value_cents: value,
      cost_cents: cost,
      unrealized_cents: value - cost,
      unrealized_micro: r.priced ? ratioMicro(value - cost, cost) : null,
      irr_micro: null,
      annualized: false,
      held_days: opened.length === 0 ? 0 : Math.max(0, asOf - Math.min(...opened)),
      shared: true,
    })
  }
  const value = rows.reduce((s, r) => s + r.value_cents, 0)
  const cost = rows.reduce((s, r) => s + r.cost_cents, 0)
  for (const r of rows) r.weight_micro = ratioMicro(r.value_cents, value) ?? 0
  const everything = rows.length === data.rows.length && !rows.some((r) => r.shared)
  return {
    as_of: data.as_of,
    rows,
    totals: everything
      ? data.totals
      : { value_cents: value, cost_cents: cost, unrealized_cents: value - cost, irr_micro: null, annualized: false },
  }
}

/** a / b as integer micro, rounded as engine/returns.ts rounds its own; null when b is not positive. */
function ratioMicro(a: number, b: number): number | null {
  return b > 0 ? Math.round((a / b) * 1_000_000) + 0 : null
}

/**
 * The day a priced holding with no money-weighted rate needs a close for. A
 * starting position pasted without its acquisition date enters at its market
 * value on its as-of day, and there was no close near it. Named only when
 * the holding's lots all opened on one day — otherwise which lot is the
 * starting one isn't known here — else null.
 */
export function noRateDay(assetId: number, positions: readonly PortfolioPosition[] | undefined): string | null {
  const days = new Set(positions?.find((p) => p.asset_id === assetId)?.lots.map((l) => l.opened_on))
  return days.size === 1 ? [...days][0]! : null
}

/** How long a holding has been held, from its days: '6 yr 8 mo', '4 mo', '12 days'. Months are 30.44-day averages. */
export function heldText(days: number): string {
  if (!Number.isFinite(days) || days < 0) return ''
  if (days < 45) return `${Math.floor(days)} day${Math.floor(days) === 1 ? '' : 's'}`
  const months = Math.floor((days * 12) / 365.25)
  const y = Math.floor(months / 12)
  const m = months % 12
  return [y ? `${y} yr` : '', m ? `${m} mo` : ''].filter(Boolean).join(' ') || '1 mo'
}

/**
 * The Future fan's markers over the simulated `years`: Today, Buy dream home
 * (only when the run models a purchase — `buys`: the scenario buys and the
 * Dream Home has the loan terms to simulate one), Retire, and the Crossing
 * year in gold. Years outside the span are left out. `t` is Jan 1 of the year.
 */
export function fanMarkers(o: {
  years: readonly number[]
  buys: boolean
  buyYear: number
  retireYear: number
  crossingYear: number | null
  thresholdPct: number
}): { id: string; t: string; label: string; tone?: 'gold' }[] {
  const first = o.years[0]
  const last = o.years[o.years.length - 1]
  if (first === undefined || last === undefined) return []
  const yearT = (y: number) => `${y}-01-01`
  const inRange = (y: number) => y >= first && y <= last
  const out: { id: string; t: string; label: string; tone?: 'gold' }[] = [{ id: 'today', t: yearT(first), label: 'Today' }]
  if (o.buys && inRange(o.buyYear)) out.push({ id: 'buy', t: yearT(o.buyYear), label: 'Buy dream home' })
  if (inRange(o.retireYear)) out.push({ id: 'retire', t: yearT(o.retireYear), label: 'Retire' })
  if (o.crossingYear !== null && inRange(o.crossingYear))
    out.push({ id: 'cross', t: yearT(o.crossingYear), label: `Crossing · ≥${o.thresholdPct}%`, tone: 'gold' })
  return out
}

type PropertyFacts = {
  purchased_on: string | null
  purchase_cents: number | null
  valuations: readonly { valued_on: string; value_cents: number }[]
  liabilities: readonly { balances: readonly { balanced_on: string; balance_cents: number }[] }[]
}
const byT = (a: { t: string }, b: { t: string }) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)

/**
 * A property's chart lines from its recorded facts: the value (each valuation,
 * with the purchase as its first point) and the debt (every loan's recorded
 * balances summed as of each date). Null until the facts span two dates. Both
 * are facts that stand until the next one, so the chart holds each line flat
 * to today (TimeChart carryTo): without it the axis stopped at the last fact —
 * years back for a purchase and one balance, and a value area that dropped
 * away while the debt ran on (F14).
 */
export function propertyLines(p: PropertyFacts): { value: { t: string; v: number }[]; debt: { t: string; v: number }[]; bought: { t: string; v: number } | null } | null {
  const value = p.valuations.map((v) => ({ t: v.valued_on, v: v.value_cents })).sort(byT)
  const bought = p.purchased_on && p.purchase_cents !== null && p.purchase_cents > 0 ? { t: p.purchased_on, v: p.purchase_cents } : null
  if (bought && !value.some((v) => v.t === bought.t)) {
    value.push(bought)
    value.sort(byT)
  }
  const loans = p.liabilities.map((l) => l.balances.map((b) => ({ t: b.balanced_on, v: b.balance_cents })).sort(byT)).filter((b) => b.length > 0)
  const debt = sumAsOf(loans)
  if (new Set([...value, ...debt].map((x) => x.t)).size < 2) return null
  return { value, debt, bought }
}
