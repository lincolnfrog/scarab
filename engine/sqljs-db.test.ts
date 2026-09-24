import initSqlJs from 'sql.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { migrate } from './migrations'
import { type BrowserDb, openBrowserDb, STATEMENT_CACHE_SIZE } from './sqljs-db'

/**
 * The sql.js adapter's statement cache (bug #37: every prepare used to leak a
 * WASM statement until the tab closed).
 */
const open: BrowserDb[] = []
async function fresh(): Promise<BrowserDb> {
  const db = await openBrowserDb()
  open.push(db)
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)')
  return db
}
afterEach(() => {
  for (const db of open.splice(0)) db.close()
})

describe('sql.js statement cache', () => {
  it('10k prepares of the same SQL compile one statement', async () => {
    const db = await fresh()
    const base = db.liveStatements()
    for (let i = 0; i < 10_000; i++) db.prepare('SELECT count(*) AS n FROM t').get()
    expect(db.liveStatements() - base).toBe(1)
  })

  it('10k distinct SQL strings never keep more than the cache size alive', async () => {
    const db = await fresh()
    for (let i = 0; i < 10_000; i++) {
      expect((db.prepare(`SELECT ${i} AS n`).get() as { n: number }).n).toBe(i)
      if (i % 997 === 0) expect(db.liveStatements()).toBeLessThanOrEqual(STATEMENT_CACHE_SIZE)
    }
    expect(db.liveStatements()).toBeLessThanOrEqual(STATEMENT_CACHE_SIZE)
  })

  it('a Stmt held across 1,000 other prepares still works (re-prepared after eviction)', async () => {
    const db = await fresh()
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    const one = db.prepare('SELECT v FROM t WHERE id = ?')
    for (let i = 0; i < 1_000; i++) {
      db.prepare(`SELECT ${i} + 1 AS n`).get() // pushes `ins` and `one` out of the cache
      ins.run(`row ${i}`)
    }
    expect(db.liveStatements()).toBeLessThanOrEqual(STATEMENT_CACHE_SIZE)
    expect(one.get(1)).toEqual({ v: 'row 0' })
    expect(one.get(1000)).toEqual({ v: 'row 999' })
    expect((db.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(1000)
  })

  it('interleaves get/all/run on two Stmts that share one compiled statement', async () => {
    const db = await fresh()
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (const v of ['a', 'b', 'c']) ins.run(v)
    const a = db.prepare('SELECT v FROM t WHERE id >= ? ORDER BY id')
    const b = db.prepare('SELECT v FROM t WHERE id >= ? ORDER BY id') // same SQL, same cache entry
    expect(a.get(2)).toEqual({ v: 'b' })
    expect(b.all(1)).toEqual([{ v: 'a' }, { v: 'b' }, { v: 'c' }])
    expect(a.get(3)).toEqual({ v: 'c' }) // not the stale cursor b left behind
    expect(b.get(4)).toBeUndefined()
    // A loop that reads with one while writing through another.
    for (const row of a.all(1) as { v: string }[]) ins.run(`${row.v}2`)
    expect(b.all(4)).toEqual([{ v: 'a2' }, { v: 'b2' }, { v: 'c2' }])
  })

  it('run reports lastInsertRowid and changes like better-sqlite3', async () => {
    const db = await fresh()
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    expect(ins.run('x')).toEqual({ lastInsertRowid: 1, changes: 1 })
    expect(ins.run('y')).toEqual({ lastInsertRowid: 2, changes: 1 })
    expect(db.prepare("UPDATE t SET v = v || '!'").run()).toMatchObject({ changes: 2 })
    expect(db.prepare('DELETE FROM t WHERE id = ?').run(99)).toMatchObject({ changes: 0 })
  })

  it('bad SQL still throws at prepare time, and a failed step leaves the statement usable', async () => {
    const db = await fresh()
    expect(() => db.prepare('SELEC nope')).toThrow()
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    ins.run('dup')
    expect(() => ins.run('dup')).toThrow(/UNIQUE/)
    expect(ins.run('fine')).toMatchObject({ changes: 1 })
  })

  it('get() leaves no statement mid-result: a table read with get() can be dropped', async () => {
    const db = await fresh()
    db.prepare('INSERT INTO t (v) VALUES (?)').run('a')
    db.prepare('INSERT INTO t (v) VALUES (?)').run('b')
    expect(db.prepare('SELECT v FROM t ORDER BY id').get()).toEqual({ v: 'a' }) // one row of two read
    expect(() => db.exec('DROP TABLE t')).not.toThrow()
  })

  it('a rolled-back transaction leaves cached statements usable', async () => {
    const db = await fresh()
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    expect(() =>
      db.transaction(() => {
        ins.run('a')
        ins.run('a') // UNIQUE → rollback
      })(),
    ).toThrow()
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 })
    db.transaction(() => ins.run('b'))()
    expect(db.prepare('SELECT v FROM t').all()).toEqual([{ v: 'b' }])
  })

  it('export() frees sql.js statements; held Stmts re-prepare, and foreign keys stay enforced', async () => {
    const db = await openBrowserDb()
    open.push(db)
    migrate(db)
    const count = db.prepare('SELECT count(*) AS n FROM assets')
    expect(count.get()).toEqual({ n: 0 })
    const bytes = db.export()
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(count.get()).toEqual({ n: 0 }) // would throw "Statement closed" without the cache reset
    // Enforcement survives the re-open that export() does, as on the server.
    expect(() => db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (999, ?, 1)').run('2026-09-01')).toThrow(
      /FOREIGN KEY/,
    )
  })
})

describe('sql.js reads', () => {
  it("all() reads the column names once per call, not once per row, and builds the same rows getAsObject would", async () => {
    const db = await fresh()
    db.exec('ALTER TABLE t ADD COLUMN n INTEGER')
    db.exec('ALTER TABLE t ADD COLUMN b BLOB')
    const ins = db.prepare('INSERT INTO t (v, n, b) VALUES (?, ?, ?)')
    for (let i = 0; i < 200; i++) ins.run(`row ${i}`, i % 3 === 0 ? null : i * 7, i % 5 === 0 ? new Uint8Array([i, 1]) : null)
    // The adapter's statements share sql.js's Statement prototype (initSqlJs hands back one module).
    const SQL = await initSqlJs()
    const raw = new SQL.Database()
    const probe = raw.prepare('SELECT 1')
    const proto = Object.getPrototypeOf(probe) as { getColumnNames(): string[]; getAsObject(): unknown }
    probe.free()
    raw.close()
    const names = vi.spyOn(proto, 'getColumnNames')
    const perRow = vi.spyOn(proto, 'getAsObject')
    try {
      const rows = db.prepare('SELECT id, v, n, b, v AS v2, n AS v FROM t ORDER BY id').all() as Record<string, unknown>[]
      expect(perRow).not.toHaveBeenCalled()
      expect(names).toHaveBeenCalledTimes(1)
      expect(rows).toHaveLength(200)
      // A later duplicate name wins, as it does in getAsObject.
      expect(rows[1]).toEqual({ id: 2, v: 7, n: 7, b: null, v2: 'row 1' })
      expect(rows[0]).toEqual({ id: 1, v: null, n: null, b: new Uint8Array([0, 1]), v2: 'row 0' })
      names.mockClear()
      expect(db.prepare('SELECT v FROM t WHERE id > ?').all(1_000)).toEqual([])
      expect(names).not.toHaveBeenCalled()
    } finally {
      names.mockRestore()
      perRow.mockRestore()
    }
  })
})

describe('adapter parity with better-sqlite3', () => {
  it('the same statements give the same rows and run results on both engines', async () => {
    const server = openDb(':memory:') as unknown as DbLike & { close(): void }
    const browser = await openBrowserDb()
    open.push(browser)
    migrate(browser)
    try {
      const work = (db: DbLike) => {
        const ins = db.prepare("INSERT INTO assets (symbol, kind) VALUES (?, 'stock')")
        const runs = ['VTI', 'QQQ', 'SPY'].map((s) => ins.run(s))
        const px = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)')
        for (let i = 0; i < 250; i++) px.run((i % 3) + 1, `2026-${String((i % 9) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`, 1000 + i)
        const one = db.prepare('SELECT symbol FROM assets WHERE id = ?')
        return {
          runs: runs.map((r) => ({ id: Number(r.lastInsertRowid), changes: r.changes })),
          first: one.get(1),
          missing: one.get(42) ?? null,
          agg: db.prepare('SELECT asset_id, count(*) AS n, max(close_cents) AS hi FROM prices GROUP BY asset_id ORDER BY asset_id').all(),
        }
      }
      const s = work(server)
      expect(work(browser)).toEqual(s)
      expect(s.agg).toHaveLength(3) // not vacuous
    } finally {
      server.close()
    }
  })
})
