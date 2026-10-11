import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { deleteInvestAccount, deleteTrade, listAssets, listInvestAccounts, updateInvestAccount } from './invest'
import { createPlannedSale, deletePlannedSale, listPlannedSales, plannedSaleGains, updatePlannedSale } from './planned-sales'
import { dumpDb, loadDump } from './snapshot'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const BTC = (n: number) => n * 1_000_000
const today = '2026-10-11'

/**
 * Coinbase (1, lots, taxable) holds 15 BTC in two lots: 10 from 2017 at $3,500
 * each and 5 from March 2026 at $90,000 each; a Roth (2) holds some too; Flex
 * 250 (3) is tracked by balance. BTC last quoted at $80,000.
 */
function household() {
  const db = mem()
  const acct = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  acct.run('Coinbase', 'crypto', 'lots')
  acct.run('Roth IRA', 'retirement', 'lots')
  acct.run('Flex 250', 'brokerage', 'balance')
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('BTC', 'crypto')").run() // 1
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ETH', 'crypto')").run() // 2
  const t = db.prepare('INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, 1, ?, ?, ?, ?)')
  t.run(1, '2017-06-06', 'buy', BTC(10), $(35_000)) // 1
  t.run(1, '2026-03-01', 'buy', BTC(5), $(450_000)) // 2
  t.run(2, '2024-01-10', 'buy', BTC(1), $(40_000)) // 3
  db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-10-01', ?)").run($(80_000))
  return db
}
const sale = (db: DbLike, b: Record<string, unknown>) => createPlannedSale(db, { investAccountId: 1, assetId: 1, ...b }, today)

describe('planned sales: what can be planned', () => {
  it('plans a sale of a holding, priced at the latest quote unless a price is typed', () => {
    const db = household()
    const r = sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(8), note: ' January ' })
    expect(r.row).toMatchObject({ account: 'Coinbase', symbol: 'BTC', asset_kind: 'crypto', planned_on: '2027-01-05', qty_micro: BTC(8), price_cents: null, note: 'January' })
    const g = plannedSaleGains(db, today)[0]!
    // 8 BTC × $80,000, FIFO out of the 2017 lot: basis 8 × $3,500, long-term.
    expect(g).toMatchObject({ price_used_cents: $(80_000), price_source: 'quote', priced_on: '2026-10-01', proceeds_cents: $(640_000), cost_cents: $(28_000), st_cents: 0, lt_cents: $(612_000), warnings: [] })
    expect(listInvestAccounts(db)[0]!.counts.planned).toBe(1)
  })

  it('a second plan takes the lots the first leaves, in planned order whatever the order typed', () => {
    const db = household()
    // Typed second but dated first: it gets the 2017 lot.
    const later = sale(db, { plannedOn: '2027-01-06', qtyMicro: BTC(7), priceCents: $(100_000) })
    const earlier = sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(8) })
    const gains = plannedSaleGains(db, today)
    expect(gains.map((g) => g.id)).toEqual([earlier.row.id, later.row.id])
    expect(gains[0]).toMatchObject({ proceeds_cents: $(640_000), cost_cents: $(28_000), lt_cents: $(612_000), st_cents: 0 })
    // 7 BTC at the typed $100,000: the last 2 of the 2017 lot (long-term) and the 5 bought in March 2026 (short-term by Jan 2027).
    expect(gains[1]).toMatchObject({
      price_used_cents: $(100_000),
      price_source: 'typed',
      priced_on: null,
      proceeds_cents: $(700_000),
      cost_cents: $(7_000) + $(450_000),
      lt_cents: $(200_000) - $(7_000),
      st_cents: $(500_000) - $(450_000),
    })
    // Nothing is left to plan.
    expect(() => sale(db, { plannedOn: '2027-02-01', qtyMicro: BTC(1) })).toThrow(/15 of it already planned — this would sell 1 more than it holds/)
  })

  it('refuses more than is held, a past day, a sheltered or balance account, an unheld asset and bad numbers', () => {
    const db = household()
    expect(() => sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(25) })).toThrow(/holds 15 BTC today — this would sell 10 more/)
    expect(() => sale(db, { plannedOn: today, qtyMicro: BTC(1) })).toThrow(/dated after today/)
    expect(() => sale(db, { plannedOn: '2060-01-01', qtyMicro: BTC(1) })).toThrow(/within 30 years/)
    expect(() => sale(db, { plannedOn: '2027-02-29', qtyMicro: BTC(1) })).toThrow(/real yyyy-mm-dd/)
    expect(() => sale(db, { investAccountId: 2, plannedOn: '2027-01-05', qtyMicro: BTC(1) })).toThrow(/never taxed/)
    expect(() => sale(db, { investAccountId: 3, plannedOn: '2027-01-05', qtyMicro: BTC(1) })).toThrow(/tracked by balance/)
    expect(() => sale(db, { assetId: 2, plannedOn: '2027-01-05', qtyMicro: BTC(1) })).toThrow(/holds no ETH today/)
    expect(() => sale(db, { assetId: 9, plannedOn: '2027-01-05', qtyMicro: BTC(1) })).toThrow(/no such asset/)
    expect(() => sale(db, { investAccountId: 9, plannedOn: '2027-01-05', qtyMicro: BTC(1) })).toThrow(/no such investment account/)
    expect(() => sale(db, { plannedOn: '2027-01-05', qtyMicro: 0 })).toThrow(/above zero/)
    expect(() => sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(1), priceCents: 0 })).toThrow(/priceCents/)
    expect(() => deletePlannedSale(db, 1)).toThrow(/no such planned sale/)
  })

  it('changes a plan whole — the same plan again writes nothing — and deletes it', () => {
    const db = household()
    const { row } = sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(8) })
    const same = { investAccountId: 1, assetId: 1, plannedOn: '2027-01-05', qtyMicro: BTC(8) }
    expect(updatePlannedSale(db, row.id, same, today).changed).toBe(false)
    const u = updatePlannedSale(db, row.id, { ...same, qtyMicro: BTC(15), priceCents: $(90_000) }, today)
    expect(u).toMatchObject({ changed: true, row: { qty_micro: BTC(15), price_cents: $(90_000) } })
    // Its own shares don't count against it when it grows.
    expect(() => updatePlannedSale(db, row.id, { ...same, qtyMicro: BTC(16) }, today)).toThrow(/1 more than it holds/)
    expect(deletePlannedSale(db, row.id).removed.id).toBe(row.id)
    expect(listPlannedSales(db)).toEqual([])
  })

  it('warns, never fails, when the holdings shrink under a plan — and the asset stays on the books', () => {
    const db = household()
    sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(12) })
    deleteTrade(db, 2) // the March lot goes: only 10 BTC remain
    const g = plannedSaleGains(db, today)[0]!
    expect(g.warnings.join(' ')).toMatch(/holds only 10 BTC for this sale — 2 count with zero basis/)
    expect(g).toMatchObject({ proceeds_cents: $(960_000), cost_cents: $(35_000), lt_cents: $(800_000) - $(35_000), st_cents: $(160_000) })
    deleteTrade(db, 1)
    deleteTrade(db, 3)
    // No trade names BTC any more, but a plan does: the asset (and its price) are kept.
    expect(listAssets(db).map((a) => a.symbol)).toContain('BTC')
    expect(plannedSaleGains(db, today)[0]!.warnings.join(' ')).toMatch(/holds only 0 BTC/)
  })

  it('says so when no price is on file', () => {
    const db = household()
    db.prepare('DELETE FROM prices').run()
    sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(1) })
    const g = plannedSaleGains(db, today)[0]!
    expect(g).toMatchObject({ price_used_cents: null, price_source: 'none', proceeds_cents: 0, lt_cents: -$(3_500) })
    expect(g.warnings[0]).toMatch(/No price on file for BTC/)
  })

  it('keeps the account’s tracking, goes with the account, and survives a snapshot round trip', () => {
    const db = household()
    sale(db, { plannedOn: '2027-01-05', qtyMicro: BTC(1) })
    const dump = dumpDb(db)
    // Even with its trades gone, a plan still ties the account to lots.
    deleteTrade(db, 1)
    deleteTrade(db, 2)
    expect(() => updateInvestAccount(db, 1, { tracking: 'balance' })).toThrow(/1 planned sale/)
    const other = mem()
    loadDump(other, dump)
    expect(listPlannedSales(other)).toEqual(listPlannedSales(db))
    expect(deleteInvestAccount(db, 1).removed.planned).toBe(1)
    expect(listPlannedSales(db)).toEqual([])
  })
})
