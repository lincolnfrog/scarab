/**
 * The pure half of the bar charts in viz.tsx (Cash & budget): the budget pace
 * for the month so far, shares of a total, the order Bullets draws its rows
 * in, and how long a first-reveal bar grow lasts. Money is integer cents; no
 * React, no DOM — node-tested in barsModel.test.ts.
 */
import { DUR } from '../ui/motion'

/** Days in a 'YYYY-MM' month (0 for anything that isn't one). */
export function daysInMonth(month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) return 0
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return 0
  return new Date(Date.UTC(Number(m[1]), mo, 0)).getUTCDate()
}

/**
 * Where spending "should" be by the end of today if a monthly budget were
 * spent evenly: budget × day ÷ days-in-month, rounded to a cent. Only for the
 * month `today` is in — a past month's pace is simply the whole budget, and a
 * future month has none — so anything else, or no budget, is null.
 */
export function paceCents(budgetCents: number, month: string, today: string): number | null {
  if (!Number.isSafeInteger(budgetCents) || budgetCents <= 0) return null
  if (month !== today.slice(0, 7)) return null
  const dim = daysInMonth(month)
  const day = Number(today.slice(8, 10))
  if (!dim || !Number.isInteger(day) || day < 1 || day > dim) return null
  return Math.round((budgetCents * day) / dim)
}

/**
 * A part's share of a whole for a tooltip: "34%", "<1%" for a sliver that
 * would otherwise round to a false 0%, "0%" for nothing. Integer percent,
 * half up; a whole of 0 or less has no shares.
 */
export function shareText(cents: number, totalCents: number): string {
  if (!(totalCents > 0) || !(cents > 0)) return '0%'
  const pct = Math.round((cents * 100) / totalCents)
  return pct === 0 ? '<1%' : `${Math.min(100, pct)}%`
}

export type BulletRow = { name: string; actual: number; budget: number }

/**
 * Bullets' row order: the budgeted rows first, then the ones with no budget
 * (they carry no plan to measure against, so they sit apart and look
 * neutral) — each group keeps the caller's order.
 */
export function orderBullets<T extends BulletRow>(rows: readonly T[]): T[] {
  return [...rows.filter((r) => r.budget > 0), ...rows.filter((r) => !(r.budget > 0))]
}

/**
 * Bullets' vertical layout: one slot per row, in `orderBullets` order, plus a
 * caption slot ("No budget") before the first unbudgeted row when budgeted
 * rows come before it. `y` is each slot's top in px; `height` the total.
 */
export function bulletLayout<T extends BulletRow>(
  rows: readonly T[],
  rowH: number,
  captionH: number,
): { rows: { row: T; y: number }[]; captionY: number | null; height: number } {
  const ordered = orderBullets(rows)
  const out: { row: T; y: number }[] = []
  let y = 0
  let captionY: number | null = null
  ordered.forEach((row, i) => {
    if (!(row.budget > 0) && i > 0 && ordered[i - 1]!.budget > 0) {
      captionY = y
      y += captionH
    }
    out.push({ row, y })
    y += rowH
  })
  return { rows: out, captionY, height: y }
}

/** What's left of a budget, or how far over it the month is: integer cents; null without a budget. */
export function budgetLeft(actual: number, budget: number): { left: number } | { over: number } | null {
  if (!Number.isSafeInteger(budget) || budget <= 0 || !Number.isSafeInteger(actual)) return null
  return actual > budget ? { over: actual - budget } : { left: budget - actual }
}

/**
 * Keyboard stepping through a chart's marks (one tab stop; arrows move):
 * ←/↑ back, →/↓ forward, Home/End to the ends, clamped rather than
 * wrapping. With nothing highlighted yet, any of those keys lands on `start`
 * (the selected month, say) — except Home/End, which go where they say.
 * Returns undefined for a key the chart doesn't handle, or with no marks.
 */
export function navStep(key: string, cur: number | null, n: number, start = 0): number | undefined {
  if (!(n > 0)) return undefined
  const last = n - 1
  const clamp = (i: number) => Math.min(last, Math.max(0, i))
  switch (key) {
    case 'Home':
      return 0
    case 'End':
      return last
    case 'ArrowLeft':
    case 'ArrowUp':
      return cur === null ? clamp(start) : clamp(cur - 1)
    case 'ArrowRight':
    case 'ArrowDown':
      return cur === null ? clamp(start) : clamp(cur + 1)
    default:
      return undefined
  }
}

/** How far apart consecutive bars start growing on a chart's first reveal (plan §C9). */
export const GROW_STAGGER_MS = 18

/**
 * How long a first-reveal grow of `n` staggered marks takes, plus a little
 * slack — after it the chart drops its grow class, so a keep-alive revisit
 * (which restarts CSS animations) never replays it. Capped so a long list
 * doesn't keep the class for seconds.
 */
export function growMs(n: number): number {
  const steps = Math.max(0, Math.min(40, Math.floor(n) - 1))
  return DUR[4] + steps * GROW_STAGGER_MS + 120
}

/** The stagger index for mark `i`, capped the same way as `growMs`. */
export const growIndex = (i: number) => Math.max(0, Math.min(40, Math.floor(i)))
