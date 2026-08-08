import type { Database } from 'better-sqlite3'
import { parseYahooHistory } from './prices'

/**
 * Daily chart data. Yahoo supplies daily closes (period1/period2 — range=max
 * silently degrades to monthly). Cached in SQLite, refetched at most once
 * per day per asset.
 */

const today = () => new Date().toISOString().slice(0, 10)
const UA = { 'user-agent': 'Mozilla/5.0 (scarab household finance)' }

function freshEnough(db: Database, key: string): boolean {
  const row = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value === today()
}
function markFresh(db: Database, key: string) {
  db.prepare(
    'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, today())
}

export async function ensureDailyHistory(
  db: Database,
  asset: { id: number; symbol: string; kind: 'stock' | 'crypto' },
  f: typeof fetch = fetch,
): Promise<string[]> {
  const flag = `daily:v2:${asset.symbol}`
  if (freshEnough(db, flag)) return []
  const ySym = asset.kind === 'crypto' ? `${asset.symbol}-USD` : asset.symbol
  try {
    const period2 = Math.floor(Date.now() / 1000)
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&period1=0&period2=${period2}`
    const r = await f(url, { headers: UA })
    if (!r.ok) return [`${asset.symbol}: Yahoo daily HTTP ${r.status}`]
    const quotes = parseYahooHistory(asset.symbol, await r.json())
    if (quotes.length === 0) return [`${asset.symbol}: no daily history`]
    const upsert = db.prepare(
      `INSERT INTO prices_daily (asset_id, priced_on, close_cents) VALUES (?, ?, ?)
       ON CONFLICT (asset_id, priced_on) DO UPDATE SET close_cents = excluded.close_cents`,
    )
    db.transaction(() => {
      for (const q of quotes) upsert.run(asset.id, q.pricedOn, q.cents)
      markFresh(db, flag)
    })()
    return []
  } catch (e) {
    return [`${asset.symbol}: ${e instanceof Error ? e.message : 'daily fetch failed'}`]
  }
}
