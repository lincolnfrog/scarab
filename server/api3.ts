import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import * as svc from '../engine/services'
import { simulate, type SimParams } from '../engine/simulate'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Dream Home goal, loan options, Monte Carlo.
export const api3 = new Hono<{ Variables: { userEmail: string } }>()

export type { GoalSettings, RentalSettings } from '../engine/services'

api3.get('/goal', (c) => handle(c, () => svc.getGoal(db)))
api3.put('/goal', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.putGoal(db, b))
})

api3.post('/loans', async (c) => {
  const b = await c.req.json()
  return handle(c, () => svc.createLoan(db, b))
})
api3.delete('/loans/:id', (c) => handle(c, () => svc.deleteLoan(db, Number(c.req.param('id')))))

api3.post('/simulate', async (c) => {
  const p = (await c.req.json()) as SimParams
  if (
    !Number.isSafeInteger(p.startYear) ||
    !Number.isSafeInteger(p.endYear) ||
    p.endYear <= p.startYear ||
    p.endYear - p.startYear > 60
  )
    return c.json({ error: 'startYear/endYear out of range' }, 400)
  p.paths = Math.min(5000, Math.max(200, p.paths ?? 2000))
  return c.json(simulate(p))
})
