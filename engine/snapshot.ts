import type { DbLike } from './db'
import { CURRENT_VERSION, readabilityError, SNAPSHOT_COMPAT, upgradesFor, type Compat } from './upgrades'

/**
 * Whole-database snapshots as plain JSON — the interchange format between
 * server, browser engine, vault blobs, and export files. Tables are listed in
 * FK-safe insert order; columns come from the rows themselves (every export
 * row carries every column, SELECT * semantics).
 *
 * A snapshot is household DATA only. Two things live in the same database but
 * are deliberately not part of it:
 *   - vault_blobs: the courier's ciphertext. A snapshot is what goes INTO the
 *     vault; carrying the previous blob along would nest ciphertext in every
 *     backup and a restore would roll the vault's version back.
 *   - basket_quotes and the basket:* keys in app_meta: shared price
 *     infrastructure (server/basket.ts), not anyone's data.
 *   - household_members: which identities share a vault — routing for the
 *     courier, meaningful only to the deployment that stores the ciphertext.
 */
export const TABLES = [
  'app_meta',
  'accounts',
  'categories',
  'imports',
  'transactions',
  'rules',
  'budgets',
  'invest_accounts',
  'assets',
  'trades',
  'prices',
  'prices_daily',
  'onchain_daily',
  'balance_snapshots',
  'properties',
  'property_valuations',
  'liabilities',
  'liability_balances',
  'rsu_vests',
  'unvested_positions',
  'goal_settings',
  'pay_sources',
  'loan_options',
  'scenarios',
] as const

export type Dump = {
  scarab: true
  schemaVersion: number
  exportedAt: string
  tables: Record<string, Record<string, unknown>[]>
}

/** app_meta rows that belong to the server's price basket, never to a snapshot. */
const BASKET_META = "key LIKE 'basket:%'"

export function dumpDb(db: DbLike): Dump {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const t of TABLES)
    tables[t] = db
      .prepare(t === 'app_meta' ? `SELECT * FROM app_meta WHERE NOT (${BASKET_META})` : `SELECT * FROM ${t}`)
      .all() as Record<string, unknown>[]
  return { scarab: true, schemaVersion: CURRENT_VERSION, exportedAt: new Date().toISOString(), tables }
}

/**
 * Replace every row of data with the dump's contents.
 *
 * `db` must already be migrated to this engine's schema; the dump may have been
 * written by an older one, as far back as `compat.minReadable`. Columns come
 * from the rows themselves, so a column added since the dump was written simply
 * takes its DEFAULT. Anything else the dump needs to cross the gap is in
 * `compat.upgrades` (see engine/upgrades.ts): every `before` newer than the
 * dump reshapes it ahead of the insert, every `after` repairs rows once they
 * are in — the row work all inside one transaction, so a failing upgrade
 * leaves the database exactly as it was. Ciphertext and basket rows are left
 * alone (see TABLES).
 *
 * `compat` is injectable so the machinery can be tested without a shipped
 * entry; callers use the default.
 *
 * Returns which upgrades ran, so callers can say so out loud.
 */
export function loadDump(db: DbLike, dump: Dump, compat: Compat = SNAPSHOT_COMPAT): { from: number; upgraded: number[] } {
  if (!dump.scarab || !dump.tables) throw new Error('not a Scarab export')
  const why = readabilityError(dump.schemaVersion, compat)
  if (why) throw new Error(why)
  const plan = upgradesFor(dump.schemaVersion, compat)
  // Reshape first, outside the transaction: pure JSON, and a transform that
  // throws must leave the database untouched.
  let shaped = dump
  for (const { upgrade } of plan) if (upgrade.before) shaped = upgrade.before(shaped)
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const t of [...TABLES].reverse())
        db.prepare(t === 'app_meta' ? `DELETE FROM app_meta WHERE NOT (${BASKET_META})` : `DELETE FROM ${t}`).run()
      for (const t of TABLES) {
        const rows = shaped.tables[t] ?? []
        if (rows.length === 0) continue
        const cols = Object.keys(rows[0]!)
        const insert = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        for (const row of rows) insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c])))
      }
      // Older snapshot: bring its ROWS up to what this schema expects. Never
      // opens its own transaction — sql.js can't nest one.
      for (const { upgrade } of plan) upgrade.after?.(db)
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
  return { from: dump.schemaVersion, upgraded: plan.map((u) => u.version) }
}
