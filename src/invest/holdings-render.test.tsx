import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import type { ReturnsResponse, SparksResponse } from '../../shared/series-api'
import HoldingsCard from './HoldingsCard'
import HoldingsTable from './HoldingsTable'
import InvestSummary from './InvestSummary'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const TODAY = '2026-09-22'

const lot = (account: number, name: string, qty: number, cost: number, sheltered = false) => ({
  trade_id: account, opened_on: '2020-03-02', lt_on: '2021-03-03', qty_micro: qty, cost_cents: cost, invest_account_id: account, account_name: name, sheltered,
})
const vti: PortfolioPosition = {
  asset_id: 1, symbol: 'VTI', kind: 'stock', qty_micro: 15_000_000, cost_cents: 3_000_00, price_cents: 300_00, priced_on: TODAY,
  value_cents: 4_500_00, unrealized_cents: 1_500_00, prev_close_cents: 298_00, day_change_cents: 30_00,
  lots: [lot(1, 'Schwab', 10_000_000, 1_500_00), lot(2, 'Roth IRA', 5_000_000, 1_500_00, true)],
  accounts: [
    { invest_account_id: 1, name: 'Schwab', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 1_500_00, value_cents: 3_000_00, day_change_cents: 20_00 },
    { invest_account_id: 2, name: 'Roth IRA', kind: 'retirement', qty_micro: 5_000_000, cost_cents: 1_500_00, value_cents: 1_500_00, day_change_cents: 10_00 },
  ],
}
// Hand-priced: no previous close, so no day change.
const fund: PortfolioPosition = {
  asset_id: 2, symbol: 'FUND', kind: 'stock', qty_micro: 10_000_000, cost_cents: 1_200_00, price_cents: 100_00, priced_on: '2026-09-20',
  value_cents: 1_000_00, unrealized_cents: -200_00, price_manual: true, prev_close_cents: null, day_change_cents: null,
  lots: [lot(1, 'Schwab', 10_000_000, 1_200_00)],
  accounts: [{ invest_account_id: 1, name: 'Schwab', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 1_200_00, value_cents: 1_000_00, day_change_cents: null }],
}
const totals: PortfolioResponse['totals'] = { value: 5_500_00, cost: 4_200_00, unrealized: 1_300_00, cash: 0, day_change: 30_00, day_base: 4_470_00, ytd_st: 0, ytd_lt: 0, ytd_sheltered: 0, ytd_reported_st: 0, ytd_reported_lt: 0 }
const row = (p: PortfolioPosition, irr: number | null, annualized: boolean, held: number) => ({
  asset_id: p.asset_id, symbol: p.symbol, value_cents: p.value_cents, cost_cents: p.cost_cents, unrealized_cents: p.unrealized_cents,
  unrealized_micro: 0, irr_micro: irr, annualized, held_days: held, weight_micro: 0, priced: true,
})
const returns: ReturnsResponse = {
  as_of: TODAY,
  rows: [row(vti, 64_000, true, 2400), row(fund, -20_000, false, 120)],
  totals: { value_cents: 5_500_00, cost_cents: 4_200_00, unrealized_cents: 1_300_00, irr_micro: 52_000, annualized: true },
}
const sparks: SparksResponse = { from: '2026-06-24', to: TODAY, series: [{ asset_id: 1, closes: [{ d: '2026-07-01', c: 280_00 }, { d: TODAY, c: 300_00 }] }] }

describe('the holdings card', () => {
  const render = (over: Partial<Parameters<typeof HoldingsCard>[0]> = {}) =>
    renderToStaticMarkup(
      <HoldingsCard positions={[vti, fund]} totals={totals} returns={returns} sparks={sparks} today={TODAY} onOpen={() => {}} onPriceSaved={() => {}} {...over} />,
    )

  it('puts the day, the value, the gain and the return on one row, and opens the holding from its symbol', () => {
    const html = render()
    const t = text(html)
    // Qty and the account count ride under the symbol; the day's change sits beside the price.
    expect(t).toMatch(/VTI 15 · 2 accounts \$300\.00 ▲ \$30\.00 0\.67% \$4,500\.00 cost basis \$3,000\.00 ▲ \$1,500\.00 50% \+6\.4%\/yr held 6 yr 6 mo 81\.8%/)
    // Under a year: the plain return over the months held, never annualized.
    expect(t).toMatch(/— \$1,000\.00 cost basis \$1,200\.00 ▼ \$200\.00 17% −2\.0% over 3 mo 18\.2%/)
    expect(html).toContain('aria-label="VTI: open its chart, lots and trades"')
    expect(html).toContain('aria-label="VTI over the last 90 days: up 7.1%"')
    // The total: the day across holdings that have one, and the combined rate.
    expect(t).toMatch(/Total ▲ \$30\.00 0\.67% \$5,500\.00 cost basis \$4,200\.00 ▲ \$1,300\.00 31% \+5\.2%\/yr/)
    // Sorted by value, largest first, and the header says so.
    expect(html).toMatch(/aria-sort="descending"[^>]*>(?:(?!<\/th>).)*Value/)
    expect(t.indexOf('VTI 15')).toBeLessThan(t.indexOf('FUND 10'))
  })

  it('draws without the returns or the sparklines, and adds cash to the total', () => {
    const t = text(render({ returns: null, sparks: null, cash: { cents: 250_00, note: 'in 1 account' } }))
    expect(t).toMatch(/VTI 15 · 2 accounts \$300\.00 ▲ \$30\.00/)
    expect(t).toMatch(/Cash in 1 account \$250\.00/)
    expect(t).toMatch(/Total ▲ \$30\.00 0\.67% \$5,750\.00/)
  })
})

describe('the holdings card, capped for the overview', () => {
  it('lists the largest few by value, folds the rest into one line and keeps the whole total', () => {
    const html = renderToStaticMarkup(
      <HoldingsCard positions={[fund, vti]} totals={totals} returns={returns} sparks={sparks} today={TODAY} onOpen={() => {}} onPriceSaved={() => {}} limit={1} more={<a href="#/invest/holdings">All 2 holdings</a>} />,
    )
    const t = text(html)
    expect(t).toMatch(/Holdings All 2 holdings/)
    expect(t).toMatch(/VTI 15 · 2 accounts/)
    expect(t).not.toMatch(/FUND/)
    expect(t).toMatch(/1 more holding \$1,000\.00 18\.2%/)
    expect(t).toMatch(/Total ▲ \$30\.00 0\.67% \$5,500\.00/)
    // Sorting belongs to the full view: plain headers here.
    expect(html).not.toContain('inv-sortbtn')
    expect(html).not.toContain('aria-sort')
  })
})

describe('the investments headline', () => {
  const render = (over: Partial<Parameters<typeof InvestSummary>[0]> = {}) =>
    text(
      renderToStaticMarkup(
        <InvestSummary loaded valueCents={7_750_00} totals={totals} positions={[vti, fund]} cashCents={250_00} balanceCents={2_000_00} rate={returns.totals} today={TODAY} {...over} />,
      ),
    )

  it('says what it is all worth, what it did today and how it has done', () => {
    const t = render()
    expect(t).toMatch(/Portfolio \$7,750\.00 ▲ \$30\.00 0\.67% today/)
    // What the day's change leaves out is said, not hidden.
    expect(t).toMatch(/1 holding has no quote for the day\. Accounts tracked by balance move only when you record one\./)
    expect(t).toMatch(/holdings \$5,500\.00 · cash \$250\.00 · tracked by balance \$2,000\.00/)
    expect(t).toMatch(/Unrealized \+\$1,300\.00 31\.0% of cost/)
    expect(t).toMatch(/\+5\.2%\/yr money-weighted/)
    expect(t).toMatch(/Cost basis \$4,200\.00/)
  })

  it('names the day when the quotes are not today’s, and says so when there is no day change at all', () => {
    expect(render({ positions: [{ ...vti, priced_on: '2026-09-18' }] })).toMatch(/▲ \$30\.00 0\.67% Sep 18/)
    const none = render({ positions: [fund], totals: { ...totals, day_change: 0, day_base: 0 } })
    expect(none).toMatch(/No change for the day yet/)
    expect(none).not.toMatch(/▲|▼/)
  })
})

describe('one holding’s accounts and lots (its drawer)', () => {
  it('lays every account and lot open, without a symbol row or a total', () => {
    const html = renderToStaticMarkup(<HoldingsTable variant="lots" positions={[vti]} totals={totals} marginal={null} today={TODAY} onSell={() => {}} />)
    const t = text(html)
    expect(t).toMatch(/Account · lot Qty Cost/)
    expect(t).toMatch(/Schwab taxable 10 \$3,000\.00/)
    expect(t).toMatch(/Roth IRA tax-advantaged 5 \$1,500\.00/)
    expect(html.match(/Sell…/g)).toHaveLength(2)
    expect(t).not.toMatch(/Total/)
    expect(html).not.toContain('aria-expanded')
  })
})
