import { serve } from '@hono/node-server'
import type { DbLike } from '../engine/db'
import { createApp, prepareDatabase } from './app'
import { db, schemaVersion } from './db'

const flag = (name: string) => ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase())

// SCARAB_ZK_ONLY=1 makes this a vault-only server (scarab.one): ciphertext
// courier + price basket, no plaintext routes. Unset = household mode.
const zkOnly = flag('SCARAB_ZK_ONLY')
for (const line of prepareDatabase(db as unknown as DbLike, { zkOnly, purge: flag('SCARAB_PURGE_PLAINTEXT') }))
  console.log(line)

const app = createApp({ zkOnly })
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => {
  console.log(`scarab listening on :${port} (db schema v${schemaVersion}, ${zkOnly ? 'zero-knowledge only' : 'household mode'})`)
})
