import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { lotCostShare } from '../../engine/lots'
import type { InvestAccountRow, PortfolioAccount, PortfolioPosition, PortfolioResponse, TradeRow, UnvestedRow } from '../../shared/invest-api'
import { accountValueCents } from './accountTypes'
import { ActivityRow } from './ActivityTable'
import CashPanel from './CashPanel'
import { cashView, portfolioCash } from './cashMath'
import { grantEditBody } from './GrantsPanel'
import HoldingsTable from './HoldingsTable'
import { VestSummary } from './VestDialog'
import { fmvPrefill, vestBody, vestDateDefault, vestPlan, withheldValueCents, type VestForm } from './vestMath'

/**
 * The cash anchor (B12) and the vest flow (B9) as the screens word them:
 * the pure helpers, and static renders of the pieces (node has no DOM).
 * Typing and dialogs are checked in the browser.
 */

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const TODAY = '2026-09-22'
const noCounts = { trades: 0, balances: 0, unvested: 0, paychecks: 0 }
const account: InvestAccountRow = {
  id: 1, name: 'Schwab', kind: 'brokerage', tracking: 'lots', stock_plan: 0, subtype: 'taxable', institution: null,
  owner: null, mask: null, sort: 0, latest_snapshot: null, counts: noCounts,
}
const row = (over: Partial<PortfolioAccount> = {}): PortfolioAccount => ({
  invest_account_id: 1, name: 'Schwab', kind: 'brokerage', value_cents: 900_00,
  cash_cents: 1_100_00, cash_as_of: '2026-08-31', cash_anchor_cents: 500_00, cash_trades: 1, uncounted_proceeds_cents: 0, ...over,
})
const unset = row({ cash_cents: null, cash_as_of: null, cash_anchor_cents: null, cash_trades: 0, uncounted_proceeds_cents: 600_00 })

describe('cash, as the screens say it (B12)', () => {
  it('reads the derived cash: where it comes from, and when trades took it below $0', () => {
    expect(cashView(row(), TODAY)).toEqual({ state: 'set', cents: 1_100_00, line: 'from $500.00 on Aug 31 · 1 trade since', short: false })
    expect(cashView(row({ cash_cents: -40_00, cash_trades: 2 }), TODAY)).toMatchObject({ short: true, line: 'from $500.00 on Aug 31 · 2 trades since' })
    expect(cashView(row({ cash_cents: -900_00, cash_anchor_cents: -900_00, cash_trades: 0 }), TODAY)).toMatchObject({ short: false, line: 'from -$900.00 on Aug 31' })
    expect(cashView(unset, TODAY)).toEqual({ state: 'none', uncountedCents: 600_00 })
    expect(cashView(null, TODAY)).toBeNull()
    expect(portfolioCash([row(), unset, row({ invest_account_id: 2, cash_cents: -100_00 })])).toEqual({ cents: 1_000_00, accounts: 2 })
    expect(portfolioCash([unset])).toBeNull()
  })

  it("a lots account's tile value is its holdings plus its cash — or its cash alone once everything is sold", () => {
    const positions = [
      { accounts: [{ invest_account_id: 1, value_cents: 900_00 }] },
    ] as unknown as PortfolioPosition[]
    expect(accountValueCents(account, positions)).toBe(900_00)
    expect(accountValueCents(account, positions, row())).toBe(2_000_00)
    expect(accountValueCents(account, [], row())).toBe(1_100_00)
    expect(accountValueCents(account, [], unset)).toBeNull()
  })

  it('the cash panel says what cash is, or how much of the sales goes uncounted', () => {
    const set = text(renderToStaticMarkup(<CashPanel account={account} cash={row()} anchors={[{ invest_account_id: 1, balanced_on: '2026-08-31', balance_cents: 500_00 }]} today={TODAY} onChanged={() => {}} />))
    expect(set).toMatch(/Cash \$1,100\.00 · from \$500\.00 on Aug 31 · 1 trade since/)
    expect(set).toMatch(/History \(1\) Update cash/)
    const none = text(renderToStaticMarkup(<CashPanel account={account} cash={unset} anchors={[]} today={TODAY} onChanged={() => {}} />))
    expect(none).toMatch(/\$600\.00 from sales isn’t counted in net worth\. Record this account’s cash balance/)
    expect(none).toMatch(/Set cash balance/)
    expect(none).not.toMatch(/History/)
    const short = text(renderToStaticMarkup(<CashPanel account={account} cash={row({ cash_cents: -40_00 })} anchors={[]} today={TODAY} onChanged={() => {}} />))
    expect(short).toMatch(/below \$0: a deposit Scarab doesn’t know about\?/)
  })

  it('holdings get a Cash row, and the Total includes it (cost and unrealized stay the holdings’)', () => {
    const totals: PortfolioResponse['totals'] = { value: 900_00, cost: 600_00, unrealized: 300_00, cash: 1_100_00, ytd_st: 0, ytd_lt: 0, ytd_sheltered: 0 }
    const html = renderToStaticMarkup(
      <HoldingsTable positions={[]} totals={totals} marginal={null} today={TODAY} onSell={() => {}} cash={{ cents: 1_100_00, note: 'in 1 account' }} />,
    )
    // Cash has no cost basis: nothing under its value. The Total's cost and percent are the holdings'.
    expect(text(html)).toMatch(/Cash in 1 account \$1,100\.00 Total \$2,000\.00 cost basis \$600\.00 \+\$300\.00 50%/)
    expect(text(renderToStaticMarkup(<HoldingsTable positions={[]} totals={totals} marginal={null} today={TODAY} onSell={() => {}} />))).toMatch(/Total \$900\.00/)
  })
})

describe('the vest flow (B9)', () => {
  const form = (over: Partial<VestForm> = {}): VestForm => ({
    date: '2026-08-15', grossMicro: 25_000_000, mode: 'price', priceCents: 400_00, totalCents: null, withheldMicro: 9_000_000, ...over,
  })

  it('gross, withheld, net: the withheld value is exactly what the engine prices the sale at', () => {
    expect(vestPlan(form(), TODAY)).toEqual({
      plan: { totalCents: 10_000_00, priceCents: 400_00, withheldMicro: 9_000_000, withheldCents: 3_600_00, netMicro: 16_000_000, netCostCents: 6_400_00 },
    })
    expect(vestPlan(form({ mode: 'total', totalCents: 10_012_34, priceCents: null }), TODAY)).toMatchObject({ plan: { totalCents: 10_012_34, priceCents: 400_49 } })
    expect(vestPlan(form({ withheldMicro: null }), TODAY)).toMatchObject({ plan: { withheldMicro: 0, withheldCents: 0, netMicro: 25_000_000 } })
    let seed = 11
    const rnd = (n: number) => (seed = (seed * 48_271) % 2_147_483_647) % n
    for (let i = 0; i < 500; i++) {
      const gross = 1 + rnd(500_000_000)
      const withheld = rnd(gross + 1)
      const total = 1 + rnd(5_000_000_00)
      expect(withheldValueCents(total, withheld, gross)).toBe(lotCostShare(total, withheld, gross))
    }
  })

  it('stays quiet while incomplete, and names what to fix', () => {
    expect(vestPlan(form({ priceCents: null }), TODAY)).toEqual({ error: null })
    expect(vestPlan(form({ grossMicro: null }), TODAY)).toEqual({ error: null })
    expect(vestPlan(form({ date: '2026-09-23' }), TODAY)).toEqual({ error: expect.stringMatching(/once it has happened/) })
    expect(vestPlan(form({ withheldMicro: 26_000_000 }), TODAY)).toEqual({ error: expect.stringMatching(/More shares withheld than vested/) })
    expect(vestPlan(form({ mode: 'total', totalCents: 0 }), TODAY)).toEqual({ error: expect.stringMatching(/more than \$0/) })
  })

  it('the request, and the FMV prefill only from a close dated the vest day', () => {
    const p = vestPlan(form(), TODAY)
    if (!('plan' in p)) throw new Error('expected a plan')
    expect(vestBody({ accountId: 2, symbol: 'ACME', date: '2026-08-15', grossMicro: 25_000_000, plan: p.plan, allowUntracked: false })).toEqual({
      investAccountId: 2, symbol: 'ACME', qty: '25', tradedOn: '2026-08-15', totalCents: 10_000_00, withheldQty: '9',
    })
    const basket = { cents: 401_00, pricedOn: '2026-08-14' }
    const stored = { cents: 399_00, pricedOn: '2026-08-15' }
    expect(fmvPrefill('2026-08-15', [basket, stored])).toEqual(stored)
    expect(fmvPrefill('2026-08-14', [basket, stored])).toEqual(basket)
    expect(fmvPrefill('2026-08-13', [basket, stored, null])).toBeNull()
    expect(vestDateDefault('2026-08-15', TODAY)).toBe('2026-08-15')
    expect(vestDateDefault('2026-11-15', TODAY)).toBe(TODAY)
    expect(vestDateDefault(null, TODAY)).toBe(TODAY)
  })

  it('the summary says income, what was withheld (a $0 sale, not cash), and what stays', () => {
    const grant: UnvestedRow = {
      invest_account_id: 2, asset_id: 4, symbol: 'ACME', account_name: 'Acme plan', qty_micro: 100_000_000, updated_on: '2026-08-01',
      next_vest_on: '2026-08-15', vest_every_months: 3, vest_qty_micro: 25_000_000, price_cents: 400_00, priced_on: '2026-08-15', est_cents: 40_000_00,
    }
    const p = vestPlan(form(), TODAY)
    if (!('plan' in p)) throw new Error('expected a plan')
    const t = text(renderToStaticMarkup(<VestSummary plan={p.plan} complaint={null} grant={grant} grossMicro={25_000_000} />))
    expect(t).toMatch(/Income on Taxes \$10,000\.00 25 × \$400\.00 the shares’ cost basis/)
    expect(t).toMatch(/Withheld for tax · 9 shares \$3,600\.00 a same-day sale at cost: \$0 gain, and not cash in the account/)
    expect(t).toMatch(/Kept in Acme plan · 16 shares \$6,400\.00 basis of what stays 75 still unvested after/)
    expect(text(renderToStaticMarkup(<VestSummary plan={null} complaint="More shares withheld than vested — check the release." grant={grant} grossMicro={25_000_000} />))).toMatch(/More shares withheld/)
  })

  it('Edit grant sends the count and the schedule — kept, changed or cleared', () => {
    const u: UnvestedRow = {
      invest_account_id: 2, asset_id: 4, symbol: 'ACME', account_name: 'Acme plan', qty_micro: 100_000_000, updated_on: '2026-08-01',
      next_vest_on: '2026-11-15', vest_every_months: 3, vest_qty_micro: 25_000_000, price_cents: null, priced_on: null, est_cents: null,
    }
    expect(grantEditBody(u, { qtyMicro: 90_000_000, vestQtyMicro: 30_000_000, vestEveryMonths: '6', nextVestOn: '2027-02-15' })).toEqual({
      body: { investAccountId: 2, symbol: 'ACME', qty: '90', nextVestOn: '2027-02-15', vestEveryMonths: 6, vestQty: '30' },
    })
    expect(grantEditBody(u, { qtyMicro: 90_000_000, vestQtyMicro: null, vestEveryMonths: '3', nextVestOn: '' })).toEqual({
      body: { investAccountId: 2, symbol: 'ACME', qty: '90', nextVestOn: '' },
    })
    const bare = { ...u, next_vest_on: null, vest_every_months: null, vest_qty_micro: null }
    expect(grantEditBody(bare, { qtyMicro: 5_000_000, vestQtyMicro: null, vestEveryMonths: '3', nextVestOn: '' })).toEqual({ body: { investAccountId: 2, symbol: 'ACME', qty: '5' } })
    expect(grantEditBody(u, { qtyMicro: null, vestQtyMicro: null, vestEveryMonths: '3', nextVestOn: '' })).toEqual({ error: expect.stringMatching(/Clear grant/) })
    expect(grantEditBody(u, { qtyMicro: 5_000_000, vestQtyMicro: 1_000_000, vestEveryMonths: '3', nextVestOn: '' })).toEqual({ error: expect.stringMatching(/or neither/) })
  })

  it('the ledger tags a vest with what was withheld, and the withholding as tax paid', () => {
    const base = { invest_account_id: 2, account_name: 'Acme plan', asset_id: 4, symbol: 'ACME', acquired_on: null, basis_cents: null }
    const vest: TradeRow = { ...base, id: 10, traded_on: '2026-08-15', side: 'buy', qty_micro: 25_000_000, total_cents: 10_000_00, note: 'RSU vest', sold_lot_trade_id: null, dependents: 0, withheld_qty_micro: 9_000_000 }
    const wh: TradeRow = { ...base, id: 11, traded_on: '2026-08-15', side: 'sell', qty_micro: 9_000_000, total_cents: 3_600_00, note: 'RSU withholding', sold_lot_trade_id: 10, realized: { st_cents: 0, lt_cents: 0, zero_basis_cents: 0 } }
    const r = (t: TradeRow) =>
      text(renderToStaticMarkup(<table><tbody><ActivityRow r={t} today={TODAY} showAccount={false} sheltered={false} lotDate="2026-08-15" locked={false} onEdit={() => {}} onDelete={() => {}} /></tbody></table>))
    expect(r(vest)).toMatch(/Buy ACME vest 9 withheld for tax · 16 kept 25 \$400\.00 \$10,000\.00/)
    const w = r(wh)
    expect(w).toMatch(/Sell ACME withheld for tax at the vest’s value · paid its tax, not cash 9 \$400\.00 \$3,600\.00 \$0\.00/)
    expect(w).not.toMatch(/chosen lot/)
    // $0 is neither a gain nor a loss: no up/down colour on it.
    const html = renderToStaticMarkup(<table><tbody><ActivityRow r={wh} today={TODAY} showAccount={false} sheltered={false} lotDate="2026-08-15" locked={false} onEdit={() => {}} onDelete={() => {}} /></tbody></table>)
    expect(html).not.toMatch(/class="(pos|neg)"/)
    const gain = renderToStaticMarkup(<table><tbody><ActivityRow r={{ ...wh, note: null, realized: { st_cents: 12_00, lt_cents: 0 } }} today={TODAY} showAccount={false} sheltered={false} lotDate={undefined} locked={false} onEdit={() => {}} onDelete={() => {}} /></tbody></table>)
    expect(gain).toMatch(/class="pos"/)
  })
})
