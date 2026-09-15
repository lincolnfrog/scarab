import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { handle } from './api'
import { householdOf } from './api4'
import { basketStatus, buildBasket, ensureBasket, getBasket, isBuilding } from './basket'
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

api8.get('/mode', (c) =>
  handle(c, () => {
    const email = c.get('userEmail')
    const household = householdOf(db, email)
    const v = db
      .prepare('SELECT version, updated_at FROM vault_blobs WHERE owner_email = ?')
      .get(household) as { version: number; updated_at: string } | undefined
    return {
      vault: v ?? null,
      household: household === email ? null : household, // whose vault this identity was added to
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
api8.post('/basket/rebuild', async (c) => c.json(await buildBasket(db)))
