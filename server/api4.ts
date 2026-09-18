import { createHash } from 'node:crypto'
import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { dumpDb, loadDump, TABLES, type Dump } from '../engine/snapshot'
import { readabilityError } from '../engine/upgrades'
import { db, schemaVersion } from './db'

/**
 * The vault layer: opaque ciphertext storage plus whole-database
 * export/import. The server never sees vault keys — blobs are encrypted
 * client-side (shared/vault.ts) before they arrive.
 *
 * One blob per household. A blob is keyed by the identity that created it;
 * household_members maps other identities onto it, so a partner added from
 * an unlocked session fetches and saves the same ciphertext.
 */
export const api4 = new Hono<{ Variables: { userEmail: string } }>()

const MAX_BLOB_BYTES = 10 * 1024 * 1024

/** The vault_blobs key this identity reads and writes: its own, unless it was added to someone's household. */
export function householdOf(d: DbLike, email: string): string {
  const m = d.prepare('SELECT household FROM household_members WHERE email = ?').get(email) as { household: string } | undefined
  return m?.household ?? email
}

/* ---------- encrypted vault blobs ---------- */

api4.get('/vault', (c) => {
  const row = db
    .prepare('SELECT version, sha256, size, data, updated_at FROM vault_blobs WHERE owner_email = ?')
    .get(householdOf(db as unknown as DbLike, c.get('userEmail'))) as
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
  const email = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const current = db.prepare('SELECT version FROM vault_blobs WHERE owner_email = ?').get(email) as
    | { version: number }
    | undefined
  if ((current?.version ?? 0) !== b.version)
    return c.json(
      { error: `version conflict: server has ${current?.version ?? 0}, you sent ${b.version}`, serverVersion: current?.version ?? 0 },
      409,
    )
  const sha = createHash('sha256').update(b.data).digest('hex')
  // The blob being replaced moves into prev_* (one step of history, still
  // ciphertext — see migration 17). Every right-hand side of an UPDATE reads
  // the row as it was, so the prev_ assignments see the outgoing values.
  db.prepare(
    `INSERT INTO vault_blobs (owner_email, version, sha256, size, data, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT (owner_email) DO UPDATE SET
       prev_version = vault_blobs.version, prev_sha256 = vault_blobs.sha256, prev_size = vault_blobs.size,
       prev_data = vault_blobs.data, prev_updated_at = vault_blobs.updated_at,
       version = excluded.version, sha256 = excluded.sha256, size = excluded.size,
       data = excluded.data, updated_at = excluded.updated_at`,
  ).run(email, b.version + 1, sha, b.data.length, b.data)
  return c.json({ ok: true, version: b.version + 1, sha256: sha })
})

/* ---------- household members ---------- */

export type Member = { email: string; added_by: string; added_at: string }

const normalizeEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

/** Everyone who unlocks this vault: the identity that created it plus every member row pointing at it. */
api4.get('/vault/members', (c) => {
  const household = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const members = db
    .prepare('SELECT email, added_by, added_at FROM household_members WHERE household = ? ORDER BY added_at')
    .all(household) as Member[]
  return c.json({ household, members })
})

/**
 * Add an identity to this household. Their passkey wrapping is already in
 * the blob header by the time this is called (the client registers the
 * passkey first, saves, then tells the server who it belongs to). Refuses an
 * identity that already has a vault of its own or belongs elsewhere: joining
 * would orphan their ciphertext, and there is no delete-vault route on purpose.
 */
api4.post('/vault/members', async (c) => {
  const me = c.get('userEmail')
  const household = householdOf(db as unknown as DbLike, me)
  const email = normalizeEmail(((await c.req.json().catch(() => ({}))) as { email?: unknown }).email)
  if (!email.includes('@')) return c.json({ error: 'email required — the Google account they sign in with' }, 400)
  if (email === me || email === household) return c.json({ error: 'that identity already unlocks this vault' }, 400)
  const existing = db.prepare('SELECT household FROM household_members WHERE email = ?').get(email) as { household: string } | undefined
  if (existing?.household === household) return c.json({ error: `${email} is already a member` }, 400)
  if (existing) return c.json({ error: `${email} belongs to another household` }, 409)
  if (db.prepare('SELECT 1 FROM vault_blobs WHERE owner_email = ?').get(email))
    return c.json({ error: `${email} already has a vault of their own` }, 409)
  db.prepare('INSERT INTO household_members (email, household, added_by) VALUES (?, ?, ?)').run(email, household, me)
  return c.json({ ok: true, household, email })
})

/** Remove a member (any member may; the creating identity has no row to remove). The client drops their passkey too. */
api4.delete('/vault/members/:email', (c) => {
  const household = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const email = normalizeEmail(decodeURIComponent(c.req.param('email')))
  const r = db.prepare('DELETE FROM household_members WHERE email = ? AND household = ?').run(email, household)
  if (r.changes === 0) return c.json({ error: `${email} is not a member of this household` }, 404)
  return c.json({ ok: true })
})

/* ---------- whole-database export / import ---------- */

api4.get('/export', (c) => c.json(dumpDb(db as unknown as DbLike)))

api4.post('/import', async (c) => {
  const b = (await c.req.json()) as Dump & { confirm?: string }
  if (!b.scarab || !b.tables) return c.json({ error: 'not a Scarab export' }, 400)
  const why = readabilityError(b.schemaVersion)
  if (why) return c.json({ error: why }, 400)
  if (b.confirm !== 'REPLACE')
    return c.json({ error: 'this REPLACES every row of data — resend with confirm: "REPLACE"' }, 400)
  const loaded = loadDump(db as unknown as DbLike, b)
  const counts = Object.fromEntries(
    TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  )
  return c.json({ ok: true, restored: counts, schemaVersion, loadedFrom: loaded.from, upgraded: loaded.upgraded })
})
