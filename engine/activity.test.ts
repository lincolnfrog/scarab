import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { getActivity } from './services'
import { createOpeningPositions, createTrade, vestUnvested } from './invest'
import { onBothEngines } from './test/parity'

const TODAY = '2026-09-22'

/**
 * A checking account with one paycheck, a brokerage with a starting position,
 * a buy, a sale and a transfer in, and an employee stock plan with a vest whose
 * withholding the employer kept — each written the way the app writes it.
 */
function seed(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
  db.prepare(
    "INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (1, '2026-09-01', 400000, 'ACME PAYROLL', 'p1')",
  ).run()
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run() // 1
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking, stock_plan) VALUES ('E*Trade', 'brokerage', 'lots', 1)").run() // 2
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ACME', 'stock')").run()
  createOpeningPositions(db, { investAccountId: 1, asOf: '2026-08-01', rows: [{ symbol: 'VTI', qty: '10', basisCents: 200_000, acquiredOn: '2020-01-02' }] }, TODAY)
  const trade = (b: Record<string, unknown>) =>
    createTrade(db, { investAccountId: 1, symbol: 'VTI', assetKind: 'stock', qty: '1', ...b }, TODAY)
  trade({ tradedOn: '2026-08-10', side: 'buy', totalCents: 25_000 })
  trade({ tradedOn: '2026-08-20', side: 'sell', totalCents: 26_000 })
  trade({ tradedOn: '2026-08-25', side: 'buy', totalCents: 24_000, acquiredOn: '2019-05-01' }) // moved in from another broker
  vestUnvested(db, { investAccountId: 2, symbol: 'ACME', qty: '100', tradedOn: '2026-09-15', totalCents: 1_000_000, withheldQty: '36', allowUntracked: true }, TODAY)
}

describe('recent activity', () => {
  it('reads each trade’s cash the way its account does: starting positions, vests and withholding moved none', () => {
    const db = openDb(':memory:') as unknown as DbLike
    seed(db)
    expect(getActivity(db).map(({ on_date, description, cents, tag, kind }) => [on_date, description, cents, tag, kind])).toEqual([
      ['2026-09-15', 'withheld for tax ACME', 0, 'E*Trade', 'trade'], // the proceeds paid the tax, never landed here
      ['2026-09-15', 'vest ACME', 0, 'E*Trade', 'trade'], // pay, in shares — not a $10,000 purchase
      ['2026-09-01', 'ACME PAYROLL', 400_000, '—', 'tx'],
      ['2026-08-25', 'transfer in VTI', 0, 'Taxable', 'trade'],
      ['2026-08-20', 'sell VTI', 26_000, 'Taxable', 'trade'],
      ['2026-08-10', 'buy VTI', -25_000, 'Taxable', 'trade'],
      ['2026-08-01', 'starting position VTI', 0, 'Taxable', 'trade'], // booked as of the statement, not bought that day
    ])
  })

  it('keeps the eight newest, and answers the same on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        seed(db)
        const add = db.prepare(
          "INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (1, '2026-07-01', -500, 'COFFEE', ?)",
        )
        for (let i = 0; i < 5; i++) add.run(`c${i}`)
      },
      (db) => getActivity(db),
    )
    expect(browser).toEqual(server)
    expect(server).toHaveLength(8)
    expect(server.at(-1)).toMatchObject({ on_date: '2026-07-01', description: 'COFFEE', cents: -500 })
    expect(server.filter((r) => r.kind === 'trade' && r.cents === 0).map((r) => r.description)).toEqual([
      'withheld for tax ACME',
      'vest ACME',
      'transfer in VTI',
      'starting position VTI',
    ])
  })
})
