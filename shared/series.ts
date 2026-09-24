import { addMonthsToMonth } from './dates'

/** Simple moving average over a daily series; null until the window fills. */
export function sma(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = Math.round(sum / window)
  }
  return out
}

/** Whole days since 1970-01-01 for a 'YYYY-MM-DD', on the UTC calendar (time zone never shifts it). */
function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000)
}

/**
 * The ISO week (Monday–Sunday) a day falls in, as a running index. 1970-01-01
 * was a Thursday, so shifting by 3 puts every Monday on a multiple of 7; two
 * days share an index exactly when they share an ISO week, across year ends.
 */
export function isoWeekIndex(iso: string): number {
  return Math.floor((dayNumber(iso) + 3) / 7)
}

/**
 * The last close of each ISO week, oldest first: Friday's for a stock,
 * Sunday's for crypto, Thursday's in a week that lost its Friday to a
 * holiday. The week still in progress ends at its latest close. Input must be
 * ascending by date.
 */
export function resampleWeekly<T extends { d: string; c: number }>(closes: T[]): T[] {
  const out: T[] = []
  let week = Number.NaN
  for (const p of closes) {
    const w = isoWeekIndex(p.d)
    if (w === week) out[out.length - 1] = p
    else {
      out.push(p)
      week = w
    }
  }
  return out
}

/**
 * A moving average over `weeks` weekly closes, laid back onto the daily
 * series and carried forward: each day reads the average as of the latest
 * week-close on or before it, so no day ever sees a close from later in its
 * week. This is the real 200-week line — `sma(daily, 1400)` counted 1,400
 * trading days, about 280 weeks for a stock (bug #32).
 */
export function weeklySmaDaily(closes: { d: string; c: number }[], weeks: number): (number | null)[] {
  const weekly = resampleWeekly(closes)
  const ma = sma(
    weekly.map((p) => p.c),
    weeks,
  )
  const out: (number | null)[] = new Array(closes.length).fill(null)
  let j = -1
  for (let i = 0; i < closes.length; i++) {
    while (j + 1 < weekly.length && weekly[j + 1]!.d <= closes[i]!.d) j++
    out[i] = j >= 0 ? ma[j]! : null
  }
  return out
}

/* ---------------- time-series alignment and transforms (TimeChart, Compare) ---------------- */

/** Index-micro for 100: a rebased series reads 1_000_000 at its anchor. */
export const INDEX_BASE = 1_000_000

/** First index whose time is ≥ t (ascending `times`). */
function lowerBound(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid]! < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The reading of a series "as of" time t: the index of its last point at or
 * before t (among duplicates, the last one), or −1 when t is before its first
 * point. `times` must be ascending.
 */
export function asOfIndex(times: readonly number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (times[mid]! <= t) lo = mid + 1
    else hi = mid
  }
  return lo - 1
}

/**
 * Line several series up for one crosshair. Returns the sorted union of every
 * series' times, and for each series and each union time the index of its
 * reading as of that time (`asOfIndex`; −1 before its first point). A monthly
 * series read on a day between its points answers with its previous point —
 * the chart then labels that value "as of Aug 31" instead of pretending it is
 * current. Each series' `times` must be ascending.
 */
export function alignAsOf(times: readonly (readonly number[])[]): { ts: number[]; at: number[][] } {
  const all: number[] = []
  for (const s of times) for (const t of s) all.push(t)
  all.sort((a, b) => a - b)
  const ts: number[] = []
  for (const t of all) if (ts.length === 0 || ts[ts.length - 1] !== t) ts.push(t)
  const at = times.map((s) => {
    const out = new Array<number>(ts.length)
    let j = -1
    for (let i = 0; i < ts.length; i++) {
      while (j + 1 < s.length && s[j + 1]! <= ts[i]!) j++
      out[i] = j
    }
    return out
  })
  return { ts, at }
}

/**
 * Where a series is anchored for rebasing or % change.
 *   `at`: its reading as of that time (`asOfIndex`) — whatever it is; `rebase`
 *         refuses it when it is missing or ≤ 0.
 *   otherwise: its first point > 0 inside [from, to] — the first thing a
 *         reader sees in the window, skipping the zeros before an account
 *         was funded. −1 when there is none.
 */
export function anchorIndex(
  times: readonly number[],
  values: readonly (number | null)[],
  o: { at?: number; from?: number; to?: number } = {},
): number {
  if (o.at !== undefined) return asOfIndex(times, o.at)
  const to = o.to ?? Infinity
  for (let i = lowerBound(times, o.from ?? -Infinity); i < times.length && times[i]! <= to; i++) {
    const v = values[i]
    if (v !== null && v !== undefined && v > 0) return i
  }
  return -1
}

/**
 * round(a·b / c) for integers, half away from zero, exact at any magnitude:
 * plain integer math while a·b is a safe integer, BigInt beyond (a $3M value
 * times 1e6 is still safe; $100M is not). `c` must be positive.
 */
function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) return Math.round((a * b) / c)
  const p = a * b
  if (Number.isSafeInteger(p)) {
    const ap = Math.abs(p)
    let whole = Math.floor(ap / c)
    let rem = ap - whole * c
    // The float quotient can round across an integer; the remainder says which side it is on.
    if (rem < 0) {
      whole -= 1
      rem += c
    } else if (rem >= c) {
      whole += 1
      rem -= c
    }
    const r = whole + (rem * 2 >= c ? 1 : 0)
    return p < 0 && r !== 0 ? -r : r
  }
  const P = BigInt(a) * BigInt(b)
  const C = BigInt(c)
  const ap = P < 0n ? -P : P
  let r = ap / C
  if ((ap % C) * 2n >= C) r += 1n
  return Number(P < 0n ? -r : r)
}

function transformFrom(
  values: readonly (number | null)[],
  anchorI: number,
  o: { dropBefore?: boolean },
  f: (v: number, a: number) => number,
): (number | null)[] | null {
  const a = anchorI >= 0 ? values[anchorI] : null
  if (a === null || a === undefined || !(a > 0)) return null
  return values.map((v, i) => (v === null || v === undefined || (o.dropBefore && i < anchorI) ? null : f(v, a)))
}

/**
 * A series as an index where its anchor reads 100 — index-micro, so the
 * anchor is INDEX_BASE (1_000_000) and 112.5 is 1_125_000. Integer math,
 * rounded half away from zero. Null stays null.
 *
 * Refuses (returns null) when the anchor is missing, null, or ≤ 0: growth
 * from a zero or negative base means nothing (a liability, an account before
 * its first deposit). `dropBefore` blanks the points before the anchor —
 * right for an anchor found by scanning (the zeros it skipped), wrong for an
 * explicit anchor date mid-window.
 */
export function rebase(values: readonly (number | null)[], anchorI: number, o: { dropBefore?: boolean } = {}): (number | null)[] | null {
  return transformFrom(values, anchorI, o, (v, a) => mulDivRound(v, INDEX_BASE, a))
}

/** % change from the anchor as a micro-fraction (100_000 = +10%); refuses exactly as `rebase` does. */
export function pctChange(values: readonly (number | null)[], anchorI: number, o: { dropBefore?: boolean } = {}): (number | null)[] | null {
  return transformFrom(values, anchorI, o, (v, a) => mulDivRound(v - a, 1_000_000, a))
}

/* ---------------- dashboard and card figures (C4, C5) ---------------- */

/**
 * The change from `prev` to `cur` in integer basis points of |prev|
 * (140 = +1.4%, −80 = −0.8%), rounded half away from zero, exact at any
 * magnitude. Null when there is no base to measure against: `prev` is 0, or
 * either value is not an integer (cents only — never a float).
 */
export function changeBp(cur: number, prev: number): number | null {
  if (!Number.isSafeInteger(cur) || !Number.isSafeInteger(prev) || prev === 0) return null
  return mulDivRound(cur - prev, 10_000, Math.abs(prev))
}

/**
 * A month-by-month projection in integer cents: `startCents` in `startMonth`
 * ('YYYY-MM'), then `stepCents` more each month, through the first month at or
 * above `targetCents` — or `maxMonths` after the start, whichever comes first.
 * The month count is ceil((target − start) / step) in integer math, the same
 * count GoalDerived.etaMonth uses, so the projection ends on the ETA month.
 * Empty when there is nothing to project: already at the target, or no step.
 */
export function projectToTarget(
  startMonth: string,
  startCents: number,
  stepCents: number,
  targetCents: number,
  maxMonths: number,
): { t: string; v: number }[] {
  if (![startCents, stepCents, targetCents, maxMonths].every(Number.isSafeInteger)) return []
  const gap = targetCents - startCents
  if (gap <= 0 || stepCents <= 0 || maxMonths < 1) return []
  const months = Math.min(maxMonths, Math.floor(gap / stepCents) + (gap % stepCents === 0 ? 0 : 1))
  const out: { t: string; v: number }[] = []
  for (let k = 0; k <= months; k++) out.push({ t: addMonthsToMonth(startMonth, k), v: startCents + k * stepCents })
  return out
}

/**
 * Several step series (balances recorded on dates) summed on the union of
 * their dates: at each date, every series contributes its latest value on or
 * before it, and nothing before its first point. Dates must sort as strings
 * ('YYYY-MM-DD' or 'YYYY-MM'); each series ascending. Two mortgages on one
 * house become one debt line whose every point is a real recorded date.
 */
export function sumAsOf(series: readonly (readonly { t: string; v: number }[])[]): { t: string; v: number }[] {
  const dates = [...new Set(series.flatMap((s) => s.map((p) => p.t)))].sort()
  const at = series.map(() => -1)
  return dates.map((t) => {
    let v = 0
    series.forEach((s, i) => {
      while (at[i]! + 1 < s.length && s[at[i]! + 1]!.t <= t) at[i]!++
      if (at[i]! >= 0) v += s[at[i]!]!.v
    })
    return { t, v }
  })
}

/**
 * Gross sale needed to net a target amount after long-term capital-gains tax,
 * given the basis share of proceeds and a capital-loss carryforward that
 * shields gains dollar-for-dollar. Solves X − tax(X) = net where
 * tax(X) = max(0, X·(1−basis) − carryforward) · rate.
 */
export function grossSaleForNet(
  netCents: number,
  basisPctMicro: number,
  rateMicro: number,
  carryforwardCents: number,
): { grossCents: number; taxCents: number } {
  if (netCents <= 0) return { grossCents: 0, taxCents: 0 }
  const b = basisPctMicro / 1_000_000
  const r = rateMicro / 1_000_000
  if (netCents * (1 - b) <= carryforwardCents || r === 0) return { grossCents: netCents, taxCents: 0 }
  const gross = Math.round((netCents - carryforwardCents * r) / (1 - (1 - b) * r))
  const tax = Math.max(0, Math.round((gross * (1 - b) - carryforwardCents) * r))
  return { grossCents: gross, taxCents: tax }
}

/* ---------------- Compare: difference, growth and drawdown (C7) ---------------- */

type CmpPoint = { t: string; v: number | null; est?: boolean }

/**
 * A − B on the union of their dates, for Compare's "Difference" mode. Each
 * date reads both series as of it (their last point on or before it, as the
 * crosshair does); a date where either has no reading yet, or a null one, is
 * left out. Integer cents in, integer cents out — a non-integer reading is
 * treated as missing rather than rounded. `est` when either reading is an
 * estimate. Dates must sort as strings (both 'YYYY-MM', say); each series
 * ascending.
 */
export function diff(a: readonly CmpPoint[], b: readonly CmpPoint[]): { t: string; v: number; est?: boolean }[] {
  const dates = [...new Set([...a.map((p) => p.t), ...b.map((p) => p.t)])].sort()
  let i = -1
  let j = -1
  const out: { t: string; v: number; est?: boolean }[] = []
  for (const t of dates) {
    while (i + 1 < a.length && a[i + 1]!.t <= t) i++
    while (j + 1 < b.length && b[j + 1]!.t <= t) j++
    const pa = i >= 0 ? a[i]! : null
    const pb = j >= 0 ? b[j]! : null
    if (!pa || !pb || !Number.isSafeInteger(pa.v) || !Number.isSafeInteger(pb.v)) continue
    const v = pa.v! - pb.v!
    if (!Number.isSafeInteger(v)) continue
    out.push(pa.est || pb.est ? { t, v, est: true } : { t, v })
  }
  return out
}

/** Whole calendar months from one month to another ('YYYY-MM', or a 'YYYY-MM-DD' read by its month); negative when `to` is earlier. */
export function monthsApart(from: string, to: string): number {
  const ym = (s: string) => {
    const m = /^(\d{4})-(\d{2})/.exec(s)
    if (!m) throw new Error(`not a month: ${s}`)
    return Number(m[1]) * 12 + Number(m[2]) - 1
  }
  return ym(to) - ym(from)
}

/**
 * The change from `prev` to `cur` as a micro-fraction of |prev| (100_000 =
 * +10%), half away from zero, exact at any magnitude — changeBp's finer
 * twin. Measured against |prev| so a debt shrinking from −$500K to −$400K
 * reads +20%. Null without a base: `prev` is 0, or either is not an integer.
 */
export function changeMicro(cur: number, prev: number): number | null {
  if (!Number.isSafeInteger(cur) || !Number.isSafeInteger(prev) || prev === 0) return null
  return mulDivRound(cur - prev, 1_000_000, Math.abs(prev))
}

/**
 * Compound annual growth from `start` to `end` over `months` months, as a
 * micro-fraction per year (63_000 = 6.3%/yr): (end / start)^(12 / months) − 1.
 * Null under 12 months (annualizing a few months overstates wildly), when
 * `start` ≤ 0 (growth from nothing, or from a debt, has no rate) or `end` < 0.
 *
 * Float boundary: the root is taken on the ratio of two integers — a unitless
 * rate, never an amount — and the result is rounded once to whole micro (the
 * same boundary as shared/perf.ts xirr). Money itself never becomes a float.
 */
export function cagr(start: number, end: number, months: number): number | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isInteger(months)) return null
  if (months < 12 || start <= 0 || end < 0) return null
  if (end === start) return 0
  const r = Math.pow(end / start, 12 / months) - 1
  return Number.isFinite(r) ? Math.round(r * 1_000_000) : null
}

/**
 * The largest fall from a running peak to a later low, as a positive
 * micro-fraction of that peak (250_000 = a 25% drawdown), with the indices
 * of the peak and the low. Only peaks above zero count (a debt has no
 * drawdown in this sense); nulls are skipped. `micro` is 0 when the series
 * never fell. Null when no value is above zero. Integer math throughout.
 */
export function maxDrawdown(values: readonly (number | null)[]): { micro: number; peak: number; trough: number } | null {
  let peakI = -1
  let best: { micro: number; peak: number; trough: number } | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === null || v === undefined || !Number.isSafeInteger(v)) continue
    if (peakI < 0 || v > values[peakI]!) {
      if (v > 0) {
        peakI = i
        if (!best) best = { micro: 0, peak: i, trough: i }
      }
      continue
    }
    const peak = values[peakI]!
    const dd = mulDivRound(peak - v, 1_000_000, peak)
    if (!best || dd > best.micro) best = { micro: dd, peak: peakI, trough: i }
  }
  return best
}

/**
 * Where overlaid lines should all begin so that they share one anchor
 * (Compare's Rebased and % change): the latest of each series' first date
 * with a value above zero. A series with no such value — a liability, a
 * return withheld for thin price history — has no vote; it is refused
 * downstream anyway. Null when no series has one. Dates compare as strings.
 */
export function commonStart(series: readonly (readonly CmpPoint[])[]): string | null {
  let start: string | null = null
  for (const s of series) {
    const first = s.find((p) => p.v !== null && p.v !== undefined && p.v > 0)
    if (first && (start === null || first.t > start)) start = first.t
  }
  return start
}
