import { describe, expect, it } from 'vitest'
import { grossSaleForNet, sma } from './series'

describe('sma', () => {
  it('is null until the window fills, then averages exactly', () => {
    expect(sma([2, 4, 6, 8], 2)).toEqual([null, 3, 5, 7])
    expect(sma([10, 20, 30], 3)).toEqual([null, null, 20])
  })
  it('handles window larger than the series', () => {
    expect(sma([1, 2], 5)).toEqual([null, null])
  })
})

describe('grossSaleForNet', () => {
  it('zero-basis sale grosses up by the tax rate', () => {
    const { grossCents, taxCents } = grossSaleForNet(18_000_000, 0, 350_000, 0)
    expect(grossCents).toBe(27_692_308) // $180K / (1 − 0.35)
    expect(grossCents - taxCents).toBe(18_000_000)
  })
  it('a loss carryforward can shield the whole gain', () => {
    expect(grossSaleForNet(18_000_000, 0, 350_000, 45_000_000)).toEqual({
      grossCents: 18_000_000,
      taxCents: 0,
    })
  })
  it('partial shielding blends correctly', () => {
    const { grossCents, taxCents } = grossSaleForNet(50_000_000, 0, 300_000, 20_000_000)
    expect(grossCents - taxCents).toBe(50_000_000)
    expect(taxCents).toBeGreaterThan(0)
  })
  it('full basis means no tax', () => {
    expect(grossSaleForNet(10_000_000, 1_000_000, 350_000, 0)).toEqual({ grossCents: 10_000_000, taxCents: 0 })
  })
})
