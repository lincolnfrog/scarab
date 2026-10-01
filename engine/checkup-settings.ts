import type { CheckupSettings, ResolvedRole } from '../shared/checkup-api'
import type { DbLike } from './db'
import { bad } from './errors'

/**
 * The Checkup's one settings blob (goal_settings 'checkup', household data,
 * rides the snapshot): the concentration threshold and which expense
 * categories play the roles the tax findings read — charitable giving,
 * property tax, gifts to people. A role left unset (null) is guessed from the
 * category names, so a household with a "Giving" category gets the itemized
 * and appreciated-shares findings without touching a setting; 0 turns a role
 * off.
 */

export const CHECKUP_DEFAULTS: CheckupSettings = {
  concentrationMicro: 100_000,
  charityCategoryId: null,
  propertyTaxCategoryId: null,
  giftCategoryId: null,
}

const KEY = 'checkup'

export function getCheckupSettings(db: DbLike): CheckupSettings {
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(KEY) as { value: string } | undefined
  if (!row) return { ...CHECKUP_DEFAULTS }
  try {
    return { ...CHECKUP_DEFAULTS, ...(JSON.parse(row.value) as Partial<CheckupSettings>) }
  } catch {
    return { ...CHECKUP_DEFAULTS }
  }
}

const ROLE_KEYS = ['charityCategoryId', 'propertyTaxCategoryId', 'giftCategoryId'] as const

export function putCheckupSettings(db: DbLike, body: Partial<Record<keyof CheckupSettings, unknown>>) {
  const next = getCheckupSettings(db)
  if (body.concentrationMicro !== undefined) {
    const v = body.concentrationMicro
    if (!Number.isSafeInteger(v) || (v as number) < 10_000 || (v as number) > 1_000_000)
      bad('concentrationMicro must be an integer from 10000 (1%) to 1000000 (100%)')
    next.concentrationMicro = v as number
  }
  for (const k of ROLE_KEYS) {
    const v = body[k]
    if (v === undefined) continue
    if (v === null || v === 0) {
      next[k] = v
      continue
    }
    if (!Number.isSafeInteger(v) || !db.prepare("SELECT id FROM categories WHERE id = ? AND kind = 'expense'").get(v))
      bad(`${k} must be null (guess), 0 (none) or an expense category id`)
    next[k] = v as number
  }
  db.prepare(
    'INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(KEY, JSON.stringify(next))
  return { ok: true as const, settings: next }
}

/** What each role's name usually looks like, for households that never set one. */
const GUESS: Record<'charity' | 'propertyTax' | 'gift', RegExp> = {
  charity: /\b(giving|charit|donat|tithe|church)/i,
  propertyTax: /\bproperty\s*tax/i,
  gift: /^gifts?\b(?!\s*card)/i,
}

export type Roles = { charity: ResolvedRole; propertyTax: ResolvedRole; gift: ResolvedRole }

/** Resolve each role to a category: the one set, or the first expense category whose name fits, or none. */
export function resolveRoles(db: DbLike, s: CheckupSettings = getCheckupSettings(db)): Roles {
  const cats = db.prepare("SELECT id, name FROM categories WHERE kind = 'expense' ORDER BY sort, id").all() as { id: number; name: string }[]
  const one = (set: number | null, guess: RegExp): ResolvedRole => {
    if (set === 0) return null
    if (set !== null) {
      const c = cats.find((x) => x.id === set)
      if (c) return { id: c.id, name: c.name, guessed: false }
      // A category since deleted falls back to guessing, like an unset role.
    }
    const c = cats.find((x) => guess.test(x.name))
    return c ? { id: c.id, name: c.name, guessed: true } : null
  }
  return {
    charity: one(s.charityCategoryId, GUESS.charity),
    propertyTax: one(s.propertyTaxCategoryId, GUESS.propertyTax),
    gift: one(s.giftCategoryId, GUESS.gift),
  }
}

/**
 * Net spending in a category over (from, through] — outflows less refunds,
 * never below zero. Transfers never land in an expense category, so this is
 * the money that left the household for it.
 */
export function categorySpend(db: DbLike, categoryId: number, fromExclusive: string, through: string): number {
  const r = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS s FROM transactions WHERE category_id = ? AND posted_on > ? AND posted_on <= ?')
    .get(categoryId, fromExclusive, through) as { s: number }
  return Math.max(0, -r.s)
}
