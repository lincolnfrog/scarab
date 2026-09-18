import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { migrate } from './migrations'
import { listInvestAccounts } from './services'
import { type Dump, dumpDb, loadDump } from './snapshot'
import { openBrowserDb } from './sqljs-db'
import { CURRENT_VERSION, type Compat, readabilityError, SNAPSHOT_COMPAT, upgradesFor } from './upgrades'

/**
 * Carrying a vault across migrations. In a zero-knowledge deployment the
 * snapshot IS the database, so "this engine can't read your snapshot" means
 * unreachable data.
 *
 * Two layers here. The MACHINERY (before/after hooks, ordering, atomicity,
 * refusals) is proven against a synthetic contract, so it stays proven while
 * the shipped registry is empty. The shipped CONTRACT is proven by whatever
 * fixtures are checked in under engine/fixtures/ — none until production.
 *
 * Every case runs on BOTH engines. The browser is the path that matters (a
 * vault unlock loads the dump through sql.js) and it is the stricter one: its
 * transaction seam issues a bare BEGIN, so an upgrade that opened its own
 * transaction would pass on the server and fail here.
 */

const server = (): DbLike => openDb(':memory:') as unknown as DbLike
const browser = async (): Promise<DbLike> => {
  const db = await openBrowserDb()
  migrate(db)
  return db
}
const both = async (): Promise<[string, DbLike][]> => [
  ['better-sqlite3', server()],
  ['sql.js', await browser()],
]

/** A small household on the current schema: two brokerages, one holding unvested shares. */
function household(db: DbLike): void {
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking, stock_plan) VALUES ('E*Trade', 'brokerage', 'lots', 1)").run()
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Vanguard', 'brokerage', 'lots')").run()
  db.prepare("INSERT INTO assets (symbol, name, kind) VALUES ('ACME', 'Acme Corp', 'stock')").run()
  db.prepare('INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on) VALUES (1, 1, 400000000, ?)').run('2026-09-17')
}

/**
 * Pretend the household was exported two versions ago by an engine whose
 * invest_accounts called the name column `title` and had no `stock_plan`.
 * Crossing that gap needs both halves: a `before` to rename the column (the
 * current schema would refuse the insert otherwise) and an `after` to
 * re-derive the flag the old engine never stored.
 */
const OLD = CURRENT_VERSION - 2
function ageDump(dump: Dump): Dump {
  return {
    ...dump,
    schemaVersion: OLD,
    tables: {
      ...dump.tables,
      invest_accounts: dump.tables.invest_accounts!.map(({ name, stock_plan: _drop, ...rest }) => ({ title: name, ...rest })),
    },
  }
}
function synthetic(log: string[] = []): Compat {
  return {
    minReadable: OLD,
    upgrades: {
      [CURRENT_VERSION - 1]: {
        before: (d) => {
          log.push(`before:${CURRENT_VERSION - 1}`)
          return {
            ...d,
            tables: { ...d.tables, invest_accounts: d.tables.invest_accounts!.map(({ title, ...rest }) => ({ name: title, ...rest })) },
          }
        },
        after: (db) => {
          log.push(`after:${CURRENT_VERSION - 1}`)
          // Deliberately depends on the previous `after` NOT having run yet.
          const n = (db.prepare('SELECT count(*) AS n FROM invest_accounts WHERE stock_plan = 1').get() as { n: number }).n
          if (n !== 0) throw new Error('after hooks ran out of order')
        },
      },
      [CURRENT_VERSION]: {
        before: (d) => {
          log.push(`before:${CURRENT_VERSION}`)
          return d
        },
        after: (db) => {
          log.push(`after:${CURRENT_VERSION}`)
          db.prepare('UPDATE invest_accounts SET stock_plan = 1 WHERE id IN (SELECT invest_account_id FROM unvested_positions)').run()
        },
      },
    },
  }
}

describe('the upgrade machinery, against a synthetic contract', () => {
  it('reshapes before the insert, repairs after it, both oldest first', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      const old = ageDump(dumpDb(db))
      expect(Object.keys(old.tables.invest_accounts![0]!), engine).toContain('title')

      const log: string[] = []
      const fresh = engine === 'sql.js' ? await browser() : server()
      const loaded = loadDump(fresh, old, synthetic(log))
      expect(loaded, engine).toEqual({ from: OLD, upgraded: [CURRENT_VERSION - 1, CURRENT_VERSION] })
      expect(log, engine).toEqual([
        `before:${CURRENT_VERSION - 1}`,
        `before:${CURRENT_VERSION}`,
        `after:${CURRENT_VERSION - 1}`,
        `after:${CURRENT_VERSION}`,
      ])

      // Nothing lost in the crossing, and the flag the old engine never stored is back.
      expect(listInvestAccounts(fresh).map((a) => [a.name, (a as { stock_plan: number }).stock_plan]), engine).toEqual([
        ['E*Trade', 1],
        ['Vanguard', 0],
      ])
      // And the household now exports at the current version.
      expect(dumpDb(fresh).schemaVersion, engine).toBe(CURRENT_VERSION)
    }
  })

  it('is idempotent: loading the same old snapshot twice changes nothing', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      const old = ageDump(dumpDb(db))
      loadDump(db, old, synthetic())
      const first = dumpDb(db).tables
      loadDump(db, old, synthetic())
      expect(dumpDb(db).tables, engine).toEqual(first)
    }
  })

  it('runs nothing for a current-version snapshot, so a hand-set flag cannot be clobbered', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      db.prepare('UPDATE invest_accounts SET stock_plan = 0').run() // contradicts what the `after` would derive
      const dump = dumpDb(db)
      const log: string[] = []
      const fresh = engine === 'sql.js' ? await browser() : server()
      expect(loadDump(fresh, dump, synthetic(log)), engine).toEqual({ from: CURRENT_VERSION, upgraded: [] })
      expect(log, engine).toEqual([])
      expect(fresh.prepare('SELECT stock_plan FROM invest_accounts ORDER BY id').all(), engine).toEqual([{ stock_plan: 0 }, { stock_plan: 0 }])
    }
  })

  it('a failing `after` rolls the whole load back — on both engines', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      const old = ageDump(dumpDb(db))
      const fresh = engine === 'sql.js' ? await browser() : server()
      fresh.prepare("INSERT INTO accounts (name, kind) VALUES ('Keeper', 'checking')").run()

      const broken = synthetic()
      broken.upgrades[CURRENT_VERSION]!.after = () => {
        throw new Error('boom')
      }
      expect(() => loadDump(fresh, old, broken), engine).toThrow('boom')
      expect(fresh.prepare('SELECT name FROM accounts').all(), engine).toEqual([{ name: 'Keeper' }])
      expect(fresh.prepare('SELECT count(*) AS n FROM invest_accounts').get(), engine).toEqual({ n: 0 })
    }
  })

  it('a failing `before` never opens the transaction', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      const old = ageDump(dumpDb(db))
      const fresh = engine === 'sql.js' ? await browser() : server()
      fresh.prepare("INSERT INTO accounts (name, kind) VALUES ('Keeper', 'checking')").run()

      const broken = synthetic()
      broken.upgrades[CURRENT_VERSION - 1]!.before = () => {
        throw new Error('bad shape')
      }
      expect(() => loadDump(fresh, old, broken), engine).toThrow('bad shape')
      expect(fresh.prepare('SELECT name FROM accounts').all(), engine).toEqual([{ name: 'Keeper' }])
      // The seam is not left mid-transaction: a follow-up load works.
      expect(loadDump(fresh, old, synthetic()).upgraded, engine).toHaveLength(2)
    }
  })

  it('without a `before`, the gap is real: the insert itself fails', async () => {
    // What the hook exists for — proof the machinery is not papering over it.
    for (const [engine, db] of await both()) {
      household(db)
      const old = ageDump(dumpDb(db))
      const fresh = engine === 'sql.js' ? await browser() : server()
      const noReshape = synthetic()
      delete noReshape.upgrades[CURRENT_VERSION - 1]!.before
      expect(() => loadDump(fresh, old, noReshape), engine).toThrow(/title/)
    }
  })
})

describe('what the engine refuses', () => {
  it('rejects snapshots older than the floor and newer than itself, without touching the database', async () => {
    for (const [engine, db] of await both()) {
      household(db)
      const dump = dumpDb(db)
      db.prepare("INSERT INTO accounts (name, kind) VALUES ('Keeper', 'checking')").run()
      const before = dumpDb(db).tables

      const floor = SNAPSHOT_COMPAT.minReadable
      expect(() => loadDump(db, { ...dump, schemaVersion: floor - 1 }), engine).toThrow(`this engine reads v${floor} and newer`)
      expect(() => loadDump(db, { ...dump, schemaVersion: CURRENT_VERSION + 1 }), engine).toThrow(/newer than this engine/)
      expect(() => loadDump(db, { ...dump, schemaVersion: 0 }), engine).toThrow('no usable schema version')
      expect(() => loadDump(db, { ...dump, scarab: false } as unknown as Dump), engine).toThrow('not a Scarab export')
      expect(dumpDb(db).tables, engine).toEqual(before)
    }
  })

  it('readabilityError agrees with what loadDump throws', () => {
    expect(readabilityError(CURRENT_VERSION)).toBeNull()
    expect(readabilityError(CURRENT_VERSION + 1)).toMatch(/newer than this engine/)
    expect(readabilityError(SNAPSHOT_COMPAT.minReadable - 1)).toMatch(/reads v/)
    expect(readabilityError(Number.NaN)).toMatch(/no usable/)
  })
})

/* ---------- the shipped contract ---------- */

const fixtureDir = new URL('./fixtures/', import.meta.url)
const fixtures = readdirSync(fixtureDir)
  .map((f) => /^snapshot-v(\d+)\.json$/.exec(f))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({ file: m[0], version: Number(m[1]) }))
  .sort((a, b) => a.version - b.version)

describe('the shipped contract stays honest', () => {
  it('the floor is the oldest fixture on disk, or the current version when there is none', () => {
    const oldest = fixtures[0]?.version ?? CURRENT_VERSION
    expect(SNAPSHOT_COMPAT.minReadable).toBe(oldest)
    expect(SNAPSHOT_COMPAT.minReadable).toBeLessThanOrEqual(CURRENT_VERSION)
  })

  it('only registers upgrades a readable snapshot could actually replay', () => {
    // An entry at or below the floor is dead code; one above the current
    // version never runs. Either means the floor moved and this did not.
    for (const v of Object.keys(SNAPSHOT_COMPAT.upgrades).map(Number)) {
      expect(v, `upgrades[${v}]`).toBeGreaterThan(SNAPSHOT_COMPAT.minReadable)
      expect(v, `upgrades[${v}]`).toBeLessThanOrEqual(CURRENT_VERSION)
    }
    expect(upgradesFor(CURRENT_VERSION)).toEqual([])
  })

  it('every checked-in fixture loads on both engines', async () => {
    for (const { file, version } of fixtures) {
      const dump = JSON.parse(readFileSync(new URL(file, fixtureDir), 'utf8')) as Dump
      expect(dump.schemaVersion, file).toBe(version)
      for (const [engine, db] of await both()) {
        expect(loadDump(db, dump).from, `${file} on ${engine}`).toBe(version)
        expect(dumpDb(db).schemaVersion, `${file} on ${engine}`).toBe(CURRENT_VERSION)
      }
    }
  })
})
