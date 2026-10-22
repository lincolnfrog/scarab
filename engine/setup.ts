import type { DbLike } from './db'
import { bad } from './errors'
import { listPeople } from './people'
import { getTaxSettings, hasTaxSettings, STATES, type FilingStatus } from './tax'

/**
 * The household's first steps, for the Dashboard's setup checklist: what a
 * new household brings in before Scarab's screens have much to say. Each step
 * is read from the ledger as it stands — a bank or card account with
 * transactions, an investment account with holdings or a balance, a property,
 * a paycheck, everyone's birth year, and the filing status and state Taxes
 * works from — so nothing is ever marked done, and undoing the thing undoes
 * the step. The one thing stored is a per-person mark in app_meta, like the
 * digest's seen mark: that this person hid the checklist (a household that
 * rents never adds a property, and shouldn't be asked to forever).
 */

export type SetupStep =
  /** `accounts`: bank and card accounts, with or without transactions yet. */
  | { id: 'bank'; done: boolean; accounts: number; transactions: number }
  /** `accounts`: investment accounts, with or without holdings or a balance yet. */
  | { id: 'invest'; done: boolean; accounts: number }
  | { id: 'property'; done: boolean; properties: number }
  | { id: 'paycheck'; done: boolean; paychecks: number }
  /** Everyone the ledger names (paycheck earners, account owners); `missing` have no birth year. None yet: it waits on a paycheck. */
  | { id: 'people'; done: boolean; people: number; missing: string[] }
  /** What Taxes works from — the defaults until the household saves its settings once. */
  | { id: 'filing'; done: boolean; filingStatus: FilingStatus; state: string; stateName: string }

export type SetupStepId = SetupStep['id']

/** GET /api/setup. `hidden`: this person hid the checklist; PUT /api/setup brings it back. */
export type Setup = { steps: SetupStep[]; done: number; hidden: boolean }

const hiddenKey = (who: string) => `setup:hidden:${who}`

const count = (db: DbLike, sql: string): number => (db.prepare(sql).get() as { n: number }).n

export function getSetup(db: DbLike, who: string): Setup {
  const bankAccounts = count(db, 'SELECT count(*) AS n FROM accounts')
  const transactions = count(db, 'SELECT count(*) AS n FROM transactions')
  const investAccounts = count(db, 'SELECT count(*) AS n FROM invest_accounts')
  // Holdings or a balance: a trade (lots), or a statement balance (a balance account, or a lots account's cash).
  const invested = count(db, 'SELECT (EXISTS (SELECT 1 FROM trades) OR EXISTS (SELECT 1 FROM balance_snapshots)) AS n') === 1
  const properties = count(db, 'SELECT count(*) AS n FROM properties')
  const paychecks = count(db, 'SELECT count(*) AS n FROM pay_sources')
  const people = listPeople(db)
  const missing = people.filter((p) => p.birthYear === null).map((p) => p.name)
  const tax = getTaxSettings(db)
  const steps: SetupStep[] = [
    { id: 'bank', done: transactions > 0, accounts: bankAccounts, transactions },
    { id: 'invest', done: invested, accounts: investAccounts },
    { id: 'property', done: properties > 0, properties },
    { id: 'paycheck', done: paychecks > 0, paychecks },
    { id: 'people', done: people.length > 0 && missing.length === 0, people: people.length, missing },
    {
      id: 'filing',
      done: hasTaxSettings(db),
      filingStatus: tax.filingStatus,
      state: tax.state,
      stateName: STATES.find((s) => s.code === tax.state)?.name ?? tax.state,
    },
  ]
  return {
    steps,
    done: steps.filter((s) => s.done).length,
    hidden: db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(hiddenKey(who)) !== undefined,
  }
}

/**
 * PUT /api/setup { hidden }: hide the checklist for this person, or bring it
 * back. Writes only what changes, so asking twice leaves a tab session clean.
 */
export function putSetup(db: DbLike, who: string, body: { hidden?: unknown }) {
  if (typeof body?.hidden !== 'boolean') bad('hidden (true or false) required')
  if (body.hidden) db.prepare("INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, datetime('now'))").run(hiddenKey(who))
  else db.prepare('DELETE FROM app_meta WHERE key = ?').run(hiddenKey(who))
  return getSetup(db, who)
}
