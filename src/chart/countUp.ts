/**
 * The count-up on a hero figure's first reveal (plan §C11): the pure frame
 * function, node-tested. The component is CountUp in CountUpText.tsx.
 */
import { DUR } from '../ui/motion'

/** How long a count-up runs (ms): the chart-reveal duration, so the figure lands with the line. */
export const COUNT_MS = DUR[4]

/**
 * The value shown at progress `k` (0…1) of a count from `from` to `to`:
 * ease-out cubic (fast, then settling, like --ease-out), rounded to a whole
 * unit, never past `to`, and exactly `to` at k ≥ 1 — so the last frame is the
 * true figure, not a rounding of it.
 */
export function countUpAt(from: number, to: number, k: number): number {
  if (!(k < 1)) return to
  if (!(k > 0)) return from
  const e = 1 - Math.pow(1 - k, 3)
  const v = Math.round(from + (to - from) * e)
  return to >= from ? Math.min(to, Math.max(from, v)) : Math.max(to, Math.min(from, v))
}
