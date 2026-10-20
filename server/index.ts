import { existsSync, readFileSync } from 'node:fs'
import { serve } from '@hono/node-server'
import type { DbLike } from '../engine/db'
import { createApp, prepareDatabase } from './app'
import { readBuildInfo, readInlineStyleHashes } from './build-info'
import { db, schemaVersion } from './db'
import { seedHistoryPack } from './history-pack'

const flag = (name: string) => ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase())

// SCARAB_ZK_ONLY=1 makes this a vault-only server (scarab.one): ciphertext
// courier + price basket, no plaintext routes. Unset = household mode.
const zkOnly = flag('SCARAB_ZK_ONLY')
for (const line of prepareDatabase(db as unknown as DbLike, { zkOnly, purge: flag('SCARAB_PURGE_PLAINTEXT') }))
  console.log(line)

// The monthly market history, built ahead of time (npm run seed:history) and
// shipped in the image, so the first request doesn't wait on a ~630-call crawl.
const SEED = process.env.HISTORY_SEED ?? './seed/history-pack.json.gz'
if (existsSync(SEED)) {
  const r = seedHistoryPack(db as unknown as DbLike, readFileSync(SEED))
  console.log(`market history seed (${SEED}): ${r === 'seeded' ? 'stored' : r === 'kept' ? 'stored file is as new or newer; kept it' : 'unreadable, ignored'}`)
}

// What is being served: the build manifest's provenance (dist/build.json) for
// /api/health and the Data & Vault screen, and the hashes of index.html's
// inline style blocks for the Content-Security-Policy. Both are read once, here.
const DIST = './dist'
const build = readBuildInfo(DIST)
const app = createApp({ zkOnly, build, inlineStyleHashes: readInlineStyleHashes(DIST) })
const port = Number(process.env.PORT ?? 8787)
serve({ fetch: app.fetch, port }, () => {
  const built = build?.commit ? `commit ${build.commit.slice(0, 7)}${build.tag ? ` · ${build.tag}` : ''}` : 'no build manifest'
  console.log(`scarab listening on :${port} (db schema v${schemaVersion}, ${zkOnly ? 'zero-knowledge only' : 'household mode'}, ${built})`)
})
