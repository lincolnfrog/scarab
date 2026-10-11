import { isRealIsoDay } from '../shared/dates'
import type { AccountFlowBody, AccountFlowRow } from '../shared/invest-api'
import type { DbLike } from './db'
import { bad, notFound } from './errors'

/**
 * Deposits and withdrawals on an account tracked by balance (migration 28).
 * A balance history alone can't tell money put in from money made: the
 * $200,000 that arrives in September looks like a good month. A flow is the
 * fact that separates them — a day, an amount (negative on the way out) and
 * a note. A flow dated after today is a plan: the harvest forecast
 * (engine/harvest.ts) counts a planned deposit as new money from that day,
 * and the drawer shows it as planned until the day comes.
 *
 * Lots accounts never take one: money there shows in the cash anchor and the
 * trades. Nothing derived is stored.
 */

/** No household moves a trillion dollars in a day: an amount past this is a typo. */
const MAX_CENTS = 100_000_000_000_00
/** A plan further out than this is not a plan. */
export const FLOW_HORIZON_YEARS = 30
const MAX_NOTE = 120

const SELECT = `SELECT f.id, f.invest_account_id, ia.name AS account, f.flowed_on, f.amount_cents, f.note
  FROM account_flows f JOIN invest_accounts ia ON ia.id = f.invest_account_id`

type DbRow = Omit<AccountFlowRow, 'planned'>

const toRow = (today: string) => (r: DbRow): AccountFlowRow => ({ ...r, planned: r.flowed_on > today })

/** Every flow, or one account's — newest first. */
export function listAccountFlows(db: DbLike, today: string, f: { accountId?: number } = {}): AccountFlowRow[] {
  const rows = (
    f.accountId === undefined
      ? db.prepare(`${SELECT} ORDER BY f.flowed_on DESC, f.id DESC`).all()
      : db.prepare(`${SELECT} WHERE f.invest_account_id = ? ORDER BY f.flowed_on DESC, f.id DESC`).all(f.accountId)
  ) as DbRow[]
  return rows.map(toRow(today))
}

function one(db: DbLike, id: number, today: string): AccountFlowRow {
  const r = (Number.isSafeInteger(id) && id > 0 ? db.prepare(`${SELECT} WHERE f.id = ?`).get(id) : undefined) as DbRow | undefined
  if (!r) notFound('no such deposit or withdrawal')
  return toRow(today)(r!)
}

type Valid = { investAccountId: number; flowedOn: string; amountCents: number; note: string | null }

function validate(db: DbLike, b: Partial<Record<keyof AccountFlowBody, unknown>>, today: string): Valid {
  const id = b.investAccountId
  const a = (Number.isSafeInteger(id) && (id as number) > 0
    ? db.prepare('SELECT id, name, tracking FROM invest_accounts WHERE id = ?').get(id)
    : undefined) as { id: number; name: string; tracking: string } | undefined
  if (!a) notFound('no such investment account')
  if (a!.tracking !== 'balance')
    bad(`${a!.name} tracks trades — money in and out shows in its cash balance and its trades; deposits are recorded only for an account tracked by balance`)
  const on = b.flowedOn
  if (typeof on !== 'string' || !isRealIsoDay(on)) bad('flowedOn must be a real yyyy-mm-dd day')
  const far = `${Number(today.slice(0, 4)) + FLOW_HORIZON_YEARS}${today.slice(4)}`
  if ((on as string) < '1900-01-01' || (on as string) > far) bad(`flowedOn must fall between 1900 and ${FLOW_HORIZON_YEARS} years from today`)
  const cents = b.amountCents
  if (!Number.isSafeInteger(cents) || cents === 0 || Math.abs(cents as number) > MAX_CENTS)
    bad('amountCents must be a whole number of cents other than zero (negative for a withdrawal)')
  let note: string | null = null
  if (b.note !== undefined && b.note !== null) {
    if (typeof b.note !== 'string') bad('note must be text')
    note = (b.note as string).trim().slice(0, MAX_NOTE) || null
  }
  return { investAccountId: a!.id, flowedOn: on as string, amountCents: cents as number, note }
}

/** Record a deposit or withdrawal — or, dated after today, plan one. */
export function createAccountFlow(db: DbLike, b: Partial<Record<keyof AccountFlowBody, unknown>>, today: string) {
  const v = validate(db, b, today)
  const r = db
    .prepare('INSERT INTO account_flows (invest_account_id, flowed_on, amount_cents, note) VALUES (?, ?, ?, ?)')
    .run(v.investAccountId, v.flowedOn, v.amountCents, v.note)
  return { ok: true as const, row: one(db, Number(r.lastInsertRowid), today) }
}

/** Correct one: its day, amount or note (it stays with its account). The same values again write nothing. */
export function updateAccountFlow(db: DbLike, id: number, b: Partial<Record<keyof AccountFlowBody, unknown>>, today: string) {
  const cur = one(db, id, today)
  const v = validate(db, { ...b, investAccountId: cur.invest_account_id }, today)
  const changed = v.flowedOn !== cur.flowed_on || v.amountCents !== cur.amount_cents || v.note !== cur.note
  if (changed) db.prepare('UPDATE account_flows SET flowed_on = ?, amount_cents = ?, note = ? WHERE id = ?').run(v.flowedOn, v.amountCents, v.note, id)
  return { ok: true as const, changed, row: one(db, id, today) }
}

export function deleteAccountFlow(db: DbLike, id: number, today: string) {
  const row = one(db, id, today)
  db.prepare('DELETE FROM account_flows WHERE id = ?').run(id)
  return { ok: true as const, removed: row }
}

/** Deposits in, withdrawals out, through today and planned — for the drawer's summary line. */
export function flowTotals(rows: readonly AccountFlowRow[]): { depositedCents: number; withdrawnCents: number; plannedCents: number } {
  let deposited = 0
  let withdrawn = 0
  let planned = 0
  for (const r of rows) {
    if (r.planned) planned += r.amount_cents
    else if (r.amount_cents > 0) deposited += r.amount_cents
    else withdrawn += -r.amount_cents
  }
  return { depositedCents: deposited, withdrawnCents: withdrawn, plannedCents: planned }
}
