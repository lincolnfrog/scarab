import { describe, expect, it } from 'vitest'
import { getAssumptions } from './assumptions'
import { ackCheckup, getCheckup } from './checkup'
import { putCheckupSettings } from './checkup-settings'
import type { DbLike } from './db'
import { PMMS_KEY } from './digest'
import { putTaxSettings } from './tax'
import { seedHousehold } from './test/household'
import { onBothEngines } from './test/parity'

const TODAY = '2026-09-22'

/**
 * The seeded household plus enough for every Checkup rule to have something
 * to read: a stock plan holding the employer's stock with a paycheck tied to
 * it, months of spending, a rated mortgage, property tax and giving
 * categories, a long-term gain lot, a recurring charge that crept up, and a
 * mortgage-rate quote under the best saved option.
 */
function household(db: DbLike) {
  seedHousehold(db)
  putTaxSettings(db, { filingStatus: 'mfj', state: 'CA', wagesAnnualCents: 30_000_000 })
  db.prepare('UPDATE liabilities SET rate_micro = 65000 WHERE id = 1').run()
  db.prepare("UPDATE invest_accounts SET stock_plan = 1 WHERE id = 1").run()
  db.prepare("INSERT INTO pay_sources (earner, employer, cadence, paid_on, gross_cents, invest_account_id) VALUES ('Max', 'Acme', 'biweekly', '2026-09-11', 1100000, 1)").run()
  db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 2, '2023-02-01', 'buy', 20000000, 400000)").run()
  db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (2, '2026-09-19', 52000)").run()
  db.prepare("INSERT INTO categories (name, kind) VALUES ('Giving', 'expense'), ('Property tax', 'expense')").run()
  const tx = db.prepare(
    `INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash)
     VALUES (1, ?, ?, ?, (SELECT id FROM categories WHERE name = ?), ?)`,
  )
  let n = 0
  for (const m of ['03', '04', '05', '06', '07', '08']) {
    tx.run(`2026-${m}-03`, -420_000, 'WHOLE FOODS', 'Groceries', `g${n++}`)
    tx.run(`2026-${m}-05`, -1_500, 'NETFLIX.COM', 'Subscriptions', `n${n++}`)
  }
  tx.run('2026-09-05', -1_800, 'NETFLIX.COM', 'Subscriptions', `n${n++}`)
  tx.run('2026-04-10', -900_000, 'COUNTY TAX COLLECTOR', 'Property tax', `p${n++}`)
  tx.run('2026-06-01', -250_000, 'RED CROSS', 'Giving', `c${n++}`)
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PMMS_KEY, JSON.stringify({ on: '2026-09-18', rateMicro: 61_000 }))
  db.prepare("INSERT INTO loan_options (name, rate_micro, term_months) VALUES ('Jumbo 30', 66000, 360)").run()
  putCheckupSettings(db, { concentrationMicro: 50_000 })
}

describe('Checkup parity: better-sqlite3 vs sql.js', () => {
  it('reads the same findings, headroom and calendar', async () => {
    const { server, browser } = await onBothEngines(household, (db) => getCheckup(db, TODAY, 'max@x'))
    expect(browser).toEqual(server)
    expect(server.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(['runway-low', 'safe-harbor', 'concentration', 'itemize', 'give-shares', 'price-creep', 'allocation-drift', 'mortgage-rate']),
    )
  })

  it('stores the same seen mark', async () => {
    const { server, browser } = await onBothEngines(household, (db) => {
      ackCheckup(db, TODAY, 'max@x')
      return getCheckup(db, TODAY, 'max@x').findings.map((f) => [f.id, f.isNew])
    })
    expect(browser).toEqual(server)
  })

  it('lists the same assumptions', async () => {
    const { server, browser } = await onBothEngines(household, getAssumptions)
    expect(browser).toEqual(server)
  })
})
