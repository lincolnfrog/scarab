import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { handle } from './api'
import { householdOf, invitesFor } from './api4'
import { basketStatus, ensureBasket, getBasket, isBuilding } from './basket'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Zero-knowledge mode plumbing: what the front door needs to know, and the
// daily price basket (see ./basket.ts) that lets a local session refresh
// quotes without telling the server what it holds.
export const api8 = new Hono<{ Variables: { userEmail: string; zkOnly: boolean } }>()

/** Does the server hold any plaintext household data at all? (Ciphertext and the basket don't count.) */
export function serverHasData(d: DbLike): boolean {
  for (const t of ['accounts', 'transactions', 'invest_accounts', 'trades', 'properties', 'rsu_vests'])
    if ((d.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n > 0) return true
  return false
}

/**
 * What the front door needs, and a session's poll (every 45s while its tab is
 * visible): the stored vault's version, when and by whom it was saved, and
 * the SHA-256 of its ciphertext (which the caller can download anyway) — so
 * a member's tab can follow the other member's saves, and notice a vault
 * replaced at its own version number, without downloading the blob.
 * `keepsHistory`: the courier keeps replaced versions (vault history).
 * `invites`: invitations into a household waiting for this identity's answer
 * (the front door offers them) — the caller's own, never anyone else's.
 */
api8.get('/mode', (c) =>
  handle(c, () => {
    const email = c.get('userEmail')
    const household = householdOf(db, email)
    const v = db
      .prepare('SELECT version, updated_at, updated_by, sha256 FROM vault_blobs WHERE owner_email = ?')
      .get(household) as { version: number; updated_at: string; updated_by: string | null; sha256: string } | undefined
    return {
      vault: v ? { ...v, keepsHistory: true } : null,
      household: household === email ? null : household, // whose vault this identity is a member of
      invites: invitesFor(db, email),
      serverHasData: serverHasData(db),
      zkOnly: c.get('zkOnly') ?? false,
    }
  }),
)

/**
 * The daily basket. Served whole, identical for every caller; refreshed at
 * most once a day in the background. A caller who finds it empty (first
 * boot) waits for the build instead.
 */
api8.get('/basket', async (c) => {
  const pending = ensureBasket(db)
  if (pending && basketStatus(db).count === 0) await pending.catch(() => undefined)
  return c.json(getBasket(db))
})
api8.get('/basket/status', (c) => c.json({ ...basketStatus(db), building: isBuilding() }))

/** A rebuild within this long of the last build (or rebuild request) is refused with 429. */
export const REBUILD_WINDOW_MS = 15 * 60_000
/** When a rebuild was last started. A basket:* key: infrastructure, never part of a snapshot, kept by the ZK purge. */
const REBUILD_AT = 'basket:rebuild_requested_at'
const metaAt = (key: string): number => {
  const v = (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
  const t = v ? Date.parse(v) : NaN
  return Number.isNaN(t) ? 0 : t
}

/**
 * Rebuild the basket now. It is the only rebuild path on a vault-only
 * server, and a build fans out to thousands of upstream quote requests, so it
 * is throttled: a build already running (the daily one or another caller's
 * rebuild) is joined, never doubled, and a new one starts at most once per 15
 * minutes (429 with builtAt and Retry-After otherwise). Every build goes
 * through ensureBasket's single in-flight guard (./basket.ts); this route
 * keeps no promise of its own.
 */
api8.post('/basket/rebuild', async (c) => {
  // Forced, ensureBasket starts a build only when none is running — so while one is, this joins it.
  const rebuild = () => ensureBasket(db, fetch, undefined, { force: true })!
  if (isBuilding()) return c.json(await rebuild())
  const { builtAt } = basketStatus(db)
  const last = Math.max(metaAt(REBUILD_AT), builtAt ? Date.parse(builtAt) || 0 : 0)
  const wait = last + REBUILD_WINDOW_MS - Date.now()
  if (wait > 0) {
    const retryAfter = Math.ceil(wait / 1000)
    c.header('retry-after', String(retryAfter))
    return c.json({ error: 'the price basket was built less than 15 minutes ago', builtAt, retryAfter }, 429)
  }
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    REBUILD_AT,
    new Date().toISOString(),
  )
  return c.json(await rebuild())
})
