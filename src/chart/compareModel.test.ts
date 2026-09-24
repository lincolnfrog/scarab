import { describe, expect, it } from 'vitest'
import type { SeriesMeta } from '../../shared/series-api'
import {
  arrivalAction,
  defaultBench,
  effectiveMode,
  includesDeposits,
  indexedEnds,
  modeAvailability,
  newViewId,
  perfDefaults,
  perfIds,
  perfLineCount,
  perfOptions,
  ROUTE_SAFE_VIEW_ID,
  sameSelection,
  seriesLabel,
  seriesStats,
  setLabel,
  spanText,
  suggestName,
  viewWindow,
  warningsFor,
  warningText,
} from './compareModel'
import { parseT } from './scale'

const TODAY = '2026-09-23'

describe('modeAvailability (unit rules)', () => {
  it('allows Value only for one amount unit, A − B only for two dollar series', () => {
    const cents = modeAvailability(['cents', 'cents'])
    expect(cents.value.ok && cents.rebased.ok && cents.pct.ok && cents.diff.ok).toBe(true)
    const three = modeAvailability(['cents', 'cents', 'cents'])
    expect(three.diff.ok).toBe(false)
    expect(three.diff.why).toMatch(/exactly two/)
    const prices = modeAvailability(['cents_per_share', 'cents_per_share'])
    expect(prices.value.ok).toBe(true)
    expect(prices.diff.ok).toBe(false)
    const mixed = modeAvailability(['cents', 'index_micro'])
    expect(mixed.value.ok).toBe(false)
    expect(mixed.value.why).toMatch(/different units/)
    expect(mixed.rebased.ok).toBe(true)
    const idx = modeAvailability(['index_micro', 'index_micro'])
    expect(idx.value.why).toMatch(/indexes/)
    expect(modeAvailability([]).rebased.ok).toBe(false)
  })

  it('falls back to Rebased with a one-line hint, keeping the pick', () => {
    expect(effectiveMode('value', ['cents', 'cents'])).toEqual({ mode: 'value', hint: null })
    const mixed = effectiveMode('value', ['cents', 'index_micro'])
    expect(mixed.mode).toBe('rebased')
    expect(mixed.hint).toMatch(/different units/)
    expect(effectiveMode('value', ['index_micro']).hint).toMatch(/indexes/)
    expect(effectiveMode('diff', ['cents']).mode).toBe('rebased')
    expect(effectiveMode('pct', ['cents', 'index_micro'])).toEqual({ mode: 'pct', hint: null })
    expect(effectiveMode('diff', [])).toEqual({ mode: 'diff', hint: null })
  })
})

describe('includesDeposits / seriesLabel', () => {
  it('marks balance series when rebased or as % change, never prices, returns or benchmarks', () => {
    for (const id of ['nw:total', 'nw:equity', 'inv:all:value', 'inv:3:cost', 'pos:1:value', 'set:1+2:value', 'cash:1', 'goal:fund', 'prop:2:equity'])
      expect(includesDeposits(id)).toBe(true)
    for (const id of ['nw:property', 'nw:liabilities', 'inv:all:twr', 'pos:1:twr', 'set:1+2:twr', 'px:1', 'bench:SPY', 'prop:1:value', 'liab:1', 'cf:net'])
      expect(includesDeposits(id)).toBe(false)
    expect(seriesLabel('Net worth', 'nw:total', 'rebased')).toBe('Net worth · includes deposits')
    expect(seriesLabel('Net worth', 'nw:total', 'pct')).toBe('Net worth · includes deposits')
    expect(seriesLabel('Net worth', 'nw:total', 'value')).toBe('Net worth')
    expect(seriesLabel('S&P 500 (SPY)', 'bench:SPY', 'rebased')).toBe('S&P 500 (SPY)')
  })
})

describe('seriesStats', () => {
  const months = (from: number, n: number, f: (i: number) => number | null) =>
    Array.from({ length: n }, (_, i) => {
      const k = from + i
      const t = `${2024 + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`
      return { t, v: f(i) }
    })

  it('gives start, end and change, with CAGR and drawdown from 12 months', () => {
    // Jan 2024 … Jan 2025: 100 → 110, dipping to 90 in Jun.
    const pts = months(0, 13, (i) => (i === 5 ? 90_00 : i === 12 ? 110_00 : 100_00))
    const s = seriesStats({ id: 'nw:total', label: 'Net worth', unit: 'cents', kind: 'level', points: pts }, null, TODAY)
    expect(s.start).toEqual({ t: '2024-01', v: 100_00 })
    expect(s.end).toEqual({ t: '2025-01', v: 110_00 })
    expect(s.months).toBe(12)
    expect(s.change).toBe(10_00)
    expect(s.changeMicro).toBe(100_000)
    expect(s.cagrMicro).toBe(100_000)
    expect(s.drawdown).toEqual({ micro: 100_000, peakT: '2024-01', troughT: '2024-06' })
  })

  it('withholds CAGR and drawdown under 12 months, and reads only the window', () => {
    const pts = months(0, 13, (i) => 100_00 + i * 100)
    const win = { t0: parseT('2024-03-01', TODAY), t1: parseT('2024-09-30', TODAY) }
    const s = seriesStats({ id: 'x', label: 'x', unit: 'cents', kind: 'level', points: pts }, win, TODAY)
    expect(s.start?.t).toBe('2024-03')
    expect(s.end?.t).toBe('2024-09')
    expect(s.months).toBe(6)
    expect(s.cagrMicro).toBeNull()
    expect(s.drawdown).toBeNull()
    expect(s.change).toBe(600)
  })

  it('skips nulls, and gives a flow its total and monthly mean instead of growth', () => {
    const pts = [
      { t: '2026-01', v: 1_000 },
      { t: '2026-02', v: null },
      { t: '2026-03', v: 2_001 },
    ]
    const s = seriesStats({ id: 'cf:spend', label: 'Spending', unit: 'cents', kind: 'flow', points: pts }, null, TODAY)
    expect(s.n).toBe(2)
    expect(s.total).toBe(3_001)
    expect(s.average).toBe(1_501) // 1,500.5 rounds half away from zero
    expect(s.change).toBeNull()
    expect(s.cagrMicro).toBeNull()
  })

  it('keeps a difference to start/end/change (growth: false)', () => {
    const pts = months(0, 24, (i) => 1_000 - i * 10)
    const s = seriesStats({ id: 'diff', label: 'A − B', unit: 'cents', kind: 'level', points: pts }, null, TODAY, { growth: false })
    expect(s.change).toBe(-230)
    expect(s.cagrMicro).toBeNull()
    expect(s.drawdown).toBeNull()
  })

  it('handles an empty window', () => {
    const s = seriesStats({ id: 'x', label: 'x', unit: 'cents', kind: 'level', points: [] }, null, TODAY)
    expect(s.start).toBeNull()
    expect(s.months).toBe(0)
    expect(s.change).toBeNull()
  })
})

describe('indexedEnds / spanText', () => {
  it('reads an index on a 100 base at its start', () => {
    expect(indexedEnds(1_121_033, 1_037_116)).toEqual({ start: 1_000_000, end: 925_143 })
    expect(indexedEnds(0, 5)).toBeNull()
  })
  it('writes spans in years and months', () => {
    expect(spanText(27)).toBe('2 yr 3 mo')
    expect(spanText(12)).toBe('1 yr')
    expect(spanText(7)).toBe('7 mo')
    expect(spanText(0)).toBe('one month')
  })
})

describe('warnings', () => {
  const w = ['inv:1:twr: only 0% of the value in these months had a market price; …', 'unknown series: pos:9:value', 'something else']
  it('picks out the ones about an id and words them', () => {
    expect(warningsFor('inv:1:twr', w)).toEqual([w[0]])
    expect(warningsFor('pos:9:value', w)).toEqual([w[1]])
    expect(warningsFor('inv:1:value', w)).toEqual([])
    expect(warningText('inv:1:twr', w[0]!)).toMatch(/^only 0%/)
    expect(warningText('pos:9:value', w[1]!)).toMatch(/No longer exists/)
  })
})

describe('saved views', () => {
  it('makes ids that fit both the router and the server', () => {
    const id = newViewId(1_790_000_000_000, () => 0.5)
    expect(id).toMatch(ROUTE_SAFE_VIEW_ID)
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(newViewId(0, () => 0)).toBe('v00000')
    expect(newViewId(8.64e15, () => 0.999999).length).toBeLessThanOrEqual(24)
    expect(ROUTE_SAFE_VIEW_ID.test('has_underscore')).toBe(false)
  })

  it('compares selections by order, mode and window', () => {
    const a = { ids: ['nw:total', 'nw:cash'], mode: 'value' as const }
    expect(sameSelection(a, { ...a, ids: ['nw:total', 'nw:cash'] })).toBe(true)
    expect(sameSelection(a, { ...a, ids: ['nw:cash', 'nw:total'] })).toBe(false)
    expect(sameSelection(a, { ...a, mode: 'pct' })).toBe(false)
    expect(sameSelection(a, { ...a, from: '2025-01' })).toBe(false)
    expect(sameSelection({ ...a, from: undefined }, a)).toBe(true)
  })

  it('suggests a name from labels, capped at 80 characters', () => {
    const label = (id: string) => ({ 'nw:total': 'Net worth', 'bench:SPY': 'S&P 500 (SPY)' })[id] ?? id
    expect(suggestName(['nw:total', 'bench:SPY'], label)).toBe('Net worth vs S&P 500 (SPY)')
    expect(suggestName(Array(6).fill('x'.repeat(20)), (s) => s).length).toBe(80)
  })

  it('saves the chart window only when it is narrower than the data', () => {
    const span = { t0: parseT('2024-06', TODAY), t1: parseT('2026-09', TODAY) }
    expect(viewWindow(span, span, {})).toEqual({})
    expect(viewWindow(null, span, { from: '2025-01' })).toEqual({ from: '2025-01' })
    const zoom = { t0: parseT('2025-02-10', TODAY), t1: parseT('2025-11-05', TODAY) }
    expect(viewWindow(zoom, span, {})).toEqual({ from: '2025-02', to: '2025-11' })
    const oneYear = { t0: parseT('2025-09-23', TODAY), t1: span.t1 }
    expect(viewWindow(oneYear, span, {})).toEqual({ from: '2025-09' })
  })
})

describe('arrivalAction (saved views vs keep-alive)', () => {
  const base = { entryHasSelection: false, v: null as string | null, fromView: null as string | null, viewsLoaded: true }
  it('uses a selection the entry carries: reload, Back/Forward, a view opened from the menu', () => {
    expect(arrivalAction({ ...base, entryHasSelection: true, v: 'va', fromView: 'vb' })).toBe('keep')
    expect(arrivalAction({ ...base, entryHasSelection: true })).toBe('keep')
  })
  it('keeps what is on screen when the nav comes back to the same view, edits included', () => {
    expect(arrivalAction({ ...base, v: 'va', fromView: 'va' })).toBe('stamp')
    expect(arrivalAction({ ...base, v: 'va', fromView: 'va', viewsLoaded: false })).toBe('stamp')
    expect(arrivalAction({ ...base })).toBe('stamp') // an unsaved selection at #/compare
  })
  it('opens a different saved view arriving by its address, once the list is here', () => {
    expect(arrivalAction({ ...base, v: 'vb', fromView: 'va' })).toBe('apply')
    expect(arrivalAction({ ...base, v: 'vb' })).toBe('apply') // first arrival by URL
    expect(arrivalAction({ ...base, v: 'vb', viewsLoaded: false })).toBe('wait')
  })
})

describe('the Performance preset', () => {
  const meta = (id: string, available = true): SeriesMeta => ({
    id,
    label: id,
    group: id.startsWith('bench') ? 'Benchmarks' : id.startsWith('pos') ? 'Holdings' : 'Accounts',
    unit: 'index_micro',
    kind: 'level',
    firstMonth: '2025-11',
    lastMonth: '2026-09',
    available,
  })
  const entries = [
    meta('inv:all:value'),
    meta('inv:all:twr', false),
    meta('inv:2:twr'),
    meta('pos:1:twr'),
    meta('pos:3:twr'),
    meta('bench:SPY', false),
    meta('bench:VTI'),
    meta('bench:QQQ'),
  ]

  it('offers returns and benchmarks only, and starts from what has data', () => {
    const o = perfOptions(entries)
    expect(o.accounts.map((e) => e.id)).toEqual(['inv:all:twr', 'inv:2:twr'])
    expect(o.holdings.map((e) => e.id)).toEqual(['pos:1:twr', 'pos:3:twr'])
    expect(defaultBench(o.benchmarks)).toBe('bench:VTI') // SPY has no data here
    expect(defaultBench([meta('bench:SPY'), meta('bench:VTI')])).toBe('bench:SPY')
    expect(defaultBench([meta('bench:SPY', false)])).toBeNull()
    expect(perfDefaults(o)).toEqual({ accounts: ['inv:2:twr'], holdings: [], combine: false, bench: 'bench:VTI' })
    expect(perfDefaults(perfOptions([meta('pos:3:twr')]))).toEqual({ accounts: [], holdings: ['pos:3:twr'], combine: false, bench: null })
  })

  it('draws each pick as its own line, or several holdings as one set, benchmark last', () => {
    expect(perfIds({ accounts: ['inv:all:twr'], holdings: ['pos:3:twr', 'pos:1:twr'], combine: false, bench: 'bench:SPY' })).toEqual([
      'inv:all:twr',
      'pos:3:twr',
      'pos:1:twr',
      'bench:SPY',
    ])
    expect(perfIds({ accounts: [], holdings: ['pos:3:twr', 'pos:1:twr', 'pos:12:twr'], combine: true, bench: 'bench:SPY' })).toEqual([
      'set:1+3+12:twr',
      'bench:SPY',
    ])
    // one holding "combined" is just that holding
    expect(perfIds({ accounts: [], holdings: ['pos:3:twr'], combine: true, bench: null })).toEqual(['pos:3:twr'])
    expect(perfLineCount({ accounts: ['a'], holdings: ['pos:1:twr', 'pos:2:twr'], combine: true, bench: null })).toBe(2)
  })

  it('never asks for more than six series, keeping the benchmark', () => {
    const holdings = Array.from({ length: 7 }, (_, i) => `pos:${i + 1}:twr`)
    const ids = perfIds({ accounts: [], holdings, combine: false, bench: 'bench:SPY' })
    expect(ids).toHaveLength(6)
    expect(ids[5]).toBe('bench:SPY')
    expect(perfIds({ accounts: [], holdings, combine: false, bench: null })).toHaveLength(6)
  })
})

describe('setLabel', () => {
  it('names a set from its members before the series loads', () => {
    const labels: Record<string, string> = { 'pos:1:twr': 'VTI · time-weighted return', 'pos:3:twr': 'VXUS · time-weighted return', 'pos:1:value': 'VTI · value' }
    const of = (id: string) => labels[id]
    expect(setLabel('set:1+3:twr', of)).toBe('VTI + VXUS · time-weighted return')
    expect(setLabel('set:1+9:value', of)).toBe('VTI + #9 · value')
    expect(setLabel('pos:1:twr', of)).toBeNull()
  })
})
