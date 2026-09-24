import { describe, expect, it } from 'vitest'
import { blendMa, maSpanMs, timeWeightedMa } from './maModel'
import { DAY_MS } from './scale'

const T = (iso: string) => Date.parse(`${iso}T00:00:00Z`)

describe('maSpanMs', () => {
  it('turns trading days into calendar time for a stock, and not for crypto', () => {
    expect(maSpanMs({ kind: 'days', n: 252 }, 'stock')).toBe(365.25 * DAY_MS)
    expect(maSpanMs({ kind: 'days', n: 50 }, 'crypto')).toBe(50 * DAY_MS)
    expect(maSpanMs({ kind: 'weeks', n: 200 }, 'stock')).toBe(1400 * DAY_MS)
  })
})

describe('timeWeightedMa', () => {
  it('is null until the history reaches back a whole window, then the mean of the line as drawn', () => {
    // A straight line from 100 to 400 over 30 days: over the last 10 days it averages the midpoint.
    const ts = [T('2026-01-01'), T('2026-01-31')]
    expect(timeWeightedMa(ts, [100, 400], 10 * DAY_MS)).toEqual([null, 350])
    expect(timeWeightedMa(ts, [100, 400], 30 * DAY_MS)).toEqual([null, 250])
    expect(timeWeightedMa(ts, [100, 400], 31 * DAY_MS)).toEqual([null, null])
  })

  it('weighs a month-end by the month it stands for, not as one close among dailies', () => {
    // 1000 at two month-ends, then ten daily closes at 2000: a count of closes would call the last
    // 12 closes' mean ≈ 1833; over the 38 days before the last close the line spends most of its time near 1000.
    const ts = [T('2026-01-31'), T('2026-02-28'), ...Array.from({ length: 10 }, (_, k) => T('2026-03-01') + k * DAY_MS)]
    const vs = [1000, 1000, ...Array.from({ length: 10 }, () => 2000)]
    const ma = timeWeightedMa(ts, vs, 38 * DAY_MS)
    // Window: Jan 31 → Mar 10. 28 days at 1000, the jump to 2000 over Feb 28–Mar 1 (1 day, mean 1500), then 9 days at 2000.
    expect(ma.at(-1)).toBe((28 * 1000 + 1500 + 9 * 2000) / 38)
    expect(ma.at(-1)).toBe(1250)
    expect(ma.slice(0, 11).every((v) => v === null)).toBe(true) // Mar 9 − 38 days is before the first close
  })

  it('agrees with a plain average on evenly spaced closes', () => {
    const ts = Array.from({ length: 6 }, (_, k) => T('2026-01-01') + k * DAY_MS)
    const vs = [10, 20, 30, 40, 50, 60]
    // Over 2 days before close 5: the line from 40 to 60 averages 50.
    expect(timeWeightedMa(ts, vs, 2 * DAY_MS)).toEqual([null, null, 20, 30, 40, 50])
  })

  it('survives short or empty input', () => {
    expect(timeWeightedMa([], [], DAY_MS)).toEqual([])
    expect(timeWeightedMa([T('2026-01-01')], [5], DAY_MS)).toEqual([null])
  })
})

describe('blendMa', () => {
  it('uses the count-of-closes average only where its whole window is daily', () => {
    const ts = [T('2026-01-31'), T('2026-02-28'), T('2026-03-02'), T('2026-03-03'), T('2026-03-04')]
    const exact = [null, null, 1, 2, 3]
    const timed = [null, 10, 20, 30, 40]
    expect(blendMa(ts, exact, timed, T('2026-03-02'), 1 * DAY_MS)).toEqual([null, 10, 20, 2, 3])
    expect(blendMa(ts, exact, timed, null, 1 * DAY_MS)).toEqual(timed)
  })
})
