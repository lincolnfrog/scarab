import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import * as svc from '../engine/services'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Thin HTTP shell over engine/services — the same functions the browser's
// local dispatcher calls. All handlers assume IAP already authenticated.
export const api = new Hono<{ Variables: { userEmail: string } }>()

export function handle(c: { json: (o: object, s?: number) => Response }, fn: () => unknown): Response {
  try {
    return c.json(fn() as object)
  } catch (e) {
    if (e instanceof svc.ApiError) return c.json({ error: e.message }, e.status as 400)
    throw e
  }
}

api.get('/health', (c) => handle(c, () => svc.health()))

api.get('/accounts', (c) => handle(c, () => svc.listAccounts(db)))
api.post('/accounts', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createAccount(db, b))
})
api.patch('/accounts/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.anchorAccount(db, Number(c.req.param('id')), b))
})

api.get('/categories', (c) => handle(c, () => svc.listCategories(db)))
api.post('/categories', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createCategory(db, b))
})

api.post('/imports', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.runImport(db, b, c.get('userEmail')))
})
api.get('/imports', (c) => handle(c, () => svc.listImports(db)))

api.get('/transactions', (c) =>
  handle(c, () =>
    svc.listTransactions(db, {
      q: c.req.query('q'),
      month: c.req.query('month'),
      categoryId: c.req.query('category_id'),
      accountId: c.req.query('account_id'),
      uncategorized: c.req.query('uncategorized') === '1',
    }),
  ),
)
api.patch('/transactions/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.patchTransaction(db, Number(c.req.param('id')), b))
})

api.get('/cashflow/monthly', (c) => handle(c, () => svc.cashflowMonthly(db)))
api.get('/cashflow/categories', (c) => handle(c, () => svc.cashflowCategories(db, c.req.query('month'))))
api.get('/budget', (c) => handle(c, () => svc.getBudget(db, c.req.query('month'))))
api.put('/budget', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putBudget(db, b))
})
