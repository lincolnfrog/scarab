import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CheckinItem, PortfolioResponse, RealizedReport } from '../../shared/invest-api'
import { RealizedBody } from '../tax/RealizedCard'
import { CheckinRow } from './CheckinDrawer'
import OwnerPills from './OwnerPills'
import { SymbolInput } from './SymbolInput'
import TaxPictureCard from './TaxPictureCard'

/**
 * B10 · B11 · B13 · B14 pieces rendered to static markup (node has no DOM):
 * the symbol combobox's wiring, a check-in row, the owner pills and the
 * realized-gains report say the right things. Typing and clicking are
 * checked in the browser.
 */

const text = (html: string) =>
  html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/\s+/g, ' ')
const TODAY = '2026-09-22'

describe('the symbol box (B10)', () => {
  it('is a combobox wired to its (closed) suggestion list', () => {
    const html = renderToStaticMarkup(<SymbolInput value="vt" onChange={() => {}} recorded={[]} market={null} placeholder="VTI or a name" />)
    expect(html).toMatch(/role="combobox"/)
    expect(html).toMatch(/aria-autocomplete="list"/)
    expect(html).toMatch(/aria-expanded="false"/)
    const list = /<ul id="([^"]+)" role="listbox"[^>]*hidden/.exec(html)
    expect(list).not.toBeNull()
    expect(html).toContain(`aria-controls="${list![1]}"`)
    expect(html).toMatch(/autoComplete="off"|autocomplete="off"/)
    expect(html).toContain('value="vt"')
  })
})

describe('a check-in row (B11)', () => {
  const item = (over: Partial<CheckinItem>): CheckinItem => ({
    kind: 'balance', id: 3, name: 'Fidelity 401(k)', detail: 'Fidelity ··1234', owner: 'Nicole', last: { on: '2026-06-30', cents: 44_500_00 }, derived_cents: null, uncounted_cents: 0, ...over,
  })
  const row = (i: CheckinItem, draft?: { cents: number | null; on: string | null }) =>
    text(renderToStaticMarkup(<ul><CheckinRow item={i} draft={draft} asOf={TODAY} today={TODAY} owners={['Max', 'Nicole']} error={null} onChange={() => {}} /></ul>))

  it('a balance: the last one, how old it is, a box and "Unchanged"', () => {
    const t = row(item({}))
    expect(t).toContain('Fidelity 401(k)')
    expect(t).toContain('Fidelity ··1234')
    expect(t).toContain('$44,500.00 on Jun 30')
    expect(t).toContain('stale · 84d')
    expect(t).toContain('Unchanged')
    const html = renderToStaticMarkup(<ul><CheckinRow item={item({})} draft={undefined} asOf={TODAY} today={TODAY} owners={[]} error={null} onChange={() => {}} /></ul>)
    expect(html).toContain('aria-label="Fidelity 401(k) balance"')
    expect(html).toContain('placeholder="—"')
  })

  it('cash: what the trades since make it today; with none recorded, what goes uncounted', () => {
    expect(row(item({ kind: 'cash', name: 'Schwab', last: { on: '2026-08-31', cents: 2_000_00 }, derived_cents: 3_100_00 }))).toContain('With the trades since: $3,100.00 today')
    expect(row(item({ kind: 'cash', name: 'Schwab', last: null, uncounted_cents: 960_00 }))).toContain('No cash balance yet — $960.00 of sales isn’t counted in net worth')
  })

  it('a loan names its property; nothing recorded says so; a failed save shows why', () => {
    expect(row(item({ kind: 'liability', name: 'Mortgage', detail: 'House', owner: null, last: null }))).toMatch(/Mortgage on House No balance owed yet/)
    const t = text(renderToStaticMarkup(<ul><CheckinRow item={item({ kind: 'property', name: 'House', detail: null })} draft={{ cents: 900_000_00, on: '2026-09-01' }} asOf={TODAY} today={TODAY} owners={[]} error="no such property" onChange={() => {}} /></ul>))
    expect(t).toContain('no such property')
    expect(t).not.toContain('stale') // only balances go stale here
  })
})

describe('the owner pills (B13)', () => {
  it('one radio per group with its subtotal in whole dollars; nothing with no groups', () => {
    const html = renderToStaticMarkup(
      <OwnerPills
        groups={[
          { key: 'all', label: 'Household', cents: 62_000_40, accounts: 4 },
          { key: 'p:max', label: 'Max', cents: 6_000_00, accounts: 2 },
          { key: 'joint', label: 'Joint', cents: 6_000_40, accounts: 1 },
        ]}
        value="p:max"
        onChange={() => {}}
      />,
    )
    expect(html).toMatch(/role="radiogroup" aria-label="Whose accounts"/)
    expect(text(html)).toContain('Household $62,000 , 4 accounts Max $6,000 , 2 accounts Joint $6,000 , 1 account')
    expect((html.match(/role="radio"/g) ?? []).length).toBe(3)
    expect(text(html.slice(html.indexOf('aria-checked="true"')))).toMatch(/^[^<]*Max \$6,000/)
    expect(renderToStaticMarkup(<OwnerPills groups={[]} value="all" onChange={() => {}} />)).toBe('')
  })

  it('the tax picture says it is still the household’s when narrowed', () => {
    const totals: PortfolioResponse['totals'] = { value: 1, cost: 1, unrealized: 0, cash: 0, ytd_st: 0, ytd_lt: 0, ytd_sheltered: 0 }
    expect(text(renderToStaticMarkup(<TaxPictureCard totals={totals} marginal={null} year="2026" scope="Max’s accounts" />))).toContain(
      'The whole household’s, not only Max’s accounts',
    )
    expect(text(renderToStaticMarkup(<TaxPictureCard totals={totals} marginal={null} year="2026" />))).not.toContain('not only')
  })
})

describe('the realized-gains report (B14)', () => {
  const report: RealizedReport = {
    year: 2026,
    years: [2026, 2025],
    lines: [
      { sale_trade_id: 3, account: 'Schwab', account_id: 1, symbol: 'VTI', qty_micro: 10_000_000, acquired_on: '2024-01-10', sold_on: '2026-06-01', proceeds_cents: 3_200_00, cost_cents: 1_000_00, gain_cents: 2_200_00, term: 'lt', basis: 'lot', note: null, wash_risk: false },
      { sale_trade_id: 4, account: 'Schwab', account_id: 1, symbol: 'QQQ', qty_micro: 3_000_000, acquired_on: null, sold_on: '2026-07-01', proceeds_cents: 900_00, cost_cents: 0, gain_cents: 900_00, term: 'st', basis: 'none', note: null, wash_risk: false },
      { sale_trade_id: 5, account: 'Schwab', account_id: 1, symbol: 'ACME', qty_micro: 4_000_000, acquired_on: '2026-08-15', sold_on: '2026-08-15', proceeds_cents: 1_600_00, cost_cents: 1_500_00, gain_cents: 100_00, term: 'st', basis: 'lot', note: 'RSU withholding', wash_risk: false },
      { sale_trade_id: 6, account: 'Schwab', account_id: 1, symbol: 'ARKK', qty_micro: 5_000_000, acquired_on: '2026-02-01', sold_on: '2026-09-01', proceeds_cents: 200_00, cost_cents: 1_400_00, gain_cents: -1_200_00, term: 'st', basis: 'lot', note: null, wash_risk: true },
    ],
    st: { proceeds_cents: 2_700_00, cost_cents: 2_900_00, gain_cents: -200_00, lines: 3 },
    lt: { proceeds_cents: 3_200_00, cost_cents: 1_000_00, gain_cents: 2_200_00, lines: 1 },
    netted: { netStCents: 0, netLtCents: 1_900_00, capLossUsedCents: 0, capLossCarryCents: 0 },
    sheltered: { sales: 2, gain_cents: 600_00 },
    withheld: { sales: 2, cents: 2_468_00 },
    flags: { no_basis: 1, wash_risk: 1 },
  }

  it('totals by part, the netting, what to check, and each line', () => {
    const t = text(renderToStaticMarkup(<RealizedBody r={report} all onAll={() => {}} />))
    expect(t).toContain('Short-term Part I · 3 lines $2,700.00 $2,900.00 -$200.00')
    expect(t).toContain('Long-term Part II · 1 line $3,200.00 $1,000.00 +$2,200.00')
    expect(t).toContain('10 sh · Schwab · acquired 2024-01-10 · long-term +$2,200.00 of $3,200.00')
    expect(t).toContain('After netting: $0.00 short-term, $1,900.00 long-term.')
    expect(t).toContain('Sales inside tax-advantaged accounts (2) aren’t reported.')
    expect(t).toContain('1 line has shares with no recorded basis')
    expect(t).toContain('1 loss with a buy of the same stock within 30 days')
    expect(t).toContain('no basis')
    // A withholding line only shows when edited off cost; net-settled vests are counted, never listed.
    expect(t).toContain('withheld for tax')
    expect(t).toContain('Shares withheld at 2 vests to pay the tax ($2,468.00) weren’t sold by you, so they aren’t listed.')
    expect(t).toContain('wash?')
    expect(t).toContain('take the box (A–F) and any adjustments from there')
  })

  it('a net loss says what offsets income and what carries; a year with no sales says so', () => {
    const loss = { ...report, netted: { netStCents: 0, netLtCents: 0, capLossUsedCents: 3_000_00, capLossCarryCents: 1_250_00 } }
    expect(text(renderToStaticMarkup(<RealizedBody r={loss} all onAll={() => {}} />))).toContain('Net capital loss $4,250.00: $3,000.00 offsets ordinary income, $1,250.00 carries forward.')
    const none = { ...report, lines: [], flags: { no_basis: 0, wash_risk: 0 } }
    expect(text(renderToStaticMarkup(<RealizedBody r={none} all onAll={() => {}} />))).toContain(
      'No sales in taxable accounts in 2026 — 2 inside tax-advantaged accounts (+$600.00), which are never reported or taxed. Shares withheld at 2 vests',
    )
    const plain = { ...none, sheltered: { sales: 0, gain_cents: 0 }, withheld: { sales: 1, cents: 1_600_00 } }
    expect(text(renderToStaticMarkup(<RealizedBody r={plain} all onAll={() => {}} />)).trim()).toBe(
      'No sales in taxable accounts in 2026. Shares withheld at a vest to pay the tax ($1,600.00) weren’t sold by you, so they aren’t listed.',
    )
  })

  it('shows the first 8 lines, then offers the rest', () => {
    const many = { ...report, lines: Array.from({ length: 11 }, (_, i) => ({ ...report.lines[0]!, sale_trade_id: 100 + i })) }
    const html = renderToStaticMarkup(<RealizedBody r={many} all={false} onAll={() => {}} />)
    expect((html.match(/<tr>/g) ?? []).length).toBe(1 + 2 + 1 + 8) // two table heads, two summary rows, eight lines
    expect(text(html)).toContain('Show all 11 lines')
  })
})
