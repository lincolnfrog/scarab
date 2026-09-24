import { describe, expect, it } from 'vitest'
import { ensureDailyHistory } from '../server/charts'
import { openDb } from '../server/migrations'
import { backfillMonthlyHistory } from '../server/prices'
import type { PortfolioResponse } from '../shared/invest-api'
import type { DbLike } from './db'
import { ApiError } from './errors'
import {
  createOpeningPositions,
  deleteBalanceSnapshot,
  deleteTrade,
  getInvestAccount,
  findAsset,
  getCheckin,
  getPortfolio,
  listAssets,
  listBalanceSnapshots,
  listInvestOwners,
  listTrades,
  manualPriceKey,
  setManualPrice,
  updateTrade,
  vestUnvested,
} from './invest'
import { priceFlagKeys, priceFlags, upsertPrices } from './prices'
import { getTax } from './tax'
import { netWorthSeries } from './networth'
import {
  createInvestAccount,
  createLiability,
  createProperty,
  createTrade,
  deleteInvestAccount,
  listInvestAccounts,
  putBalanceSnapshot,
  putLiabilityBalance,
  putUnvested,
  putValuation,
  updateInvestAccount,
} from './services'
import { seedHousehold } from './test/household'

const TODAY = '2026-09-22'
const mem = () => openDb(':memory:') as unknown as DbLike
const count = (db: DbLike, t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
const totalChanges = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

/** The HTTP status an engine call fails with (400/404), or what went wrong instead. */
function failure(fn: () => unknown): { status: number; message: string } | string {
  try {
    fn()
  } catch (e) {
    return e instanceof ApiError ? { status: e.status, message: e.message } : `not an ApiError: ${String(e)}`
  }
  return 'did not throw'
}

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
    }, TODAY)
    createTrade(db, {
      investAccountId: kept.id, symbol: 'VTI', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-01-05', qty: '3', totalCents: 900_00,
    }, TODAY)
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
    putBalanceSnapshot(db, { investAccountId: balance.id, balancedOn: '2026-09-01', balanceCents: 1_234_56 }, TODAY)
    expect(deleteInvestAccount(db, balance.id).removed.balances).toBe(1)
    expect(count(db, 'balance_snapshots')).toBe(0)

    const gone = createInvestAccount(db, { name: 'Old', kind: 'brokerage', tracking: 'lots' })
    const kept = createInvestAccount(db, { name: 'New', kind: 'brokerage', tracking: 'lots' })
    const buy = createTrade(db, {
      investAccountId: gone.id, symbol: 'ACME', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-01-05', qty: '10', totalCents: 100_00,
    }, TODAY)
    createTrade(db, {
      investAccountId: kept.id, symbol: 'ACME', assetKind: 'stock', side: 'buy',
      tradedOn: '2026-02-05', qty: '10', totalCents: 200_00,
    }, TODAY)
    db.prepare('UPDATE trades SET sold_lot_trade_id = ? WHERE invest_account_id = ?').run(buy.id, kept.id)

    deleteInvestAccount(db, gone.id)
    expect(db.prepare('SELECT sold_lot_trade_id FROM trades').get()).toEqual({ sold_lot_trade_id: null })
  })
})

/* ---------- B1 · per-account lots ---------- */

type TradeBody = Parameters<typeof createTrade>[1]

/** Two taxable accounts (A, B), a Roth IRA and a traditional IRA, all lots-tracked. */
function fourAccounts(db: DbLike) {
  const a = createInvestAccount(db, { name: 'Max Schwab', kind: 'brokerage', tracking: 'lots' }).id
  const b = createInvestAccount(db, { name: 'Nicole Fidelity', kind: 'brokerage', tracking: 'lots' }).id
  const roth = createInvestAccount(db, { name: 'Roth IRA', kind: 'retirement', tracking: 'lots' }).id
  const ira = createInvestAccount(db, { name: 'Rollover IRA', kind: 'retirement', tracking: 'lots' }).id
  const t = (b: Omit<TradeBody, 'assetKind'> & { assetKind?: string }) =>
    createTrade(db, { assetKind: 'stock', ...b }, TODAY).id
  return { a, b, roth, ira, t }
}

describe('recording a trade', () => {
  it('refuses a specific lot from another account or another asset (audit probe 3)', () => {
    const db = mem()
    const { a, b, t } = fourAccounts(db)
    const aVti = t({ investAccountId: a, symbol: 'VTI', side: 'buy', tradedOn: '2020-03-02', qty: '10', totalCents: 1_500_00 })
    t({ investAccountId: b, symbol: 'VTI', side: 'buy', tradedOn: '2026-01-05', qty: '10', totalCents: 3_000_00 })
    const aQqq = t({ investAccountId: a, symbol: 'QQQ', side: 'buy', tradedOn: '2025-01-02', qty: '5', totalCents: 2_500_00 })
    const trades = count(db, 'trades')
    const assets = count(db, 'assets')

    const sell = (over: Partial<TradeBody>) => () =>
      createTrade(db, { investAccountId: b, symbol: 'VTI', assetKind: 'stock', side: 'sell', tradedOn: '2026-06-01', qty: '10', totalCents: 3_200_00, ...over }, TODAY)
    expect(failure(sell({ soldLotTradeId: aVti }))).toEqual({ status: 400, message: 'that lot belongs to a different account' })
    expect(failure(sell({ investAccountId: a, soldLotTradeId: aQqq }))).toEqual({ status: 400, message: 'that lot is not a VTI lot' })
    // A symbol Scarab has never seen can't own any lot — and isn't created by the refused sale.
    expect(failure(sell({ investAccountId: a, symbol: 'NEWCO', soldLotTradeId: aVti }))).toMatchObject({ status: 400 })
    expect(failure(sell({ investAccountId: a, tradedOn: '2020-03-01', soldLotTradeId: aVti }))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/bought on 2020-03-02, after this sale/),
    })
    expect(count(db, 'trades')).toBe(trades)
    expect(count(db, 'assets')).toBe(assets)

    // The same lot, from its own account, is fine.
    expect(sell({ investAccountId: a, soldLotTradeId: aVti })()).toMatchObject({ id: expect.any(Number) })
  })

  it('refuses a trade dated after today (audit probe 6)', () => {
    const db = mem()
    const { a } = fourAccounts(db)
    const body = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', qty: '1', totalCents: 300_00 }
    expect(failure(() => createTrade(db, { ...body, tradedOn: '2026-09-23' }, TODAY))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/after today/),
    })
    expect(count(db, 'trades')).toBe(0)
    expect(count(db, 'assets')).toBe(0)
    createTrade(db, { ...body, tradedOn: TODAY }, TODAY)
    expect(count(db, 'trades')).toBe(1)
  })

  it('refuses an asset kind that contradicts the recorded asset (audit probe 7)', () => {
    const db = mem()
    const { a, t } = fourAccounts(db)
    t({ investAccountId: a, symbol: 'VTI', side: 'buy', tradedOn: '2026-01-05', qty: '1', totalCents: 300_00 })
    expect(
      failure(() =>
        createTrade(db, { investAccountId: a, symbol: 'vti', assetKind: 'crypto', side: 'buy', tradedOn: '2026-02-05', qty: '1', totalCents: 300_00 }, TODAY),
      ),
    ).toMatchObject({ status: 400, message: expect.stringMatching(/VTI is already recorded as a stock/) })
    expect(count(db, 'trades')).toBe(1)
    expect(db.prepare('SELECT kind FROM assets').all()).toEqual([{ kind: 'stock' }])
  })

  it('refuses an explicit-basis sale acquired after it was sold', () => {
    const db = mem()
    const { a } = fourAccounts(db)
    expect(
      failure(() =>
        createTrade(db, {
          investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'sell', tradedOn: '2026-03-01', qty: '1',
          totalCents: 300_00, acquiredOn: '2026-04-01', basisCents: 200_00,
        }, TODAY),
      ),
    ).toMatchObject({ status: 400, message: 'acquiredOn must be on or before the sale date' })
  })
})

describe('the portfolio pools lots per account', () => {
  it("B's sale uses B's lot: short-term $200, and A's 2020 lot stays open (audit probe 1)", () => {
    const db = mem()
    const { a, b, t } = fourAccounts(db)
    const aLot = t({ investAccountId: a, symbol: 'VTI', side: 'buy', tradedOn: '2020-03-02', qty: '10', totalCents: 1_500_00 })
    t({ investAccountId: b, symbol: 'VTI', side: 'buy', tradedOn: '2026-01-05', qty: '10', totalCents: 3_000_00 })
    t({ investAccountId: b, symbol: 'VTI', side: 'sell', tradedOn: '2026-06-01', qty: '10', totalCents: 3_200_00 }) // FIFO

    const p = getPortfolio(db, TODAY)
    expect(p.totals).toMatchObject({ ytd_st: 200_00, ytd_lt: 0, ytd_sheltered: 0 })
    expect(p.positions).toHaveLength(1)
    const vti = p.positions[0]!
    expect(vti).toMatchObject({ symbol: 'VTI', kind: 'stock', qty_micro: 10_000_000, cost_cents: 1_500_00 })
    expect(vti.accounts).toEqual([
      { invest_account_id: a, name: 'Max Schwab', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 1_500_00, value_cents: 1_500_00 },
    ])
    expect(vti.lots).toEqual([
      {
        trade_id: aLot, opened_on: '2020-03-02', lt_on: '2021-03-03', qty_micro: 10_000_000, cost_cents: 1_500_00,
        invest_account_id: a, account_name: 'Max Schwab', sheltered: false,
      },
    ])
    expect(p.warnings).toEqual([])
  })

  it('answers the PortfolioResponse contract: per-account split, shelter, priced values, named warnings', () => {
    const db = mem()
    const { a, roth, t } = fourAccounts(db)
    t({ investAccountId: a, symbol: 'QQQ', side: 'buy', tradedOn: '2024-02-29', qty: '4', totalCents: 1_600_00 })
    t({ investAccountId: roth, symbol: 'QQQ', side: 'buy', tradedOn: '2025-05-01', qty: '6', totalCents: 2_700_00 })
    t({ investAccountId: roth, symbol: 'QQQ', side: 'sell', tradedOn: '2026-07-01', qty: '2', totalCents: 1_100_00 })
    // An oversell in the Roth: zero-basis proceeds and a warning naming the holding.
    t({ investAccountId: roth, symbol: 'BND', side: 'sell', tradedOn: '2026-08-01', qty: '1', totalCents: 70_00 })
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-19', 50_000)").run()

    const p: PortfolioResponse = getPortfolio(db, TODAY)
    // Roth QQQ: 2 of the 6 sold at $550 against $450 basis → $200 gain; BND $70 zero-basis. Neither is taxable.
    expect(p.totals).toMatchObject({ ytd_st: 0, ytd_lt: 0, ytd_sheltered: 200_00 + 70_00 })
    const qqq = p.positions.find((x) => x.symbol === 'QQQ')!
    expect(qqq).toMatchObject({ asset_id: 1, qty_micro: 8_000_000, price_cents: 50_000, priced_on: '2026-09-19', value_cents: 4_000_00 })
    expect(qqq.cost_cents).toBe(1_600_00 + 1_800_00)
    expect(qqq.unrealized_cents).toBe(4_000_00 - 3_400_00)
    expect(qqq.accounts.map((x) => [x.name, x.kind, x.qty_micro, x.value_cents])).toEqual([
      ['Max Schwab', 'brokerage', 4_000_000, 2_000_00],
      ['Roth IRA', 'retirement', 4_000_000, 2_000_00],
    ])
    // A Feb 29 lot turns long-term on Mar 1 of the next year.
    expect(qqq.lots.map((l) => [l.account_name, l.opened_on, l.lt_on, l.sheltered])).toEqual([
      ['Max Schwab', '2024-02-29', '2025-03-01', false],
      ['Roth IRA', '2025-05-01', '2026-05-02', true],
    ])
    expect(p.warnings).toHaveLength(1)
    expect(p.warnings[0]).toMatch(/^BND · Roth IRA: Sell on 2026-08-01 exceeds recorded holdings/)
    expect(p.totals.value).toBe(p.positions.reduce((s, x) => s + x.value_cents, 0))
  })

  it("totals.value equals the current month's lots-account value in net worth (audit probe 4)", () => {
    const db = mem()
    seedHousehold(db)
    const trade = db.prepare(
      'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, ?, ?, ?, ?, ?)',
    )
    // A buy dated later this month hasn't happened yet (legacy data — the
    // services refuse it now), and a quote stamped with a later day is still
    // the latest price. Both sides must treat them the same way.
    trade.run(1, 1, '2026-09-28', 'buy', 2_000_000, 50_000)
    trade.run(2, 1, '2026-08-03', 'buy', 3_333_333, 81_111) // VTI in the Roth too: odd micro-shares, rounding per account
    // (On the last evening of a month a crypto quote's UTC stamp is already next month.)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (2, '2026-10-01', 48_123)").run()

    const p = getPortfolio(db, TODAY)
    const nw = netWorthSeries(db, TODAY).at(-1)!
    expect(nw.month).toBe('2026-09')
    const balanceTracked = (db.prepare(
      `SELECT COALESCE(SUM(s.balance_cents), 0) AS v FROM balance_snapshots s JOIN invest_accounts ia ON ia.id = s.invest_account_id
       WHERE ia.tracking = 'balance' AND s.balanced_on = (SELECT max(balanced_on) FROM balance_snapshots WHERE invest_account_id = s.invest_account_id)`,
    ).get() as { v: number }).v
    expect(balanceTracked).toBe(4_450_000)
    expect(p.totals.value).toBe(nw.brokerage + nw.retirement + nw.crypto - balanceTracked)
    expect(p.totals.value).toBeGreaterThan(0)
    // The unpriced bitcoin is carried at cost on both sides.
    expect(p.positions.find((x) => x.symbol === 'BTC')).toMatchObject({ price_cents: null, value_cents: 650_000 })
  })
})

/* ---------- B2 · correctness bundle ---------- */

describe('vesting RSUs', () => {
  function plan() {
    const db = mem()
    const planId = createInvestAccount(db, { name: 'Acme stock plan', kind: 'brokerage', tracking: 'lots', stockPlan: true }).id
    const plain = createInvestAccount(db, { name: 'Schwab', kind: 'brokerage', tracking: 'lots' }).id
    const k401 = createInvestAccount(db, { name: '401(k)', kind: 'retirement', tracking: 'balance' }).id
    putUnvested(db, { investAccountId: planId, symbol: 'ACME', qty: '100', nextVestOn: '2026-11-15', vestEveryMonths: 3, vestQty: '25' }, TODAY)
    const vest = (over: Partial<Parameters<typeof vestUnvested>[1]>) =>
      vestUnvested(db, { investAccountId: planId, symbol: 'ACME', qty: '25', tradedOn: '2026-08-15', totalCents: 10_000_00, ...over }, TODAY)
    return { db, planId, plain, k401, vest }
  }

  it('lands only in a lots-tracked employee stock plan', () => {
    const { db, plain, k401, vest } = plan()
    expect(failure(() => vest({ investAccountId: plain }))).toMatchObject({ status: 404, message: expect.stringMatching(/employee stock plan/) })
    expect(failure(() => vest({ investAccountId: k401 }))).toMatchObject({ status: 404 })
    expect(failure(() => vest({ tradedOn: '2026-09-23' }))).toMatchObject({ status: 400, message: expect.stringMatching(/after today/) })
    expect(count(db, 'trades')).toBe(0)
  })

  it('refuses to vest more than is unvested unless the extra is confirmed as untracked', () => {
    const { db, vest, planId } = plan()
    expect(failure(() => vest({ qty: '101' }))).toMatchObject({
      status: 400,
      message: expect.stringMatching(/only 100 ACME are unvested here/),
    })
    expect(count(db, 'trades')).toBe(0)
    expect(db.prepare('SELECT qty_micro FROM unvested_positions').get()).toEqual({ qty_micro: 100_000_000 })

    expect(vest({ qty: '101', allowUntracked: true })).toMatchObject({ remainingQtyMicro: 0 })
    expect(count(db, 'unvested_positions')).toBe(0)
    expect(db.prepare('SELECT qty_micro, note FROM trades').get()).toEqual({ qty_micro: 101_000_000, note: 'RSU vest' })

    // Nothing unvested at all: refused, then allowed as an untracked grant.
    expect(failure(() => vest({ qty: '5' }))).toMatchObject({ status: 400, message: expect.stringMatching(/no unvested ACME/) })
    expect(vest({ qty: '5', allowUntracked: true, investAccountId: planId })).toMatchObject({ remainingQtyMicro: 0 })
    expect(count(db, 'trades')).toBe(2)
  })

  it('an exact vest keeps the rest of the grant and rolls its cadence', () => {
    const { db, vest } = plan()
    expect(vest({ qty: '25', tradedOn: '2026-08-15' })).toMatchObject({ remainingQtyMicro: 75_000_000 })
    expect(db.prepare('SELECT qty_micro, next_vest_on FROM unvested_positions').get()).toEqual({
      qty_micro: 75_000_000,
      next_vest_on: '2026-11-15',
    })
  })

  it('a refused grant writes nothing — no stray asset — and clearing one drops an asset nothing else uses', () => {
    const { db, planId, vest } = plan()
    const before = totalChanges(db)
    // A bad count or a half-typed schedule is refused before the new symbol is ever inserted.
    expect(failure(() => putUnvested(db, { investAccountId: planId, symbol: 'NEWCO', qty: 'abc' }, TODAY))).toMatchObject({ status: 400 })
    expect(failure(() => putUnvested(db, { investAccountId: planId, symbol: 'NEWCO', qty: '10', nextVestOn: '2026-10-01', vestEveryMonths: 3, vestQty: 'x' }, TODAY))).toMatchObject({ status: 400 })
    // Clearing a grant Scarab never recorded changes nothing.
    expect(putUnvested(db, { investAccountId: planId, symbol: 'ZZZ', qty: '0' }, TODAY)).toEqual({ ok: true, qtyMicro: 0 })
    expect(totalChanges(db)).toBe(before)
    expect(listAssets(db).map((a) => a.symbol)).toEqual(['ACME'])

    // A grant set and then cleared leaves nothing behind (its price history goes too)…
    putUnvested(db, { investAccountId: planId, symbol: 'OTHR', qty: '5' }, TODAY)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) SELECT id, '2026-09-19', 1234 FROM assets WHERE symbol = 'OTHR'").run()
    putUnvested(db, { investAccountId: planId, symbol: 'OTHR', qty: '0' }, TODAY)
    expect(listAssets(db).map((a) => a.symbol)).toEqual(['ACME'])
    expect(count(db, 'prices')).toBe(0)
    // …but an asset with trades stays when its grant is cleared.
    vest({ qty: '25' })
    putUnvested(db, { investAccountId: planId, symbol: 'ACME', qty: '0' }, TODAY)
    expect(count(db, 'unvested_positions')).toBe(0)
    expect(listAssets(db).map((a) => a.symbol)).toEqual(['ACME'])
  })
})

describe('balance snapshots', () => {
  it('404 for an account that does not exist; any tracking otherwise', () => {
    const db = mem()
    expect(failure(() => putBalanceSnapshot(db, { investAccountId: 42, balancedOn: '2026-09-01', balanceCents: 1_00 }, TODAY))).toEqual({
      status: 404,
      message: 'no such investment account',
    })
    expect(count(db, 'balance_snapshots')).toBe(0)
    // A lots account takes one too — it will anchor the brokerage's cash.
    const lots = createInvestAccount(db, { name: 'Schwab', kind: 'brokerage', tracking: 'lots' }).id
    putBalanceSnapshot(db, { investAccountId: lots, balancedOn: '2026-09-01', balanceCents: 1_00 }, TODAY)
    expect(count(db, 'balance_snapshots')).toBe(1)
  })
})

describe('balance history: bulk backfill, list, delete (B4)', () => {
  const setup = () => {
    const db = mem()
    const k = createInvestAccount(db, { name: 'Fidelity 401(k)', kind: 'retirement', tracking: 'balance' }).id
    const other = createInvestAccount(db, { name: 'Other 401(k)', kind: 'retirement', tracking: 'balance' }).id
    return { db, k, other }
  }
  const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

  it('writes a batch of statement balances in one go, overwriting a day already recorded', () => {
    const { db, k, other } = setup()
    putBalanceSnapshot(db, { investAccountId: k, balancedOn: '2026-03-31', balanceCents: 1_00 }, TODAY)
    putBalanceSnapshot(db, { investAccountId: other, balancedOn: '2026-03-31', balanceCents: 9_00 }, TODAY)
    expect(
      putBalanceSnapshot(
        db,
        {
          investAccountId: k,
          balances: [
            { balancedOn: '2025-12-31', balanceCents: 40_000_00 },
            { balancedOn: '2026-03-31', balanceCents: 42_000_00 },
            { balancedOn: '2026-06-30', balanceCents: 44_500_00 },
          ],
        },
        TODAY,
      ),
    ).toEqual({ ok: true, written: 3 })
    expect(listBalanceSnapshots(db, { accountId: String(k) })).toEqual([
      { invest_account_id: k, balanced_on: '2026-06-30', balance_cents: 44_500_00 },
      { invest_account_id: k, balanced_on: '2026-03-31', balance_cents: 42_000_00 },
      { invest_account_id: k, balanced_on: '2025-12-31', balance_cents: 40_000_00 },
    ])
    expect(listBalanceSnapshots(db).map((r) => r.invest_account_id)).toEqual([k, k, k, other])
    // The account list's latest balance follows.
    expect(listInvestAccounts(db).find((a) => a.id === k)!.latest_snapshot).toEqual({ balanced_on: '2026-06-30', balance_cents: 44_500_00 })
  })

  it('refuses the whole batch when any entry is bad, before writing anything', () => {
    const { db, k } = setup()
    const before = changes(db)
    const bad = (balances: unknown[]) =>
      failure(() => putBalanceSnapshot(db, { investAccountId: k, balances: balances as { balancedOn: string; balanceCents: number }[] }, TODAY))
    const good = { balancedOn: '2026-03-31', balanceCents: 1_00 }
    expect(bad([good, { balancedOn: '2026-02-30', balanceCents: 1_00 }])).toMatchObject({ status: 400, message: /balances\[1\]/ })
    expect(bad([good, { balancedOn: '2026-06-30', balanceCents: 1.5 }])).toMatchObject({ status: 400 })
    expect(bad([good, { balancedOn: '2026-09-23', balanceCents: 1_00 }])).toMatchObject({ status: 400, message: /after today/ })
    expect(bad([good, good])).toMatchObject({ status: 400, message: /appears twice/ })
    expect(bad([])).toMatchObject({ status: 400 })
    expect(bad(Array.from({ length: 101 }, (_, i) => ({ balancedOn: `2020-01-${String((i % 28) + 1).padStart(2, '0')}`, balanceCents: i })))).toMatchObject({ status: 400, message: /at most 100/ })
    expect(failure(() => putBalanceSnapshot(db, { investAccountId: 999, balances: [good] }, TODAY))).toMatchObject({ status: 404 })
    expect(failure(() => putBalanceSnapshot(db, { investAccountId: k, balancedOn: '2026-03-31', balanceCents: 1, balances: [good] }, TODAY))).toMatchObject({ status: 400, message: /not both/ })
    // A single snapshot dated after today is refused too.
    expect(failure(() => putBalanceSnapshot(db, { investAccountId: k, balancedOn: '2026-09-23', balanceCents: 1_00 }, TODAY))).toMatchObject({ status: 400, message: /after today/ })
    expect(changes(db)).toBe(before)
    expect(count(db, 'balance_snapshots')).toBe(0)
  })

  it('deletes one recorded day, and 404s for a day that has none', () => {
    const { db, k, other } = setup()
    putBalanceSnapshot(db, { investAccountId: k, balances: [{ balancedOn: '2026-03-31', balanceCents: 1_00 }, { balancedOn: '2026-06-30', balanceCents: 2_00 }] }, TODAY)
    putBalanceSnapshot(db, { investAccountId: other, balancedOn: '2026-06-30', balanceCents: 3_00 }, TODAY)
    expect(deleteBalanceSnapshot(db, k, '2026-06-30')).toEqual({ ok: true })
    expect(listBalanceSnapshots(db).map((r) => [r.invest_account_id, r.balanced_on])).toEqual([
      [k, '2026-03-31'],
      [other, '2026-06-30'],
    ])
    expect(failure(() => deleteBalanceSnapshot(db, k, '2026-06-30'))).toMatchObject({ status: 404 })
    expect(failure(() => deleteBalanceSnapshot(db, k, 'June 30'))).toMatchObject({ status: 400 })
    expect(failure(() => listBalanceSnapshots(db, { accountId: 'x' }))).toMatchObject({ status: 400 })
  })
})

describe('hand-entered prices (B3)', () => {
  const setup = () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Fidelity', kind: 'brokerage', tracking: 'lots' }).id
    createTrade(db, { investAccountId: a, symbol: 'FXAIX', assetKind: 'stock', side: 'buy', tradedOn: '2026-01-05', qty: '10', totalCents: 2_000_00 }, TODAY)
    return { db, a }
  }

  it('validates: a recorded asset, a day that has happened, more than $0', () => {
    const { db } = setup()
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    expect(failure(() => setManualPrice(db, { symbol: 'NOPE', pricedOn: '2026-09-20', cents: 100 }, TODAY))).toMatchObject({ status: 404 })
    expect(failure(() => setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-23', cents: 100 }, TODAY))).toMatchObject({ status: 400, message: /after today/ })
    expect(failure(() => setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-20', cents: 0 }, TODAY))).toMatchObject({ status: 400, message: /more than \$0/ })
    expect(failure(() => setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-20', cents: 12.5 }, TODAY))).toMatchObject({ status: 400 })
    expect(failure(() => setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-02-30', cents: 100 }, TODAY))).toMatchObject({ status: 400 })
    expect(failure(() => setManualPrice(db, { pricedOn: '2026-09-20', cents: 100 }, TODAY))).toMatchObject({ status: 400 })
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before)
  })

  it('prices the holding and tags it manual until a market quote replaces it', () => {
    const { db } = setup()
    expect(setManualPrice(db, { symbol: ' fxaix ', pricedOn: '2026-09-20', cents: 215_37 }, TODAY)).toEqual({
      ok: true, symbol: 'FXAIX', pricedOn: '2026-09-20', cents: 215_37,
    })
    let p = getPortfolio(db, TODAY).positions[0]!
    expect(p).toMatchObject({ price_cents: 215_37, priced_on: '2026-09-20', value_cents: 2_153_70, price_manual: true })
    // An older statement price backfilled later leaves the current one tagged.
    setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-06-30', cents: 200_00 }, TODAY)
    expect(getPortfolio(db, TODAY).positions[0]!.price_manual).toBe(true)
    // A market quote for the same day overwrites the close: no longer manual.
    db.prepare("UPDATE prices SET close_cents = 216_00 WHERE priced_on = '2026-09-20'").run()
    expect(getPortfolio(db, TODAY).positions[0]!.price_manual).toBe(false)
    // A newer manual price tags it again; a newer market quote untags it.
    setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-21', cents: 217_00 }, TODAY)
    expect(getPortfolio(db, TODAY).positions[0]!.price_manual).toBe(true)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-22', 218_00)").run()
    p = getPortfolio(db, TODAY).positions[0]!
    expect(p).toMatchObject({ priced_on: '2026-09-22', price_manual: false })
  })

  it('the orphan sweep drops the manual mark with its price', () => {
    const { db, a } = setup()
    setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-20', cents: 215_37 }, TODAY)
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(manualPriceKey('FXAIX'))).toEqual({ value: '{"on":"2026-09-20","cents":21537}' })
    deleteInvestAccount(db, a)
    expect(db.prepare('SELECT value FROM app_meta WHERE key = ?').get(manualPriceKey('FXAIX'))).toBeUndefined()
    expect(count(db, 'prices')).toBe(0)
  })
})

describe('starting positions (B5)', () => {
  const setup = () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Schwab', kind: 'brokerage', tracking: 'lots' }).id
    const cb = createInvestAccount(db, { name: 'Coinbase', kind: 'crypto', tracking: 'lots' }).id
    const k = createInvestAccount(db, { name: '401(k)', kind: 'retirement', tracking: 'balance' }).id
    return { db, a, cb, k }
  }
  const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
  const AS_OF = '2026-09-01'

  it('books each lot as a buy on the as-of date that keeps its real acquisition date', () => {
    const { db, a, cb } = setup()
    const res = createOpeningPositions(
      db,
      {
        investAccountId: a,
        asOf: AS_OF,
        rows: [
          { symbol: 'vti', qty: '120', basisCents: 18_400_00, acquiredOn: '2019-03-15' },
          { symbol: 'VTI', qty: '10', basisCents: 2_500_00, acquiredOn: '2026-03-02' },
          { symbol: 'QQQ', qty: '5', basisCents: 2_000_00 },
        ],
      },
      TODAY,
    )
    expect(res).toMatchObject({ created: 3, errors: [], warnings: [{ row: 2, message: 'QQQ: no acquisition date — its holding period starts on 2026-09-01' }] })
    expect(res.tradeIds).toHaveLength(3)
    expect(db.prepare('SELECT traded_on, side, qty_micro, total_cents, acquired_on, note FROM trades ORDER BY id').all()).toEqual([
      { traded_on: AS_OF, side: 'buy', qty_micro: 120_000_000, total_cents: 18_400_00, acquired_on: '2019-03-15', note: 'Opening position' },
      { traded_on: AS_OF, side: 'buy', qty_micro: 10_000_000, total_cents: 2_500_00, acquired_on: '2026-03-02', note: 'Opening position' },
      { traded_on: AS_OF, side: 'buy', qty_micro: 5_000_000, total_cents: 2_000_00, acquired_on: null, note: 'Opening position' },
    ])
    // The holding period comes from the acquisition: the 2019 lot is long-term, the March one isn't yet.
    const vti = getPortfolio(db, TODAY).positions.find((p) => p.symbol === 'VTI')!
    expect(vti.lots.map((l) => [l.opened_on, l.lt_on])).toEqual([
      ['2019-03-15', '2020-03-16'],
      ['2026-03-02', '2027-03-03'],
    ])
    // A new symbol in a crypto account is crypto; a second paste into the same account warns about the overlap.
    const again = createOpeningPositions(
      db,
      { investAccountId: cb, asOf: AS_OF, rows: [{ symbol: 'ETH', qty: '2', basisCents: 3_000_00, acquiredOn: '2021-01-04' }] },
      TODAY,
    )
    expect(again.created).toBe(1)
    expect(db.prepare("SELECT kind FROM assets WHERE symbol = 'ETH'").get()).toEqual({ kind: 'crypto' })
    const more = createOpeningPositions(db, { investAccountId: a, asOf: AS_OF, rows: [{ symbol: 'VTI', qty: '1', basisCents: 100_00, acquiredOn: '2020-01-02' }] }, TODAY)
    expect(more.warnings).toEqual([{ row: 0, message: 'Schwab already has VTI trades — this lot is added to them' }])
  })

  it('is all or nothing: one bad row writes nothing, and says which rows', () => {
    const { db, a } = setup()
    createTrade(db, { investAccountId: a, symbol: 'BTC', assetKind: 'crypto', side: 'buy', tradedOn: '2026-01-05', qty: '1', totalCents: 1_00 }, TODAY)
    const before = changes(db)
    const res = createOpeningPositions(
      db,
      {
        investAccountId: a,
        asOf: AS_OF,
        rows: [
          { symbol: 'VTI', qty: '10', basisCents: 1_000_00, acquiredOn: '2019-01-02' },
          { symbol: 'QQQ', qty: '-1', basisCents: 1_000_00 },
          { symbol: 'IWM', qty: '1', basisCents: -5 },
          { symbol: 'EFA', qty: '1', basisCents: 100, acquiredOn: '2026-09-02' },
          { symbol: 'EEM', qty: '1', basisCents: 100, acquiredOn: '2019-02-30' },
          { symbol: 'BTC', qty: '1', basisCents: 100, assetKind: 'stock' },
          { symbol: 'NEW', qty: '1', basisCents: 100, assetKind: 'stock' },
          { symbol: 'NEW', qty: '1', basisCents: 100, assetKind: 'crypto' },
          { symbol: 'TWO WORDS', qty: '1', basisCents: 100 },
        ],
      },
      TODAY,
    )
    expect(res.created).toBe(0)
    expect(res.tradeIds).toEqual([])
    expect(res.errors.map((e) => e.row)).toEqual([1, 2, 3, 4, 5, 7, 8])
    expect(res.errors.find((e) => e.row === 3)!.message).toMatch(/after the as-of date/)
    expect(res.errors.find((e) => e.row === 5)!.message).toMatch(/already recorded as crypto/)
    expect(changes(db)).toBe(before)
    expect(count(db, 'trades')).toBe(1)
    expect(count(db, 'assets')).toBe(1)
  })

  it('refuses a future as-of date, an empty paste, and anything but a lots account', () => {
    const { db, a, k } = setup()
    const row = { symbol: 'VTI', qty: '1', basisCents: 100 }
    expect(failure(() => createOpeningPositions(db, { investAccountId: a, asOf: '2026-09-23', rows: [row] }, TODAY))).toMatchObject({ status: 400, message: /after today/ })
    expect(failure(() => createOpeningPositions(db, { investAccountId: a, asOf: AS_OF, rows: [] }, TODAY))).toMatchObject({ status: 400 })
    expect(failure(() => createOpeningPositions(db, { investAccountId: k, asOf: AS_OF, rows: [row] }, TODAY))).toMatchObject({ status: 404 })
    expect(failure(() => createOpeningPositions(db, { investAccountId: a, asOf: '2026-02-30', rows: [row] }, TODAY))).toMatchObject({ status: 400 })
    expect(count(db, 'trades')).toBe(0)
  })

  it('FIFO sells the earliest-acquired lot first, and a sale before the as-of date cannot touch it', () => {
    const { db, a } = setup()
    const buy = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', qty: '10' }
    createTrade(db, { ...buy, side: 'buy', tradedOn: '2024-06-03', totalCents: 2_500_00 }, TODAY) // bought in Scarab, 2024
    const [opening] = createOpeningPositions(
      db,
      { investAccountId: a, asOf: AS_OF, rows: [{ symbol: 'VTI', qty: '10', basisCents: 1_000_00, acquiredOn: '2019-03-15' }] },
      TODAY,
    ).tradeIds
    // Naming the opening lot in a sale dated before its as-of date is refused.
    expect(failure(() => createTrade(db, { ...buy, side: 'sell', tradedOn: '2026-08-15', totalCents: 3_000_00, soldLotTradeId: opening }, TODAY)))
      .toMatchObject({ status: 400, message: /on the books from 2026-09-01/ })
    // A FIFO sale after it takes the 2019 lot (long-term), not the 2024 one booked first.
    createTrade(db, { ...buy, side: 'sell', tradedOn: '2026-09-15', totalCents: 3_000_00 }, TODAY)
    const p = getPortfolio(db, TODAY)
    expect(p.positions[0]!.lots.map((l) => l.opened_on)).toEqual(['2024-06-03'])
    expect(p.totals).toMatchObject({ ytd_lt: 2_000_00, ytd_st: 0 })
    expect(getTax(db, TODAY).incomes).toMatchObject({ realizedLtCents: 2_000_00, realizedStCents: 0 })
  })

  it("the wash-sale scan dates an opening lot by its acquisition, not the day it was booked", () => {
    const { db, a } = setup()
    createTrade(db, { investAccountId: a, symbol: 'ACME', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-02', qty: '10', totalCents: 5_000_00 }, TODAY)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-19', 40_000)").run() // under water
    createOpeningPositions(db, { investAccountId: a, asOf: '2026-09-15', rows: [{ symbol: 'ACME', qty: '5', basisCents: 1_000_00, acquiredOn: '2018-05-01' }] }, TODAY)
    const loss = getTax(db, TODAY).harvest.rows.find((r) => r.opened_on === '2026-02-02')!
    expect(loss.gain_cents).toBeLessThan(0)
    expect(loss.wash_risk).toBe(false)
    // A real buy on the same day would be one.
    createTrade(db, { investAccountId: a, symbol: 'ACME', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-15', qty: '1', totalCents: 400_00 }, TODAY)
    expect(getTax(db, TODAY).harvest.rows.find((r) => r.opened_on === '2026-02-02')!.wash_risk).toBe(true)
  })
})

describe('createTrade: a buy may carry its real acquisition date (B5)', () => {
  it('accepts acquiredOn on or before the trade date; refuses a later one and basisCents on a buy', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Schwab', kind: 'brokerage', tracking: 'lots' }).id
    const buy = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-01', qty: '1', totalCents: 100_00 }
    createTrade(db, { ...buy, acquiredOn: '2019-03-15' }, TODAY)
    createTrade(db, { ...buy, acquiredOn: '2026-09-01' }, TODAY)
    expect(failure(() => createTrade(db, { ...buy, acquiredOn: '2026-09-02' }, TODAY))).toMatchObject({ status: 400, message: /on or before tradedOn/ })
    expect(failure(() => createTrade(db, { ...buy, acquiredOn: '2019-02-29' }, TODAY))).toMatchObject({ status: 400, message: /real/ })
    expect(failure(() => createTrade(db, { ...buy, basisCents: 50_00 }, TODAY))).toMatchObject({ status: 400, message: /basisCents is for selling/ })
    expect(db.prepare('SELECT acquired_on FROM trades ORDER BY id').all()).toEqual([{ acquired_on: '2019-03-15' }, { acquired_on: '2026-09-01' }])
    expect(getPortfolio(db, TODAY).positions[0]!.lots.map((l) => l.opened_on)).toEqual(['2019-03-15', '2026-09-01'])
  })
})

describe('impossible days are refused before they reach the ledger', () => {
  it('trades, vests, vest schedules, valuations and loan balances take real calendar days only', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Taxable', kind: 'brokerage', tracking: 'lots' }).id
    const plan = createInvestAccount(db, { name: 'Plan', kind: 'brokerage', tracking: 'lots', stockPlan: true }).id
    const trade = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', qty: '1', totalCents: 100_00 }
    for (const tradedOn of ['2025-00-15', '2025-02-30', '2026-04-31'])
      expect(failure(() => createTrade(db, { ...trade, tradedOn }, TODAY))).toMatchObject({ status: 400, message: `tradedOn ${tradedOn} is not a real day` })
    const good = createTrade(db, { ...trade, tradedOn: '2025-01-15' }, TODAY).id
    expect(failure(() => updateTrade(db, good, { tradedOn: '2025-02-29' }, TODAY))).toMatchObject({ status: 400, message: /not a real day/ })
    expect(failure(() => putUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '100', nextVestOn: '2026-11-31', vestEveryMonths: 3, vestQty: '25' }, TODAY)))
      .toMatchObject({ status: 400, message: /nextVestOn must be a real/ })
    putUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '100' }, TODAY)
    expect(failure(() => vestUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '25', tradedOn: '2026-00-15', totalCents: 1_000_00 }, TODAY)))
      .toMatchObject({ status: 400, message: /not a real day/ })
    const house = createProperty(db, { name: 'House' }).id
    expect(failure(() => createProperty(db, { name: 'Cabin', purchasedOn: '2020-02-30' }))).toMatchObject({ status: 400 })
    expect(failure(() => putValuation(db, house, { valuedOn: '2025-00-01', valueCents: 1 }))).toMatchObject({ status: 400 })
    expect(failure(() => createLiability(db, { name: 'Loan', balanceCents: 1, balancedOn: '2025-13-01' }))).toMatchObject({ status: 400 })
    const loan = createLiability(db, { name: 'Loan' }).id
    expect(failure(() => putLiabilityBalance(db, loan, { balancedOn: '2025-06-31', balanceCents: 1 }))).toMatchObject({ status: 400 })
    // So every monthly series still builds.
    expect(netWorthSeries(db, TODAY).at(-1)).toMatchObject({ month: '2026-09' })
    expect(count(db, 'trades')).toBe(1)
  })
})

describe('the orphan sweep', () => {
  const metaKeys = (db: DbLike, re: RegExp) =>
    (db.prepare('SELECT key FROM app_meta ORDER BY key').all() as { key: string }[]).map((r) => r.key).filter((k) => re.test(k))

  it("drops every price flag a removed symbol had, and keeps every other symbol's", () => {
    const db = mem()
    const gone = createInvestAccount(db, { name: 'Old', kind: 'brokerage', tracking: 'lots' }).id
    const kept = createInvestAccount(db, { name: 'Keep', kind: 'brokerage', tracking: 'lots' }).id
    const body = { assetKind: 'stock', side: 'buy', tradedOn: '2026-01-05', qty: '1', totalCents: 100_00 }
    createTrade(db, { ...body, investAccountId: gone, symbol: 'ACME' }, TODAY)
    createTrade(db, { ...body, investAccountId: kept, symbol: 'VTI' }, TODAY)
    const meta = db.prepare("INSERT INTO app_meta (key, value) VALUES (?, '2026-09-01')")
    for (const sym of ['ACME', 'VTI']) for (const k of [...priceFlagKeys(sym), manualPriceKey(sym)]) meta.run(k)
    expect(priceFlagKeys('ACME')).toEqual(['backfilled:ACME', 'backfilled:v2:ACME', 'backfill_failed:ACME', 'daily:v2:ACME'])
    deleteInvestAccount(db, gone)
    expect(metaKeys(db, /ACME/)).toEqual([])
    expect(metaKeys(db, /VTI/)).toEqual([...priceFlagKeys('VTI'), manualPriceKey('VTI')].sort())
  })

  it('a symbol removed and recorded again gets its monthly and daily history fetched again', async () => {
    const db = mem()
    let calls = 0
    const history = async () => {
      calls++
      return { quotes: [{ symbol: 'VTI', cents: 200_00, pricedOn: '2024-01-31' }, { symbol: 'VTI', cents: 210_00, pricedOn: '2024-02-29' }], errors: [] }
    }
    const yahooDaily = (async () =>
      new Response(JSON.stringify({ chart: { result: [{ timestamp: [1706659200], indicators: { quote: [{ close: [200] }] } }] } }))) as typeof fetch
    const backfill = () => backfillMonthlyHistory(db, [{ symbol: 'VTI', kind: 'stock' }], upsertPrices, { today: TODAY, fetchHistory: history })
    const daily = () =>
      ensureDailyHistory(db as never, { ...(db.prepare("SELECT id, symbol, kind FROM assets WHERE symbol = 'VTI'").get() as { id: number; symbol: string; kind: 'stock' }) }, yahooDaily)
    const buy = (a: number) => createTrade(db, { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2024-01-10', qty: '1', totalCents: 200_00 }, TODAY)

    const first = createInvestAccount(db, { name: 'Taxable', kind: 'brokerage', tracking: 'lots' }).id
    buy(first)
    expect(await backfill()).toMatchObject({ backfilled: 2 })
    expect(await daily()).toEqual([])
    // The fetchers set the very flags the sweep knows by name.
    expect(metaKeys(db, /VTI/)).toEqual([priceFlags.backfillDone('VTI'), priceFlags.dailyFetched('VTI')].sort())
    expect(await backfill()).toMatchObject({ backfilled: 0 }) // done: not fetched again
    expect(calls).toBe(1)

    deleteInvestAccount(db, first)
    expect(metaKeys(db, /VTI/)).toEqual([])
    expect(count(db, 'prices')).toBe(0)

    buy(createInvestAccount(db, { name: 'Taxable again', kind: 'brokerage', tracking: 'lots' }).id)
    expect(await backfill()).toMatchObject({ backfilled: 2 })
    expect(calls).toBe(2)
    expect(count(db, 'prices')).toBe(2)
    expect(await daily()).toEqual([])
    expect(count(db, 'prices_daily')).toBe(1)
  })
})

/* ---------- B6 · the activity ledger ---------- */

describe('listTrades: the whole ledger, newest first (B6)', () => {
  it('is unbounded, narrows by account, symbol and year, and carries realized gains and lot dependents', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Taxable', kind: 'brokerage', tracking: 'lots' }).id
    const r = createInvestAccount(db, { name: 'Roth', kind: 'retirement', tracking: 'lots' }).id
    const buy = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', qty: '1', totalCents: 100_00 }
    const ids: number[] = []
    for (let i = 0; i < 60; i++) ids.push(createTrade(db, { ...buy, tradedOn: `2025-0${1 + (i % 9)}-1${i % 10}` }, TODAY).id)
    const sell = createTrade(db, { ...buy, side: 'sell', tradedOn: '2026-09-01', qty: '2', totalCents: 300_00 }, TODAY).id
    createTrade(db, { ...buy, investAccountId: r, symbol: 'QQQ', tradedOn: '2026-03-02' }, TODAY)

    const all = listTrades(db)
    expect(all).toHaveLength(62) // no LIMIT 50
    expect(all[0]!.id).toBe(sell)
    expect(all.map((t) => t.traded_on)).toEqual([...all.map((t) => t.traded_on)].sort().reverse())
    expect(listTrades(db, { accountId: String(r) }).map((t) => t.symbol)).toEqual(['QQQ'])
    expect(listTrades(db, { symbol: 'vti' })).toHaveLength(61)
    expect(listTrades(db, { year: '2026' }).map((t) => t.id).sort()).toEqual([sell, sell + 1])
    expect(listTrades(db, { accountId: a, year: '2026', symbol: 'VTI' }).map((t) => t.id)).toEqual([sell])

    // FIFO took the two earliest-acquired lots: both long-term, $50 each.
    const s = all.find((t) => t.id === sell)!
    expect(s).toMatchObject({
      side: 'sell', symbol: 'VTI', account_name: 'Taxable', invest_account_id: a, asset_id: 1, sold_lot_trade_id: null, basis_cents: null,
      realized: { st_cents: 0, lt_cents: 100_00, zero_basis_cents: 0 },
    })
    expect(s.dependents).toBeUndefined()
    const byId = new Map(all.map((t) => [t.id, t]))
    const firstTwo = [...ids].sort((x, y) => byId.get(x)!.traded_on.localeCompare(byId.get(y)!.traded_on) || x - y).slice(0, 2)
    for (const id of ids) expect(byId.get(id)!.dependents).toBe(firstTwo.includes(id) ? 1 : 0)

    expect(failure(() => listTrades(db, { accountId: 'x' }))).toMatchObject({ status: 400 })
    expect(failure(() => listTrades(db, { year: '26' }))).toMatchObject({ status: 400 })
  })
})

describe('deleteTrade (B6)', () => {
  const setup = () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Taxable', kind: 'brokerage', tracking: 'lots' }).id
    const b = createInvestAccount(db, { name: 'Other', kind: 'brokerage', tracking: 'lots' }).id
    const t = (x: Record<string, unknown>) =>
      createTrade(db, { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', qty: '10', ...x }, TODAY).id
    return { db, a, b, t }
  }
  const realizedBy = (db: DbLike) => new Map(listTrades(db).filter((x) => x.side === 'sell').map((x) => [x.id, x.realized!]))
  const taxRealized = (db: DbLike) => {
    const i = getTax(db, TODAY).incomes
    return { st: i.realizedStCents, lt: i.realizedLtCents }
  }

  it("deleting a buy keeps every dependent sale's realized gain: a FIFO sale is split, a chosen-lot sale carries the basis", () => {
    const { db, a, t } = setup()
    const l1 = t({ tradedOn: '2020-03-02', totalCents: 1_500_00 })
    const l2 = t({ tradedOn: '2026-01-05', totalCents: 2_500_00 })
    const fifo = t({ side: 'sell', tradedOn: '2026-06-01', qty: '15', totalCents: 4_500_00 }) // 10 of L1 (LT) + 5 of L2 (ST)
    const chosen = t({ side: 'sell', tradedOn: '2026-07-01', qty: '3', totalCents: 1_000_00, soldLotTradeId: l2 })
    const before = realizedBy(db)
    const tax = taxRealized(db)
    expect(before.get(fifo)).toMatchObject({ lt_cents: 3_000_00 - 1_500_00, st_cents: 1_500_00 - 1_250_00 })
    expect(listTrades(db).find((x) => x.id === l1)!.dependents).toBe(1)
    expect(listTrades(db).find((x) => x.id === l2)!.dependents).toBe(2)

    expect(deleteTrade(db, l1)).toEqual({ ok: true, id: l1, rewritten: 1, unlinkedVests: 0, withholdingRemoved: 0 })
    expect(taxRealized(db)).toEqual(tax)
    const rows = listTrades(db, { accountId: a })
    const twin = rows.find((x) => x.side === 'sell' && x.acquired_on === '2020-03-02')!
    expect(twin).toMatchObject({ traded_on: '2026-06-01', qty_micro: 10_000_000, total_cents: 3_000_00, basis_cents: 1_500_00, sold_lot_trade_id: null })
    const rest = rows.find((x) => x.id === fifo)!
    expect(rest).toMatchObject({ qty_micro: 5_000_000, total_cents: 1_500_00, acquired_on: null, basis_cents: null })
    // The split pair realizes exactly what the one sale did, term by term.
    expect(twin.realized!.lt_cents + rest.realized!.lt_cents).toBe(before.get(fifo)!.lt_cents)
    expect(twin.realized!.st_cents + rest.realized!.st_cents).toBe(before.get(fifo)!.st_cents)
    expect(rows.find((x) => x.id === chosen)!.realized).toEqual(before.get(chosen))
    expect(getPortfolio(db, TODAY).positions[0]!.lots).toMatchObject([{ trade_id: l2, qty_micro: 2_000_000 }])

    // Now L2: both sales that took from it become explicit, gains untouched.
    expect(deleteTrade(db, l2)).toMatchObject({ rewritten: 2 })
    expect(taxRealized(db)).toEqual(tax)
    expect(listTrades(db).find((x) => x.id === chosen)).toMatchObject({ sold_lot_trade_id: null, acquired_on: '2026-01-05', basis_cents: 750_00 })
    expect(getPortfolio(db, TODAY).positions).toEqual([])
    expect(getPortfolio(db, TODAY).warnings).toEqual([])
  })

  it("a FIFO sale split across terms keeps each lot's exact proceeds, where re-running FIFO on the rest would round a cent across", () => {
    const { db, a, t } = setup()
    const l1 = t({ tradedOn: '2024-01-02', qty: '1', totalCents: 200_00 }) // long-term by the sale
    const l2 = t({ tradedOn: '2025-11-03', qty: '1', totalCents: 200_00 }) // short-term
    const l3 = t({ tradedOn: '2025-12-01', qty: '1', totalCents: 200_00 }) // short-term
    // FIFO over 3 shares for $1,000.00 allots 333.33 / 333.34 / 333.33. A 2-share FIFO
    // remainder for 666.67 would allot round(333.335) = 333.34 to L1 and move a cent from short- to long-term.
    const sale = t({ side: 'sell', tradedOn: '2026-03-02', qty: '3', totalCents: 1_000_00 })
    const before = realizedBy(db).get(sale)!
    expect(before).toEqual({ st_cents: 266_67, lt_cents: 133_33, zero_basis_cents: 0 })
    const tax = taxRealized(db)

    expect(deleteTrade(db, l3)).toEqual({ ok: true, id: l3, rewritten: 1, unlinkedVests: 0, withholdingRemoved: 0 })
    expect(taxRealized(db)).toEqual(tax)
    const pieces = listTrades(db, { accountId: a }).filter((x) => x.side === 'sell' && x.traded_on === '2026-03-02')
    // Each lot the sale took is now a sale of that lot, at the proceeds it had; L3's part carries its basis.
    expect(pieces.map((x) => [x.sold_lot_trade_id, x.acquired_on, x.basis_cents, x.qty_micro, x.total_cents]).sort()).toEqual(
      [
        [l1, null, null, 1_000_000, 333_33],
        [l2, null, null, 1_000_000, 333_34],
        [null, '2025-12-01', 200_00, 1_000_000, 333_33],
      ].sort(),
    )
    expect(pieces.find((x) => x.id === sale)).toMatchObject({ sold_lot_trade_id: l1 })
    const sum = (k: 'st_cents' | 'lt_cents') => pieces.reduce((n, x) => n + x.realized![k], 0)
    expect([sum('st_cents'), sum('lt_cents')]).toEqual([before.st_cents, before.lt_cents])
    expect(getPortfolio(db, TODAY).positions).toEqual([])
  })

  it("the FK case: a legacy vest link and stray picks of the lot don't block the delete, and nothing's gain moves", () => {
    const { db, a, b, t } = setup()
    const lot = t({ tradedOn: '2026-03-02', totalCents: 1_000_00 })
    db.prepare("INSERT INTO rsu_vests (invest_account_id, asset_id, vest_on, qty_micro, converted_trade_id) VALUES (?, 1, '2026-03-02', 10000000, ?)").run(a, lot)
    const legacy = db.prepare(
      "INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id) VALUES (?, 1, ?, 'sell', ?, ?, ?)",
    )
    const crossAccount = Number(legacy.run(b, '2026-05-01', 2_000_000, 300_00, lot).lastInsertRowid) // pooled elsewhere: never resolved
    const tooEarly = Number(legacy.run(a, '2026-02-01', 1_000_000, 150_00, lot).lastInsertRowid) // before the lot existed
    // A raw delete trips the foreign keys — the case deleteTrade has to handle.
    expect(() => db.prepare('DELETE FROM trades WHERE id = ?').run(lot)).toThrow(/FOREIGN KEY/)
    const tax = taxRealized(db)
    const warnings = getPortfolio(db, TODAY).warnings
    expect(warnings).toHaveLength(2)

    expect(deleteTrade(db, lot)).toEqual({ ok: true, id: lot, rewritten: 2, unlinkedVests: 1, withholdingRemoved: 0 })
    expect(taxRealized(db)).toEqual(tax)
    expect(db.prepare('SELECT converted_trade_id FROM rsu_vests').get()).toEqual({ converted_trade_id: null })
    // They were zero-basis all along; now that says so explicitly.
    const rows = new Map(listTrades(db).map((x) => [x.id, x]))
    expect(rows.get(crossAccount)).toMatchObject({ sold_lot_trade_id: null, acquired_on: '2026-05-01', basis_cents: 0, realized: { st_cents: 300_00 } })
    expect(rows.get(tooEarly)).toMatchObject({ sold_lot_trade_id: null, acquired_on: '2026-02-01', basis_cents: 0, realized: { st_cents: 150_00 } })
  })

  it('deleting a sell: its gain goes and later FIFO sales take the lots it had taken', () => {
    const { db, t } = setup()
    const l1 = t({ tradedOn: '2024-01-10', totalCents: 1_000_00 })
    t({ tradedOn: '2025-06-02', totalCents: 2_000_00 })
    const s1 = t({ side: 'sell', tradedOn: '2026-02-02', totalCents: 2_500_00 })
    const s2 = t({ side: 'sell', tradedOn: '2026-03-02', totalCents: 2_500_00 })
    expect(realizedBy(db).get(s2)).toEqual({ st_cents: 500_00, lt_cents: 0, zero_basis_cents: 0 }) // the 2025 lot
    expect(deleteTrade(db, s1)).toEqual({ ok: true, id: s1, rewritten: 0, unlinkedVests: 0, withholdingRemoved: 0 })
    expect(realizedBy(db).get(s2)).toEqual({ st_cents: 0, lt_cents: 1_500_00, zero_basis_cents: 0 }) // now the 2024 lot
    expect(getPortfolio(db, TODAY).positions[0]!.lots.map((l) => l.trade_id)).not.toContain(l1)
  })

  it("an asset left with no trades goes, so a symbol recorded under the wrong kind can be recorded again", () => {
    const { db, a, t } = setup()
    const wrong = t({ symbol: 'SOL', tradedOn: '2026-09-01', totalCents: 1_500_00 })
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-19', 100)").run()
    expect(failure(() => createTrade(db, { investAccountId: a, symbol: 'SOL', assetKind: 'crypto', side: 'buy', tradedOn: '2026-09-02', qty: '1', totalCents: 1 }, TODAY)))
      .toMatchObject({ status: 400, message: /already recorded as a stock/ })
    deleteTrade(db, wrong)
    expect(count(db, 'assets')).toBe(0)
    expect(count(db, 'prices')).toBe(0)
    createTrade(db, { investAccountId: a, symbol: 'SOL', assetKind: 'crypto', side: 'buy', tradedOn: '2026-09-02', qty: '1', totalCents: 150_00 }, TODAY)
    expect(db.prepare('SELECT kind FROM assets').get()).toEqual({ kind: 'crypto' })
  })

  it('404 for a trade that does not exist, and nothing is written', () => {
    const { db, t } = setup()
    t({ tradedOn: '2026-09-01', totalCents: 1 })
    const before = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    expect(failure(() => deleteTrade(db, 999))).toMatchObject({ status: 404 })
    expect(failure(() => deleteTrade(db, Number('x')))).toMatchObject({ status: 404 })
    expect((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n).toBe(before)
  })
})

describe('updateTrade: edits are re-validated against the whole holding (B6)', () => {
  const setup = () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Taxable', kind: 'brokerage', tracking: 'lots' }).id
    const b = createInvestAccount(db, { name: 'Other', kind: 'brokerage', tracking: 'lots' }).id
    const t = (x: Record<string, unknown>) =>
      createTrade(db, { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', qty: '10', ...x }, TODAY).id
    const lot = t({ tradedOn: '2024-01-10', totalCents: 1_000_00 })
    const fifo = t({ side: 'sell', tradedOn: '2026-03-02', qty: '6', totalCents: 1_800_00 })
    const chosen = t({ side: 'sell', tradedOn: '2026-04-01', qty: '3', totalCents: 900_00, soldLotTradeId: lot })
    return { db, a, b, lot, fifo, chosen }
  }
  const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

  it('refuses an edit that leaves another sale short of shares, and writes nothing', () => {
    const { db, lot, fifo, chosen } = setup()
    const n = changes(db)
    expect(failure(() => updateTrade(db, lot, { qty: '8' }, TODAY))).toMatchObject({ status: 400, message: /2026-04-01 sale of 3 VTI in Taxable short 1 share it/ })
    expect(failure(() => updateTrade(db, lot, { tradedOn: '2026-03-15' }, TODAY))).toMatchObject({ status: 400, message: /2026-03-02 sale/ })
    expect(failure(() => updateTrade(db, fifo, { qty: '8' }, TODAY))).toMatchObject({ status: 400, message: /2026-04-01 sale/ })
    // The chosen-lot rule itself: a sale can't move ahead of its lot.
    expect(failure(() => updateTrade(db, chosen, { tradedOn: '2023-12-01' }, TODAY))).toMatchObject({ status: 400, message: /bought on 2024-01-10, after this sale/ })
    expect(failure(() => updateTrade(db, fifo, { tradedOn: '2999-01-01' }, TODAY))).toMatchObject({ status: 400, message: /after today/ })
    expect(failure(() => updateTrade(db, fifo, { qty: 'ten' }, TODAY))).toMatchObject({ status: 400 })
    expect(changes(db)).toBe(n)
  })

  it("keeps a trade's identity: account, symbol, kind, side and note are fixed", () => {
    const { db, b, fifo } = setup()
    for (const patch of [{ side: 'buy' }, { symbol: 'QQQ' }, { investAccountId: b }, { assetKind: 'crypto' }])
      expect(failure(() => updateTrade(db, fifo, patch, TODAY))).toMatchObject({ status: 400, message: /can't change/ })
    expect(failure(() => updateTrade(db, fifo, { note: 'RSU vest' }, TODAY))).toMatchObject({ status: 400, message: /note/ })
    // Sending the same identity back is fine (a client may send the whole row).
    expect(updateTrade(db, fifo, { symbol: 'vti', side: 'sell', assetKind: 'stock', note: null }, TODAY)).toEqual({ ok: true, id: fifo, changed: false, affected: 0 })
    expect(failure(() => updateTrade(db, 999, { qty: '1' }, TODAY))).toMatchObject({ status: 404 })
  })

  it('a corrected cost moves the gains of the sales that took from the lot; an unchanged edit writes nothing', () => {
    const { db, lot, fifo, chosen } = setup()
    expect(getTax(db, TODAY).incomes.realizedLtCents).toBe(1_800_00 - 600_00 + 900_00 - 300_00)
    expect(updateTrade(db, lot, { totalCents: 1_200_00 }, TODAY)).toEqual({ ok: true, id: lot, changed: true, affected: 2 })
    expect(getTax(db, TODAY).incomes.realizedLtCents).toBe(1_800_00 - 720_00 + 900_00 - 360_00)
    const n = changes(db)
    expect(updateTrade(db, lot, { totalCents: 1_200_00, qty: '10.000' }, TODAY)).toMatchObject({ changed: false })
    expect(changes(db)).toBe(n)
    // A sale can switch to an explicit basis; the chosen-lot sale after it is unaffected.
    expect(updateTrade(db, fifo, { acquiredOn: '2019-01-02', basisCents: 100_00 }, TODAY)).toEqual({ ok: true, id: fifo, changed: true, affected: 0 })
    const rows = new Map(listTrades(db).map((x) => [x.id, x]))
    expect(rows.get(fifo)).toMatchObject({ acquired_on: '2019-01-02', basis_cents: 100_00, realized: { lt_cents: 1_700_00 } })
    expect(rows.get(chosen)!.realized).toEqual({ st_cents: 0, lt_cents: 900_00 - 360_00, zero_basis_cents: 0 })
    // …and back to FIFO by clearing both.
    updateTrade(db, fifo, { acquiredOn: null, basisCents: null }, TODAY)
    expect(listTrades(db).find((x) => x.id === fifo)!.realized).toEqual({ st_cents: 0, lt_cents: 1_800_00 - 720_00, zero_basis_cents: 0 })
    // A chosen lot and an explicit basis at once is refused, as for a new trade.
    expect(failure(() => updateTrade(db, chosen, { acquiredOn: '2019-01-02', basisCents: 1 }, TODAY))).toMatchObject({ status: 400, message: /excludes explicit basis/ })
  })

  it("a buy's acquisition date can be corrected; FIFO follows it", () => {
    const { db, a, lot } = setup()
    const later = createTrade(db, { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2025-02-03', qty: '5', totalCents: 500_00 }, TODAY).id
    updateTrade(db, later, { acquiredOn: '2020-01-02' }, TODAY)
    // The corrected lot is now the older one: FIFO's 2026-03-02 sale takes it first.
    const lots = getPortfolio(db, TODAY).positions[0]!.lots
    expect(lots.map((l) => [l.trade_id, l.opened_on])).toEqual([[lot, '2024-01-10']])
    expect(failure(() => updateTrade(db, later, { acquiredOn: '2025-02-04' }, TODAY))).toMatchObject({ status: 400, message: /on or before tradedOn/ })
  })
})

describe('account profiles: type, institution, owner, last 4 (B8, migration #18)', () => {
  it('a type card is enough: the subtype brings its kind, and the profile is trimmed and normalised', () => {
    const db = mem()
    const k = createInvestAccount(db, { name: ' Fidelity 401(k) ', subtype: '401k', tracking: 'balance', institution: ' Fidelity ', owner: 'Nicole', mask: '••1234' })
    expect(k).toMatchObject({ name: 'Fidelity 401(k)', kind: 'retirement', tracking: 'balance', subtype: '401k', institution: 'Fidelity', owner: 'Nicole', mask: '1234', sort: 0, stock_plan: 0 })
    expect(k.counts).toEqual({ trades: 0, balances: 0, unvested: 0, paychecks: 0 })
    const joint = createInvestAccount(db, { name: 'Schwab', subtype: 'taxable', tracking: 'lots', owner: 'joint', mask: 'XXXX-ab12', institution: '' })
    expect(joint).toMatchObject({ kind: 'brokerage', owner: null, mask: 'AB12', institution: null })
    // The old shape — kind and tracking, no profile — still works, and infers its type.
    expect(createInvestAccount(db, { name: 'Old', kind: 'crypto', tracking: 'lots' })).toMatchObject({ subtype: null, owner: null, mask: null })
    expect(createInvestAccount(db, { name: 'Private shares', subtype: 'other', kind: 'brokerage', tracking: 'balance' })).toMatchObject({ subtype: 'other', kind: 'brokerage' })
    expect(listInvestAccounts(db).map((a) => a.name)).toEqual(['Fidelity 401(k)', 'Schwab', 'Old', 'Private shares'])
  })

  it('refuses a kind that contradicts the type, and a malformed profile, before writing anything', () => {
    const db = mem()
    const before = count(db, 'invest_accounts')
    for (const [b, message] of [
      [{ name: 'Roth', subtype: 'roth_ira', kind: 'brokerage', tracking: 'lots' }, /Roth IRA is kind retirement, not brokerage/],
      [{ name: 'Mystery', subtype: 'other', tracking: 'lots' }, /kind \(brokerage\|retirement\|crypto\)/],
      [{ name: 'X', subtype: 'annuity', tracking: 'balance' }, /subtype must be one of/],
      [{ name: 'X', subtype: 'taxable', tracking: 'lots', mask: '12345' }, /last 4/],
      [{ name: 'X', subtype: 'taxable', tracking: 'lots', mask: '1' }, /last 4/],
      [{ name: 'X'.repeat(61), subtype: 'taxable', tracking: 'lots' }, /at most 60/],
      [{ name: 'X', subtype: 'taxable', tracking: 'lots', owner: 'N'.repeat(41) }, /owner: at most 40/],
      [{ name: 'X', subtype: 'taxable', tracking: 'lots', institution: 7 }, /institution must be text/],
      [{ name: 'HSA', subtype: 'hsa', tracking: 'balance', stockPlan: true }, /track trades/],
    ] as const)
      expect(failure(() => createInvestAccount(db, b as never)), JSON.stringify(b)).toMatchObject({ status: 400, message })
    expect(count(db, 'invest_accounts')).toBe(before)
  })

  it('patches the profile; blank clears; a patch that changes nothing writes nothing', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Schwab', subtype: 'taxable', tracking: 'lots' }).id
    const r = updateInvestAccount(db, a, { institution: 'Charles Schwab', owner: 'Max', mask: '9876', name: 'Schwab brokerage' })
    expect(r).toMatchObject({ ok: true, changed: true, account: { id: a, name: 'Schwab brokerage', institution: 'Charles Schwab', owner: 'Max', mask: '9876' } })
    const n = totalChanges(db)
    expect(updateInvestAccount(db, a, { institution: ' Charles Schwab ', owner: 'Max', mask: '9876', subtype: 'taxable' })).toMatchObject({ changed: false })
    expect(totalChanges(db)).toBe(n)
    expect(updateInvestAccount(db, a, { institution: '', owner: null, mask: null }).account).toMatchObject({ institution: null, owner: null, mask: null })
    expect(updateInvestAccount(db, a, { owner: 'JOINT' }).changed).toBe(false) // joint is null
    expect(failure(() => updateInvestAccount(db, a, { name: '  ' }))).toMatchObject({ status: 400, message: /name required/ })
    expect(failure(() => updateInvestAccount(db, 999, { name: 'x' }))).toMatchObject({ status: 404 })
  })

  it('orders the strip by sort, then id', () => {
    const db = mem()
    const ids = ['A', 'B', 'C'].map((name) => createInvestAccount(db, { name, subtype: 'taxable', tracking: 'lots' }).id)
    updateInvestAccount(db, ids[0]!, { sort: 2 })
    updateInvestAccount(db, ids[2]!, { sort: -1 })
    expect(listInvestAccounts(db).map((a) => a.name)).toEqual(['C', 'B', 'A'])
    expect(failure(() => updateInvestAccount(db, ids[1]!, { sort: 1.5 }))).toMatchObject({ status: 400, message: /sort/ })
  })

  it("a new type brings its kind along — and moves the account's sales off the tax bill", () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Misfiled', subtype: 'taxable', tracking: 'lots' }).id
    const buy = { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-02', qty: '10', totalCents: 1_000_00 }
    createTrade(db, buy, TODAY)
    createTrade(db, { ...buy, side: 'sell', tradedOn: '2026-06-01', totalCents: 1_300_00 }, TODAY)
    expect(getTax(db, TODAY).incomes).toMatchObject({ realizedStCents: 300_00, realizedShelteredCents: 0 })

    expect(updateInvestAccount(db, a, { subtype: 'roth_ira' }).account).toMatchObject({ subtype: 'roth_ira', kind: 'retirement' })
    expect(getTax(db, TODAY).incomes).toMatchObject({ realizedStCents: 0, realizedShelteredCents: 300_00 })
    expect(getPortfolio(db, TODAY).totals).toMatchObject({ ytd_st: 0, ytd_sheltered: 300_00 })

    // A kind that contradicts the type is refused; 'other' goes with any kind.
    expect(failure(() => updateInvestAccount(db, a, { kind: 'brokerage' }))).toMatchObject({ status: 400, message: /Roth IRA is kind retirement/ })
    expect(updateInvestAccount(db, a, { subtype: 'other', kind: 'brokerage' }).account).toMatchObject({ subtype: 'other', kind: 'brokerage' })
    expect(getTax(db, TODAY).incomes.realizedStCents).toBe(300_00)
    // An untyped (legacy) account's kind changes freely.
    const legacy = createInvestAccount(db, { name: 'Legacy', kind: 'brokerage', tracking: 'balance' }).id
    expect(updateInvestAccount(db, legacy, { kind: 'retirement' }).account).toMatchObject({ kind: 'retirement', subtype: null })
  })
})

describe('changing how an account is tracked is guarded (B8)', () => {
  it('lots → balance only while no trade is recorded', () => {
    const db = mem()
    const a = createInvestAccount(db, { name: 'Schwab', subtype: 'taxable', tracking: 'lots' }).id
    createTrade(db, { investAccountId: a, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-02-02', qty: '1', totalCents: 100_00 }, TODAY)
    const n = totalChanges(db)
    expect(failure(() => updateInvestAccount(db, a, { tracking: 'balance', name: 'Renamed' }))).toMatchObject({ status: 400, message: /Schwab has 1 trade — tracking it by balance/ })
    expect(totalChanges(db)).toBe(n)
    expect(listInvestAccounts(db)[0]).toMatchObject({ name: 'Schwab', tracking: 'lots' })

    const empty = createInvestAccount(db, { name: 'Empty', subtype: 'ira', tracking: 'lots' }).id
    expect(updateInvestAccount(db, empty, { tracking: 'balance' }).account.tracking).toBe('balance')
  })

  it('balance → lots only while no balance is recorded', () => {
    const db = mem()
    const k = createInvestAccount(db, { name: '401(k)', subtype: '401k', tracking: 'balance' }).id
    putBalanceSnapshot(db, { investAccountId: k, balances: [{ balancedOn: '2026-03-31', balanceCents: 1 }, { balancedOn: '2026-06-30', balanceCents: 2 }] }, TODAY)
    expect(failure(() => updateInvestAccount(db, k, { tracking: 'lots' }))).toMatchObject({ status: 400, message: /401\(k\) has 2 balance updates/ })
    deleteBalanceSnapshot(db, k, '2026-03-31')
    deleteBalanceSnapshot(db, k, '2026-06-30')
    expect(updateInvestAccount(db, k, { tracking: 'lots' }).account.tracking).toBe('lots')
  })

  it('a stock plan has to track trades: switching it to balance needs the plan off first', () => {
    const db = mem()
    const plan = createInvestAccount(db, { name: 'Acme plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true }).id
    expect(failure(() => updateInvestAccount(db, plan, { tracking: 'balance' }))).toMatchObject({ status: 400, message: /stock plan has to track trades/ })
    expect(updateInvestAccount(db, plan, { tracking: 'balance', stockPlan: false }).account).toMatchObject({ tracking: 'balance', stock_plan: 0 })
    expect(failure(() => updateInvestAccount(db, plan, { tracking: 'wallet' }))).toMatchObject({ status: 400 })
  })
})

describe('one account, as its drawer shows it (B8)', () => {
  it('its own positions and totals — exactly its share of the portfolio — its balances, grants and counts', () => {
    const db = mem()
    seedHousehold(db)
    const taxable = getInvestAccount(db, 1, TODAY)
    expect(taxable.account).toMatchObject({ id: 1, name: 'Taxable', tracking: 'lots' })
    expect(taxable.counts).toEqual({ trades: 2, balances: 0, unvested: 0, paychecks: 0 })
    expect(taxable.positions.map((p) => [p.symbol, p.qty_micro, p.accounts.map((a) => a.invest_account_id)])).toEqual([['VTI', 6_000_000, [1]]])
    expect(taxable.balances).toEqual([])
    expect(taxable.totals.ytd_st).not.toBe(0)

    // Each lots account's detail is its slice of getPortfolio, to the cent.
    const pf = getPortfolio(db, TODAY)
    const lotsIds = listInvestAccounts(db).filter((a) => a.tracking === 'lots').map((a) => a.id)
    const details = lotsIds.map((id) => getInvestAccount(db, id, TODAY))
    expect(details.reduce((s, d) => s + d.totals.value, 0)).toBe(pf.totals.value)
    expect(details.reduce((s, d) => s + d.totals.ytd_st + d.totals.ytd_lt, 0)).toBe(pf.totals.ytd_st + pf.totals.ytd_lt)
    for (const d of details)
      for (const p of d.positions) {
        const share = pf.positions.find((x) => x.asset_id === p.asset_id)!.accounts.find((a) => a.invest_account_id === d.account.id)!
        expect([p.value_cents, p.cost_cents, p.qty_micro]).toEqual([share.value_cents, share.cost_cents, share.qty_micro])
        expect(p.lots.every((l) => l.invest_account_id === d.account.id)).toBe(true)
      }
    expect(getInvestAccount(db, 2, TODAY).positions[0]!.lots[0]!.sheltered).toBe(true)

    const k = getInvestAccount(db, 3, TODAY)
    expect(k.positions).toEqual([])
    expect(k.balances.map((b) => b.balanced_on)).toEqual(['2026-06-30', '2026-03-31'])
    expect(k.totals.value).toBe(0)
  })

  it("lists only this account's grants, and 404s for an account that doesn't exist", () => {
    const db = mem()
    const plan = createInvestAccount(db, { name: 'Acme plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true }).id
    const other = createInvestAccount(db, { name: 'Other plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true }).id
    putUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '100', nextVestOn: '2026-11-15', vestEveryMonths: 3, vestQty: '25' }, TODAY)
    putUnvested(db, { investAccountId: other, symbol: 'OTHR', qty: '5' }, TODAY)
    expect(getInvestAccount(db, plan, TODAY).grants).toEqual([
      expect.objectContaining({ invest_account_id: plan, symbol: 'ACME', qty_micro: 100_000_000, next_vest_on: '2026-11-15', vest_every_months: 3, est_cents: null }),
    ])
    expect(getInvestAccount(db, plan, TODAY).counts.unvested).toBe(1)
    for (const id of [999, 0, Number.NaN]) expect(failure(() => getInvestAccount(db, id, TODAY))).toMatchObject({ status: 404 })
  })
})

describe('who accounts can belong to (B8)', () => {
  it('paycheck earners in their order, then other owners named on accounts — once each, never "Joint"', () => {
    const db = mem()
    expect(listInvestOwners(db)).toEqual([])
    const pay = db.prepare("INSERT INTO pay_sources (earner, cadence, paid_on, gross_cents, sort) VALUES (?, 'biweekly', '2026-09-01', 100, ?)")
    pay.run('Nicole', 1)
    pay.run('Max', 0)
    pay.run('max', 2)
    createInvestAccount(db, { name: 'A', subtype: 'taxable', tracking: 'lots', owner: 'Grandma' })
    createInvestAccount(db, { name: 'B', subtype: 'taxable', tracking: 'lots', owner: 'Nicole' })
    createInvestAccount(db, { name: 'C', subtype: 'taxable', tracking: 'lots', owner: 'Joint' })
    expect(listInvestOwners(db)).toEqual(['Max', 'Nicole', 'Grandma'])
  })
})

/* ---------- B12 · the brokerage cash anchor ---------- */

describe('the cash anchor: a lots account’s cash keeps sale proceeds in net worth (B12, bug #10)', () => {
  /** A taxable account holding 10 VTI (cost $1,000) priced at $150. */
  function broker(o: { anchor?: { on: string; cents: number } } = {}) {
    const db = mem()
    const acct = createInvestAccount(db, { name: 'Schwab', subtype: 'taxable', tracking: 'lots' }).id
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-03-02', qty: '10', totalCents: 1_000_00 }, TODAY)
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-09-01', 150_00)").run()
    if (o.anchor) putBalanceSnapshot(db, { investAccountId: acct, balancedOn: o.anchor.on, balanceCents: o.anchor.cents }, TODAY)
    const lotsValue = () => netWorthSeries(db, TODAY).at(-1)!.brokerage
    return { db, acct, lotsValue }
  }
  const sell4 = (db: DbLike, acct: number) =>
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'sell', tradedOn: '2026-09-10', qty: '4', totalCents: 600_00 }, TODAY)

  it('a sale at market leaves net worth unchanged: the shares become cash', () => {
    const { db, acct, lotsValue } = broker({ anchor: { on: '2026-08-31', cents: 500_00 } })
    expect(lotsValue()).toBe(1_500_00 + 500_00)
    sell4(db, acct)
    expect(lotsValue()).toBe(900_00 + 1_100_00)
    const p = getPortfolio(db, TODAY)
    expect(p.totals).toMatchObject({ value: 900_00, cash: 1_100_00 })
    expect(p.accounts).toEqual([
      {
        invest_account_id: acct, name: 'Schwab', kind: 'brokerage', value_cents: 900_00,
        cash_cents: 1_100_00, cash_as_of: '2026-08-31', cash_anchor_cents: 500_00, cash_trades: 1, uncounted_proceeds_cents: 0,
      },
    ])
    // value + cash is exactly what net worth counts for the account.
    expect(p.totals.value + p.totals.cash).toBe(lotsValue())
    expect(p.warnings).toEqual([])
  })

  it('an account with no cash balance behaves as before: the proceeds leave net worth, and say how much', () => {
    const { db, acct, lotsValue } = broker()
    sell4(db, acct)
    expect(lotsValue()).toBe(900_00)
    const p = getPortfolio(db, TODAY)
    expect(p.totals.cash).toBe(0)
    expect(p.accounts[0]).toMatchObject({ cash_cents: null, cash_as_of: null, cash_trades: 0, uncounted_proceeds_cents: 600_00 })
  })

  it('vests, starting positions, booked-late buys and withheld shares never move cash; buys after the anchor do', () => {
    const { db, acct, lotsValue } = broker({ anchor: { on: '2026-09-01', cents: 2_000_00 } })
    updateInvestAccount(db, acct, { stockPlan: true })
    putUnvested(db, { investAccountId: acct, symbol: 'ACME', qty: '10' }, TODAY)
    vestUnvested(db, { investAccountId: acct, symbol: 'ACME', qty: '10', tradedOn: '2026-09-05', totalCents: 1_000_00, withheldQty: '4' }, TODAY)
    createOpeningPositions(db, { investAccountId: acct, asOf: '2026-09-06', rows: [{ symbol: 'BND', qty: '5', basisCents: 300_00, acquiredOn: '2021-01-04' }] }, TODAY)
    createTrade(db, { investAccountId: acct, symbol: 'QQQ', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-07', qty: '1', totalCents: 450_00, acquiredOn: '2025-02-03' }, TODAY)
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-01', qty: '1', totalCents: 150_00 }, TODAY) // on the anchor day: already in it
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-08', qty: '2', totalCents: 300_00 }, TODAY)
    const a = getPortfolio(db, TODAY).accounts[0]!
    expect(a).toMatchObject({ cash_cents: 2_000_00 - 300_00, cash_trades: 1 })
    expect(getPortfolio(db, TODAY).totals.value + a.cash_cents!).toBe(lotsValue())
  })

  it('warns when the trades since the anchor take cash below $0 — not for a margin balance recorded as one', () => {
    const { db, acct } = broker({ anchor: { on: '2026-09-01', cents: 100_00 } })
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-02', qty: '3', totalCents: 500_00 }, TODAY)
    const p = getPortfolio(db, TODAY)
    expect(p.accounts[0]!.cash_cents).toBe(-400_00)
    expect(p.warnings).toEqual([
      'Cash · Schwab: -$400.00 after the trades since the 2026-09-01 cash balance — a deposit Scarab doesn’t know about? Update the cash balance.',
    ])
    putBalanceSnapshot(db, { investAccountId: acct, balancedOn: '2026-09-03', balanceCents: -2_000_00 }, TODAY) // on margin
    expect(getPortfolio(db, TODAY).warnings).toEqual([])
    expect(getPortfolio(db, TODAY).totals.cash).toBe(-2_000_00)
  })

  it('past months count the cash as of their month end; months before the first anchor have none', () => {
    const { db, acct } = broker({ anchor: { on: '2026-06-30', cents: 1_000_00 } })
    createTrade(db, { investAccountId: acct, symbol: 'VTI', assetKind: 'stock', side: 'sell', tradedOn: '2026-07-15', qty: '2', totalCents: 300_00 }, TODAY)
    const byMonth = new Map(netWorthSeries(db, TODAY).map((p) => [p.month, p.brokerage]))
    // No VTI price before September: shares carry at cost ($100 each).
    expect(byMonth.get('2026-05')).toBe(1_000_00)
    expect(byMonth.get('2026-06')).toBe(1_000_00 + 1_000_00)
    expect(byMonth.get('2026-07')).toBe(800_00 + 1_300_00)
    expect(byMonth.get('2026-09')).toBe(8 * 150_00 + 1_300_00)
  })

  it("the account drawer carries the same cash; a balance account's is null", () => {
    const { db, acct } = broker({ anchor: { on: '2026-08-31', cents: 500_00 } })
    sell4(db, acct)
    const k401 = createInvestAccount(db, { name: '401(k)', subtype: '401k', tracking: 'balance' }).id
    expect(getInvestAccount(db, acct, TODAY).cash).toEqual(getPortfolio(db, TODAY).accounts.find((a) => a.invest_account_id === acct))
    expect(getInvestAccount(db, acct, TODAY).totals.cash).toBe(1_100_00)
    expect(getInvestAccount(db, k401, TODAY).cash).toBeNull()
    expect(getPortfolio(db, TODAY).accounts.map((a) => a.name)).toEqual(['Schwab'])
  })

  it('the seeded household (no anchors) keeps net worth exactly as before', () => {
    const db = mem()
    seedHousehold(db)
    const p = getPortfolio(db, TODAY)
    expect(p.totals.cash).toBe(0)
    expect(p.accounts.map((a) => [a.name, a.cash_cents])).toEqual([['Taxable', null], ['Roth IRA', null], ['Coinbase', null]])
    expect(p.accounts[0]!.uncounted_proceeds_cents).toBeGreaterThan(0) // its VTI sale
  })
})

/* ---------- B9 · the RSU vest flow ---------- */

describe('vesting with net settlement: gross, withheld, net (B9)', () => {
  function plan() {
    const db = mem()
    const planId = createInvestAccount(db, { name: 'Acme plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true }).id
    putUnvested(db, { investAccountId: planId, symbol: 'ACME', qty: '100', nextVestOn: '2026-08-15', vestEveryMonths: 3, vestQty: '25' }, TODAY)
    const vest = (over: Partial<Parameters<typeof vestUnvested>[1]> = {}) =>
      vestUnvested(db, { investAccountId: planId, symbol: 'ACME', qty: '25', tradedOn: '2026-08-15', totalCents: 10_000_00, withheldQty: '9', ...over }, TODAY)
    const sales = () => listTrades(db).filter((t) => t.side === 'sell')
    return { db, planId, vest, sales }
  }

  it('records the gross as income and basis, the withheld shares as a $0 same-day sale, and keeps the net', () => {
    const { db, planId, vest, sales } = plan()
    putBalanceSnapshot(db, { investAccountId: planId, balancedOn: '2026-08-01', balanceCents: 50_00 }, TODAY)
    const r = vest()
    expect(r).toMatchObject({ ok: true, grossQtyMicro: 25_000_000, withheldQtyMicro: 9_000_000, netQtyMicro: 16_000_000, withheldCents: 3_600_00, remainingQtyMicro: 75_000_000 })
    expect(db.prepare('SELECT side, qty_micro, total_cents, sold_lot_trade_id, note, traded_on FROM trades ORDER BY id').all()).toEqual([
      { side: 'buy', qty_micro: 25_000_000, total_cents: 10_000_00, sold_lot_trade_id: null, note: 'RSU vest', traded_on: '2026-08-15' },
      { side: 'sell', qty_micro: 9_000_000, total_cents: 3_600_00, sold_lot_trade_id: r.tradeId, note: 'RSU withholding', traded_on: '2026-08-15' },
    ])
    expect(sales()[0]!.realized).toEqual({ st_cents: 0, lt_cents: 0, zero_basis_cents: 0 })
    const p = getPortfolio(db, TODAY)
    expect(p.positions[0]).toMatchObject({ symbol: 'ACME', qty_micro: 16_000_000, cost_cents: 6_400_00 })
    expect(p.totals.ytd_st + p.totals.ytd_lt).toBe(0)
    // Neither leg touched the account's cash; Taxes counts the gross as pay.
    expect(p.accounts[0]).toMatchObject({ cash_cents: 50_00, cash_trades: 0 })
    expect(getTax(db, TODAY).incomes.rsuYtdCents).toBe(10_000_00)
    // The vest row says what was withheld, and the withholding isn't a "dependent" of its lot.
    expect(listTrades(db).find((t) => t.side === 'buy')).toMatchObject({ withheld_qty_micro: 9_000_000, dependents: 0 })
  })

  it('realizes exactly $0 for awkward share counts and values', () => {
    let seed = 7
    const rnd = (n: number) => (seed = (seed * 48_271) % 2_147_483_647) % n
    for (let i = 0; i < 40; i++) {
      const { db, vest, sales } = plan()
      const gross = 1_000_000 + rnd(99_000_000) // 1–100 shares, to the micro-share
      const withheld = 1 + rnd(gross)
      const total = 1 + rnd(2_000_000_00)
      vest({ qty: String(gross / 1_000_000), withheldQty: String(withheld / 1_000_000), totalCents: total, allowUntracked: true })
      const s = sales()[0]!
      expect(s.realized).toEqual({ st_cents: 0, lt_cents: 0, zero_basis_cents: 0 })
      const pos = getPortfolio(db, TODAY).positions
      if (withheld < gross) expect(pos[0]!.qty_micro).toBe(gross - withheld)
      else expect(pos).toEqual([])
    }
  })

  it('no withholding: just the buy; refuses more withheld than vested, or a bad count, writing nothing', () => {
    const { db, vest } = plan()
    expect(failure(() => vest({ withheldQty: '26' }))).toMatchObject({ status: 400, message: expect.stringMatching(/more than the 25 that vested/) })
    expect(failure(() => vest({ withheldQty: 'nine' }))).toMatchObject({ status: 400, message: expect.stringMatching(/^withheldQty/) })
    expect(failure(() => vest({ qty: '0' }))).toMatchObject({ status: 400 })
    expect(count(db, 'trades')).toBe(0)
    expect(db.prepare('SELECT qty_micro FROM unvested_positions').get()).toEqual({ qty_micro: 100_000_000 })
    expect(vest({ withheldQty: '' })).toMatchObject({ withholdingTradeId: null, withheldQtyMicro: 0, netQtyMicro: 25_000_000, withheldCents: 0 })
    expect(count(db, 'trades')).toBe(1)
    expect(vest({ withheldQty: '25', tradedOn: '2026-08-16' })).toMatchObject({ netQtyMicro: 0 }) // everything withheld: nothing stays
  })

  it('correcting the vest re-prices its withholding at cost, on its day — still $0, and no other sale "affected"', () => {
    const { db, vest, sales } = plan()
    const r = vest()
    expect(updateTrade(db, r.tradeId, { totalCents: 10_125_00 }, TODAY)).toEqual({ ok: true, id: r.tradeId, changed: true, affected: 0 })
    expect(sales()[0]).toMatchObject({ total_cents: 3_645_00, realized: { st_cents: 0, lt_cents: 0 } })
    updateTrade(db, r.tradeId, { tradedOn: '2026-08-14', qty: '26' }, TODAY)
    expect(sales()[0]).toMatchObject({ traded_on: '2026-08-14', qty_micro: 9_000_000, total_cents: Math.round((10_125_00 * 9) / 26), realized: { st_cents: 0, lt_cents: 0 } })
    const before = totalChanges(db)
    expect(failure(() => updateTrade(db, r.tradeId, { qty: '8' }, TODAY))).toMatchObject({ status: 400, message: expect.stringMatching(/9 shares withheld from it/) })
    expect(totalChanges(db)).toBe(before)
  })

  it('a withholding sale edits only its share count; its value and day follow the vest', () => {
    const { db, vest, sales } = plan()
    const r = vest()
    const w = r.withholdingTradeId!
    expect(updateTrade(db, w, { qty: '10' }, TODAY)).toMatchObject({ changed: true })
    expect(sales()[0]).toMatchObject({ qty_micro: 10_000_000, total_cents: 4_000_00, realized: { st_cents: 0, lt_cents: 0 } })
    // The form echoing the stored total is fine; a different one contradicts the vest.
    expect(updateTrade(db, w, { qty: '11', totalCents: 4_000_00 }, TODAY)).toMatchObject({ changed: true })
    expect(sales()[0]).toMatchObject({ total_cents: 4_400_00 })
    const before = totalChanges(db)
    expect(failure(() => updateTrade(db, w, { totalCents: 4_000_00 }, TODAY))).toMatchObject({ status: 400, message: expect.stringMatching(/worth what they were at the vest/) })
    expect(failure(() => updateTrade(db, w, { tradedOn: '2026-08-20' }, TODAY))).toMatchObject({ status: 400, message: expect.stringMatching(/the day it vests/) })
    expect(failure(() => updateTrade(db, w, { qty: '26' }, TODAY))).toMatchObject({ status: 400, message: expect.stringMatching(/more than the 25 that vested/) })
    expect(failure(() => updateTrade(db, w, { soldLotTradeId: null }, TODAY))).toMatchObject({ status: 400 })
    expect(totalChanges(db)).toBe(before)
  })

  it("deleting a vest takes its withholding along; other sales from its lot keep their gains", () => {
    const { db, planId, vest, sales } = plan()
    const r = vest()
    createTrade(db, { investAccountId: planId, symbol: 'ACME', assetKind: 'stock', side: 'sell', tradedOn: '2026-09-01', qty: '6', totalCents: 2_700_00 }, TODAY)
    expect(listTrades(db).find((t) => t.id === r.tradeId)).toMatchObject({ dependents: 1, withheld_qty_micro: 9_000_000 })
    const gain = sales().find((s) => s.note === null)!.realized
    expect(gain).toEqual({ st_cents: 2_700_00 - 2_400_00, lt_cents: 0, zero_basis_cents: 0 })
    expect(deleteTrade(db, r.tradeId)).toEqual({ ok: true, id: r.tradeId, rewritten: 1, unlinkedVests: 0, withholdingRemoved: 1 })
    expect(sales()).toHaveLength(1)
    expect(sales()[0]!.realized).toEqual(gain)
    expect(getTax(db, TODAY).incomes.realizedStCents).toBe(300_00)
  })
})

describe('one security, one asset: symbols and their spellings (B10)', () => {
  const setup = () => {
    const db = mem()
    const acct = createInvestAccount(db, { name: 'Schwab', kind: 'brokerage', tracking: 'lots' }).id
    const buy = (symbol: string, qty = '1', assetKind = 'stock') =>
      createTrade(db, { investAccountId: acct, symbol, assetKind, side: 'buy', tradedOn: '2026-03-02', qty, totalCents: 400_00 }, TODAY)
    return { db, acct, buy }
  }

  it('lists every recorded symbol with its kind, by symbol', () => {
    const { db, buy } = setup()
    buy('VTI')
    buy('BTC', '0.1', 'crypto')
    expect(listAssets(db)).toEqual([
      { id: expect.any(Number), symbol: 'BTC', kind: 'crypto' },
      { id: expect.any(Number), symbol: 'VTI', kind: 'stock' },
    ])
  })

  it('a class share typed with a dash or a dot is the same stock — no second holding', () => {
    const { db, acct, buy } = setup()
    buy('BRK.B', '2')
    buy('brk-b', '3')
    expect(count(db, 'assets')).toBe(1)
    expect(findAsset(db, 'BRK-B')).toMatchObject({ symbol: 'BRK.B', kind: 'stock' })
    const pf = getPortfolio(db, TODAY)
    expect(pf.positions).toHaveLength(1)
    expect(pf.positions[0]).toMatchObject({ symbol: 'BRK.B', qty_micro: 5_000_000 })
    // Selling under the other spelling takes from the same lots.
    createTrade(db, { investAccountId: acct, symbol: 'BRK-B', assetKind: 'stock', side: 'sell', tradedOn: '2026-09-01', qty: '5', totalCents: 2_500_00 }, TODAY)
    expect(getPortfolio(db, TODAY).positions).toHaveLength(0)
    expect(listTrades(db).map((t) => t.symbol)).toEqual(['BRK.B', 'BRK.B', 'BRK.B'])
  })

  it('the alias keeps the recorded kind rule: BRK-B as crypto is refused, and crypto tickers never alias', () => {
    const { db, acct, buy } = setup()
    buy('BRK.B')
    const before = totalChanges(db)
    expect(failure(() => buy('BRK-B', '1', 'crypto'))).toMatchObject({ status: 400, message: expect.stringMatching(/BRK\.B is already recorded as a stock/) })
    expect(totalChanges(db)).toBe(before)
    // A crypto ticker with a dash is its own symbol: no stock-style aliasing.
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('X-Y', 'crypto')").run()
    expect(findAsset(db, 'X.Y')).toBeUndefined()
    expect(findAsset(db, 'X-Y')).toMatchObject({ kind: 'crypto' })
    void acct
  })

  it('a paste with both spellings books one stock; an alias of a recorded stock joins it', () => {
    const { db, acct, buy } = setup()
    buy('BF.B')
    const r = createOpeningPositions(
      db,
      {
        investAccountId: acct,
        asOf: '2026-09-01',
        rows: [
          { symbol: 'BRK.B', qty: '1', basisCents: 300_00, acquiredOn: '2020-01-02' },
          { symbol: 'BRK-B', qty: '2', basisCents: 600_00, acquiredOn: '2021-01-04' },
          { symbol: 'BF-B', qty: '4', basisCents: 200_00, acquiredOn: '2019-05-01' },
        ],
      },
      TODAY,
    )
    expect(r).toMatchObject({ created: 3, errors: [] })
    expect(listAssets(db).map((a) => a.symbol)).toEqual(['BF.B', 'BRK.B'])
    expect(getPortfolio(db, TODAY).positions.find((p) => p.symbol === 'BRK.B')).toMatchObject({ qty_micro: 3_000_000, cost_cents: 900_00 })
    // The same spelling given two kinds in one paste is still refused.
    const bad = createOpeningPositions(
      db,
      { investAccountId: acct, asOf: '2026-09-01', rows: [{ symbol: 'ZZ.A', qty: '1', basisCents: 1 }, { symbol: 'ZZ-A', qty: '1', basisCents: 1, assetKind: 'crypto' }] },
      TODAY,
    )
    expect(bad).toMatchObject({ created: 0, errors: [{ row: 1, message: expect.stringMatching(/two kinds/) }] })
  })

  it('a hand-set price, a grant and a vest find the recorded spelling too; a grant is never crypto', () => {
    const { db, buy } = setup()
    buy('BRK.B')
    expect(setManualPrice(db, { symbol: 'BRK-B', pricedOn: '2026-09-20', cents: 480_00 }, TODAY)).toMatchObject({ symbol: 'BRK.B' })
    expect(getPortfolio(db, TODAY).positions[0]).toMatchObject({ price_cents: 480_00, price_manual: true })

    buy('ETH', '1', 'crypto')
    const plan = createInvestAccount(db, { name: 'E*Trade', kind: 'brokerage', tracking: 'lots', stockPlan: true }).id
    const before = totalChanges(db)
    expect(failure(() => putUnvested(db, { investAccountId: plan, symbol: 'ETH', qty: '10' }, TODAY))).toMatchObject({ status: 400, message: expect.stringMatching(/recorded as crypto/) })
    expect(totalChanges(db)).toBe(before)
    putUnvested(db, { investAccountId: plan, symbol: 'brk-b', qty: '10' }, TODAY)
    expect(count(db, 'assets')).toBe(2)
    const v = vestUnvested(db, { investAccountId: plan, symbol: 'BRK-B', qty: '4', tradedOn: '2026-09-15', totalCents: 1_920_00 }, TODAY)
    expect(v).toMatchObject({ grossQtyMicro: 4_000_000, remainingQtyMicro: 6_000_000 })
    expect(listTrades(db, { accountId: plan })[0]).toMatchObject({ symbol: 'BRK.B', note: 'RSU vest' })
  })
})

describe('the balance check-in: every number from a statement, with its latest value (B11)', () => {
  it('balance accounts, then each lots account\'s cash, then homes, then loans — and it writes nothing', () => {
    const db = mem()
    seedHousehold(db)
    db.prepare("UPDATE invest_accounts SET institution = 'Fidelity', mask = '1234', owner = 'Nicole' WHERE id = 3").run()
    putBalanceSnapshot(db, { investAccountId: 1, balancedOn: '2026-07-01', balanceCents: 1_000_00 }, TODAY) // Taxable's cash anchor
    db.prepare("INSERT INTO liabilities (property_id, name) VALUES (NULL, 'Car loan')").run() // a loan against no property
    const before = totalChanges(db)
    const { items } = getCheckin(db, TODAY)
    expect(totalChanges(db)).toBe(before)
    expect(items.map((i) => `${i.kind}:${i.name}`)).toEqual([
      'balance:401(k)',
      'cash:Taxable',
      'cash:Roth IRA',
      'cash:Coinbase',
      'property:House',
      'liability:Mortgage',
      'liability:Car loan',
    ])
    expect(items[0]).toEqual({
      kind: 'balance', id: 3, name: '401(k)', detail: 'Fidelity ··1234', owner: 'Nicole',
      last: { on: '2026-06-30', cents: 4_450_000 }, derived_cents: null, uncounted_cents: 0,
    })
    // Taxable: $1,000 cash on Jul 1, plus the Jul 20 sale's $960 → $1,960 today.
    expect(items[1]).toMatchObject({ kind: 'cash', id: 1, last: { on: '2026-07-01', cents: 1_000_00 }, derived_cents: 1_960_00, uncounted_cents: 0 })
    // No cash balance: none derived, and nothing uncounted without a sale.
    expect(items[2]).toMatchObject({ kind: 'cash', id: 2, last: null, derived_cents: null, uncounted_cents: 0 })
    expect(items[4]).toMatchObject({ kind: 'property', id: 1, detail: null, owner: null, last: { on: '2026-07-15', cents: 85_000_000 } })
    expect(items[5]).toMatchObject({ kind: 'liability', id: 1, detail: 'House', last: { on: '2026-08-01', cents: 63_500_000 } })
    expect(items[6]).toMatchObject({ kind: 'liability', detail: null, last: null })
  })

  it("an unanchored account's sale proceeds show as uncounted; its cash balance then counts them", () => {
    const db = mem()
    seedHousehold(db)
    expect(getCheckin(db, TODAY).items.find((i) => i.kind === 'cash' && i.id === 1)).toMatchObject({ last: null, derived_cents: null, uncounted_cents: 960_00 })
    putBalanceSnapshot(db, { investAccountId: 1, balancedOn: '2026-09-21', balanceCents: 960_00 }, TODAY)
    expect(getCheckin(db, TODAY).items.find((i) => i.kind === 'cash' && i.id === 1)).toMatchObject({ derived_cents: 960_00, uncounted_cents: 0 })
  })
})
