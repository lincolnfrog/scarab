import { isRealIsoDay } from '../shared/dates'
import type { ReportedRealizedBody, ReportedRealizedRow } from '../shared/invest-api'
import type { DbLike } from './db'
import { bad, notFound } from './errors'

/**
 * Realized gains as the broker reports them (migration 26), for accounts
 * Scarab tracks by balance. A managed tax-aware strategy — a long/short book
 * making hundreds of trades, shorts included — realizes gains and losses the
 * return has to see, but recording its trades isn't possible (Scarab has no
 * short lots) or sensible. Its broker states the year's realized gain or loss
 * by term, so that is the fact kept: one row per account and tax year, the
 * latest year-to-date figures with the day they run through. Taxes, the
 * two-year view, the harvest list's tax deltas and the realized report add
 * them in; nothing derived is stored.
 *
 * A lots account's sales come from its trades, so it never takes a row here
 * (both would count the same sale twice). A retirement account's sales are
 * never taxed, so none is entered there either; a row left behind by a kind
 * change reads as sheltered.
 */

type DbRow = Omit<ReportedRealizedRow, 'sheltered'> & { kind: string }

const SELECT = `SELECT r.invest_account_id, ia.name AS account, ia.kind, r.tax_year, r.st_cents, r.lt_cents, r.as_of
  FROM realized_reported r JOIN invest_accounts ia ON ia.id = r.invest_account_id`

const toRow = ({ kind, ...r }: DbRow): ReportedRealizedRow => ({ ...r, sheltered: kind === 'retirement' })

/** Every reported year, or one account's, or one year's — newest year first, then in strip order. */
export function listReportedRealized(db: DbLike, f: { accountId?: number; year?: number } = {}): ReportedRealizedRow[] {
  const where: string[] = []
  const args: number[] = []
  if (f.accountId !== undefined) {
    where.push('r.invest_account_id = ?')
    args.push(f.accountId)
  }
  if (f.year !== undefined) {
    where.push('r.tax_year = ?')
    args.push(f.year)
  }
  const rows = db
    .prepare(`${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY r.tax_year DESC, ia.sort, ia.id`)
    .all(...args) as DbRow[]
  return rows.map(toRow)
}

/** A tax year's reported figures by shelter: what reaches the bill, and what was realized inside retirement accounts. */
export function reportedTotals(db: DbLike, year: number): { stCents: number; ltCents: number; shelteredCents: number; rows: ReportedRealizedRow[] } {
  const rows = listReportedRealized(db, { year })
  let st = 0
  let lt = 0
  let sheltered = 0
  for (const r of rows) {
    if (r.sheltered) sheltered += r.st_cents + r.lt_cents
    else {
      st += r.st_cents
      lt += r.lt_cents
    }
  }
  return { stCents: st, ltCents: lt, shelteredCents: sheltered, rows: rows.filter((r) => !r.sheltered) }
}

/** No household realizes a trillion dollars in a year: a figure past this is a typo. */
const MAX_CENTS = 100_000_000_000_00

function taxYearOf(raw: unknown, today: string): number {
  const thisYear = Number(today.slice(0, 4))
  const year = typeof raw === 'string' && /^\d{4}$/.test(raw) ? Number(raw) : raw
  if (!Number.isSafeInteger(year) || (year as number) < 1900 || (year as number) > thisYear)
    bad(`the tax year must be a whole year from 1900 to ${thisYear}`)
  return year as number
}

function account(db: DbLike, id: number) {
  const a = Number.isSafeInteger(id) && id > 0
    ? (db.prepare('SELECT id, name, kind, tracking FROM invest_accounts WHERE id = ?').get(id) as
        | { id: number; name: string; kind: string; tracking: string }
        | undefined)
    : undefined
  if (!a) notFound('no such investment account')
  return a
}

/**
 * Set one account's realized gains for a tax year: short- and long-term in
 * cents (a loss is negative), as of a day inside that year and not after
 * today — by default today, or Dec 31 for a year that has ended. Replaces the
 * year's earlier figures. The same figures again write nothing
 * (`changed: false`), so a tab stays clean.
 */
export function putReportedRealized(db: DbLike, accountId: number, yearRaw: unknown, b: Partial<Record<keyof ReportedRealizedBody, unknown>>, today: string) {
  const a = account(db, accountId)
  const year = taxYearOf(yearRaw, today)
  if (a.tracking !== 'balance')
    bad(`${a.name} tracks trades — its realized gains come from the sales recorded there, so there's nothing to enter`)
  if (a.kind === 'retirement') bad(`sales inside ${a.name} are tax-advantaged and never reach the return — nothing to report`)
  for (const k of ['stCents', 'ltCents'] as const) {
    const v = b[k]
    if (!Number.isSafeInteger(v) || Math.abs(v as number) > MAX_CENTS) bad(`${k} must be a whole number of cents (negative for a loss)`)
  }
  const last = `${year}-12-31` < today ? `${year}-12-31` : today
  const asOf = b.asOf === undefined || b.asOf === null || b.asOf === '' ? last : b.asOf
  if (typeof asOf !== 'string' || !isRealIsoDay(asOf)) bad('asOf must be a real yyyy-mm-dd day')
  if (asOf < `${year}-01-01` || asOf > last)
    bad(`asOf must fall within ${year}${last === today ? `, through today (${today})` : ''} — the day the figures run through`)
  const st = b.stCents as number
  const lt = b.ltCents as number
  const cur = db
    .prepare('SELECT st_cents, lt_cents, as_of FROM realized_reported WHERE invest_account_id = ? AND tax_year = ?')
    .get(a.id, year) as { st_cents: number; lt_cents: number; as_of: string } | undefined
  const changed = !cur || cur.st_cents !== st || cur.lt_cents !== lt || cur.as_of !== asOf
  if (changed)
    db.prepare(
      `INSERT INTO realized_reported (invest_account_id, tax_year, st_cents, lt_cents, as_of) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (invest_account_id, tax_year) DO UPDATE SET st_cents = excluded.st_cents, lt_cents = excluded.lt_cents, as_of = excluded.as_of`,
    ).run(a.id, year, st, lt, asOf)
  return { ok: true as const, changed, row: listReportedRealized(db, { accountId: a.id, year })[0]! }
}

/** Remove one account's figures for a tax year. */
export function deleteReportedRealized(db: DbLike, accountId: number, yearRaw: unknown, today: string) {
  const a = account(db, accountId)
  const year = taxYearOf(yearRaw, today)
  const row = listReportedRealized(db, { accountId: a.id, year })[0]
  if (!row) notFound(`no realized gains reported for ${a.name} in ${year}`)
  db.prepare('DELETE FROM realized_reported WHERE invest_account_id = ? AND tax_year = ?').run(a.id, year)
  return { ok: true as const, removed: row }
}
