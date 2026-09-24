import { describe, expect, it } from 'vitest'
import type { DbLike } from './db'
import {
  createOpeningPositions,
  deleteBalanceSnapshot,
  deleteTrade,
  getCheckin,
  getInvestAccount,
  getPortfolio,
  listAssets,
  listBalanceSnapshots,
  listInvestAccounts,
  listInvestOwners,
  listTrades,
  putBalanceSnapshot,
  setManualPrice,
  updateInvestAccount,
  updateTrade,
  vestUnvested,
} from './invest'
import { netWorthSeries } from './networth'
import { getRealizedReport, getTax, previewTrade } from './tax'
import { seedHousehold } from './test/household'
import { onBothEngines } from './test/parity'

const TODAY = '2026-09-22'

/**
 * The seeded household plus what exercises the brokerage rules: the same
 * ticker in a taxable account and the Roth, a realized gain in each, a
 * specific-lot sale, an oversell warning, a loss lot with an IRA buy inside
 * the wash window, and a stock plan with a vest scheduled within 30 days.
 */
function brokerage(db: DbLike) {
  seedHousehold(db)
  db.prepare("UPDATE invest_accounts SET stock_plan = 1 WHERE id = 1").run()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ACME', 'stock')").run() // 4
  const trade = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  trade.run(2, 1, '2025-01-06', 'buy', 5_000_000, 110_000, null, null) // VTI in the Roth too (trade 5)
  trade.run(2, 1, '2026-05-04', 'sell', 2_000_000, 48_000, 5, null) // specific-lot sale inside the Roth
  trade.run(1, 4, '2026-03-02', 'buy', 20_000_000, 1_000_000, null, 'RSU vest') // ACME at $500
  trade.run(2, 4, '2026-09-10', 'buy', 1_000_000, 40_000, null, null) // ACME in the Roth: wash window
  trade.run(4, 2, '2026-08-01', 'sell', 1_000_000, 45_000, null, null) // QQQ oversold in Coinbase: warning
  db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (4, '2026-09-19', 40_000)").run()
  db.prepare(
    `INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on, next_vest_on, vest_every_months, vest_qty_micro)
     VALUES (1, 4, 60_000_000, '2026-09-01', '2026-10-15', 3, 15_000_000)`,
  ).run()
}

describe('brokerage parity: better-sqlite3 and sql.js', () => {
  it('getPortfolio is identical, and not vacuous', async () => {
    const { server, browser } = await onBothEngines(brokerage, (db) => getPortfolio(db, TODAY))
    expect(browser).toEqual(server)
    expect(server.positions.map((p) => p.symbol).sort()).toEqual(['ACME', 'BTC', 'QQQ', 'VTI'])
    expect(server.positions.find((p) => p.symbol === 'VTI')!.accounts).toHaveLength(2)
    expect(server.totals.ytd_st).not.toBe(0)
    expect(server.totals.ytd_sheltered).not.toBe(0)
    expect(server.warnings.length).toBeGreaterThan(0)
  })

  it('getTax is identical, and not vacuous', async () => {
    const { server, browser } = await onBothEngines(brokerage, (db) => getTax(db, TODAY))
    expect(browser).toEqual(server)
    expect(server.incomes.realizedStCents).not.toBe(0)
    expect(server.incomes.realizedShelteredCents).not.toBe(0)
    const acme = server.harvest.rows.find((r) => r.symbol === 'ACME')!
    expect(acme).toMatchObject({ account: 'Taxable', wash_risk: true, wash_upcoming: { vest_on: '2026-10-15' } })
    expect(server.harvest.rows.every((r) => r.account !== 'Roth IRA')).toBe(true)
  })

  it('starting positions, hand-entered prices and balance history write and read identically', async () => {
    const run = (db: DbLike) => {
      const opening = createOpeningPositions(
        db,
        {
          investAccountId: 1,
          asOf: '2026-09-01',
          rows: [
            { symbol: 'VTI', qty: '10', basisCents: 1_000_00, acquiredOn: '2019-03-15' },
            { symbol: 'FXAIX', qty: '12.5', basisCents: 2_000_00 },
          ],
        },
        TODAY,
      )
      const refused = createOpeningPositions(db, { investAccountId: 1, asOf: '2026-09-01', rows: [{ symbol: 'X', qty: '0', basisCents: 1 }] }, TODAY)
      setManualPrice(db, { symbol: 'FXAIX', pricedOn: '2026-09-20', cents: 215_37 }, TODAY)
      putBalanceSnapshot(db, { investAccountId: 3, balances: [{ balancedOn: '2025-12-31', balanceCents: 4_000_000 }, { balancedOn: '2026-09-15', balanceCents: 4_600_000 }] }, TODAY)
      deleteBalanceSnapshot(db, 3, '2026-03-31')
      return { opening, refused, portfolio: getPortfolio(db, TODAY), balances: listBalanceSnapshots(db) }
    }
    const { server, browser } = await onBothEngines(brokerage, run)
    expect(browser).toEqual(server)
    expect(server.opening).toMatchObject({ created: 2, errors: [] })
    expect(server.refused.errors).toHaveLength(1)
    const fxaix = server.portfolio.positions.find((p) => p.symbol === 'FXAIX')!
    expect(fxaix).toMatchObject({ price_manual: true, value_cents: 2_692_13 })
    expect(server.portfolio.positions.find((p) => p.symbol === 'VTI')!.lots[0]!.opened_on).toBe('2019-03-15')
    expect(server.balances.map((b) => b.balanced_on)).toEqual(['2026-09-15', '2026-06-30', '2025-12-31'])
  })

  it('the activity ledger — list, preview, edit, delete — reads and writes identically', async () => {
    const run = (db: DbLike) => {
      const listed = listTrades(db)
      const preview = previewTrade(
        db,
        { investAccountId: 1, symbol: 'ACME', assetKind: 'stock', side: 'sell', tradedOn: TODAY, qty: '5', totalCents: 1_500_00 },
        TODAY,
      )
      const refused = (() => {
        try {
          return updateTrade(db, 1, { qty: '1' }, TODAY) // VTI's lot: the July sale took 4 of it
        } catch (e) {
          return String(e)
        }
      })()
      const edited = updateTrade(db, 1, { totalCents: 210_000 }, TODAY)
      const deleted = deleteTrade(db, 1) // the sale that took from it keeps its gain
      return { listed, preview, refused, edited, deleted, after: listTrades(db), tax: getTax(db, TODAY).incomes }
    }
    const { server, browser } = await onBothEngines(brokerage, run)
    expect(browser).toEqual(server)
    expect(server.listed.length).toBeGreaterThan(5)
    expect(server.listed.find((t) => t.side === 'sell' && t.symbol === 'VTI' && t.invest_account_id === 1)!.realized).toBeDefined()
    expect(server.preview.washSale).toMatchObject({ risk: true, upcomingVest: { vest_on: '2026-10-15' } })
    expect(server.refused).toMatch(/short/)
    expect(server.edited).toMatchObject({ changed: true, affected: 1 })
    expect(server.deleted).toMatchObject({ rewritten: 1 })
    expect(server.after.find((t) => t.id === 4)).toMatchObject({ acquired_on: '2026-02-10', basis_cents: 84_000 })
  })

  it('the account drawer — detail, owners, a profile patch and a refused tracking change — reads and writes identically', async () => {
    const run = (db: DbLike) => {
      db.prepare("INSERT INTO pay_sources (earner, cadence, paid_on, gross_cents) VALUES ('Nicole', 'biweekly', '2026-09-01', 100)").run()
      const patched = updateInvestAccount(db, 2, { subtype: 'roth_ira', institution: 'Vanguard', owner: 'Max', mask: '4321' })
      const refused = (() => {
        try {
          return updateInvestAccount(db, 1, { tracking: 'balance' })
        } catch (e) {
          return String(e)
        }
      })()
      return {
        patched,
        refused,
        accounts: listInvestAccounts(db),
        owners: listInvestOwners(db),
        details: [1, 2, 3, 4].map((id) => getInvestAccount(db, id, TODAY)),
      }
    }
    const { server, browser } = await onBothEngines(brokerage, run)
    expect(browser).toEqual(server)
    expect(server.patched).toMatchObject({ changed: true, account: { subtype: 'roth_ira', kind: 'retirement', mask: '4321' } })
    expect(server.refused).toMatch(/tracking it by balance/)
    expect(server.owners).toEqual(['Nicole', 'Max'])
    const [taxable, roth, k401] = server.details
    expect(taxable!.positions.length).toBeGreaterThan(0)
    expect(taxable!.grants).toHaveLength(1)
    expect(roth!.totals.ytd_sheltered).not.toBe(0)
    expect(k401!.balances).toHaveLength(2)
  })

  it('cash anchors, a net-settled vest and its edits and delete read and write identically', async () => {
    const run = (db: DbLike) => {
      putBalanceSnapshot(db, { investAccountId: 1, balancedOn: '2026-06-30', balanceCents: 2_000_00 }, TODAY)
      putBalanceSnapshot(db, { investAccountId: 4, balancedOn: '2026-09-01', balanceCents: 10_00 }, TODAY) // Coinbase: goes negative
      db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (4, 3, '2026-09-10', 'buy', 1_000, 100_00)").run()
      const vest = vestUnvested(
        db,
        { investAccountId: 1, symbol: 'ACME', qty: '15.333333', tradedOn: '2026-09-15', totalCents: 6_137_77, withheldQty: '5.777777' },
        TODAY,
      )
      const portfolio = getPortfolio(db, TODAY)
      const edited = updateTrade(db, vest.tradeId, { totalCents: 6_200_01 }, TODAY)
      const listed = listTrades(db, { symbol: 'ACME' })
      const deleted = deleteTrade(db, vest.tradeId)
      return { vest, portfolio, edited, listed, deleted, nw: netWorthSeries(db, TODAY), detail: getInvestAccount(db, 1, TODAY).cash }
    }
    const { server, browser } = await onBothEngines(brokerage, run)
    expect(browser).toEqual(server)
    expect(server.vest).toMatchObject({ withheldQtyMicro: 5_777_777, netQtyMicro: 9_555_556 })
    const taxable = server.portfolio.accounts.find((a) => a.name === 'Taxable')!
    expect(taxable.cash_cents).not.toBeNull()
    expect(taxable.cash_trades).toBeGreaterThan(0)
    expect(server.portfolio.warnings.some((w) => w.startsWith('Cash · Coinbase'))).toBe(true)
    const withholding = server.listed.find((t) => t.note === 'RSU withholding')!
    expect(withholding.realized).toEqual({ st_cents: 0, lt_cents: 0, zero_basis_cents: 0 })
    expect(server.edited).toMatchObject({ changed: true, affected: 0 })
    expect(server.deleted).toMatchObject({ withholdingRemoved: 1 })
    expect(server.detail).toMatchObject({ name: 'Taxable', cash_as_of: '2026-06-30' })
  })

  it('recorded symbols (and a class-share alias), the check-in and the realized-gains report are identical (B10, B11, B14)', async () => {
    const run = (db: DbLike) => {
      putBalanceSnapshot(db, { investAccountId: 1, balancedOn: '2026-06-30', balanceCents: 2_000_00 }, TODAY)
      db.prepare("INSERT INTO assets (symbol, kind) VALUES ('BRK.B', 'stock')").run()
      const alias = previewTrade(db, { investAccountId: 1, symbol: 'BRK-B', assetKind: 'stock', side: 'buy', tradedOn: TODAY, qty: '1', totalCents: 480_00 }, TODAY)
      return {
        assets: listAssets(db),
        alias,
        checkin: getCheckin(db, TODAY),
        realized: getRealizedReport(db, 2026, TODAY),
        earlier: getRealizedReport(db, '2025', TODAY),
        tax: getTax(db, TODAY).incomes,
      }
    }
    const { server, browser } = await onBothEngines(brokerage, run)
    expect(browser).toEqual(server)
    expect(server.assets.map((a) => a.symbol)).toEqual(['ACME', 'BRK.B', 'BTC', 'QQQ', 'VTI'])
    expect(server.checkin.items.map((i) => i.kind)).toEqual(['balance', 'cash', 'cash', 'cash', 'property', 'liability'])
    expect(server.checkin.items[1]).toMatchObject({ name: 'Taxable', last: { cents: 2_000_00 }, derived_cents: expect.any(Number) })
    expect(server.realized.lines.length).toBeGreaterThan(0)
    expect(server.realized.sheltered.sales).toBeGreaterThan(0)
    expect(server.realized.lines.some((l) => l.basis === 'none')).toBe(true) // Coinbase's QQQ oversell
    // The report's lines add up to what Taxes counts, on both engines.
    expect([server.realized.st.gain_cents, server.realized.lt.gain_cents]).toEqual([server.tax.realizedStCents, server.tax.realizedLtCents])
    expect(server.earlier.lines).toEqual([])
  })
})
