import type { DbLike } from './db'

// Every migration is append-only: never edit an entry that has shipped, add a new one.
export const migrations: string[] = [
  // 1 — Phase 0: bootstrap
  `CREATE TABLE app_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,

  // 2 — Phase I: the cash ledger.
  // Facts only: transactions are immutable rows; everything on the Cash screen
  // is computed from them. Money is signed integer cents (+inflow, -outflow).
  `CREATE TABLE accounts (
     id          INTEGER PRIMARY KEY,
     name        TEXT NOT NULL,
     kind        TEXT NOT NULL CHECK (kind IN ('checking','savings')),
     external_id TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE categories (
     id   INTEGER PRIMARY KEY,
     name TEXT NOT NULL UNIQUE,
     kind TEXT NOT NULL CHECK (kind IN ('income','expense','transfer')),
     sort INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE imports (
     id            INTEGER PRIMARY KEY,
     account_id    INTEGER NOT NULL REFERENCES accounts(id),
     filename      TEXT NOT NULL,
     format        TEXT NOT NULL,
     rows_total    INTEGER NOT NULL,
     rows_imported INTEGER NOT NULL,
     rows_skipped  INTEGER NOT NULL,
     imported_by   TEXT NOT NULL,
     imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE transactions (
     id             INTEGER PRIMARY KEY,
     account_id     INTEGER NOT NULL REFERENCES accounts(id),
     posted_on      TEXT NOT NULL,             -- ISO yyyy-mm-dd
     amount_cents   INTEGER NOT NULL,          -- signed
     description    TEXT NOT NULL,             -- raw statement text
     category_id    INTEGER REFERENCES categories(id),
     categorized_by TEXT,                      -- 'rule:<id>' | 'manual'
     import_id      INTEGER REFERENCES imports(id),
     dedupe_hash    TEXT NOT NULL,             -- see server/import.ts
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE UNIQUE INDEX idx_tx_dedupe ON transactions(account_id, dedupe_hash);
   CREATE INDEX idx_tx_posted ON transactions(posted_on);
   CREATE INDEX idx_tx_category ON transactions(category_id);
   CREATE TABLE rules (
     id          INTEGER PRIMARY KEY,
     pattern     TEXT NOT NULL,                -- uppercase substring match
     category_id INTEGER NOT NULL REFERENCES categories(id),
     priority    INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE budgets (
     category_id   INTEGER PRIMARY KEY REFERENCES categories(id),
     monthly_cents INTEGER NOT NULL
   );
   INSERT INTO categories (name, kind, sort) VALUES
     ('Salary','income',0),
     ('Consulting','income',1),
     ('RSU / Stock','income',2),
     ('Dividends & interest','income',3),
     ('Other income','income',4),
     ('Housing','expense',10),
     ('Groceries','expense',11),
     ('Dining','expense',12),
     ('Shopping','expense',13),
     ('Travel','expense',14),
     ('Utilities','expense',15),
     ('Insurance','expense',16),
     ('Transportation','expense',17),
     ('Health','expense',18),
     ('Subscriptions','expense',19),
     ('Other','expense',20),
     ('Transfer','transfer',30);
   INSERT INTO rules (pattern, category_id)
     SELECT column1, (SELECT id FROM categories WHERE name = column2) FROM (VALUES
       ('WHOLE FOODS','Groceries'), ('TRADER JOE','Groceries'), ('SAFEWAY','Groceries'),
       ('COSTCO','Groceries'), ('INSTACART','Groceries'),
       ('MORTGAGE','Housing'), ('MR. COOPER','Housing'), ('MR COOPER','Housing'),
       ('PG&E','Utilities'), ('PGANDE','Utilities'), ('SO CAL EDISON','Utilities'), ('SOCALGAS','Utilities'), ('COX COMM','Utilities'),
       ('AMAZON','Shopping'), ('TARGET','Shopping'),
       ('NETFLIX','Subscriptions'), ('SPOTIFY','Subscriptions'), ('APPLE.COM/BILL','Subscriptions'),
       ('UBER','Transportation'), ('LYFT','Transportation'), ('SHELL OIL','Transportation'), ('CHEVRON','Transportation'),
       ('ONLINE TRANSFER','Transfer'), ('ZELLE','Transfer'), ('VENMO','Transfer'), ('WEALTHFRONT EDI','Transfer'),
       ('PAYROLL','Salary'), ('DIRECT DEP','Salary'),
       ('INTEREST PAYMENT','Dividends & interest'), ('DIVIDEND','Dividends & interest')
     )`,

  // 3 — Phase II: investments & property.
  // Same ledger philosophy: trades, prices, valuations, and balances are dated
  // facts; positions, cost basis, equity, and net worth are always computed.
  // Share quantities are integer micro-shares (1 share = 1_000_000) so crypto
  // fractions never touch floats.
  `ALTER TABLE accounts ADD COLUMN opening_cents INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE invest_accounts (
     id         INTEGER PRIMARY KEY,
     name       TEXT NOT NULL,
     kind       TEXT NOT NULL CHECK (kind IN ('brokerage','retirement','crypto')),
     tracking   TEXT NOT NULL CHECK (tracking IN ('lots','balance')),
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE assets (
     id     INTEGER PRIMARY KEY,
     symbol TEXT NOT NULL UNIQUE,
     name   TEXT,
     kind   TEXT NOT NULL CHECK (kind IN ('stock','crypto'))
   );
   CREATE TABLE trades (
     id                INTEGER PRIMARY KEY,
     invest_account_id INTEGER NOT NULL REFERENCES invest_accounts(id),
     asset_id          INTEGER NOT NULL REFERENCES assets(id),
     traded_on         TEXT NOT NULL,
     side              TEXT NOT NULL CHECK (side IN ('buy','sell')),
     qty_micro         INTEGER NOT NULL CHECK (qty_micro > 0),
     total_cents       INTEGER NOT NULL CHECK (total_cents >= 0),
     note              TEXT,
     created_at        TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_trades_asset ON trades(asset_id, traded_on);
   CREATE TABLE prices (
     asset_id    INTEGER NOT NULL REFERENCES assets(id),
     priced_on   TEXT NOT NULL,
     close_cents INTEGER NOT NULL,
     PRIMARY KEY (asset_id, priced_on)
   );
   CREATE TABLE balance_snapshots (
     invest_account_id INTEGER NOT NULL REFERENCES invest_accounts(id),
     balanced_on       TEXT NOT NULL,
     balance_cents     INTEGER NOT NULL,
     PRIMARY KEY (invest_account_id, balanced_on)
   );
   CREATE TABLE properties (
     id             INTEGER PRIMARY KEY,
     name           TEXT NOT NULL,
     purchased_on   TEXT,
     purchase_cents INTEGER,
     created_at     TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE property_valuations (
     property_id INTEGER NOT NULL REFERENCES properties(id),
     valued_on   TEXT NOT NULL,
     value_cents INTEGER NOT NULL,
     source      TEXT NOT NULL DEFAULT 'manual',
     PRIMARY KEY (property_id, valued_on)
   );
   CREATE TABLE liabilities (
     id          INTEGER PRIMARY KEY,
     property_id INTEGER REFERENCES properties(id),
     name        TEXT NOT NULL,
     rate_micro  INTEGER,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE liability_balances (
     liability_id  INTEGER NOT NULL REFERENCES liabilities(id),
     balanced_on   TEXT NOT NULL,
     balance_cents INTEGER NOT NULL,
     PRIMARY KEY (liability_id, balanced_on)
   )`,

  // 4 — RSU vesting schedules. Unvested units are future compensation, not
  // assets: they never count toward net worth. Converting a vest creates a
  // normal buy trade at vest-day value (which IS the tax basis for RSUs) and
  // records the link here.
  `CREATE TABLE rsu_vests (
     id                 INTEGER PRIMARY KEY,
     invest_account_id  INTEGER NOT NULL REFERENCES invest_accounts(id),
     asset_id           INTEGER NOT NULL REFERENCES assets(id),
     vest_on            TEXT NOT NULL,
     qty_micro          INTEGER NOT NULL CHECK (qty_micro > 0),
     converted_trade_id INTEGER REFERENCES trades(id),
     created_at         TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE INDEX idx_vests_pending ON rsu_vests(vest_on) WHERE converted_trade_id IS NULL`,

  // 5 — specific-lot sells. A sell can (a) consume FIFO as before, (b) target
  // one specific open lot (sold_lot_trade_id → the buy that created it), or
  // (c) carry its own acquisition date + basis for shares whose buy history
  // predates Scarab.
  `ALTER TABLE trades ADD COLUMN sold_lot_trade_id INTEGER REFERENCES trades(id);
   ALTER TABLE trades ADD COLUMN acquired_on TEXT;
   ALTER TABLE trades ADD COLUMN basis_cents INTEGER`,

  // 6 — simpler unvested RSU tracking: one running share count per
  // account+asset instead of individual future tranches (tranche-level entry
  // proved too fiddly against real brokerage UIs). Any pending rows from
  // the old rsu_vests table roll up into it.
  `CREATE TABLE unvested_positions (
     invest_account_id INTEGER NOT NULL REFERENCES invest_accounts(id),
     asset_id          INTEGER NOT NULL REFERENCES assets(id),
     qty_micro         INTEGER NOT NULL CHECK (qty_micro >= 0),
     updated_on        TEXT NOT NULL,
     PRIMARY KEY (invest_account_id, asset_id)
   );
   INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on)
     SELECT invest_account_id, asset_id, SUM(qty_micro), date('now')
     FROM rsu_vests WHERE converted_trade_id IS NULL
     GROUP BY invest_account_id, asset_id`,

  // 7 — more categories (Gardening, Alcohol, Pets, Taxes) with seed rules
  // for common national merchants. Card-payment patterns file as Transfer so
  // unpaired autopays never read as spending.
  `INSERT INTO categories (name, kind, sort) VALUES
     ('Gardening','expense',21),
     ('Alcohol','expense',22),
     ('Pets','expense',23),
     ('Taxes','expense',24);
   INSERT INTO rules (pattern, category_id)
     SELECT column1, (SELECT id FROM categories WHERE name = column2) FROM (VALUES
       ('SITEONE LANDSCAPE','Gardening'), ('NURSERY','Gardening'), ('ARBORICULTURAL','Gardening'),
       ('TOTAL WINE','Alcohol'), ('BEVERAGES & MORE','Alcohol'), ('BEVMO','Alcohol'),
       ('BOTTLE SHOP','Alcohol'), ('LIQUOR','Alcohol'), ('WINERY','Alcohol'),
       ('BREWING','Alcohol'), ('BREWERY','Alcohol'), ('ALEHOUSE','Alcohol'),
       ('TAPROOM','Alcohol'),
       ('VETERINARY','Pets'), ('CHEWY.COM','Pets'), ('PETSMART','Pets'), ('PETCO','Pets'), ('THEFARMERSDOG','Pets'),
       ('USATAXPYMT','Taxes'), ('FRANCHISE TAX BO','Taxes'),
       ('POOL SERVICE','Housing'), ('CLEANING SERVICE','Housing'),
       ('CITY OF','Utilities'), ('WASTE MANAGEMENT','Utilities'),
       ('STATE FARM','Insurance'),
       ('WHOLEFDS','Groceries'), ('SPROUTS','Groceries'), ('KROGER','Groceries'),
       ('DOORDASH','Dining'), ('IN-N-OUT','Dining'), ('TST*','Dining'), ('SQ *','Dining'),
       ('VRBO','Travel'), ('AIRBNB','Travel'), ('SOUTHWES','Travel'), ('HOTEL','Travel'), ('EXPEDIA','Travel'),
       ('THREDUP','Shopping'), ('NORDSTROM','Shopping'),
       ('KAISER','Health'),
       ('PARAMOUNT+','Subscriptions'), ('PRIME VIDEO','Subscriptions'), ('YOUTUBEPREM','Subscriptions'),
       ('BIG O TIRES','Transportation'), ('RIVIAN','Transportation'),
       ('AUTOPAY','Transfer'), ('PAYMENT THANK YOU','Transfer'), ('PAYMENT, THANK YOU','Transfer'),
       ('AUTOMATIC PAYMENT','Transfer')
     )`,

  // 8 — Phase III: the Dream Home goal. Settings are JSON blobs (this screen
  // is all knobs); loan options come from real term sheets. Brokerage→checking
  // ACH files as Transfer: moving your own money between accounts is not
  // income.
  `CREATE TABLE goal_settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   CREATE TABLE loan_options (
     id          INTEGER PRIMARY KEY,
     name        TEXT NOT NULL,
     rate_micro  INTEGER NOT NULL,
     term_months INTEGER NOT NULL,
     points_micro INTEGER NOT NULL DEFAULT 0,
     note        TEXT,
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   );
   INSERT INTO rules (pattern, category_id)
     SELECT column1, (SELECT id FROM categories WHERE name = column2) FROM (VALUES
       ('GOLDMAN SACHS','Transfer'), ('MORGAN STANLEY','Transfer'), ('COINBASE','Transfer')
     )`,

  // 9 — detailed charting: daily closes per asset, and BTC on-chain metrics.
  // On-chain values are stored as integers in per-metric units:
  //   realized_price → cents · mvrv → millionths (ratio × 1e6) · fear_greed → 0-100
  `CREATE TABLE prices_daily (
     asset_id    INTEGER NOT NULL REFERENCES assets(id),
     priced_on   TEXT NOT NULL,
     close_cents INTEGER NOT NULL,
     PRIMARY KEY (asset_id, priced_on)
   );
   CREATE TABLE onchain_daily (
     metric TEXT NOT NULL,
     day    TEXT NOT NULL,
     value  INTEGER NOT NULL,
     PRIMARY KEY (metric, day)
   )`,

  // 10 — the zero-knowledge vault store (scarab.one groundwork). The server
  // holds opaque ciphertext per identity, versioned for optimistic
  // concurrency. Keys never exist server-side; see shared/vault.ts.
  `CREATE TABLE vault_blobs (
     owner_email TEXT PRIMARY KEY,
     version     INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     size        INTEGER NOT NULL,
     data        TEXT NOT NULL,
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // 11 — the decision engine: named scenarios for the Future screen. A
  // scenario is a knob-set (returns, savings, purchase year, retirement,
  // one-off events) stored as JSON; the balance sheet it runs against is
  // always resolved from the ledger at read time, never stored. Exactly one
  // row is the baseline the others are measured against.
  `CREATE TABLE scenarios (
     id          INTEGER PRIMARY KEY,
     name        TEXT NOT NULL,
     params      TEXT NOT NULL,
     is_baseline INTEGER NOT NULL DEFAULT 0,
     sort        INTEGER NOT NULL DEFAULT 0,
     created_at  TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
   )`,

  // 12 — the daily price basket (server/basket.ts): every listed US stock/ETF
  // and the top crypto assets, quoted once a day and served whole so a
  // zero-knowledge session can pick its own symbols without naming them.
  // Shared infrastructure, not household data — deliberately NOT part of the
  // snapshot (engine/snapshot.ts TABLES); the table exists in-tab but empty.
  `CREATE TABLE basket_quotes (
     symbol    TEXT NOT NULL,
     kind      TEXT NOT NULL CHECK (kind IN ('stock','crypto')),
     cents     INTEGER NOT NULL,
     priced_on TEXT NOT NULL,
     PRIMARY KEY (symbol, kind)
   )`,

  // 13 — an optional vest cadence on each unvested position, so the tax layer
  // can project the rest of the year's RSU income. Still one running count per
  // account+asset (tranche tables were tried and dropped in 6): "N shares
  // every M months, next on D" is what a release schedule boils down to, and
  // it survives grants overlapping. All three are NULL until the user sets them.
  `ALTER TABLE unvested_positions ADD COLUMN next_vest_on TEXT;
   ALTER TABLE unvested_positions ADD COLUMN vest_every_months INTEGER;
   ALTER TABLE unvested_positions ADD COLUMN vest_qty_micro INTEGER`,
]

export function migrate(db: DbLike): void {
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    id         INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)
  const applied = (db.prepare('SELECT count(*) AS n FROM migrations').get() as { n: number }).n
  for (let i = applied; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]!)
      db.prepare('INSERT INTO migrations (id) VALUES (?)').run(i + 1)
    })()
  }
}
