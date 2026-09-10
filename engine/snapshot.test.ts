import { describe, expect, it } from 'vitest'
import type { DbLike } from './db'
import { openDb } from '../server/migrations'
import { migrations } from './migrations'
import { dumpDb, loadDump, TABLES } from './snapshot'

const mem = () => openDb(':memory:') as unknown as DbLike
const count = (db: DbLike, t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

describe('snapshot boundaries', () => {
  it('leaves the vault ciphertext out: a snapshot is what goes INTO the vault', () => {
    const db = mem()
    db.prepare("INSERT INTO vault_blobs (owner_email, version, sha256, size, data) VALUES ('a@b', 3, 'x', 2, '{}')").run()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    const dump = dumpDb(db)
    expect(TABLES).not.toContain('vault_blobs')
    expect(dump.tables.vault_blobs).toBeUndefined()
    expect(dump.tables.accounts).toHaveLength(1)

    // Restoring never touches the blob either — no version rollback.
    loadDump(db, { ...dump, tables: { ...dump.tables, accounts: [] } })
    expect(count(db, 'accounts')).toBe(0)
    expect(db.prepare('SELECT version FROM vault_blobs').get()).toEqual({ version: 3 })
  })

  it('keeps the price basket bookkeeping server-side, in both directions', () => {
    const db = mem()
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:built_at', '2026-09-09T00:00:00Z')").run()
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:attempted_on', '2026-09-09')").run()
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('digest:a@b', '2026-09')").run()
    db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES ('SPY', 'stock', 65000, '2026-09-09')").run()
    const dump = dumpDb(db)
    expect(dump.tables.app_meta).toEqual([{ key: 'digest:a@b', value: '2026-09' }])
    expect(dump.tables.basket_quotes).toBeUndefined()

    // A restore replaces household rows but not the basket's rows or stamps —
    // otherwise an old dump could claim "attempted today" over an empty basket.
    loadDump(db, { ...dump, tables: { ...dump.tables, app_meta: [{ key: 'digest:a@b', value: '2026-08' }] } })
    expect(db.prepare('SELECT key, value FROM app_meta ORDER BY key').all()).toEqual([
      { key: 'basket:attempted_on', value: '2026-09-09' },
      { key: 'basket:built_at', value: '2026-09-09T00:00:00Z' },
      { key: 'digest:a@b', value: '2026-08' },
    ])
    expect(count(db, 'basket_quotes')).toBe(1)
  })

  it('ignores tables in an older export that are no longer part of the snapshot', () => {
    const db = mem()
    loadDump(db, {
      scarab: true,
      schemaVersion: migrations.length,
      exportedAt: 'x',
      tables: { accounts: [{ id: 1, name: 'Old', kind: 'checking' }], vault_blobs: [{ owner_email: 'a@b', version: 9, sha256: 'x', size: 1, data: '{}' }] },
    })
    expect(count(db, 'accounts')).toBe(1)
    expect(count(db, 'vault_blobs')).toBe(0)
  })
})
