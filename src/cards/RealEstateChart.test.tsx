import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { todayLocal } from '../../shared/dates'
import type { TimeChartProps } from '../chart/TimeChart'
import type { PropertyDetail } from '../screens/RealEstate'
import RealEstateChart from './RealEstateChart'

// Node has no layout, so TimeChart would draw nothing: capture what the card hands it instead.
const seen: TimeChartProps[] = []
vi.mock('../chart/TimeChart', () => ({
  TimeChart: (p: TimeChartProps) => {
    seen.push(p)
    return null
  },
}))

const house: PropertyDetail = {
  id: 1,
  name: 'Maple St',
  purchased_on: '2020-06-15',
  purchase_cents: 800_000_00,
  latest_valuation: null,
  valuations: [],
  liabilities: [
    {
      id: 1, name: 'Mortgage', rate_micro: 30_000,
      latest_balance: { balanced_on: '2021-01-01', balance_cents: 600_000_00 },
      balances: [{ balanced_on: '2021-01-01', balance_cents: 600_000_00 }],
    },
  ],
}

describe('RealEstateChart', () => {
  it('runs both the value and the debt line on to today (F14)', () => {
    seen.length = 0
    renderToStaticMarkup(<RealEstateChart property={house} />)
    const series = seen.at(-1)!.series
    expect(series.map((s) => [s.id, s.carryTo])).toEqual([
      ['value', todayLocal()],
      ['debt', todayLocal()],
    ])
  })

  it('draws nothing from a purchase alone', () => {
    seen.length = 0
    renderToStaticMarkup(<RealEstateChart property={{ ...house, liabilities: [] }} />)
    expect(seen).toHaveLength(0)
  })
})
