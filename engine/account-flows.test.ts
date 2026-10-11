import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { createAccountFlow, deleteAccountFlow, flowTotals, listAccountFlows, updateAccountFlow } from './account-flows'
import type { DbLike } from './db'
import { deleteInvestAccount, getInvestAccount, listInvestAccounts, updateInvestAccount } from './invest'
import { dumpDb, loadDump } from './snapshot'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-11'

/** A lots brokerage (1), a managed strategy tracked by balance (2) and a 401(k) (3). */
function household() {
  const db = mem()
  const acct = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  acct.run('Schwab', 'brokerage', 'lots')
  acct.run('Flex 250', 'brokerage', 'balance')
  acct.run('401(k)', 'retirement', 'balance')
  return db
}

describe('deposits and withdrawals on a balance account', () => {
  it('records a deposit, a withdrawal and a planned deposit, newest first, and sums them', () => {
    const db = household()
    const a = createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_500_000), note: '  Opening funding  ' }, today)
    expect(a.row).toMatchObject({ account: 'Flex 250', flowed_on: '2026-04-01', amount_cents: $(1_500_000), note: 'Opening funding', planned: false })
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-09-15', amountCents: $(200_000) }, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-06-30', amountCents: -$(10_000), note: '' }, today)
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2027-01-05', amountCents: $(1_600_000), note: 'January sale proceeds' }, today)
    const rows = listAccountFlows(db, today, { accountId: 2 })
    expect(rows.map((r) => [r.flowed_on, r.amount_cents, r.planned, r.note])).toEqual([
      ['2027-01-05', $(1_600_000), true, 'January sale proceeds'],
      ['2026-09-15', $(200_000), false, null],
      ['2026-06-30', -$(10_000), false, null],
      ['2026-04-01', $(1_500_000), false, 'Opening funding'],
    ])
    expect(flowTotals(rows)).toEqual({ depositedCents: $(1_700_000), withdrawnCents: $(10_000), plannedCents: $(1_600_000) })
    // The 401(k) takes deposits too (contributions are its flows); every account's list is in date order.
    createAccountFlow(db, { investAccountId: 3, flowedOn: '2026-01-15', amountCents: $(2_000) }, today)
    expect(listAccountFlows(db, today).map((r) => r.account)).toEqual(['Flex 250', 'Flex 250', 'Flex 250', 'Flex 250', '401(k)'])
    expect(listInvestAccounts(db).find((x) => x.id === 2)!.counts.flows).toBe(4)
    expect(getInvestAccount(db, 2, today).flows).toHaveLength(4)
    expect(getInvestAccount(db, 1, today).flows).toEqual([])
  })

  it('refuses a lots account, a zero or fractional amount, an impossible or far-off day and an unknown account', () => {
    const db = household()
    const make = (b: Record<string, unknown>) => () => createAccountFlow(db, b, today)
    expect(make({ investAccountId: 1, flowedOn: '2026-04-01', amountCents: $(100) })).toThrow(/tracks trades/)
    expect(make({ investAccountId: 2, flowedOn: '2026-04-01', amountCents: 0 })).toThrow(/other than zero/)
    expect(make({ investAccountId: 2, flowedOn: '2026-04-01', amountCents: 10.5 })).toThrow(/whole number of cents/)
    expect(make({ investAccountId: 2, flowedOn: '2026-02-30', amountCents: $(100) })).toThrow(/real yyyy-mm-dd/)
    expect(make({ investAccountId: 2, flowedOn: '2060-01-01', amountCents: $(100) })).toThrow(/30 years/)
    expect(make({ investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(100), note: 7 })).toThrow(/note must be text/)
    expect(make({ investAccountId: 9, flowedOn: '2026-04-01', amountCents: $(100) })).toThrow(/no such investment account/)
    expect(() => deleteAccountFlow(db, 1, today)).toThrow(/no such deposit/)
  })

  it('corrects one in place — same values write nothing — and deletes it', () => {
    const db = household()
    const { row } = createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_500_000) }, today)
    expect(updateAccountFlow(db, row.id, { flowedOn: '2026-04-01', amountCents: $(1_500_000) }, today).changed).toBe(false)
    const u = updateAccountFlow(db, row.id, { flowedOn: '2026-04-02', amountCents: $(1_499_000), note: 'wire fee' }, today)
    expect(u).toMatchObject({ changed: true, row: { flowed_on: '2026-04-02', amount_cents: $(1_499_000), note: 'wire fee', invest_account_id: 2 } })
    expect(() => updateAccountFlow(db, row.id, { flowedOn: '2026-04-02', amountCents: 0 }, today)).toThrow(/other than zero/)
    expect(deleteAccountFlow(db, row.id, today).removed.id).toBe(row.id)
    expect(listAccountFlows(db, today)).toEqual([])
  })

  it('keeps the account’s tracking from switching under them, and goes with the account', () => {
    const db = household()
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_000) }, today)
    expect(() => updateInvestAccount(db, 2, { tracking: 'lots' })).toThrow(/1 deposit or withdrawal recorded/)
    const r = deleteInvestAccount(db, 2)
    expect(r.removed).toMatchObject({ flows: 1, planned: 0, forecast: 0 })
    expect(listAccountFlows(db, today)).toEqual([])
  })

  it('survives a snapshot round trip, and an older snapshot without the table loads empty', () => {
    const db = household()
    createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_000), note: 'x' }, today)
    const dump = dumpDb(db)
    const other = mem()
    loadDump(other, dump)
    expect(listAccountFlows(other, today)).toEqual(listAccountFlows(db, today))
    const { account_flows: _, ...older } = dump.tables
    loadDump(other, { ...dump, tables: older })
    expect(listAccountFlows(other, today)).toEqual([])
  })
})
