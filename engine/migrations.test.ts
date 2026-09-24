import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { DbLike } from './db'
import { migrate, migrations } from './migrations'
import { openBrowserDb } from './sqljs-db'

/**
 * Migrations applied on top of a database that already has rows — the path a
 * deployed server and a stored vault actually take. A fresh database only ever
 * proves the DDL parses. Every case runs on both engines.
 */

/** Bring a raw database to schema `n` with the same bookkeeping migrate() keeps, so migrate() resumes from there. */
function migrateTo(db: DbLike, n: number) {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  for (let i = 0; i < n; i++)
    db.transaction(() => {
      db.exec(migrations[i]!)
      db.prepare('INSERT INTO migrations (id) VALUES (?)').run(i + 1)
    })()
}

type Closable = DbLike & { close(): void }
const engines = async (): Promise<[string, Closable][]> => [
  ['better-sqlite3', new Database(':memory:') as unknown as Closable],
  ['sql.js', await openBrowserDb()],
]

describe('migrations 18–20 over a v17 database', () => {
  it('adds the account profile, basket names, and seeds courier history from prev_*', async () => {
    for (const [name, db] of await engines()) {
      migrateTo(db, 17)
      db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Vanguard', 'brokerage', 'lots')").run()
      db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES ('VTI', 'stock', 31000, '2026-09-22')").run()
      db.prepare(
        `INSERT INTO vault_blobs (owner_email, version, sha256, size, data, updated_at,
                                  prev_version, prev_sha256, prev_size, prev_data, prev_updated_at)
         VALUES ('max@x', 42, 'sha42', 5, 'ct-42', '2026-09-22 10:00:00', 41, 'sha41', 4, 'ct-41', '2026-09-21 09:00:00')`,
      ).run()
      // A vault saved once has no previous version to carry over.
      db.prepare("INSERT INTO vault_blobs (owner_email, version, sha256, size, data) VALUES ('solo@x', 1, 'sha1', 4, 'ct-1')").run()

      migrate(db)
      const at = (db.prepare('SELECT max(id) AS v FROM migrations').get() as { v: number }).v
      expect(at, name).toBe(migrations.length)

      expect(db.prepare('SELECT subtype, institution, owner, mask, sort FROM invest_accounts').get(), name).toEqual({
        subtype: null,
        institution: null,
        owner: null,
        mask: null,
        sort: 0,
      })
      expect(db.prepare('SELECT name, etf FROM basket_quotes').get(), name).toEqual({ name: null, etf: 0 })
      expect(db.prepare('SELECT * FROM vault_history').all(), name).toEqual([
        {
          owner_email: 'max@x',
          version: 41,
          sha256: 'sha41',
          size: 4,
          data: 'ct-41',
          updated_at: '2026-09-21 09:00:00',
          updated_by: null,
          pin: null,
        },
      ])
      // The live blob is untouched, and gains a saved-by column for the next save to fill.
      expect(db.prepare("SELECT version, data, updated_by FROM vault_blobs WHERE owner_email = 'max@x'").get(), name).toEqual({
        version: 42,
        data: 'ct-42',
        updated_by: null,
      })
      db.close()
    }
  })

  it('creates vault_invites (as #20 shipped it: keyed by the invitee alone), stamped when invited', async () => {
    for (const [name, db] of await engines()) {
      migrateTo(db, 20)
      db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('nicole@x', 'max@x', 'max@x')").run()
      const row = db.prepare('SELECT * FROM vault_invites').get() as Record<string, unknown>
      expect(row, name).toMatchObject({ email: 'nicole@x', household: 'max@x', invited_by: 'max@x' })
      expect(row.invited_at, name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      // At #20, one pending invitation per invitee (what #21 undoes).
      expect(() => db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('nicole@x', 'o@x', 'o@x')").run(), name).toThrow()
      db.close()
    }
  })
})

describe('migration 21 over a v20 database', () => {
  it('rekeys vault_invites by (invitee, household), keeping every waiting invitation as it was', async () => {
    for (const [name, db] of await engines()) {
      migrateTo(db, 20)
      const invite = db.prepare('INSERT INTO vault_invites (email, household, invited_by, invited_at) VALUES (?, ?, ?, ?)')
      invite.run('nicole@x', 'max@x', 'max@x', '2026-09-20 08:00:00.125')
      invite.run('wes@x', 'max@x', 'nicole@x', '2026-09-21 09:30:00')
      invite.run('kid@x', 'ann@x', 'ann@x', '2026-09-22 10:00:00')

      migrate(db)
      expect((db.prepare('SELECT max(id) AS v FROM migrations').get() as { v: number }).v, name).toBe(migrations.length)
      expect(db.prepare('SELECT * FROM vault_invites ORDER BY invited_at').all(), name).toEqual([
        { email: 'nicole@x', household: 'max@x', invited_by: 'max@x', invited_at: '2026-09-20 08:00:00.125' },
        { email: 'wes@x', household: 'max@x', invited_by: 'nicole@x', invited_at: '2026-09-21 09:30:00' },
        { email: 'kid@x', household: 'ann@x', invited_by: 'ann@x', invited_at: '2026-09-22 10:00:00' },
      ])
      // Another household's invitation to the same person now waits beside the first, stamped when invited…
      db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('nicole@x', 'ann@x', 'ann@x')").run()
      const both = db.prepare("SELECT household, invited_at FROM vault_invites WHERE email = 'nicole@x' ORDER BY household").all() as {
        household: string
        invited_at: string
      }[]
      expect(both.map((r) => r.household), name).toEqual(['ann@x', 'max@x'])
      expect(both[0]!.invited_at, name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      // …while one household still has at most one per person.
      expect(() => db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('nicole@x', 'max@x', 'max@x')").run(), name).toThrow()
      // The rebuild left nothing behind but the table and its household index.
      const schema = db.prepare("SELECT type, name FROM sqlite_master WHERE name LIKE 'vault_invites%' ORDER BY name").all()
      expect(schema, name).toEqual([
        { type: 'table', name: 'vault_invites' },
        { type: 'index', name: 'vault_invites_household' },
      ])
      db.close()
    }
  })

  it('migrates an empty vault_invites the same way, and a fresh database straight to the new key', async () => {
    for (const [name, db] of await engines()) {
      migrateTo(db, 20)
      migrate(db)
      const cols = (db.prepare('PRAGMA table_info(vault_invites)').all() as { name: string; pk: number }[]).map((c) => [c.name, c.pk])
      expect(cols, name).toEqual([
        ['email', 1],
        ['household', 2],
        ['invited_by', 0],
        ['invited_at', 0],
      ])
      db.close()
    }
    for (const [name, db] of await engines()) {
      migrate(db)
      db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('q@x', 'a@x', 'a@x'), ('q@x', 'b@x', 'b@x')").run()
      expect((db.prepare('SELECT count(*) AS n FROM vault_invites').get() as { n: number }).n, name).toBe(2)
      db.close()
    }
  })
})
