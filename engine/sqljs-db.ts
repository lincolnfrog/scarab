import initSqlJs, { type Database as SqlJsDatabase, type Statement } from 'sql.js'
import type { DbLike, Stmt } from './db'

/**
 * sql.js (SQLite compiled to WASM) adapted to the DbLike seam. Runs the same
 * engine code as better-sqlite3 does on the server — in any browser tab, or in
 * Node for the parity tests. The database lives in memory; persistence is
 * export() → encrypt → vault.
 */
export type BrowserDb = DbLike & { export(): Uint8Array; close(): void }

class SqlJsStmt implements Stmt {
  constructor(
    private db: SqlJsDatabase,
    private stmt: Statement,
  ) {}

  private bindAll(params: unknown[]) {
    this.stmt.reset()
    if (params.length > 0) this.stmt.bind(params as never)
  }

  get(...params: unknown[]): unknown {
    this.bindAll(params)
    if (!this.stmt.step()) return undefined
    return this.stmt.getAsObject()
  }

  all(...params: unknown[]): unknown[] {
    this.bindAll(params)
    const rows: unknown[] = []
    while (this.stmt.step()) rows.push(this.stmt.getAsObject())
    return rows
  }

  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number } {
    this.bindAll(params)
    this.stmt.step()
    this.stmt.reset()
    const rowid = this.db.exec('SELECT last_insert_rowid() AS id')
    return {
      lastInsertRowid: Number(rowid[0]?.values[0]?.[0] ?? 0),
      changes: this.db.getRowsModified(),
    }
  }
}

class SqlJsDb implements DbLike {
  constructor(private db: SqlJsDatabase) {}

  prepare(sql: string): Stmt {
    return new SqlJsStmt(this.db, this.db.prepare(sql))
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
    return this.db.export()
  }

  close(): void {
    this.db.close()
  }
}

/** Open an in-memory browser database, optionally from exported bytes. */
export async function openBrowserDb(opts: { wasmUrl?: string; bytes?: Uint8Array } = {}): Promise<BrowserDb> {
  const SQL = await initSqlJs(opts.wasmUrl ? { locateFile: () => opts.wasmUrl! } : undefined)
  return new SqlJsDb(new SQL.Database(opts.bytes ?? null) as SqlJsDatabase) as unknown as BrowserDb
}
