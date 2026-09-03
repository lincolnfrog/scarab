import type { DbLike } from './db'
import { migrations } from './migrations'

/**
 * Whole-database snapshots as plain JSON — the interchange format between
 * server, browser engine, vault blobs, and export files. Tables are listed in
 * FK-safe insert order; columns come from the rows themselves (every export
 * row carries every column, SELECT * semantics).
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
  'loan_options',
  'scenarios',
  'vault_blobs',
] as const

export type Dump = {
  scarab: true
  schemaVersion: number
  exportedAt: string
  tables: Record<string, Record<string, unknown>[]>
}

export function dumpDb(db: DbLike): Dump {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const t of TABLES) tables[t] = db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[]
  return { scarab: true, schemaVersion: migrations.length, exportedAt: new Date().toISOString(), tables }
}

/** Replace every row of data with the dump's contents. Schema must match. */
export function loadDump(db: DbLike, dump: Dump): void {
  if (!dump.scarab || !dump.tables) throw new Error('not a Scarab export')
  if (dump.schemaVersion !== migrations.length)
    throw new Error(`schema mismatch: export is v${dump.schemaVersion}, engine is v${migrations.length}`)
  db.pragma('foreign_keys = OFF')
  try {
    db.transaction(() => {
      for (const t of [...TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run()
      for (const t of TABLES) {
        const rows = dump.tables[t] ?? []
        if (rows.length === 0) continue
        const cols = Object.keys(rows[0]!)
        const insert = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        for (const row of rows) insert.run(...cols.map((c) => (row[c] === undefined ? null : row[c])))
      }
    })()
  } finally {
    db.pragma('foreign_keys = ON')
  }
}
