import { describe, expect, it } from 'vitest'
import type { PortfolioPosition } from '../../shared/invest-api'
import { accountDay, dayAmount, dayChange, dayOf, dayPercent, nextSort, parseSort, priceDay, sortHoldings, totalDay, type SortableHolding } from './dayMath'

const pos = (over: Partial<PortfolioPosition>): PortfolioPosition => ({
  asset_id: 1, symbol: 'VTI', kind: 'stock', qty_micro: 10_000_000, cost_cents: 2_000_00, price_cents: 300_00, priced_on: '2026-09-22',
  value_cents: 3_000_00, unrealized_cents: 1_000_00, lots: [], accounts: [],
  ...over,
})

describe('the day’s change', () => {
  it('is a percent of what the holding was worth before it', () => {
    expect(dayChange(20_00, 3_000_00)).toEqual({ cents: 20_00, micro: 6_711 }) // $20 on $2,980
    expect(dayChange(-30_00, 2_970_00)).toEqual({ cents: -30_00, micro: -10_000 })
    expect(dayChange(null, 3_000_00)).toBeNull()
    expect(dayChange(undefined, 3_000_00)).toBeNull()
    // Everything bought today at exactly its value: nothing to measure against.
    expect(dayChange(500_00, 500_00)).toEqual({ cents: 500_00, micro: null })
  })

  it('totals read the engine’s base; none when no holding has a day change', () => {
    expect(totalDay({ day_change: 30_00, day_base: 4_470_00 })).toEqual({ cents: 30_00, micro: 6_711 })
    expect(totalDay({ day_change: 0, day_base: 0 })).toBeNull()
    expect(totalDay({ day_change: 0, day_base: 1_000_00 })).toEqual({ cents: 0, micro: 0 })
  })

  it('an account sums its part of each position; holdings without a change stay out', () => {
    const acct = (id: number, value: number, day: number | null) => ({ invest_account_id: id, name: `A${id}`, kind: 'brokerage' as const, qty_micro: 1, cost_cents: 1, value_cents: value, day_change_cents: day })
    const positions = [
      pos({ accounts: [acct(1, 3_000_00, 20_00), acct(2, 1_500_00, 10_00)] }),
      pos({ asset_id: 2, symbol: 'QQQ', accounts: [acct(1, 1_000_00, -5_00)] }),
      pos({ asset_id: 3, symbol: 'FUND', accounts: [acct(1, 9_000_00, null)] }), // hand-priced
    ]
    expect(accountDay(1, positions)).toEqual({ cents: 15_00, micro: Math.round((15_00 * 1e6) / 3_985_00) })
    expect(accountDay(2, positions)?.cents).toBe(10_00)
    expect(accountDay(3, positions)).toBeNull()
  })

  it('a share’s change is the price against the previous close', () => {
    expect(priceDay({ price_cents: 300_00, prev_close_cents: 298_00 })).toEqual({ cents: 2_00, micro: 6_711 })
    expect(priceDay({ price_cents: 300_00, prev_close_cents: null })).toBeNull()
    expect(priceDay({ price_cents: null, prev_close_cents: 298_00 })).toBeNull()
  })

  it('names the newest quote day among holdings that have a change', () => {
    expect(dayOf([{ priced_on: '2026-09-18', day_change_cents: 1 }, { priced_on: '2026-09-20', day_change_cents: 0 }, { priced_on: '2026-09-22', day_change_cents: null }])).toBe('2026-09-20')
    expect(dayOf([{ priced_on: '2026-09-22', day_change_cents: null }])).toBeNull()
  })

  it('words: an arrow for the direction, the amount and percent unsigned', () => {
    expect(dayAmount(12_30)).toBe('▲ $12.30')
    expect(dayAmount(-4_10)).toBe('▼ $4.10')
    expect(dayAmount(0)).toBe('$0.00')
    expect(dayPercent(-4_200)).toBe('0.42%')
    expect(dayPercent(null)).toBe('')
  })
})

describe('sorting holdings', () => {
  const row = (symbol: string, value: number, day: number | null, irr: number | null): SortableHolding => ({
    symbol, price_cents: 1, value_cents: value, unrealized_cents: 0, day_micro: day, irr_micro: irr,
  })
  const rows = [row('B', 200, 5, null), row('A', 300, -2, 10), row('C', 100, null, 30)]
  const order = (key: Parameters<typeof nextSort>[1], dir: 'asc' | 'desc') => sortHoldings(rows, { key, dir }).map((r) => r.symbol).join('')

  it('by any column, either way, with rows that lack the figure last', () => {
    expect(order('value', 'desc')).toBe('ABC')
    expect(order('symbol', 'asc')).toBe('ABC')
    expect(order('day', 'desc')).toBe('BAC')
    expect(order('day', 'asc')).toBe('ABC') // C has no day change: last, not first
    expect(order('return', 'desc')).toBe('CAB')
  })

  it('a header click flips its own column and starts a new one where it reads best', () => {
    expect(nextSort({ key: 'value', dir: 'desc' }, 'value')).toEqual({ key: 'value', dir: 'asc' })
    expect(nextSort({ key: 'value', dir: 'desc' }, 'symbol')).toEqual({ key: 'symbol', dir: 'asc' })
    expect(nextSort({ key: 'symbol', dir: 'asc' }, 'day')).toEqual({ key: 'day', dir: 'desc' })
    expect(parseSort('day-asc')).toEqual({ key: 'day', dir: 'asc' })
    expect(parseSort('nonsense')).toEqual({ key: 'value', dir: 'desc' })
  })
})
