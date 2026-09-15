import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import type { DbLike } from '../engine/db'
import { migrations } from '../engine/migrations'
import { loadDump } from '../engine/snapshot'
import { api } from './api'
import { api2 } from './api2'
import { api3 } from './api3'
import { api4 } from './api4'
import { api5 } from './api5'
import { api6 } from './api6'
import { api7 } from './api7'
import { api8, serverHasData } from './api8'
import { detectTransfers } from './import'
import { runRepairs } from './repairs'

export type Variables = { userEmail: string; zkOnly: boolean }
export type ServerOptions = { zkOnly: boolean }

/**
 * Everything a zero-knowledge-only server will answer. Identity, the mode
 * probe, the encrypted-blob courier and its membership list (emails the
 * server already knows from IAP), and the daily price basket — nothing that
 * carries plaintext in either direction. The list is the whole
 * privacy claim for scarab.one, so it is deliberately short and literal.
 */
export const ZK_ROUTES = /^\/api\/(me|health|mode|vault|vault\/members|vault\/members\/[^/]+|basket|basket\/status|basket\/rebuild)$/

/**
 * Identity comes from Identity-Aware Proxy. IAP sets this header after
 * authenticating the caller against the IAM allowlist; with ingress locked to
 * IAP, nothing else can reach the container, so the header is trustworthy.
 */
export function userEmail(header: string | undefined): string | null {
  if (header) return header.split(':').pop() ?? null // "accounts.google.com:max@gmail.com"
  return process.env.NODE_ENV === 'production' ? null : 'dev@localhost'
}

/**
 * Boot-time database checks. A zero-knowledge-only server must hold no
 * plaintext: if it does, refuse to start unless explicitly told to purge
 * (SCARAB_PURGE_PLAINTEXT=1 — the one-time step that turns a household
 * install into a vault-only one). Household mode runs its repairs instead.
 */
export function prepareDatabase(db: DbLike, opts: ServerOptions & { purge: boolean }): string[] {
  const log: string[] = []
  if (opts.zkOnly) {
    if (serverHasData(db)) {
      if (!opts.purge)
        throw new Error(
          'SCARAB_ZK_ONLY is set but the database holds plaintext household data. ' +
            'Export it first, then redeploy with SCARAB_PURGE_PLAINTEXT=1 to wipe it (ciphertext and the price basket are kept).',
        )
      loadDump(db, { scarab: true, schemaVersion: migrations.length, exportedAt: new Date().toISOString(), tables: {} })
      log.push('zero-knowledge only: purged plaintext household data (vault blobs and price basket kept)')
    }
    log.push('zero-knowledge only: plaintext routes disabled')
    return log
  }
  const repairs = runRepairs(db)
  if (repairs.signsFlipped > 0) log.push(`repair: flipped ${repairs.signsFlipped} card-payment rows to inflows`)
  if (repairs.rulesApplied > 0) log.push(`rules: filed ${repairs.rulesApplied} previously uncategorized transactions`)
  const swept = detectTransfers(db)
  if (swept > 0) log.push(`transfer detection: filed ${swept} transactions as Transfer`)
  return log
}

export function createApp(opts: ServerOptions): Hono<{ Variables: Variables }> {
  const app = new Hono<{ Variables: Variables }>()

  app.use('/api/*', async (c, next) => {
    const email = userEmail(c.req.header('x-goog-authenticated-user-email'))
    if (!email) return c.json({ error: 'unauthenticated' }, 401)
    c.set('userEmail', email)
    c.set('zkOnly', opts.zkOnly)
    if (opts.zkOnly && !ZK_ROUTES.test(c.req.path))
      return c.json({ error: 'this server is zero-knowledge only: it stores ciphertext and never handles plaintext' }, 403)
    await next()
  })

  // The basket is ~10k rows; gzip it (Cloud Run's front end doesn't).
  app.use('/api/basket', compress())
  app.get('/api/me', (c) => c.json({ email: c.get('userEmail') }))
  app.route('/api', api)
  app.route('/api', api2)
  app.route('/api', api3)
  app.route('/api', api4)
  app.route('/api', api5)
  app.route('/api', api6)
  app.route('/api', api7)
  app.route('/api', api8)

  // Built client, with SPA fallback for client-side routes. Hashed assets are
  // immutable; the HTML shell must never be cached or deploys leave users on
  // stale bundles.
  app.use('/assets/*', async (c, next) => {
    await next()
    c.header('cache-control', 'public, max-age=31536000, immutable')
  })
  app.use('*', async (c, next) => {
    await next()
    if (!c.req.path.startsWith('/assets/')) c.header('cache-control', 'no-cache')
  })
  app.use('*', serveStatic({ root: './dist' }))
  app.get('*', serveStatic({ path: './dist/index.html' }))
  return app
}
