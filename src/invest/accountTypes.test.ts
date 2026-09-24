import { describe, expect, it } from 'vitest'
import { INVEST_SUBTYPES, SUBTYPE_KIND, type InvestAccountRow, type PortfolioPosition } from '../../shared/invest-api'
import {
  ACCOUNT_TYPES,
  accountPatch,
  accountValueCents,
  formFromAccount,
  formKind,
  heldLine,
  institutionLine,
  kindFor,
  ownerInitial,
  ownerTone,
  staleReason,
  stockPlanLock,
  suggestName,
  trackingLock,
  typeLabel,
} from './accountTypes'
import { drawerTab, drawerTabs } from './AccountDrawer'
import * as accountTypesModule from './accountTypes'

const TODAY = '2026-09-22'
const acct = (over: Partial<InvestAccountRow> = {}): InvestAccountRow => ({
  id: 1,
  name: 'Schwab brokerage',
  kind: 'brokerage',
  tracking: 'lots',
  stock_plan: 0,
  subtype: 'taxable',
  institution: 'Schwab',
  owner: null,
  mask: '1234',
  sort: 0,
  latest_snapshot: null,
  counts: { trades: 0, balances: 0, unvested: 0, paychecks: 0 },
  ...over,
})
const pos = (over: Partial<PortfolioPosition> & Pick<PortfolioPosition, 'asset_id' | 'symbol'>): PortfolioPosition => ({
  kind: 'stock',
  qty_micro: 1_000_000,
  cost_cents: 100_00,
  price_cents: 120_00,
  priced_on: '2026-09-19',
  value_cents: 120_00,
  unrealized_cents: 20_00,
  lots: [],
  accounts: [],
  ...over,
})

describe('account types', () => {
  it('cover every subtype once, and each card agrees with the kind the engine enforces', () => {
    expect(ACCOUNT_TYPES.map((t) => t.subtype).sort()).toEqual([...INVEST_SUBTYPES].sort())
    for (const t of ACCOUNT_TYPES) {
      if (t.stockPlan) expect(t.tracking, t.subtype).toBe('lots') // a stock plan must track trades
      expect(kindFor(t.subtype, 'crypto')).toBe(SUBTYPE_KIND[t.subtype] ?? 'crypto')
    }
    // Workplace plans default to a balance; brokerages, IRAs and crypto to trades.
    expect(ACCOUNT_TYPES.filter((t) => t.tracking === 'balance').map((t) => t.subtype)).toEqual(['401k', '403b', 'hsa', 'other'])
  })

  it('label an account by its type, or by its kind when it predates types', () => {
    expect(typeLabel(acct({ subtype: 'roth_ira', kind: 'retirement' }))).toBe('Roth IRA')
    expect(typeLabel(acct({ subtype: null, kind: 'retirement' }))).toBe('Retirement')
    expect(typeLabel(acct({ subtype: null, kind: 'brokerage', stock_plan: 1 }))).toBe('Stock plan')
    expect(typeLabel(acct({ subtype: null, kind: 'crypto' }))).toBe('Crypto')
  })

  it('suggest a name from the institution, the type and — with two people — the owner', () => {
    const owners = ['Max', 'Nicole']
    expect(suggestName({ subtype: '401k', institution: ' Fidelity ', owner: null, owners })).toBe('Fidelity 401(k)')
    expect(suggestName({ subtype: 'taxable', institution: 'Schwab', owner: null, owners })).toBe('Schwab brokerage')
    expect(suggestName({ subtype: 'taxable', institution: '', owner: null, owners })).toBe('Brokerage')
    expect(suggestName({ subtype: 'crypto', institution: 'Coinbase', owner: null, owners })).toBe('Coinbase')
    expect(suggestName({ subtype: 'roth_ira', institution: 'Vanguard', owner: 'Nicole', owners })).toBe('Nicole’s Vanguard Roth IRA')
    expect(suggestName({ subtype: 'roth_ira', institution: '', owner: 'Max', owners: ['Max'] })).toBe('Roth IRA')
    expect(suggestName({ subtype: 'other', institution: '', owner: null, owners })).toBe('Account')
    expect(suggestName({ subtype: 'taxable', institution: 'X'.repeat(70), owner: null, owners }).length).toBeLessThanOrEqual(60)
  })

  it('give owners initials and the household’s first two people their own avatar tone', () => {
    expect(ownerInitial(' nicole')).toBe('N')
    expect(ownerTone('max', ['Max', 'Nicole'])).toBe(1)
    expect(ownerTone('Nicole', ['Max', 'Nicole'])).toBe(2)
    expect(ownerTone('Grandma', ['Max', 'Nicole', 'Grandma'])).toBe(0)
    expect(institutionLine(acct())).toBe('Schwab ··1234')
    expect(institutionLine(acct({ institution: null }))).toBe('··1234')
    expect(institutionLine(acct({ institution: null, mask: null }))).toBe('')
  })
})

describe('the settings form sends only what changed', () => {
  it('an untouched form sends nothing; blank text clears; a new type carries its kind', () => {
    const a = acct()
    expect(accountPatch(a, formFromAccount(a))).toEqual({})
    // Case and surrounding space in the last 4 aren't a change the engine would store.
    expect(accountPatch(a, { ...formFromAccount(a), mask: ' 1234 ', name: ' Schwab brokerage ' })).toEqual({})
    expect(accountPatch(a, { ...formFromAccount(a), institution: '  ', mask: '' })).toEqual({ institution: null, mask: null })
    expect(accountPatch(a, { ...formFromAccount(a), subtype: 'roth_ira' })).toEqual({ subtype: 'roth_ira', kind: 'retirement' })
    expect(accountPatch(a, { ...formFromAccount(a), owner: 'Max' })).toEqual({ owner: 'Max' })
    expect(accountPatch(acct({ owner: 'Max' }), { ...formFromAccount(acct({ owner: 'Max' })), owner: null })).toEqual({ owner: null })
    expect(accountPatch(a, { ...formFromAccount(a), tracking: 'balance' })).toEqual({ tracking: 'balance' })
  })

  it("'other' and an untyped account keep the kind chosen; a known type decides it", () => {
    const legacy = acct({ subtype: null, kind: 'retirement' })
    const f = formFromAccount(legacy)
    expect(f.subtype).toBe('')
    expect(formKind({ ...f, kind: 'brokerage' })).toBe('brokerage')
    expect(accountPatch(legacy, { ...f, kind: 'brokerage' })).toEqual({ kind: 'brokerage' })
    expect(formKind({ subtype: 'hsa', kind: 'brokerage' })).toBe('retirement')
    expect(formKind({ subtype: 'other', kind: 'crypto' })).toBe('crypto')
  })

  it('says why tracking or the stock-plan flag is locked, before anyone tries', () => {
    expect(trackingLock(acct())).toBeNull()
    expect(trackingLock(acct({ counts: { trades: 3, balances: 0, unvested: 0, paychecks: 0 } }))).toMatch(/It has 3 trades/)
    expect(trackingLock(acct({ tracking: 'balance', counts: { trades: 0, balances: 1, unvested: 0, paychecks: 0 } }))).toMatch(/1 balance update\./)
    expect(stockPlanLock(acct())).toBeNull()
    expect(stockPlanLock(acct({ stock_plan: 1 }))).toBeNull()
    expect(stockPlanLock(acct({ stock_plan: 1, counts: { trades: 0, balances: 0, unvested: 2, paychecks: 0 } }))).toMatch(/Grants tab/)
    expect(stockPlanLock(acct({ stock_plan: 1, counts: { trades: 0, balances: 0, unvested: 0, paychecks: 1 } }))).toMatch(/paycheck/)
  })
})

describe('the account strip', () => {
  const positions = [
    pos({ asset_id: 1, symbol: 'VTI', accounts: [{ invest_account_id: 1, name: 'A', kind: 'brokerage', qty_micro: 1, cost_cents: 1, value_cents: 3_000_00 }, { invest_account_id: 2, name: 'B', kind: 'retirement', qty_micro: 1, cost_cents: 1, value_cents: 500_00 }] }),
    pos({ asset_id: 2, symbol: 'ACME', priced_on: null, price_cents: null, accounts: [{ invest_account_id: 1, name: 'A', kind: 'brokerage', qty_micro: 1, cost_cents: 1, value_cents: 250_00 }] }),
    pos({ asset_id: 3, symbol: 'FXAIX', priced_on: '2026-07-01', price_manual: true, accounts: [{ invest_account_id: 2, name: 'B', kind: 'retirement', qty_micro: 1, cost_cents: 1, value_cents: 100_00 }] }),
  ]

  it("values a lots account by its share of every position, a balance account by its latest balance", () => {
    expect(accountValueCents(acct(), positions)).toBe(3_250_00)
    expect(accountValueCents(acct({ id: 2 }), positions)).toBe(600_00)
    expect(accountValueCents(acct({ id: 9 }), positions)).toBeNull()
    expect(accountValueCents(acct({ id: 9, tracking: 'balance', latest_snapshot: { balanced_on: '2026-06-30', balance_cents: 44_500_00 } }), positions)).toBe(44_500_00)
    expect(accountValueCents(acct({ id: 9, tracking: 'balance' }), positions)).toBeNull()
    expect(heldLine(acct(), positions)).toBe('2 holdings')
    expect(heldLine(acct({ id: 9 }), positions)).toBe('no holdings yet')
    expect(heldLine(acct({ id: 9, counts: { trades: 2, balances: 0, unvested: 0, paychecks: 0 } }), positions)).toBe('nothing held now')
  })

  it('marks an old number: a balance past 45 days, or a holding with no fresh price (hand-set prices count as fresh)', () => {
    expect(staleReason(acct(), positions, TODAY)).toBe('ACME has no fresh price')
    expect(staleReason(acct({ id: 2 }), positions, TODAY)).toBeNull()
    const k = acct({ id: 9, tracking: 'balance', latest_snapshot: { balanced_on: '2026-06-30', balance_cents: 1 } })
    expect(staleReason(k, positions, TODAY)).toBe('balance 84d old')
    expect(staleReason({ ...k, latest_snapshot: { balanced_on: '2026-09-01', balance_cents: 1 } }, positions, TODAY)).toBeNull()
  })

  it("opens the drawer on a tab the account has", () => {
    expect(drawerTabs(acct())).toEqual(['positions', 'activity', 'grants', 'settings'])
    expect(drawerTabs(acct({ tracking: 'balance' }))).toEqual(['balances', 'settings'])
    expect(drawerTab(acct(), 'activity')).toBe('activity')
    expect(drawerTab(acct(), 'balances')).toBe('positions')
    expect(drawerTab(acct({ tracking: 'balance' }), undefined)).toBe('balances')
    expect(drawerTab(acct({ tracking: 'balance' }), 'settings')).toBe('settings')
  })
})

describe('the last-4 box', () => {
  it('keeps the last four letters or digits of whatever is typed or pasted', () => {
    const { maskInput } = accountTypesModule
    expect(maskInput('1234')).toBe('1234')
    expect(maskInput('••9876')).toBe('9876')
    expect(maskInput('XXXX-XXXX-1234')).toBe('1234')
    expect(maskInput('ab1')).toBe('AB1')
    expect(maskInput('')).toBe('')
  })
})
