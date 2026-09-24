import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { InvestAccountRow, PortfolioPosition, UnvestedRow } from '../../shared/invest-api'
import AccountSettings from './AccountSettings'
import AccountStrip from './AccountStrip'
import AddAccountFlow from './AddAccountFlow'
import GrantsPanel from './GrantsPanel'

/**
 * The account strip, the drawer's Settings and Grants panels and the add
 * flow's first step, rendered to static markup (node has no DOM): they say the
 * right things from the contract shapes. Clicking through is checked in the browser.
 */

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const TODAY = '2026-09-22'
const noCounts = { trades: 0, balances: 0, unvested: 0, paychecks: 0 }
const acct = (over: Partial<InvestAccountRow>): InvestAccountRow => ({
  id: 1, name: 'Schwab brokerage', kind: 'brokerage', tracking: 'lots', stock_plan: 0, subtype: 'taxable', institution: 'Schwab',
  owner: 'Max', mask: '1234', sort: 0, latest_snapshot: null, counts: noCounts, ...over,
})
const accounts = [
  acct({ counts: { ...noCounts, trades: 4 } }),
  acct({ id: 2, name: 'Acme plan', subtype: 'stock_plan', stock_plan: 1, institution: 'E*TRADE', mask: null, owner: 'Nicole', counts: { ...noCounts, trades: 1, unvested: 1 } }),
  acct({ id: 3, name: 'Fidelity 401(k)', kind: 'retirement', tracking: 'balance', subtype: '401k', institution: 'Fidelity', owner: null, latest_snapshot: { balanced_on: '2026-06-30', balance_cents: 44_500_00 } }),
  acct({ id: 4, name: 'Old account', kind: 'crypto', subtype: null, institution: null, mask: null, owner: null }),
]
const positions: PortfolioPosition[] = [
  {
    asset_id: 1, symbol: 'VTI', kind: 'stock', qty_micro: 10_000_000, cost_cents: 2_000_00, price_cents: 300_00, priced_on: '2026-09-19',
    value_cents: 3_000_00, unrealized_cents: 1_000_00, lots: [],
    accounts: [{ invest_account_id: 1, name: 'Schwab brokerage', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 2_000_00, value_cents: 3_000_00 }],
  },
  {
    asset_id: 2, symbol: 'ACME', kind: 'stock', qty_micro: 5_000_000, cost_cents: 500_00, price_cents: 120_00, priced_on: '2026-09-19',
    value_cents: 600_00, unrealized_cents: 100_00, lots: [],
    accounts: [{ invest_account_id: 2, name: 'Acme plan', kind: 'brokerage', qty_micro: 5_000_000, cost_cents: 500_00, value_cents: 600_00 }],
  },
]
const strip = (over: Partial<Parameters<typeof AccountStrip>[0]> = {}) =>
  renderToStaticMarkup(
    <AccountStrip
      accounts={accounts}
      positions={positions}
      unvested={new Map([[2, 60_000_000]])}
      owners={['Max', 'Nicole']}
      today={TODAY}
      loaded
      onOpen={() => {}}
      onAdd={() => {}}
      {...over}
    />,
  )

describe('the account strip', () => {
  it('shows each account: owner, name, value, type, where, and a quiet mark on an old number', () => {
    const html = strip()
    const t = text(html)
    expect(t).toMatch(/M Schwab brokerage \$3,000\.00 Taxable Schwab ··1234 1 holding/)
    expect(t).toMatch(/N Acme plan \$600\.00 Stock plan E\*TRADE 1 holding \+ 60 unvested/)
    // Joint: both people's initials; a balance past 45 days wears the dot and says why.
    expect(t).toMatch(/M N Fidelity 401\(k\) \$44,500\.00 401\(k\) Fidelity ··1234 balance 84d old/)
    expect(t).toMatch(/Old account — Crypto no holdings yet/)
    expect(html.match(/class="inv-dot"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Fidelity 401(k): 401(k), joint, $44,500.00 — balance 84d old. Open account"')
    expect(t).toMatch(/\+ Add account/)
  })

  it('shows its shape while loading — never "add your first account" — and the empty state once it knows', () => {
    const loading = strip({ loaded: false, accounts: [] })
    expect(loading).toContain('aria-busy="true"')
    expect(text(loading)).not.toMatch(/first account/)
    expect(text(strip({ accounts: [] }))).toMatch(/Add your first account .* Add an account/)
  })
})

describe("the drawer's panels", () => {
  it('Settings: the profile, locks said up front, the type deciding the tax treatment, and Delete', () => {
    const html = renderToStaticMarkup(<AccountSettings account={accounts[1]!} owners={['Max', 'Nicole']} institutions={['Schwab']} onSaved={() => {}} onDeleted={() => {}} />)
    const t = text(html)
    expect(t).toMatch(/Name Type 401\(k\) .* Institution Optional Last 4/)
    expect(html).toMatch(/<option value="stock_plan" selected="">Stock plan<\/option>/)
    expect(html).toContain('value="Acme plan"')
    expect(t).toMatch(/Owner Max Nicole Joint Someone else…/)
    expect(t).toMatch(/Tax treatment Taxable Tax-advantaged Crypto Sales here reach the tax bill\. Set by its type\./)
    expect(t).toMatch(/It has 1 trade\. Tracking by balance would drop them/)
    expect(t).toMatch(/Employee stock plan — grants vest here Clear its unvested grants \(Grants tab\) first\./)
    expect(t).toMatch(/Delete this account .* Delete account…/)

    // An account from before types: "Not set" stands in, and its kind can change.
    const legacy = renderToStaticMarkup(<AccountSettings account={accounts[3]!} owners={[]} institutions={[]} onSaved={() => {}} onDeleted={() => {}} />)
    expect(text(legacy)).toMatch(/Not set — Crypto/)
    expect(legacy).not.toMatch(/disabled="" title="Set by the account/)
    expect(text(legacy)).toMatch(/Owner Joint One person…/)
  })

  it("Grants: each grant's count, value and schedule, with Vest…; the form when there are none", () => {
    const grant: UnvestedRow = {
      invest_account_id: 2, asset_id: 2, symbol: 'ACME', account_name: 'Acme plan', qty_micro: 60_000_000, updated_on: '2026-09-01',
      next_vest_on: '2026-10-15', vest_every_months: 3, vest_qty_micro: 15_000_000, price_cents: 120_00, priced_on: '2026-09-21', est_cents: 7_200_00,
    }
    const t = text(renderToStaticMarkup(<GrantsPanel account={accounts[1]!} grants={[grant]} onChanged={() => {}} />))
    expect(t).toMatch(/≈ \$7,200\.00 at today’s price · not counted in net worth/)
    expect(t).toMatch(/ACME updated 2026-09-01 60 \$7,200\.00 15 every 3 mo · next 2026-10-15 Vest…/)
    expect(t).toMatch(/Add another grant/)
    expect(text(renderToStaticMarkup(<GrantsPanel account={accounts[1]!} grants={[]} onChanged={() => {}} />))).toMatch(/Track an unvested grant Keep one running number per grant/)
  })
})

describe('the guided add', () => {
  it('starts from type cards, grouped, each saying how it is followed', () => {
    const html = renderToStaticMarkup(
      <AddAccountFlow open owners={['Max']} institutions={[]} today={TODAY} onClose={() => {}} onCreated={async () => {}} onNext={() => {}} />,
    )
    const t = text(html)
    expect(t).toMatch(/Add an account What kind is it\?/)
    expect(t).toMatch(/Retirement 401\(k\) Workplace plan · enter the balance from each statement 403\(b\) .* Traditional IRA .* Roth IRA .* HSA/)
    expect(t).toMatch(/Investing Brokerage Taxable · every sale shapes the tax bill Stock plan .* Crypto/)
    expect(t).toMatch(/Other Something else/)
    expect(html.match(/data-subtype=/g)).toHaveLength(9)
  })
})
