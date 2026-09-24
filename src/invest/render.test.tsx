import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PortfolioResponse } from '../../shared/invest-api'
import type { InvestAccountRow } from '../../engine/invest'
import HarvestCard from '../tax/HarvestCard'
import type { TaxResponse } from '../tax/types'
import { BalancePanel } from './BalanceAccounts'
import HoldingsTable from './HoldingsTable'
import TaxPictureCard from './TaxPictureCard'

/**
 * Node has no DOM here, so the brokerage cards are rendered to static markup:
 * enough to prove they render from the contract shapes and say the right
 * things. Interaction is checked in the browser.
 */

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')

const portfolio: PortfolioResponse = {
  positions: [
    {
      asset_id: 1, symbol: 'VTI', kind: 'stock', qty_micro: 15_000_000, cost_cents: 3_000_00, price_cents: 300_00,
      priced_on: '2026-09-19', value_cents: 4_500_00, unrealized_cents: 1_500_00,
      lots: [
        { trade_id: 1, opened_on: '2020-03-02', lt_on: '2021-03-03', qty_micro: 10_000_000, cost_cents: 1_500_00, invest_account_id: 1, account_name: 'Schwab', sheltered: false },
        { trade_id: 5, opened_on: '2026-01-05', lt_on: '2027-01-06', qty_micro: 5_000_000, cost_cents: 1_500_00, invest_account_id: 2, account_name: 'Roth IRA', sheltered: true },
      ],
      accounts: [
        { invest_account_id: 1, name: 'Schwab', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 1_500_00, value_cents: 3_000_00 },
        { invest_account_id: 2, name: 'Roth IRA', kind: 'retirement', qty_micro: 5_000_000, cost_cents: 1_500_00, value_cents: 1_500_00 },
      ],
    },
  ],
  warnings: [],
  totals: { value: 4_500_00, cost: 3_000_00, unrealized: 1_500_00, cash: 0, ytd_st: -500_00, ytd_lt: 2_000_00, ytd_sheltered: 200_00 },
  accounts: [],
}

describe('brokerage cards render from the contract', () => {
  it('holdings expand to each account, then its lots, with the shelter spelled out', () => {
    const html = renderToStaticMarkup(
      <HoldingsTable
        positions={portfolio.positions}
        totals={portfolio.totals}
        marginal={{ stMicro: 450_000, ltMicro: 250_000 }}
        today="2026-09-22"
        onSell={() => {}}
        defaultOpen={[1]}
      />,
    )
    const t = text(html)
    expect(t).toMatch(/VTI 2 accounts/)
    expect(t).toMatch(/Schwab taxable 10 \$3,000\.00/)
    expect(t).toMatch(/Roth IRA tax-advantaged 5 \$1,500\.00/)
    // Cost basis rides under the value, the percent under the gain (the header's second lines say so).
    expect(t).toMatch(/Value cost basis Unrealized % of cost/)
    expect(t).toMatch(/VTI 2 accounts 15 \$300\.00 \$4,500\.00 cost basis \$3,000\.00 ▲ \$1,500\.00 50%/)
    // Flat (value = cost) is neither up nor down: no arrow, no gain/loss colour.
    expect(t).toMatch(/Roth IRA tax-advantaged 5 \$1,500\.00 cost basis \$1,500\.00 \$0\.00 0%/)
    expect(html).toContain('▲ $1,500.00')
    expect(html).not.toContain('▲ $0.00')
    expect(t).toMatch(/lot · 2020-03-02 long-term/)
    expect(t).toMatch(/lot · 2020-03-02 long-term .* 10 \$150\.00 \/sh \$3,000\.00 cost basis \$1,500\.00 Sell…/)
    expect(t).toMatch(/lot · 2026-01-05 tax-deferred — no tax on sale/)
    expect(html.match(/Sell…/g)).toHaveLength(2)
    expect(html).toContain('aria-expanded="true"')
    // Collapsed by default.
    const closed = renderToStaticMarkup(
      <HoldingsTable positions={portfolio.positions} totals={portfolio.totals} marginal={null} today="2026-09-22" onSell={() => {}} />,
    )
    expect(closed).not.toContain('lot · ')
  })

  it('the tax picture nets short against long and keeps sheltered gains apart', () => {
    const t = text(
      renderToStaticMarkup(
        <TaxPictureCard totals={portfolio.totals} marginal={{ ordinaryMicro: 400_000, stMicro: 450_000, ltMicro: 250_000 }} year="2026" />,
      ),
    )
    expect(t).toMatch(/After netting short against long \$1,500\.00 LT/)
    expect(t).toMatch(/Est\. tax on realized gains so far \$375\.00/)
    expect(t).toMatch(/Realized inside tax-advantaged accounts — not taxed \+\$200\.00/)
    // A net loss: $3,000 offsets ordinary income, the rest carries.
    const loss = text(
      renderToStaticMarkup(
        <TaxPictureCard
          totals={{ ...portfolio.totals, ytd_st: -5_000_00, ytd_lt: 1_000_00, ytd_sheltered: 0 }}
          marginal={{ ordinaryMicro: 400_000, stMicro: 450_000, ltMicro: 250_000 }}
          year="2026"
        />,
      ),
    )
    expect(loss).toMatch(/\$3,000\.00 offsets ordinary income this year, \$1,000\.00 carries forward/)
    expect(loss).toMatch(/Est\. tax saved by realized losses so far \$1,200\.00/)
    expect(loss).not.toMatch(/tax-advantaged/)
  })

  it('harvest shows the account and an upcoming vest; empty, it hugs the top', () => {
    const row = {
      symbol: 'ACME', account: 'Stock plan', account_id: 1, trade_id: 3, opened_on: '2026-03-02', lt_on: '2027-03-03',
      qty_micro: 20_000_000, cost_cents: 10_000_00, value_cents: 8_000_00, gain_cents: -2_000_00, term: 'st' as const,
      days_to_lt: 162, wash_risk: false, wash_upcoming: { vest_on: '2026-10-15', qty_micro: 15_000_000, account: 'Stock plan', account_id: 1 },
      tax_delta_cents: -900_00, after_tax_cents: 8_000_00,
    }
    const harvest: TaxResponse['harvest'] = {
      rows: [row],
      totals: { harvestableStCents: -2_000_00, harvestableLtCents: 0, estTaxSavedCents: 900_00, washFlagged: 1 },
    }
    const t = text(renderToStaticMarkup(<HarvestCard harvest={harvest} marginal={{ stMicro: 450_000, ltMicro: 250_000 }} />))
    // The lot's date and account ride under its symbol, its term under the loss (so the table fits a half-width card).
    expect(t).toMatch(/Lot Qty Value Loss Tax saved/)
    // The ⚠ carries its reason (the Tooltip keeps it in the markup as the glyph's description).
    expect(t).toMatch(/ACME ⚠ 15 shares vest in Stock plan on 2026-10-15\..* 2026-03-02 · Stock plan 20 \$8,000\.00 -\$2,000\.00 short-term \$900\.00/)
    expect(t).toMatch(/Vest coming up: ACME vests 2026-10-15 in Stock plan/)
    const empty = renderToStaticMarkup(
      <HarvestCard harvest={{ rows: [], totals: { harvestableStCents: 0, harvestableLtCents: 0, estTaxSavedCents: 0, washFlagged: 0 } }} marginal={{ stMicro: 1, ltMicro: 1 }} />,
    )
    expect(empty).toContain('align-self:start')
  })

  it('price cells offer a hand-set price when there is none, when it is stale, and label manual prices', () => {
    const base = portfolio.positions[0]!
    const positions = [
      { ...base, asset_id: 1, symbol: 'VTI', price_cents: 300_00, priced_on: '2026-09-19' },
      { ...base, asset_id: 2, symbol: 'FXAIX', price_cents: 215_37, priced_on: '2026-09-20', price_manual: true },
      { ...base, asset_id: 3, symbol: 'CIT', price_cents: 12_00, priced_on: '2026-08-01' },
      { ...base, asset_id: 4, symbol: 'ACME', price_cents: null, priced_on: null },
    ]
    const t = text(
      renderToStaticMarkup(
        <HoldingsTable positions={positions} totals={portfolio.totals} marginal={null} today="2026-09-22" onSell={() => {}} onPriceSaved={() => {}} />,
      ),
    )
    expect(t).toMatch(/VTI 2 accounts 15 \$300\.00 /) // fresh market price: nothing to set
    // The tag's tooltip text rides in the markup as its description.
    expect(t).toMatch(/FXAIX 2 accounts 15 manual · Sep 20 Entered by hand for 2026-09-20 — click to update it \$215\.37/)
    expect(t).toMatch(/CIT 2 accounts 15 stale · Aug 1 No quote since 2026-08-01 — click to set a price by hand \$12\.00/)
    expect(t).toMatch(/ACME 2 accounts 15 Set price/)
    // Without the callback the cells stay read-only.
    const readOnly = text(renderToStaticMarkup(<HoldingsTable positions={positions} totals={portfolio.totals} marginal={null} today="2026-09-22" onSell={() => {}} />))
    expect(readOnly).not.toMatch(/Set price|manual ·/)
    expect(readOnly).toMatch(/no price yet/)
  })

  it("a balance account's history lists every recorded balance, newest first, and says when there is none", () => {
    const acct: InvestAccountRow = {
      id: 3, name: 'Fidelity 401(k)', kind: 'retirement', tracking: 'balance', stock_plan: 0,
      latest_snapshot: { balanced_on: '2026-06-30', balance_cents: 44_500_00 },
      subtype: '401k', institution: 'Fidelity', owner: 'Nicole', mask: '1234', sort: 0,
      counts: { trades: 0, balances: 2, unvested: 0, paychecks: 0 },
    }
    const html = renderToStaticMarkup(
      <BalancePanel
        account={acct}
        snapshots={[
          { invest_account_id: 3, balanced_on: '2026-06-30', balance_cents: 44_500_00 },
          { invest_account_id: 3, balanced_on: '2026-03-31', balance_cents: 42_000_00 },
        ]}
        today="2026-09-22"
        onChanged={() => {}}
      />,
    )
    const t = text(html)
    expect(t).toMatch(/2 balances · net worth uses the latest on or before each month’s end · stale after 45 days Backfill statements…/)
    expect(t.indexOf('2026-06-30')).toBeLessThan(t.indexOf('2026-03-31'))
    expect(html).toContain('value="44,500.00"')
    expect(html.match(/>Delete</g)).toHaveLength(2)
    const empty = text(renderToStaticMarkup(<BalancePanel account={{ ...acct, latest_snapshot: null }} snapshots={[]} today="2026-09-22" onChanged={() => {}} />))
    expect(empty).toMatch(/No balance yet .*Backfill statements…/)
  })
})
