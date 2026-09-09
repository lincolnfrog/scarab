import { parseQtyMicro } from '../shared/money'
import type { DbLike } from './db'
import { categorize, extractMerchant, importStatement, type Rule } from './import'
import { computePosition, positionValueCents, type TradeInput } from './lots'
import { migrations } from './migrations'
import { netWorthSeries } from './networth'

/**
 * Every read/write the screens perform, as pure functions of (db, args).
 * The server's Hono handlers and the browser's local dispatcher both call
 * these — one implementation, two runtimes, same rules as the rest of engine/:
 * isomorphic, synchronous, DbLike only.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
const bad = (msg: string): never => {
  throw new ApiError(400, msg)
}
const notFound = (msg: string): never => {
  throw new ApiError(404, msg)
}

const isoDay = /^\d{4}-\d{2}-\d{2}$/
const isoMonth = /^\d{4}-\d{2}$/

export const health = () => ({ ok: true, db: 'ready', schemaVersion: migrations.length })

/* ---------- accounts ---------- */

export const listAccounts = (db: DbLike) => db.prepare('SELECT id, name, kind FROM accounts ORDER BY id').all()

export function createAccount(db: DbLike, b: { name?: string; kind?: string }) {
  if (!b.name?.trim() || !['checking', 'savings'].includes(b.kind ?? ''))
    bad('name and kind (checking|savings) required')
  const r = db.prepare('INSERT INTO accounts (name, kind) VALUES (?, ?)').run(b.name!.trim(), b.kind)
  return { id: Number(r.lastInsertRowid), name: b.name!.trim(), kind: b.kind }
}

export function anchorAccount(db: DbLike, id: number, b: { currentBalanceCents?: number }) {
  if (!Number.isSafeInteger(b.currentBalanceCents)) bad('integer currentBalanceCents required')
  if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(id)) notFound('no such account')
  const flow = db
    .prepare('SELECT COALESCE(SUM(amount_cents),0) AS s FROM transactions WHERE account_id = ?')
    .get(id) as { s: number }
  const opening = (b.currentBalanceCents as number) - flow.s
  db.prepare('UPDATE accounts SET opening_cents = ? WHERE id = ?').run(opening, id)
  return { ok: true, openingCents: opening }
}

/* ---------- categories ---------- */

export const listCategories = (db: DbLike) =>
  db.prepare('SELECT id, name, kind, sort FROM categories ORDER BY sort, name').all()

export function createCategory(db: DbLike, b: { name?: string; kind?: string }) {
  if (!b.name?.trim() || !['income', 'expense'].includes(b.kind ?? '')) bad('name and kind (income|expense) required')
  const trimmed = b.name!.trim()
  const existing = db.prepare('SELECT id, name, kind FROM categories WHERE name = ? COLLATE NOCASE').get(trimmed)
  if (existing) return existing
  const r = db
    .prepare(
      "INSERT INTO categories (name, kind, sort) VALUES (?, ?, (SELECT COALESCE(max(sort),0)+1 FROM categories WHERE kind = 'expense'))",
    )
    .run(trimmed, b.kind)
  return { id: Number(r.lastInsertRowid), name: trimmed, kind: b.kind }
}

/* ---------- imports ---------- */

export function runImport(
  db: DbLike,
  b: { accountId?: number; filename?: string; content?: string },
  importedBy: string,
) {
  if (!b.accountId || !b.content) bad('accountId and content required')
  if (!db.prepare('SELECT id FROM accounts WHERE id = ?').get(b.accountId)) notFound('no such account')
  try {
    return importStatement(db, {
      accountId: b.accountId!,
      filename: b.filename ?? 'upload',
      content: b.content!,
      importedBy,
    })
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(400, e instanceof Error ? e.message : 'import failed')
  }
}

export const listImports = (db: DbLike) =>
  db
    .prepare(
      `SELECT i.id, a.name AS account_name, i.filename, i.format, i.rows_total,
              i.rows_imported, i.rows_skipped, i.imported_at, i.imported_by
       FROM imports i JOIN accounts a ON a.id = i.account_id
       ORDER BY i.id DESC LIMIT 20`,
    )
    .all()

/* ---------- transactions ---------- */

export function listTransactions(
  db: DbLike,
  q: { q?: string; month?: string; categoryId?: string; accountId?: string; uncategorized?: boolean },
) {
  const where: string[] = []
  const params: unknown[] = []
  const needle = q.q?.trim()
  if (needle) {
    where.push('(t.description LIKE ? OR cat.name LIKE ?)')
    params.push(`%${needle}%`, `%${needle}%`)
  }
  if (q.month) {
    where.push('t.posted_on LIKE ?')
    params.push(`${q.month}%`)
  }
  if (q.categoryId) {
    where.push('t.category_id = ?')
    params.push(Number(q.categoryId))
  }
  if (q.accountId) {
    where.push('t.account_id = ?')
    params.push(Number(q.accountId))
  }
  if (q.uncategorized) where.push('t.category_id IS NULL')
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, t.posted_on, t.amount_cents,
              t.description, t.category_id, cat.name AS category_name, t.categorized_by
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories cat ON cat.id = t.category_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY t.posted_on DESC, t.id DESC LIMIT 300`,
    )
    .all(...params)
  const total = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
  return { rows, total }
}

export function patchTransaction(db: DbLike, id: number, body: { categoryId: number | null; rulePattern?: string }) {
  const tx = db.prepare('SELECT id, description FROM transactions WHERE id = ?').get(id) as
    | { id: number; description: string }
    | undefined
  if (!tx) notFound('no such transaction')
  db.prepare('UPDATE transactions SET category_id = ?, categorized_by = ? WHERE id = ?').run(
    body.categoryId,
    body.categoryId === null ? null : 'manual',
    id,
  )
  let ruleApplied = 0
  let pattern: string | null = null
  if (body.categoryId !== null) {
    pattern = (body.rulePattern?.trim().toUpperCase() || extractMerchant(tx!.description)) || null
    if (pattern && pattern.length >= 4) {
      const existing = db.prepare('SELECT id FROM rules WHERE pattern = ?').get(pattern) as { id: number } | undefined
      let ruleId: number
      if (existing) {
        db.prepare('UPDATE rules SET category_id = ?, priority = 10 WHERE id = ?').run(body.categoryId, existing.id)
        ruleId = existing.id
      } else {
        ruleId = Number(
          db.prepare('INSERT INTO rules (pattern, category_id, priority) VALUES (?, ?, 10)').run(pattern, body.categoryId)
            .lastInsertRowid,
        )
      }
      const rule: Rule = { id: ruleId, pattern, category_id: body.categoryId, priority: 10 }
      const candidates = db
        .prepare(
          `SELECT id, description FROM transactions
           WHERE (categorized_by IS NULL OR categorized_by LIKE 'rule:%') AND id != ?`,
        )
        .all(id) as { id: number; description: string }[]
      const set = db.prepare('UPDATE transactions SET category_id = ?, categorized_by = ? WHERE id = ?')
      db.transaction(() => {
        for (const t of candidates) {
          if (categorize(t.description, [rule])) {
            set.run(body.categoryId, `rule:${rule.id}`, t.id)
            ruleApplied++
          }
        }
      })()
    } else pattern = null
  }
  return { ok: true as const, ruleApplied, pattern }
}

/* ---------- cash flow & budget ---------- */

export const cashflowMonthly = (db: DbLike) =>
  (
    db
      .prepare(
        `SELECT substr(t.posted_on, 1, 7) AS month,
                SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS income_cents,
                SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS spend_cents
         FROM transactions t
         LEFT JOIN categories cat ON cat.id = t.category_id
         WHERE cat.kind IS NULL OR cat.kind != 'transfer'
         GROUP BY month ORDER BY month DESC LIMIT 12`,
      )
      .all() as { month: string }[]
  ).reverse()

export function cashflowCategories(db: DbLike, month?: string) {
  if (!isoMonth.test(month ?? '')) bad('month=YYYY-MM required')
  return db
    .prepare(
      `SELECT t.category_id, COALESCE(cat.name, 'Uncategorized') AS name,
              SUM(-t.amount_cents) AS spend_cents
       FROM transactions t
       LEFT JOIN categories cat ON cat.id = t.category_id
       WHERE t.posted_on LIKE ? AND t.amount_cents < 0 AND (cat.kind IS NULL OR cat.kind = 'expense')
       GROUP BY t.category_id ORDER BY spend_cents DESC`,
    )
    .all(`${month}%`)
}

export function getBudget(db: DbLike, month?: string) {
  if (!isoMonth.test(month ?? '')) bad('month=YYYY-MM required')
  const rows = db
    .prepare(
      `SELECT cat.id AS category_id, cat.name, cat.kind,
              COALESCE(b.monthly_cents, 0) AS monthly_cents,
              COALESCE((SELECT SUM(CASE WHEN cat.kind = 'income' THEN t.amount_cents ELSE -t.amount_cents END)
                        FROM transactions t
                        WHERE t.category_id = cat.id AND t.posted_on LIKE ?), 0) AS actual_cents
       FROM categories cat
       LEFT JOIN budgets b ON b.category_id = cat.id
       WHERE cat.kind IN ('income', 'expense')
       ORDER BY cat.sort, cat.name`,
    )
    .all(`${month}%`) as object[]
  const un = db
    .prepare(
      `SELECT SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS inc,
              SUM(CASE WHEN amount_cents < 0 THEN -amount_cents ELSE 0 END) AS spend
       FROM transactions WHERE category_id IS NULL AND posted_on LIKE ?`,
    )
    .get(`${month}%`) as { inc: number | null; spend: number | null }
  if (un.inc)
    rows.push({ category_id: null, name: 'Uncategorized', kind: 'income', monthly_cents: 0, actual_cents: un.inc })
  if (un.spend)
    rows.push({ category_id: null, name: 'Uncategorized', kind: 'expense', monthly_cents: 0, actual_cents: un.spend })
  return rows
}

export function putBudget(db: DbLike, b: { categoryId?: number; monthlyCents?: number }) {
  if (!b.categoryId || !Number.isSafeInteger(b.monthlyCents)) bad('categoryId and integer monthlyCents required')
  db.prepare(
    `INSERT INTO budgets (category_id, monthly_cents) VALUES (?, ?)
     ON CONFLICT (category_id) DO UPDATE SET monthly_cents = excluded.monthly_cents`,
  ).run(b.categoryId, b.monthlyCents)
  return { ok: true as const }
}

/* ---------- investments ---------- */

export function listInvestAccounts(db: DbLike) {
  const rows = db.prepare('SELECT id, name, kind, tracking FROM invest_accounts ORDER BY id').all() as { id: number }[]
  const latest = db.prepare(
    'SELECT balanced_on, balance_cents FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on DESC LIMIT 1',
  )
  return rows.map((r) => ({ ...r, latest_snapshot: latest.get(r.id) ?? null }))
}

export function createInvestAccount(db: DbLike, b: { name?: string; kind?: string; tracking?: string }) {
  if (
    !b.name?.trim() ||
    !['brokerage', 'retirement', 'crypto'].includes(b.kind ?? '') ||
    !['lots', 'balance'].includes(b.tracking ?? '')
  )
    bad('name, kind (brokerage|retirement|crypto), tracking (lots|balance) required')
  const r = db
    .prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
    .run(b.name!.trim(), b.kind, b.tracking)
  return { id: Number(r.lastInsertRowid), name: b.name!.trim(), kind: b.kind, tracking: b.tracking }
}

export function putBalanceSnapshot(db: DbLike, b: { investAccountId?: number; balancedOn?: string; balanceCents?: number }) {
  if (!b.investAccountId || !isoDay.test(b.balancedOn ?? '') || !Number.isSafeInteger(b.balanceCents))
    bad('investAccountId, balancedOn (yyyy-mm-dd), integer balanceCents required')
  db.prepare(
    `INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (?, ?, ?)
     ON CONFLICT (invest_account_id, balanced_on) DO UPDATE SET balance_cents = excluded.balance_cents`,
  ).run(b.investAccountId, b.balancedOn, b.balanceCents)
  return { ok: true as const }
}

export function createTrade(
  db: DbLike,
  b: {
    investAccountId?: number
    symbol?: string
    assetKind?: string
    side?: string
    tradedOn?: string
    qty?: string
    totalCents?: number
    soldLotTradeId?: number
    acquiredOn?: string
    basisCents?: number
  },
) {
  if (
    !b.investAccountId ||
    !b.symbol?.trim() ||
    !['stock', 'crypto'].includes(b.assetKind ?? '') ||
    !['buy', 'sell'].includes(b.side ?? '') ||
    !isoDay.test(b.tradedOn ?? '') ||
    !b.qty ||
    !Number.isSafeInteger(b.totalCents) ||
    (b.totalCents as number) < 0
  )
    bad('investAccountId, symbol, assetKind, side, tradedOn, qty, totalCents required')
  if (!db.prepare("SELECT id FROM invest_accounts WHERE id = ? AND tracking = 'lots'").get(b.investAccountId))
    notFound('no such lots-tracked investment account')
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(b.qty!)
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
  }
  const isSell = b.side === 'sell'
  const explicit = b.acquiredOn != null || b.basisCents != null
  if (
    explicit &&
    (!isSell || !isoDay.test(b.acquiredOn ?? '') || !Number.isSafeInteger(b.basisCents) || (b.basisCents as number) < 0)
  )
    bad('explicit basis needs side=sell, acquiredOn (yyyy-mm-dd), integer basisCents')
  if (b.soldLotTradeId != null && (!isSell || explicit)) bad('soldLotTradeId is for sells and excludes explicit basis')
  if (b.soldLotTradeId != null && !db.prepare("SELECT id FROM trades WHERE id = ? AND side = 'buy'").get(b.soldLotTradeId))
    bad('soldLotTradeId does not reference a buy')
  const symbol = b.symbol!.trim().toUpperCase()
  db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING').run(symbol, b.assetKind)
  const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(symbol) as { id: number }
  const r = db
    .prepare(
      `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents,
                           sold_lot_trade_id, acquired_on, basis_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      b.investAccountId,
      asset.id,
      b.tradedOn,
      b.side,
      qtyMicro,
      b.totalCents,
      b.soldLotTradeId ?? null,
      b.acquiredOn ?? null,
      b.basisCents ?? null,
    )
  return { id: Number(r.lastInsertRowid) }
}

export const listTrades = (db: DbLike) =>
  db
    .prepare(
      `SELECT t.id, t.traded_on, t.side, t.qty_micro, t.total_cents, a.symbol, ia.name AS account_name
       FROM trades t JOIN assets a ON a.id = t.asset_id JOIN invest_accounts ia ON ia.id = t.invest_account_id
       ORDER BY t.traded_on DESC, t.id DESC LIMIT 50`,
    )
    .all()

export function getPortfolio(db: DbLike, today: string) {
  const assets = db.prepare('SELECT id, symbol, name, kind FROM assets ORDER BY symbol').all() as {
    id: number
    symbol: string
    name: string | null
    kind: 'stock' | 'crypto'
  }[]
  const latestPrice = db.prepare(
    'SELECT close_cents, priced_on FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1',
  )
  const tradesFor = db.prepare(
    'SELECT id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, acquired_on, basis_cents FROM trades WHERE asset_id = ? ORDER BY traded_on',
  )
  const out = []
  const totals = { value: 0, cost: 0, unrealized: 0, ytd_st: 0, ytd_lt: 0 }
  const warnings: string[] = []
  for (const a of assets) {
    const pos = computePosition(tradesFor.all(a.id) as TradeInput[], today)
    warnings.push(...pos.warnings.map((w) => `${a.symbol}: ${w}`))
    totals.ytd_st += pos.realized_ytd_st_cents
    totals.ytd_lt += pos.realized_ytd_lt_cents
    if (pos.qty_micro === 0) continue
    const price = latestPrice.get(a.id) as { close_cents: number; priced_on: string } | undefined
    const value = price ? positionValueCents(pos.qty_micro, price.close_cents) : pos.cost_cents
    totals.value += value
    totals.cost += pos.cost_cents
    totals.unrealized += value - pos.cost_cents
    out.push({
      symbol: a.symbol,
      kind: a.kind,
      qty_micro: pos.qty_micro,
      cost_cents: pos.cost_cents,
      price_cents: price?.close_cents ?? null,
      priced_on: price?.priced_on ?? null,
      value_cents: value,
      unrealized_cents: value - pos.cost_cents,
      lots: pos.lots,
    })
  }
  out.sort((a, b) => b.value_cents - a.value_cents)
  return { positions: out, totals, warnings }
}

export function upsertPrices(db: DbLike, quotes: { symbol: string; cents: number; pricedOn: string }[]) {
  const assets = db.prepare('SELECT id, symbol FROM assets').all() as { id: number; symbol: string }[]
  const byId = new Map(assets.map((a) => [a.symbol, a.id]))
  const upsert = db.prepare(
    `INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)
     ON CONFLICT (asset_id, priced_on) DO UPDATE SET close_cents = excluded.close_cents`,
  )
  let updated = 0
  for (const q of quotes) {
    const id = byId.get(q.symbol)
    if (!id) continue
    upsert.run(id, q.pricedOn, q.cents)
    updated++
  }
  return updated
}

/**
 * Price this household's assets from the shared daily basket (server/basket.ts).
 * The basket is the same list for everyone; the matching happens here, on the
 * engine's side of the seam, so in a zero-knowledge session the symbols never
 * leave the tab. Stocks match on Yahoo spelling (BRK.B → BRK-B), crypto on
 * the bare ticker.
 */
export function applyBasket(
  db: DbLike,
  basket: { builtAt: string | null; quotes: { symbol: string; kind: 'stock' | 'crypto'; cents: number; pricedOn: string }[] },
) {
  const assets = db.prepare('SELECT symbol, kind FROM assets').all() as { symbol: string; kind: 'stock' | 'crypto' }[]
  if (assets.length === 0) return { updated: 0, backfilled: 0, errors: ['no assets yet — record a trade first'], basketBuiltAt: basket.builtAt }
  if (basket.quotes.length === 0)
    return { updated: 0, backfilled: 0, errors: ['the price basket is empty — rebuild it from Data & Vault, or wait for today’s build'], basketBuiltAt: basket.builtAt }
  const byKey = new Map(basket.quotes.map((q) => [`${q.kind}:${q.symbol}`, q]))
  const quotes: { symbol: string; cents: number; pricedOn: string }[] = []
  const errors: string[] = []
  for (const a of assets) {
    const key = `${a.kind}:${a.kind === 'stock' ? a.symbol.toUpperCase().replace(/\./g, '-') : a.symbol.toUpperCase()}`
    const q = byKey.get(key)
    if (q) quotes.push({ symbol: a.symbol, cents: q.cents, pricedOn: q.pricedOn })
    else errors.push(`${a.symbol}: not in today’s basket`)
  }
  return { updated: upsertPrices(db, quotes), backfilled: 0, errors, basketBuiltAt: basket.builtAt }
}

/* ---------- properties & liabilities ---------- */

export function listProperties(db: DbLike) {
  const props = db.prepare('SELECT id, name, purchased_on, purchase_cents FROM properties ORDER BY id').all() as {
    id: number
  }[]
  const latestVal = db.prepare(
    'SELECT valued_on, value_cents, source FROM property_valuations WHERE property_id = ? ORDER BY valued_on DESC LIMIT 1',
  )
  const valHistory = db.prepare(
    'SELECT valued_on, value_cents FROM property_valuations WHERE property_id = ? ORDER BY valued_on',
  )
  const liabsFor = db.prepare('SELECT id, name, rate_micro FROM liabilities WHERE property_id = ? ORDER BY id')
  const latestBal = db.prepare(
    'SELECT balanced_on, balance_cents FROM liability_balances WHERE liability_id = ? ORDER BY balanced_on DESC LIMIT 1',
  )
  const balHistory = db.prepare(
    'SELECT balanced_on, balance_cents FROM liability_balances WHERE liability_id = ? ORDER BY balanced_on',
  )
  return props.map((p) => ({
    ...p,
    latest_valuation: latestVal.get(p.id) ?? null,
    valuations: valHistory.all(p.id),
    liabilities: (liabsFor.all(p.id) as { id: number }[]).map((l) => ({
      ...l,
      latest_balance: latestBal.get(l.id) ?? null,
      balances: balHistory.all(l.id),
    })),
  }))
}

export function createProperty(db: DbLike, b: { name?: string; purchasedOn?: string; purchaseCents?: number }) {
  if (!b.name?.trim()) bad('name required')
  const r = db
    .prepare('INSERT INTO properties (name, purchased_on, purchase_cents) VALUES (?, ?, ?)')
    .run(b.name!.trim(), b.purchasedOn ?? null, b.purchaseCents ?? null)
  return { id: Number(r.lastInsertRowid) }
}

export function putValuation(db: DbLike, id: number, b: { valuedOn?: string; valueCents?: number }) {
  if (!isoDay.test(b.valuedOn ?? '') || !Number.isSafeInteger(b.valueCents))
    bad('valuedOn (yyyy-mm-dd) and integer valueCents required')
  if (!db.prepare('SELECT id FROM properties WHERE id = ?').get(id)) notFound('no such property')
  db.prepare(
    `INSERT INTO property_valuations (property_id, valued_on, value_cents) VALUES (?, ?, ?)
     ON CONFLICT (property_id, valued_on) DO UPDATE SET value_cents = excluded.value_cents`,
  ).run(id, b.valuedOn, b.valueCents)
  return { ok: true as const }
}

export function createLiability(db: DbLike, b: { propertyId?: number; name?: string; rateMicro?: number }) {
  if (!b.name?.trim()) bad('name required')
  const r = db
    .prepare('INSERT INTO liabilities (property_id, name, rate_micro) VALUES (?, ?, ?)')
    .run(b.propertyId ?? null, b.name!.trim(), b.rateMicro ?? null)
  return { id: Number(r.lastInsertRowid) }
}

export function putLiabilityBalance(db: DbLike, id: number, b: { balancedOn?: string; balanceCents?: number }) {
  if (!isoDay.test(b.balancedOn ?? '') || !Number.isSafeInteger(b.balanceCents))
    bad('balancedOn (yyyy-mm-dd) and integer balanceCents required')
  if (!db.prepare('SELECT id FROM liabilities WHERE id = ?').get(id)) notFound('no such liability')
  db.prepare(
    `INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (?, ?, ?)
     ON CONFLICT (liability_id, balanced_on) DO UPDATE SET balance_cents = excluded.balance_cents`,
  ).run(id, b.balancedOn, b.balanceCents)
  return { ok: true as const }
}

/* ---------- net worth & activity ---------- */

export function getNetworth(db: DbLike, today: string) {
  const series = netWorthSeries(db, today)
  return { series, current: series[series.length - 1] ?? null, prev: series[series.length - 2] ?? null }
}

export function getActivity(db: DbLike) {
  const tx = db
    .prepare(
      `SELECT t.posted_on AS on_date, t.description, t.amount_cents AS cents, COALESCE(c.name,'—') AS tag, 'tx' AS kind
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ORDER BY t.posted_on DESC, t.id DESC LIMIT 8`,
    )
    .all()
  const trades = db
    .prepare(
      `SELECT tr.traded_on AS on_date, (tr.side || ' ' || a.symbol) AS description,
              (CASE tr.side WHEN 'buy' THEN -tr.total_cents ELSE tr.total_cents END) AS cents,
              ia.name AS tag, 'trade' AS kind
       FROM trades tr JOIN assets a ON a.id = tr.asset_id JOIN invest_accounts ia ON ia.id = tr.invest_account_id
       ORDER BY tr.traded_on DESC, tr.id DESC LIMIT 8`,
    )
    .all()
  return [...(tx as { on_date: string }[]), ...(trades as { on_date: string }[])]
    .sort((a, b) => b.on_date.localeCompare(a.on_date))
    .slice(0, 8)
}

/* ---------- unvested RSUs ---------- */

export function getUnvested(db: DbLike) {
  const rows = db
    .prepare(
      `SELECT u.invest_account_id, u.qty_micro, u.updated_on, a.symbol, a.id AS asset_id, ia.name AS account_name,
              (SELECT close_cents FROM prices WHERE asset_id = a.id ORDER BY priced_on DESC LIMIT 1) AS price_cents
       FROM unvested_positions u
       JOIN assets a ON a.id = u.asset_id
       JOIN invest_accounts ia ON ia.id = u.invest_account_id
       ORDER BY a.symbol`,
    )
    .all() as { qty_micro: number; price_cents: number | null }[]
  const est = (r: { qty_micro: number; price_cents: number | null }) =>
    r.price_cents === null ? null : positionValueCents(r.qty_micro, r.price_cents)
  return {
    rows: rows.map((r) => ({ ...r, est_cents: est(r) })),
    total_est_cents: rows.reduce((s, r) => s + (est(r) ?? 0), 0),
  }
}

export function putUnvested(db: DbLike, b: { investAccountId?: number; symbol?: string; qty?: string }, today: string) {
  if (!b.investAccountId || !b.symbol?.trim() || b.qty == null) bad('investAccountId, symbol, qty required')
  if (!db.prepare("SELECT id FROM invest_accounts WHERE id = ? AND tracking = 'lots'").get(b.investAccountId))
    notFound('no such lots-tracked investment account')
  const symbol = b.symbol!.trim().toUpperCase()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES (?, 'stock') ON CONFLICT (symbol) DO NOTHING").run(symbol)
  const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(symbol) as { id: number }
  if (b.qty!.trim() === '0') {
    db.prepare('DELETE FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?').run(
      b.investAccountId,
      asset.id,
    )
    return { ok: true as const, qtyMicro: 0 }
  }
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(b.qty!)
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
  }
  db.prepare(
    `INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (invest_account_id, asset_id)
     DO UPDATE SET qty_micro = excluded.qty_micro, updated_on = excluded.updated_on`,
  ).run(b.investAccountId, asset.id, qtyMicro, today)
  return { ok: true as const, qtyMicro }
}

export function vestUnvested(
  db: DbLike,
  b: { investAccountId?: number; symbol?: string; qty?: string; tradedOn?: string; totalCents?: number },
  today: string,
) {
  if (
    !b.investAccountId ||
    !b.symbol?.trim() ||
    !b.qty ||
    !isoDay.test(b.tradedOn ?? '') ||
    !Number.isSafeInteger(b.totalCents) ||
    (b.totalCents as number) <= 0
  )
    bad('investAccountId, symbol, qty, tradedOn, totalCents required')
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(b.qty!)
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
  }
  const symbol = b.symbol!.trim().toUpperCase()
  const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(symbol) as { id: number } | undefined
  if (!asset) notFound('no such asset')
  const trade = db
    .prepare(
      `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, note)
       VALUES (?, ?, ?, 'buy', ?, ?, 'RSU vest')`,
    )
    .run(b.investAccountId, asset!.id, b.tradedOn, qtyMicro, b.totalCents)
  const cur = db
    .prepare('SELECT qty_micro FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?')
    .get(b.investAccountId, asset!.id) as { qty_micro: number } | undefined
  let remaining = 0
  if (cur) {
    remaining = Math.max(0, cur.qty_micro - qtyMicro)
    if (remaining === 0)
      db.prepare('DELETE FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?').run(
        b.investAccountId,
        asset!.id,
      )
    else
      db.prepare(
        'UPDATE unvested_positions SET qty_micro = ?, updated_on = ? WHERE invest_account_id = ? AND asset_id = ?',
      ).run(remaining, today, b.investAccountId, asset!.id)
  }
  return { ok: true as const, tradeId: Number(trade.lastInsertRowid), remainingQtyMicro: remaining }
}

/* ---------- charts (reads only — fetching stays with the caller) ---------- */

export function getChartData(db: DbLike, symbolRaw: string, errors: string[] = []) {
  const symbol = symbolRaw.toUpperCase()
  const asset = db.prepare('SELECT id, symbol, kind FROM assets WHERE symbol = ?').get(symbol) as
    | { id: number; symbol: string; kind: 'stock' | 'crypto' }
    | undefined
  if (!asset) notFound('no such asset')
  const closes = db
    .prepare('SELECT priced_on AS d, close_cents AS c FROM prices_daily WHERE asset_id = ? ORDER BY priced_on')
    .all(asset!.id)
  return { symbol, kind: asset!.kind, closes, errors } as Record<string, unknown>
}

/* ---------- goal & loans ---------- */

export type GoalSettings = {
  targetPriceCents: number
  downPctMicro: number
  closingCents: number
  fundAccountIds: number[]
  fundExtraCents: number
  monthlyPlanCents: number
  selectedLoanId: number | null
  taxPctMicro: number
  insMonthlyCents: number
  capGainsRateMicro: number
  lossCarryforwardCents: number
  saleBasisPctMicro: number
}
export type RentalSettings = {
  propertyId: number | null
  rentCents: number
  piCents: number
  taxCents: number
  insCents: number
  maintPctMicro: number
  vacancyPctMicro: number
}

const GOAL_DEFAULTS: GoalSettings = {
  targetPriceCents: 300_000_000,
  downPctMicro: 200_000,
  closingCents: 8_000_000,
  fundAccountIds: [],
  fundExtraCents: 0,
  monthlyPlanCents: 0,
  selectedLoanId: null,
  taxPctMicro: 11_000,
  insMonthlyCents: 32_000,
  capGainsRateMicro: 350_000,
  lossCarryforwardCents: 0,
  saleBasisPctMicro: 20_000,
}
const RENTAL_DEFAULTS: RentalSettings = {
  propertyId: null,
  rentCents: 0,
  piCents: 0,
  taxCents: 0,
  insCents: 0,
  maintPctMicro: 70_000,
  vacancyPctMicro: 50_000,
}

function readSetting<T>(db: DbLike, key: string, defaults: T): T {
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(key) as { value: string } | undefined
  if (!row) return defaults
  try {
    return { ...defaults, ...(JSON.parse(row.value) as Partial<T>) }
  } catch {
    return defaults
  }
}
function writeSetting(db: DbLike, key: string, value: unknown) {
  db.prepare(
    'INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value))
}

export function getGoal(db: DbLike) {
  const goal = readSetting(db, 'goal', GOAL_DEFAULTS)
  const rental = readSetting(db, 'rental', RENTAL_DEFAULTS)
  const accounts = db
    .prepare(
      `SELECT a.id, a.name, a.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.account_id = a.id), 0) AS balance_cents
       FROM accounts a ORDER BY a.id`,
    )
    .all() as { id: number; name: string; balance_cents: number }[]
  const included = accounts.filter((a) => goal.fundAccountIds.includes(a.id))
  const fundTotal = included.reduce((s, a) => s + a.balance_cents, 0) + goal.fundExtraCents
  let series: { month: string; cents: number }[] = []
  if (included.length > 0) {
    const rows = db
      .prepare(
        `SELECT substr(posted_on, 1, 7) AS month, SUM(amount_cents) AS delta
         FROM transactions WHERE account_id IN (${included.map(() => '?').join(',')})
         GROUP BY month ORDER BY month`,
      )
      .all(...included.map((a) => a.id)) as { month: string; delta: number }[]
    let run = included.reduce((s, a) => s + a.balance_cents, 0) - rows.reduce((s, r) => s + r.delta, 0)
    series = rows.map((r) => {
      run += r.delta
      return { month: r.month, cents: run + goal.fundExtraCents }
    })
  }
  const recent = series.slice(-7)
  const monthlySuggest =
    recent.length >= 2 ? Math.round((recent[recent.length - 1]!.cents - recent[0]!.cents) / (recent.length - 1)) : 0
  const loans = db
    .prepare('SELECT id, name, rate_micro, term_months, points_micro, note FROM loan_options ORDER BY id')
    .all()
  const properties = db.prepare('SELECT id, name FROM properties ORDER BY id').all()
  return { goal, rental, accounts, fundTotal, series, monthlySuggest, loans, properties }
}

export function putGoal(db: DbLike, b: { goal?: Partial<GoalSettings>; rental?: Partial<RentalSettings> }) {
  if (b.goal) writeSetting(db, 'goal', { ...readSetting(db, 'goal', GOAL_DEFAULTS), ...b.goal })
  if (b.rental) writeSetting(db, 'rental', { ...readSetting(db, 'rental', RENTAL_DEFAULTS), ...b.rental })
  return { ok: true as const }
}

export function createLoan(
  db: DbLike,
  b: { name?: string; rateMicro?: number; termMonths?: number; pointsMicro?: number; note?: string },
) {
  if (
    !b.name?.trim() ||
    !Number.isSafeInteger(b.rateMicro) ||
    (b.rateMicro as number) <= 0 ||
    !Number.isSafeInteger(b.termMonths) ||
    (b.termMonths as number) <= 0
  )
    bad('name, rateMicro, termMonths required')
  const r = db
    .prepare('INSERT INTO loan_options (name, rate_micro, term_months, points_micro, note) VALUES (?, ?, ?, ?, ?)')
    .run(b.name!.trim(), b.rateMicro, b.termMonths, b.pointsMicro ?? 0, b.note ?? null)
  return { id: Number(r.lastInsertRowid) }
}

export function deleteLoan(db: DbLike, id: number) {
  const r = db.prepare('DELETE FROM loan_options WHERE id = ?').run(id)
  if (!r.changes) notFound('no such loan option')
  return { ok: true as const }
}
