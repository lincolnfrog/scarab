import { dayNumber, xirr, type Flow } from '../shared/perf'
import type { PortfolioLot } from '../shared/invest-api'
import type { HoldingReturn, ReturnsResponse } from '../shared/series-api'
import type { DbLike } from './db'
import { getPortfolio, OPENING_NOTE } from './invest'
import { positionValueCents } from './lots'

/**
 * Return by holding (GET /api/portfolio/returns): how the money in each open
 * position has done, money-weighted, from the ledger and today's price alone —
 * no price history needed, so it works in a zero-knowledge tab from the first
 * refresh.
 *
 * For each symbol the cash flows are what its open lots cost, on the day each
 * lot opened, against what they are worth today. Sold lots are out (their
 * gains are realized and belong to the tax picture), so this is the return on
 * what is still held. Values and costs are the portfolio's own
 * (getPortfolio), so the rows sum to its totals to the cent.
 *
 * A starting position pasted without its acquisition date (an 'Opening
 * position' buy with no acquired_on) opens on its as-of day but carries a cost
 * paid at some unknown earlier time: as a purchase on the as-of day it would
 * read as a windfall. So it enters at its market value that day instead — a
 * close at most ENTRY_PRICE_MAX_DAYS old (any quote for one booked today) —
 * and a holding with such a lot and no such close gets no rate. With its true
 * acquisition date, a lot's historical cost on that date is a real flow.
 *
 * `held_days` runs from the oldest open lot to today. A holding held a year or
 * more gets an annualized rate (`annualized: true`); a younger one gets its
 * money-weighted return over the whole holding period instead, because
 * annualizing a few weeks turns a 5% move into a four-digit percentage.
 *
 * Unpriced holdings are carried at cost (as the portfolio carries them), with
 * `priced: false` and no rate. The totals' rate covers the holdings that have
 * one, so a position with no quote yet doesn't drag it toward zero.
 */
export function getHoldingsReturns(db: DbLike, today: string): ReturnsResponse {
  const { positions, totals } = getPortfolio(db, today)
  const todayN = dayNumber(today)
  const entry = entryFlows(db, today)

  const rated: { lots: Flow[]; value: number }[] = [] // the holdings the totals' rate covers
  const rows: HoldingReturn[] = positions.map((p) => {
    const priced = p.price_cents != null
    const first = Math.min(...p.lots.map((l) => dayNumber(l.opened_on)))
    const heldDays = p.lots.length === 0 ? 0 : Math.max(0, todayN - first)
    const lots = priced ? entry(p.asset_id, p.lots) : null
    if (lots && p.lots.length > 0) rated.push({ lots, value: p.value_cents })
    const rate = lots ? moneyWeighted(lots, todayN, heldDays, p.value_cents) : { irr: null, annualized: false }
    return {
      asset_id: p.asset_id,
      symbol: p.symbol,
      value_cents: p.value_cents,
      cost_cents: p.cost_cents,
      unrealized_cents: p.unrealized_cents,
      unrealized_micro: priced ? ratioMicro(p.unrealized_cents, p.cost_cents) : null,
      irr_micro: rate.irr,
      annualized: rate.annualized,
      held_days: heldDays,
      weight_micro: ratioMicro(p.value_cents, totals.value) ?? 0,
      priced,
    }
  })

  const lots = rated.flatMap((r) => r.lots)
  const value = rated.reduce((s, r) => s + r.value, 0)
  const firstDay = lots.length === 0 ? null : Math.min(...lots.map((f) => f.day))
  const total = firstDay === null ? { irr: null, annualized: false } : moneyWeighted(lots, todayN, Math.max(0, todayN - firstDay), value)

  return {
    as_of: today,
    rows,
    totals: {
      value_cents: totals.value,
      cost_cents: totals.cost,
      unrealized_cents: totals.unrealized,
      irr_micro: total.irr,
      annualized: total.annualized,
    },
  }
}

/** How old a close may be and still price a starting position on its as-of day (as engine/analytics.ts :twr does). */
const ENTRY_PRICE_MAX_DAYS = 7

/**
 * Each open lot as the money put in (negative cents, on the day it opened):
 * its cost, or, for a starting position with no acquisition date, its market
 * value on the as-of day. null when such a lot has no close to price it.
 */
function entryFlows(db: DbLike, today: string): (assetId: number, lots: PortfolioLot[]) => Flow[] | null {
  const booked = new Set(
    (
      db.prepare("SELECT id FROM trades WHERE side = 'buy' AND note = ? AND acquired_on IS NULL").all(OPENING_NOTE) as { id: number }[]
    ).map((t) => t.id),
  )
  const closeOn = db.prepare(
    'SELECT priced_on AS "on", close_cents AS cents FROM prices WHERE asset_id = ? AND priced_on <= ? ORDER BY priced_on DESC LIMIT 1',
  )
  return (assetId, lots) => {
    const out: Flow[] = []
    for (const l of lots) {
      const day = dayNumber(l.opened_on)
      if (l.trade_id === null || !booked.has(l.trade_id)) {
        out.push({ day, cents: -l.cost_cents })
        continue
      }
      // Booked today: today's price, whatever its stamp (a quote can carry tomorrow's UTC date).
      const close = closeOn.get(assetId, l.opened_on >= today ? '9999-99-99' : l.opened_on) as { on: string; cents: number } | undefined
      if (!close || (l.opened_on < today && day - dayNumber(close.on) > ENTRY_PRICE_MAX_DAYS)) return null
      out.push({ day, cents: -positionValueCents(l.qty_micro, close.cents) })
    }
    return out
  }
}

/**
 * The rate for one set of entry flows against today's value: annual once held
 * 365 days, otherwise over the holding period itself. Everything put in today
 * has no period to discount over, so its return is simply value against what
 * went in.
 */
function moneyWeighted(lots: Flow[], todayN: number, heldDays: number, value: number): { irr: number | null; annualized: boolean } {
  const flows = [...lots, { day: todayN, cents: value }]
  if (heldDays >= 365) {
    const irr = xirr(flows)
    return { irr, annualized: irr !== null }
  }
  if (heldDays === 0) {
    const invested = -lots.reduce((s, f) => s + f.cents, 0)
    return { irr: ratioMicro(value - invested, invested), annualized: false }
  }
  return { irr: xirr(flows, { basisDays: heldDays }), annualized: false }
}

/** a / b as integer micro; null when b is not positive. */
function ratioMicro(a: number, b: number): number | null {
  if (!(b > 0)) return null
  return Math.round((a / b) * 1_000_000) + 0
}
