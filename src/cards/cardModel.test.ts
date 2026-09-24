import { describe, expect, it } from 'vitest'
import type { PortfolioPosition, TradeRow } from '../../shared/invest-api'
import type { HoldingReturn, ReturnsResponse } from '../../shared/series-api'
import {
  fanMarkers,
  propertyLines,
  heldText,
  noRateDay,
  pctOfTarget,
  projectionHorizon,
  returnBars,
  scopeReturns,
  sumSeries,
  tileGroups,
  tileSpan,
  tradeRug,
  unrealizedAt,
  type NetWorthPoint,
} from './cardModel'

const pt = (month: string, o: Partial<NetWorthPoint> = {}): NetWorthPoint => {
  const p = { month, cash: 0, brokerage: 0, retirement: 0, crypto: 0, property: 0, liabilities: 0, ...o }
  return { ...p, total: p.cash + p.brokerage + p.retirement + p.crypto + p.property + p.liabilities }
}

describe('tileGroups (Dashboard tiles)', () => {
  it('groups as the mockup does, in slot colours, each linking to its screen', () => {
    const g = tileGroups([pt('2026-08', { brokerage: 1, retirement: 2, cash: 3, crypto: 4, property: 900_000_00, liabilities: -500_000_00 })])
    expect(g.map((x) => [x.label, x.color, x.to.screen])).toEqual([
      ['Brokerage', 'var(--s1)', 'invest'],
      ['Retirement', 'var(--s2)', 'invest'],
      ['Home equity', 'var(--s3)', 're'],
      ['Cash + crypto', 'var(--s5)', 'cash'],
    ])
    const p = pt('2026-09', { property: 900_000_00, liabilities: -500_000_00, cash: 10_00, crypto: 5_00 })
    expect(g[2]!.of(p)).toBe(400_000_00) // equity = value + (negative) debt
    expect(g[3]!.of(p)).toBe(15_00)
  })

  it('hides a class that was $0 all window (bug #69) and home equity without a property', () => {
    const g = tileGroups([pt('2026-08', { brokerage: 5_00 }), pt('2026-09', { brokerage: 6_00, liabilities: -20_000_00 })])
    expect(g.map((x) => x.key)).toEqual(['brokerage'])
  })

  it('keeps a class that went to $0 this month, so the drop is visible', () => {
    const g = tileGroups([pt('2026-08', { retirement: 50_00 }), pt('2026-09')])
    expect(g.map((x) => x.key)).toEqual(['retirement'])
  })

  it('names and links only the half of cash + crypto that exists', () => {
    expect(tileGroups([pt('2026-09', { cash: 1 })]).map((x) => [x.label, x.to.screen])).toEqual([['Cash', 'cash']])
    expect(tileGroups([pt('2026-09', { crypto: 1 })]).map((x) => [x.label, x.to.screen])).toEqual([['Crypto', 'invest']])
  })

  it('shares the row evenly', () => {
    expect([1, 2, 3, 4].map(tileSpan)).toEqual(['c12', 'c6', 'c4', 'c3'])
  })
})

describe('goal fund chart helpers', () => {
  it('runs to the ETA when it is within five years or twice the history', () => {
    expect(projectionHorizon(1, 43)).toBe(43) // the ETA marker shows
    expect(projectionHorizon(18, 15)).toBe(15) // the mockup's case
    expect(projectionHorizon(40, 75)).toBe(75) // twice the history reaches it
    expect(projectionHorizon(80, 118)).toBe(118)
  })
  it('otherwise draws twice the history, between three and ten years', () => {
    expect(projectionHorizon(0)).toBe(36)
    expect(projectionHorizon(9, 125)).toBe(36) // a decade-away ETA doesn't flatten 9 months of history
    expect(projectionHorizon(24, null)).toBe(48)
    expect(projectionHorizon(80, 400)).toBe(120)
    expect(projectionHorizon(70, 130)).toBe(120)
  })
  it('reads % of target as an exact floor', () => {
    expect(pctOfTarget(412_300_00, 680_000_00)).toBe(60) // 60.63% → 60, never rounded up
    expect(pctOfTarget(679_999_99, 680_000_00)).toBe(99)
    expect(pctOfTarget(680_000_00, 680_000_00)).toBe(100)
    expect(pctOfTarget(700_000_00, 680_000_00)).toBe(102)
    expect(pctOfTarget(-5, 100)).toBe(0)
    expect(pctOfTarget(5, 0)).toBe(0)
  })
})

describe('unrealizedAt (portfolio tooltip row)', () => {
  it('is value − cost, with the percent of cost', () => {
    expect(unrealizedAt(4_086_557, 2_777_000)).toEqual({ cents: 1_309_557, micro: 471_573 })
    expect(unrealizedAt(90_00, 100_00)).toEqual({ cents: -10_00, micro: -100_000 })
    expect(unrealizedAt(5_00, 0)).toEqual({ cents: 5_00, micro: null })
    expect(unrealizedAt(null, 5)).toBeNull()
    expect(unrealizedAt(1.5, 1)).toBeNull()
  })
})

describe('tradeRug', () => {
  const row = (o: Partial<TradeRow>): TradeRow => ({
    id: 1,
    traded_on: '2026-06-01',
    side: 'buy',
    qty_micro: 10_000_000,
    total_cents: 50_000,
    asset_id: 1,
    symbol: 'VTI',
    invest_account_id: 2,
    account_name: 'Vanguard',
    note: null,
    acquired_on: null,
    ...o,
  })
  it('ticks each trade on its day, oldest first, ▲ buys and ▼ sells, naming starting positions', () => {
    const rug = tradeRug([
      row({ id: 9, traded_on: '2026-09-23', side: 'sell', qty_micro: 1_000_000 }),
      row({ id: 3, traded_on: '2025-11-15' }),
      row({ id: 7, traded_on: '2026-09-23', note: 'Opening position', symbol: 'VXUS', qty_micro: 200_000_000 }),
    ])
    expect(rug.map((r) => [r.t, r.shape, r.label])).toEqual([
      ['2025-11-15', 'up', 'Bought 10 VTI · Vanguard'],
      ['2026-09-23', 'up', 'Starting position: 200 VXUS · Vanguard'],
      ['2026-09-23', 'down', 'Sold 1 VTI · Vanguard'],
    ])
    expect(new Set(rug.map((r) => r.id)).size).toBe(3)
  })
})

describe('returnBars', () => {
  const hr = (o: Partial<HoldingReturn>): HoldingReturn => ({
    asset_id: 1,
    symbol: 'X',
    value_cents: 100,
    cost_cents: 100,
    unrealized_cents: 0,
    unrealized_micro: 0,
    irr_micro: null,
    annualized: false,
    held_days: 10,
    weight_micro: 0,
    priced: true,
    ...o,
  })
  it('sorts best to worst, unpriced last, on one scale from the largest loss to the largest gain', () => {
    const { bars, zeroPct } = returnBars([
      hr({ symbol: 'ACME', unrealized_micro: 3_659 }),
      hr({ symbol: 'ETH', unrealized_micro: -200_000 }),
      hr({ symbol: 'NEW', priced: false, unrealized_micro: null }),
      hr({ symbol: 'FXAIX', unrealized_micro: 600_000 }),
    ])
    expect(bars.map((b) => b.symbol)).toEqual(['FXAIX', 'ACME', 'ETH', 'NEW'])
    // span 800_000: zero sits a quarter of the way in (inside 2% margins)
    expect(zeroPct).toBe(26)
    expect(bars[0]).toMatchObject({ x: 26, w: 72 })
    expect(bars[1]).toMatchObject({ x: 26, w: 0.8 }) // a real but tiny return stays visible
    expect(bars[2]).toMatchObject({ x: 2, w: 24 }) // a loss grows left from zero
    expect(bars[3]).toMatchObject({ w: 0 })
  })
  it('puts zero at the left edge when nothing is down, and survives flat or unpriced lists', () => {
    const up = returnBars([hr({ unrealized_micro: 500_000 }), hr({ unrealized_micro: 250_000 })])
    expect(up.zeroPct).toBe(2)
    expect(up.bars.map((b) => b.w)).toEqual([96, 48])
    expect(returnBars([hr({ unrealized_micro: 0 })]).bars[0]!.w).toBe(0)
    expect(returnBars([hr({ priced: false, unrealized_micro: null })]).bars[0]!.w).toBe(0)
    expect(returnBars([])).toEqual({ bars: [], zeroPct: 2 })
  })
})

describe('heldText', () => {
  it('reads days, then years and months', () => {
    expect(heldText(1)).toBe('1 day')
    expect(heldText(12)).toBe('12 days')
    expect(heldText(131)).toBe('4 mo')
    expect(heldText(365)).toBe('11 mo')
    expect(heldText(366)).toBe('1 yr')
    expect(heldText(2_456)).toBe('6 yr 8 mo')
  })
})

describe('sumSeries (an owner pill’s inv:<id> series added up)', () => {
  it('adds month by month, counts a month before an account’s first fact as nothing, and keeps estimates', () => {
    const a = [
      { t: '2026-06', v: 100 },
      { t: '2026-07', v: 150, est: true },
      { t: '2026-08', v: 200 },
    ]
    const b = [
      { t: '2026-07', v: 1_000 },
      { t: '2026-08', v: null },
      { t: '2026-09', v: 1_200 },
    ]
    expect(sumSeries([b, a])).toEqual([
      { t: '2026-06', v: 100 },
      { t: '2026-07', v: 1_150, est: true },
      { t: '2026-08', v: 200 },
      { t: '2026-09', v: 1_200 },
    ])
    expect(sumSeries([])).toEqual([])
    expect(sumSeries([[{ t: '2026-01', v: null }]])).toEqual([{ t: '2026-01', v: null }])
  })
})

describe('scopeReturns (return by holding under an owner pill)', () => {
  const lot = (account: number, opened_on: string, cost_cents: number) => ({
    trade_id: null,
    opened_on,
    lt_on: opened_on,
    qty_micro: 1_000_000,
    cost_cents,
    invest_account_id: account,
    account_name: `A${account}`,
    sheltered: false,
  })
  const pos = (asset_id: number, symbol: string, split: [number, number, number][], lots: ReturnType<typeof lot>[]): PortfolioPosition => ({
    asset_id,
    symbol,
    kind: 'stock',
    qty_micro: 0,
    cost_cents: split.reduce((s, x) => s + x[2], 0),
    price_cents: 100,
    priced_on: '2026-09-23',
    value_cents: split.reduce((s, x) => s + x[1], 0),
    unrealized_cents: 0,
    lots,
    accounts: split.map(([id, value_cents, cost_cents]) => ({ invest_account_id: id, name: `A${id}`, kind: 'brokerage' as const, qty_micro: 0, value_cents, cost_cents })),
  })
  const row = (asset_id: number, symbol: string, value: number, cost: number, irr: number | null): HoldingReturn => ({
    asset_id,
    symbol,
    value_cents: value,
    cost_cents: cost,
    unrealized_cents: value - cost,
    unrealized_micro: Math.round(((value - cost) / cost) * 1_000_000),
    irr_micro: irr,
    annualized: true,
    held_days: 800,
    weight_micro: 0,
    priced: true,
  })
  // VTI: 3 in account 1 (Max), 7 in account 2 (joint). BRK: only in account 2.
  const positions = [
    pos(1, 'VTI', [[1, 300_00, 200_00], [2, 700_00, 400_00]], [lot(1, '2026-01-01', 200_00), lot(2, '2024-06-01', 400_00)]),
    pos(2, 'BRK', [[2, 500_00, 450_00]], [lot(2, '2025-01-01', 450_00)]),
  ]
  const data: ReturnsResponse = {
    as_of: '2026-09-23',
    rows: [row(1, 'VTI', 1_000_00, 600_00, 90_000), row(2, 'BRK', 500_00, 450_00, 40_000)],
    totals: { value_cents: 1_500_00, cost_cents: 1_050_00, unrealized_cents: 450_00, irr_micro: 70_000, annualized: true },
  }

  it('re-sums a shared holding for the scope, without a rate, and keeps a whole one’s rate', () => {
    const r = scopeReturns(data, positions, new Set([2]))
    expect(r.rows.map((x) => [x.symbol, x.value_cents, x.cost_cents, x.unrealized_cents, x.irr_micro, !!x.shared])).toEqual([
      ['VTI', 700_00, 400_00, 300_00, null, true],
      ['BRK', 500_00, 450_00, 50_00, 40_000, false],
    ])
    expect(r.rows[0]!.unrealized_micro).toBe(750_000)
    expect(r.rows[0]!.held_days).toBe(844) // from its own oldest lot in the scope, 2024-06-01
    expect(r.rows.map((x) => x.weight_micro)).toEqual([583_333, 416_667])
    expect(r.totals).toEqual({ value_cents: 1_200_00, cost_cents: 850_00, unrealized_cents: 350_00, irr_micro: null, annualized: false })
  })

  it('drops what the scope doesn’t hold, and keeps the household totals when it holds everything', () => {
    const max = scopeReturns(data, positions, new Set([1]))
    expect(max.rows.map((x) => x.symbol)).toEqual(['VTI'])
    expect(max.rows[0]!.held_days).toBe(265)
    const all = scopeReturns(data, positions, new Set([1, 2]))
    expect(all.totals).toBe(data.totals)
    expect(all.rows.map((x) => x.irr_micro)).toEqual([90_000, 40_000])
    expect(scopeReturns(data, positions, new Set([9])).rows).toEqual([])
  })

  it('leaves out a row the positions don’t know yet (a reload between the two reads)', () => {
    expect(scopeReturns(data, positions.slice(0, 1), new Set([2])).rows.map((x) => x.symbol)).toEqual(['VTI'])
  })

  it('names the day a missing rate needs a price for only when the lots share one', () => {
    expect(noRateDay(2, positions)).toBe('2025-01-01')
    expect(noRateDay(1, positions)).toBeNull()
    expect(noRateDay(3, positions)).toBeNull()
    expect(noRateDay(1, undefined)).toBeNull()
  })
})

describe('fanMarkers', () => {
  const years = [2026, 2027, 2028, 2029, 2030, 2048, 2060]
  const base = { years, buyYear: 2027, retireYear: 2048, crossingYear: 2045, thresholdPct: 90 }
  it('marks the purchase only when the run models one (F15: no loan options → no purchase simulated)', () => {
    expect(fanMarkers({ ...base, buys: true }).map((m) => m.id)).toEqual(['today', 'buy', 'retire', 'cross'])
    expect(fanMarkers({ ...base, buys: false }).map((m) => m.id)).toEqual(['today', 'retire', 'cross'])
  })
  it('leaves out years outside the simulated span, and has nothing to mark with no years', () => {
    expect(fanMarkers({ ...base, buys: true, buyYear: 2020, retireYear: 2070, crossingYear: null }).map((m) => m.id)).toEqual(['today'])
    expect(fanMarkers({ ...base, buys: true, years: [] })).toEqual([])
    expect(fanMarkers({ ...base, buys: false }).find((m) => m.id === 'cross')).toEqual({ id: 'cross', t: '2045-01-01', label: 'Crossing · ≥90%', tone: 'gold' })
  })
})

describe('propertyLines', () => {
  const house = (o: Partial<Parameters<typeof propertyLines>[0]> = {}) => ({
    purchased_on: '2020-06-15',
    purchase_cents: 800_000_00,
    valuations: [],
    liabilities: [],
    ...o,
  })
  it('a purchase and one later balance is two dates: enough to chart', () => {
    const l = propertyLines(house({ liabilities: [{ balances: [{ balanced_on: '2021-01-01', balance_cents: 600_000_00 }] }] }))
    expect(l).toEqual({
      value: [{ t: '2020-06-15', v: 800_000_00 }],
      debt: [{ t: '2021-01-01', v: 600_000_00 }],
      bought: { t: '2020-06-15', v: 800_000_00 },
    })
  })
  it('a purchase alone is one date: nothing to chart', () => {
    expect(propertyLines(house())).toBeNull()
  })
  it('sums several loans as of each date and keeps valuations in date order', () => {
    const l = propertyLines(
      house({
        valuations: [{ valued_on: '2025-09-01', value_cents: 900_000_00 }, { valued_on: '2024-06-01', value_cents: 850_000_00 }],
        liabilities: [
          { balances: [{ balanced_on: '2024-06-01', balance_cents: 500_000_00 }] },
          { balances: [{ balanced_on: '2026-09-01', balance_cents: 50_000_00 }] },
        ],
      }),
    )!
    expect(l.value.map((p) => p.t)).toEqual(['2020-06-15', '2024-06-01', '2025-09-01'])
    expect(l.debt).toEqual([{ t: '2024-06-01', v: 500_000_00 }, { t: '2026-09-01', v: 550_000_00 }])
  })
})
