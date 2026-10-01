/**
 * Print a snapshot fixture for engine/fixtures/: a small household written by
 * THIS checkout's engine, exercising the parts migrations tend to disturb.
 * Run it at the commit whose version you are freezing (engine/fixtures/README.md):
 *
 *   npx tsx scripts/mkfixture.ts > engine/fixtures/snapshot-vN.json
 *
 * Every date is fixed, so the same engine always writes the same household.
 */
import type { DbLike } from '../engine/db'
import { createOpeningPositions, createTrade, putBalanceSnapshot, putUnvested, vestUnvested } from '../engine/invest'
import { putAccountClass, putAssetClass, putTarget } from '../engine/allocation'
import { putCheckupSettings } from '../engine/checkup-settings'
import { createPaySource } from '../engine/paychecks'
import { putPeople } from '../engine/people'
import { createAccount, createInvestAccount, createLiability, createProperty, putBudget, putValuation, runImport } from '../engine/services'
import { dumpDb } from '../engine/snapshot'
import { openDb } from '../server/migrations'

const TODAY = '2026-09-25'
const db = openDb(':memory:') as unknown as DbLike

// A bank account with imported transactions, and a budget.
const checking = createAccount(db, { name: 'Checking', kind: 'checking' }) as { id: number }
runImport(
  db,
  { accountId: checking.id, filename: 'checking.csv', content: 'Date,Description,Amount\n2026-09-01,ACME PAYROLL,4000.00\n2026-09-03,TST* SOME BISTRO,-42.50\n2026-09-10,PG&E WEB ONLINE,-120.00\n' },
  'max@example.com',
)
const dining = (db.prepare("SELECT id FROM categories WHERE name = 'Dining'").get() as { id: number }).id
putBudget(db, { categoryId: dining, monthlyCents: 30_000 })

// A lots-tracked brokerage: a trade and a starting position.
const vanguard = createInvestAccount(db, { name: 'Vanguard', kind: 'brokerage', tracking: 'lots' }).id
createTrade(db, { investAccountId: vanguard, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-03-02', qty: '10', totalCents: 250_000 }, TODAY)
createOpeningPositions(db, { investAccountId: vanguard, asOf: TODAY, rows: [{ symbol: 'VXUS', qty: '20', basisCents: 100_000, acquiredOn: '2019-04-01' }] }, TODAY)

// A crypto account.
const coinbase = createInvestAccount(db, { name: 'Coinbase', kind: 'crypto', tracking: 'lots' }).id
createOpeningPositions(db, { investAccountId: coinbase, asOf: TODAY, rows: [{ symbol: 'BTC', qty: '0.5', basisCents: 1_000_000, acquiredOn: '2017-06-06' }] }, TODAY)

// An employee stock plan: a scheduled grant, a net-settled vest, and a paycheck pointing at it.
const plan = createInvestAccount(db, { name: 'Morgan Stanley', kind: 'brokerage', tracking: 'lots', stockPlan: true }).id
putUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '400', nextVestOn: '2026-11-15', vestEveryMonths: 3, vestQty: '50' }, TODAY)
vestUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '50', tradedOn: '2026-08-15', totalCents: 500_000, withheldQty: '18' }, TODAY)
// A second grant of the same stock on its own schedule (migration 22).
putUnvested(db, { investAccountId: plan, symbol: 'ACME', qty: '120', nextVestOn: '2027-02-15', vestEveryMonths: 6, vestQty: '30' }, TODAY)
// The paycheck carries a Roth 401(k) line and the employer's match (migration 23).
createPaySource(db, {
  earner: 'Max', employer: 'Acme', cadence: 'biweekly', paidOn: '2026-09-18', grossCents: 600_000, fedWithheldCents: 120_000,
  retirementCents: 40_000, rothCents: 20_000, matchRateMicro: 500_000, matchCapMicro: 60_000, matchTrueUp: true, investAccountId: plan,
})

// A balance-tracked 401(k).
const k401 = createInvestAccount(db, { name: 'Fidelity 401(k)', kind: 'retirement', tracking: 'balance' }).id
putBalanceSnapshot(db, { investAccountId: k401, balancedOn: '2026-06-30', balanceCents: 18_000_000 })

// Asset classes (migration 24): one set on an asset, one on a balance-only account; and a target.
putAssetClass(db, (db.prepare("SELECT id FROM assets WHERE symbol = 'VXUS'").get() as { id: number }).id, { assetClass: 'intl_stock' })
putAccountClass(db, k401, { assetClass: 'us_stock' })
putTarget(db, { targets: { us_stock: 600_000, intl_stock: 200_000, bonds: 150_000, cash: 50_000 } })

// The settings blobs the copilot reads: people (birth year, HSA) and the Checkup's threshold and roles.
putPeople(db, { people: [{ name: 'Max', birthYear: 1975, hsaCoverage: 'family', hsaCents: 300_000 }, { name: 'Nicole', birthYear: 1977 }] }, TODAY)
putCheckupSettings(db, { concentrationMicro: 150_000, charityCategoryId: 0 })

// A home with a valuation and its mortgage.
const home = createProperty(db, { name: 'Home', purchasedOn: '2015-05-01', purchaseCents: 90_000_000 }) as { id: number }
putValuation(db, home.id, { valuedOn: '2026-09-20', valueCents: 122_500_000 })
createLiability(db, { propertyId: home.id, name: 'Mortgage', rateMicro: 30_000, balanceCents: 60_000_000, balancedOn: '2026-09-01' })

process.stdout.write(JSON.stringify(dumpDb(db), null, 1) + '\n')
