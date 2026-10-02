import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { getAllocation } from './allocation'
import type { DbLike } from './db'
import { netWorthSeries } from './networth'
import { resolveContext } from './scenarios'
import { anchorAccount, ApiError, createAccount, createLiability, createProperty, getGoal, getNetworth, listAccounts, listDebts, putGoal } from './services'
import { onBothEngines } from './test/parity'

/**
 * Credit cards are bank accounts whose balance is owed (migration 27). Net
 * worth keeps them out of cash and lists them as debt, beside the loans.
 */

const mem = () => openDb(':memory:') as unknown as DbLike
const TODAY = '2026-09-30'

function household(db: DbLike) {
  const chk = createAccount(db, { name: 'WF Checking', kind: 'checking' }).id
  const card = createAccount(db, { name: 'Citi Card', kind: 'credit' }).id
  const tx = db.prepare("INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (?, ?, ?, ?, ?)")
  tx.run(chk, '2026-08-01', 1_000_000, 'PAYROLL', 'a#0')
  tx.run(card, '2026-08-05', -45_000, 'GROCERIES', 'b#0')
  tx.run(card, '2026-09-05', -30_000, 'DINING', 'c#0')
  tx.run(card, '2026-09-10', 45_000, 'AUTOPAY THANK YOU', 'd#0')
  tx.run(chk, '2026-09-10', -45_000, 'CITI AUTOPAY', 'e#0')
  const { id: home } = createProperty(db, { name: 'Home', purchasedOn: '2020-01-15', purchaseCents: 80_000_000 })
  createLiability(db, { propertyId: home, name: 'Huntington mortgage', rateMicro: 30_000, balanceCents: 40_000_000, balancedOn: '2026-08-31' })
  return { chk, card }
}

describe('credit card accounts', () => {
  it('count as debt in net worth, not cash, and the total is unchanged', () => {
    const db = mem()
    household(db)
    const [aug, sep] = netWorthSeries(db, TODAY).slice(-2)
    expect(aug).toMatchObject({ month: '2026-08', cash: 1_000_000, credit: -45_000, liabilities: -40_000_000 })
    expect(sep).toMatchObject({ month: '2026-09', cash: 955_000, credit: -30_000 })
    expect(sep!.total).toBe(955_000 - 30_000 + 80_000_000 - 40_000_000)
  })

  it('itemizes everything owed today, largest first', () => {
    const db = mem()
    household(db)
    expect(listDebts(db, TODAY)).toEqual([
      { kind: 'loan', id: 1, name: 'Huntington mortgage', property: 'Home', rateMicro: 30_000, owedCents: 40_000_000 },
      { kind: 'card', id: 2, name: 'Citi Card', owedCents: 30_000 },
    ])
    expect(getNetworth(db, TODAY).debts).toHaveLength(2)
    // A paid-off card owes nothing and drops out.
    db.prepare("INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (2, '2026-09-20', 30000, 'PAYMENT', 'f#0')").run()
    expect(listDebts(db, TODAY).map((d) => d.name)).toEqual(['Huntington mortgage'])
  })

  it('lists balances; a card is anchored to what it owes, as a negative balance', () => {
    const db = mem()
    const { card } = household(db)
    expect(listAccounts(db)).toEqual([
      { id: 1, name: 'WF Checking', kind: 'checking', balance_cents: 955_000 },
      { id: 2, name: 'Citi Card', kind: 'credit', balance_cents: -30_000 },
    ])
    anchorAccount(db, card, { currentBalanceCents: -52_000 })
    expect(listAccounts(db)[1]!.balance_cents).toBe(-52_000)
    expect(netWorthSeries(db, TODAY).at(-1)!.credit).toBe(-52_000)
  })

  it('changes an account’s kind, and validates kinds', () => {
    const db = mem()
    const id = createAccount(db, { name: 'Card filed as checking', kind: 'checking' }).id
    anchorAccount(db, id, { kind: 'credit' })
    expect(listAccounts(db)[0]!.kind).toBe('credit')
    expect(() => createAccount(db, { name: 'X', kind: 'loan' })).toThrow(ApiError)
    expect(() => anchorAccount(db, id, { kind: 'loan' })).toThrow(ApiError)
    expect(() => anchorAccount(db, id, {})).toThrow(/currentBalanceCents or kind/)
  })

  it('stay out of the dream-home fund and the asset allocation', () => {
    const db = mem()
    household(db)
    putGoal(db, { goal: { fundAccountIds: [1, 2] } })
    const g = getGoal(db, TODAY)
    expect((g.accounts as { name: string }[]).map((a) => a.name)).toEqual(['WF Checking'])
    expect(g.derived.fundCents).toBe(955_000)
    const names = getAllocation(db, TODAY).slices.map((s) => s.accountName)
    expect(names).toContain('WF Checking')
    expect(names).not.toContain('Citi Card')
  })

  it('reduce the cash the Future simulation starts from', () => {
    const db = mem()
    household(db)
    expect(resolveContext(db, TODAY).balance).toMatchObject({ cash: 955_000 - 30_000, liabilities: 40_000_000 })
  })

  it('read back identically on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => void household(db),
      (db) => ({ nw: netWorthSeries(db, TODAY), debts: listDebts(db, TODAY), accounts: listAccounts(db) }),
    )
    expect(server.debts).toHaveLength(2)
    expect(browser).toEqual(server)
  })
})
