import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import {
  createInvestAccount,
  createTrade,
  deleteInvestAccount,
  listInvestAccounts,
  putBalanceSnapshot,
  putUnvested,
  updateInvestAccount,
} from './services'

const mem = () => openDb(':memory:') as unknown as DbLike
const count = (db: DbLike, t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

describe('employee stock plans are opt-in', () => {
  it('defaults off, and only a lot-tracked account can hold one', () => {
    const db = mem()
    const plain = createInvestAccount(db, { name: 'Broker', kind: 'brokerage', tracking: 'lots' })
    expect(plain.stock_plan).toBe(0)
    expect(listInvestAccounts(db)[0]).toMatchObject({ name: 'Broker', stock_plan: 0 })

    const plan = createInvestAccount(db, { name: 'Broker — RSUs', kind: 'brokerage', tracking: 'lots', stockPlan: true })
    expect(plan.stock_plan).toBe(1)

    expect(() =>
      createInvestAccount(db, { name: '401k', kind: 'retirement', tracking: 'balance', stockPlan: true }),
    ).toThrow(/track trades/)
  })

  it('can be turned on later, and refuses to turn off while shares are still unvested', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Broker', kind: 'brokerage', tracking: 'lots' })
    updateInvestAccount(db, a.id, { name: 'Broker — RSUs', stockPlan: true })
    expect(listInvestAccounts(db)[0]).toMatchObject({ name: 'Broker — RSUs', stock_plan: 1 })

    putUnvested(db, { investAccountId: a.id, symbol: 'ACME', qty: '400' }, '2026-09-15')
    expect(() => updateInvestAccount(db, a.id, { stockPlan: false })).toThrow(/clear the unvested shares/)

    putUnvested(db, { investAccountId: a.id, symbol: 'ACME', qty: '0' }, '2026-09-15')
    updateInvestAccount(db, a.id, { stockPlan: false })
    expect(listInvestAccounts(db)[0]!.stock_plan).toBe(0)
  })
})

describe('deleting an investment account', () => {
  it('takes its dated facts with it and leaves other accounts alone', () => {
    const db = mem()
    const gone = createInvestAccount(db, { name: 'Old broker', kind: 'brokerage', tracking: 'lots', stockPlan: true })
    const kept = createInvestAccount(db, { name: 'Keeper', kind: 'brokerage', tracking: 'lots' })
    createTrade(db, {
      investAccountId: gone.id, symbol: 'ACME', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-01-05', qty: '10', totalCents: 100_00,
    })
    createTrade(db, {
      investAccountId: kept.id, symbol: 'VTI', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-01-05', qty: '3', totalCents: 900_00,
    })
    putUnvested(db, { investAccountId: gone.id, symbol: 'ACME', qty: '400' }, '2026-09-15')
    db.prepare(
      `INSERT INTO pay_sources (earner, employer, cadence, paid_on, gross_cents, invest_account_id)
       VALUES ('Max', 'Acme', 'biweekly', '2026-09-04', 500_000, ?)`,
    ).run(gone.id)
    expect(listInvestAccounts(db)[0]!.counts).toEqual({ trades: 1, balances: 0, unvested: 1, paychecks: 1 })

    const r = deleteInvestAccount(db, gone.id)
    expect(r.removed).toEqual({ trades: 1, balances: 0, unvested: 1 })
    expect(r.unlinkedPaychecks).toBe(1)
    expect(listInvestAccounts(db).map((a) => a.name)).toEqual(['Keeper'])
    expect(count(db, 'unvested_positions')).toBe(0)
    expect(count(db, 'trades')).toBe(1)
    // The paycheck survives; only its stock-comp link is cleared.
    expect(db.prepare('SELECT invest_account_id FROM pay_sources').get()).toEqual({ invest_account_id: null })
    // ACME is nobody's asset now; VTI still is.
    expect(db.prepare('SELECT symbol FROM assets').all()).toEqual([{ symbol: 'VTI' }])

    expect(() => deleteInvestAccount(db, gone.id)).toThrow(/no such investment account/)
  })

  it('drops balance snapshots and keeps a cross-account sell pointing at a deleted lot', () => {
    const db = mem()
    const balance = createInvestAccount(db, { name: '401k', kind: 'retirement', tracking: 'balance' })
    putBalanceSnapshot(db, { investAccountId: balance.id, balancedOn: '2026-09-01', balanceCents: 1_234_56 })
    expect(deleteInvestAccount(db, balance.id).removed.balances).toBe(1)
    expect(count(db, 'balance_snapshots')).toBe(0)

    const gone = createInvestAccount(db, { name: 'Old', kind: 'brokerage', tracking: 'lots' })
    const kept = createInvestAccount(db, { name: 'New', kind: 'brokerage', tracking: 'lots' })
    const buy = createTrade(db, {
      investAccountId: gone.id, symbol: 'ACME', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-01-05', qty: '10', totalCents: 100_00,
    })
    createTrade(db, {
      investAccountId: kept.id, symbol: 'ACME', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-02-05', qty: '10', totalCents: 200_00,
    })
    db.prepare('UPDATE trades SET sold_lot_trade_id = ? WHERE invest_account_id = ?').run(buy.id, kept.id)

    deleteInvestAccount(db, gone.id)
    expect(db.prepare('SELECT sold_lot_trade_id FROM trades').get()).toEqual({ sold_lot_trade_id: null })
  })
})
