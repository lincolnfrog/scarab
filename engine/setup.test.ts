import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { createPaySource } from './paychecks'
import { putPeople } from './people'
import { createAccount, createInvestAccount, createProperty, putBalanceSnapshot, runImport } from './services'
import { getSetup, putSetup, type SetupStep, type SetupStepId } from './setup'
import { putTaxSettings } from './tax'
import { onBothEngines } from './test/parity'

const TODAY = '2026-10-22'
const fresh = () => openDb(':memory:') as unknown as DbLike
const done = (db: DbLike) => Object.fromEntries(getSetup(db, 'a@x').steps.map((s) => [s.id, s.done])) as Record<SetupStepId, boolean>
const step = <K extends SetupStepId>(db: DbLike, id: K) => getSetup(db, 'a@x').steps.find((s) => s.id === id) as Extract<SetupStep, { id: K }>

describe('the setup checklist', () => {
  it('starts with every step to do, in the order the Dashboard lists them, on what Taxes assumes', () => {
    const s = getSetup(fresh(), 'a@x')
    expect(s.steps.map((x) => x.id)).toEqual(['bank', 'invest', 'property', 'paycheck', 'people', 'filing'])
    expect(s.steps.every((x) => !x.done)).toBe(true)
    expect(s.done).toBe(0)
    expect(s.hidden).toBe(false)
    expect(s.steps.at(-1)).toEqual({ id: 'filing', done: false, filingStatus: 'mfj', state: 'CA', stateName: 'California' })
  })

  it('reads each step from the ledger: an account counts once it has transactions, an investment account once it holds or has a balance', () => {
    const db = fresh()
    const checking = createAccount(db, { name: 'Checking', kind: 'checking' })
    expect(step(db, 'bank')).toMatchObject({ done: false, accounts: 1, transactions: 0 })
    runImport(db, { accountId: checking.id, content: 'Date,Description,Amount\n2026-10-01,TRADER JOE S,-42.50\n' }, 'a@x')
    expect(step(db, 'bank')).toMatchObject({ done: true, transactions: 1 })

    const k = createInvestAccount(db, { name: '401(k)', kind: 'retirement', tracking: 'balance' })
    expect(step(db, 'invest')).toMatchObject({ done: false, accounts: 1 })
    putBalanceSnapshot(db, { investAccountId: k.id, balancedOn: '2026-09-30', balanceCents: 1_000_000 }, TODAY)
    expect(done(db).invest).toBe(true)

    createProperty(db, { name: 'Home' })
    expect(done(db).property).toBe(true)
  })

  it('asks for birth years once a paycheck names the earners, and for filing status and state until Taxes saves them', () => {
    const db = fresh()
    expect(step(db, 'people')).toEqual({ id: 'people', done: false, people: 0, missing: [] }) // nobody to ask about yet
    createPaySource(db, { earner: 'Robin', employer: 'Larkspur', cadence: 'biweekly', paidOn: '2026-10-16', grossCents: 500_000 })
    expect(done(db).paycheck).toBe(true)
    expect(step(db, 'people')).toEqual({ id: 'people', done: false, people: 1, missing: ['Robin'] })
    putPeople(db, { people: [{ name: 'Robin', birthYear: 1988 }] }, TODAY)
    expect(done(db).people).toBe(true)
    // An account owner with no birth year undoes it: everyone the ledger names counts.
    createInvestAccount(db, { name: 'Roth IRA', kind: 'retirement', tracking: 'balance', owner: 'Kai' })
    expect(step(db, 'people')).toMatchObject({ done: false, missing: ['Kai'] })

    // The defaults are an assumption, not an answer; saving them (unchanged, even) is the answer.
    putTaxSettings(db, { filingStatus: 'mfj', state: 'CA' })
    expect(step(db, 'filing')).toMatchObject({ done: true, filingStatus: 'mfj', state: 'CA' })
    putTaxSettings(db, { state: 'NY', filingStatus: 'single' })
    expect(step(db, 'filing')).toEqual({ id: 'filing', done: true, filingStatus: 'single', state: 'NY', stateName: 'New York' })
  })

  it('keeps a hide mark per person, written only when it changes', () => {
    const db = fresh()
    const changes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    expect(putSetup(db, 'a@x', { hidden: true }).hidden).toBe(true)
    const after = changes()
    putSetup(db, 'a@x', { hidden: true })
    expect(changes()).toBe(after) // hiding twice writes nothing
    expect(getSetup(db, 'b@x').hidden).toBe(false) // the other member still sees it
    expect(putSetup(db, 'a@x', { hidden: false }).hidden).toBe(false)
    putSetup(db, 'b@x', { hidden: false })
    expect(changes()).toBe(after + 1) // bringing back one that isn't hidden writes nothing either
    expect(() => putSetup(db, 'a@x', { hidden: 'yes' })).toThrow(/hidden/)
  })
})

describe('setup parity: better-sqlite3 vs sql.js', () => {
  it('reads the same checklist', async () => {
    const seed = (db: DbLike) => {
      const a = createAccount(db, { name: 'Card', kind: 'credit' })
      runImport(db, { accountId: a.id, content: 'Date,Description,Amount\n2026-10-02,NETFLIX.COM,-17.99\n' }, 'a@x')
      createPaySource(db, { earner: 'Robin', cadence: 'semimonthly', paidOn: '2026-10-15', grossCents: 400_000 })
      putSetup(db, 'a@x', { hidden: true })
    }
    const { server, browser } = await onBothEngines(seed, (db) => getSetup(db, 'a@x'))
    expect(browser).toEqual(server)
    expect(server).toMatchObject({ done: 2, hidden: true })
  })
})
