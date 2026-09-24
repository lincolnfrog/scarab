import type { VestBody } from '../../shared/invest-api'
import { grossCents, mulDivRound, qtyParam } from './tradeMath'

/**
 * The vest dialog's arithmetic, pure and node-tested. Integers throughout:
 * cents and micro-shares.
 *
 * A release confirmation says how many shares vested (gross), their fair
 * market value (per share, or the total), and — with net settlement — how
 * many the employer withheld to pay the tax. The gross value is income on
 * Taxes and the lot's cost basis; the withheld shares leave the same day at
 * their share of that value, so their sale gains exactly $0.
 */

export type VestForm = {
  date: string
  grossMicro: number | null
  /** Which figure is typed: the FMV per share, or the total value at vest. */
  mode: 'price' | 'total'
  priceCents: number | null
  totalCents: number | null
  withheldMicro: number | null
}

export type VestPlan = {
  totalCents: number
  /** FMV per share, typed or implied by the total. */
  priceCents: number
  withheldMicro: number
  /** The withheld shares' value at vest — the tax they paid. */
  withheldCents: number
  netMicro: number
  /** What stays: the net shares' cost basis. */
  netCostCents: number
}

/**
 * The withheld shares' value: round(total × withheld / gross). The engine
 * prices the withholding sale with this very expression (engine/lots.ts
 * lotCostShare) — it is also the cost the lot engine takes out for them — so
 * what this shows is what gets recorded, to the cent.
 */
export const withheldValueCents = (totalCents: number, withheldMicro: number, grossMicro: number): number =>
  Math.round((totalCents * withheldMicro) / grossMicro)

/** The total value at vest the form stands for, or null until it can be worked out. */
export function vestTotalCents(f: Pick<VestForm, 'grossMicro' | 'mode' | 'priceCents' | 'totalCents'>): number | null {
  if (f.mode === 'total') return f.totalCents
  if (f.grossMicro === null || f.priceCents === null) return null
  return grossCents(f.grossMicro, f.priceCents)
}

/**
 * What recording the vest would do. `{ error: null }`: not filled in yet
 * (say nothing); a string is something to fix first.
 */
export function vestPlan(f: VestForm, today: string): { plan: VestPlan } | { error: string | null } {
  if (f.date && f.date > today) return { error: 'A vest is recorded once it has happened — pick today or earlier.' }
  if (f.grossMicro !== null && f.grossMicro <= 0) return { error: 'The shares vested must be more than 0.' }
  const withheld = f.withheldMicro ?? 0
  if (f.grossMicro !== null && withheld > f.grossMicro) return { error: 'More shares withheld than vested — check the release.' }
  if (!f.date || f.grossMicro === null) return { error: null }
  const total = vestTotalCents(f)
  if (total === null) return { error: null }
  if (total <= 0) return { error: 'The value at vest must be more than $0.' }
  const withheldCents = withheld > 0 ? withheldValueCents(total, withheld, f.grossMicro) : 0
  return {
    plan: {
      totalCents: total,
      priceCents: f.mode === 'price' && f.priceCents !== null ? f.priceCents : mulDivRound(total, 1_000_000, f.grossMicro),
      withheldMicro: withheld,
      withheldCents,
      netMicro: f.grossMicro - withheld,
      netCostCents: total - withheldCents,
    },
  }
}

/** The request a valid plan stands for. */
export function vestBody(o: { accountId: number; symbol: string; date: string; grossMicro: number; plan: VestPlan; allowUntracked: boolean }): VestBody {
  return {
    investAccountId: o.accountId,
    symbol: o.symbol,
    qty: qtyParam(o.grossMicro),
    tradedOn: o.date,
    totalCents: o.plan.totalCents,
    ...(o.plan.withheldMicro > 0 ? { withheldQty: qtyParam(o.plan.withheldMicro) } : {}),
    ...(o.allowUntracked ? { allowUntracked: true } : {}),
  }
}

export type Quote = { cents: number; pricedOn: string }

/**
 * A price to prefill the FMV with: only a close from the vest day itself —
 * the basket's quote or the stored price. Any other day's price would be the
 * wrong basis, so there is no prefill then.
 */
export function fmvPrefill(date: string, candidates: readonly (Quote | null | undefined)[]): Quote | null {
  if (!date) return null
  return candidates.find((q): q is Quote => !!q && q.pricedOn === date && q.cents > 0) ?? null
}

/** The date a vest dialog opens on: the scheduled vest if it has come, else today. */
export const vestDateDefault = (nextVestOn: string | null, today: string): string => (nextVestOn && nextVestOn <= today ? nextVestOn : today)
