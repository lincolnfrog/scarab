import { monthsBetween } from '../shared/dates'
import type { DbLike } from './db'
import { cashAt, type CashTrade } from './holdings'
import { computePosition, positionValueCents, type Position, type TradeInput } from './lots'

export type NetWorthComponents = {
  cash: number
  brokerage: number
  retirement: number
  crypto: number
  property: number
  liabilities: number // negative
}
export type NetWorthPoint = { month: string } & NetWorthComponents & { total: number }

const sum = (o: NetWorthComponents) =>
  o.cash + o.brokerage + o.retirement + o.crypto + o.property + o.liabilities

const monthEnd = (month: string) => `${month}-99` // string-compare sentinel: after any day in month
const LATEST = '9999-99-99' // string-compare sentinel: after any date at all

/**
 * Net worth as of each month end, derived entirely from dated facts. A month's
 * value uses the latest fact on or before that month's end (prices, snapshots,
 * valuations, balances); assets with trades but no price yet are carried at
 * cost basis.
 *
 * Holdings in the current month are as of today: trades dated after today
 * haven't happened, and each asset is valued at its latest known price (a
 * quote stamped with tomorrow's UTC date is still today's price). That is
 * exactly how the portfolio values them, so the two agree to the cent.
 *
 * A lots account with a cash balance recorded (a balance snapshot: its cash
 * anchor) also counts its cash — the anchor plus what later trades did to it
 * (engine/holdings.ts cashAt) — so a sale moves value from shares to cash
 * instead of out of net worth. Without an anchor it counts holdings alone.
 */
export function netWorthSeries(db: DbLike, today: string): NetWorthPoint[] {
  const txMonths = db
    .prepare("SELECT min(substr(posted_on,1,7)) AS lo FROM transactions")
    .get() as { lo: string | null }
  const tradeMonths = db.prepare('SELECT min(substr(traded_on,1,7)) AS lo FROM trades').get() as {
    lo: string | null
  }
  const snapMonths = db
    .prepare('SELECT min(substr(balanced_on,1,7)) AS lo FROM balance_snapshots')
    .get() as { lo: string | null }
  const valMonths = db
    .prepare('SELECT min(substr(valued_on,1,7)) AS lo FROM property_valuations')
    .get() as { lo: string | null }
  const lows = [txMonths.lo, tradeMonths.lo, snapMonths.lo, valMonths.lo].filter(Boolean) as string[]
  const thisMonth = today.slice(0, 7)
  if (lows.length === 0) return []
  const first = lows.sort()[0]!
  const months = monthsBetween(first, thisMonth)

  // Pull everything once; derive per month in JS.
  const accounts = db.prepare('SELECT id, opening_cents FROM accounts').all() as {
    id: number
    opening_cents: number
  }[]
  const txs = db
    .prepare('SELECT account_id, posted_on, amount_cents FROM transactions ORDER BY posted_on')
    .all() as { account_id: number; posted_on: string; amount_cents: number }[]
  const investAccounts = db.prepare('SELECT id, kind, tracking FROM invest_accounts').all() as {
    id: number
    kind: 'brokerage' | 'retirement' | 'crypto'
    tracking: 'lots' | 'balance'
  }[]
  const trades = db
    .prepare(
      `SELECT id, invest_account_id, asset_id, traded_on, side, qty_micro, total_cents,
              sold_lot_trade_id, acquired_on, basis_cents, note FROM trades ORDER BY traded_on`,
    )
    .all() as ({ invest_account_id: number; asset_id: number; note: string | null } & TradeInput)[]
  const prices = db
    .prepare('SELECT asset_id, priced_on, close_cents FROM prices ORDER BY priced_on')
    .all() as { asset_id: number; priced_on: string; close_cents: number }[]
  const snaps = db
    .prepare('SELECT invest_account_id, balanced_on, balance_cents FROM balance_snapshots ORDER BY balanced_on')
    .all() as { invest_account_id: number; balanced_on: string; balance_cents: number }[]
  const vals = db
    .prepare('SELECT property_id, valued_on, value_cents FROM property_valuations ORDER BY valued_on')
    .all() as { property_id: number; valued_on: string; value_cents: number }[]
  const props = db.prepare('SELECT id, purchased_on, purchase_cents FROM properties').all() as {
    id: number
    purchased_on: string | null
    purchase_cents: number | null
  }[]
  const liabs = db
    .prepare('SELECT liability_id, balanced_on, balance_cents FROM liability_balances ORDER BY balanced_on')
    .all() as { liability_id: number; balanced_on: string; balance_cents: number }[]

  // Each entity's facts, once, in date order. Every lookup below is then a
  // binary search into its own rows, never a scan of a whole table: the
  // prices table alone gains a row per asset for every day with a quote.
  const txsBy = groupBy(txs, (t) => t.account_id)
  const tradesBy = groupBy(trades, (t) => t.invest_account_id)
  const pricesBy = groupBy(prices, (p) => p.asset_id)
  const snapsBy = groupBy(snaps, (s) => s.invest_account_id)
  const valsBy = groupBy(vals, (v) => v.property_id)
  const liabsBy = groupBy(liabs, (l) => l.liability_id)

  // A bank account's balance at a cutoff: opening plus the running sum of its first n transactions.
  const txSums = new Map<number, number[]>()
  for (const [id, rows] of txsBy) {
    const cum = [0]
    for (const t of rows) cum.push(cum[cum.length - 1]! + t.amount_cents)
    txSums.set(id, cum)
  }

  // Lots pool per (account, asset), as in engine/holdings.ts. A pool's
  // position only changes when a month takes in more of its trades, so it is
  // recomputed then and carried otherwise.
  type Pool = { assetId: number; trades: TradeInput[]; n: number; pos: Position | null }
  const pools = new Map<number, Pool[]>()
  for (const [accountId, rows] of tradesBy)
    pools.set(
      accountId,
      [...groupBy(rows, (t) => t.asset_id)].map(([assetId, list]) => ({ assetId, trades: list, n: 0, pos: null })),
    )

  return months.map((month) => {
    const cutoff = monthEnd(month)
    const current = month === thisMonth
    const tradeCutoff = current ? today : cutoff
    const priceCutoff = current ? LATEST : cutoff
    const c: NetWorthComponents = { cash: 0, brokerage: 0, retirement: 0, crypto: 0, property: 0, liabilities: 0 }

    for (const a of accounts) {
      const rows = txsBy.get(a.id)
      c.cash += a.opening_cents + (rows ? txSums.get(a.id)![countOnOrBefore(rows, (t) => t.posted_on, cutoff)]! : 0)
    }

    for (const ia of investAccounts) {
      let value = 0
      const anchors = snapsBy.get(ia.id) ?? []
      if (ia.tracking === 'balance') {
        value = lastOnOrBefore(anchors, (s) => s.balanced_on, cutoff)?.balance_cents ?? 0
      } else {
        for (const pool of pools.get(ia.id) ?? []) {
          const n = countOnOrBefore(pool.trades, (t) => t.traded_on, tradeCutoff)
          if (n === 0) continue
          if (n !== pool.n || !pool.pos) {
            pool.pos = computePosition(pool.trades.slice(0, n), today)
            pool.n = n
          }
          const pos = pool.pos
          if (pos.qty_micro === 0) continue
          const price = lastOnOrBefore(pricesBy.get(pool.assetId), (p) => p.priced_on, priceCutoff)
          value += price ? positionValueCents(pos.qty_micro, price.close_cents) : pos.cost_cents
        }
        // Its cash, when an anchor is recorded: snapshots on a lots account are cash balances.
        if (anchors.length > 0) {
          const own: CashTrade[] = tradesBy.get(ia.id) ?? []
          value += cashAt(anchors, own, tradeCutoff)?.cents ?? 0
        }
      }
      c[ia.kind] += value
    }

    for (const p of props) {
      const val = lastOnOrBefore(valsBy.get(p.id), (v) => v.valued_on, cutoff)
      if (val) c.property += val.value_cents
      else if (p.purchased_on && p.purchased_on <= cutoff && p.purchase_cents) c.property += p.purchase_cents
    }

    for (const rows of liabsBy.values()) {
      const bal = lastOnOrBefore(rows, (l) => l.balanced_on, cutoff)
      if (bal) c.liabilities -= bal.balance_cents
    }

    return { month, ...c, total: sum(c) }
  })
}

/** Rows grouped by an id, each group keeping the rows' order. */
function groupBy<T>(rows: readonly T[], key: (r: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>()
  for (const r of rows) {
    const k = key(r)
    const list = out.get(k)
    if (list) list.push(r)
    else out.set(k, [r])
  }
  return out
}

/** How many of `rows` (in date order) are dated on or before `cutoff`. */
function countOnOrBefore<T>(rows: readonly T[], date: (r: T) => string, cutoff: string): number {
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (date(rows[mid]!) <= cutoff) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The latest of `rows` (in date order) dated on or before `cutoff`. */
function lastOnOrBefore<T>(rows: readonly T[] | undefined, date: (r: T) => string, cutoff: string): T | undefined {
  if (!rows) return undefined
  const n = countOnOrBefore(rows, date, cutoff)
  return n > 0 ? rows[n - 1] : undefined
}
