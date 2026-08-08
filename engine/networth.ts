import type { DbLike } from './db'
import { computePosition, positionValueCents, type TradeInput } from './lots'

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

function monthsBetween(first: string, last: string): string[] {
  const out: string[] = []
  let [y, m] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))]
  const [ly, lm] = [Number(last.slice(0, 4)), Number(last.slice(5, 7))]
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

/**
 * Net worth as of each month end, derived entirely from dated facts. A month's
 * value uses the latest fact on or before that month's end (prices, snapshots,
 * valuations, balances); assets with trades but no price yet are carried at
 * cost basis.
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

  // Pull everything once; derive per month in JS (household scale).
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
              sold_lot_trade_id, acquired_on, basis_cents FROM trades ORDER BY traded_on`,
    )
    .all() as ({ invest_account_id: number; asset_id: number } & TradeInput)[]
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

  const latestAtOrBefore = <T extends { [k: string]: unknown }>(
    rows: T[],
    dateKey: keyof T,
    cutoff: string,
  ): T | undefined => {
    let best: T | undefined
    for (const r of rows) {
      if ((r[dateKey] as string) <= cutoff) best = r
      else break
    }
    return best
  }

  return months.map((month) => {
    const cutoff = monthEnd(month)
    const c: NetWorthComponents = { cash: 0, brokerage: 0, retirement: 0, crypto: 0, property: 0, liabilities: 0 }

    for (const a of accounts) {
      c.cash += a.opening_cents
      for (const t of txs) if (t.account_id === a.id && t.posted_on <= cutoff) c.cash += t.amount_cents
    }

    for (const ia of investAccounts) {
      let value = 0
      if (ia.tracking === 'balance') {
        value =
          latestAtOrBefore(
            snaps.filter((s) => s.invest_account_id === ia.id),
            'balanced_on',
            cutoff,
          )?.balance_cents ?? 0
      } else {
        const byAsset = new Map<number, TradeInput[]>()
        for (const t of trades)
          if (t.invest_account_id === ia.id && t.traded_on <= cutoff) {
            const list = byAsset.get(t.asset_id) ?? []
            list.push(t)
            byAsset.set(t.asset_id, list)
          }
        for (const [assetId, assetTrades] of byAsset) {
          const pos = computePosition(assetTrades, today)
          if (pos.qty_micro === 0) continue
          const price = latestAtOrBefore(
            prices.filter((p) => p.asset_id === assetId),
            'priced_on',
            cutoff,
          )
          value += price ? positionValueCents(pos.qty_micro, price.close_cents) : pos.cost_cents
        }
      }
      c[ia.kind] += value
    }

    for (const p of props) {
      const val = latestAtOrBefore(
        vals.filter((v) => v.property_id === p.id),
        'valued_on',
        cutoff,
      )
      if (val) c.property += val.value_cents
      else if (p.purchased_on && p.purchased_on <= cutoff && p.purchase_cents) c.property += p.purchase_cents
    }

    const liabIds = [...new Set(liabs.map((l) => l.liability_id))]
    for (const id of liabIds) {
      const bal = latestAtOrBefore(
        liabs.filter((l) => l.liability_id === id),
        'balanced_on',
        cutoff,
      )
      if (bal) c.liabilities -= bal.balance_cents
    }

    return { month, ...c, total: sum(c) }
  })
}
