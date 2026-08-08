import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import * as svc from '../engine/services'
import { handle } from './api'
import { ensureDailyHistory } from './charts'
import { db as rawDb } from './db'
import { fetchCryptoQuotes, fetchHistory, fetchStockQuotes } from './prices'

const db = rawDb as unknown as DbLike

// Investments, prices, property, net worth. Network fetching (Yahoo,
// CoinGecko, on-chain sources) lives HERE — the engine only ever reads the
// database, so the browser build stays CORS-clean.
export const api2 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api2.get('/invest/accounts', (c) => handle(c, () => svc.listInvestAccounts(db)))
api2.post('/invest/accounts', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createInvestAccount(db, b))
})
api2.put('/invest/balances', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putBalanceSnapshot(db, b))
})

api2.post('/trades', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createTrade(db, b))
})
api2.get('/trades', (c) => handle(c, () => svc.listTrades(db)))
api2.get('/portfolio', (c) => handle(c, () => svc.getPortfolio(db, today())))

api2.post('/prices/refresh', async (c) => {
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

  // Backfill monthly history once per asset — without it, months before the
  // first refresh value positions at cost and the net-worth chart cliff-jumps.
  const errors = [...stocks.errors, ...crypto.errors]
  let backfilled = 0
  for (const a of assets) {
    const flag = `backfilled:${a.symbol}`
    if (db.prepare('SELECT 1 FROM app_meta WHERE key = ?').get(flag)) continue
    const h = await fetchHistory(a.symbol, a.kind)
    errors.push(...h.errors)
    if (h.quotes.length === 0) continue
    db.transaction(() => {
      svc.upsertPrices(db, h.quotes)
      db.prepare("INSERT INTO app_meta (key, value) VALUES (?, datetime('now'))").run(flag)
    })()
    backfilled += h.quotes.length
  }
  return c.json({ updated, backfilled, errors })
})

api2.get('/properties', (c) => handle(c, () => svc.listProperties(db)))
api2.post('/properties', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createProperty(db, b))
})
api2.put('/properties/:id/valuation', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putValuation(db, Number(c.req.param('id')), b))
})
api2.post('/liabilities', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createLiability(db, b))
})
api2.put('/liabilities/:id/balance', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putLiabilityBalance(db, Number(c.req.param('id')), b))
})

api2.get('/networth', (c) => handle(c, () => svc.getNetworth(db, today())))
api2.get('/activity', (c) => handle(c, () => svc.getActivity(db)))

api2.get('/unvested', (c) => handle(c, () => svc.getUnvested(db)))
api2.put('/unvested', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putUnvested(db, b, today()))
})
api2.post('/unvested/vest', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.vestUnvested(db, b, today()))
})

api2.get('/charts/:symbol', async (c) => {
  const symbol = c.req.param('symbol').toUpperCase()
  const asset = db.prepare('SELECT id, symbol, kind FROM assets WHERE symbol = ?').get(symbol) as
    | { id: number; symbol: string; kind: 'stock' | 'crypto' }
    | undefined
  if (!asset) return c.json({ error: 'no such asset' }, 404)
  const errors = await ensureDailyHistory(rawDb, asset)
  return handle(c, () => svc.getChartData(db, symbol, errors))
})
