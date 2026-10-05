import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { createOpeningPositions, createPastSales, createInvestAccount, getPortfolio } from './invest'
import { amountCents, decimalMicro, parseSales } from './sales-paste'
import { getRealizedReport } from './tax'
import { onBothEngines } from './test/parity'

const TOTALS = { basis: 'total', proceeds: 'total' } as const
const TODAY = '2026-10-02'

describe('parseSales', () => {
  it('reads the realized-gains layout: symbol, shares, basis, acquired, sale amount, sold', () => {
    const p = parseSales('symbol, shares, cost basis, aquisition date, sale price, sale date\nGOOG, 26.5, 3141.31, 06/25/2022, 8301.125, 1/5/2026', TOTALS)
    expect(p.errors).toEqual([])
    expect(p.header).toBe(true)
    expect(p.rows).toEqual([
      { line: 2, symbol: 'GOOG', qtyMicro: 26_500_000, basisCents: 314_131, acquiredOn: '2022-06-25', proceedsCents: 830_113, soldOn: '2026-01-05' },
    ])
  })

  it('multiplies per-share amounts by the shares, rounding once, half up', () => {
    const p = parseSales('GOOG\t26.5\t118.5400\t2022-06-25\t313.25\t2026-01-05', { basis: 'perShare', proceeds: 'perShare' })
    expect(p.rows[0]).toMatchObject({ basisCents: 314_131, proceedsCents: 830_113 }) // 26.5 × 118.54 = 3141.31; 26.5 × 313.25 = 8301.125
    expect(parseSales('GOOG,10,$1,234.56,1/1/2020,5000,2/1/2026', { basis: 'perShare', proceeds: 'total' }).errors).toHaveLength(1) // a comma split the basis
    expect(parseSales('GOOG\t10\t$1,234.56\t1/1/2020\t5000\t2/1/2026', { basis: 'perShare', proceeds: 'total' }).rows[0]!.basisCents).toBe(1_234_560)
  })

  it('names the line and the problem of every bad row', () => {
    const p = parseSales('GOOG, 1, 100, 6/25/2022, 200, 1/5/2026\nGOOG, x, 100, 6/25/2022, 200, 1/5/2026\nGOOG, 1, 100, 6/25/2027, 200, 1/5/2026\nGOOG, 1, 100, 6/25/2022, 200', TOTALS)
    expect(p.rows).toHaveLength(1)
    expect(p.errors.map((e) => e.line)).toEqual([2, 3, 4])
    expect(p.errors[1]!.message).toMatch(/after it was sold/)
  })

  it('takes columns in any order when a header names them all', () => {
    const p = parseSales('Date Sold\tSymbol\tQuantity\tProceeds\tDate Acquired\tCost Basis\n1/5/2026\tGOOG\t2\t600\t6/25/2022\t240', TOTALS)
    expect(p.rows[0]).toMatchObject({ symbol: 'GOOG', qtyMicro: 2_000_000, proceedsCents: 60_000, basisCents: 24_000, acquiredOn: '2022-06-25', soldOn: '2026-01-05' })
  })

  it('decimal amounts are string math', () => {
    expect(decimalMicro('$8,301.125')).toBe(8_301_125_000)
    expect(decimalMicro('-5')).toBeNull()
    expect(amountCents(8_301_125_000, 1, 'total')).toBe(830_113)
    expect(amountCents(118_540_100, 26_500_000, 'perShare')).toBe(314_131) // 118.5401 × 26.5 = 3,141.31265 → $3,141.31
    expect(amountCents(5_000, 1_000_000, 'perShare')).toBe(1) // $0.005 a share × 1 share rounds half up to a cent
  })
})

function account(db: DbLike) {
  return createInvestAccount(db, { name: 'Morgan Stanley', kind: 'brokerage', tracking: 'lots' }).id as number
}
const sale = { symbol: 'GOOG', qty: '26.5', basisCents: 314_131, acquiredOn: '2022-06-25', proceedsCents: 830_113, soldOn: '2026-01-05' }

describe('createPastSales', () => {
  it('realizes each sale with its lot’s basis and term, leaving the holdings alone', () => {
    const db = openDb(':memory:') as unknown as DbLike
    const id = account(db)
    createOpeningPositions(db, { investAccountId: id, asOf: '2025-12-31', rows: [{ symbol: 'GOOG', qty: '100', basisCents: 1_000_000, acquiredOn: '2024-03-01' }] }, TODAY)
    const r = createPastSales(db, { investAccountId: id, rows: [sale, { ...sale, qty: '1', basisCents: 30_000, acquiredOn: '2025-08-01', proceedsCents: 31_325 }] }, TODAY)
    expect(r).toMatchObject({ created: 2, errors: [], warnings: [] })
    const rep = getRealizedReport(db, 2026, TODAY)
    expect(rep.lt.gain_cents).toBe(830_113 - 314_131)
    expect(rep.st.gain_cents).toBe(31_325 - 30_000)
    expect(rep.lines.every((l) => l.basis === 'entered')).toBe(true)
    // The 100 shares held are still held.
    expect(getPortfolio(db, TODAY).positions.find((p) => p.symbol === 'GOOG')!.qty_micro).toBe(100_000_000)
  })

  it('writes nothing when any row is refused, and says which', () => {
    const db = openDb(':memory:') as unknown as DbLike
    const id = account(db)
    const r = createPastSales(db, { investAccountId: id, rows: [sale, { ...sale, soldOn: '2027-01-05' }, { ...sale, qty: 'lots' }] }, TODAY)
    expect(r.created).toBe(0)
    expect(r.errors.map((e) => e.row)).toEqual([1, 2])
    expect(r.errors[0]!.message).toMatch(/after today/)
    expect((db.prepare('SELECT count(*) AS n FROM trades').get() as { n: number }).n).toBe(0)
  })

  it('warns when the lot is already on the books, or the sale already recorded', () => {
    const db = openDb(':memory:') as unknown as DbLike
    const id = account(db)
    createOpeningPositions(db, { investAccountId: id, asOf: '2025-12-31', rows: [{ symbol: 'GOOG', qty: '26.5', basisCents: 314_131, acquiredOn: '2022-06-25' }] }, TODAY)
    const first = createPastSales(db, { investAccountId: id, rows: [sale] }, TODAY)
    expect(first.warnings.map((w) => w.message)).toEqual([expect.stringMatching(/lot acquired 2022-06-25 is already in Morgan Stanley — sell that lot instead/)])
    // A dry run says the same and writes nothing.
    const before = (db.prepare('SELECT count(*) AS n FROM trades').get() as { n: number }).n
    expect(createPastSales(db, { investAccountId: id, rows: [sale], dryRun: true }, TODAY)).toMatchObject({ created: 0, errors: [] })
    expect((db.prepare('SELECT count(*) AS n FROM trades').get() as { n: number }).n).toBe(before)
    const again = createPastSales(db, { investAccountId: id, rows: [sale] }, TODAY)
    expect(again.warnings.map((w) => w.message)).toContainEqual(expect.stringMatching(/looks recorded already/))
  })

  it('reads back identically on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => void createPastSales(db, { investAccountId: account(db), rows: [sale] }, TODAY),
      (db) => getRealizedReport(db, 2026, TODAY).lt,
    )
    expect(server.gain_cents).toBe(830_113 - 314_131)
    expect(browser).toEqual(server)
  })
})
