import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccountFlowRow, HarvestProfile, InvestAccountRow } from '../../shared/invest-api'
import { drawerTabs } from './AccountDrawer'
import FlowsPanel, { flowSummary } from './FlowsPanel'
import HarvestPanel, { forecastYears, formFor } from './HarvestPanel'

/**
 * The drawer's Deposits and Forecast panels, rendered to static markup (node
 * has no DOM): they say the right things from the contract shapes. Clicking
 * through is checked in the browser.
 */

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const TODAY = '2026-10-11'
const flex: InvestAccountRow = {
  id: 12, name: 'Flex 250', kind: 'brokerage', tracking: 'balance', stock_plan: 0, subtype: 'taxable', institution: 'Schwab', owner: null, mask: null, sort: 0,
  latest_snapshot: { balanced_on: '2026-09-30', balance_cents: 250_000_000 },
  counts: { trades: 0, balances: 1, unvested: 0, paychecks: 0, reported: 1, flows: 3, planned: 0 },
}
const flows: AccountFlowRow[] = [
  { id: 3, invest_account_id: 12, account: 'Flex 250', flowed_on: '2027-01-05', amount_cents: 160_000_000, note: 'January sale proceeds', planned: true },
  { id: 2, invest_account_id: 12, account: 'Flex 250', flowed_on: '2026-09-15', amount_cents: 20_000_000, note: null, planned: false },
  { id: 1, invest_account_id: 12, account: 'Flex 250', flowed_on: '2026-04-01', amount_cents: 150_000_000, note: 'Opening funding', planned: false },
]

describe('the Deposits panel', () => {
  it('lists each flow with planned ones marked, and sets the deposits against the balance', () => {
    const t = text(renderToStaticMarkup(<FlowsPanel account={flex} rows={flows} today={TODAY} onChanged={() => {}} />))
    expect(t).toContain('2027-01-05 planned')
    expect(t).toContain('+$1,600,000.00')
    expect(t).toContain('Opening funding')
    // $1.7M deposited against a $2.5M balance: $800k beyond the deposits; $1.6M planned.
    expect(t).toContain('Deposited $1,700,000.00')
    expect(t).toContain('balance $2,500,000.00 as of Sep 30: +$800,000.00 beyond the deposits')
    expect(t).toContain('+$1,600,000.00 planned')
    expect(t).toContain('Record a deposit or withdrawal')
  })

  it('with nothing recorded, offers the form alone', () => {
    const t = text(renderToStaticMarkup(<FlowsPanel account={{ ...flex, counts: { ...flex.counts, flows: 0 } }} rows={[]} today={TODAY} onChanged={() => {}} />))
    expect(t).toContain('Record a deposit or withdrawal')
    expect(t).not.toContain('Deposited')
  })

  it('sums deposits, withdrawals and plans', () => {
    expect(flowSummary(flows)).toEqual({ depositedCents: 170_000_000, withdrawnCents: 0, plannedCents: 160_000_000, past: 2 })
    expect(flowSummary([{ ...flows[1]!, amount_cents: -5_000 }])).toEqual({ depositedCents: 0, withdrawnCents: 5_000, plannedCents: 0, past: 1 })
  })
})

describe('the Forecast panel', () => {
  const profile: HarvestProfile = {
    invest_account_id: 12, as_of: '2026-08-31', year1_micro: 700_000, year2_micro: 390_000, later_micro: 250_000, source: 'Manager email',
    years: [{ tax_year: 2026, loss_cents: 35_000_000 }, { tax_year: 2027, loss_cents: 67_000_000 }],
  }

  it('shows the saved estimate and its figures', () => {
    const t = text(renderToStaticMarkup(<HarvestPanel account={flex} profile={profile} today={TODAY} onChanged={() => {}} />))
    expect(t).toContain('The manager’s estimate')
    expect(t).toContain('Saved: 70% / 39% / 25% on new money · 2026 $350,000.00 · 2027 $670,000.00 · Manager email')
    expect(t).toContain('Remove forecast…')
  })

  it('without one, asks for it, with this year and next ready to fill', () => {
    const t = text(renderToStaticMarkup(<HarvestPanel account={flex} profile={null} today={TODAY} onChanged={() => {}} />))
    expect(t).toContain('Enter the manager’s estimate')
    expect(t).not.toContain('Remove forecast')
    expect(formFor(null, TODAY).years.map((y) => y.taxYear)).toEqual([2026, 2027])
    expect(formFor(profile, TODAY)).toMatchObject({ asOf: '2026-08-31', year1Micro: 700_000, source: 'Manager email', years: [{ taxYear: 2026, lossCents: 35_000_000 }, { taxYear: 2027, lossCents: 67_000_000 }] })
    expect(forecastYears('2026-08-31')).toEqual([2026, 2027, 2028, 2029, 2030, 2031, 2032, 2033, 2034, 2035, 2036])
  })

  it('is a tab of a taxable balance account only', () => {
    expect(drawerTabs(flex)).toContain('harvest')
    expect(drawerTabs({ tracking: 'balance', kind: 'retirement' })).not.toContain('harvest')
    expect(drawerTabs({ tracking: 'balance', kind: 'retirement' })).toContain('flows')
    expect(drawerTabs({ tracking: 'lots', kind: 'brokerage' })).not.toContain('flows')
  })
})
