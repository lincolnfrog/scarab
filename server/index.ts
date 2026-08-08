import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { api } from './api'
import { api2 } from './api2'
import { api3 } from './api3'
import { api4 } from './api4'
import { db, schemaVersion } from './db'
import { detectTransfers } from './import'
import { runRepairs } from './repairs'

const app = new Hono<{ Variables: { userEmail: string } }>()

// Identity comes from Identity-Aware Proxy. IAP sets this header after
// authenticating the caller against the IAM allowlist; with ingress locked to
// IAP, nothing else can reach the container, so the header is trustworthy.
function userEmail(header: string | undefined): string | null {
  if (header) return header.split(':').pop() ?? null // "accounts.google.com:max@gmail.com"
  return process.env.NODE_ENV === 'production' ? null : 'dev@localhost'
}

app.use('/api/*', async (c, next) => {
  const email = userEmail(c.req.header('x-goog-authenticated-user-email'))
  if (!email) return c.json({ error: 'unauthenticated' }, 401)
  c.set('userEmail', email)
  await next()
})

app.get('/api/me', (c) => c.json({ email: c.get('userEmail') }))
app.route('/api', api)
app.route('/api', api2)
app.route('/api', api3)
app.route('/api', api4)

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

const repairs = runRepairs(db)
if (repairs.signsFlipped > 0) console.log(`repair: flipped ${repairs.signsFlipped} card-payment rows to inflows`)
if (repairs.rulesApplied > 0) console.log(`rules: filed ${repairs.rulesApplied} previously uncategorized transactions`)
const swept = detectTransfers(db)
if (swept > 0) console.log(`transfer detection: filed ${swept} transactions as Transfer`)

const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`scarab listening on :${port} (db schema v${schemaVersion})`)
})
