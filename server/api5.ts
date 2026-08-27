import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
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
