import { describe, expect, it } from 'vitest'
import { dayNumber, linkReturns, periodGrowth, TWR_BASE, xirr, type Flow, type ReturnPeriod } from './perf'

const flow = (iso: string, cents: number): Flow => ({ day: dayNumber(iso), cents })

describe('dayNumber', () => {
  it('counts whole UTC days, across a leap day', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('1970-01-02')).toBe(1)
    expect(dayNumber('2024-03-01') - dayNumber('2024-02-28')).toBe(2)
    expect(dayNumber('2025-03-01') - dayNumber('2025-02-28')).toBe(1)
  })
})

describe('xirr', () => {
  it("matches Microsoft's XIRR example: 37.3363%", () => {
    // support.microsoft.com, XIRR function: -10,000 then four receipts → 0.373362535.
    const flows = [
      flow('2008-01-01', -1_000_000),
      flow('2008-03-01', 275_000),
      flow('2008-10-30', 425_000),
      flow('2009-02-15', 325_000),
      flow('2009-04-01', 275_000),
    ]
    expect(xirr(flows)).toBe(373_363)
    // Order doesn't matter; the first day is the earliest one.
    expect(xirr([...flows].reverse())).toBe(373_363)
  })

  it('a year of 10% is 10%; a loss is negative; breaking even is exactly 0', () => {
    expect(xirr([flow('2025-01-01', -100_000), flow('2026-01-01', 110_000)])).toBe(100_000)
    expect(xirr([flow('2025-01-01', -100_000), flow('2026-01-01', 80_000)])).toBe(-200_000)
    expect(xirr([flow('2025-01-01', -100_000), flow('2026-06-01', 100_000)])).toBe(0)
  })

  it('has no answer without both an inflow and an outflow', () => {
    expect(xirr([flow('2025-01-01', 100_000), flow('2026-01-01', 110_000)])).toBeNull() // all positive
    expect(xirr([flow('2025-01-01', -100_000), flow('2026-01-01', -1)])).toBeNull() // all negative
    expect(xirr([flow('2025-01-01', -100_000), flow('2026-01-01', 0)])).toBeNull() // zero flows are ignored
    expect(xirr([])).toBeNull()
    // Everything on one day: nothing to discount.
    expect(xirr([flow('2025-01-01', -100_000), flow('2025-01-01', 110_000)])).toBeNull()
  })

  it('quotes a short holding over its own period with basisDays, not annualized', () => {
    const flows = [flow('2026-01-01', -100_000), flow('2026-01-31', 105_000)] // +5% in 30 days
    expect(xirr(flows, { basisDays: 30 })).toBe(50_000)
    // The same root, annualized: (1.05)^(365/30) − 1 ≈ 81%.
    const annual = xirr(flows)!
    expect(annual / 1e6).toBeCloseTo(Math.pow(1.05, 365 / 30) - 1, 5)
    expect(xirr(flows, { basisDays: 0 })).toBeNull()
  })

  it('a money-weighted period return weights each dollar by how long it was in', () => {
    // $1,000 for the whole year and $1,000 for the last day, ending at $2,100:
    // nearly all of the $100 gain was earned by the first $1,000 → about 10%.
    const r = xirr([flow('2025-01-01', -100_000), flow('2025-12-31', -100_000), flow('2026-01-01', 210_000)])!
    expect(r).toBeGreaterThan(99_000)
    expect(r).toBeLessThan(100_100)
  })

  it('falls back to bisection when Newton cannot start, and stays in integer micro', () => {
    // A near-total loss: Newton from 0.1 overshoots below −100%; bisection finds it.
    const r = xirr([flow('2020-01-01', -1_000_000), flow('2026-01-01', 1)])
    expect(r).not.toBeNull()
    expect(Number.isInteger(r)).toBe(true)
    expect(r!).toBeLessThan(-850_000)
    expect(r!).toBeGreaterThanOrEqual(-999_900)
    // A root beyond the bracket that Newton can't reach either: no answer rather than a wrong one.
    expect(xirr([flow('2026-01-01', -1), flow('2026-01-02', 1_000_000_000)])).toBeNull()
  })

  it('refuses non-integer inputs rather than computing on them', () => {
    expect(xirr([{ day: 0, cents: -100.5 }, { day: 365, cents: 110 }])).toBeNull()
  })
})

/* ---------- time-weighted return ---------- */

const growth = (p: ReturnPeriod) => {
  const g = periodGrowth(p)
  return g === null ? null : Number(g.num) / Number(g.den)
}
const link = (periods: (ReturnPeriod | null)[]) => linkReturns(periods).index

describe('periodGrowth (Modified Dietz, exact fractions)', () => {
  it('no flows: end over start; nothing held and nothing moved: exactly 1', () => {
    expect(periodGrowth({ start: 100_000, end: 110_000, days: 30, flows: [] })).toEqual({ num: 110_000n, den: 100_000n })
    expect(periodGrowth({ start: 0, end: 0, days: 31, flows: [] })).toEqual({ num: 1n, den: 1n })
    expect(growth({ start: 100_000, end: 0, days: 30, flows: [] })).toBe(0) // everything lost
  })

  it('a buy into an empty scope starts the period at the buy: its first month is buy → month end, however late', () => {
    // $1,000 bought on the 25th, worth $1,020 at month end: +2%, not 2% spread over the whole month.
    expect(growth({ start: 0, end: 102_000, days: 30, flows: [{ day: 25, cents: 100_000 }] })).toBeCloseTo(1.02, 12)
    // Bought on the last day at $1,000, closing at $1,010: +1%.
    expect(growth({ start: 0, end: 101_000, days: 30, flows: [{ day: 30, cents: 100_000 }] })).toBeCloseTo(1.01, 12)
  })

  it('selling out ends the period at the sale', () => {
    // $1,000 at the start, all sold on the 15th for $1,100: +10%.
    expect(growth({ start: 100_000, end: 0, days: 30, flows: [{ day: 15, cents: -110_000 }] })).toBeCloseTo(1.1, 12)
    // Bought and sold within the month (nothing at either end): the round trip.
    expect(growth({ start: 0, end: 0, days: 31, flows: [{ day: 5, cents: 100_000 }, { day: 20, cents: -110_000 }] })).toBeCloseTo(1.1, 12)
    // …even on the same day.
    expect(growth({ start: 0, end: 0, days: 31, flows: [{ day: 9, cents: 100_000 }, { day: 9, cents: -99_000 }] })).toBeCloseTo(0.99, 12)
  })

  it('weights a mid-period flow by the days it was at work', () => {
    // $1,000 all month plus $1,000 for the last 15 of 30 days, ending at $2,150:
    // gain $150 on $1,000 + $500 at work → 10%.
    expect(growth({ start: 100_000, end: 215_000, days: 30, flows: [{ day: 15, cents: 100_000 }] })).toBeCloseTo(1.1, 12)
  })

  it('is unmeasurable when value appears from nowhere, the money at work is not positive, or input is not whole', () => {
    expect(periodGrowth({ start: 0, end: 5_000, days: 30, flows: [] })).toBeNull()
    expect(periodGrowth({ start: 100_000, end: 1_000, days: 30, flows: [{ day: 1, cents: -200_000 }] })).toBeNull()
    expect(periodGrowth({ start: 100_000, end: 50_000, days: 30, flows: [{ day: 31, cents: 1 }] })).toBeNull() // day outside the period
    expect(periodGrowth({ start: 100_000.5, end: 50_000, days: 30, flows: [] })).toBeNull()
    expect(periodGrowth({ start: 100_000, end: 50_000, days: 0, flows: [] })).toBeNull()
  })

  it('stays exact where floats would not: cents × days far past 2^53', () => {
    const big = 9_000_000_000_000_000 // $90 trillion, still a safe integer
    const g = periodGrowth({ start: big, end: big, days: 31, flows: [{ day: 10, cents: big }, { day: 20, cents: -big }] })!
    expect(g.num).toBe(g.den) // flat: exactly 1
  })
})

describe('linkReturns', () => {
  it('chains periods into an index from 100 (1_000_000)', () => {
    expect(TWR_BASE).toBe(1_000_000)
    expect(
      link([
        { start: 0, end: 110_000, days: 31, flows: [{ day: 1, cents: 100_000 }] }, // +10%
        { start: 110_000, end: 121_000, days: 30, flows: [] }, // +10%
        { start: 121_000, end: 108_900, days: 31, flows: [] }, // −10%
      ]),
    ).toEqual([1_100_000, 1_210_000, 1_089_000])
  })

  it('a flat price gives exactly 1_000_000, whatever is bought and sold at it', () => {
    const periods: ReturnPeriod[] = [
      { start: 0, end: 100_000, days: 31, flows: [{ day: 3, cents: 100_000 }] },
      { start: 100_000, end: 250_000, days: 28, flows: [{ day: 10, cents: 150_000 }] },
      { start: 250_000, end: 50_000, days: 31, flows: [{ day: 2, cents: -120_000 }, { day: 30, cents: -80_000 }] },
      { start: 50_000, end: 0, days: 30, flows: [{ day: 17, cents: -50_000 }] },
      { start: 0, end: 0, days: 31, flows: [] },
    ]
    expect(link(periods)).toEqual([1_000_000, 1_000_000, 1_000_000, 1_000_000, 1_000_000])
  })

  it('a deposit at the going price does not move the index', () => {
    // 10 shares at $100; the price goes 100 → 110 → 110 → 121 at month ends.
    const without: ReturnPeriod[] = [
      { start: 0, end: 110_000, days: 31, flows: [{ day: 1, cents: 100_000 }] },
      { start: 110_000, end: 110_000, days: 30, flows: [] },
      { start: 110_000, end: 121_000, days: 31, flows: [] },
    ]
    // The same, plus 10 more shares bought for $1,100 mid-month in the flat month, and 5 on the last day of the rising one.
    const withDeposits: ReturnPeriod[] = [
      without[0]!,
      { start: 110_000, end: 220_000, days: 30, flows: [{ day: 12, cents: 110_000 }] },
      { start: 220_000, end: 302_500, days: 31, flows: [{ day: 31, cents: 60_500 }] },
    ]
    expect(link(withDeposits)).toEqual(link(without))
    expect(link(without)).toEqual([1_100_000, 1_100_000, 1_210_000])
  })

  it('a withdrawal does not move it either', () => {
    const without: ReturnPeriod[] = [
      { start: 0, end: 200_000, days: 31, flows: [{ day: 1, cents: 200_000 }] },
      { start: 200_000, end: 220_000, days: 30, flows: [] },
    ]
    // Half sold on the 30th (the last day) at the month-end price.
    const withSale: ReturnPeriod[] = [without[0]!, { start: 200_000, end: 110_000, days: 30, flows: [{ day: 30, cents: -110_000 }] }]
    expect(link(withSale)).toEqual(link(without))
  })

  it('carries flat across a period it cannot measure, and says so', () => {
    const r = linkReturns([
      { start: 0, end: 110_000, days: 31, flows: [{ day: 1, cents: 100_000 }] },
      null,
      { start: 0, end: 5, days: 30, flows: [] }, // value from nowhere
      { start: 110_000, end: 121_000, days: 31, flows: [] },
    ])
    expect(r.index).toEqual([1_100_000, 1_100_000, 1_100_000, 1_210_000])
    expect(r.measured).toEqual([true, false, false, true])
  })

  it('rounds to whole micro once per period and keeps integers throughout', () => {
    const r = link([
      { start: 300_000, end: 300_001, days: 31, flows: [] },
      { start: 300_001, end: 299_999, days: 30, flows: [] },
    ])
    for (const v of r) expect(Number.isSafeInteger(v)).toBe(true)
    expect(r).toEqual([1_000_003, 999_996]) // 1e6 × 300001/300000 = 1000003.33 → 1000003; × 299999/300001 → 999996.33 → 999996
  })
})
