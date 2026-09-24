import type { TradeBody } from '../../shared/invest-api'
import { formatQtyMicro } from '../../shared/money'

/**
 * The record-trade sheet's arithmetic and form → request mapping, kept pure
 * so it is tested in node. Integers throughout: cents, micro-shares.
 *
 * A trade is entered as a price per share or as the total that moved, plus
 * any fees; the API stores the total (fees included — what actually left or
 * entered the account), and the other figure is derived for display.
 */

/** a × b / d, rounded half up, for non-negative integers — exact even past 2^53 (a big crypto lot × its price). */
export function mulDivRound(a: number, b: number, d: number): number {
  const p = a * b
  if (Number.isSafeInteger(p)) return Math.round(p / d)
  const D = BigInt(d)
  return Number((BigInt(a) * BigInt(b) * 2n + D) / (2n * D))
}

/** Shares × price per share, to the cent. */
export const grossCents = (qtyMicro: number, priceCents: number): number => mulDivRound(qtyMicro, priceCents, 1_000_000)

/** What moved: a buy costs the shares plus fees; a sale brings in the shares less fees (negative when fees exceed it). */
export const totalFromPrice = (side: 'buy' | 'sell', qtyMicro: number, priceCents: number, feesCents: number): number =>
  side === 'buy' ? grossCents(qtyMicro, priceCents) + feesCents : grossCents(qtyMicro, priceCents) - feesCents

/** The price per share a total implies once fees are taken out, to the cent; null with no shares or when fees exceed a buy's total. */
export function priceFromTotal(side: 'buy' | 'sell', qtyMicro: number, totalCents: number, feesCents: number): number | null {
  if (qtyMicro <= 0) return null
  const gross = side === 'buy' ? totalCents - feesCents : totalCents + feesCents
  if (gross < 0) return null
  return mulDivRound(gross, 1_000_000, qtyMicro)
}

export type LotChoice = 'fifo' | 'manual' | number

export type TradeForm = {
  accountId: number
  side: 'buy' | 'sell'
  symbol: string
  assetKind: 'stock' | 'crypto'
  qtyMicro: number | null
  /** Which figure is typed: the price per share or the total. */
  mode: 'price' | 'total'
  priceCents: number | null
  totalCents: number | null
  feesCents: number | null
  tradedOn: string
  /** Sells: FIFO, one chosen lot (its buy's trade id), or shares Scarab never tracked. */
  lot: LotChoice
  acquiredOn: string
  basisCents: number | null
}

/** The total the form stands for, or null while it can't be worked out yet. */
export function formTotalCents(f: Pick<TradeForm, 'side' | 'qtyMicro' | 'mode' | 'priceCents' | 'totalCents' | 'feesCents'>): number | null {
  if (f.mode === 'total') return f.totalCents
  if (f.qtyMicro === null || f.priceCents === null) return null
  return totalFromPrice(f.side, f.qtyMicro, f.priceCents, f.feesCents ?? 0)
}

/** The price per share the form stands for (typed, or implied by the total), or null. */
export function formPriceCents(f: Pick<TradeForm, 'side' | 'qtyMicro' | 'mode' | 'priceCents' | 'totalCents' | 'feesCents'>): number | null {
  if (f.mode === 'price') return f.priceCents
  if (f.qtyMicro === null || f.totalCents === null) return null
  return priceFromTotal(f.side, f.qtyMicro, f.totalCents, f.feesCents ?? 0)
}

/** The API takes share counts as text; micro-shares print exactly, without thousands commas. */
export const qtyParam = (micro: number): string => formatQtyMicro(micro).replace(/,/g, '')

/**
 * The request the form stands for. `{ error: null }` means not filled in
 * yet (say nothing); a string is something to fix before it can be recorded.
 */
export function tradeBody(f: TradeForm, today: string): { body: TradeBody } | { error: string | null } {
  const symbol = f.symbol.trim().toUpperCase()
  if (f.tradedOn && f.tradedOn > today) return { error: 'A trade is recorded once it has happened — pick today or earlier.' }
  if (f.side === 'sell' && f.lot === 'manual' && f.acquiredOn && f.tradedOn && f.acquiredOn > f.tradedOn)
    return { error: 'Those shares were acquired after this sale — check the acquired date.' }
  if (!f.accountId || !symbol || !f.tradedOn || f.qtyMicro === null) return { error: null }
  const total = formTotalCents(f)
  if (total === null) return { error: null }
  if (total < 0) return { error: 'The fees are more than the sale brought in.' }
  const body: TradeBody = {
    investAccountId: f.accountId,
    symbol,
    assetKind: f.assetKind,
    side: f.side,
    tradedOn: f.tradedOn,
    qty: qtyParam(f.qtyMicro),
    totalCents: total,
  }
  if (f.side === 'sell') {
    if (f.lot === 'manual') {
      if (!f.acquiredOn || f.basisCents === null) return { error: null }
      body.acquiredOn = f.acquiredOn
      body.basisCents = f.basisCents
    } else if (typeof f.lot === 'number') {
      body.soldLotTradeId = f.lot
    }
  }
  return { body }
}

/**
 * "Fidelity 401(k) ×2 · Schwab · Coinbase": the header's account line, names
 * in first-seen order with repeats counted.
 */
export function accountsLine(names: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return [...counts].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ')
}
