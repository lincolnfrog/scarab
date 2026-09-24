import { describe, expect, it } from 'vitest'
import type { PortfolioLot } from '../../shared/invest-api'
import { daysBetween, lotTerm, lotValueCents, perShareCents, saleEstimate, sellableLots } from './lotMath'

const M = { stMicro: 450_000, ltMicro: 250_000 }

describe('lot display math', () => {
  it("reads the holding period from the engine's lt_on, not a day count", () => {
    // Bought 2024-02-05: lt_on 2025-02-06. On the anniversary (366 days in) it is still short-term.
    expect(lotTerm({ lt_on: '2025-02-06', sheltered: false }, '2025-02-05')).toEqual({ kind: 'st', daysToLt: 1 })
    expect(lotTerm({ lt_on: '2025-02-06', sheltered: false }, '2025-02-06')).toEqual({ kind: 'lt' })
    expect(lotTerm({ lt_on: '2027-01-01', sheltered: false }, '2026-12-01')).toEqual({ kind: 'st', daysToLt: 31 })
  })

  it('a sheltered lot owes nothing on sale, gain or loss', () => {
    const lot = { lt_on: '2027-01-01', sheltered: true, qty_micro: 10_000_000, cost_cents: 1_000_00 }
    expect(saleEstimate(lot, 20_000, M, '2026-09-22')).toEqual({
      term: { kind: 'sheltered' },
      valueCents: 2_000_00,
      gainCents: 1_000_00,
      taxCents: 0,
      afterTaxCents: 2_000_00,
    })
  })

  it('taxes a taxable gain at the term rate and credits a loss', () => {
    const lot = { lt_on: '2026-01-01', sheltered: false, qty_micro: 10_000_000, cost_cents: 1_000_00 }
    expect(saleEstimate(lot, 20_000, M, '2026-09-22')).toMatchObject({ taxCents: 250_00, afterTaxCents: 1_750_00 })
    expect(saleEstimate({ ...lot, lt_on: '2027-01-01' }, 20_000, M, '2026-09-22')).toMatchObject({ taxCents: 450_00 })
    expect(saleEstimate(lot, 5_000, M, '2026-09-22')).toMatchObject({ gainCents: -500_00, taxCents: -125_00, afterTaxCents: 500_00 })
  })

  it('keeps value and per-share cost in integer cents', () => {
    expect(lotValueCents(3_333_333, 24_800)).toBe(826_67)
    expect(perShareCents(81_111, 3_333_333)).toBe(24_333)
    expect(perShareCents(100, 0)).toBe(0)
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2)
  })
})

describe('the lot picker', () => {
  const lot = (trade_id: number | null, invest_account_id: number): PortfolioLot => ({
    trade_id, opened_on: '2025-01-02', lt_on: '2026-01-03', qty_micro: 1_000_000, cost_cents: 100_00,
    invest_account_id, account_name: `#${invest_account_id}`, sheltered: false,
  })
  const positions = [{ symbol: 'VTI', lots: [lot(1, 1), lot(2, 2), lot(3, 1), lot(null, 1)] }]

  it("offers only the sale's own account's lots of that symbol", () => {
    expect(sellableLots(positions, ' vti ', 1).map((l) => l.trade_id)).toEqual([1, 3])
    expect(sellableLots(positions, 'VTI', 2).map((l) => l.trade_id)).toEqual([2])
    expect(sellableLots(positions, 'VTI', 9)).toEqual([])
    expect(sellableLots(positions, 'QQQ', 1)).toEqual([])
  })
})
