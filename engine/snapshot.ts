import type { DbLike, Stmt } from './db'
import { CURRENT_VERSION, readabilityError, SNAPSHOT_COMPAT, upgradesFor, type Compat } from './upgrades'

/**
 * Whole-database snapshots as plain JSON — the interchange format between
 * server, browser engine, vault blobs, and export files. Tables are listed in
 * FK-safe insert order; columns come from the rows themselves (every export
 * row carries every column, SELECT * semantics).
 *
 * A snapshot is household DATA only. Some things live in the same database but
 * are deliberately not part of it:
 *   - vault_blobs and vault_history: the courier's ciphertext. A snapshot is
 *     what goes INTO the vault; carrying earlier blobs along would nest
 *     ciphertext in every backup and a restore would roll the vault's version
 *     back.
 *   - basket_quotes and the basket:* keys in app_meta: shared price
 *     infrastructure (server/basket.ts), not anyone's data.
 *   - household_members and vault_invites: which identities share a vault, or
 *     have been asked to — routing for the courier, meaningful only to the
 *     deployment that stores the ciphertext.
 *   - onchain_daily: BTC on-chain metrics from migration 9. Nothing has ever
 *     written or read it; the table stays (migrations are append-only) but it
 *     is no longer carried. An older snapshot's rows for it are ignored.
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
/** BASKET_META for a row in hand (LIKE is case-insensitive for ASCII). */
const isBasketKey = (key: unknown) => typeof key === 'string' && key.slice(0, 7).toLowerCase() === 'basket:'

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
  // Check every row before the first write, so a bad snapshot fails with the
  // database untouched (and a tab stays clean).
  // The basket:* keys belong to the server's price basket and market history,
  // never to a snapshot: dumpDb leaves them out, and a snapshot that carries
  // one anyway must not overwrite (or collide with) the server's.
  const tables = TABLES.map((t) => {
    const rows = checkedRows(db, t, shaped.tables[t])
    return { t, rows: t === 'app_meta' ? rows.filter((r) => !isBasketKey(r.key)) : rows }
  })
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const t of [...TABLES].reverse())
        db.prepare(t === 'app_meta' ? `DELETE FROM app_meta WHERE NOT (${BASKET_META})` : `DELETE FROM ${t}`).run()
      for (const { t, rows } of tables) {
        // Each row is inserted with its own keys: a key a row lacks takes the
        // column's DEFAULT, never a NULL borrowed from another row's shape.
        const inserts = new Map<string, Stmt>()
        for (const row of rows) {
          const cols = Object.keys(row)
          const shape = cols.join(',')
          let insert = inserts.get(shape)
          if (!insert) {
            insert = db.prepare(`INSERT INTO ${t} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
            inserts.set(shape, insert)
          }
          insert.run(...cols.map((c) => row[c] ?? null))
        }
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

/**
 * One table's rows from a snapshot, checked against the live schema. Row keys
 * become SQL identifiers, so every key that ANY row carries (the union, not
 * just the first row's) must be a column the table really has
 * (PRAGMA table_info). Values must be what both engines bind the same way:
 * null, a string, or a finite number.
 */
function checkedRows(db: DbLike, table: string, rows: unknown): Record<string, unknown>[] {
  if (rows === undefined || rows === null) return []
  if (!Array.isArray(rows)) throw new Error(`snapshot table ${table} is not a list of rows`)
  if (rows.length === 0) return []
  const known = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
  for (const row of rows) {
    if (typeof row !== 'object' || row === null || Array.isArray(row) || Object.keys(row).length === 0)
      throw new Error(`snapshot has a malformed row in ${table}`)
    for (const [c, v] of Object.entries(row as Record<string, unknown>)) {
      if (!known.has(c)) throw new Error(`snapshot has an unknown column: ${table}.${c}`)
      if (!(v === null || v === undefined || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))))
        throw new Error(`snapshot has a malformed value in ${table}.${c}`)
    }
  }
  return rows as Record<string, unknown>[]
}

/** A validated column name, quoted anyway: belt and braces for an identifier built from data. */
const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`
