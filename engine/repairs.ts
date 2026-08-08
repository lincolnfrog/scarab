import type { DbLike } from './db'
import { sha1Hex } from './hash'
import { categorize, type Rule } from './import'

const norm = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').trim()

/**
 * One-off repair: before the debit/credit magnitude fix, Citi-style CSVs
 * recorded card payments (negative credits) as outflows, double-counting every
 * autopay. Flip those rows positive and recompute their dedupe hashes to
 * exactly what the fixed parser would produce, so re-imports still dedupe.
 */
function repairCardPaymentSigns(db: DbLike): number {
  const done = db.prepare("SELECT value FROM app_meta WHERE key = 'repair:card-payment-signs'").get()
  if (done) return 0
  const rows = db
    .prepare(
      `SELECT id, account_id, posted_on, amount_cents, description FROM transactions
       WHERE amount_cents < 0 AND (
         UPPER(description) LIKE 'AUTOPAY%AUTO-PMT%' OR
         UPPER(description) LIKE '%PAYMENT, THANK YOU%' OR
         UPPER(description) LIKE '%PAYMENT THANK YOU%' OR
         UPPER(description) LIKE 'AUTOMATIC PAYMENT%')`,
    )
    .all() as { id: number; account_id: number; posted_on: string; amount_cents: number; description: string }[]

  const update = db.prepare('UPDATE transactions SET amount_cents = ?, dedupe_hash = ? WHERE id = ?')
  const exists = db.prepare(
    'SELECT 1 FROM transactions WHERE account_id = ? AND dedupe_hash = ? AND id != ?',
  )
  db.transaction(() => {
    const ordinals = new Map<string, number>()
    for (const r of rows.sort((a, b) => a.id - b.id)) {
      const cents = -r.amount_cents
      const base = sha1Hex(`${r.posted_on}|${cents}|${norm(r.description)}`).slice(0, 20)
      const key = `${r.account_id}|${base}`
      let ord = ordinals.get(key) ?? 0
      let hash = `${base}#${ord}`
      while (exists.get(r.account_id, hash, r.id)) {
        ord++
        hash = `${base}#${ord}`
      }
      ordinals.set(key, ord + 1)
      update.run(cents, hash, r.id)
    }
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('repair:card-payment-signs', datetime('now'))").run()
  })()
  return rows.length
}

/** Newly seeded rules should reach existing rows: file anything uncategorized. */
function applyRulesToUncategorized(db: DbLike): number {
  const rules = db.prepare('SELECT id, pattern, category_id, priority FROM rules').all() as Rule[]
  const rows = db
    .prepare('SELECT id, description FROM transactions WHERE category_id IS NULL')
    .all() as { id: number; description: string }[]
  const set = db.prepare('UPDATE transactions SET category_id = ?, categorized_by = ? WHERE id = ?')
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const rule = categorize(r.description, rules)
      if (rule) {
        set.run(rule.category_id, `rule:${rule.id}`, r.id)
        n++
      }
    }
  })()
  return n
}

export function runRepairs(db: DbLike): { signsFlipped: number; rulesApplied: number } {
  return { signsFlipped: repairCardPaymentSigns(db), rulesApplied: applyRulesToUncategorized(db) }
}
