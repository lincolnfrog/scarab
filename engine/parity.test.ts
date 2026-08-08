import { describe, expect, it } from 'vitest'
import type { DbLike } from './db'
import { detectTransfers, importStatement } from './import'
import { netWorthSeries } from './networth'
import { runRepairs } from './repairs'
import { openBrowserDb } from './sqljs-db'
import { dumpDb, loadDump } from './snapshot'
import { migrate } from './migrations'
import { openDb } from '../server/migrations'

/**
 * The point of the seam: better-sqlite3 (server) and sql.js (browser) must be
 * indistinguishable to the engine. Run the same real-world scenario on both
 * and demand identical results.
 */

const WF_CSV = `"07/01/2026","-3418.00","*","","MR. COOPER MORTGAGE PYMT"
"07/03/2026","-12000.00","*","","ONLINE TRANSFER TO WEALTHFRONT EDI PYMNTS"
"07/05/2026","11918.00","*","","ACME CORP PAYROLL 260705 DIRECT DEP"
"07/09/2026","-312.44","*","","COSTCO WHSE #0423 SPRINGFIELD US"
"07/22/2026","-88.12","*","","CHEVRON 0093456 SPRINGFIELD US"
"08/01/2026","-3418.00","*","","MR. COOPER MORTGAGE PYMT"
"08/04/2026","11918.00","*","","ACME CORP PAYROLL 260804 DIRECT DEP"
"08/05/2026","-96.40","*","","TRADER JOES #202 SPRINGFIELD US"`

const CITI_CSV = `Status,Date,Description,Debit,Credit
Cleared,08/06/2026,AUTOPAY 123 AUTO-PMT,,-3514.40
Cleared,08/02/2026,COSTCO WHSE #0029,142.55,
Cleared,07/28/2026,BLUE BOTTLE COFFEE,6.50,`

function scenario(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('WF Checking', 'checking')").run()
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('Citi', 'checking')").run()
  const a = importStatement(db, { accountId: 1, filename: 'wf.csv', content: WF_CSV, importedBy: 'parity' })
  const b = importStatement(db, { accountId: 2, filename: 'citi.csv', content: CITI_CSV, importedBy: 'parity' })
  const repairs = runRepairs(db)
  const transfers = detectTransfers(db)
  const series = netWorthSeries(db, '2026-08-09')
  const cats = db
    .prepare(
      `SELECT COALESCE(c.name,'(none)') AS name, count(*) AS n, SUM(t.amount_cents) AS total
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       GROUP BY 1 ORDER BY 1`,
    )
    .all()
  return { a, b, repairs, transfers, series, cats }
}

describe('engine parity: better-sqlite3 vs sql.js', () => {
  it('produces byte-identical results for the full import→repair→networth pipeline', async () => {
    const server = openDb(':memory:')
    const browser = await openBrowserDb()
    migrate(browser)

    const s = scenario(server as unknown as DbLike)
    const w = scenario(browser)

    expect(w.a).toEqual(s.a)
    expect(w.b).toEqual(s.b)
    expect(w.repairs).toEqual(s.repairs)
    expect(w.transfers).toEqual(s.transfers)
    expect(w.cats).toEqual(s.cats)
    expect(w.series).toEqual(s.series)
    browser.close()
  })

  it('round-trips a snapshot from server engine to browser engine', async () => {
    const server = openDb(':memory:')
    scenario(server as unknown as DbLike)
    const dump = dumpDb(server as unknown as DbLike)

    const browser = await openBrowserDb()
    migrate(browser)
    loadDump(browser, dump)
    const [sTx, wTx] = [server, browser].map(
      (d) => ((d as DbLike).prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n,
    )
    expect(wTx).toBe(sTx)
    expect(netWorthSeries(browser, '2026-08-09')).toEqual(netWorthSeries(server as unknown as DbLike, '2026-08-09'))
    browser.close()
  })
})
