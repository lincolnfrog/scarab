import type { PortfolioAccount } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { shortDay } from './balanceMath'

/**
 * A lots account's cash, as the screens word it (the engine derives it:
 * PortfolioAccount). Pure, node-tested.
 */

export type CashView =
  /** No cash balance recorded: sale proceeds aren't counted anywhere. */
  | { state: 'none'; uncountedCents: number }
  | {
      state: 'set'
      cents: number
      /** "from $500.00 on Aug 31 · 2 trades since" */
      line: string
      /** The trades since the anchor took it below $0 (a deposit Scarab never saw) — not a margin balance entered as one. */
      short: boolean
    }

export function cashView(c: PortfolioAccount | null | undefined, today: string): CashView | null {
  if (!c) return null
  if (c.cash_cents === null || c.cash_as_of === null) return { state: 'none', uncountedCents: c.uncounted_proceeds_cents }
  const since = c.cash_trades > 0 ? ` · ${c.cash_trades} trade${c.cash_trades === 1 ? '' : 's'} since` : ''
  return {
    state: 'set',
    cents: c.cash_cents,
    line: `from ${formatCents(c.cash_anchor_cents ?? 0)} on ${shortDay(c.cash_as_of, today)}${since}`,
    short: c.cash_cents < 0 && (c.cash_anchor_cents ?? 0) >= 0,
  }
}

/** The account's cash, or 0 when none is recorded (what net worth adds for it). */
export const cashCents = (c: PortfolioAccount | null | undefined): number => c?.cash_cents ?? 0

/** The portfolio's cash row: the sum over anchored accounts, or null when no account has a cash balance. */
export function portfolioCash(accounts: readonly PortfolioAccount[]): { cents: number; accounts: number } | null {
  const set = accounts.filter((a) => a.cash_cents !== null)
  return set.length === 0 ? null : { cents: set.reduce((s, a) => s + a.cash_cents!, 0), accounts: set.length }
}
