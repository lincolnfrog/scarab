/**
 * Chart scales: round-number value ticks (linear and log), a UTC time axis,
 * the one date parser every chart shares, and M4 decimation for long daily
 * series. Pure and synchronous — node-tested in scale.test.ts.
 *
 * Time is always epoch milliseconds at UTC midnight, and every calendar read
 * uses the UTC getters, so a US time zone can never label Jan 1 with the
 * previous year (bug #29).
 */
import { todayLocal } from '../../shared/dates'

export type NiceTicks = { ticks: number[]; lo: number; hi: number; step: number }

/** Round away float dust from `k·step` sums (0.1 + 0.2), to the step's own precision. */
function clean(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1)
  const r = Number(v.toFixed(Math.min(20, decimals)))
  return Object.is(r, -0) ? 0 : r
}

/**
 * Round-number ticks covering [lo, hi]: a step of 1, 2 or 5 × 10^k chosen so
 * the tick count lands closest to `target` (ties go to the extra tick), and
 * the domain widened out to the first and last tick. `integerStep` never
 * returns a step below 1 (counts, whole cents).
 *
 *   niceTicks(0, 26_766_984) → { ticks: [0, 10M, 20M, 30M], lo: 0, hi: 30M, step: 10M }
 */
export function niceTicks(lo: number, hi: number, target = 4, o: { integerStep?: boolean } = {}): NiceTicks {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ticks: [0, 1], lo: 0, hi: 1, step: 1 }
  if (lo > hi) [lo, hi] = [hi, lo]
  if (lo === hi) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1
    lo = lo === 0 ? 0 : lo - pad
    hi = hi + pad
  }
  const want = Math.max(2, Math.round(target))
  const e = Math.floor(Math.log10((hi - lo) / (want - 1)))
  let best: { step: number; nlo: number; nhi: number; count: number; score: number } | null = null
  for (let k = e - 1; k <= (o.integerStep ? Math.max(e + 1, 0) : e + 1); k++) {
    for (const m of [1, 2, 5]) {
      const step = clean(m * Math.pow(10, k), m * Math.pow(10, k))
      if (o.integerStep && step < 1) continue
      const nlo = clean(Math.floor(lo / step + 1e-9) * step, step)
      const nhi = clean(Math.ceil(hi / step - 1e-9) * step, step)
      const count = Math.round((nhi - nlo) / step) + 1
      const score = Math.abs(count - want) - (count > want ? 0.25 : 0)
      if (!best || score < best.score) best = { step, nlo, nhi, count, score }
    }
  }
  const b = best!
  const ticks = Array.from({ length: b.count }, (_, i) => clean(b.nlo + i * b.step, b.step))
  return { ticks, lo: b.nlo, hi: b.nhi, step: b.step }
}

/**
 * Ticks for a log axis over [lo, hi] (both > 0), all inside the range:
 * 1-2-5 per decade; powers of ten alone when that is too crowded; 1…9 per
 * decade when 1-2-5 leaves fewer than three; and linear round numbers as the
 * last resort for a narrow range — so the axis always reads (bug #30).
 */
export function logTicks(lo: number, hi: number, max = 8): number[] {
  if (lo > hi) [lo, hi] = [hi, lo]
  const inRange = (v: number) => v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)
  if (!(lo > 0) || !Number.isFinite(hi)) return niceTicks(lo, hi, 5).ticks.filter(inRange)
  const gen = (mults: number[]) => {
    const out: number[] = []
    for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++)
      for (const m of mults) {
        const v = Number((m * Math.pow(10, k)).toPrecision(12))
        if (inRange(v)) out.push(v)
      }
    return out
  }
  const oneTwoFive = gen([1, 2, 5])
  if (oneTwoFive.length > max) {
    const decades = gen([1])
    if (decades.length >= 3) return decades.length > max ? decades.filter((_, i) => i % Math.ceil(decades.length / max) === 0) : decades
    return oneTwoFive
  }
  if (oneTwoFive.length >= 3) return oneTwoFive
  const ones = gen([1, 2, 3, 4, 5, 6, 7, 8, 9])
  if (ones.length >= 3) return ones.length > max + 1 ? ones.filter((_, i) => i % 2 === 0) : ones
  for (const target of [5, 8, 12, 20]) {
    const lin = niceTicks(lo, hi, target).ticks.filter(inRange)
    if (lin.length >= 3) return lin
  }
  return [lo, hi]
}

/* ---------------- time ---------------- */

export const DAY_MS = 86_400_000
export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * A chart date → epoch ms at UTC midnight.
 *   'YYYY-MM-DD' → that day
 *   'YYYY-MM'    → the month's last day; the current month (per `today`) → today
 *   'YYYY'       → Jan 1
 * Anything else, or an impossible date, is NaN.
 */
export function parseT(t: string, today: string = todayLocal()): number {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const ms = Date.UTC(y, mo - 1, d)
    const back = new Date(ms)
    return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? ms : NaN
  }
  m = /^(\d{4})-(\d{2})$/.exec(t)
  if (m) {
    const [y, mo] = [Number(m[1]), Number(m[2])]
    if (mo < 1 || mo > 12) return NaN
    if (t === today.slice(0, 7)) return parseT(today.slice(0, 10), today)
    return Date.UTC(y, mo, 0) // day 0 of the next month = this month's last day
  }
  m = /^(\d{4})$/.exec(t)
  if (m) return Date.UTC(Number(m[1]), 0, 1)
  return NaN
}

/** Epoch ms → 'YYYY-MM-DD' (UTC). */
export function isoOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** "Sep 22, 2026" / "Sep 2026" (`month: true`) for tooltips; UTC. */
export function fmtDay(ms: number, o: { month?: boolean } = {}): string {
  const d = new Date(ms)
  const mon = MONTH_NAMES[d.getUTCMonth()]!
  return o.month ? `${mon} ${d.getUTCFullYear()}` : `${mon} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
}

export type TimeTick = { t: number; label: string; major: boolean }

type TimeUnit = { kind: 'day' | 'month' | 'year'; step: number; approx: number }
const UNITS: TimeUnit[] = [
  ...[1, 2, 7, 14].map((step) => ({ kind: 'day' as const, step, approx: step * DAY_MS })),
  ...[1, 2, 3, 6].map((step) => ({ kind: 'month' as const, step, approx: step * 30.44 * DAY_MS })),
  ...[1, 2, 5, 10, 20, 50, 100].map((step) => ({ kind: 'year' as const, step, approx: step * 365.25 * DAY_MS })),
]

const yy = (y: number) => `'${String(y).slice(-2)}`

/**
 * Calendar-aligned ticks between t0 and t1 (inclusive) for a plot `plotW`
 * pixels wide, at least `minGapPx` apart: days, then 1/2/3/6 months, then
 * 1/2/5/10… years — whichever is the finest that fits. Every step lands on a
 * round date (Jan/Apr/Jul/Oct for quarters, even years for 2), so the spacing
 * is even and never capped at a count (bug #31).
 *
 * Labels: years read "2026"; months "Mar", with the year on January and on
 * the first tick ("Mar '26", "Jan '27"); days "Sep 8". `major` marks a year
 * boundary (a month or day tick) or every year tick.
 */
export function timeTicks(t0: number, t1: number, plotW: number, minGapPx = 56): TimeTick[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0 || plotW <= 0) return []
  const span = Math.max(t1 - t0, DAY_MS)
  const unit = UNITS.find((u) => (u.approx / span) * plotW >= minGapPx) ?? UNITS[UNITS.length - 1]!
  const start = new Date(t0)
  const out: TimeTick[] = []
  const push = (t: number, label: string, major: boolean) => {
    if (t >= t0 && t <= t1) out.push({ t, label, major })
  }
  if (unit.kind === 'year') {
    let y = Math.ceil(start.getUTCFullYear() / unit.step) * unit.step
    if (Date.UTC(y, 0, 1) < t0) y += unit.step
    for (; Date.UTC(y, 0, 1) <= t1; y += unit.step) push(Date.UTC(y, 0, 1), String(y), true)
  } else if (unit.kind === 'month') {
    let y = start.getUTCFullYear()
    let mo = Math.floor(start.getUTCMonth() / unit.step) * unit.step
    for (; Date.UTC(y, mo, 1) <= t1; mo += unit.step) {
      if (mo >= 12) {
        y += Math.floor(mo / 12)
        mo %= 12
      }
      const t = Date.UTC(y, mo, 1)
      if (t > t1) break
      const first = out.length === 0 && t >= t0
      push(t, mo === 0 || first ? `${MONTH_NAMES[mo]} ${yy(y)}` : MONTH_NAMES[mo]!, mo === 0)
    }
  } else {
    for (let t = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1); t <= t1; ) {
      const d = new Date(t)
      const [y, mo] = [d.getUTCFullYear(), d.getUTCMonth()]
      const dim = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
      for (let day = 1; day + unit.step / 2 <= dim + 0.5; day += unit.step) {
        const td = Date.UTC(y, mo, day)
        const first = out.length === 0 && td >= t0
        const label = `${MONTH_NAMES[mo]} ${day}`
        push(td, first || (mo === 0 && day === 1) ? `${label} ${yy(y)}` : label, mo === 0 && day === 1)
      }
      t = Date.UTC(y, mo + 1, 1)
    }
  }
  return out
}

/**
 * Ticks for month-granular data, whose points sit on each month's valued day
 * (its last day; the current month at today — `parseT('YYYY-MM')`). The same
 * calendar steps as `timeTicks` (1/2/3/6 months, then 1/2/5/10… years), but
 * each tick lands on its month's point, so "Aug" sits under the August value
 * instead of under a Sep 1 that is a day after it. Year ticks sit on
 * January's point. Labels follow `timeTicks`: "Mar", with the year on January
 * and on the first tick; years read "2026".
 */
export function monthTicks(t0: number, t1: number, plotW: number, minGapPx = 56, today: string = todayLocal()): TimeTick[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0 || plotW <= 0) return []
  const span = Math.max(t1 - t0, DAY_MS)
  const unit = UNITS.find((u) => u.kind !== 'day' && (u.approx / span) * plotW >= minGapPx) ?? UNITS[UNITS.length - 1]!
  const valued = (y: number, mo: number) => parseT(`${String(y).padStart(4, '0')}-${String(mo + 1).padStart(2, '0')}`, today)
  const out: TimeTick[] = []
  const push = (t: number, label: string, major: boolean) => {
    const prev = out[out.length - 1]
    // The current month's point is today, closer than a month to the one before; never let it crowd.
    if (prev && ((t - prev.t) / span) * plotW < minGapPx * 0.6) return
    out.push({ t, label, major })
  }
  const start = new Date(t0)
  if (unit.kind === 'year') {
    for (let y = Math.floor(start.getUTCFullYear() / unit.step) * unit.step; ; y += unit.step) {
      const t = valued(y, 0)
      if (t > t1) break
      if (t >= t0) push(t, String(y), true)
    }
    return out
  }
  let y = start.getUTCFullYear()
  let mo = Math.floor(start.getUTCMonth() / unit.step) * unit.step
  for (;;) {
    const t = valued(y, mo)
    if (t > t1) break
    if (t >= t0) push(t, mo === 0 || out.length === 0 ? `${MONTH_NAMES[mo]} ${yy(y)}` : MONTH_NAMES[mo]!, mo === 0)
    mo += unit.step
    if (mo >= 12) {
      y += 1
      mo -= 12
    }
  }
  return out
}

/** Add whole calendar months to a UTC-midnight time, clamping the day (Mar 31 − 1 month → Feb 28). */
export function addMonthsUTC(t: number, months: number): number {
  const d = new Date(t)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + months
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return Date.UTC(y, m, Math.min(d.getUTCDate(), last))
}

/**
 * Which of `n` evenly spaced category labels to print, at most `max`: always
 * the first and the last; between them an even stride, nudged onto an index
 * `prefer` likes (a January) when one is within half a stride; and nothing
 * crowding the last label.
 */
export function indexTicks(n: number, max: number, prefer?: (i: number) => boolean): number[] {
  if (n <= 0) return []
  if (n === 1) return [0]
  const cap = Math.max(2, Math.floor(max))
  if (n <= cap) return Array.from({ length: n }, (_, i) => i)
  const stride = Math.ceil((n - 1) / (cap - 1))
  const out = [0]
  let next = stride
  while (next < n - 1) {
    let pick = next
    if (prefer) {
      const half = Math.floor(stride / 2)
      for (let d = 0; d <= half; d++) {
        if (next - d > out[out.length - 1]! + half && prefer(next - d)) {
          pick = next - d
          break
        }
        if (next + d < n - 1 && prefer(next + d)) {
          pick = next + d
          break
        }
      }
    }
    if (n - 1 - pick < Math.max(1, stride * 0.6)) break
    out.push(pick)
    next = pick + stride
  }
  out.push(n - 1)
  return out
}

/* ---------------- decimation ---------------- */

function lowerBound(ts: number[], t: number): number {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ts[mid]! < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

function upperBound(ts: number[], t: number): number {
  let lo = 0
  let hi = ts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (ts[mid]! <= t) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** Index of the point nearest `t` in an ascending `ts` (ties go left); -1 when empty. */
export function nearestIndex(ts: number[], t: number): number {
  if (ts.length === 0) return -1
  const i = lowerBound(ts, t)
  if (i <= 0) return 0
  if (i >= ts.length) return ts.length - 1
  return t - ts[i - 1]! <= ts[i]! - t ? i - 1 : i
}

/**
 * M4 decimation: for each pixel column of the visible window keep the first,
 * last, minimum and maximum point (and the first gap), so the drawn line is
 * pixel-identical to the full series — spikes, the global extremes and the
 * last close all survive, unlike a stride (bug #44). One neighbour on each
 * side of the window is kept so the line runs to the plot edges (clip it).
 * Returns the kept indices, ascending.
 */
export function decimateM4(ts: number[], vs: (number | null)[], t0: number, t1: number, plotW: number): number[] {
  const n = ts.length
  if (n === 0) return []
  let a = lowerBound(ts, t0)
  let b = upperBound(ts, t1) - 1
  if (a > 0) a--
  if (b < n - 1) b++
  if (b < a) return []
  const cols = Math.max(1, Math.floor(plotW))
  if (b - a + 1 <= cols * 4) return Array.from({ length: b - a + 1 }, (_, i) => a + i)
  const span = t1 - t0 || 1
  const keep: number[] = []
  let col = Number.NaN
  let first = -1
  let last = -1
  let minI = -1
  let maxI = -1
  let gapI = -1
  const flush = () => {
    if (first < 0) return
    const set = [first, minI, maxI, gapI, last].filter((i) => i >= 0).sort((x, y) => x - y)
    for (const i of set) if (keep[keep.length - 1] !== i) keep.push(i)
  }
  for (let i = a; i <= b; i++) {
    const c = Math.min(cols, Math.max(-1, Math.floor(((ts[i]! - t0) / span) * cols)))
    if (c !== col) {
      flush()
      col = c
      first = i
      minI = maxI = gapI = -1
    }
    const v = vs[i]
    if (v === null || v === undefined || Number.isNaN(v)) {
      if (gapI < 0) gapI = i
    } else {
      if (minI < 0 || v < vs[minI]!) minI = i
      if (maxI < 0 || v > vs[maxI]!) maxI = i
    }
    last = i
  }
  flush()
  return keep
}
