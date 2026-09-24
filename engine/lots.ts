import { addDaysIso, anniversaryIso } from '../shared/dates'

/**
 * Lot engine. Trades in, positions out — nothing here touches the DB.
 * All money is integer cents; all quantities are integer micro-shares.
 *
 * A buy opens a lot on `acquired_on ?? traded_on`: a starting position is
 * recorded as a buy on the day Scarab's records begin (traded_on) but keeps
 * the day its shares were really acquired, which sets the holding period.
 * Trades are still processed in traded_on order — a sale can only consume a
 * lot that was on the books when it happened.
 *
 * Sells resolve their basis three ways:
 *  - explicit: acquired_on + basis_cents on the sell (history predates Scarab)
 *  - specific lot: sold_lot_trade_id points at the buy whose lot it consumes
 *  - FIFO: the earliest-acquired open lot first (the default)
 */
export type TradeInput = {
  id?: number
  traded_on: string // ISO date
  side: 'buy' | 'sell'
  qty_micro: number
  total_cents: number // buy: cost paid (incl. fees) · sell: proceeds received
  sold_lot_trade_id?: number | null
  acquired_on?: string | null // sell: explicit basis's acquisition · buy: when the shares were really acquired
  basis_cents?: number | null
}

export type Lot = { trade_id?: number; opened_on: string; qty_micro: number; cost_cents: number }

/**
 * What one sale took from one lot. `lot_trade_id` is null for an explicit
 * basis (shares that never lived in Scarab's lots): that part's opened_on is
 * the sell's acquired_on and its cost the sell's basis_cents.
 */
export type SalePart = {
  lot_trade_id: number | null
  opened_on: string
  qty_micro: number
  cost_cents: number
  proceeds_cents: number
  term: 'st' | 'lt'
}

/**
 * How one sell resolved: the lots it consumed, and whatever it couldn't
 * match to a lot (proceeds counted with zero basis, short-term). Parts plus
 * zero-basis always add up to the sale's shares and its proceeds.
 */
export type Sale = {
  trade_id: number | null
  traded_on: string
  qty_micro: number
  proceeds_cents: number
  parts: SalePart[]
  zero_basis_cents: number
  zero_basis_qty_micro: number
}

export type Position = {
  qty_micro: number
  cost_cents: number // remaining basis of open lots
  lots: Lot[]
  realized_st_cents: number // lifetime
  realized_lt_cents: number
  realized_ytd_st_cents: number
  realized_ytd_lt_cents: number
  warnings: string[]
  /** Every sell, in the order processed, with the lots it took. The realized figures above are these summed. */
  sales: Sale[]
}

/** A sale's realized gain by term — zero-basis proceeds count as short-term. */
export function saleRealized(s: Sale): { st_cents: number; lt_cents: number } {
  let st = s.zero_basis_cents
  let lt = 0
  for (const p of s.parts) {
    if (p.term === 'lt') lt += p.proceeds_cents - p.cost_cents
    else st += p.proceeds_cents - p.cost_cents
  }
  return { st_cents: st, lt_cents: lt }
}

/**
 * Long-term means held more than one year: the holding period starts the day
 * after acquisition, so a sale on the one-year anniversary is still short-term
 * and the day after is long-term (IRS Pub 550). Counting days instead gets
 * leap years wrong — Feb 5 2024 → Feb 5 2025 is 366 days and still short-term.
 * A Feb 29 acquisition's anniversary is Feb 28, so Mar 1 is its first
 * long-term day. The one rule for lots, the harvest list and the screens.
 */
export const isLongTerm = (openedOn: string, soldOn: string): boolean => soldOn > anniversaryIso(openedOn)

/** The first day a sale of a lot opened on `openedOn` counts as long-term. */
export const longTermOn = (openedOn: string): string => addDaysIso(anniversaryIso(openedOn), 1)

/**
 * The cost basis `take` micro-shares carry out of a lot holding `lotQtyMicro`
 * that cost `lotCostCents`: its pro-rata share, rounded to the cent. The one
 * formula every sale uses — and what an RSU vest's withholding sale is priced
 * at, so it realizes exactly $0.
 */
export const lotCostShare = (lotCostCents: number, takeMicro: number, lotQtyMicro: number): number =>
  Math.round((lotCostCents * takeMicro) / lotQtyMicro)

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
    sales: [],
  }

  for (const t of sorted) {
    if (t.side === 'buy') {
      const lot: Lot = { trade_id: t.id, opened_on: t.acquired_on || t.traded_on, qty_micro: t.qty_micro, cost_cents: t.total_cents }
      // FIFO is first acquired, first sold: keep open lots in acquisition
      // order. Lots acquired the same day stay in the order they were booked.
      let at = pos.lots.length
      while (at > 0 && pos.lots[at - 1]!.opened_on > lot.opened_on) at--
      pos.lots.splice(at, 0, lot)
      continue
    }

    const sale: Sale = {
      trade_id: t.id ?? null,
      traded_on: t.traded_on,
      qty_micro: t.qty_micro,
      proceeds_cents: t.total_cents,
      parts: [],
      zero_basis_cents: 0,
      zero_basis_qty_micro: 0,
    }
    pos.sales.push(sale)
    const inYear = t.traded_on.slice(0, 4) === thisYear
    const record = (lotTradeId: number | null, openedOn: string, qty: number, cost: number, proceeds: number) => {
      const gain = proceeds - cost
      const lt = isLongTerm(openedOn, t.traded_on)
      if (lt) pos.realized_lt_cents += gain
      else pos.realized_st_cents += gain
      if (inYear) {
        if (lt) pos.realized_ytd_lt_cents += gain
        else pos.realized_ytd_st_cents += gain
      }
      sale.parts.push({ lot_trade_id: lotTradeId, opened_on: openedOn, qty_micro: qty, cost_cents: cost, proceeds_cents: proceeds, term: lt ? 'lt' : 'st' })
    }
    const zeroBasis = (proceeds: number, qty: number, why: string) => {
      pos.realized_st_cents += proceeds
      if (inYear) pos.realized_ytd_st_cents += proceeds
      sale.zero_basis_cents += proceeds
      sale.zero_basis_qty_micro += qty
      pos.warnings.push(why)
    }

    // (a) explicit basis — shares never lived in Scarab's lots
    if (t.basis_cents != null && t.acquired_on) {
      record(null, t.acquired_on, t.qty_micro, t.basis_cents, t.total_cents)
      continue
    }

    // (b) a specific chosen lot
    if (t.sold_lot_trade_id != null) {
      const idx = pos.lots.findIndex((l) => l.trade_id === t.sold_lot_trade_id)
      if (idx < 0) {
        zeroBasis(
          t.total_cents,
          t.qty_micro,
          `Sell on ${t.traded_on} targets lot #${t.sold_lot_trade_id}, which is not open — proceeds counted with zero basis.`,
        )
        continue
      }
      const lot = pos.lots[idx]!
      const take = Math.min(t.qty_micro, lot.qty_micro)
      const costShare = lotCostShare(lot.cost_cents, take, lot.qty_micro)
      const proceedsShare = Math.round((t.total_cents * take) / t.qty_micro)
      record(lot.trade_id ?? null, lot.opened_on, take, costShare, proceedsShare)
      lot.qty_micro -= take
      lot.cost_cents -= costShare
      if (lot.qty_micro === 0) pos.lots.splice(idx, 1)
      if (take < t.qty_micro)
        zeroBasis(
          t.total_cents - proceedsShare,
          t.qty_micro - take,
          `Sell on ${t.traded_on} exceeds its chosen lot by ${(t.qty_micro - take) / 1_000_000} shares — excess counted with zero basis.`,
        )
      continue
    }

    // (c) FIFO. Proceeds are allocated cumulatively — each lot gets
    // round(total × sharesSoFar / sold) minus what the lots before it got —
    // so the parts always add up to exactly what the sale brought in.
    let remaining = t.qty_micro
    const totalSold = t.qty_micro
    let taken = 0
    let allocated = 0
    while (remaining > 0 && pos.lots.length > 0) {
      const lot = pos.lots[0]!
      const take = Math.min(remaining, lot.qty_micro)
      const costShare = lotCostShare(lot.cost_cents, take, lot.qty_micro)
      taken += take
      const upTo = Math.round((t.total_cents * taken) / totalSold)
      record(lot.trade_id ?? null, lot.opened_on, take, costShare, upTo - allocated)
      allocated = upTo
      lot.qty_micro -= take
      lot.cost_cents -= costShare
      if (lot.qty_micro === 0) pos.lots.shift()
      remaining -= take
    }
    if (remaining > 0) {
      zeroBasis(
        t.total_cents - allocated,
        remaining,
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
