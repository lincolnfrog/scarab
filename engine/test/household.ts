import type { DbLike } from '../db'

/**
 * Test helper: a small household with one of everything net worth reads — a
 * bank account with transactions, lots-tracked brokerage, Roth and crypto
 * accounts (one of them unpriced, so it is carried at cost), a balance-tracked
 * 401(k), a house with a valuation and a mortgage. Raw inserts rather than the
 * services, so tests built on it keep passing as validation tightens.
 *
 * Dated facts run 2026-02 … 2026-09; use it with a `today` in 2026-09.
 */
export function seedHousehold(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', 100000)").run() // 1
  const tx = db.prepare(
    'INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (1, ?, ?, ?, ?)',
  )
  tx.run('2026-03-05', 500_000, 'ACME PAYROLL', 'h1')
  tx.run('2026-05-10', -120_000, 'MORTGAGE PMT', 'h2')
  tx.run('2026-08-01', 250_000, 'ACME PAYROLL', 'h3')

  const account = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  account.run('Taxable', 'brokerage', 'lots') // 1
  account.run('Roth IRA', 'retirement', 'lots') // 2
  account.run('401(k)', 'retirement', 'balance') // 3
  account.run('Coinbase', 'crypto', 'lots') // 4

  const asset = db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?)')
  asset.run('VTI', 'stock') // 1
  asset.run('QQQ', 'stock') // 2
  asset.run('BTC', 'crypto') // 3 — never priced
  const trade = db.prepare(
    'INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, ?, ?, ?, ?, ?)',
  )
  trade.run(1, 1, '2026-02-10', 'buy', 10_000_000, 200_000)
  trade.run(2, 2, '2026-04-15', 'buy', 4_000_000, 180_000)
  trade.run(4, 3, '2026-06-01', 'buy', 100_000, 650_000)
  trade.run(1, 1, '2026-07-20', 'sell', 4_000_000, 96_000)

  const price = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)')
  price.run(1, '2026-03-31', 21_000)
  price.run(1, '2026-06-30', 23_500)
  price.run(1, '2026-09-19', 24_800)
  price.run(2, '2026-05-29', 47_000)

  const snap = db.prepare('INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (3, ?, ?)')
  snap.run('2026-03-31', 4_200_000)
  snap.run('2026-06-30', 4_450_000)

  db.prepare("INSERT INTO properties (name, purchased_on, purchase_cents) VALUES ('House', '2026-04-01', 80000000)").run() // 1
  db.prepare("INSERT INTO property_valuations (property_id, valued_on, value_cents) VALUES (1, '2026-07-15', 85000000)").run()
  db.prepare("INSERT INTO liabilities (property_id, name) VALUES (1, 'Mortgage')").run() // 1
  const owed = db.prepare('INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (1, ?, ?)')
  owed.run('2026-04-01', 64_000_000)
  owed.run('2026-08-01', 63_500_000)
}
