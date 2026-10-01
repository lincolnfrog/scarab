import type { PortfolioPosition } from '../../shared/invest-api'
import { formatCents, formatPercentMicro } from '../../shared/money'

/**
 * The day's gain or loss, as Investments shows it. The engine supplies each
 * position's change in cents (engine/invest.ts: measured from the previous
 * close its quote came with); here it becomes a percent, a per-account sum
 * and words. Pure and node-tested.
 */

/** A day's change in cents and as millionths of what the holding was worth before it (null when that was nothing). */
export type DayChange = { cents: number; micro: number | null }

/** The change as a percent of the value before it: `valueNow − cents`. */
export function dayChange(cents: number | null | undefined, valueNow: number): DayChange | null {
  if (cents == null) return null
  const base = valueNow - cents
  return { cents, micro: base > 0 ? Math.round((cents * 1_000_000) / base) : null }
}

/** The portfolio's: the engine's totals (day_base is the denominator), or null when no holding has a day change. */
export function totalDay(totals: { day_change: number; day_base: number }): DayChange | null {
  if (totals.day_base <= 0 && totals.day_change === 0) return null
  return { cents: totals.day_change, micro: totals.day_base > 0 ? Math.round((totals.day_change * 1_000_000) / totals.day_base) : null }
}

/** One account's: its part of every position's change, or null when none of its holdings has one. */
export function accountDay(accountId: number, positions: readonly PortfolioPosition[]): DayChange | null {
  let cents = 0
  let value = 0
  let any = false
  for (const p of positions)
    for (const a of p.accounts)
      if (a.invest_account_id === accountId && a.day_change_cents != null) {
        cents += a.day_change_cents
        value += a.value_cents
        any = true
      }
  return any ? dayChange(cents, value) : null
}

/** One share's: the price against the previous close. */
export function priceDay(p: Pick<PortfolioPosition, 'price_cents' | 'prev_close_cents'>): DayChange | null {
  if (p.price_cents === null || p.prev_close_cents == null) return null
  return dayChange(p.price_cents - p.prev_close_cents, p.price_cents)
}

/**
 * The day the changes are for: the newest quote day among the holdings that
 * have one. Quotes can be a session apart (crypto trades on a Sunday), so
 * this names the latest — 'today' when it is.
 */
export function dayOf(positions: readonly Pick<PortfolioPosition, 'priced_on' | 'day_change_cents'>[]): string | null {
  let latest: string | null = null
  for (const p of positions) if (p.day_change_cents != null && p.priced_on && (!latest || p.priced_on > latest)) latest = p.priced_on
  return latest
}

/** '▲ $12.30' / '▼ $4.10' / '$0.00' — the arrow says which way, so the amount is unsigned. */
export const dayAmount = (cents: number): string => `${cents > 0 ? '▲ ' : cents < 0 ? '▼ ' : ''}${formatCents(Math.abs(cents))}`

/** '0.42%' — unsigned, two places; '' when there is no base to measure against. */
export const dayPercent = (micro: number | null): string => (micro === null ? '' : formatPercentMicro(Math.abs(micro), 2))

/** 'pos' / 'neg' / '' — flat is neither. */
export const toneOf = (cents: number): string => (cents > 0 ? 'pos' : cents < 0 ? 'neg' : '')

/* ---------- sorting the holdings table ---------- */

export type HoldingSortKey = 'symbol' | 'price' | 'day' | 'value' | 'unrealized' | 'return'
export type HoldingSort = { key: HoldingSortKey; dir: 'asc' | 'desc' }
export const DEFAULT_SORT: HoldingSort = { key: 'value', dir: 'desc' }

const KEYS: readonly HoldingSortKey[] = ['symbol', 'price', 'day', 'value', 'unrealized', 'return']

/** 'value-desc' ↔ { key, dir } — the route-state form; anything else is the default. */
export function parseSort(s: string): HoldingSort {
  const [key, dir] = s.split('-')
  return KEYS.includes(key as HoldingSortKey) && (dir === 'asc' || dir === 'desc') ? { key: key as HoldingSortKey, dir } : DEFAULT_SORT
}
export const formatSort = (s: HoldingSort): string => `${s.key}-${s.dir}`

/** A header click: the same column flips; a new one starts where it reads best (names A→Z, numbers largest first). */
export function nextSort(cur: HoldingSort, key: HoldingSortKey): HoldingSort {
  if (cur.key === key) return { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
  return { key, dir: key === 'symbol' ? 'asc' : 'desc' }
}

export type SortableHolding = {
  symbol: string
  price_cents: number | null
  value_cents: number
  unrealized_cents: number
  /** The day's change as micro of the value before it. */
  day_micro: number | null
  /** The money-weighted rate. */
  irr_micro: number | null
}

/** Sorted copy. A row without the figure sorts last either way; ties fall back to value, then symbol. */
export function sortHoldings<T extends SortableHolding>(rows: readonly T[], sort: HoldingSort): T[] {
  const of = (r: T): number | string | null =>
    sort.key === 'symbol'
      ? r.symbol
      : sort.key === 'price'
        ? r.price_cents
        : sort.key === 'day'
          ? r.day_micro
          : sort.key === 'value'
            ? r.value_cents
            : sort.key === 'unrealized'
              ? r.unrealized_cents
              : r.irr_micro
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = of(a)
    const y = of(b)
    if (x === null || y === null) {
      if (x !== y) return x === null ? 1 : -1
    } else if (x !== y) return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * sign
    return b.value_cents - a.value_cents || a.symbol.localeCompare(b.symbol)
  })
}
