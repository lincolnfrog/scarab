import type { InvestAccountRow, PortfolioAccount, PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { accountValueCents } from './accountTypes'

/**
 * The owner pills on Investments — Household, each person, Joint — with each
 * one's subtotal, and the portfolio narrowed to one owner's accounts. Pure
 * and node-tested. Owners match case-insensitively (the account list and the
 * paycheck earners may spell a name differently); null is joint.
 */

/** 'all' = the whole household, 'joint', or 'p:<name, lower-cased>'. */
export type OwnerKey = string
export const HOUSEHOLD: OwnerKey = 'all'
export const JOINT: OwnerKey = 'joint'
export const personKey = (name: string): OwnerKey => `p:${name.trim().toLowerCase()}`
export const ownerKeyOf = (a: Pick<InvestAccountRow, 'owner'>): OwnerKey => (a.owner?.trim() ? personKey(a.owner) : JOINT)

export type OwnerGroup = {
  key: OwnerKey
  label: string
  /** The group's accounts' value: holdings plus cash, or the latest balance (what their tiles show). */
  cents: number
  accounts: number
}

/**
 * The pills: Household first, then each person who owns an account (in the
 * household's order — paycheck earners first), then Joint. Nothing when
 * there's nothing to split: every account is one person's, or all joint.
 */
export function ownerGroups(
  accounts: readonly InvestAccountRow[],
  owners: readonly string[],
  positions: readonly PortfolioPosition[],
  cash: ReadonlyMap<number, PortfolioAccount>,
): OwnerGroup[] {
  const sums = new Map<OwnerKey, { label: string; cents: number; accounts: number }>()
  const valueOf = (a: InvestAccountRow) => accountValueCents(a, positions, a.tracking === 'lots' ? cash.get(a.id) : undefined) ?? 0
  let total = 0
  for (const a of accounts) {
    const key = ownerKeyOf(a)
    const v = valueOf(a)
    total += v
    const g = sums.get(key) ?? { label: key === JOINT ? 'Joint' : a.owner!.trim(), cents: 0, accounts: 0 }
    g.cents += v
    g.accounts++
    sums.set(key, g)
  }
  if (sums.size < 2) return []
  const order = [...owners.map(personKey), ...[...sums.keys()].filter((k) => k !== JOINT)]
  const people = [...new Set(order)].filter((k) => sums.has(k) && k !== JOINT)
  const out: OwnerGroup[] = [{ key: HOUSEHOLD, label: 'Household', cents: total, accounts: accounts.length }]
  for (const k of people) {
    const g = sums.get(k)!
    // The household's own spelling of the name, where it has one.
    const named = owners.find((o) => personKey(o) === k)
    out.push({ key: k, label: named ?? g.label, cents: g.cents, accounts: g.accounts })
  }
  const joint = sums.get(JOINT)
  if (joint) out.push({ key: JOINT, label: 'Joint', cents: joint.cents, accounts: joint.accounts })
  return out
}

/** The accounts a pill shows: all of them for Household. */
export function inScope(a: Pick<InvestAccountRow, 'owner'>, key: OwnerKey): boolean {
  return key === HOUSEHOLD || ownerKeyOf(a) === key
}

/**
 * The portfolio as one owner's accounts hold it: each symbol's per-account
 * split kept for those accounts only (its quantity, cost and value re-summed
 * from them — the engine's own figures, so nothing is re-priced), its lots
 * likewise, symbols they don't hold dropped. Holdings totals re-summed; the
 * realized-gains totals stay the household's (one return).
 */
export function scopePortfolio(
  positions: readonly PortfolioPosition[],
  totals: PortfolioResponse['totals'],
  accountIds: ReadonlySet<number>,
): { positions: PortfolioPosition[]; totals: PortfolioResponse['totals'] } {
  const out: PortfolioPosition[] = []
  let value = 0
  let cost = 0
  for (const p of positions) {
    const accounts = p.accounts.filter((a) => accountIds.has(a.invest_account_id))
    if (accounts.length === 0) continue
    const q = accounts.reduce((s, a) => s + a.qty_micro, 0)
    const c = accounts.reduce((s, a) => s + a.cost_cents, 0)
    const v = accounts.reduce((s, a) => s + a.value_cents, 0)
    out.push({
      ...p,
      qty_micro: q,
      cost_cents: c,
      value_cents: v,
      unrealized_cents: v - c,
      accounts,
      lots: p.lots.filter((l) => accountIds.has(l.invest_account_id)),
    })
    value += v
    cost += c
  }
  out.sort((a, b) => b.value_cents - a.value_cents || a.symbol.localeCompare(b.symbol))
  return { positions: out, totals: { ...totals, value, cost, unrealized: value - cost } }
}

/** "Max’s accounts" / "joint accounts" — what a narrowed view shows, in words. */
export function scopeWords(g: Pick<OwnerGroup, 'key' | 'label'>): string {
  if (g.key === HOUSEHOLD) return 'every account'
  return g.key === JOINT ? 'joint accounts' : `${g.label}’s accounts`
}
