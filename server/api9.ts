import { Hono } from 'hono'
import { createAccountFlow, deleteAccountFlow, listAccountFlows, updateAccountFlow } from '../engine/account-flows'
import { getAllocation, putAccountClass, putAssetClass, putTarget } from '../engine/allocation'
import type { DbLike } from '../engine/db'
import {
  createOpeningPositions,
  createPastSales,
  deleteBalanceSnapshot,
  deleteTrade,
  getCheckin,
  getInvestAccount,
  listAssets,
  listBalanceSnapshots,
  listInvestOwners,
  setManualPrice,
  updateTrade,
} from '../engine/invest'
import { deleteHarvestProfile, putHarvestProfile } from '../engine/harvest'
import { createPlannedSale, deletePlannedSale, listPlannedSales, updatePlannedSale } from '../engine/planned-sales'
import { deleteReportedRealized, putReportedRealized } from '../engine/realized-reported'
import { getRealizedReport, previewTrade } from '../engine/tax'
import { handle } from './api'
import { db as rawDb } from './db'

const db = rawDb as unknown as DbLike

// Brokerage routes added by this pass (account detail, trade edits and
// previews, opening positions, manual prices). Registered once in app.ts;
// the existing investment routes stay in api2.ts. Each has an in-tab mirror
// in src/local/routes-invest.ts calling the same engine function.
export const api9 = new Hono<{ Variables: { userEmail: string } }>()

// UTC, the same day api2's trade and balance routes use.
const today = () => new Date().toISOString().slice(0, 10)
/** An optional ?accountId= — a positive integer, else undefined (the engine refuses anything stranger). */
const numberQuery = (v: string | undefined): number | undefined => (v === undefined || v === '' ? undefined : Number(v))

// One account, everything its drawer shows; and who accounts can belong to.
// (The account list and its create/patch/delete are in api2.)
api9.get('/invest/accounts/:id', (c) => handle(c, () => getInvestAccount(db, Number(c.req.param('id')), today())))
api9.get('/invest/owners', (c) => handle(c, () => listInvestOwners(db)))
// Every recorded symbol and its kind (the symbol box locks a recorded symbol's kind).
api9.get('/invest/assets', (c) => handle(c, () => listAssets(db)))

// The balance check-in: every number that comes from a statement, with its
// latest value. Read-only — it saves through each number's own route.
api9.get('/invest/checkin', (c) => handle(c, () => getCheckin(db, today())))

// Balance-tracked accounts: the snapshot history, and removing one entry.
// (PUT /invest/balances — one snapshot or a batch — is in api2.)
api9.get('/invest/balances', (c) => handle(c, () => listBalanceSnapshots(db, { accountId: c.req.query('accountId') })))
api9.delete('/invest/balances/:accountId/:date', (c) =>
  handle(c, () => deleteBalanceSnapshot(db, Number(c.req.param('accountId')), c.req.param('date'))),
)

// A balance account's realized gains for a tax year, as its broker reports them.
api9.put('/invest/accounts/:id/realized/:year', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putReportedRealized(db, Number(c.req.param('id')), c.req.param('year'), b, today()))
})
api9.delete('/invest/accounts/:id/realized/:year', (c) =>
  handle(c, () => deleteReportedRealized(db, Number(c.req.param('id')), c.req.param('year'), today())),
)

// A balance account's deposits and withdrawals (dated ahead: planned), and a taxable one's harvest forecast —
// the manager's estimate of the losses it will realize (migration 28).
api9.get('/invest/flows', (c) => handle(c, () => listAccountFlows(db, today(), { accountId: numberQuery(c.req.query('accountId')) })))
api9.post('/invest/flows', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createAccountFlow(db, b, today()))
})
api9.put('/invest/flows/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => updateAccountFlow(db, Number(c.req.param('id')), b, today()))
})
api9.delete('/invest/flows/:id', (c) => handle(c, () => deleteAccountFlow(db, Number(c.req.param('id')), today())))
api9.put('/invest/accounts/:id/harvest', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putHarvestProfile(db, Number(c.req.param('id')), b, today()))
})
api9.delete('/invest/accounts/:id/harvest', (c) => handle(c, () => deleteHarvestProfile(db, Number(c.req.param('id')))))

// Sales planned from a lots account: what the capacity view nets against the losses expected by then.
api9.get('/invest/planned-sales', (c) => handle(c, () => listPlannedSales(db, { accountId: numberQuery(c.req.query('accountId')) })))
api9.post('/invest/planned-sales', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createPlannedSale(db, b, today()))
})
api9.put('/invest/planned-sales/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => updatePlannedSale(db, Number(c.req.param('id')), b, today()))
})
api9.delete('/invest/planned-sales/:id', (c) => handle(c, () => deletePlannedSale(db, Number(c.req.param('id')))))

// Starting positions: lots already held as of a statement date, all or none.
api9.post('/trades/opening', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createOpeningPositions(db, b, today()))
})

// Past sales: shares sold before Scarab tracked them, each with its lot's basis — all or none.
api9.post('/trades/sales', async (c) => {
  const b = await c.req.json()
  return handle(c, () => createPastSales(db, b, today()))
})

// What recording a trade would do — realized gain, estimated tax, wash-sale
// traps — computed and written nowhere.
api9.post('/trades/preview', async (c) => {
  const b = await c.req.json()
  return handle(c, () => previewTrade(db, b, today()))
})

// The activity ledger's edits: fix a trade, or delete one (sales that took
// from a deleted buy keep their gains, rewritten with its basis).
api9.patch('/trades/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => updateTrade(db, Number(c.req.param('id')), b, today()))
})
api9.delete('/trades/:id', (c) => handle(c, () => deleteTrade(db, Number(c.req.param('id')))))

// A year's realized gains, lot by lot — Form 8949's lines — from taxable accounts.
api9.get('/invest/realized', (c) => handle(c, () => getRealizedReport(db, c.req.query('year'), today())))

// A price typed in by hand, for what no quote source covers.
api9.post('/prices/manual', async (c) => {
  const b = await c.req.json()
  return handle(c, () => setManualPrice(db, b, today()))
})

// Target allocation and tax-aware rebalancing (copilot §4d).
api9.get('/allocation', (c) => handle(c, () => getAllocation(db, today())))
api9.put('/allocation/target', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putTarget(db, b))
})
api9.put('/allocation/assets/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putAssetClass(db, Number(c.req.param('id')), b))
})
api9.put('/allocation/accounts/:id', async (c) => {
  const b = await c.req.json()
  return handle(c, () => putAccountClass(db, Number(c.req.param('id')), b))
})
