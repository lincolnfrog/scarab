import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { addMonthsUTC, decimateM4, fmtDay, indexTicks, logTicks, monthTicks, nearestIndex, niceTicks, parseT, timeTicks } from './scale'

describe('niceTicks', () => {
  it('rounds a net-worth range to 0/10M/20M/30M', () => {
    expect(niceTicks(0, 26_766_984)).toEqual({ ticks: [0, 10_000_000, 20_000_000, 30_000_000], lo: 0, hi: 30_000_000, step: 10_000_000 })
  })

  it('always covers the data with 1-2-5 steps', () => {
    for (const [lo, hi] of [
      [0, 134_000],
      [-52_000, 410_000],
      [4_812, 38_510],
      [0.13, 0.91],
      [1_000_000, 1_000_450],
    ] as const) {
      const t = niceTicks(lo, hi)
      expect(t.lo).toBeLessThanOrEqual(lo)
      expect(t.hi).toBeGreaterThanOrEqual(hi)
      const mant = t.step / Math.pow(10, Math.floor(Math.log10(t.step)))
      expect([1, 2, 5]).toContain(Math.round(mant))
      expect(t.ticks[0]).toBe(t.lo)
      expect(t.ticks[t.ticks.length - 1]).toBe(t.hi)
      for (let i = 1; i < t.ticks.length; i++) expect(t.ticks[i]! - t.ticks[i - 1]!).toBeCloseTo(t.step, 9)
    }
  })

  it('has no float dust and handles flat or empty ranges', () => {
    expect(niceTicks(0, 0.3, 4).ticks).toEqual([0, 0.1, 0.2, 0.3])
    expect(niceTicks(0, 0)).toMatchObject({ lo: 0, hi: 1 })
    const flat = niceTicks(500, 500)
    expect(flat.lo).toBeLessThan(500)
    expect(flat.hi).toBeGreaterThan(500)
    expect(niceTicks(0, 3, 8, { integerStep: true }).step).toBe(1)
  })
})

describe('logTicks', () => {
  it('gives at least three ticks for 4,800–38,500 and every window inside it', () => {
    expect(logTicks(4_800, 38_500)).toEqual([5_000, 10_000, 20_000])
    for (let lo = 4_800; lo < 38_000; lo *= 1.07)
      for (const ratio of [1.01, 1.05, 1.2, 1.6, 2, 3, 5, 8]) {
        const hi = Math.min(38_500, lo * ratio)
        const ticks = logTicks(lo, hi)
        expect(ticks.length, `${lo}–${hi}`).toBeGreaterThanOrEqual(3)
        for (const t of ticks) {
          expect(t).toBeGreaterThanOrEqual(lo * (1 - 1e-9))
          expect(t).toBeLessThanOrEqual(hi * (1 + 1e-9))
        }
      }
  })

  it('thins to powers of ten over many decades', () => {
    expect(logTicks(3, 4_000_000)).toEqual([10, 100, 1_000, 10_000, 100_000, 1_000_000])
  })
})

describe('parseT', () => {
  it('reads days, months (month end; the current month is today) and years at UTC midnight', () => {
    expect(parseT('2026-09-22')).toBe(Date.UTC(2026, 8, 22))
    expect(parseT('2026-02', '2026-09-23')).toBe(Date.UTC(2026, 1, 28))
    expect(parseT('2024-02', '2026-09-23')).toBe(Date.UTC(2024, 1, 29))
    expect(parseT('2026-09', '2026-09-23')).toBe(Date.UTC(2026, 8, 23))
    expect(parseT('2027-03', '2026-09-23')).toBe(Date.UTC(2027, 2, 31))
    expect(parseT('2031')).toBe(Date.UTC(2031, 0, 1))
  })
  it('is NaN for anything else', () => {
    for (const bad of ['', '2026-13', '2026-02-30', '26-01-01', 'Sep 2026']) expect(parseT(bad, '2026-09-23')).toBeNaN()
  })
})

describe('timeTicks', () => {
  it('puts the year on the first tick of seven months', () => {
    const ticks = timeTicks(parseT('2026-02', '2026-09-23'), parseT('2026-09', '2026-09-23'), 600)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks[0]!.label).toMatch(/'26$/)
    expect(ticks.slice(1).every((t) => !/'/.test(t.label))).toBe(true)
  })

  it('labels January with its year inside a month axis', () => {
    const ticks = timeTicks(Date.UTC(2025, 8, 30), Date.UTC(2026, 5, 30), 800)
    const jan = ticks.find((t) => t.t === Date.UTC(2026, 0, 1))
    expect(jan).toMatchObject({ label: "Jan '26", major: true })
  })

  it('gives 25 years at 800px at least ten evenly spaced year ticks', () => {
    const ticks = timeTicks(Date.UTC(2001, 0, 1), Date.UTC(2026, 0, 1), 800)
    expect(ticks.length).toBeGreaterThanOrEqual(10)
    const years = ticks.map((t) => Number(t.label))
    const step = years[1]! - years[0]!
    expect(step).toBeGreaterThan(0)
    for (let i = 1; i < years.length; i++) expect(years[i]! - years[i - 1]!).toBe(step)
    expect(years.every((y) => y % step === 0)).toBe(true)
    // …and never more than fit: 56px apart at the default gap
    const pxPerMs = 800 / (Date.UTC(2026, 0, 1) - Date.UTC(2001, 0, 1))
    expect((ticks[1]!.t - ticks[0]!.t) * pxPerMs).toBeGreaterThanOrEqual(56)
  })

  it('is not capped at 14 ticks (bug #31)', () => {
    expect(timeTicks(Date.UTC(1990, 0, 1), Date.UTC(2026, 0, 1), 3000).length).toBeGreaterThan(14)
  })

  describe('in America/Los_Angeles', () => {
    const saved = process.env.TZ
    beforeAll(() => {
      process.env.TZ = 'America/Los_Angeles'
    })
    afterAll(() => {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    })

    it('labels Jan 1 with its own year', () => {
      // The zone really is in effect: a local-time read of Jan 1 UTC lands in the old year (the bug).
      expect(new Date(Date.parse('2026-01-01')).getFullYear()).toBe(2025)
      const t = parseT('2026-01-01')
      expect(t).toBe(Date.UTC(2026, 0, 1))
      const years = timeTicks(Date.UTC(2016, 5, 1), Date.UTC(2026, 5, 1), 800)
      expect(years.find((k) => k.t === t)?.label).toBe('2026')
      const months = timeTicks(Date.UTC(2025, 6, 1), Date.UTC(2026, 3, 1), 800)
      expect(months.find((k) => k.t === t)?.label).toBe("Jan '26")
      expect(fmtDay(t)).toBe('Jan 1, 2026')
    })
  })
})

describe('indexTicks', () => {
  it('always labels the first and last, capped at max', () => {
    expect(indexTicks(0, 6)).toEqual([])
    expect(indexTicks(1, 6)).toEqual([0])
    expect(indexTicks(5, 6)).toEqual([0, 1, 2, 3, 4])
    const t = indexTicks(24, 6)
    expect(t[0]).toBe(0)
    expect(t[t.length - 1]).toBe(23)
    expect(t.length).toBeLessThanOrEqual(6)
  })
  it('prefers a January when one is within half a stride', () => {
    // 24 months starting in Sep: Januaries at 4 and 16
    const jan = (i: number) => (8 + i) % 12 === 0
    const t = indexTicks(24, 6, jan)
    expect(t).toContain(4)
    expect(t).toContain(16)
    expect(t[t.length - 1]).toBe(23)
  })
})

describe('decimateM4', () => {
  // A long random walk with a planted global minimum and maximum.
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
  const n = 20_000
  const ts = Array.from({ length: n }, (_, i) => Date.UTC(1990, 0, 1) + i * 86_400_000)
  const vs: (number | null)[] = []
  let v = 10_000
  for (let i = 0; i < n; i++) vs.push((v += Math.round((rnd() - 0.5) * 200)))
  vs[12_345] = -99_999
  vs[777] = 999_999

  it('keeps the global minimum, the maximum and the last point, in ≤ 4 per column', () => {
    const keep = decimateM4(ts, vs, ts[0]!, ts[n - 1]!, 400)
    expect(keep).toContain(12_345)
    expect(keep).toContain(777)
    expect(keep[keep.length - 1]).toBe(n - 1)
    expect(keep[0]).toBe(0)
    expect(keep.length).toBeLessThanOrEqual(4 * 401 + 2)
    for (let i = 1; i < keep.length; i++) expect(keep[i]!).toBeGreaterThan(keep[i - 1]!)
  })

  it('keeps one neighbour outside the window and a gap marker', () => {
    const withGap = [...vs]
    withGap[15_000] = null
    const t0 = ts[5_000]!
    const t1 = ts[18_000]!
    const keep = decimateM4(ts, withGap, t0, t1, 300)
    expect(keep[0]).toBe(4_999)
    expect(keep[keep.length - 1]).toBe(18_001)
    expect(keep).toContain(15_000)
  })

  it('returns everything when it already fits', () => {
    expect(decimateM4([1, 2, 3], [5, null, 7], 1, 3, 800)).toEqual([0, 1, 2])
    expect(decimateM4([], [], 0, 1, 800)).toEqual([])
  })

  it('finds the nearest index', () => {
    expect(nearestIndex([10, 20, 30], 24)).toBe(1)
    expect(nearestIndex([10, 20, 30], 26)).toBe(2)
    expect(nearestIndex([10, 20, 30], -5)).toBe(0)
    expect(nearestIndex([], 3)).toBe(-1)
  })
})

describe('monthTicks (month-granular data)', () => {
  const today = '2026-09-23'
  const months = (from: string, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const [y, m] = from.split('-').map(Number)
      const d = new Date(Date.UTC(y!, m! - 1 + i, 1))
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    })

  it("puts each month's tick on its own point — month end, the current month at today", () => {
    const ms = months('2026-03', 7) // Mar … Sep 2026
    const ts = ms.map((m) => parseT(m, today))
    const ticks = monthTicks(ts[0]!, ts[ts.length - 1]!, 800, 56, today)
    expect(ticks.map((k) => k.label)).toEqual(["Mar '26", 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'])
    expect(ticks.map((k) => k.t)).toEqual(ts)
    expect(ticks[ticks.length - 1]!.t).toBe(parseT('2026-09-23'))
    // Aug's tick is Aug 31, not Sep 1 — the label sits under the August value.
    expect(new Date(ticks[5]!.t).toISOString().slice(0, 10)).toBe('2026-08-31')
  })

  it('labels January with its year, and quarters land on Jan/Apr/Jul/Oct points', () => {
    const ms = months('2024-11', 23) // Nov 2024 … Sep 2026
    const ts = ms.map((m) => parseT(m, today))
    const ticks = monthTicks(ts[0]!, ts[ts.length - 1]!, 360, 56, today)
    const labels = ticks.map((k) => k.label)
    expect(labels[0]).toMatch(/'2[45]$/)
    expect(labels).toContain("Jan '26")
    for (const k of ticks) expect(ts).toContain(k.t)
    expect(ticks.every((k) => ['Jan', 'Apr', 'Jul', 'Oct'].some((m) => k.label.startsWith(m)))).toBe(true)
  })

  it('gives 25 years at 800px evenly spaced year ticks on January points', () => {
    const ts = months('2001-09', 301).map((m) => parseT(m, today))
    const ticks = monthTicks(ts[0]!, ts[ts.length - 1]!, 800, 56, today)
    expect(ticks.length).toBeGreaterThanOrEqual(10)
    const years = ticks.map((k) => Number(k.label))
    const steps = new Set(years.slice(1).map((y, i) => y - years[i]!))
    expect(steps.size).toBe(1)
    for (const k of ticks) expect(new Date(k.t).toISOString().slice(5, 10)).toBe('01-31')
  })

  it('never lets the current month crowd the one before it', () => {
    const early = '2026-09-02'
    const ts = months('2026-06', 4).map((m) => parseT(m, early))
    const ticks = monthTicks(ts[0]!, ts[ts.length - 1]!, 300, 56, early)
    expect(ticks.map((k) => k.label)).toEqual(["Jun '26", 'Jul', 'Aug'])
  })
})

describe('addMonthsUTC', () => {
  it('moves by calendar months and clamps the day', () => {
    const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
    expect(iso(addMonthsUTC(Date.UTC(2026, 8, 23), -12))).toBe('2025-09-23')
    expect(iso(addMonthsUTC(Date.UTC(2026, 2, 31), -1))).toBe('2026-02-28')
    expect(iso(addMonthsUTC(Date.UTC(2026, 0, 15), -3))).toBe('2025-10-15')
  })
})
