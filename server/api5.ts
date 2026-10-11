import { Hono } from 'hono'
import { getCapacity } from '../engine/capacity'
import { getContributions } from '../engine/contributions'
import type { DbLike } from '../engine/db'
import { createPaySource, deletePaySource, updatePaySource } from '../engine/paychecks'
import { listPeople, putPeople } from '../engine/people'
import { getTax, putTaxSettings } from '../engine/tax'
import { getTwoYear, priceTiming } from '../engine/twoyear'
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

// Contribution pace (copilot §4b) and the people it reads: birth years, HSA coverage.
api5.get('/contributions', (c) => handle(c, () => getContributions(db, today())))
api5.get('/people', (c) => handle(c, () => listPeople(db)))
api5.put('/people', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putPeople(db, b, today()))
})

// The two-year view (copilot §4e): next year on the same settings, and when-to-do-it priced over both.
api5.get('/tax/two-year', (c) => handle(c, () => getTwoYear(db, today())))
// Loss capacity: reported and forecast losses against recorded and planned sales, year by year (migration 28).
api5.get('/tax/capacity', (c) => handle(c, () => getCapacity(db, today())))
api5.post('/tax/timing', async (c) => {
  const b = await c.req.json()
  return handle(c, () => priceTiming(db, today(), b))
})
