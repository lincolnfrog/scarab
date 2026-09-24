import { OPENING_NOTE, RSU_VEST_NOTE, RSU_WITHHOLDING_NOTE, type InvestKind } from '../shared/invest-api'
import type { DbLike } from './db'
import { computePosition, type Position, type TradeInput } from './lots'

/**
 * Holdings per (account, asset): the seam every lots consumer reads through,
 * so cost basis, holding period and realized gains are pooled per account the
 * way a brokerage (and the IRS) pools them — VTI in a taxable account and VTI
 * in a Roth are two positions, not one.
 */

// Declared once, with the brokerage contract it belongs to.
export type { InvestKind }

export type HoldingRow = {
  investAccountId: number
  accountName: string
  accountKind: InvestKind
  /** Tax-advantaged: gains inside it never reach the tax bill. Today that is kind === 'retirement'. */
  sheltered: boolean
  assetId: number
  symbol: string
  assetKind: 'stock' | 'crypto'
  /** This account's trades in this asset dated on or before asOf, oldest first. */
  trades: (TradeInput & { id: number; note: string | null })[]
  pos: Position
}

type Row = TradeInput & {
  id: number
  note: string | null
  invest_account_id: number
  account_name: string
  account_kind: InvestKind
  asset_id: number
  symbol: string
  asset_kind: 'stock' | 'crypto'
}

/**
 * Lots-tracked accounts only; one row per (account, asset) with any trade on
 * or before `asOf` — closed positions included, since their realized gains
 * still count. Trades dated after `asOf` are excluded, so each `pos` is the
 * position as it stood at the end of that day, realized year-to-date figures
 * included (computed for asOf's calendar year). Rows come in account id, then
 * asset id, order.
 *
 * `taxableOnly` drops sheltered accounts; `accountId` / `assetId` narrow to one.
 */
export function loadHoldings(
  db: DbLike,
  today: string,
  opts: { asOf?: string; taxableOnly?: boolean; accountId?: number; assetId?: number } = {},
): HoldingRow[] {
  const asOf = opts.asOf ?? today
  const where = ["ia.tracking = 'lots'", 't.traded_on <= ?']
  const params: unknown[] = [asOf]
  if (opts.taxableOnly) where.push("ia.kind != 'retirement'")
  if (opts.accountId != null) {
    where.push('t.invest_account_id = ?')
    params.push(opts.accountId)
  }
  if (opts.assetId != null) {
    where.push('t.asset_id = ?')
    params.push(opts.assetId)
  }
  const rows = db
    .prepare(
      `SELECT t.id, t.traded_on, t.side, t.qty_micro, t.total_cents, t.sold_lot_trade_id, t.acquired_on,
              t.basis_cents, t.note, t.invest_account_id, ia.name AS account_name, ia.kind AS account_kind,
              t.asset_id, a.symbol, a.kind AS asset_kind
       FROM trades t
       JOIN invest_accounts ia ON ia.id = t.invest_account_id
       JOIN assets a ON a.id = t.asset_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.invest_account_id, t.asset_id, t.traded_on, t.id`,
    )
    .all(...params) as Row[]

  const groups: Omit<HoldingRow, 'pos'>[] = []
  let cur: Omit<HoldingRow, 'pos'> | undefined
  for (const r of rows) {
    if (!cur || cur.investAccountId !== r.invest_account_id || cur.assetId !== r.asset_id) {
      cur = {
        investAccountId: r.invest_account_id,
        accountName: r.account_name,
        accountKind: r.account_kind,
        sheltered: r.account_kind === 'retirement',
        assetId: r.asset_id,
        symbol: r.symbol,
        assetKind: r.asset_kind,
        trades: [],
      }
      groups.push(cur)
    }
    cur.trades.push({
      id: r.id,
      traded_on: r.traded_on,
      side: r.side,
      qty_micro: r.qty_micro,
      total_cents: r.total_cents,
      sold_lot_trade_id: r.sold_lot_trade_id,
      acquired_on: r.acquired_on,
      basis_cents: r.basis_cents,
      note: r.note,
    })
  }
  return groups.map((g) => ({ ...g, pos: computePosition(g.trades, asOf) }))
}

/** An asOf that takes in every trade, legacy future-dated ones included — for listing and editing the ledger. */
export const ALL_TIME = '9999-12-31'

/** One trade as the ledger stores it, in the shape computePosition reads. */
export type LedgerTrade = TradeInput & { id: number; note: string | null }

/**
 * Every trade one account holds in one asset, oldest first (traded_on, id) —
 * no date cutoff. The input for re-deriving a single holding when a trade in
 * it is listed, edited, deleted or previewed.
 */
export function holdingLedger(db: DbLike, accountId: number, assetId: number): LedgerTrade[] {
  return db
    .prepare(
      `SELECT id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, acquired_on, basis_cents, note
       FROM trades WHERE invest_account_id = ? AND asset_id = ?
       ORDER BY traded_on, id`,
    )
    .all(accountId, assetId) as LedgerTrade[]
}

/* ---------- a brokerage account's cash (the cash anchor) ---------- */

/** A trade as far as its account's cash is concerned. */
export type CashTrade = Pick<TradeInput, 'traded_on' | 'side' | 'total_cents' | 'acquired_on'> & { note: string | null }

/**
 * What a trade did to its account's cash, in cents: a buy spent its total
 * (fees included) and a sale brought its proceeds in. Except the trades no
 * cash changed hands for:
 *  - a vest's shares were pay, not bought;
 *  - a starting position — or any buy booked after its shares were acquired
 *    (a transfer in) — was booked, not bought, that day;
 *  - shares withheld at a vest paid the tax: the proceeds never landed here.
 */
export function cashEffectCents(t: CashTrade): number {
  if (t.side === 'sell') return t.note === RSU_WITHHOLDING_NOTE ? 0 : t.total_cents
  const booked = t.note === RSU_VEST_NOTE || t.note === OPENING_NOTE || (t.acquired_on != null && t.acquired_on < t.traded_on)
  return booked ? 0 : -t.total_cents
}

/** A balance snapshot on a lots account: its cash at the end of that day. */
export type CashAnchor = { balanced_on: string; balance_cents: number }

export type DerivedCash = {
  cents: number
  /** The anchor it builds from: its day and amount. */
  as_of: string
  anchor_cents: number
  /** Trades after the anchor, through the day asked about, that moved the cash. */
  trades: number
}

/**
 * The account's cash at the end of `through` (a day, or a month-end sentinel
 * that sorts after every day of its month): the latest anchor on or before
 * it, plus what the trades dated after the anchor and on or before `through`
 * did to it. An anchor is the end-of-day balance, so trades on its own day
 * are already in it. null when no anchor is that old — the account has no
 * cash as far as Scarab knows, and behaves as if cash didn't exist.
 * Deposits and withdrawals aren't recorded: a newer anchor re-bases it.
 */
export function cashAt(anchors: readonly CashAnchor[], trades: readonly CashTrade[], through: string): DerivedCash | null {
  let anchor: CashAnchor | undefined
  for (const a of anchors) if (a.balanced_on <= through && (!anchor || a.balanced_on > anchor.balanced_on)) anchor = a
  if (!anchor) return null
  let cents = anchor.balance_cents
  let n = 0
  for (const t of trades) {
    if (t.traded_on <= anchor.balanced_on || t.traded_on > through) continue
    const e = cashEffectCents(t)
    if (e === 0) continue
    cents += e
    n++
  }
  return { cents, as_of: anchor.balanced_on, anchor_cents: anchor.balance_cents, trades: n }
}
