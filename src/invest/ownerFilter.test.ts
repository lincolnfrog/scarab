import { describe, expect, it } from 'vitest'
import type { InvestAccountRow, PortfolioAccount, PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { HOUSEHOLD, inScope, JOINT, ownerGroups, ownerKeyOf, personKey, scopePortfolio, scopeWords } from './ownerFilter'

const acct = (id: number, name: string, owner: string | null, extra: Partial<InvestAccountRow> = {}): InvestAccountRow => ({
  id,
  name,
  kind: 'brokerage',
  tracking: 'lots',
  stock_plan: 0,
  subtype: null,
  institution: null,
  owner,
  mask: null,
  sort: 0,
  latest_snapshot: null,
  counts: { trades: 1, balances: 0, unvested: 0, paychecks: 0 },
  ...extra,
})

const maxSchwab = acct(1, 'Max Schwab', 'Max')
const nicoleK = acct(2, 'Nicole 401(k)', 'nicole ', { tracking: 'balance', kind: 'retirement', latest_snapshot: { balanced_on: '2026-06-30', balance_cents: 50_000_00 } })
const joint = acct(3, 'Joint brokerage', null)
const maxRoth = acct(4, 'Max Roth', 'Max', { kind: 'retirement' })

const lot = (account: number, qty: number, cost: number) => ({
  trade_id: account * 10,
  opened_on: '2025-01-02',
  lt_on: '2026-01-03',
  qty_micro: qty,
  cost_cents: cost,
  invest_account_id: account,
  account_name: `#${account}`,
  sheltered: account === 4,
})
const vti: PortfolioPosition = {
  asset_id: 1,
  symbol: 'VTI',
  kind: 'stock',
  qty_micro: 30_000_000,
  cost_cents: 6_000_00,
  price_cents: 300_00,
  priced_on: '2026-09-22',
  value_cents: 9_000_00,
  unrealized_cents: 3_000_00,
  lots: [lot(1, 10_000_000, 2_000_00), lot(3, 20_000_000, 4_000_00)],
  accounts: [
    { invest_account_id: 1, name: 'Max Schwab', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 2_000_00, value_cents: 3_000_00 },
    { invest_account_id: 3, name: 'Joint brokerage', kind: 'brokerage', qty_micro: 20_000_000, cost_cents: 4_000_00, value_cents: 6_000_00 },
  ],
}
const qqq: PortfolioPosition = {
  asset_id: 2,
  symbol: 'QQQ',
  kind: 'stock',
  qty_micro: 5_000_000,
  cost_cents: 2_000_00,
  price_cents: 500_00,
  priced_on: '2026-09-22',
  value_cents: 2_500_00,
  unrealized_cents: 500_00,
  lots: [lot(4, 5_000_000, 2_000_00)],
  accounts: [{ invest_account_id: 4, name: 'Max Roth', kind: 'retirement', qty_micro: 5_000_000, cost_cents: 2_000_00, value_cents: 2_500_00 }],
}
const cashRow = (id: number, cents: number | null): PortfolioAccount => ({
  invest_account_id: id,
  name: `#${id}`,
  kind: 'brokerage',
  value_cents: 0,
  cash_cents: cents,
  cash_as_of: cents === null ? null : '2026-09-01',
  cash_anchor_cents: cents,
  cash_trades: 0,
  uncounted_proceeds_cents: 0,
})
const cash = new Map([[1, cashRow(1, 500_00)], [3, cashRow(3, null)]])
const totals: PortfolioResponse['totals'] = { value: 11_500_00, cost: 8_000_00, unrealized: 3_500_00, cash: 500_00, ytd_st: 120_00, ytd_lt: 0, ytd_sheltered: 40_00 }

describe('the owner pills', () => {
  it('Household, then each person in the household’s order (names matched ignoring case), then Joint — with subtotals', () => {
    const g = ownerGroups([joint, maxSchwab, nicoleK, maxRoth], ['Nicole', 'Max'], [vti, qqq], cash)
    expect(g).toEqual([
      // 9,000 + 2,500 of holdings + 500 cash + the 401(k)'s 50,000
      { key: HOUSEHOLD, label: 'Household', cents: 62_000_00, accounts: 4 },
      { key: 'p:nicole', label: 'Nicole', cents: 50_000_00, accounts: 1 },
      { key: 'p:max', label: 'Max', cents: 3_000_00 + 500_00 + 2_500_00, accounts: 2 },
      { key: JOINT, label: 'Joint', cents: 6_000_00, accounts: 1 },
    ])
    // The subtotals add up to the household's.
    expect(g.slice(1).reduce((s, x) => s + x.cents, 0)).toBe(g[0]!.cents)
  })

  it('an owner who is no paycheck earner still gets a pill, after the earners', () => {
    const g = ownerGroups([maxSchwab, acct(5, 'Kid 529', 'Sam')], ['Max'], [], new Map())
    expect(g.map((x) => x.label)).toEqual(['Household', 'Max', 'Sam'])
  })

  it('nothing to split — one person’s accounts, or all joint — means no pills', () => {
    expect(ownerGroups([maxSchwab, maxRoth], ['Max', 'Nicole'], [vti, qqq], cash)).toEqual([])
    expect(ownerGroups([joint], [], [vti], cash)).toEqual([])
    expect(ownerGroups([], ['Max'], [], cash)).toEqual([])
  })

  it('keys and scope', () => {
    expect(ownerKeyOf(maxSchwab)).toBe(personKey('MAX'))
    expect(ownerKeyOf(joint)).toBe(JOINT)
    expect(ownerKeyOf(acct(9, 'x', '  '))).toBe(JOINT)
    expect(inScope(joint, HOUSEHOLD)).toBe(true)
    expect(inScope(joint, 'p:max')).toBe(false)
    expect(inScope(nicoleK, 'p:nicole')).toBe(true)
    expect(scopeWords({ key: 'p:max', label: 'Max' })).toBe('Max’s accounts')
    expect(scopeWords({ key: JOINT, label: 'Joint' })).toBe('joint accounts')
  })
})

describe('the portfolio narrowed to one owner', () => {
  it("keeps each symbol's split for those accounts only, re-summed from the engine's own figures", () => {
    const v = scopePortfolio([vti, qqq], totals, new Set([1, 4]))
    expect(v.positions.map((p) => [p.symbol, p.qty_micro, p.cost_cents, p.value_cents, p.unrealized_cents])).toEqual([
      ['VTI', 10_000_000, 2_000_00, 3_000_00, 1_000_00],
      ['QQQ', 5_000_000, 2_000_00, 2_500_00, 500_00],
    ])
    expect(v.positions[0]!.lots).toEqual([lot(1, 10_000_000, 2_000_00)])
    expect(v.positions[0]!.accounts.map((a) => a.invest_account_id)).toEqual([1])
    expect(v.totals).toEqual({ ...totals, value: 5_500_00, cost: 4_000_00, unrealized: 1_500_00 })
  })

  it('drops symbols the owner doesn’t hold; the realized totals stay the household’s', () => {
    const v = scopePortfolio([vti, qqq], totals, new Set([3]))
    expect(v.positions.map((p) => p.symbol)).toEqual(['VTI'])
    expect(v.totals).toMatchObject({ value: 6_000_00, ytd_st: 120_00, ytd_sheltered: 40_00, cash: 500_00 })
    expect(scopePortfolio([vti], totals, new Set([2])).positions).toEqual([])
  })
})
