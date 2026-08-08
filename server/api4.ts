import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { dumpDb, loadDump, TABLES, type Dump } from '../engine/snapshot'
import { db, schemaVersion } from './db'

/**
 * The vault layer: opaque ciphertext storage plus whole-database
 * export/import. The server never sees vault keys — blobs are encrypted
 * client-side (shared/vault.ts) before they arrive.
 */
export const api4 = new Hono<{ Variables: { userEmail: string } }>()

const MAX_BLOB_BYTES = 10 * 1024 * 1024

/* ---------- encrypted vault blobs ---------- */

api4.get('/vault', (c) => {
  const row = db
    .prepare('SELECT version, sha256, size, data, updated_at FROM vault_blobs WHERE owner_email = ?')
    .get(c.get('userEmail')) as
    | { version: number; sha256: string; size: number; data: string; updated_at: string }
    | undefined
  if (!row) return c.json({ error: 'no vault yet' }, 404)
  return c.json(row)
})

api4.put('/vault', async (c) => {
  const b = await c.req.json<{ data?: string; version?: number }>()
  if (typeof b.data !== 'string' || !Number.isSafeInteger(b.version))
    return c.json({ error: 'data (string) and version (current version, 0 to create) required' }, 400)
  if (b.data.length > MAX_BLOB_BYTES * 1.4) return c.json({ error: 'vault blob exceeds 10MB' }, 413)
  const email = c.get('userEmail')
  const current = db.prepare('SELECT version FROM vault_blobs WHERE owner_email = ?').get(email) as
    | { version: number }
    | undefined
  if ((current?.version ?? 0) !== b.version)
    return c.json(
      { error: `version conflict: server has ${current?.version ?? 0}, you sent ${b.version}`, serverVersion: current?.version ?? 0 },
      409,
    )
  const sha = createHash('sha256').update(b.data).digest('hex')
  db.prepare(
    `INSERT INTO vault_blobs (owner_email, version, sha256, size, data, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (owner_email) DO UPDATE SET
       version = excluded.version, sha256 = excluded.sha256, size = excluded.size,
       data = excluded.data, updated_at = excluded.updated_at`,
  ).run(email, b.version + 1, sha, b.data.length, b.data)
  return c.json({ ok: true, version: b.version + 1, sha256: sha })
})

/* ---------- whole-database export / import ---------- */

api4.get('/export', (c) => c.json(dumpDb(db as unknown as DbLike)))

api4.post('/import', async (c) => {
  const b = (await c.req.json()) as Dump & { confirm?: string }
  if (!b.scarab || !b.tables) return c.json({ error: 'not a Scarab export' }, 400)
  if (b.schemaVersion !== schemaVersion)
    return c.json({ error: `schema mismatch: export is v${b.schemaVersion}, server is v${schemaVersion}` }, 400)
  if (b.confirm !== 'REPLACE')
    return c.json({ error: 'this REPLACES every row of data — resend with confirm: "REPLACE"' }, 400)
  loadDump(db as unknown as DbLike, b)
  const counts = Object.fromEntries(
    TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  )
  return c.json({ ok: true, restored: counts })
})
