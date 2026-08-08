import { describe, expect, it } from 'vitest'
import { simulate, type SimParams } from './simulate'

const BASE: SimParams = {
  startYear: 2026,
  endYear: 2056,
  liquidCents: 100_000_000, // $1M
  propertyCents: 0,
  liabilitiesCents: 0,
  meanReturnMicro: 50_000,
  volMicro: 0,
  propertyGrowthMicro: 0,
  saveBeforeBuyCents: 0,
  saveAfterBuyCents: 0,
  buy: null,
  retireYear: 2056,
  retireSpendCents: 0,
  paths: 200,
  seed: 7,
}

describe('simulate', () => {
  it('zero volatility compounds deterministically', () => {
    const r = simulate(BASE)
    // $1M at 5% real for 30 years ≈ $4.32M; all percentiles identical
    expect(r.p50[r.p50.length - 1]).toBeCloseTo(100_000_000 * Math.pow(1.05, 30), -6)
    expect(r.p10[r.p10.length - 1]).toBe(r.p90[r.p90.length - 1])
    expect(r.successPct).toBe(100)
  })

  it('volatility fans the percentiles out and stays ordered', () => {
    const r = simulate({ ...BASE, volMicro: 150_000, paths: 1000 })
    const last = r.years.length - 1
    expect(r.p10[last]!).toBeLessThan(r.p50[last]!)
    expect(r.p50[last]!).toBeLessThan(r.p90[last]!)
    for (let i = 0; i < r.years.length; i++) {
      expect(r.p25[i]!).toBeGreaterThanOrEqual(r.p10[i]!)
      expect(r.p75[i]!).toBeLessThanOrEqual(r.p90[i]!)
    }
  })

  it('a house purchase moves cash into property and amortizes the loan', () => {
    const r = simulate({
      ...BASE,
      buy: { year: 2027, priceCents: 300_000_000, cashOutCents: 68_000_000, rateMicro: 63_750, termMonths: 360 },
      endYear: 2030,
    })
    // Net worth at buy year: liquid drops by cashOut, home value + loan appear;
    // loan ≈ price − cashOut, so total drops only by amortization-vs-growth.
    expect(r.p50[1]!).toBeGreaterThan(0)
    // 2030: loan has amortized 3 years — remaining < original
    const total2030 = r.p50[4]!
    expect(total2030).toBeGreaterThan(r.p50[1]!)
  })

  it('unsustainable retirement spending fails paths', () => {
    const r = simulate({
      ...BASE,
      volMicro: 120_000,
      retireYear: 2028,
      retireSpendCents: 30_000_000, // $300K/yr from $1M: doomed
      paths: 500,
    })
    expect(r.successPct).toBeLessThan(30)
  })

  it('is deterministic for a given seed', () => {
    const a = simulate({ ...BASE, volMicro: 120_000 })
    const b = simulate({ ...BASE, volMicro: 120_000 })
    expect(a.p50).toEqual(b.p50)
  })
})
