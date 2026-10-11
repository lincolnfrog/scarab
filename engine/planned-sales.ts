import { isRealIsoDay } from '../shared/dates'
import type { PlannedSaleBody, PlannedSaleRow } from '../shared/invest-api'
import { formatQtyMicro } from '../shared/money'
import type { DbLike } from './db'
import { bad, notFound } from './errors'
import { ALL_TIME, holdingLedger, loadHoldings } from './holdings'
import { computePosition, positionValueCents, saleRealized, type TradeInput } from './lots'

/**
 * Planned sales (migration 28): a sale not yet made — this many shares of a
 * holding in a lots account, on a day ahead, at a typed price or the latest
 * quote when read. The plan the capacity view (engine/capacity.ts) nets
 * against the losses expected by then: "25 BTC in January" priced off the
 * real lots.
 *
 * The gain is derived, never stored: `plannedSaleGains` replays the account's
 * ledger with the planned sales appended in date order, so a second sale of
 * the same holding takes the lots the first one leaves (FIFO), and long-term
 * is judged by the planned day. A plan can't sell more than the account holds
 * today; should the holdings shrink later, the read warns instead of failing.
 * Only a taxable lots account takes one — a sale inside a retirement account
 * is never taxed, and a balance account has no lots to plan from.
 */

/** A plan further out than this is not a plan. */
export const PLAN_HORIZON_YEARS = 30
const MAX_CENTS = 100_000_000_000_00
const MAX_NOTE = 120
/** Synthetic trade ids for the replay: past every real id, in planned order. */
const PLAN_ID_BASE = 1_000_000_000

const SELECT = `SELECT p.id, p.invest_account_id, ia.name AS account, p.asset_id, a.symbol, a.kind AS asset_kind, p.planned_on, p.qty_micro, p.price_cents, p.note
  FROM planned_sales p JOIN invest_accounts ia ON ia.id = p.invest_account_id JOIN assets a ON a.id = p.asset_id`

/** Every planned sale, or one account's — soonest first. */
export function listPlannedSales(db: DbLike, f: { accountId?: number } = {}): PlannedSaleRow[] {
  return (
    f.accountId === undefined
      ? db.prepare(`${SELECT} ORDER BY p.planned_on, p.id`).all()
      : db.prepare(`${SELECT} WHERE p.invest_account_id = ? ORDER BY p.planned_on, p.id`).all(f.accountId)
  ) as PlannedSaleRow[]
}

function one(db: DbLike, id: number): PlannedSaleRow {
  const r = (Number.isSafeInteger(id) && id > 0 ? db.prepare(`${SELECT} WHERE p.id = ?`).get(id) : undefined) as PlannedSaleRow | undefined
  if (!r) notFound('no such planned sale')
  return r!
}

type Valid = { investAccountId: number; assetId: number; plannedOn: string; qtyMicro: number; priceCents: number | null; note: string | null }

function validate(db: DbLike, b: Partial<Record<keyof PlannedSaleBody, unknown>>, today: string, exceptId: number | null): Valid {
  const aid = b.investAccountId
  const acct = (Number.isSafeInteger(aid) && (aid as number) > 0
    ? db.prepare('SELECT id, name, kind, tracking FROM invest_accounts WHERE id = ?').get(aid)
    : undefined) as { id: number; name: string; kind: string; tracking: string } | undefined
  if (!acct) notFound('no such investment account')
  if (acct!.tracking !== 'balance' && acct!.kind === 'retirement') bad(`a sale inside ${acct!.name} is never taxed — nothing to plan for`)
  if (acct!.tracking !== 'lots')
    bad(`${acct!.name} is tracked by balance — Scarab holds no lots there to plan a sale from; what its manager expects to realize goes in its harvest forecast`)
  const sid = b.assetId
  const asset = (Number.isSafeInteger(sid) && (sid as number) > 0 ? db.prepare('SELECT id, symbol FROM assets WHERE id = ?').get(sid) : undefined) as
    | { id: number; symbol: string }
    | undefined
  if (!asset) notFound('no such asset')
  const on = b.plannedOn
  if (typeof on !== 'string' || !isRealIsoDay(on)) bad('plannedOn must be a real yyyy-mm-dd day')
  if ((on as string) <= today) bad(`a planned sale is dated after today (${today}) — a sale that has happened is recorded as a trade`)
  const far = `${Number(today.slice(0, 4)) + PLAN_HORIZON_YEARS}${today.slice(4)}`
  if ((on as string) > far) bad(`plannedOn must be within ${PLAN_HORIZON_YEARS} years`)
  const qty = b.qtyMicro
  if (!Number.isSafeInteger(qty) || (qty as number) <= 0) bad('qtyMicro must be a whole number of micro-shares above zero')
  const held = loadHoldings(db, today, { accountId: acct!.id, assetId: asset!.id })[0]?.pos.qty_micro ?? 0
  if (held <= 0) bad(`${acct!.name} holds no ${asset!.symbol} today — a plan sells what is held`)
  const others = (
    db
      .prepare('SELECT COALESCE(SUM(qty_micro), 0) AS q FROM planned_sales WHERE invest_account_id = ? AND asset_id = ? AND id IS NOT ?')
      .get(acct!.id, asset!.id, exceptId) as { q: number }
  ).q
  if (others + (qty as number) > held)
    bad(
      `${acct!.name} holds ${formatQtyMicro(held)} ${asset!.symbol} today${others > 0 ? `, ${formatQtyMicro(others)} of it already planned` : ''} — this would sell ${formatQtyMicro(others + (qty as number) - held)} more than it holds`,
    )
  let price: number | null = null
  if (b.priceCents !== undefined && b.priceCents !== null) {
    if (!Number.isSafeInteger(b.priceCents) || (b.priceCents as number) <= 0 || (b.priceCents as number) > MAX_CENTS)
      bad('priceCents must be a whole number of cents above zero, or left out for the latest quote')
    price = b.priceCents as number
  }
  let note: string | null = null
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') bad('note must be text')
    note = (b.note as string).trim().slice(0, MAX_NOTE) || null
  }
  return { investAccountId: acct!.id, assetId: asset!.id, plannedOn: on as string, qtyMicro: qty as number, priceCents: price, note }
}

export function createPlannedSale(db: DbLike, b: Partial<Record<keyof PlannedSaleBody, unknown>>, today: string) {
  const v = validate(db, b, today, null)
  const r = db
    .prepare('INSERT INTO planned_sales (invest_account_id, asset_id, planned_on, qty_micro, price_cents, note) VALUES (?, ?, ?, ?, ?, ?)')
    .run(v.investAccountId, v.assetId, v.plannedOn, v.qtyMicro, v.priceCents, v.note)
  return { ok: true as const, row: one(db, Number(r.lastInsertRowid)) }
}

/** Change a plan: any field, the whole body sent. The same plan again writes nothing. */
export function updatePlannedSale(db: DbLike, id: number, b: Partial<Record<keyof PlannedSaleBody, unknown>>, today: string) {
  const cur = one(db, id)
  const v = validate(db, b, today, id)
  const changed =
    v.investAccountId !== cur.invest_account_id ||
    v.assetId !== cur.asset_id ||
    v.plannedOn !== cur.planned_on ||
    v.qtyMicro !== cur.qty_micro ||
    v.priceCents !== cur.price_cents ||
    v.note !== cur.note
  if (changed)
    db.prepare('UPDATE planned_sales SET invest_account_id = ?, asset_id = ?, planned_on = ?, qty_micro = ?, price_cents = ?, note = ? WHERE id = ?').run(
      v.investAccountId,
      v.assetId,
      v.plannedOn,
      v.qtyMicro,
      v.priceCents,
      v.note,
      id,
    )
  return { ok: true as const, changed, row: one(db, id) }
}

export function deletePlannedSale(db: DbLike, id: number) {
  const row = one(db, id)
  db.prepare('DELETE FROM planned_sales WHERE id = ?').run(id)
  return { ok: true as const, removed: row }
}

/* ---------- what the plan realizes ---------- */

/** A planned sale with its gain as the lots stand today. */
export type PlannedGain = PlannedSaleRow & {
  /** The price the proceeds use: the typed one, the latest quote, or none on file. */
  price_used_cents: number | null
  price_source: 'typed' | 'quote' | 'none'
  priced_on: string | null
  proceeds_cents: number
  cost_cents: number
  st_cents: number
  lt_cents: number
  warnings: string[]
}

/**
 * Every planned sale priced and resolved against its account's lots, in
 * planned order: the ledger with the plans appended, replayed through the
 * lot engine, so FIFO and the holding period come out exactly as a recorded
 * sale's would on that day. Proceeds use the typed price, else the latest
 * quote (and warn when there is none). Shares the account no longer holds by
 * then count with zero basis, short-term, with a warning — never silently.
 */
export function plannedSaleGains(db: DbLike, today: string, f: { accountId?: number } = {}): PlannedGain[] {
  const rows = listPlannedSales(db, f)
  if (rows.length === 0) return []
  const latest = db.prepare('SELECT close_cents, priced_on FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1')
  const groups = new Map<string, PlannedSaleRow[]>()
  for (const r of rows) {
    const k = `${r.invest_account_id}:${r.asset_id}`
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const out = new Map<number, PlannedGain>()
  for (const g of groups.values()) {
    const first = g[0]!
    const quote = latest.get(first.asset_id) as { close_cents: number; priced_on: string } | undefined
    const ledger = holdingLedger(db, first.invest_account_id, first.asset_id)
    const priced = g.map((r, k) => {
      const price = r.price_cents ?? quote?.close_cents ?? null
      const synthetic: TradeInput = {
        id: PLAN_ID_BASE + k,
        traded_on: r.planned_on,
        side: 'sell',
        qty_micro: r.qty_micro,
        total_cents: price === null ? 0 : positionValueCents(r.qty_micro, price),
      }
      return { r, price, synthetic }
    })
    const pos = computePosition([...ledger, ...priced.map((p) => p.synthetic)], ALL_TIME)
    for (const { r, price, synthetic } of priced) {
      const sale = pos.sales.find((s) => s.trade_id === synthetic.id)!
      const realized = saleRealized(sale)
      const warnings: string[] = []
      if (price === null) warnings.push(`No price on file for ${r.symbol} — type one here, or refresh quotes.`)
      if (sale.zero_basis_qty_micro > 0)
        warnings.push(
          `${r.account} holds only ${formatQtyMicro(r.qty_micro - sale.zero_basis_qty_micro)} ${r.symbol} for this sale — ${formatQtyMicro(sale.zero_basis_qty_micro)} ${sale.zero_basis_qty_micro === 1_000_000 ? 'counts' : 'count'} with zero basis (short-term).`,
        )
      out.set(r.id, {
        ...r,
        price_used_cents: price,
        price_source: r.price_cents !== null ? 'typed' : quote ? 'quote' : 'none',
        priced_on: r.price_cents !== null ? null : (quote?.priced_on ?? null),
        proceeds_cents: synthetic.total_cents,
        cost_cents: sale.parts.reduce((s, p) => s + p.cost_cents, 0),
        st_cents: realized.st_cents,
        lt_cents: realized.lt_cents,
        warnings,
      })
    }
  }
  return rows.map((r) => out.get(r.id)!)
}
