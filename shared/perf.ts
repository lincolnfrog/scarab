/**
 * Performance math: rates of return from dated cash flows. Isomorphic and sync
 * (the engine and the browser both call it).
 *
 * The float boundary, as in engine/simulate.ts: flows come in as integer cents
 * and rates go out as integer micro (1_000_000 = 100%). Solving for a rate is
 * root-finding on a polynomial in (1 + r), so floats are used inside and never
 * escape: every public result is rounded to a whole micro. Money is never
 * computed here.
 */

/** Whole days since 1970-01-01 for a 'YYYY-MM-DD', on the UTC calendar, so the runtime's time zone never shifts it. */
export function dayNumber(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000)
}

/** One dated cash flow: `day` from dayNumber(); `cents` negative = money in (a buy), positive = money out (a sale, or the value today). */
export type Flow = { day: number; cents: number }

/** The bracket the bisection fallback searches: a total loss short of −100% up to +1,000% per period. */
export const XIRR_BRACKET = { lo: -0.9999, hi: 10 } as const

/**
 * The internal rate of return of dated cash flows (Excel's XIRR): the rate r
 * at which Σ cents / (1 + r)^((day − firstDay) / basisDays) = 0, as integer
 * micro. With the default basis of 365 days it is annual — Microsoft's XIRR
 * example comes out at 373363 (37.3363%).
 *
 * `basisDays` changes the period the rate is quoted over: pass a holding's own
 * length in days and the answer is its money-weighted return over that whole
 * holding period instead — the same root, (1 + r_annual)^(basisDays/365) − 1,
 * without first annualizing a short holding into an absurd number.
 *
 * Newton's method from 0.1 first; when it fails to converge (a flat or
 * pathological curve), bisection over XIRR_BRACKET. Null when there is no
 * answer: fewer than one inflow and one outflow (all-positive or all-negative
 * flows have no rate), no root in the bracket, or a non-positive basis.
 * Zero flows are ignored.
 */
export function xirr(flows: Flow[], opts: { basisDays?: number } = {}): number | null {
  const basis = opts.basisDays ?? 365
  if (!(basis > 0) || !Number.isFinite(basis)) return null
  const live = flows.filter((f) => f.cents !== 0)
  if (!live.some((f) => f.cents > 0) || !live.some((f) => f.cents < 0)) return null
  for (const f of live) if (!Number.isSafeInteger(f.cents) || !Number.isSafeInteger(f.day)) return null

  const first = Math.min(...live.map((f) => f.day))
  const terms = live.map((f) => ({ t: (f.day - first) / basis, c: f.cents }))
  const npv = (r: number) => terms.reduce((s, { t, c }) => s + c / Math.pow(1 + r, t), 0)
  const slope = (r: number) => terms.reduce((s, { t, c }) => s - (t * c) / Math.pow(1 + r, t + 1), 0)
  // Every flow on one day: nothing to discount, so no rate (the sum is fixed).
  if (terms.every((x) => x.t === 0)) return null

  let r = 0.1
  for (let i = 0; i < 100; i++) {
    const f = npv(r)
    const d = slope(r)
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break
    const next = r - f / d
    if (!Number.isFinite(next) || next <= -1) break
    if (Math.abs(next - r) < 1e-10) return toMicro(next)
    r = next
  }

  let { lo, hi } = XIRR_BRACKET as { lo: number; hi: number }
  let fLo = npv(lo)
  const fHi = npv(hi)
  if (!Number.isFinite(fLo) || !Number.isFinite(fHi)) return null
  if (fLo === 0) return toMicro(lo)
  if (fHi === 0) return toMicro(hi)
  if (Math.sign(fLo) === Math.sign(fHi)) return null
  for (let i = 0; i < 200 && hi - lo > 1e-12; i++) {
    const mid = (lo + hi) / 2
    const fMid = npv(mid)
    if (fMid === 0) return toMicro(mid)
    if (Math.sign(fMid) === Math.sign(fLo)) {
      lo = mid
      fLo = fMid
    } else hi = mid
  }
  return toMicro((lo + hi) / 2)
}

/** The float boundary: a rate as whole micro, never −0. */
function toMicro(rate: number): number | null {
  if (!Number.isFinite(rate)) return null
  const m = Math.round(rate * 1_000_000)
  return Number.isSafeInteger(m) ? m + 0 : null
}

/* ---------- time-weighted return ---------- */

/**
 * Time-weighted return: how the investments themselves did, with the money
 * moved in and out taken out of the picture. Buying more shares is not a gain
 * and selling some is not a loss — only price moves are. That is what makes
 * two portfolios, or a portfolio and an index, comparable.
 *
 * Each period's return is Modified Dietz: the gain over the period divided by
 * the money at work, where each flow counts for the share of the period it was
 * in. Periods are chain-linked into an index. Unlike xirr this needs no float
 * at all: a period's growth is an exact fraction of integers (BigInt, since
 * cents × days outgrows 2^53), and the index is rounded to whole micro once
 * per period.
 */

/** An index in micro: 1_000_000 reads as 100 (the same scale as shared/series.ts INDEX_BASE). */
export const TWR_BASE = 1_000_000

/**
 * One external flow inside a period, in integer cents: > 0 is money put to
 * work (a buy), < 0 is money taken out (a sale). It happens at the end of day
 * `day` of the period (1 = its first day), so it is at work for the days after.
 */
export type PeriodFlow = { day: number; cents: number }

/** One period: its value at the start and at the end (integer cents), its length in days, and the flows between. */
export type ReturnPeriod = { start: number; end: number; days: number; flows: readonly PeriodFlow[] }

/** A period's growth as an exact fraction: 1 + r = num / den. */
export type Growth = { num: bigint; den: bigint }

const ONE: Growth = { num: 1n, den: 1n }

/**
 * One period's growth factor, Modified Dietz, as an exact fraction; null when
 * the period can't be measured.
 *
 *   1 + r = 1 + (end − start − Σflows) / (start + Σ flow × its share of the period)
 *
 * A flow on day d of a D-day period is at work for (D − d) / D of it. Two
 * refinements keep a position's first and last months honest:
 *   - Starting from nothing, the period begins at the first flow (the money
 *     wasn't at work before it existed), so a buy on the 25th earning 2% by
 *     month end reads as 2%, not 2% spread over the whole month.
 *   - Ending at nothing (sold out), the period ends at the last flow.
 * When everything happens at one moment (bought and sold the same day, or
 * bought on the period's last day), the money put in is the base.
 *
 * Nothing held and nothing moved: growth is exactly 1. Null (unmeasurable)
 * when value appears from nowhere, the money at work isn't positive (a large
 * sale early in the period can do that), the period would lose more than
 * everything, or the input isn't whole numbers.
 */
export function periodGrowth(p: ReturnPeriod): Growth | null {
  const { start, end, days } = p
  if (!Number.isSafeInteger(days) || days < 1 || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  const flows = p.flows.filter((f) => f.cents !== 0)
  for (const f of flows)
    if (!Number.isSafeInteger(f.cents) || !Number.isSafeInteger(f.day) || f.day < 1 || f.day > days) return null
  if (flows.length === 0) {
    if (start === 0) return end === 0 ? ONE : null
    return fraction(BigInt(end), BigInt(start))
  }
  const net = flows.reduce((s, f) => s + BigInt(f.cents), 0n)
  const from = start !== 0 ? 0 : Math.min(...flows.map((f) => f.day))
  const to = end !== 0 ? days : Math.max(...flows.map((f) => f.day))
  const span = BigInt(to - from)
  const gain = BigInt(end) - BigInt(start) - net
  if (span === 0n) {
    const base = flows.reduce((s, f) => s + (f.cents > 0 ? BigInt(f.cents) : 0n), BigInt(start))
    return fraction(base + gain, base)
  }
  const atWork = flows.reduce((s, f) => s + BigInt(f.cents) * BigInt(to - f.day), span * BigInt(start))
  return fraction(atWork + span * gain, atWork)
}

const fraction = (num: bigint, den: bigint): Growth | null => (den > 0n && num >= 0n ? { num, den } : null)

/** a × num / den rounded half up, for non-negative a and a Growth. */
const scale = (a: bigint, g: Growth) => (2n * a * g.num + g.den) / (2n * g.den)

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

/**
 * Chain-links periods into a time-weighted index, in micro: the index after
 * each period, starting from `base` (TWR_BASE, i.e. 100) before the first.
 * A null period, or one periodGrowth can't measure, carries the index flat and
 * comes back with measured = false. Flat prices with every flow at those
 * prices give exactly `base` throughout.
 */
export function linkReturns(
  periods: readonly (ReturnPeriod | null)[],
  base: number = TWR_BASE,
): { index: number[]; measured: boolean[] } {
  if (!Number.isSafeInteger(base) || base < 0) throw new Error('linkReturns: base must be a non-negative whole number')
  let at = BigInt(base)
  const index: number[] = []
  const measured: boolean[] = []
  for (const p of periods) {
    const g = p === null ? null : periodGrowth(p)
    const next = g === null ? null : scale(at, g)
    if (next !== null && next <= MAX_SAFE) at = next
    measured.push(next !== null && next <= MAX_SAFE)
    index.push(Number(at))
  }
  return { index, measured }
}
