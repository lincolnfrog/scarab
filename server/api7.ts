import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import {
  compareScenarios,
  createScenario,
  deleteScenario,
  listScenarios,
  priceScenarioDecision,
  updateScenario,
} from '../engine/scenarios'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// The decision engine: saved scenarios, compared side by side against today's
// ledger. Nothing derived is stored — only the knob-sets.
export const api7 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api7.get('/scenarios', (c) => handle(c, () => listScenarios(db, today())))
api7.post('/scenarios', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createScenario(db, b, today()))
})
api7.put('/scenarios/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => updateScenario(db, Number(c.req.param('id')), b, today()))
})
api7.delete('/scenarios/:id', (c) => handle(c, () => deleteScenario(db, Number(c.req.param('id')))))
api7.post('/scenarios/compare', async (c) => {
  const b = await c.req.json()
  return handle(c, () => compareScenarios(db, today(), b))
})
api7.post('/scenarios/price', async (c) => {
  const b = await c.req.json()
  return handle(c, () => priceScenarioDecision(db, today(), b))
})
