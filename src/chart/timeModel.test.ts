import { describe, expect, it } from 'vitest'
import { alignAsOf } from '../../shared/series'
import { parseT } from './scale'
import {
  allMonthly,
  asOfText,
  availablePresets,
  capRugNotes,
  carryForward,
  rugPathData,
  RUG_NOTES_MAX,
  domainOf,
  fmtValue,
  linePaths,
  placeMarkerLabels,
  presetWindow,
  wantsDollars,
  zoomWindow, placeThresholdLabel } from './timeModel'

const D = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)

describe('range presets', () => {
  const tMin = D('2024-06-30')
  const tMax = D('2026-09-23')

  it('shows the last N calendar months up to the newest point', () => {
    expect(iso(presetWindow('1Y', tMin, tMax).t0)).toBe('2025-09-23')
    expect(iso(presetWindow('3M', tMin, tMax).t0)).toBe('2026-06-23')
    expect(presetWindow('ALL', tMin, tMax)).toEqual({ t0: tMin, t1: tMax })
    // Never before the first point.
    expect(presetWindow('5Y', tMin, tMax).t0).toBe(tMin)
  })

  it('offers only presets shorter than the data, plus ALL', () => {
    expect(availablePresets(['3M', '6M', '1Y', '2Y', '5Y', 'ALL'], tMin, tMax)).toEqual(['3M', '6M', '1Y', '2Y', 'ALL'])
    // Eight months of history: 1Y and longer would only repeat ALL.
    expect(availablePresets(['6M', '1Y', '2Y', 'ALL'], D('2026-01-31'), tMax)).toEqual(['6M', 'ALL'])
    // Two months: nothing but ALL, which means no picker.
    expect(availablePresets(['3M', '1Y', 'ALL'], D('2026-07-31'), tMax)).toEqual(['ALL'])
  })
})

describe('drag-to-zoom windows', () => {
  const ts = ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31'].map(D)
  const within = { t0: ts[0]!, t1: ts[4]! }

  it('keeps a brushed window with at least two dates in it, in either drag direction, clamped to the view', () => {
    expect(zoomWindow(D('2026-02-15'), D('2026-04-15'), within, ts)).toEqual({ t0: D('2026-02-15'), t1: D('2026-04-15') })
    expect(zoomWindow(D('2026-04-15'), D('2026-02-15'), within, ts)).toEqual({ t0: D('2026-02-15'), t1: D('2026-04-15') })
    expect(zoomWindow(D('2025-01-01'), D('2026-02-28'), within, ts)).toEqual({ t0: ts[0], t1: ts[1] })
  })

  it('ignores a brush that would leave fewer than two dates to draw', () => {
    expect(zoomWindow(D('2026-02-10'), D('2026-03-10'), within, ts)).toBeNull()
    expect(zoomWindow(D('2027-01-01'), D('2027-06-01'), within, ts)).toBeNull()
  })

  it('pads a single date so its point sits mid-plot', () => {
    const w = domainOf({ t0: ts[2]!, t1: ts[2]! })
    expect(w.t1 - ts[2]!).toBe(ts[2]! - w.t0)
    expect(w.t1).toBeGreaterThan(w.t0)
  })
})

describe('linePaths', () => {
  const ts = [0, 1, 2, 3, 4, 5]
  const x = (t: number) => t * 10
  const y = (v: number) => 100 - v

  it('dashes every segment that touches an estimated point, and keeps one subpath per run', () => {
    const vs = [10, 20, 30, 40, 50, 60]
    const est = [false, false, true, false, false, false]
    const p = linePaths([0, 1, 2, 3, 4, 5], ts, vs, est, x, y)
    expect(p.solid).toBe('M0 90L10 80M30 60L40 50L50 40')
    expect(p.est).toBe('M10 80L20 70L30 60')
  })

  it('breaks at nulls and closes one area polygon per unbroken run', () => {
    const p = linePaths([0, 1, 2, 3, 4], ts, [10, 20, null, 40, 50], [false, false, false, false, false], x, y, { yBase: 100 })
    expect(p.solid).toBe('M0 90L10 80M30 60L40 50')
    expect(p.est).toBe('')
    expect(p.area).toBe('M0 100L0 90L10 80L10 100ZM30 100L30 60L40 50L40 100Z')
  })

  it('draws steps as hold-then-jump', () => {
    const p = linePaths([0, 1, 2], ts, [10, 20, 20], [false, false, false], x, y, { step: true })
    expect(p.solid).toBe('M0 90L10 90L10 80L20 80L20 80')
  })

  it('draws nothing for a lone point (the dot marks it)', () => {
    expect(linePaths([0], ts, [10], [false], x, y, { yBase: 100 })).toEqual({ solid: '', est: '', area: '' })
  })
})

describe('placeMarkerLabels', () => {
  it('puts labels right of their line, flips left near the edge, stacks a second row, and drops what cannot fit', () => {
    const got = placeMarkerLabels(
      [
        { id: 'today', x: 100, label: 'Today' },
        { id: 'buy', x: 120, label: 'Buy dream home' },
        { id: 'retire', x: 580, label: 'Retire' },
        { id: 'x', x: 110, label: 'Crossing' },
      ],
      50,
      600,
    )
    const by = Object.fromEntries(got.map((l) => [l.id, l]))
    expect(by.today).toEqual({ id: 'today', x: 106, row: 0, anchor: 'start' })
    expect(by.x!.row).toBe(1) // collides with Today on row 0
    expect(by.retire).toEqual({ id: 'retire', x: 574, row: 0, anchor: 'end' }) // no room to its right
    expect(by.buy).toBeUndefined() // both rows taken around it: the line stays, the label goes
  })
})

describe('tooltip text', () => {
  it('reads money in whole dollars over $10,000, cents under; pct and index in their micro units', () => {
    expect(fmtValue(81_230_049, 'cents', true)).toBe('$812,300')
    expect(fmtValue(31_245, 'cents', false)).toBe('$312.45')
    expect(fmtValue(-4_000_000, 'cents', true)).toBe('-$40,000')
    expect(fmtValue(123_456, 'pct', false)).toBe('+12.3%')
    expect(fmtValue(-50_000, 'pct', false)).toBe('-5.0%')
    expect(fmtValue(1_124_500, 'index', false)).toBe('112.5') // index-micro: 1_000_000 = 100
    expect(wantsDollars([31_245, null, 999_999])).toBe(false)
    expect(wantsDollars([31_245, -1_000_000])).toBe(true)
  })

  it('marks an old reading "as of" its own date, with the year only when it differs', () => {
    expect(asOfText(D('2026-08-31'), D('2026-09-12'))).toBe('as of Aug 31')
    expect(asOfText(D('2025-12-31'), D('2026-01-14'))).toBe('as of Dec 31, 2025')
  })

  it('recognises month-granular data', () => {
    expect(allMonthly(['2026-08', '2026-09'])).toBe(true)
    expect(allMonthly(['2026-08', '2026-09-12'])).toBe(false)
    expect(allMonthly([])).toBe(false)
  })
})

describe('as-of reading across a monthly and a daily series (the crosshair contract)', () => {
  it('reads the monthly line as of its last month end on a mid-month day', () => {
    const today = '2026-09-23'
    const monthly = ['2026-07', '2026-08', '2026-09'].map((m) => parseT(m, today)) // Jul 31, Aug 31, today
    const daily = ['2026-08-28', '2026-09-11', '2026-09-22'].map((d) => parseT(d, today))
    const { ts, at } = alignAsOf([monthly, daily])
    const k = ts.indexOf(parseT('2026-09-11'))
    const j = at[0]![k]!
    expect(iso(monthly[j]!)).toBe('2026-08-31')
    expect(asOfText(monthly[j]!, ts[k]!)).toBe('as of Aug 31')
    // The current month's point is today, so on Sep 22 the monthly line is still "as of Aug 31".
    expect(iso(monthly[at[0]![ts.indexOf(parseT('2026-09-22'))]!]!)).toBe('2026-08-31')
  })
})

describe('placeThresholdLabel', () => {
  it('sits at the right end of its line unless a marker label is there', () => {
    expect(placeThresholdLabel('Target $680K', 40, 50, 750, [])).toEqual({ x: 748, anchor: 'end' })
    // An "ETA Apr 2030" label flipped left of a marker near the right edge, on the same row.
    const eta = { x0: 660, x1: 740, y0: 33, y1: 45 }
    expect(placeThresholdLabel('Target $680K', 40, 50, 750, [eta])).toEqual({ x: 54, anchor: 'start' })
    // Same place, different height: no collision.
    expect(placeThresholdLabel('Target $680K', 120, 50, 750, [eta])).toEqual({ x: 748, anchor: 'end' })
  })
})

describe('carryForward (F14: facts that stand until the next one)', () => {
  const P = { ts: [D('2020-06-15'), D('2021-01-01')], vs: [800_000_00, 810_000_00] as (number | null)[], est: [false, false], src: ['2020-06-15', '2021-01-01'] }
  it('holds the last reading flat to the date, remembering which reading it repeats', () => {
    const c = carryForward(P, D('2026-09-23'), '2026-09-23')
    expect(c.ts.map(iso)).toEqual(['2020-06-15', '2021-01-01', '2026-09-23'])
    expect(c.vs).toEqual([800_000_00, 810_000_00, 810_000_00])
    expect(c.src[2]).toBe('2026-09-23')
    expect(c.carry).toEqual({ k: 2, from: D('2021-01-01') })
    expect(P.ts).toHaveLength(2) // the input is left alone (it is the parse cache's)
  })
  it('leaves a series alone when it already reaches the date, is empty, or ends in a break', () => {
    expect(carryForward(P, D('2021-01-01'), '2021-01-01')).toBe(P)
    const empty = { ts: [], vs: [], est: [], src: [] }
    expect(carryForward(empty, D('2026-09-23'), '2026-09-23')).toBe(empty)
    const broken = { ...P, vs: [800_000_00, null] }
    expect(carryForward(broken, D('2026-09-23'), '2026-09-23')).toBe(broken)
  })
  it('draws a line where two lone facts drew only dots', () => {
    // The onboarding case: a purchase, and one balance months later — each series is a single point.
    const value = carryForward({ ts: [D('2020-06-15')], vs: [800_000_00], est: [false], src: ['2020-06-15'] }, D('2026-09-23'), '2026-09-23')
    const xOf = (t: number) => (t - D('2020-06-15')) / 1e9
    const paths = linePaths([0, 1], value.ts, value.vs, value.est, xOf, (v) => v / 1e6)
    expect(paths.solid).toMatch(/^M.*L/)
  })
})

describe('trade rug (F34)', () => {
  it('draws one tick per shape per pixel column, however many trades land there', () => {
    const ticks = [
      ...Array.from({ length: 50 }, () => ({ x: 100, shape: 'up' as const })),
      { x: 100.2, shape: 'up' as const },
      { x: 100, shape: 'down' as const },
      { x: 140, shape: 'up' as const },
    ]
    const d = rugPathData(ticks, 200)
    expect(d.match(/M/g)).toHaveLength(3)
    expect(rugPathData([], 200)).toBe('')
  })
  it('lists the first few trades of a date and counts the rest; markers always stay', () => {
    const trades = Array.from({ length: 22 }, (_, i) => ({ glyph: '▲', label: `Bought ${i + 1} VTI`, rug: true }))
    const notes = capRugNotes([{ glyph: '│', label: 'Retire' }, ...trades])
    expect(notes).toHaveLength(1 + RUG_NOTES_MAX + 1)
    expect(notes[0]!.label).toBe('Retire')
    expect(notes[RUG_NOTES_MAX]!.label).toBe(`Bought ${RUG_NOTES_MAX} VTI`)
    expect(notes[notes.length - 1]).toEqual({ glyph: '', label: `+${22 - RUG_NOTES_MAX} more` })
    const few = trades.slice(0, 3)
    expect(capRugNotes(few)).toEqual(few)
  })
})
