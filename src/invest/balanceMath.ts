import { monthEndIso } from '../../shared/dates'
import { daysBetween } from './lotMath'

/**
 * Balance-tracked accounts (401(k)s, HSAs, anything entered as a total):
 * when a balance counts as stale, and which statement dates the backfill
 * grid offers. Pure, node-tested.
 */

/** A balance older than this many days gets a "stale" chip: statements are quarterly, so a quarter and two weeks. */
export const BALANCE_STALE_DAYS = 45

/** Whole days since the balance's date. */
export const balanceAgeDays = (balancedOn: string, today: string): number => daysBetween(balancedOn, today)

/** Stale once older than BALANCE_STALE_DAYS. No balance at all isn't stale — it's missing, and says so. */
export function isBalanceStale(balancedOn: string | null | undefined, today: string): boolean {
  return !!balancedOn && balanceAgeDays(balancedOn, today) > BALANCE_STALE_DAYS
}

/** The last `n` calendar quarter-ends on or before today, newest first: statement dates for a backfill. */
export function quarterEnds(today: string, n = 8): string[] {
  let y = Number(today.slice(0, 4))
  let q = Math.ceil(Number(today.slice(5, 7)) / 3) // this quarter, 1–4
  const out: string[] = []
  while (out.length < n) {
    const end = monthEndIso(`${y}-${String(q * 3).padStart(2, '0')}`)
    if (end <= today) out.push(end)
    if (--q === 0) {
      q = 4
      y--
    }
  }
  return out
}

/** 'Sep 20' — or 'Sep 20, 2025' outside today's year. Display only. */
export function shortDay(iso: string, today: string): string {
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const [y, m, d] = iso.split('-')
  const base = `${MON[Number(m) - 1] ?? '?'} ${Number(d)}`
  return y === today.slice(0, 4) ? base : `${base}, ${y}`
}
