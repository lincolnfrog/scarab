import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { cashAt, cashEffectCents, loadHoldings, type CashTrade } from './holdings'
import { onBothEngines } from './test/parity'

const TODAY = '2026-09-22'
const mem = () => openDb(':memory:') as unknown as DbLike

/**
 * Raw inserts rather than the services, so these tests pin loadHoldings alone
 * and keep passing as trade validation tightens.
 */
function trade(
  db: DbLike,
  accountId: number,
  symbol: string,
  side: 'buy' | 'sell',
  tradedOn: string,
  qtyMicro: number,
  totalCents: number,
  o: { kind?: 'stock' | 'crypto'; note?: string } = {},
) {
  db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING').run(symbol, o.kind ?? 'stock')
  const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(symbol) as { id: number }
  db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(accountId, asset.id, tradedOn, side, qtyMicro, totalCents, o.note ?? null)
}

/** VTI held in a taxable account and a Roth, plus QQQ, bitcoin, a balance-tracked 401(k) and a future-dated buy. */
function household(db: DbLike) {
  const account = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  account.run('Taxable', 'brokerage', 'lots') // 1
  account.run('Roth IRA', 'retirement', 'lots') // 2
  account.run('401(k)', 'retirement', 'balance') // 3
  account.run('Coinbase', 'crypto', 'lots') // 4
  trade(db, 1, 'VTI', 'buy', '2020-03-02', 10_000_000, 150_000) // asset 1
  trade(db, 2, 'VTI', 'buy', '2026-01-05', 10_000_000, 300_000)
  trade(db, 2, 'VTI', 'sell', '2026-06-01', 10_000_000, 320_000)
  trade(db, 1, 'QQQ', 'buy', '2025-02-03', 5_000_000, 250_000, { note: 'RSU vest' }) // asset 2
  trade(db, 4, 'BTC', 'buy', '2024-01-10', 500_000, 2_000_000, { kind: 'crypto' }) // asset 3
  trade(db, 1, 'VTI', 'buy', '2026-10-01', 1_000_000, 30_000) // after TODAY
  // A balance-tracked account can't record trades through the services; one
  // slipped in anyway (an old import, a hand edit) must still stay out.
  trade(db, 3, 'VTI', 'buy', '2025-05-05', 1_000_000, 25_000)
}

const seeded = () => {
  const db = mem()
  household(db)
  return db
}
const keys = (rows: ReturnType<typeof loadHoldings>) => rows.map((h) => `${h.accountName}:${h.symbol}`)

describe('loadHoldings', () => {
  it('pools lots per account, not per symbol', () => {
    const rows = loadHoldings(seeded(), TODAY)
    expect(keys(rows)).toEqual(['Taxable:VTI', 'Taxable:QQQ', 'Roth IRA:VTI', 'Coinbase:BTC'])

    // The Roth's sell consumes the Roth's own 2026 lot. Pooled by symbol it
    // would have FIFO'd the taxable 2020 lot and booked a long-term gain.
    const [taxableVti, , rothVti] = rows
    expect(taxableVti!.pos.lots).toEqual([{ trade_id: 1, opened_on: '2020-03-02', qty_micro: 10_000_000, cost_cents: 150_000 }])
    expect(taxableVti!.pos.realized_lt_cents).toBe(0)
    expect(rothVti!.pos.qty_micro).toBe(0)
    expect(rothVti!.pos.realized_ytd_st_cents).toBe(20_000)
    expect(rothVti!.pos.realized_lt_cents).toBe(0)
  })

  it('describes each row: account, shelter, asset and its trades oldest first', () => {
    const rows = loadHoldings(seeded(), TODAY)
    const roth = rows.find((h) => h.accountName === 'Roth IRA')!
    expect(roth).toMatchObject({
      investAccountId: 2,
      accountKind: 'retirement',
      sheltered: true,
      assetId: 1,
      symbol: 'VTI',
      assetKind: 'stock',
    })
    expect(roth.trades.map((t) => [t.id, t.side, t.traded_on])).toEqual([
      [2, 'buy', '2026-01-05'],
      [3, 'sell', '2026-06-01'],
    ])
    const btc = rows.find((h) => h.symbol === 'BTC')!
    expect(btc).toMatchObject({ accountKind: 'crypto', sheltered: false, assetKind: 'crypto' })
    const qqq = rows.find((h) => h.symbol === 'QQQ')!
    expect(qqq.trades[0]).toEqual({
      id: 4,
      traded_on: '2025-02-03',
      side: 'buy',
      qty_micro: 5_000_000,
      total_cents: 250_000,
      sold_lot_trade_id: null,
      acquired_on: null,
      basis_cents: null,
      note: 'RSU vest',
    })
  })

  it('excludes trades dated after asOf, and computes each position as of that day', () => {
    const db = seeded()
    // Default asOf is today: the October buy isn't held yet.
    expect(loadHoldings(db, TODAY)[0]!.pos.qty_micro).toBe(10_000_000)
    expect(loadHoldings(db, TODAY, { asOf: '2026-12-31' })[0]!.pos.qty_micro).toBe(11_000_000)

    // Before the Roth's first trade it has no row at all.
    const endOf2025 = loadHoldings(db, TODAY, { asOf: '2025-12-31' })
    expect(keys(endOf2025)).toEqual(['Taxable:VTI', 'Taxable:QQQ', 'Coinbase:BTC'])

    // Mid-year the Roth still holds its lot; the sale hasn't happened yet.
    const may = loadHoldings(db, TODAY, { asOf: '2026-05-31' }).find((h) => h.accountName === 'Roth IRA')!
    expect(may.pos.qty_micro).toBe(10_000_000)
    expect(may.pos.realized_st_cents).toBe(0)
    expect(may.trades).toHaveLength(1)
  })

  it('taxableOnly drops sheltered accounts and keeps crypto', () => {
    expect(keys(loadHoldings(seeded(), TODAY, { taxableOnly: true }))).toEqual(['Taxable:VTI', 'Taxable:QQQ', 'Coinbase:BTC'])
  })

  it('narrows to one account or one asset', () => {
    const db = seeded()
    expect(keys(loadHoldings(db, TODAY, { accountId: 1 }))).toEqual(['Taxable:VTI', 'Taxable:QQQ'])
    expect(keys(loadHoldings(db, TODAY, { assetId: 1 }))).toEqual(['Taxable:VTI', 'Roth IRA:VTI'])
    expect(keys(loadHoldings(db, TODAY, { accountId: 2, assetId: 1, taxableOnly: true }))).toEqual([])
  })

  it('is empty for a household with no trades', () => {
    expect(loadHoldings(mem(), TODAY)).toEqual([])
  })

  it('is identical on better-sqlite3 and sql.js', async () => {
    const all = await onBothEngines(household, (db) => loadHoldings(db, TODAY))
    expect(all.browser).toEqual(all.server)
    expect(all.server).toHaveLength(4)
    const past = await onBothEngines(household, (db) => loadHoldings(db, TODAY, { asOf: '2026-05-31', taxableOnly: true }))
    expect(past.browser).toEqual(past.server)
  })
})

/* ---------- B12 · the cash anchor ---------- */

describe('a brokerage account’s cash: the latest anchor plus what later trades did to it', () => {
  const t = (traded_on: string, side: 'buy' | 'sell', total_cents: number, o: Partial<CashTrade> = {}): CashTrade => ({
    traded_on,
    side,
    total_cents,
    note: null,
    acquired_on: null,
    ...o,
  })

  it('what each trade does to cash: buys spend, sales bring in — except trades no cash changed hands for', () => {
    expect(cashEffectCents(t('2026-09-01', 'buy', 1_000_00))).toBe(-1_000_00)
    expect(cashEffectCents(t('2026-09-01', 'sell', 600_00))).toBe(600_00)
    expect(cashEffectCents(t('2026-09-01', 'sell', 600_00, { acquired_on: '2019-01-02' }))).toBe(600_00) // explicit basis: proceeds still land
    expect(cashEffectCents(t('2026-09-01', 'buy', 1_000_00, { note: 'RSU vest' }))).toBe(0) // pay, not a purchase
    expect(cashEffectCents(t('2026-09-01', 'buy', 1_000_00, { note: 'Opening position' }))).toBe(0) // booked, not bought
    expect(cashEffectCents(t('2026-09-01', 'buy', 1_000_00, { acquired_on: '2024-05-01' }))).toBe(0) // a transfer in, booked late
    expect(cashEffectCents(t('2026-09-01', 'buy', 1_000_00, { acquired_on: '2026-09-01' }))).toBe(-1_000_00) // same day: bought
    expect(cashEffectCents(t('2026-09-01', 'sell', 360_00, { note: 'RSU withholding' }))).toBe(0) // paid the tax, never landed
  })

  it('no anchor on or before the day: no cash at all', () => {
    expect(cashAt([], [t('2026-09-02', 'sell', 100_00)], '2026-09-30')).toBeNull()
    expect(cashAt([{ balanced_on: '2026-10-01', balance_cents: 5_00 }], [], '2026-09-30')).toBeNull()
  })

  it("an anchor is the end of its day: that day's trades are in it; later ones move it, up to the day asked about", () => {
    const anchors = [
      { balanced_on: '2026-06-30', balance_cents: 1_000_00 },
      { balanced_on: '2026-08-31', balance_cents: 2_500_00 },
    ]
    const trades = [
      t('2026-06-30', 'buy', 400_00), // already in the June anchor
      t('2026-07-10', 'sell', 300_00),
      t('2026-07-20', 'buy', 50_00),
      t('2026-07-21', 'buy', 999_00, { note: 'RSU vest' }), // moves nothing, isn't counted
      t('2026-09-02', 'buy', 700_00),
      t('2026-09-25', 'sell', 10_00), // after the day asked about
    ]
    expect(cashAt(anchors, trades, '2026-06-30')).toEqual({ cents: 1_000_00, as_of: '2026-06-30', anchor_cents: 1_000_00, trades: 0 })
    expect(cashAt(anchors, trades, '2026-07-99')).toEqual({ cents: 1_250_00, as_of: '2026-06-30', anchor_cents: 1_000_00, trades: 2 })
    // A newer anchor re-bases: deposits Scarab never saw are in it.
    expect(cashAt(anchors, trades, '2026-09-22')).toEqual({ cents: 1_800_00, as_of: '2026-08-31', anchor_cents: 2_500_00, trades: 1 })
    // Unsorted anchors are fine.
    expect(cashAt([...anchors].reverse(), trades, '2026-09-22')?.cents).toBe(1_800_00)
  })
})
