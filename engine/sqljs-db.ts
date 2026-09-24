import initSqlJs, { type Database as SqlJsDatabase, type Statement } from 'sql.js'
import type { DbLike, Stmt } from './db'

/**
 * sql.js (SQLite compiled to WASM) adapted to the DbLike seam. Runs the same
 * engine code as better-sqlite3 does on the server — in any browser tab, or in
 * Node for the parity tests. The database lives in memory; persistence is
 * export() → encrypt → vault.
 */
export type BrowserDb = DbLike & {
  export(): Uint8Array
  close(): void
  /** sql.js statements currently allocated in WASM memory (tests and debugging). */
  liveStatements(): number
}

/**
 * How many compiled statements one database keeps. The engine's working set is
 * a few dozen distinct SQL strings, plus one per table for a snapshot load.
 */
export const STATEMENT_CACHE_SIZE = 256

/**
 * Compiled statements, keyed by SQL text, least recently used first.
 *
 * sql.js statements live in WASM memory until free() — the garbage collector
 * never reclaims them — so preparing on every call (which is how engine code
 * reads: `db.prepare(sql).get(…)`) used to leak one statement per call. Now a
 * prepare reuses the compiled statement for the same SQL, and the least
 * recently used is freed once the cache is full.
 *
 * A `Stmt` handed to a caller holds only its SQL and looks its statement up
 * here on every call, re-preparing if it was evicted meanwhile. So a caller
 * that holds a `Stmt` across a loop that prepares hundreds of others never
 * touches a freed statement. Sharing one compiled statement between two
 * `Stmt`s with the same SQL is safe because every get/all/run binds, steps and
 * resets within a single synchronous call: no statement is ever left
 * mid-iteration between calls.
 */
class StatementCache {
  private map = new Map<string, Statement>()

  constructor(
    private db: SqlJsDatabase,
    private capacity = STATEMENT_CACHE_SIZE,
  ) {}

  acquire(sql: string): Statement {
    const hit = this.map.get(sql)
    if (hit) {
      // Map keeps insertion order: re-inserting marks it most recently used.
      this.map.delete(sql)
      this.map.set(sql, hit)
      return hit
    }
    const stmt = this.db.prepare(sql) // throws on bad SQL, exactly as before
    this.map.set(sql, stmt)
    while (this.map.size > this.capacity) {
      const [oldSql, old] = this.map.entries().next().value as [string, Statement]
      this.map.delete(oldSql)
      old.free()
    }
    return stmt
  }

  /** Forget every entry without freeing: sql.js already freed them (export/close). */
  forget(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

class SqlJsStmt implements Stmt {
  constructor(
    private db: SqlJsDatabase,
    private cache: StatementCache,
    private sql: string,
  ) {}

  private bound(params: unknown[]): Statement {
    const stmt = this.cache.acquire(this.sql)
    stmt.reset()
    if (params.length > 0) stmt.bind(params as never)
    return stmt
  }

  get(...params: unknown[]): unknown {
    const stmt = this.bound(params)
    try {
      return stmt.step() ? stmt.getAsObject() : undefined
    } finally {
      // Never leave a statement mid-result: an active read would hold its
      // table open (DROP fails, COMMIT can complain) until the next call.
      stmt.reset()
    }
  }

  all(...params: unknown[]): unknown[] {
    const stmt = this.bound(params)
    try {
      // Not getAsObject per row: it asks WASM for every column's name again on
      // each row (a call and a string decode per column), which made reads —
      // a snapshot dump on every save among them — about 3× slower. The names
      // are read once; rows are built the way getAsObject builds them (a later
      // duplicate name wins).
      const rows: Record<string, unknown>[] = []
      let names: string[] | null = null
      while (stmt.step()) {
        names ??= stmt.getColumnNames()
        const values = stmt.get()
        const row: Record<string, unknown> = {}
        for (let i = 0; i < names.length; i++) row[names[i]!] = values[i]
        rows.push(row)
      }
      return rows
    } finally {
      stmt.reset()
    }
  }

  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number } {
    const stmt = this.bound(params)
    try {
      stmt.step()
    } finally {
      stmt.reset()
    }
    // Read both before anything else runs: getRowsModified is the last
    // completed write's count, last_insert_rowid the connection's.
    const changes = this.db.getRowsModified()
    const id = this.cache.acquire('SELECT last_insert_rowid() AS id')
    try {
      id.step()
      return { lastInsertRowid: Number(id.get()[0] ?? 0), changes }
    } finally {
      id.reset()
    }
  }
}

class SqlJsDb implements DbLike {
  private cache: StatementCache

  constructor(private db: SqlJsDatabase) {
    this.cache = new StatementCache(db)
  }

  prepare(sql: string): Stmt {
    this.cache.acquire(sql) // compile now, so bad SQL throws here (as better-sqlite3 does)
    return new SqlJsStmt(this.db, this.cache, sql)
  }

  exec(sql: string): unknown {
    this.db.exec(sql)
    return this
  }

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.run('BEGIN')
      try {
        const result = fn()
        this.db.run('COMMIT')
        return result
      } catch (e) {
        this.db.run('ROLLBACK')
        throw e
      }
    }
  }

  pragma(src: string): unknown {
    // journal_mode etc. are meaningless in-memory; apply and move on.
    try {
      this.db.run(`PRAGMA ${src}`)
    } catch {
      /* WAL and friends don't exist in sql.js — fine */
    }
    return undefined
  }

  export(): Uint8Array {
    // sql.js export() frees every prepared statement and re-opens the
    // database, which also resets pragmas to their defaults. Drop our handles
    // to the freed statements, and put foreign-key enforcement back the way
    // it was so the tab keeps matching the server after a save.
    const fk = (this.db.exec('PRAGMA foreign_keys')[0]?.values[0]?.[0] ?? 0) === 1
    this.cache.forget()
    try {
      return this.db.export()
    } finally {
      if (fk) this.db.run('PRAGMA foreign_keys = ON')
    }
  }

  close(): void {
    this.cache.forget() // close() frees them all
    this.db.close()
  }

  liveStatements(): number {
    // sql.js keeps its registry of unfreed statements under a property whose
    // name the minified builds mangle; find it by where a probe shows up.
    const probe = this.db.prepare('SELECT 1')
    try {
      for (const v of Object.values(this.db as unknown as Record<string, unknown>))
        if (v && typeof v === 'object' && Object.values(v).includes(probe)) return Object.keys(v).length - 1
    } finally {
      probe.free()
    }
    throw new Error('sql.js statement registry not found')
  }
}

/** Open an in-memory browser database, optionally from exported bytes. */
export async function openBrowserDb(opts: { wasmUrl?: string; bytes?: Uint8Array } = {}): Promise<BrowserDb> {
  const SQL = await initSqlJs(opts.wasmUrl ? { locateFile: () => opts.wasmUrl! } : undefined)
  return new SqlJsDb(new SQL.Database(opts.bytes ?? null) as SqlJsDatabase) as unknown as BrowserDb
}
