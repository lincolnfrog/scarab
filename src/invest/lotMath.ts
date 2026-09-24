import type { PortfolioLot } from '../../shared/invest-api'

/**
 * The display arithmetic for one lot, kept pure so it is tested in node. All
 * integers: cents, micro-shares, micro rates (1e6 = 100%). Holding periods
 * come from the engine's `lt_on` (the first long-term day, by the anniversary
 * rule), never from counting days on the clock here.
 */

export type LotTerm =
  | { kind: 'sheltered' } // tax-advantaged account: no tax on sale
  | { kind: 'lt' }
  | { kind: 'st'; daysToLt: number }

const DAY = 86_400_000

/** Whole calendar days from `from` to `to` (ISO days parse as UTC midnight, so no DST). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / DAY)

/** How a sale of this lot today would be taxed. */
export function lotTerm(lot: Pick<PortfolioLot, 'lt_on' | 'sheltered'>, today: string): LotTerm {
  if (lot.sheltered) return { kind: 'sheltered' }
  return today >= lot.lt_on ? { kind: 'lt' } : { kind: 'st', daysToLt: daysBetween(today, lot.lt_on) }
}

/** Shares × price, rounded to the cent. */
export const lotValueCents = (qtyMicro: number, priceCents: number): number => Math.round((qtyMicro * priceCents) / 1_000_000)

/** Cost per whole share, rounded to the cent. */
export const perShareCents = (costCents: number, qtyMicro: number): number =>
  qtyMicro > 0 ? Math.round((costCents * 1_000_000) / qtyMicro) : 0

export type SaleEstimate = {
  term: LotTerm
  valueCents: number
  gainCents: number
  /** Positive: tax owed on the gain. Negative: tax a loss would save. Zero in a sheltered account. */
  taxCents: number
  afterTaxCents: number
}

/** Selling the whole lot today at `priceCents`, at the household's marginal rates. */
export function saleEstimate(
  lot: Pick<PortfolioLot, 'lt_on' | 'sheltered' | 'qty_micro' | 'cost_cents'>,
  priceCents: number,
  marginal: { stMicro: number; ltMicro: number },
  today: string,
): SaleEstimate {
  const term = lotTerm(lot, today)
  const valueCents = lotValueCents(lot.qty_micro, priceCents)
  const gainCents = valueCents - lot.cost_cents
  const rate = term.kind === 'sheltered' ? 0 : term.kind === 'lt' ? marginal.ltMicro : marginal.stMicro
  const taxCents = Math.round((gainCents * rate) / 1_000_000)
  return { term, valueCents, gainCents, taxCents, afterTaxCents: valueCents - Math.max(0, taxCents) }
}

/**
 * The lots a sale in `accountId` may name: open lots of `symbol` held in that
 * very account (lots pool per account — the engine refuses anything else).
 * The symbol matches as typed, case-insensitively.
 */
export function sellableLots(
  positions: readonly { symbol: string; lots: readonly PortfolioLot[] }[],
  symbol: string,
  accountId: number,
): PortfolioLot[] {
  const sym = symbol.trim().toUpperCase()
  const p = positions.find((x) => x.symbol === sym)
  return p ? p.lots.filter((l) => l.trade_id !== null && l.invest_account_id === accountId) : []
}
