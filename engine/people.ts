import type { DbLike } from './db'
import { bad } from './errors'
import { listInvestOwners } from './invest'

/**
 * The people in the household, as far as the copilot needs them: a birth
 * year (catch-up eligibility now; the age axis and RMD age with Future v3)
 * and HSA coverage with the year's planned contributions (a paystub's
 * pre-tax benefits line lumps the HSA in with §125 premiums, so the HSA
 * figure is typed here instead). One settings blob (goal_settings 'people'),
 * household data, rides the snapshot.
 *
 * Who is listed comes from the ledger — every paycheck earner and every
 * account owner (listInvestOwners) — plus anyone already saved here, so a
 * person can be described before their first paycheck is entered.
 */

export type HsaCoverage = 'none' | 'self' | 'family'
export type Person = {
  name: string
  /** null = not entered: no catch-up is assumed. */
  birthYear: number | null
  hsaCoverage: HsaCoverage
  /** Planned HSA contributions this year, the employer's included. */
  hsaCents: number
}

const KEY = 'people'
const COVERAGES: readonly HsaCoverage[] = ['none', 'self', 'family']
const blank = (name: string): Person => ({ name, birthYear: null, hsaCoverage: 'none', hsaCents: 0 })
const keyOf = (name: string) => name.trim().toLowerCase()

function stored(db: DbLike): Person[] {
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return []
  try {
    const v = JSON.parse(row.value) as { people?: unknown }
    if (!Array.isArray(v.people)) return []
    return v.people.flatMap((p: Partial<Person>) => {
      if (typeof p?.name !== 'string' || !p.name.trim()) return []
      return [
        {
          name: p.name.trim(),
          birthYear: Number.isSafeInteger(p.birthYear) ? p.birthYear! : null,
          hsaCoverage: COVERAGES.includes(p.hsaCoverage as HsaCoverage) ? (p.hsaCoverage as HsaCoverage) : 'none',
          hsaCents: Number.isSafeInteger(p.hsaCents) && p.hsaCents! >= 0 ? p.hsaCents! : 0,
        },
      ]
    })
  } catch {
    return []
  }
}

/** Everyone the ledger names (earners, then account owners), then anyone saved here alone — each once, with what's saved for them. */
export function listPeople(db: DbLike): Person[] {
  const saved = new Map(stored(db).map((p) => [keyOf(p.name), p]))
  const out = new Map<string, Person>()
  for (const name of listInvestOwners(db)) out.set(keyOf(name), saved.get(keyOf(name)) ?? blank(name))
  for (const [k, p] of saved) if (!out.has(k)) out.set(k, p)
  return [...out.values()]
}

/** The saved entry for a name (case-insensitive), or a blank one. */
export function personNamed(people: Person[], name: string): Person {
  return people.find((p) => keyOf(p.name) === keyOf(name)) ?? blank(name.trim())
}

/** The age reached by Dec 31 of `year` — what catch-up eligibility goes by — or null with no birth year. */
export const ageInYear = (p: Pick<Person, 'birthYear'>, year: number): number | null => (p.birthYear === null ? null : year - p.birthYear)

/** PUT /api/people: replaces the saved list. Each entry needs a name; the rest default. */
export function putPeople(db: DbLike, body: { people?: unknown }, today: string) {
  if (!Array.isArray(body?.people)) bad('people must be a list')
  const thisYear = Number(today.slice(0, 4))
  const seen = new Set<string>()
  const next: Person[] = []
  for (const raw of body.people as Partial<Record<keyof Person, unknown>>[]) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 40) : ''
    if (!name) bad('each person needs a name')
    if (seen.has(keyOf(name))) bad(`${name} is listed twice`)
    seen.add(keyOf(name))
    const by = raw.birthYear ?? null
    if (by !== null && (!Number.isSafeInteger(by) || (by as number) < 1900 || (by as number) > thisYear))
      bad(`birthYear must be a year from 1900 to ${thisYear}, or null`)
    const cov = raw.hsaCoverage ?? 'none'
    if (!COVERAGES.includes(cov as HsaCoverage)) bad('hsaCoverage must be none, self or family')
    const hsa = raw.hsaCents ?? 0
    if (!Number.isSafeInteger(hsa) || (hsa as number) < 0) bad('hsaCents must be a non-negative integer')
    next.push({ name, birthYear: by as number | null, hsaCoverage: cov as HsaCoverage, hsaCents: hsa as number })
  }
  db.prepare(
    'INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(KEY, JSON.stringify({ people: next }))
  return { ok: true as const, people: listPeople(db) }
}
