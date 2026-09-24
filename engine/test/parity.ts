import { openDb } from '../../server/migrations'
import type { DbLike } from '../db'
import { migrate } from '../migrations'
import { openBrowserDb } from '../sqljs-db'

/**
 * Test helper: run the same work on both database engines — better-sqlite3
 * (the server) and sql.js (the browser tab) — each freshly migrated in memory,
 * and hand back both results for the caller to compare:
 *
 *   const { server, browser } = await onBothEngines(seed, (db) => getPortfolio(db, today))
 *   expect(browser).toEqual(server)
 *
 * Each area keeps its own engine/parity-<area>.test.ts built on this, so the
 * original engine/parity.test.ts stays untouched. Test-only: it reaches into
 * server/ for better-sqlite3, which nothing shipped under engine/ may do.
 */
export async function onBothEngines<T>(
  seed: (db: DbLike) => void,
  run: (db: DbLike) => T,
): Promise<{ server: T; browser: T }> {
  const serverDb = openDb(':memory:')
  const browserDb = await openBrowserDb()
  try {
    migrate(browserDb)
    const s = serverDb as unknown as DbLike
    seed(s)
    const server = run(s)
    seed(browserDb)
    const browser = run(browserDb)
    return { server, browser }
  } finally {
    serverDb.close()
    browserDb.close()
  }
}
