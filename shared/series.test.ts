import { describe, expect, it } from 'vitest'
import {
  alignAsOf,
  anchorIndex,
  asOfIndex,
  cagr,
  changeBp,
  changeMicro,
  commonStart,
  diff,
  grossSaleForNet,
  INDEX_BASE,
  isoWeekIndex,
  maxDrawdown,
  monthsApart,
  pctChange,
  projectToTarget,
  rebase,
  resampleWeekly,
  sma,
  sumAsOf,
  weeklySmaDaily,
} from './series'
import { goalDerived } from '../engine/services'

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

describe('resampleWeekly', () => {
  it('keeps the last close of each ISO (Mon–Sun) week, across a year end', () => {
    const closes = [
      { d: '2025-12-24', c: 1 }, // Wed
      { d: '2025-12-26', c: 2 }, // Fri — last of its week
      { d: '2025-12-29', c: 3 }, // Mon: ISO week 2026-W01 starts here
      { d: '2025-12-31', c: 4 },
      { d: '2026-01-02', c: 5 }, // Fri — same week as Dec 29, despite the new year
      { d: '2026-01-05', c: 6 }, // Mon, next week
    ]
    expect(resampleWeekly(closes).map((p) => p.d)).toEqual(['2025-12-26', '2026-01-02', '2026-01-05'])
  })

  it("takes Sunday for a 7-day market and Thursday for a week that lost its Friday", () => {
    const crypto = ['2026-09-14', '2026-09-15', '2026-09-19', '2026-09-20', '2026-09-21'].map((d, i) => ({ d, c: i }))
    expect(resampleWeekly(crypto).map((p) => p.d)).toEqual(['2026-09-20', '2026-09-21'])
    const holiday = ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'].map((d, i) => ({ d, c: i })) // no Fri
    expect(resampleWeekly(holiday)).toEqual([{ d: '2026-11-26', c: 3 }])
  })

  it('puts every day of one ISO week on one index', () => {
    const week = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']
    expect(new Set(week.map(isoWeekIndex)).size).toBe(1)
    expect(isoWeekIndex('2026-09-28')).toBe(isoWeekIndex('2026-09-27') + 1)
  })
})

describe('weeklySmaDaily (the 200-week line)', () => {
  // 250 five-day weeks; every close in week w is w cents, so weekly closes are 0, 1, 2, … 249.
  const days: { d: string; c: number }[] = []
  const monday0 = Date.UTC(2021, 0, 4) // a Monday
  for (let w = 0; w < 250; w++)
    for (let k = 0; k < 5; k++) days.push({ d: new Date(monday0 + (w * 7 + k) * 86_400_000).toISOString().slice(0, 10), c: w })
  const ma = weeklySmaDaily(days, 200)
  const at = (w: number, k: number) => ma[w * 5 + k]

  it('is null until 200 weekly closes exist, then averages exactly 200 weeks', () => {
    expect(at(199, 3)).toBeNull() // Thursday of week 199: that week has not closed
    expect(at(199, 4)).toBe(Math.round((0 + 199) / 2)) // Friday closes week 199: mean of weeks 0…199 = 99.5 → 100
    expect(at(249, 4)).toBe(Math.round((50 + 249) / 2)) // weeks 50…249
  })

  it('carries the last closed week forward through the next week', () => {
    for (let k = 0; k < 4; k++) expect(at(230, k)).toBe(at(229, 4))
    expect(at(230, 4)).toBe(Math.round((31 + 230) / 2))
  })

  it('is not the old 1,400-trading-day average (≈280 weeks for a stock)', () => {
    expect(sma(days.map((p) => p.c), 1400).every((v) => v === null)).toBe(true) // 1,250 days: never fills
    expect(ma.filter((v) => v !== null).length).toBe(51 * 5 - 4)
  })
})

const D = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

describe('asOfIndex', () => {
  const ts = [D('2026-06-30'), D('2026-07-31'), D('2026-07-31'), D('2026-08-31')]
  it('answers with the last point at or before t', () => {
    expect(asOfIndex(ts, D('2026-05-01'))).toBe(-1)
    expect(asOfIndex(ts, D('2026-06-30'))).toBe(0)
    expect(asOfIndex(ts, D('2026-07-15'))).toBe(0)
    expect(asOfIndex(ts, D('2026-07-31'))).toBe(2) // duplicates: the last one wins
    expect(asOfIndex(ts, D('2027-01-01'))).toBe(3)
    expect(asOfIndex([], D('2026-01-01'))).toBe(-1)
  })
})

describe('alignAsOf (the crosshair across series)', () => {
  // A monthly series (valued at month ends) and a daily one that starts mid-July.
  const monthly = [D('2026-06-30'), D('2026-07-31'), D('2026-08-31')]
  const daily = [D('2026-07-14'), D('2026-07-31'), D('2026-08-12'), D('2026-09-02')]

  it('snaps to the union of every series’ dates, sorted, each once', () => {
    const { ts } = alignAsOf([monthly, daily])
    expect(ts).toEqual([D('2026-06-30'), D('2026-07-14'), D('2026-07-31'), D('2026-08-12'), D('2026-08-31'), D('2026-09-02')])
  })

  it('reads each series as of each snapped date — its previous point between its own dates, −1 before it starts', () => {
    const { ts, at } = alignAsOf([monthly, daily])
    const i = (iso: string) => ts.indexOf(D(iso))
    // Aug 12 is a daily date: the monthly series answers with Jul 31 (stale, "as of Jul 31").
    expect(at[0]![i('2026-08-12')]).toBe(1)
    expect(monthly[at[0]![i('2026-08-12')]!]! < D('2026-08-12')).toBe(true)
    // On its own date it is current.
    expect(at[0]![i('2026-08-31')]).toBe(2)
    // After its last point it keeps answering with that point.
    expect(at[0]![i('2026-09-02')]).toBe(2)
    // The daily series has nothing on Jun 30.
    expect(at[1]![i('2026-06-30')]).toBe(-1)
    expect(at[1]![i('2026-07-14')]).toBe(0)
    expect(at[1]![i('2026-08-31')]).toBe(2)
  })

  it('handles empty series and duplicate dates', () => {
    const { ts, at } = alignAsOf([[], [D('2026-01-31'), D('2026-01-31'), D('2026-02-28')]])
    expect(ts).toEqual([D('2026-01-31'), D('2026-02-28')])
    expect(at[0]).toEqual([-1, -1])
    expect(at[1]).toEqual([1, 2])
    expect(alignAsOf([])).toEqual({ ts: [], at: [] })
  })
})

describe('anchorIndex', () => {
  const ts = [D('2026-01-31'), D('2026-02-28'), D('2026-03-31'), D('2026-04-30'), D('2026-05-31')]
  const vs = [0, 0, 5_000_00, 5_500_00, 6_000_00]
  it('scans for the first point > 0 inside the window, skipping the zeros before an account was funded', () => {
    expect(anchorIndex(ts, vs)).toBe(2)
    expect(anchorIndex(ts, vs, { from: D('2026-04-01') })).toBe(3)
    expect(anchorIndex(ts, vs, { to: D('2026-02-28') })).toBe(-1)
    expect(anchorIndex(ts, [null, -5, 0], {})).toBe(-1)
  })
  it('with an explicit date, answers with the reading as of that date — even a zero, which rebase then refuses', () => {
    expect(anchorIndex(ts, vs, { at: D('2026-04-15') })).toBe(2)
    expect(anchorIndex(ts, vs, { at: D('2026-02-28') })).toBe(1)
    expect(anchorIndex(ts, vs, { at: D('2025-12-31') })).toBe(-1)
  })
})

describe('rebase (index = 100 at the anchor, in index-micro)', () => {
  it('divides by the anchor exactly, in integers', () => {
    expect(INDEX_BASE).toBe(1_000_000)
    expect(rebase([100, 150, 75, null, 300], 0)).toEqual([1_000_000, 1_500_000, 750_000, null, 3_000_000])
    expect(rebase([3, 1, 2], 0)).toEqual([1_000_000, 333_333, 666_667]) // half away from zero
    expect(rebase([200, 100, -50], 1)).toEqual([2_000_000, 1_000_000, -500_000])
  })

  it('refuses a series that is ≤ 0 (or missing) at the anchor', () => {
    expect(rebase([0, 100], 0)).toBeNull()
    expect(rebase([-4_000_00, -3_900_00], 0)).toBeNull() // a liability
    expect(rebase([null, 100], 0)).toBeNull()
    expect(rebase([100], -1)).toBeNull()
    expect(rebase([100], 5)).toBeNull()
  })

  it('blanks the points before a scanned anchor when asked', () => {
    const vs = [0, 0, 5_000_00, 5_500_00]
    const a = anchorIndex([1, 2, 3, 4], vs)
    expect(rebase(vs, a, { dropBefore: true })).toEqual([null, null, 1_000_000, 1_100_000])
    expect(rebase([90, 100, 110], 1)).toEqual([900_000, 1_000_000, 1_100_000])
  })

  it('stays exact where value × 1e6 is past 2^53 (a $100M series)', () => {
    const v = 10_000_000_007 // $100,000,000.07 in cents
    const a = 3
    const got = rebase([a, v], 0)![1]!
    const want = Number((BigInt(v) * 1_000_000n + 1n) / 3n) // remainder 2 of 3 rounds up
    expect(Number.isSafeInteger(v * 1_000_000)).toBe(false)
    expect(got).toBe(want)
  })
})

describe('pctChange (micro-fraction from the anchor)', () => {
  it('reads 0 at the anchor, +10% as 100_000', () => {
    expect(pctChange([100, 110, 90, null], 0)).toEqual([0, 100_000, -100_000, null])
    expect(pctChange([300, 400], 0)).toEqual([0, 333_333])
  })
  it('refuses a non-positive anchor like rebase', () => {
    expect(pctChange([0, 50], 0)).toBeNull()
    expect(pctChange([-10, 50], 0)).toBeNull()
  })
})

describe('changeBp (month-over-month %, integer basis points)', () => {
  it('measures against |prev|, half away from zero', () => {
    expect(changeBp(1_014_00, 1_000_00)).toBe(140) // +1.4%
    expect(changeBp(992_00, 1_000_00)).toBe(-80)
    expect(changeBp(1_000_05, 1_000_00)).toBe(1) // 0.5bp rounds away from zero
    expect(changeBp(999_95, 1_000_00)).toBe(-1)
    expect(changeBp(3_00, 3_00)).toBe(0)
  })
  it('reads a negative base (cash overdrawn, equity under water) by its magnitude', () => {
    // −$100 → −$50 is an improvement of half the base: +50%.
    expect(changeBp(-50_00, -100_00)).toBe(5_000)
    expect(changeBp(-150_00, -100_00)).toBe(-5_000)
  })
  it('refuses a zero base and non-integer input instead of dividing', () => {
    expect(changeBp(500_00, 0)).toBeNull()
    expect(changeBp(0, 0)).toBeNull()
    expect(changeBp(10.5, 10)).toBeNull()
    expect(changeBp(Number.NaN, 10)).toBeNull()
  })
  it('stays exact where the delta × 10,000 is past 2^53', () => {
    const prev = 3
    const cur = 3 + 1_000_000_000_000_001 // an absurd delta, to cross 2^53 after × 10,000
    const want = Number((BigInt(cur - prev) * 10_000n + 1n) / 3n) // remainder 1 of 3 rounds down
    expect(changeBp(cur, prev)).toBe(want)
  })
})

describe('projectToTarget (goal fund projection, integer cents)', () => {
  it('adds the monthly plan from the start month and stops on the first month at or over the target', () => {
    expect(projectToTarget('2026-09', 400_000_00, 100_000_00, 680_000_00, 120)).toEqual([
      { t: '2026-09', v: 400_000_00 },
      { t: '2026-10', v: 500_000_00 },
      { t: '2026-11', v: 600_000_00 },
      { t: '2026-12', v: 700_000_00 },
    ])
  })
  it('ends exactly on the target when the plan divides the gap', () => {
    const p = projectToTarget('2026-11', 0, 50_00, 150_00, 120)
    expect(p.map((x) => x.t)).toEqual(['2026-11', '2026-12', '2027-01', '2027-02'])
    expect(p[p.length - 1]!.v).toBe(150_00)
  })
  it('ends on the month GoalDerived names as the ETA, including from the 31st', () => {
    const goal = { targetPriceCents: 3_000_000_00, downPctMicro: 200_000, closingCents: 80_000_00, fundAccountIds: [], fundExtraCents: 0,
      monthlyPlanCents: 14_520_00, selectedLoanId: null, taxPctMicro: 0, insMonthlyCents: 0, capGainsRateMicro: 0, lossCarryforwardCents: 0, saleBasisPctMicro: 0 }
    for (const today of ['2026-01-31', '2026-08-31', '2026-12-31']) {
      const d = goalDerived(goal, 412_300_00, today)
      const p = projectToTarget(today.slice(0, 7), d.fundCents, d.monthlyPlanCents, d.targetCents, 1200)
      expect(p[p.length - 1]!.t).toBe(d.etaMonth)
      expect(p[p.length - 1]!.v).toBeGreaterThanOrEqual(d.targetCents)
      expect(p[p.length - 2]!.v).toBeLessThan(d.targetCents)
    }
  })
  it('caps the horizon and projects nothing when funded or without a plan', () => {
    expect(projectToTarget('2026-09', 0, 1_00, 1_000_000_00, 24)).toHaveLength(25)
    expect(projectToTarget('2026-09', 700_000_00, 10_000_00, 680_000_00, 120)).toEqual([])
    expect(projectToTarget('2026-09', 0, 0, 680_000_00, 120)).toEqual([])
    expect(projectToTarget('2026-09', 0, -5_00, 680_000_00, 120)).toEqual([])
    expect(projectToTarget('2026-09', 0.5, 5_00, 680_000_00, 120)).toEqual([])
  })
})

describe('sumAsOf (two mortgages → one debt line)', () => {
  it('sums each series as of every recorded date, nothing before a series starts', () => {
    const first = [
      { t: '2024-03-01', v: 800_000_00 },
      { t: '2025-03-01', v: 780_000_00 },
    ]
    const heloc = [
      { t: '2024-09-15', v: 50_000_00 },
      { t: '2025-03-01', v: 45_000_00 },
      { t: '2025-06-30', v: 40_000_00 },
    ]
    expect(sumAsOf([first, heloc])).toEqual([
      { t: '2024-03-01', v: 800_000_00 },
      { t: '2024-09-15', v: 850_000_00 },
      { t: '2025-03-01', v: 825_000_00 },
      { t: '2025-06-30', v: 820_000_00 },
    ])
  })
  it('passes one series through and handles none', () => {
    const one = [{ t: '2026-01-05', v: 5 }]
    expect(sumAsOf([one])).toEqual(one)
    expect(sumAsOf([])).toEqual([])
    expect(sumAsOf([[], []])).toEqual([])
  })
})

describe('diff (Compare A − B, integer cents)', () => {
  it('subtracts month by month on the union of dates, reading each as of the date', () => {
    const a = [
      { t: '2026-01', v: 1_000_00 },
      { t: '2026-02', v: 1_200_00 },
      { t: '2026-03', v: 1_500_00 },
    ]
    const b = [
      { t: '2026-02', v: 300_00 },
      { t: '2026-04', v: 500_00 },
    ]
    // Jan: B has no reading yet → left out. Apr: A as of Mar.
    expect(diff(a, b)).toEqual([
      { t: '2026-02', v: 900_00 },
      { t: '2026-03', v: 1_200_00 },
      { t: '2026-04', v: 1_000_00 },
    ])
  })
  it('skips nulls and non-integers instead of rounding them, and carries est', () => {
    const a = [
      { t: '2026-01', v: 10 },
      { t: '2026-02', v: null },
      { t: '2026-03', v: 10.5 },
      { t: '2026-04', v: 7, est: true },
    ]
    const b = [{ t: '2026-01', v: 3 }]
    expect(diff(a, b)).toEqual([
      { t: '2026-01', v: 7 },
      { t: '2026-04', v: 4, est: true },
    ])
  })
  it('stays exact on large balances and goes negative when B is bigger', () => {
    const a = [{ t: '2026-01', v: 9_007_199_254_740_000 }]
    const b = [{ t: '2026-01', v: 9_007_199_254_740_991 }]
    expect(diff(a, b)).toEqual([{ t: '2026-01', v: -991 }])
    expect(diff([], b)).toEqual([])
  })
})

describe('monthsApart', () => {
  it('counts calendar months, reading days by their month', () => {
    expect(monthsApart('2025-09', '2026-09')).toBe(12)
    expect(monthsApart('2025-12-31', '2026-01-01')).toBe(1)
    expect(monthsApart('2026-03', '2026-01')).toBe(-2)
    expect(() => monthsApart('2026', '2026-01')).toThrow()
  })
})

describe('changeMicro', () => {
  it('measures against |prev| with half-away rounding; null without a base', () => {
    expect(changeMicro(110_00, 100_00)).toBe(100_000)
    expect(changeMicro(-400_000_00, -500_000_00)).toBe(200_000) // a debt shrinking reads as a rise
    expect(changeMicro(2, 3)).toBe(-333_333)
    expect(changeMicro(1, 0)).toBeNull()
    expect(changeMicro(1.5, 1)).toBeNull()
  })
})

describe('cagr (compound annual growth, micro per year)', () => {
  it('annualizes over the months given', () => {
    expect(cagr(100_00, 110_00, 12)).toBe(100_000)
    expect(cagr(100_00, 121_00, 24)).toBe(100_000) // 1.21 over two years = 10%/yr
    expect(cagr(100_00, 100_00, 36)).toBe(0)
    expect(cagr(1_000_000, 2_000_000, 120)).toBe(71_773) // doubling in 10 years ≈ 7.18%/yr
    expect(cagr(100_00, 0, 12)).toBe(-1_000_000)
  })
  it('refuses under a year, from zero or a debt, below zero, or on non-integers', () => {
    expect(cagr(100_00, 150_00, 11)).toBeNull()
    expect(cagr(0, 150_00, 24)).toBeNull()
    expect(cagr(-100_00, 150_00, 24)).toBeNull()
    expect(cagr(100_00, -1, 24)).toBeNull()
    expect(cagr(100.5, 150_00, 24)).toBeNull()
  })
})

describe('maxDrawdown', () => {
  it('finds the deepest peak-to-low fall, in micro of the peak', () => {
    //            0    1    2    3    4    5
    const v = [100, 120, 90, 130, 104, 125]
    // 120 → 90 is 25%; 130 → 104 is 20%.
    expect(maxDrawdown(v)).toEqual({ micro: 250_000, peak: 1, trough: 2 })
  })
  it('is 0 for a series that never fell; skips nulls; ignores non-positive peaks', () => {
    expect(maxDrawdown([1, 2, null, 3])).toEqual({ micro: 0, peak: 0, trough: 0 })
    expect(maxDrawdown([-500, -400, -450])).toBeNull()
    expect(maxDrawdown([null, null])).toBeNull()
    expect(maxDrawdown([0, 10, 0])).toEqual({ micro: 1_000_000, peak: 1, trough: 2 })
  })
  it('stays exact past 2^53 intermediate products', () => {
    const peak = 9_000_000_000_000
    expect(maxDrawdown([peak, peak - 1])!.micro).toBe(0) // 1/9e12 of the peak rounds to 0 micro
    expect(maxDrawdown([peak, peak / 3])!.micro).toBe(666_667)
  })
})

describe('commonStart (one anchor for overlaid lines)', () => {
  it('is the latest first-positive date; series with none do not vote', () => {
    const spy = [
      { t: '2016-10', v: 1_000_000 },
      { t: '2026-09', v: 3_600_000 },
    ]
    const twr = [
      { t: '2025-11', v: null },
      { t: '2025-12', v: 1_010_000 },
    ]
    const acct = [
      { t: '2025-10', v: 0 },
      { t: '2025-11', v: 500_00 },
    ]
    const debt = [{ t: '2024-01', v: -100 }]
    expect(commonStart([spy, twr, acct, debt])).toBe('2025-12')
    expect(commonStart([debt])).toBeNull()
    expect(commonStart([])).toBeNull()
  })
})
