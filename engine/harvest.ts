import { addDaysIso, addMonthsIso, isRealIsoDay } from '../shared/dates'
import type { HarvestProfile, HarvestProfileBody } from '../shared/invest-api'
import type { DbLike } from './db'
import { bad, notFound } from './errors'

/**
 * The harvest forecast (migration 28): what a managed tax-aware strategy —
 * a long/short book turning over to realize losses while the market
 * exposure rides — expects to realize in net losses, as its manager
 * estimates it. Scarab can't model the trades; it can hold the manager's
 * numbers and spread them over the calendar:
 *
 *   - dollar figures for the standing book, by tax year, from the day the
 *     estimate was given (`as_of`): the year of the estimate covers the rest
 *     of that year, each later year is whole;
 *   - rates on new money by its age — deposits after `as_of`, planned ones
 *     included — a share of the deposit in its first twelve months, another
 *     in its second, and one for each year after;
 *   - past the stated years, the standing book keeps producing at that last
 *     rate on the balance the manager was looking at.
 *
 * Each figure is spread evenly over its days, so a point in time has an
 * expected cumulative loss and a tax year an expected total. Where the
 * broker's reported year-to-date figure exists (engine/realized-reported.ts)
 * the forecast takes over the day after it runs through. An assumption,
 * labelled one wherever it is read; only a taxable balance-tracked account
 * takes one. Same rules as the rest of engine/: synchronous, integer cents,
 * nothing derived stored.
 */

/** A rate past this is a typo: even a 250/150 book doesn't lose three times its money in a year. */
export const MAX_RATE_MICRO = 3_000_000
/** How far ahead the manager's year figures may reach. */
export const MAX_FORECAST_YEARS = 10
const MAX_CENTS = 100_000_000_000_00
const MAX_SOURCE = 120
const DAY = 86400000
/** Whole calendar days from `a` to `b` (ISO days as UTC midnight: no DST). */
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const yearOf = (iso: string) => Number(iso.slice(0, 4))

type ProfileRow = Omit<HarvestProfile, 'years'>
type Owner = { id: number; name: string; kind: string; tracking: string }

const PROFILE = 'SELECT invest_account_id, as_of, year1_micro, year2_micro, later_micro, source FROM harvest_profiles'

function yearsOf(db: DbLike, accountId: number): HarvestProfile['years'] {
  return db.prepare('SELECT tax_year, loss_cents FROM harvest_forecasts WHERE invest_account_id = ? ORDER BY tax_year').all(accountId) as HarvestProfile['years']
}

/** One account's forecast, or null when none is entered. */
export function getHarvestProfile(db: DbLike, accountId: number): HarvestProfile | null {
  const r = (Number.isSafeInteger(accountId) ? db.prepare(`${PROFILE} WHERE invest_account_id = ?`).get(accountId) : undefined) as ProfileRow | undefined
  return r ? { ...r, years: yearsOf(db, r.invest_account_id) } : null
}

/** Every forecast, in account strip order, with the account it belongs to. */
export function listHarvestProfiles(db: DbLike): (HarvestProfile & { account: Owner })[] {
  const rows = db
    .prepare(
      `SELECT p.invest_account_id, p.as_of, p.year1_micro, p.year2_micro, p.later_micro, p.source, ia.id, ia.name, ia.kind, ia.tracking
       FROM harvest_profiles p JOIN invest_accounts ia ON ia.id = p.invest_account_id ORDER BY ia.sort, ia.id`,
    )
    .all() as (ProfileRow & Owner)[]
  return rows.map(({ id, name, kind, tracking, ...p }) => ({ ...p, years: yearsOf(db, p.invest_account_id), account: { id, name, kind, tracking } }))
}

function owner(db: DbLike, id: number): Owner {
  const a = (Number.isSafeInteger(id) && id > 0 ? db.prepare('SELECT id, name, kind, tracking FROM invest_accounts WHERE id = ?').get(id) : undefined) as
    | Owner
    | undefined
  if (!a) notFound('no such investment account')
  return a!
}

const sameYears = (a: HarvestProfile['years'], b: HarvestProfile['years']) =>
  a.length === b.length && a.every((y, i) => y.tax_year === b[i]!.tax_year && y.loss_cents === b[i]!.loss_cents)

/**
 * Set an account's forecast: the estimate's day, the three rates (micro,
 * 1e6 = 100%), where it came from, and the manager's figures by tax year
 * (positive cents of net loss; a year may be left out). Replaces what was
 * there; the same forecast again writes nothing.
 */
export function putHarvestProfile(db: DbLike, accountId: number, b: Partial<Record<keyof HarvestProfileBody, unknown>>, today: string) {
  const a = owner(db, accountId)
  if (a.tracking !== 'balance')
    bad(`${a.name} tracks trades — its realized gains come from the sales recorded there; a harvest forecast is for a managed account tracked by balance`)
  if (a.kind === 'retirement') bad(`sales inside ${a.name} are tax-advantaged and never reach the return — nothing to forecast`)
  const asOf = b.asOf
  if (typeof asOf !== 'string' || !isRealIsoDay(asOf)) bad('asOf must be a real yyyy-mm-dd day — the day the estimate was given')
  if ((asOf as string) > today) bad(`asOf must be on or before today (${today})`)
  if ((asOf as string) < '1900-01-01') bad('asOf must be a day since 1900')
  const rates: Record<'year1Micro' | 'year2Micro' | 'laterMicro', number> = { year1Micro: 0, year2Micro: 0, laterMicro: 0 }
  for (const k of ['year1Micro', 'year2Micro', 'laterMicro'] as const) {
    const v = b[k]
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > MAX_RATE_MICRO)
      bad(`${k} must be a whole number of micro from 0 to ${MAX_RATE_MICRO} (1000000 = 100%)`)
    rates[k] = v as number
  }
  let source: string | null = null
  if (b.source !== undefined && b.source !== null) {
    if (typeof b.source !== 'string') bad('source must be text')
    source = (b.source as string).trim().slice(0, MAX_SOURCE) || null
  }
  const asOfYear = yearOf(asOf as string)
  const years: HarvestProfile['years'] = []
  if (b.years !== undefined && b.years !== null) {
    if (!Array.isArray(b.years) || b.years.length > MAX_FORECAST_YEARS) bad(`years must list at most ${MAX_FORECAST_YEARS} tax years`)
    const seen = new Set<number>()
    for (const y of b.years as { taxYear?: unknown; lossCents?: unknown }[]) {
      const ty = typeof y?.taxYear === 'string' && /^\d{4}$/.test(y.taxYear) ? Number(y.taxYear) : y?.taxYear
      if (!Number.isSafeInteger(ty) || (ty as number) < asOfYear || (ty as number) > asOfYear + MAX_FORECAST_YEARS)
        bad(`each year's taxYear must be a whole year from ${asOfYear} (the estimate's) to ${asOfYear + MAX_FORECAST_YEARS}`)
      if (!Number.isSafeInteger(y.lossCents) || (y.lossCents as number) < 0 || (y.lossCents as number) > MAX_CENTS)
        bad(`${ty}: lossCents must be a whole number of cents, zero or more (the expected net loss)`)
      if (seen.has(ty as number)) bad(`${ty} is listed twice`)
      seen.add(ty as number)
      years.push({ tax_year: ty as number, loss_cents: y.lossCents as number })
    }
    years.sort((x, y) => x.tax_year - y.tax_year)
  }
  const cur = getHarvestProfile(db, a.id)
  const changed =
    !cur ||
    cur.as_of !== asOf ||
    cur.year1_micro !== rates.year1Micro ||
    cur.year2_micro !== rates.year2Micro ||
    cur.later_micro !== rates.laterMicro ||
    cur.source !== source ||
    !sameYears(cur.years, years)
  if (changed)
    db.transaction(() => {
      db.prepare(
        `INSERT INTO harvest_profiles (invest_account_id, as_of, year1_micro, year2_micro, later_micro, source) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (invest_account_id) DO UPDATE SET as_of = excluded.as_of, year1_micro = excluded.year1_micro,
           year2_micro = excluded.year2_micro, later_micro = excluded.later_micro, source = excluded.source`,
      ).run(a.id, asOf, rates.year1Micro, rates.year2Micro, rates.laterMicro, source)
      db.prepare('DELETE FROM harvest_forecasts WHERE invest_account_id = ?').run(a.id)
      const ins = db.prepare('INSERT INTO harvest_forecasts (invest_account_id, tax_year, loss_cents) VALUES (?, ?, ?)')
      for (const y of years) ins.run(a.id, y.tax_year, y.loss_cents)
    })()
  return { ok: true as const, changed, profile: getHarvestProfile(db, a.id)! }
}

export function deleteHarvestProfile(db: DbLike, accountId: number) {
  const a = owner(db, accountId)
  const cur = getHarvestProfile(db, a.id)
  if (!cur) notFound(`no harvest forecast is entered for ${a.name}`)
  db.transaction(() => {
    db.prepare('DELETE FROM harvest_forecasts WHERE invest_account_id = ?').run(a.id)
    db.prepare('DELETE FROM harvest_profiles WHERE invest_account_id = ?').run(a.id)
  })()
  return { ok: true as const, removed: cur! }
}

/* ---------- the schedule ---------- */

/** An expected loss spread evenly over the days from `from` through `through` (inclusive). */
export type LossWindow = { from: string; through: string; cents: number; what: 'stated' | 'extrapolated' | 'deposit' }

export type ScheduleInput = {
  profile: Pick<HarvestProfile, 'as_of' | 'year1_micro' | 'year2_micro' | 'later_micro' | 'years'>
  /** Deposits (positive) and withdrawals, in any order; planned ones included. */
  flows: readonly { flowed_on: string; amount_cents: number }[]
  /** The balance the manager was looking at: the latest recorded on or before as_of, else the latest at all; null when none. */
  balanceCents: number | null
  /** The last tax year the schedule has to reach. */
  throughYear: number
}

/**
 * The windows an account's expected losses fall in, from the estimate's day
 * through `throughYear`. Pure: the same inputs give the same windows.
 */
export function lossSchedule(i: ScheduleInput): { windows: LossWindow[]; notes: string[] } {
  const p = i.profile
  const windows: LossWindow[] = []
  const notes: string[] = []
  const asOfYear = yearOf(p.as_of)
  const stated = new Map(p.years.map((y) => [y.tax_year, y.loss_cents]))
  const filled: number[] = []
  const missing: number[] = []
  for (let y = asOfYear; y <= i.throughYear; y++) {
    const from = y === asOfYear ? p.as_of : `${y}-01-01`
    const through = `${y}-12-31`
    const cents = stated.get(y)
    if (cents !== undefined) windows.push({ from, through, cents, what: 'stated' })
    else if (i.balanceCents !== null && i.balanceCents > 0) {
      windows.push({ from, through, cents: Math.round((i.balanceCents * p.later_micro) / 1_000_000), what: 'extrapolated' })
      filled.push(y)
    } else missing.push(y)
  }
  if (filled.length) notes.push(`No figure for ${filled.join(', ')}: the standing book is taken at the later rate on its balance as of the estimate.`)
  if (missing.length) notes.push(`No figure for ${missing.join(', ')} and no balance recorded by the estimate's day, so nothing is expected from the standing book then.`)

  let inEstimate = 0
  let withdrawals = 0
  const horizon = `${i.throughYear}-12-31`
  const sorted = [...i.flows].sort((a, b) => a.flowed_on.localeCompare(b.flowed_on))
  for (const f of sorted) {
    if (f.amount_cents < 0) {
      withdrawals++
      continue
    }
    if (f.flowed_on <= p.as_of) {
      inEstimate++
      continue
    }
    if (f.flowed_on > horizon) continue
    const rate = (k: number) => (k === 0 ? p.year1_micro : k === 1 ? p.year2_micro : p.later_micro)
    for (let k = 0; ; k++) {
      const from = addMonthsIso(f.flowed_on, 12 * k)
      if (from > horizon) break
      const through = addDaysIso(addMonthsIso(f.flowed_on, 12 * (k + 1)), -1)
      windows.push({ from, through, cents: Math.round((f.amount_cents * rate(k)) / 1_000_000), what: 'deposit' })
    }
  }
  if (inEstimate) notes.push(`${inEstimate} deposit${inEstimate === 1 ? '' : 's'} on or before the estimate's day ${inEstimate === 1 ? 'is' : 'are'} already in the manager's figures.`)
  if (withdrawals) notes.push(`${withdrawals} withdrawal${withdrawals === 1 ? '' : 's'} recorded; a withdrawal doesn't reduce the forecast.`)
  return { windows, notes }
}

/** Expected losses (positive cents) over the days after `after` through `through`, each window spread evenly by day. */
export function lossBetween(windows: readonly LossWindow[], after: string, through: string): number {
  if (through <= after) return 0
  const first = addDaysIso(after, 1)
  let sum = 0
  for (const w of windows) {
    const lo = first > w.from ? first : w.from
    const hi = through < w.through ? through : w.through
    if (hi < lo) continue
    sum += (w.cents * (daysBetween(lo, hi) + 1)) / (daysBetween(w.from, w.through) + 1)
  }
  return Math.round(sum)
}

/* ---------- per account ---------- */

export type AccountForecast = {
  accountId: number
  account: string
  profile: HarvestProfile
  /** This year's realized figure as the broker reported it (short + long, negative for a loss) and the day it runs through; null when none. */
  reported: { cents: number; asOf: string } | null
  /** The day the forecast takes over this year: the reported figure's, or the estimate's, whichever is later. */
  from: string
  windows: LossWindow[]
  /** Expected further net losses by tax year (positive cents): this year after `from`, later years whole. */
  byYear: { year: number; cents: number }[]
  balanceCents: number | null
  balanceOn: string | null
  notes: string[]
}

/** The day whose end this year's expected losses count from. */
export function forecastAfter(f: Pick<AccountForecast, 'from'>, year: number, thisYear: number): string {
  const prev = `${year - 1}-12-31`
  return year === thisYear && f.from > prev ? f.from : prev
}

/**
 * Every taxable balance account's forecast, `thisYear` through `throughYear`.
 * An account whose kind has since changed to retirement is left out: its
 * gains never reach the return.
 */
export function accountForecasts(db: DbLike, today: string, throughYear: number): AccountForecast[] {
  const thisYear = yearOf(today)
  const out: AccountForecast[] = []
  const flowsOf = db.prepare('SELECT flowed_on, amount_cents FROM account_flows WHERE invest_account_id = ? ORDER BY flowed_on')
  const balanceBy = db.prepare(
    'SELECT balance_cents, balanced_on FROM balance_snapshots WHERE invest_account_id = ? AND balanced_on <= ? ORDER BY balanced_on DESC LIMIT 1',
  )
  const balanceAny = db.prepare('SELECT balance_cents, balanced_on FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on DESC LIMIT 1')
  const reportedOf = db.prepare('SELECT st_cents + lt_cents AS cents, as_of FROM realized_reported WHERE invest_account_id = ? AND tax_year = ?')
  for (const { account, ...profile } of listHarvestProfiles(db)) {
    if (account.tracking !== 'balance' || account.kind === 'retirement') continue
    const flows = flowsOf.all(account.id) as { flowed_on: string; amount_cents: number }[]
    const bal = ((balanceBy.get(account.id, profile.as_of) ?? balanceAny.get(account.id)) as { balance_cents: number; balanced_on: string } | undefined) ?? null
    const rep = (reportedOf.get(account.id, thisYear) as { cents: number; as_of: string } | undefined) ?? null
    const { windows, notes } = lossSchedule({ profile, flows, balanceCents: bal?.balance_cents ?? null, throughYear })
    const reported = rep ? { cents: rep.cents, asOf: rep.as_of } : null
    const from = reported && reported.asOf > profile.as_of ? reported.asOf : profile.as_of
    if (reported && reported.asOf < profile.as_of)
      notes.push(`The broker's figure runs through ${reported.asOf}, the estimate from ${profile.as_of}: nothing is expected for the days between.`)
    const f: Omit<AccountForecast, 'byYear'> = {
      accountId: account.id,
      account: account.name,
      profile,
      reported,
      from,
      windows,
      balanceCents: bal?.balance_cents ?? null,
      balanceOn: bal?.balanced_on ?? null,
      notes,
    }
    const byYear: AccountForecast['byYear'] = []
    for (let y = thisYear; y <= throughYear; y++) byYear.push({ year: y, cents: lossBetween(windows, forecastAfter(f, y, thisYear), `${y}-12-31`) })
    out.push({ ...f, byYear })
  }
  return out
}

/** Expected further net losses in one tax year across every forecast (positive cents). */
export function forecastLossIn(forecasts: readonly AccountForecast[], year: number): number {
  let sum = 0
  for (const f of forecasts) sum += f.byYear.find((y) => y.year === year)?.cents ?? 0
  return sum
}
