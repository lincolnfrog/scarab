import { describe, expect, it } from 'vitest'
import { parsePositions } from '../../engine/positions-paste'
import { PLACEHOLDER } from './OpeningPositionsSheet'

const M = 1_000_000

describe('Starting positions placeholder', () => {
  it('parses exactly as shown — the example is a paste someone may copy', () => {
    const r = parsePositions(PLACEHOLDER)
    expect(r.errors).toEqual([])
    expect(r.rows.map((x) => [x.symbol, x.qtyMicro, x.basisCents, x.acquiredOn])).toEqual([
      ['VTI', 120 * M, 18_400_00, '2019-03-15'],
      ['AAPL', 40 * M, 5_200_50, '2021-06-02'],
      ['FXAIX', 55_125_000, 9_120_00, '2020-01-04'],
    ])
  })
})
