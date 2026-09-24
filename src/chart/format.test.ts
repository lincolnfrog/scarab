import { describe, expect, it } from 'vitest'
import { axisMonth, fmtShort, ringPath } from '../viz'
import { placeTip } from './ChartTip'
import { fmtAxis, fmtChangeBp, fmtIndex, fmtPctMicro, monthLong, shortDay } from './format'

describe('fmtAxis', () => {
  it('carries a rounding across the unit boundary', () => {
    expect(fmtAxis(999_950_00, 'cents')).toBe('$1.0M')
    expect(fmtAxis(99_960, 'cents')).toBe('$1.0K') // $999.60
  })
  it('drops the decimal on exact multiples', () => {
    expect(fmtAxis(5_000_000_00, 'cents')).toBe('$5M')
    expect(fmtAxis(250_000, 'cents')).toBe('$2.5K')
    expect(fmtAxis(1_000_000_00, 'cents')).toBe('$1M')
    expect(fmtAxis(85_000, 'cents')).toBe('$850')
    expect(fmtAxis(0, 'cents')).toBe('$0')
  })
  it('keeps cents under $10 and one decimal under 100 of a unit', () => {
    expect(fmtAxis(450, 'cents')).toBe('$4.50')
    expect(fmtAxis(500, 'cents')).toBe('$5')
    expect(fmtAxis(2_676_698, 'cents')).toBe('$26.8K')
    expect(fmtAxis(26_800_000, 'cents')).toBe('$268K')
    expect(fmtAxis(-1_250_000_00, 'cents')).toBe('−$1.3M')
    expect(fmtAxis(1_234_000_000_00, 'cents')).toBe('$1.2B')
  })
  it('formats percent (micro) and index (micro) axes', () => {
    expect(fmtAxis(120_000, 'pct')).toBe('+12%')
    expect(fmtAxis(-25_000, 'pct')).toBe('−2.5%')
    expect(fmtAxis(0, 'pct')).toBe('0%')
    expect(fmtAxis(1_000_000, 'index')).toBe('100')
    expect(fmtAxis(1_125_000, 'index')).toBe('112.5')
  })
  it('groups thousands on big percent and index ticks, like the tooltips', () => {
    expect(fmtAxis(200_000_000, 'pct')).toBe('+20,000%')
    expect(fmtAxis(-1_000_000, 'pct')).toBe('−100%')
    expect(fmtAxis(600_000_000, 'index')).toBe('60,000')
    expect(fmtAxis(12_500_000, 'index')).toBe('1,250')
    expect(fmtAxis(9_990_000, 'index')).toBe('999')
  })
})

describe('fmtShort (source-compatible, fixed at the boundary)', () => {
  it('never prints $1000K', () => {
    expect(fmtShort(99_995_000)).toBe('$1.0M')
    expect(fmtShort(99_960)).toBe('$1K')
    expect(fmtShort(7_800_000)).toBe('$78K')
    expect(fmtShort(120_000_000)).toBe('$1.2M')
    expect(fmtShort(8_500)).toBe('$85')
    expect(fmtShort(-7_800_000)).toBe('-$78K')
    expect(fmtShort(996_000_000)).toBe('$10M')
  })
})

describe('placeTip', () => {
  const box = { w: 600, h: 230 }
  const tip = { w: 180, h: 70 }
  it('sits right of the point when it fits', () => {
    expect(placeTip({ x: 100, y: 120 }, tip, box)).toEqual({ left: 114, top: 80, flipped: false })
  })
  it('flips to the left near the right edge instead of clamping over the point', () => {
    const p = placeTip({ x: 520, y: 120 }, tip, box)
    expect(p.flipped).toBe(true)
    expect(p.left).toBe(520 - 14 - 180)
    expect(p.left + tip.w).toBeLessThan(520)
  })
  it('clamps inside only when neither side fits', () => {
    const p = placeTip({ x: 100, y: 120 }, { w: 560, h: 70 }, { w: 600, h: 230 })
    expect(p.left).toBe(600 - 4 - 560)
  })
  it('stays inside the box vertically', () => {
    expect(placeTip({ x: 100, y: 10 }, tip, box).top).toBe(4)
    expect(placeTip({ x: 100, y: 229 }, tip, box, { rise: 0 }).top).toBe(230 - 4 - 70)
  })
})

describe('ringPath (donut segments)', () => {
  it('draws 100% of one class as two half arcs per edge, so the ring never vanishes', () => {
    const d = ringPath(84, 84, 74, 51, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2)
    expect(d.match(/A74 74/g)).toHaveLength(2)
    expect(d.match(/A51 51/g)).toHaveLength(2)
    expect(d).toContain('M84.00 10.00A74 74 0 0 1 84.00 158.00A74 74 0 0 1 84.00 10.00Z')
  })
  it('draws a partial segment as one arc per edge, large-arc past half a turn', () => {
    const quarter = ringPath(84, 84, 74, 51, 0, Math.PI / 2)
    expect(quarter.match(/A74 74 0 0 1/g)).toHaveLength(1)
    expect(ringPath(84, 84, 74, 51, 0, Math.PI * 1.5)).toContain('A74 74 0 1 1')
  })
})

describe('axisMonth', () => {
  it('puts the year on the first, the last and January only', () => {
    const months = ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']
    expect(months.map((_, i) => axisMonth(months, i))).toEqual(["Nov '25", 'Dec', "Jan '26", 'Feb', "Mar '26"])
  })
})

describe('fmtChangeBp', () => {
  it('prints tenths of a percent, unsigned, rounded half away from zero', () => {
    expect(fmtChangeBp(140)).toBe('1.4%')
    expect(fmtChangeBp(-80)).toBe('0.8%')
    expect(fmtChangeBp(145)).toBe('1.5%')
    expect(fmtChangeBp(-145)).toBe('1.5%')
    expect(fmtChangeBp(144)).toBe('1.4%')
    expect(fmtChangeBp(12_345)).toBe('123.5%')
    expect(fmtChangeBp(1_000_000)).toBe('10,000.0%')
  })
  it('never prints a false 0.0% for a real change', () => {
    expect(fmtChangeBp(0)).toBe('0%')
    expect(fmtChangeBp(4)).toBe('<0.1%')
    expect(fmtChangeBp(5)).toBe('0.1%')
    expect(fmtChangeBp(Number.NaN)).toBe('')
  })
})

describe('monthLong / shortDay', () => {
  it('names months and days without a Date (no time-zone shift)', () => {
    expect(monthLong('2027-11')).toBe('Nov 2027')
    expect(monthLong('2027-01-31')).toBe('Jan 2027')
    expect(monthLong('soon')).toBe('soon')
    expect(shortDay('2026-08-04', '2026-09-23')).toBe('Aug 4')
    expect(shortDay('2025-12-30', '2026-01-02')).toBe('Dec 30, 2025')
    expect(shortDay('2026-01-01', '2026-01-01')).toBe('Jan 1')
    expect(shortDay('bad', '2026-01-01')).toBe('bad')
  })
})

describe('fmtPctMicro / fmtIndex', () => {
  it('prints a micro-fraction with one decimal, signed on request with a real minus', () => {
    expect(fmtPctMicro(590_727)).toBe('59.1%')
    expect(fmtPctMicro(590_727, { sign: true })).toBe('+59.1%')
    expect(fmtPctMicro(-240_000, { sign: true })).toBe('−24.0%')
    expect(fmtPctMicro(-240_000)).toBe('−24.0%')
    expect(fmtPctMicro(3_659, { sign: true })).toBe('+0.4%')
    expect(fmtPctMicro(1_050)).toBe('0.1%') // 0.105% → half away from zero
    expect(fmtPctMicro(12_345_678)).toBe('1,234.6%')
  })
  it('never prints a false 0.0%', () => {
    expect(fmtPctMicro(0, { sign: true })).toBe('0%')
    expect(fmtPctMicro(499)).toBe('<0.1%')
    expect(fmtPctMicro(-499, { sign: true })).toBe('−<0.1%')
    expect(fmtPctMicro(1.5)).toBe('')
  })
  it('prints an index on a 100 base', () => {
    expect(fmtIndex(1_125_000)).toBe('112.5')
    expect(fmtIndex(1_000_000)).toBe('100.0')
    expect(fmtIndex(925_143)).toBe('92.5')
    expect(fmtIndex(36_385_790)).toBe('3,638.6')
  })
})
