/**
 * Lot engine. Trades in, positions out — nothing here touches the DB.
 * All money is integer cents; all quantities are integer micro-shares.
 *
 * Sells resolve their basis three ways:
 *  - explicit: acquired_on + basis_cents on the sell (history predates Scarab)
 *  - specific lot: sold_lot_trade_id points at the buy whose lot it consumes
 *  - FIFO: oldest open lot first (the default)
 */
export type TradeInput = {
  id?: number
  traded_on: string // ISO date
  side: 'buy' | 'sell'
  qty_micro: number
  total_cents: number // buy: cost paid (incl. fees) · sell: proceeds received
  sold_lot_trade_id?: number | null
  acquired_on?: string | null
  basis_cents?: number | null
}

export type Lot = { trade_id?: number; opened_on: string; qty_micro: number; cost_cents: number }

export type Position = {
  qty_micro: number
  cost_cents: number // remaining basis of open lots
  lots: Lot[]
  realized_st_cents: number // lifetime
  realized_lt_cents: number
  realized_ytd_st_cents: number
  realized_ytd_lt_cents: number
  warnings: string[]
}

const DAY = 86400000
const isLongTerm = (openedOn: string, soldOn: string) => Date.parse(soldOn) - Date.parse(openedOn) > 365 * DAY

/** Process one asset's trades (chronological order enforced here). */
export function computePosition(trades: TradeInput[], today: string): Position {
  const sorted = [...trades].sort(
    (a, b) => a.traded_on.localeCompare(b.traded_on) || (a.id ?? 0) - (b.id ?? 0),
  )
  const thisYear = today.slice(0, 4)
  const pos: Position = {
    qty_micro: 0,
    cost_cents: 0,
    lots: [],
    realized_st_cents: 0,
    realized_lt_cents: 0,
    realized_ytd_st_cents: 0,
    realized_ytd_lt_cents: 0,
    warnings: [],
  }

  for (const t of sorted) {
    if (t.side === 'buy') {
      pos.lots.push({ trade_id: t.id, opened_on: t.traded_on, qty_micro: t.qty_micro, cost_cents: t.total_cents })
      continue
    }

    const record = (gain: number, openedOn: string) => {
      const lt = isLongTerm(openedOn, t.traded_on)
      if (lt) pos.realized_lt_cents += gain
      else pos.realized_st_cents += gain
      if (t.traded_on.slice(0, 4) === thisYear) {
        if (lt) pos.realized_ytd_lt_cents += gain
        else pos.realized_ytd_st_cents += gain
      }
    }
    const zeroBasis = (proceeds: number, why: string) => {
      pos.realized_st_cents += proceeds
      if (t.traded_on.slice(0, 4) === thisYear) pos.realized_ytd_st_cents += proceeds
      pos.warnings.push(why)
    }

    // (a) explicit basis — shares never lived in Scarab's lots
    if (t.basis_cents != null && t.acquired_on) {
      record(t.total_cents - t.basis_cents, t.acquired_on)
      continue
    }

    // (b) a specific chosen lot
    if (t.sold_lot_trade_id != null) {
      const idx = pos.lots.findIndex((l) => l.trade_id === t.sold_lot_trade_id)
      if (idx < 0) {
        zeroBasis(
          t.total_cents,
          `Sell on ${t.traded_on} targets lot #${t.sold_lot_trade_id}, which is not open — proceeds counted with zero basis.`,
        )
        continue
      }
      const lot = pos.lots[idx]!
      const take = Math.min(t.qty_micro, lot.qty_micro)
      const costShare = Math.round((lot.cost_cents * take) / lot.qty_micro)
      const proceedsShare = Math.round((t.total_cents * take) / t.qty_micro)
      record(proceedsShare - costShare, lot.opened_on)
      lot.qty_micro -= take
      lot.cost_cents -= costShare
      if (lot.qty_micro === 0) pos.lots.splice(idx, 1)
      if (take < t.qty_micro)
        zeroBasis(
          t.total_cents - proceedsShare,
          `Sell on ${t.traded_on} exceeds its chosen lot by ${(t.qty_micro - take) / 1_000_000} shares — excess counted with zero basis.`,
        )
      continue
    }

    // (c) FIFO
    let remaining = t.qty_micro
    const totalSold = t.qty_micro
    while (remaining > 0 && pos.lots.length > 0) {
      const lot = pos.lots[0]!
      const take = Math.min(remaining, lot.qty_micro)
      const costShare = Math.round((lot.cost_cents * take) / lot.qty_micro)
      const proceedsShare = Math.round((t.total_cents * take) / totalSold)
      record(proceedsShare - costShare, lot.opened_on)
      lot.qty_micro -= take
      lot.cost_cents -= costShare
      if (lot.qty_micro === 0) pos.lots.shift()
      remaining -= take
    }
    if (remaining > 0) {
      zeroBasis(
        Math.round((t.total_cents * remaining) / totalSold),
        `Sell on ${t.traded_on} exceeds recorded holdings by ${remaining / 1_000_000} shares — add the missing buy (or use "enter basis manually") for correct gains.`,
      )
    }
  }

  pos.qty_micro = pos.lots.reduce((s, l) => s + l.qty_micro, 0)
  pos.cost_cents = pos.lots.reduce((s, l) => s + l.cost_cents, 0)
  return pos
}

/** Value of a position at a price (cents per whole share). */
export function positionValueCents(qtyMicro: number, priceCents: number): number {
  return Math.round((qtyMicro * priceCents) / 1_000_000)
}
