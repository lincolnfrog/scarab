import { describe, expect, it } from 'vitest'
import { computePosition, positionValueCents } from './lots'
import { parseYahooMeta } from './prices'

const M = 1_000_000 // one whole share in micro-shares

describe('computePosition (FIFO)', () => {
  it('accumulates buys into lots with remaining basis', () => {
    const pos = computePosition(
      [
        { traded_on: '2024-01-10', side: 'buy', qty_micro: 100 * M, total_cents: 500_00 * 100 },
        { traded_on: '2025-06-01', side: 'buy', qty_micro: 50 * M, total_cents: 400_00 * 100 },
      ],
      '2026-08-06',
    )
    expect(pos.qty_micro).toBe(150 * M)
    expect(pos.cost_cents).toBe(900_00 * 100)
    expect(pos.lots).toHaveLength(2)
  })

  it('sells FIFO and splits short/long-term by lot age', () => {
    const pos = computePosition(
      [
        { traded_on: '2024-01-10', side: 'buy', qty_micro: 100 * M, total_cents: 100_000 }, // $10/sh
        { traded_on: '2026-07-01', side: 'buy', qty_micro: 100 * M, total_cents: 300_000 }, // $30/sh
        // sell 150 @ $40 → 100 from 2024 lot (LT gain $3,000), 50 from 2026 lot (ST gain $500)
        { traded_on: '2026-08-01', side: 'sell', qty_micro: 150 * M, total_cents: 600_000 },
      ],
      '2026-08-06',
    )
    expect(pos.qty_micro).toBe(50 * M)
    expect(pos.cost_cents).toBe(150_000)
    expect(pos.realized_lt_cents).toBe(300_000)
    expect(pos.realized_st_cents).toBe(50_000)
    expect(pos.realized_ytd_lt_cents).toBe(300_000)
    expect(pos.realized_ytd_st_cents).toBe(50_000)
    expect(pos.warnings).toHaveLength(0)
  })

  it('a sale exactly 365 days after purchase is short-term; 366 is long-term', () => {
    const st = computePosition(
      [
        { traded_on: '2025-08-01', side: 'buy', qty_micro: 10 * M, total_cents: 1000 },
        { traded_on: '2026-08-01', side: 'sell', qty_micro: 10 * M, total_cents: 2000 },
      ],
      '2026-12-31',
    )
    expect(st.realized_st_cents).toBe(1000)
    const lt = computePosition(
      [
        { traded_on: '2025-07-31', side: 'buy', qty_micro: 10 * M, total_cents: 1000 },
        { traded_on: '2026-08-01', side: 'sell', qty_micro: 10 * M, total_cents: 2000 },
      ],
      '2026-12-31',
    )
    expect(lt.realized_lt_cents).toBe(1000)
  })

  it('flags oversells and treats the excess as zero-basis gain', () => {
    const pos = computePosition(
      [
        { traded_on: '2026-01-01', side: 'buy', qty_micro: 10 * M, total_cents: 10_000 },
        { traded_on: '2026-02-01', side: 'sell', qty_micro: 15 * M, total_cents: 30_000 },
      ],
      '2026-08-06',
    )
    expect(pos.qty_micro).toBe(0)
    expect(pos.warnings).toHaveLength(1)
    // 10 covered (proceeds 20000 − cost 10000) + 5 uncovered (proceeds 10000, zero basis)
    expect(pos.realized_st_cents).toBe(20_000)
  })

  it('fractional crypto quantities stay exact', () => {
    const pos = computePosition(
      [{ traded_on: '2026-01-01', side: 'buy', qty_micro: 620_000, total_cents: 7_340_800 }], // 0.62 BTC
      '2026-08-06',
    )
    expect(pos.qty_micro).toBe(620_000)
    expect(positionValueCents(pos.qty_micro, 11_840_000)).toBe(7_340_800) // 0.62 × $118,400
  })
})

describe('parseYahooMeta', () => {
  it('extracts price and date, converting to cents exactly once', () => {
    const body = {
      chart: { result: [{ meta: { regularMarketPrice: 379.65, regularMarketTime: 1785960000 } }] },
    }
    expect(parseYahooMeta('VTI', body)).toEqual({ cents: 37965, pricedOn: '2026-08-05' })
  })
  it('reports missing quotes', () => {
    expect(parseYahooMeta('BOGUS', { chart: { result: [] } })).toEqual({ error: 'BOGUS: no quote from Yahoo' })
    expect(parseYahooMeta('X', {})).toEqual({ error: 'X: no quote from Yahoo' })
  })
})


describe('specific-lot and explicit-basis sells', () => {
  it('explicit basis: gain and term come from the entered acquisition, nothing consumed', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2026-05-01', side: 'buy', qty_micro: 10 * M, total_cents: 100_000 },
        // historical sale: 20 sh acquired 2023-02-25 at $150/sh basis, sold for $7,000
        {
          id: 2,
          traded_on: '2026-03-10',
          side: 'sell',
          qty_micro: 20 * M,
          total_cents: 700_000,
          acquired_on: '2023-02-25',
          basis_cents: 300_000,
        },
      ],
      '2026-08-07',
    )
    expect(pos.realized_lt_cents).toBe(400_000) // 2023 → 2026 is long-term
    expect(pos.realized_ytd_lt_cents).toBe(400_000)
    expect(pos.qty_micro).toBe(10 * M) // the unrelated lot is untouched
    expect(pos.warnings).toHaveLength(0)
  })

  it('specific lot: consumes the chosen lot, not FIFO order', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2025-01-01', side: 'buy', qty_micro: 10 * M, total_cents: 100_000 }, // lot A $10/sh
        { id: 2, traded_on: '2026-06-01', side: 'buy', qty_micro: 10 * M, total_cents: 300_000 }, // lot B $30/sh
        { id: 3, traded_on: '2026-08-01', side: 'sell', qty_micro: 10 * M, total_cents: 350_000, sold_lot_trade_id: 2 },
      ],
      '2026-08-07',
    )
    // lot B consumed: ST gain $500; lot A (older) remains whole
    expect(pos.realized_st_cents).toBe(50_000)
    expect(pos.realized_lt_cents).toBe(0)
    expect(pos.lots).toHaveLength(1)
    expect(pos.lots[0]!.trade_id).toBe(1)
    expect(pos.cost_cents).toBe(100_000)
  })

  it('partial specific-lot sell leaves the remainder of that lot', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2025-01-01', side: 'buy', qty_micro: 48 * M, total_cents: 480_000 },
        { id: 2, traded_on: '2026-08-01', side: 'sell', qty_micro: 12 * M, total_cents: 240_000, sold_lot_trade_id: 1 },
      ],
      '2026-08-07',
    )
    expect(pos.qty_micro).toBe(36 * M)
    expect(pos.cost_cents).toBe(360_000)
    expect(pos.realized_lt_cents).toBe(120_000)
  })

  it('warns when the chosen lot is missing or too small', () => {
    const missing = computePosition(
      [{ id: 9, traded_on: '2026-08-01', side: 'sell', qty_micro: 5 * M, total_cents: 50_000, sold_lot_trade_id: 77 }],
      '2026-08-07',
    )
    expect(missing.warnings).toHaveLength(1)
    expect(missing.realized_st_cents).toBe(50_000)
    const tooSmall = computePosition(
      [
        { id: 1, traded_on: '2026-01-01', side: 'buy', qty_micro: 5 * M, total_cents: 50_000 },
        { id: 2, traded_on: '2026-08-01', side: 'sell', qty_micro: 8 * M, total_cents: 160_000, sold_lot_trade_id: 1 },
      ],
      '2026-08-07',
    )
    expect(tooSmall.warnings).toHaveLength(1)
    expect(tooSmall.qty_micro).toBe(0)
  })
})

describe('parseYahooHistory', () => {
  it('maps timestamps and closes, skipping nulls', async () => {
    const { parseYahooHistory } = await import('./prices')
    const body = {
      chart: {
        result: [
          {
            timestamp: [1704067200, 1706745600, 1709251200],
            indicators: { quote: [{ close: [42283.58, null, 61198.38] }] },
          },
        ],
      },
    }
    expect(parseYahooHistory('BTC', body)).toEqual([
      { symbol: 'BTC', cents: 4228358, pricedOn: '2024-01-01' },
      { symbol: 'BTC', cents: 6119838, pricedOn: '2024-03-01' },
    ])
  })
})

