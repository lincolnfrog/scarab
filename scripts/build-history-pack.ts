/**
 * Build the monthly market history (server/history-pack.ts) in one sitting on
 * this machine and write it to seed/history-pack.json.gz, which the image ships
 * and the server stores at boot (seedHistoryPack). Same builder, same pacing
 * per call as the server; only the per-run and per-day budgets are lifted.
 *
 *   npm run seed:history
 *
 * Progress lives in seed/.build.db, so an interrupted or refused run resumes
 * where it stopped when you run it again (Yahoo refusing pauses it for the day).
 */
import { writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { DbLike } from '../engine/db'
import { buildBasket } from '../server/basket'
import { ensureHistoryPack, loadPack } from '../server/history-pack'
import { openDb } from '../server/migrations'

const OUT = 'seed/history-pack.json.gz'
const db = openDb('seed/.build.db') as unknown as DbLike

const basketRows = () => (db.prepare('SELECT count(*) AS n FROM basket_quotes').get() as { n: number }).n
if (basketRows() === 0) {
  console.log('building the price basket (the universe to fetch)…')
  const b = await buildBasket(db)
  console.log(`basket: ${b.stocks} stocks, ${b.crypto} crypto${b.errors.length ? ` · ${b.errors.slice(0, 3).join('; ')}` : ''}`)
  if (basketRows() === 0) throw new Error('no basket — the symbol directory or quotes could not be fetched')
}

const opts = { runCalls: 100_000, dayCalls: 100_000, gapMs: 0 }
let total = 0
while (!loadPack(db)) {
  const run = ensureHistoryPack(db, fetch, new Date(), opts)
  if (!run) throw new Error('the build will not run now (paused after a refusal today?) — run again tomorrow; progress is kept')
  const r = await run
  total += r.calls
  console.log(`${r.calls} calls, ${r.fetched} symbols with history${r.errors.length ? ` · ${r.errors.slice(-2).join('; ')}` : ''}`)
  if (r.blocked) throw new Error(`Yahoo refused after ${total} calls — run again later; progress is kept in seed/.build.db`)
}

const pack = loadPack(db)!
const gz = gzipSync(JSON.stringify(pack), { level: 9 })
writeFileSync(OUT, gz)
console.log(
  `wrote ${OUT}: ${Object.keys(pack.stock).length} stocks + ${Object.keys(pack.crypto).length} crypto, ` +
    `${pack.start}…${pack.final} (as of ${pack.asOf}), ${(gz.length / 1024).toFixed(0)} KB`,
)
