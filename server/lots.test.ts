import { beforeAll, describe, expect, it } from 'vitest'
import type { InvestAccountDetail, PortfolioResponse } from '../shared/invest-api'
import { computePosition, isLongTerm, longTermOn, positionValueCents, saleRealized } from './lots'
import { parseYahooMeta } from './prices'

// For the route checks at the bottom: an in-memory server database, set up
// before server/app (and with it server/db) is first imported.
process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

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

  it('IRS Pub 550: bought 2024-02-05, sold on the anniversary is short-term; the day after is long-term', () => {
    // 366 calendar days (Feb 29 2024 falls between) and still short-term: a
    // day count would have called it long-term.
    const sale = (soldOn: string) =>
      computePosition(
        [
          { traded_on: '2024-02-05', side: 'buy', qty_micro: 10 * M, total_cents: 1000 },
          { traded_on: soldOn, side: 'sell', qty_micro: 10 * M, total_cents: 2500 },
        ],
        '2025-12-31',
      )
    expect(sale('2025-02-05')).toMatchObject({ realized_st_cents: 1500, realized_lt_cents: 0 })
    expect(sale('2025-02-06')).toMatchObject({ realized_st_cents: 0, realized_lt_cents: 1500 })
    expect(longTermOn('2024-02-05')).toBe('2025-02-06')
  })

  it('a Feb 29 acquisition: sold Feb 28 is short-term, Mar 1 is long-term', () => {
    const sale = (soldOn: string) =>
      computePosition(
        [
          { traded_on: '2024-02-29', side: 'buy', qty_micro: 10 * M, total_cents: 1000 },
          { traded_on: soldOn, side: 'sell', qty_micro: 10 * M, total_cents: 2500 },
        ],
        '2025-12-31',
      )
    expect(sale('2025-02-28')).toMatchObject({ realized_st_cents: 1500, realized_lt_cents: 0 })
    expect(sale('2025-03-01')).toMatchObject({ realized_st_cents: 0, realized_lt_cents: 1500 })
    expect(longTermOn('2024-02-29')).toBe('2025-03-01')
  })

  it('isLongTerm and longTermOn agree on every day of a leap and a common year', () => {
    for (const opened of ['2024-01-31', '2024-02-28', '2024-02-29', '2024-03-01', '2025-02-28', '2025-12-31']) {
      const lt = longTermOn(opened)
      const dayBefore = new Date(Date.parse(lt) - 86_400_000).toISOString().slice(0, 10)
      expect(isLongTerm(opened, lt)).toBe(true)
      expect(isLongTerm(opened, dayBefore)).toBe(false)
    }
  })

  it('an explicit-basis sale follows the same anniversary rule', () => {
    const pos = computePosition(
      [{ traded_on: '2025-02-05', side: 'sell', qty_micro: 1 * M, total_cents: 900, acquired_on: '2024-02-05', basis_cents: 400 }],
      '2025-12-31',
    )
    expect(pos).toMatchObject({ realized_st_cents: 500, realized_lt_cents: 0 })
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

describe('lots open on their acquisition date (starting positions)', () => {
  it('FIFO takes the earliest-acquired lot, even one booked later', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2024-06-03', side: 'buy', qty_micro: 10 * M, total_cents: 250_000 }, // bought in Scarab
        // a starting position booked 2026-09-01 whose shares were acquired in 2019
        { id: 2, traded_on: '2026-09-01', side: 'buy', qty_micro: 10 * M, total_cents: 100_000, acquired_on: '2019-03-15' },
        { id: 3, traded_on: '2026-09-15', side: 'sell', qty_micro: 10 * M, total_cents: 300_000 },
      ],
      '2026-09-22',
    )
    expect(pos.realized_lt_cents).toBe(200_000) // the 2019 lot: long-term, $100/sh → $300/sh
    expect(pos.realized_st_cents).toBe(0)
    expect(pos.lots.map((l) => [l.trade_id, l.opened_on])).toEqual([[1, '2024-06-03']])
  })

  it('a sale walks in trade-date order: before the starting position is booked it cannot consume it', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2026-09-01', side: 'buy', qty_micro: 10 * M, total_cents: 100_000, acquired_on: '2019-03-15' },
        { id: 2, traded_on: '2026-08-15', side: 'sell', qty_micro: 5 * M, total_cents: 150_000 },
      ],
      '2026-09-22',
    )
    expect(pos.qty_micro).toBe(10 * M) // untouched
    expect(pos.warnings).toHaveLength(1) // the earlier sale exceeds what was held then
    expect(pos.realized_st_cents).toBe(150_000) // zero basis, as for any oversell
  })

  it('open lots stay in acquisition order; same-day lots in booking order', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2026-09-01', side: 'buy', qty_micro: 1 * M, total_cents: 100, acquired_on: '2021-01-04' },
        { id: 2, traded_on: '2026-09-01', side: 'buy', qty_micro: 1 * M, total_cents: 100, acquired_on: '2019-05-01' },
        { id: 3, traded_on: '2026-09-01', side: 'buy', qty_micro: 1 * M, total_cents: 100 },
        { id: 4, traded_on: '2026-09-02', side: 'buy', qty_micro: 1 * M, total_cents: 100, acquired_on: '2019-05-01' },
      ],
      '2026-09-22',
    )
    expect(pos.lots.map((l) => [l.trade_id, l.opened_on])).toEqual([
      [2, '2019-05-01'],
      [4, '2019-05-01'],
      [1, '2021-01-04'],
      [3, '2026-09-01'],
    ])
  })
})

describe('computePosition: each sale says which lots it took (B6)', () => {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

  it('a FIFO sale across two lots: one part per lot, with its term, cost and proceeds', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2024-01-10', side: 'buy', qty_micro: 100 * M, total_cents: 100_000 },
        { id: 2, traded_on: '2026-07-01', side: 'buy', qty_micro: 100 * M, total_cents: 300_000 },
        { id: 3, traded_on: '2026-08-01', side: 'sell', qty_micro: 150 * M, total_cents: 600_000 },
      ],
      '2026-08-06',
    )
    expect(pos.sales).toEqual([
      {
        trade_id: 3,
        traded_on: '2026-08-01',
        qty_micro: 150 * M,
        proceeds_cents: 600_000,
        parts: [
          { lot_trade_id: 1, opened_on: '2024-01-10', qty_micro: 100 * M, cost_cents: 100_000, proceeds_cents: 400_000, term: 'lt' },
          { lot_trade_id: 2, opened_on: '2026-07-01', qty_micro: 50 * M, cost_cents: 150_000, proceeds_cents: 200_000, term: 'st' },
        ],
        zero_basis_cents: 0,
        zero_basis_qty_micro: 0,
      },
    ])
    expect(saleRealized(pos.sales[0]!)).toEqual({ st_cents: 50_000, lt_cents: 300_000 })
  })

  it("a FIFO sale's parts add up to exactly its proceeds, even when a third of a cent is at stake", () => {
    // $10.00 for three shares from three lots: 333 + 334 + 333, not 333 × 3 (a lost cent).
    const pos = computePosition(
      [
        { id: 1, traded_on: '2026-01-02', side: 'buy', qty_micro: 1 * M, total_cents: 100 },
        { id: 2, traded_on: '2026-01-03', side: 'buy', qty_micro: 1 * M, total_cents: 100 },
        { id: 3, traded_on: '2026-01-04', side: 'buy', qty_micro: 1 * M, total_cents: 100 },
        { id: 4, traded_on: '2026-02-01', side: 'sell', qty_micro: 3 * M, total_cents: 1000 },
      ],
      '2026-08-06',
    )
    const parts = pos.sales[0]!.parts
    expect(parts.map((p) => p.proceeds_cents)).toEqual([333, 334, 333])
    expect(sum(parts.map((p) => p.proceeds_cents))).toBe(1000)
    expect(pos.realized_st_cents).toBe(1000 - 300)
  })

  it('explicit basis, a chosen lot with an excess, and an oversell: parts plus zero-basis cover every share and cent', () => {
    const pos = computePosition(
      [
        { id: 1, traded_on: '2025-01-02', side: 'buy', qty_micro: 5 * M, total_cents: 50_000 },
        { id: 2, traded_on: '2025-03-03', side: 'buy', qty_micro: 5 * M, total_cents: 60_000 },
        { id: 3, traded_on: '2026-02-01', side: 'sell', qty_micro: 2 * M, total_cents: 9_000, acquired_on: '2019-05-01', basis_cents: 1_000 },
        { id: 4, traded_on: '2026-03-01', side: 'sell', qty_micro: 7 * M, total_cents: 140_000, sold_lot_trade_id: 2 },
        { id: 5, traded_on: '2026-04-01', side: 'sell', qty_micro: 8 * M, total_cents: 80_003 },
      ],
      '2026-08-06',
    )
    const [explicit, chosen, over] = pos.sales
    expect(explicit!.parts).toEqual([
      { lot_trade_id: null, opened_on: '2019-05-01', qty_micro: 2 * M, cost_cents: 1_000, proceeds_cents: 9_000, term: 'lt' },
    ])
    expect(chosen!.parts).toEqual([
      { lot_trade_id: 2, opened_on: '2025-03-03', qty_micro: 5 * M, cost_cents: 60_000, proceeds_cents: 100_000, term: 'st' }, // anniversary Mar 3: still short-term
    ])
    expect(chosen).toMatchObject({ zero_basis_qty_micro: 2 * M, zero_basis_cents: 40_000 })
    expect(over!.parts).toEqual([
      { lot_trade_id: 1, opened_on: '2025-01-02', qty_micro: 5 * M, cost_cents: 50_000, proceeds_cents: 50_002, term: 'lt' },
    ])
    expect(over).toMatchObject({ zero_basis_qty_micro: 3 * M, zero_basis_cents: 30_001 })
    for (const s of pos.sales) {
      expect(sum(s.parts.map((p) => p.qty_micro)) + s.zero_basis_qty_micro).toBe(s.qty_micro)
      expect(sum(s.parts.map((p) => p.proceeds_cents)) + s.zero_basis_cents).toBe(s.proceeds_cents)
    }
    // The lifetime figures are the sales summed.
    const r = pos.sales.map(saleRealized)
    expect(sum(r.map((x) => x.st_cents))).toBe(pos.realized_st_cents)
    expect(sum(r.map((x) => x.lt_cents))).toBe(pos.realized_lt_cents)
    expect(pos.warnings).toHaveLength(2)
  })

  it('a chosen lot that is not open is all zero-basis, and says so', () => {
    const pos = computePosition(
      [{ id: 9, traded_on: '2026-08-01', side: 'sell', qty_micro: 5 * M, total_cents: 50_000, sold_lot_trade_id: 77 }],
      '2026-08-07',
    )
    expect(pos.sales[0]).toMatchObject({ trade_id: 9, parts: [], zero_basis_cents: 50_000, zero_basis_qty_micro: 5 * M })
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


describe('investment routes refuse what the engine refuses', () => {
  let app: ReturnType<typeof import('./app').createApp>
  beforeAll(async () => {
    app = (await import('./app')).createApp({ zkOnly: false })
  })
  const send = async (method: string, path: string, body?: unknown) => {
    const r = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  it('400 for a cross-account lot, a future date and a kind mismatch; 404 for a missing account', async () => {
    const a = (await send('POST', '/invest/accounts', { name: 'A', kind: 'brokerage', tracking: 'lots' })).body.id
    const b = (await send('POST', '/invest/accounts', { name: 'B', kind: 'brokerage', tracking: 'lots' })).body.id
    const buy = { symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2020-03-02', qty: '10', totalCents: 150_000 }
    const lot = await send('POST', '/trades', { ...buy, investAccountId: a })
    expect(lot.status).toBe(200)

    const crossAccount = await send('POST', '/trades', {
      ...buy, investAccountId: b, side: 'sell', tradedOn: '2026-06-01', totalCents: 320_000, soldLotTradeId: lot.body.id,
    })
    expect(crossAccount).toEqual({ status: 400, body: { error: 'that lot belongs to a different account' } })

    const future = await send('POST', '/trades', { ...buy, investAccountId: a, tradedOn: '2999-01-01' })
    expect(future.status).toBe(400)
    expect(future.body.error).toMatch(/after today/)

    const kind = await send('POST', '/trades', { ...buy, investAccountId: a, assetKind: 'crypto' })
    expect(kind.status).toBe(400)
    expect(kind.body.error).toMatch(/already recorded as a stock/)

    expect(await send('PUT', '/invest/balances', { investAccountId: 999, balancedOn: '2026-09-01', balanceCents: 100 })).toEqual({
      status: 404,
      body: { error: 'no such investment account' },
    })
    const vest = await send('POST', '/unvested/vest', { investAccountId: a, symbol: 'VTI', qty: '1', tradedOn: '2026-01-02', totalCents: 100 })
    expect(vest.status).toBe(404)

    // Only the one good buy landed.
    const trades = (await (await app.request('/api/trades')).json()) as unknown[]
    expect(trades).toHaveLength(1)
  })

  it('balance history: batch PUT, GET, exact DELETE', async () => {
    const k = (await send('POST', '/invest/accounts', { name: '401(k)', kind: 'retirement', tracking: 'balance' })).body.id as number
    const batch = await send('PUT', '/invest/balances', {
      investAccountId: k,
      balances: [
        { balancedOn: '2025-12-31', balanceCents: 40_000_00 },
        { balancedOn: '2026-03-31', balanceCents: 42_000_00 },
      ],
    })
    expect(batch).toEqual({ status: 200, body: { ok: true, written: 2 } })
    const list = await app.request(`/api/invest/balances?accountId=${k}`)
    expect(await list.json()).toEqual([
      { invest_account_id: k, balanced_on: '2026-03-31', balance_cents: 42_000_00 },
      { invest_account_id: k, balanced_on: '2025-12-31', balance_cents: 40_000_00 },
    ])
    expect(await send('DELETE', `/invest/balances/${k}/2025-12-31`)).toEqual({ status: 200, body: { ok: true } })
    expect((await send('DELETE', `/invest/balances/${k}/2025-12-31`)).status).toBe(404)
    // The account itself is untouched by a balance delete.
    const accounts = (await (await app.request('/api/invest/accounts')).json()) as { id: number }[]
    expect(accounts.some((a) => a.id === k)).toBe(true)
    expect((await send('PUT', '/invest/balances', { investAccountId: k, balancedOn: '2999-01-01', balanceCents: 1 })).status).toBe(400)
  })

  it('starting positions and hand-entered prices', async () => {
    const a = (await send('POST', '/invest/accounts', { name: 'Fidelity', kind: 'brokerage', tracking: 'lots' })).body.id as number
    const opening = await send('POST', '/trades/opening', {
      investAccountId: a,
      asOf: '2026-09-01',
      rows: [{ symbol: 'FXAIX', qty: '10', basisCents: 1_500_00, acquiredOn: '2019-03-15' }],
    })
    expect(opening.status).toBe(200)
    expect(opening.body).toMatchObject({ created: 1, errors: [], warnings: [] })
    const refused = await send('POST', '/trades/opening', {
      investAccountId: a,
      asOf: '2026-09-01',
      rows: [{ symbol: 'VTI', qty: 'x', basisCents: 1 }],
    })
    expect(refused).toMatchObject({ status: 200, body: { created: 0, errors: [{ row: 0 }] } })
    expect((await send('POST', '/trades/opening', { investAccountId: a, asOf: '2999-01-01', rows: [] })).status).toBe(400)

    expect((await send('POST', '/prices/manual', { symbol: 'NOPE', pricedOn: '2026-09-01', cents: 100 })).status).toBe(404)
    expect((await send('POST', '/prices/manual', { symbol: 'FXAIX', pricedOn: '2999-01-01', cents: 100 })).status).toBe(400)
    expect((await send('POST', '/prices/manual', { symbol: 'FXAIX', pricedOn: '2026-09-01', cents: 0 })).status).toBe(400)
    expect(await send('POST', '/prices/manual', { symbol: 'fxaix', pricedOn: '2026-09-01', cents: 200_00 })).toEqual({
      status: 200,
      body: { ok: true, symbol: 'FXAIX', pricedOn: '2026-09-01', cents: 200_00 },
    })
    const portfolio = (await (await app.request('/api/portfolio')).json()) as { positions: { symbol: string; price_manual?: boolean; value_cents: number }[] }
    expect(portfolio.positions.find((p) => p.symbol === 'FXAIX')).toMatchObject({ price_manual: true, value_cents: 2_000_00 })
  })

  it('the activity ledger over HTTP: filtered GET, preview (writes nothing), PATCH and DELETE', async () => {
    const a = (await send('POST', '/invest/accounts', { name: 'Ledger', kind: 'brokerage', tracking: 'lots' })).body.id as number
    const body = { investAccountId: a, symbol: 'LDGR', assetKind: 'stock', side: 'buy', qty: '10' }
    const lot = (await send('POST', '/trades', { ...body, tradedOn: '2024-03-04', totalCents: 1_000_00 })).body.id as number
    const sale = { ...body, side: 'sell', tradedOn: '2026-05-01', qty: '4', totalCents: 800_00 }

    const preview = await send('POST', '/trades/preview', sale)
    expect(preview.status).toBe(200)
    expect(preview.body).toMatchObject({ side: 'sell', realized: { stCents: 0, ltCents: 400_00 }, parts: [{ lot_trade_id: lot }] })
    expect((await send('POST', '/trades/preview', { ...sale, tradedOn: '2999-01-01' })).status).toBe(400)
    const listed = async (q = '') => (await (await app.request(`/api/trades?accountId=${a}${q}`)).json()) as { id: number; realized?: unknown; dependents?: number }[]
    expect(await listed()).toHaveLength(1) // the preview recorded nothing

    const sell = (await send('POST', '/trades', sale)).body.id as number
    expect((await listed('&year=2026')).map((t) => t.id)).toEqual([sell])
    expect((await listed('&symbol=ldgr')).find((t) => t.id === lot)!.dependents).toBe(1)
    expect((await app.request('/api/trades?year=26')).status).toBe(400)

    expect(await send('PATCH', `/trades/${lot}`, { qty: '3' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/short 1 share it/) } })
    expect(await send('PATCH', `/trades/${lot}`, { totalCents: 1_200_00 })).toEqual({ status: 200, body: { ok: true, id: lot, changed: true, affected: 1 } })
    expect((await send('PATCH', '/trades/999999', { qty: '1' })).status).toBe(404)

    expect(await send('DELETE', `/trades/${lot}`)).toEqual({ status: 200, body: { ok: true, id: lot, rewritten: 1, unlinkedVests: 0, withholdingRemoved: 0 } })
    expect((await listed()).map((t) => [t.id, t.realized])).toEqual([[sell, { st_cents: 0, lt_cents: 800_00 - 480_00, zero_basis_cents: 0 }]])
    expect((await send('DELETE', `/trades/${lot}`)).status).toBe(404)
  })

  it('account detail and owners answer; a guarded tracking change is a 400 and changes nothing (B8)', async () => {
    const created = await send('POST', '/invest/accounts', { name: 'Fidelity 401(k)', subtype: '401k', tracking: 'balance', owner: 'Nicole', mask: '1234' })
    expect(created).toMatchObject({ status: 200, body: { kind: 'retirement', subtype: '401k', owner: 'Nicole', mask: '1234' } })
    const k = created.body.id as number
    expect((await send('PUT', '/invest/balances', { investAccountId: k, balancedOn: '2026-06-30', balanceCents: 44_500_00 })).status).toBe(200)

    const detail = await app.request(`/api/invest/accounts/${k}`)
    expect(detail.status).toBe(200)
    expect(await detail.json()).toMatchObject({
      account: { id: k, name: 'Fidelity 401(k)', tracking: 'balance' },
      positions: [],
      balances: [{ invest_account_id: k, balanced_on: '2026-06-30', balance_cents: 44_500_00 }],
      grants: [],
      counts: { balances: 1 },
    })
    expect((await app.request('/api/invest/accounts/999999')).status).toBe(404)

    expect(await send('PATCH', `/invest/accounts/${k}`, { tracking: 'lots' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/1 balance update/) } })
    expect(await send('PATCH', `/invest/accounts/${k}`, { kind: 'brokerage' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/401\(k\) is kind retirement/) } })
    expect(await send('PATCH', `/invest/accounts/${k}`, { institution: 'Fidelity' })).toMatchObject({ status: 200, body: { changed: true, account: { institution: 'Fidelity', tracking: 'balance' } } })

    const owners = (await (await app.request('/api/invest/owners')).json()) as string[]
    expect(owners).toContain('Nicole')
  })

  it('a net-settled vest over HTTP, and the portfolio carries each account’s cash (B9, B12)', async () => {
    const plan = (await send('POST', '/invest/accounts', { name: 'Acme plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true })).body.id as number
    expect((await send('PUT', '/invest/balances', { investAccountId: plan, balancedOn: '2026-08-01', balanceCents: 75_00 })).status).toBe(200)
    expect((await send('PUT', '/unvested', { investAccountId: plan, symbol: 'ACMEX', qty: '100' })).status).toBe(200)
    const body = { investAccountId: plan, symbol: 'ACMEX', qty: '25', tradedOn: '2026-08-15', totalCents: 10_000_00 }
    expect(await send('POST', '/unvested/vest', { ...body, withheldQty: '30' })).toMatchObject({ status: 400, body: { error: expect.stringMatching(/more than the 25/) } })
    const vest = await send('POST', '/unvested/vest', { ...body, withheldQty: '9' })
    expect(vest).toMatchObject({ status: 200, body: { grossQtyMicro: 25_000_000, withheldQtyMicro: 9_000_000, netQtyMicro: 16_000_000, withheldCents: 3_600_00, remainingQtyMicro: 75_000_000 } })

    const pf = (await (await app.request('/api/portfolio')).json()) as PortfolioResponse
    expect(pf.positions.find((p) => p.symbol === 'ACMEX')).toMatchObject({ qty_micro: 16_000_000, cost_cents: 6_400_00 })
    expect(pf.accounts.find((a) => a.invest_account_id === plan)).toMatchObject({ cash_cents: 75_00, cash_as_of: '2026-08-01', cash_trades: 0 })
    const detail = (await (await app.request(`/api/invest/accounts/${plan}`)).json()) as InvestAccountDetail
    expect(detail.cash).toMatchObject({ cash_cents: 75_00, value_cents: pf.accounts.find((a) => a.invest_account_id === plan)!.value_cents })
  })

  it('recorded symbols, the check-in and the realized-gains report answer; a bad year is a 400 (B10, B11, B14)', async () => {
    const a = (await send('POST', '/invest/accounts', { name: 'Spelling test', kind: 'brokerage', tracking: 'lots' })).body.id as number
    const buy = { investAccountId: a, symbol: 'BF.B', assetKind: 'stock', side: 'buy', tradedOn: '2025-03-03', qty: '10', totalCents: 500_00 }
    expect((await send('POST', '/trades', buy)).status).toBe(200)
    // The other class-share spelling is the same stock: no second asset.
    expect((await send('POST', '/trades', { ...buy, symbol: 'BF-B', side: 'sell', tradedOn: '2026-02-02', qty: '4', totalCents: 260_00 })).status).toBe(200)
    const assets = (await (await app.request('/api/invest/assets')).json()) as { symbol: string; kind: string }[]
    expect(assets.filter((x) => x.symbol.startsWith('BF'))).toEqual([{ id: expect.any(Number), symbol: 'BF.B', kind: 'stock' }])

    const checkin = (await (await app.request('/api/invest/checkin')).json()) as { items: { kind: string; id: number }[] }
    expect(checkin.items).toContainEqual(expect.objectContaining({ kind: 'cash', id: a, last: null }))

    const year = new Date().toISOString().slice(0, 4)
    const report = (await (await app.request(`/api/invest/realized?year=${year}`)).json()) as { year: number; lines: { symbol: string; gain_cents: number; term: string }[] }
    expect(report.year).toBe(Number(year))
    if (year === '2026') expect(report.lines.find((l) => l.symbol === 'BF.B')).toMatchObject({ gain_cents: 260_00 - 200_00, term: 'st' })
    expect(await send('GET', '/invest/realized?year=3000')).toMatchObject({ status: 400, body: { error: expect.stringMatching(/year must be/) } })
  })
})

