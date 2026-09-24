import { Hono } from 'hono'
import { getChartViews, getSeries, getSeriesCatalog, parseSeriesQuery, putChartViews } from '../engine/analytics'
import type { DbLike } from '../engine/db'
import { getHoldingsReturns } from '../engine/returns'
import * as svc from '../engine/services'
import { handle } from './api'
import { ensureDailyHistory } from './charts'
import { db as rawDb } from './db'
import { applyServerHistory, ensureHistoryPack, packResponse, serverMarket } from './history-pack'
import { backfillMonthlyHistory, fetchCryptoQuotes, fetchStockQuotes } from './prices'

const db = rawDb as unknown as DbLike

// Market data and analytics: price refresh, daily price charts, and the
// series layer behind Compare and the trend cards. Network fetching (Yahoo,
// CoinGecko) lives HERE — the engine only ever reads the database, so the
// browser build stays CORS-clean.
export const api10 = new Hono<{ Variables: { userEmail: string } }>()

// Same day as api2's /networth and /portfolio, so nw:* and inv:* series, the
// returns and the Dashboard all agree.
const today = () => new Date().toISOString().slice(0, 10)

api10.post('/prices/refresh', async (c) => {
  const assets = db.prepare('SELECT id, symbol, kind FROM assets').all() as {
    id: number
    symbol: string
    kind: 'stock' | 'crypto'
  }[]
  if (assets.length === 0) return c.json({ updated: 0, errors: ['no assets yet — record a trade first'] })
  const [stocks, crypto] = await Promise.all([
    fetchStockQuotes(assets.filter((a) => a.kind === 'stock').map((a) => a.symbol)),
    fetchCryptoQuotes(assets.filter((a) => a.kind === 'crypto').map((a) => a.symbol)),
  ])
  const updated = svc.upsertPrices(db, [...stocks.quotes, ...crypto.quotes])

  // Backfill month-end history once per asset (a failure retries weekly) —
  // without it, months before the first refresh value positions at cost and
  // the net-worth chart cliff-jumps. See backfillMonthlyHistory.
  const history = await backfillMonthlyHistory(db, assets, svc.upsertPrices, { today: today() })
  return c.json({ updated, backfilled: history.backfilled, errors: [...stocks.errors, ...crypto.errors, ...history.errors] })
})

api10.get('/charts/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const asset = db.prepare('SELECT id, symbol, kind FROM assets WHERE symbol = ?').get(symbol) as
    | { id: number; symbol: string; kind: 'stock' | 'crypto' }
    | undefined
  if (!asset) return c.json({ error: 'no such asset' }, 404)
  const errors = await ensureDailyHistory(rawDb, asset)
  return handle(c, () => svc.getChartData(db, symbol, errors))
})

// Benchmarks read the shared monthly history in memory (./history-pack.ts).
// Wanting benchmarks is also what starts or resumes its build (throttled there).
api10.get('/series/catalog', (c) => {
  wantHistory()
  return handle(c, () => getSeriesCatalog(db, today(), serverMarket(db)))
})
api10.get('/series', (c) =>
  handle(c, () => {
    const q = parseSeriesQuery({ ids: c.req.query('ids'), from: c.req.query('from'), to: c.req.query('to') })
    // Only benchmarks read the market history (as in the tab's route).
    return getSeries(db, today(), q.ids.some((id) => id.startsWith('bench:')) ? { ...q, ...serverMarket(db) } : q)
  }),
)

// The monthly market history for the whole basket universe: one file, the
// same bytes for every caller (network-only, like the basket, and answered by
// a vault-only server). 202 with progress while the first build runs.
api10.get('/basket/history', (c) => {
  wantHistory()
  return packResponse(db, c.req.header('accept-encoding'), c.req.header('if-none-match'))
})
// Write the history's month-end closes for this household's own assets into
// its quote table (a tab does the same with the file it downloaded).
api10.post('/prices/history', (c) => handle(c, () => applyServerHistory(db)))

/** Start or continue the history build in the background, if one is due and allowed now. */
function wantHistory() {
  ensureHistoryPack(db)?.catch((e: unknown) => console.error('market history build failed', e))
}

// Compare's saved views: the whole list in, the whole list out. New views are
// stamped with the caller's IAP identity; views already saved keep theirs.
api10.get('/series/views', (c) => handle(c, () => getChartViews(db)))
api10.put('/series/views', async (c) => {
  const b: unknown = await c.req.json().catch(() => undefined)
  return handle(c, () => putChartViews(db, b, { by: c.get('userEmail') ?? null, now: new Date().toISOString() }))
})

// Return by holding: money-weighted, from open lots and today's prices.
api10.get('/portfolio/returns', (c) => handle(c, () => getHoldingsReturns(db, today())))
