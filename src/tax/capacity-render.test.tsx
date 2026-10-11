import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Capacity, CapacityYear } from '../../engine/capacity'
import CapacityCard, { yearLine } from './CapacityCard'

/** The capacity view rendered to static markup from a contract-shaped response (node has no DOM). */
const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')

const year = (over: Partial<CapacityYear>): CapacityYear => ({
  year: 2026, salesStCents: 0, salesLtCents: 5_950_000, plannedStCents: 0, plannedLtCents: 0, reportedCents: -50_000_000, forecastCents: -33_582_537,
  carryInStCents: 0, carryInLtCents: 0, netStCents: 0, netLtCents: 0, capLossUsedCents: 300_000, carryOutStCents: 77_332_537, carryOutLtCents: 0,
  roomCents: 77_332_537, taxCents: 4_000_000, capGainsTaxCents: -72_000, est: true, ...over,
})
const cap: Capacity = {
  today: '2026-10-11',
  thisYear: 2026,
  years: [
    year({}),
    year({ year: 2027, salesLtCents: 0, plannedLtCents: 61_200_000, reportedCents: 0, forecastCents: -189_931_776, carryInStCents: 77_332_537, carryOutStCents: 205_764_313, roomCents: 205_764_313 }),
  ],
  sales: [
    {
      id: 1, invest_account_id: 1, account: 'Coinbase', asset_id: 1, symbol: 'BTC', asset_kind: 'crypto', planned_on: '2027-01-05', qty_micro: 8_000_000, price_cents: null, note: 'January',
      price_used_cents: 8_000_000, price_source: 'quote', priced_on: '2026-10-01', proceeds_cents: 64_000_000, cost_cents: 2_800_000, st_cents: 0, lt_cents: 61_200_000, warnings: [],
    },
  ],
  accounts: [
    {
      accountId: 2, name: 'Flex 250',
      profile: { invest_account_id: 2, as_of: '2026-08-31', year1_micro: 700_000, year2_micro: 390_000, later_micro: 250_000, source: 'Manager email', years: [{ tax_year: 2026, loss_cents: 35_000_000 }] },
      reported: { cents: -50_000_000, asOf: '2026-09-18' },
      flows: [{ id: 1, invest_account_id: 2, account: 'Flex 250', flowed_on: '2027-01-05', amount_cents: 160_000_000, note: null, planned: true }],
      byYear: [{ year: 2026, cents: 33_582_537 }, { year: 2027, cents: 189_931_776 }],
      balanceCents: 200_000_000, balanceOn: '2026-08-31',
      notes: ['1 withdrawal recorded; a withdrawal doesn’t reduce the forecast.'],
    },
    { accountId: 7, name: 'Old managed', profile: null, reported: null, flows: [], byYear: [], balanceCents: null, balanceOn: null, notes: ['No harvest forecast entered: its reported figures count, and nothing further is expected.'] },
  ],
  series: {
    losses: [{ t: '2026-01-01', v: 0, est: false }, { t: '2026-09-18', v: 50_000_000 }, { t: '2026-12-31', v: 83_582_537, est: true }],
    gains: [{ t: '2026-01-01', v: 0, est: false }, { t: '2026-08-17', v: 5_950_000 }, { t: '2026-12-31', v: 5_950_000, est: true }],
  },
  markers: [{ id: 'sale:1', t: '2027-01-05', label: 'BTC 8' }],
  basis: ['Realized so far in 2026: +$59,500 from recorded sales, -$500,000 as brokers report it through 2026-09-18'],
  leavesOut: ['Forecast losses are taken as short-term.'],
  vintage: 'Federal: tax year 2026 — held for later years',
}

describe('the capacity view', () => {
  it('leads with the room this year and next, lists the years, the plan and the managed accounts, and shows its work', () => {
    const t = text(renderToStaticMarkup(<CapacityCard cp={{ c: cap, err: null, reload: () => {} }} />))
    expect(t).toContain('Room in 2026')
    expect(t).toContain('$773,325')
    expect(t).toContain('Room in 2027')
    expect(t).toContain('Forecast losses, 2027')
    expect(t).toContain('$1,899,318')
    expect(t).toContain('Planned sales')
    expect(t).toContain('+$612,000')
    // The year table: gains with the planned part, losses with the forecast part, the carry.
    expect(t).toContain('2027 est.')
    expect(t).toContain('+$612,000 +$612,000 planned')
    expect(t).toContain('-$1,899,318 forecast')
    expect(t).toContain('−$773,325')
    // The plan, priced at the quote.
    expect(t).toContain('8 BTC')
    expect(t).toContain('Coinbase · at $80,000.00 (2026-10-01)')
    expect(t).toContain('LT +$612,000')
    // The accounts: the forecast by year and the way to the drawer; the one without a profile asks for it.
    expect(t).toContain('Flex 250')
    expect(t).toContain('Reported -$500,000 through 2026-09-18')
    expect(t).toContain('1 deposit, 1 planned')
    expect(t).toContain('2026 $335,825')
    expect(t).toContain('Enter the manager’s forecast')
    expect(t).toContain('How this is worked out')
    expect(t).toContain('An estimate, not advice')
  })

  it('says what a year comes to', () => {
    expect(yearLine(year({}))).toEqual({ label: 'Room in 2026', value: '$773,325', note: 'of losses left for gains before Dec 31' })
    expect(yearLine(year({ netLtCents: 1_000_000, roomCents: 0, capGainsTaxCents: 238_000 }))).toEqual({ label: 'Net gain, 2026', value: '$10,000', note: 'est. tax on it $2,380' })
    expect(yearLine(year({ roomCents: 0 })).note).toBe('gains and losses net to zero')
  })

  it('with nothing to net, says so and points at the drawer', () => {
    const empty: Capacity = { ...cap, sales: [], accounts: [], series: { losses: [], gains: [] }, markers: [] }
    const t = text(renderToStaticMarkup(<CapacityCard cp={{ c: empty, err: null, reload: () => {} }} />))
    expect(t).toContain('Nothing to net yet')
    expect(t).toContain('No taxable account is tracked by balance')
  })

  it('while loading, or when the request failed, says which', () => {
    expect(text(renderToStaticMarkup(<CapacityCard cp={{ c: null, err: 'boom', reload: () => {} }} />))).toContain('Couldn’t work out the capacity: boom')
    expect(renderToStaticMarkup(<CapacityCard cp={{ c: null, err: null, reload: () => {} }} />)).toContain('ui-skel')
  })
})
