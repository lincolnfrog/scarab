import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TradePreview, TradeRow } from '../../shared/invest-api'
import { ActivityRow } from './ActivityTable'
import { PreviewPane } from './TradeSheet'

/**
 * The record-trade preview and the activity ledger's rows, rendered to static
 * markup (node has no DOM): they say the right things from the contract
 * shapes. Typing, Enter / ⌘Enter and inline editing are checked in the browser.
 */

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const TODAY = '2026-09-22'
const noWash: TradePreview['washSale'] = { risk: false, buys: [], upcomingVest: null, lossSales: [] }
const pv = (over: Partial<TradePreview> = {}): TradePreview => ({
  side: 'sell',
  account: 'Schwab',
  sheltered: false,
  realized: { stCents: 0, ltCents: 0 },
  parts: [],
  zeroBasisCents: 0,
  estTaxCents: 0,
  taxYear: 2026,
  warnings: [],
  washSale: noWash,
  affectedSales: 0,
  ...over,
})
const pane = (preview: TradePreview, side: 'buy' | 'sell' = preview.side) =>
  text(renderToStaticMarkup(<PreviewPane state={{ state: 'ok', preview }} side={side} today={TODAY} complaint={null} />))

describe('the trade preview says what recording would do', () => {
  it('a loss sale: the lots it takes, the tax it saves, and every wash-sale trap — an IRA buy loses the loss for good', () => {
    const t = pane(
      pv({
        realized: { stCents: -1_000_00, ltCents: 0 },
        parts: [{ lot_trade_id: 1, opened_on: '2026-02-02', qty_micro: 10_000_000, cost_cents: 5_000_00, proceeds_cents: 4_000_00, term: 'st' }],
        estTaxCents: -450_00,
        washSale: {
          risk: true,
          buys: [
            { trade_id: 2, account: 'Roth IRA', account_id: 3, acquired_on: '2026-09-10', qty_micro: 1_000_000, note: null, sheltered: true },
            { trade_id: 3, account: 'Schwab', account_id: 1, acquired_on: '2026-09-15', qty_micro: 2_000_000, note: 'Opening position', sheltered: false },
          ],
          upcomingVest: { vest_on: '2026-10-15', qty_micro: 25_000_000, account: 'Stock plan', account_id: 4 },
          lossSales: [],
        },
      }),
    )
    expect(t).toMatch(/Realized gain -\$1,000\.00 short-term -\$1,000\.00/)
    expect(t).toMatch(/lot · 2026-02-02 · 10 sh · short-term -\$1,000\.00/)
    expect(t).toMatch(/Estimated tax saves ≈ \$450\.00/)
    expect(t).toMatch(/2 buys of this stock within 30 days — Roth IRA Sep 10 \(1 sh\), Schwab Sep 15 \(2 sh, a starting position\)\./)
    expect(t).toMatch(/lost for good/)
    expect(t).toMatch(/A vest of 25 sh into Stock plan is scheduled for Oct 15/)
    // Only taxable replacement buys: the loss moves into their basis.
    const taxable = pane(
      pv({
        realized: { stCents: -100_00, ltCents: 0 },
        estTaxCents: -30_00,
        washSale: { risk: true, buys: [{ trade_id: 3, account: 'Schwab', account_id: 1, acquired_on: '2026-09-15', qty_micro: 2_000_000, note: 'RSU vest', sheltered: false }], upcomingVest: null, lossSales: [] },
      }),
    )
    expect(taxable).toMatch(/Schwab Sep 15 \(2 sh, a vest\)\. The \$100\.00 loss may be disallowed and added to those shares’ basis instead\./)
    expect(taxable).not.toMatch(/lost for good/)
  })

  it('a sale in a tax-advantaged account owes nothing; an earlier tax year is not estimated; no change in tax says so', () => {
    expect(pane(pv({ sheltered: true, account: 'Roth IRA', realized: { stCents: 0, ltCents: 900_00 } }))).toMatch(
      /Estimated tax none — Roth IRA is tax-advantaged/,
    )
    expect(pane(pv({ estTaxCents: null, taxYear: 2025, realized: { stCents: 50_00, ltCents: 0 } }))).toMatch(/falls in the 2025 tax year — not estimated here/)
    const flat = pane(pv({ realized: { stCents: -1_000_00, ltCents: 0 }, estTaxCents: 0 }))
    // No change still says why: netted with the year so far, at the Taxes settings.
    expect(flat).toMatch(/Estimated tax no change to this year’s tax On your 2026 return, netted/)
    expect(pane(pv({ realized: { stCents: 0, ltCents: 2_000_00 }, estTaxCents: 300_00 }))).toMatch(/Estimated tax ≈ \$300\.00 On your 2026 return/)
  })

  it('a buy near a taxable loss sale warns that it could disallow it; otherwise it says there is no trap', () => {
    const buy = pv({ side: 'buy', washSale: { risk: true, buys: [], upcomingVest: null, lossSales: [{ trade_id: 9, account: 'Schwab', account_id: 1, traded_on: '2026-09-10', loss_cents: 500_00 }] } })
    const t = pane(buy)
    expect(t).toMatch(/Wash-sale risk Sold at a \$500\.00 loss in Schwab on Sep 10 — buying within 30 days of that sale may disallow the loss\./)
    expect(t).not.toMatch(/Realized gain/)
    expect(pane(pv({ side: 'buy' }))).toMatch(/No wash-sale trap/)
  })

  it('warnings and a form complaint are spelled out; nothing to preview yet asks for the rest', () => {
    expect(pane(pv({ warnings: ['Schwab holds only 10 VTI on 2026-09-22 — 2 shares have no recorded basis'] }))).toMatch(/⚠?.*holds only 10 VTI/)
    const complaint = text(renderToStaticMarkup(<PreviewPane state={{ state: 'idle' }} side="sell" today={TODAY} complaint="The fees are more than the sale brought in." />))
    expect(complaint).toMatch(/The fees are more than the sale brought in\./)
    const idle = text(renderToStaticMarkup(<PreviewPane state={{ state: 'idle' }} side="sell" today={TODAY} complaint={null} />))
    expect(idle).toMatch(/Fill in the symbol, shares and price to see the gain/)
    const failed = text(renderToStaticMarkup(<PreviewPane state={{ state: 'error', message: 'that lot belongs to a different account' }} side="sell" today={TODAY} complaint={null} />))
    expect(failed).toMatch(/that lot belongs to a different account/)
  })
})

describe('activity rows', () => {
  const row = (over: Partial<TradeRow>): TradeRow => ({
    id: 1, traded_on: '2026-09-01', side: 'buy', qty_micro: 10_000_000, total_cents: 1_000_00, asset_id: 1, symbol: 'VTI',
    invest_account_id: 1, account_name: 'Schwab', note: null, acquired_on: null, sold_lot_trade_id: null, basis_cents: null, ...over,
  })
  const render = (r: TradeRow, o: { sheltered?: boolean; lotDate?: string; showAccount?: boolean } = {}) =>
    text(
      renderToStaticMarkup(
        <table>
          <tbody>
            <ActivityRow
              r={r}
              today={TODAY}
              showAccount={o.showAccount ?? true}
              sheltered={o.sheltered ?? false}
              lotDate={o.lotDate}
              locked={false}
              onEdit={() => {}}
              onDelete={() => {}}
            />
          </tbody>
        </table>,
      ),
    )

  it('a sale shows its realized gain by term, its chosen lot, and proceeds no lot covered', () => {
    const t = render(row({ id: 5, side: 'sell', qty_micro: 4_000_000, total_cents: 800_00, sold_lot_trade_id: 1, realized: { st_cents: 150_00, lt_cents: 400_00, zero_basis_cents: 150_00 } }), { lotDate: '2024-03-04' })
    expect(t).toMatch(/Sep 1 Schwab Sell VTI chosen lot · Mar 4, 2024 4 \$200\.00 \$800\.00 \+\$550\.00 long-term · short-term/)
    expect(t).toMatch(/no basis \$150\.00/)
  })

  it('a sale with an entered basis, a sale in an IRA, a starting position and a vest', () => {
    expect(render(row({ side: 'sell', basis_cents: 300_00, acquired_on: '2019-05-01', realized: { st_cents: 0, lt_cents: 700_00, zero_basis_cents: 0 } }))).toMatch(
      /entered basis \$300\.00 · acquired May 1, 2019/,
    )
    expect(render(row({ side: 'sell', realized: { st_cents: -50_00, lt_cents: 0, zero_basis_cents: 0 } }), { sheltered: true })).toMatch(/-\$50\.00 tax-deferred/)
    const opening = render(row({ note: 'Opening position', acquired_on: '2019-03-15' }), { showAccount: false })
    expect(opening).toMatch(/^ ?Sep 1 acquired Mar 15, 2019 Buy VTI starting position 10 \$100\.00 \$1,000\.00 — /)
    expect(render(row({ note: 'RSU vest' }))).toMatch(/Buy VTI vest/)
  })
})
