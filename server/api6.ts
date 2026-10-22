import { Hono } from 'hono'
import type { DbLike } from '../engine/db'
import { ackDigest, getDigest } from '../engine/digest'
import { getRecurring } from '../engine/recurring'
import { getSetup, putSetup } from '../engine/setup'
import { handle } from './api'
import { db as rawDb } from './db'
import { ensurePmmsRate } from './rates'

const db = rawDb as unknown as DbLike

// Digest, recurring and the setup checklist: "since you were last here" and the checklist's hide mark, keyed per IAP identity.
export const api6 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api6.get('/digest', async (c) => {
  const errors = await ensurePmmsRate(db) // once per day; failures degrade quietly
  return handle(c, () => ({ ...getDigest(db, c.get('userEmail'), today()), errors }))
})
api6.post('/digest/ack', (c) => handle(c, () => ackDigest(db, c.get('userEmail'))))
api6.get('/recurring', (c) => handle(c, () => getRecurring(db, today())))
api6.get('/setup', (c) => handle(c, () => getSetup(db, c.get('userEmail'))))
api6.put('/setup', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putSetup(db, c.get('userEmail'), b))
})
