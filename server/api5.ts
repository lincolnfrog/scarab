import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { createPaySource, deletePaySource, updatePaySource } from '../engine/paychecks'
import { getTax, putTaxSettings } from '../engine/tax'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Tax intelligence: the whole year picture + harvesting, derived at read time.
export const api5 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api5.get('/tax', (c) => handle(c, () => getTax(db, today())))
api5.put('/tax/settings', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putTaxSettings(db, b))
})

// Per-person paychecks — the wage and withholding facts the tax picture derives from.
api5.post('/paychecks', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createPaySource(db, b))
})
api5.put('/paychecks/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => updatePaySource(db, Number(c.req.param('id')), b))
})
api5.delete('/paychecks/:id', (c) => handle(c, () => deletePaySource(db, Number(c.req.param('id')))))
