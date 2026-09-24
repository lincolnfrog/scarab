/**
 * Moving averages for BigChart when a price history is month-end closes
 * first and daily closes after (A5: the shared monthly history, then the
 * closes this tab or server has seen day by day). "The last 50 closes" would
 * reach back four years across the monthly stretch, so there each average
 * spans calendar time instead. Pure, so node tests can drive it.
 */
import { DAY_MS } from './scale'

/** Trading days in a year: an "N-day" average of a stock spans N × 365.25/252 calendar days (crypto trades every day). */
const TRADING_DAYS = 252

/** How much calendar time an N-day (trading days, for a stock) or N-week average covers, in ms. */
export function maSpanMs(spec: { kind: 'days' | 'weeks'; n: number }, asset: 'stock' | 'crypto'): number {
  if (spec.kind === 'weeks') return spec.n * 7 * DAY_MS
  return (asset === 'crypto' ? spec.n : (spec.n * 365.25) / TRADING_DAYS) * DAY_MS
}

/**
 * The mean of the price line as drawn — straight between closes — over the
 * `spanMs` before each close, in integer cents. Weighting by time is what
 * lets a stretch of month-ends and a stretch of daily closes share one
 * window: a month-end weighs the month it stands for, not one day. null
 * until the history reaches back a whole window. `ts` must be ascending.
 */
export function timeWeightedMa(ts: readonly number[], vs: readonly number[], spanMs: number): (number | null)[] {
  const n = ts.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n < 2 || !(spanMs > 0)) return out
  const t0 = ts[0]!
  const day = (t: number) => (t - t0) / DAY_MS // days keep the running area small
  // area[k]: cent-days under the line from the first close to close k.
  const area = new Array<number>(n).fill(0)
  for (let k = 1; k < n; k++) area[k] = area[k - 1]! + ((vs[k - 1]! + vs[k]!) / 2) * (day(ts[k]!) - day(ts[k - 1]!))
  const span = spanMs / DAY_MS
  let j = 0
  for (let i = 1; i < n; i++) {
    const a = ts[i]! - spanMs
    if (a < t0) continue
    while (j + 1 < i && ts[j + 1]! <= a) j++
    // The window opens between close j and j+1: take off the area before it.
    const f = (a - ts[j]!) / (ts[j + 1]! - ts[j]!)
    const va = vs[j]! + (vs[j + 1]! - vs[j]!) * f
    const before = ((vs[j]! + va) / 2) * (day(a) - day(ts[j]!))
    out[i] = Math.round((area[i]! - area[j]! - before) / span)
  }
  return out
}

/**
 * One average across both stretches: the usual count-of-closes figure
 * (`exact`) wherever its whole window lies in the daily stretch, the
 * time-weighted one (`timed`) where it reaches back into the month-ends.
 * `dailyFromT` null: all month-ends, all time-weighted.
 */
export function blendMa(
  ts: readonly number[],
  exact: readonly (number | null)[],
  timed: readonly (number | null)[],
  dailyFromT: number | null,
  spanMs: number,
): (number | null)[] {
  return ts.map((t, i) => (dailyFromT !== null && t - spanMs >= dailyFromT ? (exact[i] ?? null) : (timed[i] ?? null)))
}
