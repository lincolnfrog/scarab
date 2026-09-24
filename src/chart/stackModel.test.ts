import { describe, expect, it } from 'vitest'
import type { NetWorthPoint } from '../cards/cardModel'
import { compositionLayers, divergingStack, stackBandPath, stackOnUnion, stackTipOrder } from './stackModel'

describe('divergingStack', () => {
  it('piles positives up from $0 and hangs negatives below it', () => {
    // brokerage, property, liabilities over two points
    const s = divergingStack([
      [100, 120],
      [500, 500],
      [-300, -280],
    ])
    expect(s.lo).toEqual([
      [0, 0],
      [100, 120],
      [-300, -280],
    ])
    expect(s.hi).toEqual([
      [100, 120],
      [600, 620],
      [0, 0],
    ])
    expect(s.top).toEqual([600, 620])
    expect(s.bottom).toEqual([-300, -280])
  })
  it('keeps top + bottom equal to the sum of the layers — the Total line', () => {
    const layers = [
      [10_000_00, 12_000_00, 9_000_00],
      [-2_000_00, 500_00, 0], // cash overdrawn in month 1
      [90_000_00, 90_000_00, 91_000_00],
      [-60_000_00, -59_000_00, -58_000_00],
    ]
    const s = divergingStack(layers)
    for (let k = 0; k < 3; k++) expect(s.top[k]! + s.bottom[k]!).toBe(layers.reduce((a, l) => a + l[k]!, 0))
  })
  it('flips a layer to the negative pile only where it is negative', () => {
    const s = divergingStack([
      [100, 100],
      [50, -40],
    ])
    expect([s.lo[1], s.hi[1]]).toEqual([
      [100, -40],
      [150, 0],
    ])
  })
  it('counts missing values as 0 and stays integer', () => {
    const s = divergingStack([[5, 7, 9], [3], [Number.NaN, 2, 1]])
    expect(s.top).toEqual([8, 9, 10])
    expect(s.hi[1]).toEqual([8, 7, 9])
    expect(s.top.every(Number.isInteger)).toBe(true)
  })
  it('handles no layers', () => {
    expect(divergingStack([])).toEqual({ lo: [], hi: [], top: [], bottom: [] })
  })
})

describe('stackOnUnion', () => {
  it('reads each layer as of every date on the union, 0 before it starts', () => {
    const u = stackOnUnion([
      { ts: [1, 2, 3], vs: [10, 20, 30] },
      { ts: [2, 4], vs: [-5, null] }, // starts later; a missing reading is 0
    ])
    expect(u.ts).toEqual([1, 2, 3, 4])
    expect(u.values).toEqual([
      [10, 20, 30, 30],
      [0, -5, -5, 0],
    ])
  })
})

describe('stackBandPath', () => {
  const x = (t: number) => t * 10
  const y = (v: number) => 100 - v
  it('runs along the upper edge, then back along the lower edge', () => {
    expect(stackBandPath([0, 1, 2], [0, 1, 2], [0, 5, 10], [20, 25, 30], x, y)).toBe('M0 80L10 75L20 70L20 90L10 95L0 100Z')
  })
  it('draws only the kept indices, and nothing below two', () => {
    expect(stackBandPath([0, 2], [0, 1, 2], [0, 5, 10], [20, 25, 30], x, y)).toBe('M0 80L20 70L20 90L0 100Z')
    expect(stackBandPath([1], [0, 1, 2], [0, 5, 10], [20, 25, 30], x, y)).toBe('')
  })
})

describe('stackTipOrder: top to bottom as drawn', () => {
  it('lists the positive pile from its top, then zeros, then the negative pile from $0 down', () => {
    // stacking order: brokerage, retirement, property, cash (overdrawn), liabilities
    expect(stackTipOrder([100, 50, 900, -20, -600])).toEqual([2, 1, 0, 3, 4])
    expect(stackTipOrder([100, 0, 900, 5, -600])).toEqual([3, 2, 0, 1, 4])
    expect(stackTipOrder([])).toEqual([])
  })
})

describe('compositionLayers', () => {
  const pt = (month: string, o: Partial<NetWorthPoint>): NetWorthPoint => ({
    month,
    cash: 0,
    brokerage: 0,
    retirement: 0,
    crypto: 0,
    property: 0,
    liabilities: 0,
    total: 0,
    ...o,
  })
  it('uses the fixed slots of the donut and tiles, with every debt as one s6 layer', () => {
    const pts = [
      pt('2026-08', { brokerage: 100, retirement: 50, property: 900, cash: 10, liabilities: -600, total: 460 }),
      pt('2026-09', { brokerage: 120, retirement: 55, property: 900, cash: -5, liabilities: -590, total: 480 }),
    ]
    const layers = compositionLayers(pts)
    expect(layers.map((l) => [l.id, l.label, l.slot])).toEqual([
      ['nw:brokerage', 'Brokerage', 1],
      ['nw:retirement', 'Retirement', 2],
      ['nw:property', 'Property', 3],
      ['nw:cash', 'Cash', 5],
      ['nw:liabilities', 'Liabilities', 6],
    ])
    expect(layers.find((l) => l.id === 'nw:cash')!.values).toEqual([10, -5])
    // The layers add up to the Total line at every point.
    const s = divergingStack(layers.map((l) => l.values))
    pts.forEach((p, k) => expect(s.top[k]! + s.bottom[k]!).toBe(p.total))
  })
  it('leaves out a part that is $0 in every month, and keeps one that just dropped to $0', () => {
    const layers = compositionLayers([pt('2026-08', { crypto: 30, cash: 5 }), pt('2026-09', { crypto: 0, cash: 5 })])
    expect(layers.map((l) => l.id)).toEqual(['nw:crypto', 'nw:cash'])
    expect(layers[0]!.slot).toBe(4)
  })
})
