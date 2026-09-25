import type { DbLike } from './db'
import { sha1Hex } from './hash'
import { categorize, hashBase, splitCashBack, type Rule } from './import'

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

/**
 * Cash-back purchases imported before the parser split them (splitCashBack)
 * are one row carrying the cash too. Split them the same way: the row keeps
 * its category and becomes the purchase; the cash is a new row in the same
 * import, filed by the rules. Both get the dedupe hash a re-import of the
 * same file would compute, so it skips them. Idempotent — a split row no
 * longer matches.
 */
function splitCashBackRows(db: DbLike): number {
  const rows = db
    .prepare(
      `SELECT id, account_id, posted_on, amount_cents, description, import_id FROM transactions
       WHERE UPPER(description) LIKE 'PURCHASE WITH CASH BACK%' AND dedupe_hash NOT LIKE 'fitid:%'
       ORDER BY id`,
    )
    .all() as { id: number; account_id: number; posted_on: string; amount_cents: number; description: string; import_id: number | null }[]
  if (rows.length === 0) return 0
  const rules = db.prepare('SELECT id, pattern, category_id, priority FROM rules').all() as Rule[]
  const exists = db.prepare('SELECT 1 FROM transactions WHERE account_id = ? AND dedupe_hash = ?')
  const update = db.prepare('UPDATE transactions SET amount_cents = ?, description = ?, dedupe_hash = ? WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, categorized_by, import_id, dedupe_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const freeHash = (accountId: number, base: string) => {
    let ord = 0
    while (exists.get(accountId, `${base}#${ord}`)) ord++
    return `${base}#${ord}`
  }
  let n = 0
  db.transaction(() => {
    for (const r of rows) {
      const halves = splitCashBack([{ postedOn: r.posted_on, amountCents: r.amount_cents, description: r.description }])
      if (halves.length !== 2) continue
      const [purchase, cash] = halves as [(typeof halves)[0], (typeof halves)[0]]
      update.run(purchase.amountCents, purchase.description, freeHash(r.account_id, hashBase(purchase)), r.id)
      const rule = categorize(cash.description, rules)
      insert.run(r.account_id, r.posted_on, cash.amountCents, cash.description, rule?.category_id ?? null, rule ? `rule:${rule.id}` : null, r.import_id, freeHash(r.account_id, hashBase(cash)))
      n++
    }
  })()
  return n
}

export function runRepairs(db: DbLike): { signsFlipped: number; cashBackSplit: number; rulesApplied: number } {
  return { signsFlipped: repairCardPaymentSigns(db), cashBackSplit: splitCashBackRows(db), rulesApplied: applyRulesToUncategorized(db) }
}
