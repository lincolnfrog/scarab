/**
 * The database seam. Engine code depends on this minimal synchronous
 * interface; better-sqlite3 satisfies it structurally on the server and
 * engine/sqljs-db.ts adapts sql.js (WASM) to it in the browser. Keep it
 * boring: anything fancier belongs in the callers.
 */
export interface Stmt {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { lastInsertRowid: number | bigint; changes: number }
}

export interface DbLike {
  prepare(sql: string): Stmt
  exec(sql: string): unknown
  transaction<T>(fn: () => T): () => T
  pragma(src: string): unknown
}
