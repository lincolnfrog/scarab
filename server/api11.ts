import { Hono } from 'hono'
import { getAssumptions } from '../engine/assumptions'
import { ackCheckup, getCheckup } from '../engine/checkup'
import { putCheckupSettings } from '../engine/checkup-settings'
import type { DbLike } from '../engine/db'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// The Checkup: derived findings that show their work, keyed per IAP identity
// for the "seen" mark (like the digest's), plus the constants they rest on.
export const api11 = new Hono<{ Variables: { userEmail: string } }>()

const today = () => new Date().toISOString().slice(0, 10)

api11.get('/checkup', (c) => handle(c, () => getCheckup(db, today(), c.get('userEmail'))))
api11.post('/checkup/ack', (c) => handle(c, () => ackCheckup(db, today(), c.get('userEmail'))))
api11.put('/checkup/settings', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putCheckupSettings(db, b))
})
api11.get('/assumptions', (c) => handle(c, () => getAssumptions(db)))
