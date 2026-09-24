import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import * as svc from '../engine/services'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Investments, property, net worth. Price refresh and price charts — the
// routes that fetch from the network — live in api10.
export const api2 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api2.get('/invest/accounts', (c) => handle(c, () => svc.listInvestAccounts(db)))
api2.post('/invest/accounts', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createInvestAccount(db, b))
})
api2.patch('/invest/accounts/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.updateInvestAccount(db, Number(c.req.param('id')), b))
})
api2.delete('/invest/accounts/:id', (c) => handle(c, () => svc.deleteInvestAccount(db, Number(c.req.param('id')))))
api2.put('/invest/balances', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putBalanceSnapshot(db, b, today()))
})

api2.post('/trades', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createTrade(db, b, today()))
})
// The activity ledger: every trade, newest first; ?accountId=&symbol=&year= narrow it.
api2.get('/trades', (c) =>
  handle(c, () => svc.listTrades(db, { accountId: c.req.query('accountId'), symbol: c.req.query('symbol'), year: c.req.query('year') })),
)
api2.get('/portfolio', (c) => handle(c, () => svc.getPortfolio(db, today())))

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
