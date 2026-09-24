import { addMonthsIso, addMonthsToMonth, isRealIsoDay, monthsBetween, todayLocal } from '../shared/dates'
import { OPENING_NOTE, RSU_VEST_NOTE, RSU_WITHHOLDING_NOTE } from '../shared/invest-api'
import type { BudgetRow, CategorySpend, GoalDerived, MonthlyFlow, Tx, TxPage } from '../shared/types'
import type { DbLike } from './db'
import { ApiError, bad, isoMonth, notFound } from './errors'
import { cashEffectCents, type CashTrade } from './holdings'
import { categorize, extractMerchant, importStatement, type Rule } from './import'
import { migrations } from './migrations'
import { netWorthSeries } from './networth'

/**
 * Every read/write the screens perform, as pure functions of (db, args).
 * The server's Hono handlers and the browser's local dispatcher both call
 * these — one implementation, two runtimes, same rules as the rest of engine/:
 * isomorphic, synchronous, DbLike only.
 *
 * This module keeps accounts, cash, budget, property, goal and loans.
 * Investments live in engine/invest.ts, prices in engine/prices.ts and the
 * error vocabulary in engine/errors.ts; all three are re-exported here, so an
 * importer of services sees one module.
 */

export * from './errors'
export * from './invest'
export * from './prices'

/** Calendar-month arithmetic on ISO dates, clamping the day (shared/dates.ts); the name paychecks and tax import. */
export const addMonths = addMonthsIso

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

/** GET /api/transactions query, as both runtimes hand it over: strings from the URL (numbers are accepted too). */
export type TxQuery = {
  q?: string
  month?: string
  categoryId?: string | number
  accountId?: string | number
  uncategorized?: boolean
  offset?: string | number
  limit?: string | number
}
export const TX_PAGE_DEFAULT = 100
export const TX_PAGE_MAX = 500

/** An optional whole-number query value: absent → `dflt`; anything else must be an integer in [min, max]. */
function intParam(v: string | number | undefined | null, name: string, dflt: number | undefined, min: number, max = Number.MAX_SAFE_INTEGER) {
  if (v === undefined || v === null || v === '') return dflt
  const n = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : NaN
  if (!Number.isSafeInteger(n) || n < min || n > max)
    bad(max === Number.MAX_SAFE_INTEGER ? `${name} must be a whole number of at least ${min}` : `${name} must be a whole number from ${min} to ${max}`)
  return n
}

/** A LIKE pattern that matches `s` literally anywhere (its own % and _ are not wildcards). Use with ESCAPE '\'. */
const likeAnywhere = (s: string) => `%${s.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`

/**
 * One page of the ledger, newest first, with the counts the Cash screen's
 * transaction list shows:
 *   - `matching`: every row the filters select (the page is `limit` of them
 *     from `offset`), so the header can read "N matching" and offer Load more;
 *   - `uncategorized`: how many rows "Uncategorized" would select with the
 *     other filters (search, month, account) as they are — the count beside
 *     that option, whatever category is picked now;
 *   - `total`: every transaction in the ledger.
 * Order is (posted_on, id) descending, so pages never overlap or skip.
 */
export function listTransactions(db: DbLike, q: TxQuery): TxPage {
  const offset = intParam(q.offset, 'offset', 0, 0)!
  const limit = intParam(q.limit, 'limit', TX_PAGE_DEFAULT, 1, TX_PAGE_MAX)!
  const categoryId = intParam(q.categoryId, 'category_id', undefined, 1)
  const accountId = intParam(q.accountId, 'account_id', undefined, 1)
  if (q.month !== undefined && q.month !== '' && !isoMonth.test(q.month)) bad('month must be YYYY-MM')
  if (categoryId !== undefined && q.uncategorized) bad('category_id and uncategorized are exclusive')

  // Every filter but the category one: the base the uncategorized count shares with the list.
  const base: string[] = []
  const params: unknown[] = []
  const needle = q.q?.trim()
  if (needle) {
    base.push("(t.description LIKE ? ESCAPE '\\' OR cat.name LIKE ? ESCAPE '\\')")
    params.push(likeAnywhere(needle), likeAnywhere(needle))
  }
  if (q.month) {
    base.push('t.posted_on LIKE ?')
    params.push(`${q.month}-%`)
  }
  if (accountId !== undefined) {
    base.push('t.account_id = ?')
    params.push(accountId)
  }
  const where = [...base]
  const whereParams = [...params]
  if (categoryId !== undefined) {
    where.push('t.category_id = ?')
    whereParams.push(categoryId)
  }
  if (q.uncategorized) where.push('t.category_id IS NULL')

  const from = `FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories cat ON cat.id = t.category_id`
  const clause = (w: string[]) => (w.length ? `WHERE ${w.join(' AND ')}` : '')
  const count = (w: string[], p: unknown[]) => (db.prepare(`SELECT count(*) AS n ${from} ${clause(w)}`).get(...p) as { n: number }).n

  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, t.posted_on, t.amount_cents,
              t.description, t.category_id, cat.name AS category_name, t.categorized_by
       ${from}
       ${clause(where)}
       ORDER BY t.posted_on DESC, t.id DESC LIMIT ? OFFSET ?`,
    )
    .all(...whereParams, limit, offset) as Tx[]
  return {
    rows,
    total: (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n,
    matching: count(where, whereParams),
    uncategorized: count([...base, 't.category_id IS NULL'], params),
    offset,
    limit,
  }
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

/**
 * The one definition of income and spending that every Cash number shares:
 * the Income vs. spending bars, Spending by category, Plan vs. actual and the
 * Savings card.
 *   - Transfers between your own accounts are neither.
 *   - A categorized row counts toward its category's net for the month, and a
 *     category counts only in its own direction, never below zero. A refund
 *     filed under Groceries lowers Groceries spending (to zero at most); it is
 *     not income. A reversed paycheck lowers Salary income.
 *   - Uncategorized money has no category to net against, so its inflows are
 *     income and its outflows spending, as they come.
 * One row per (month, category) with transactions; `kind` null = uncategorized.
 */
type CategoryFlow = {
  month: string
  category_id: number | null
  name: string
  kind: 'income' | 'expense' | null
  net: number
  inflow: number
  outflow: number
}
function categoryFlows(db: DbLike, month?: string): CategoryFlow[] {
  return db
    .prepare(
      `SELECT substr(t.posted_on, 1, 7) AS month, cat.id AS category_id,
              COALESCE(cat.name, 'Uncategorized') AS name, cat.kind AS kind,
              SUM(t.amount_cents) AS net,
              SUM(CASE WHEN t.amount_cents > 0 THEN t.amount_cents ELSE 0 END) AS inflow,
              SUM(CASE WHEN t.amount_cents < 0 THEN -t.amount_cents ELSE 0 END) AS outflow
       FROM transactions t
       LEFT JOIN categories cat ON cat.id = t.category_id
       WHERE (cat.kind IS NULL OR cat.kind != 'transfer') ${month ? 'AND t.posted_on LIKE ?' : ''}
       GROUP BY month, cat.id
       ORDER BY month`,
    )
    .all(...(month ? [`${month}-%`] : [])) as CategoryFlow[]
}
const flowIncome = (f: CategoryFlow) => (f.kind === 'income' ? Math.max(0, f.net) : f.kind === null ? f.inflow : 0)
const flowSpend = (f: CategoryFlow) => (f.kind === 'expense' ? Math.max(0, -f.net) : f.kind === null ? f.outflow : 0)

/**
 * Income and spending for every month that has a non-transfer transaction,
 * oldest first (months with none are absent — cashflowMonthly fills them).
 * Exported so other monthly cash-flow views can share the definition above.
 */
export function cashflowByMonth(db: DbLike): MonthlyFlow[] {
  const out = new Map<string, MonthlyFlow>()
  for (const f of categoryFlows(db)) {
    const m = out.get(f.month) ?? { month: f.month, income_cents: 0, spend_cents: 0 }
    m.income_cents += flowIncome(f)
    m.spend_cents += flowSpend(f)
    out.set(f.month, m)
  }
  return [...out.values()]
}

export const CASHFLOW_MONTHS_DEFAULT = 12
export const CASHFLOW_MONTHS_MAX = 120

/**
 * GET /api/cashflow/monthly?months=N: contiguous months ending at the latest
 * month with a transaction, at most N of them (default 12) and none before
 * the first. A month without transactions is there, at zero, so the bars keep
 * calendar spacing. An empty ledger is [].
 */
export function cashflowMonthly(db: DbLike, o: { months?: string | number | null } = {}): MonthlyFlow[] {
  const n = intParam(o.months, 'months', CASHFLOW_MONTHS_DEFAULT, 1, CASHFLOW_MONTHS_MAX)!
  const flows = cashflowByMonth(db)
  const last = flows[flows.length - 1]?.month
  if (!last) return []
  const first = flows[0]!.month
  const start = addMonthsToMonth(last, 1 - n)
  const byMonth = new Map(flows.map((f) => [f.month, f]))
  return monthsBetween(start > first ? start : first, last).map(
    (month) => byMonth.get(month) ?? { month, income_cents: 0, spend_cents: 0 },
  )
}

/** GET /api/cashflow/categories?month=: the month's spending per category (see the definition above), largest first; zero rows left out. */
export function cashflowCategories(db: DbLike, month?: string): CategorySpend[] {
  if (!isoMonth.test(month ?? '')) bad('month=YYYY-MM required')
  return categoryFlows(db, month)
    .map((f) => ({ category_id: f.category_id, name: f.name, spend_cents: flowSpend(f) }))
    .filter((r) => r.spend_cents > 0)
    .sort((a, b) => b.spend_cents - a.spend_cents || a.name.localeCompare(b.name))
}

/**
 * GET /api/budget?month=: every income and expense category with its monthly
 * budget and the month's actual, by the definition above — an expense row's
 * actual is exactly its Spending-by-category bar. Uncategorized money follows
 * as up to two rows (inflows as income, outflows as spending), when there is any.
 */
export function getBudget(db: DbLike, month?: string): BudgetRow[] {
  if (!isoMonth.test(month ?? '')) bad('month=YYYY-MM required')
  const flows = categoryFlows(db, month)
  const byCategory = new Map(flows.filter((f) => f.category_id !== null).map((f) => [f.category_id, f]))
  const cats = db
    .prepare(
      `SELECT cat.id AS category_id, cat.name, cat.kind, COALESCE(b.monthly_cents, 0) AS monthly_cents
       FROM categories cat
       LEFT JOIN budgets b ON b.category_id = cat.id
       WHERE cat.kind IN ('income', 'expense')
       ORDER BY cat.sort, cat.name`,
    )
    .all() as Omit<BudgetRow, 'actual_cents'>[]
  const rows: BudgetRow[] = cats.map((c) => {
    const f = byCategory.get(c.category_id)
    return { ...c, actual_cents: f ? (c.kind === 'income' ? flowIncome(f) : flowSpend(f)) : 0 }
  })
  const un = flows.find((f) => f.kind === null)
  if (un?.inflow)
    rows.push({ category_id: null, name: 'Uncategorized', kind: 'income', monthly_cents: 0, actual_cents: un.inflow })
  if (un?.outflow)
    rows.push({ category_id: null, name: 'Uncategorized', kind: 'expense', monthly_cents: 0, actual_cents: un.outflow })
  return rows
}

export function putBudget(db: DbLike, b: { categoryId?: number; monthlyCents?: number }) {
  if (!b.categoryId || !Number.isSafeInteger(b.monthlyCents)) bad('categoryId and integer monthlyCents required')
  if ((b.monthlyCents as number) < 0) bad('monthlyCents must not be negative')
  db.prepare(
    `INSERT INTO budgets (category_id, monthly_cents) VALUES (?, ?)
     ON CONFLICT (category_id) DO UPDATE SET monthly_cents = excluded.monthly_cents`,
  ).run(b.categoryId, b.monthlyCents)
  return { ok: true as const }
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

/** An optional field is absent when undefined, null or ''. */
const absent = (v: unknown) => v === undefined || v === null || v === ''
const isCents = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const isMicroPct = (v: unknown): v is number => isCents(v) && (v as number) <= 1_000_000

export function createProperty(db: DbLike, b: { name?: string; purchasedOn?: string | null; purchaseCents?: number | null }) {
  if (!b.name?.trim()) bad('name required')
  if (!absent(b.purchasedOn) && !isRealIsoDay(b.purchasedOn)) bad('purchasedOn must be a real yyyy-mm-dd day')
  if (!absent(b.purchaseCents) && !isCents(b.purchaseCents)) bad('purchaseCents must be a non-negative integer')
  const r = db
    .prepare('INSERT INTO properties (name, purchased_on, purchase_cents) VALUES (?, ?, ?)')
    .run(b.name!.trim(), absent(b.purchasedOn) ? null : b.purchasedOn, absent(b.purchaseCents) ? null : b.purchaseCents)
  return { id: Number(r.lastInsertRowid) }
}

export function putValuation(db: DbLike, id: number, b: { valuedOn?: string; valueCents?: number }) {
  if (!isRealIsoDay(b.valuedOn) || !Number.isSafeInteger(b.valueCents))
    bad('valuedOn (a real yyyy-mm-dd day) and integer valueCents required')
  if (!db.prepare('SELECT id FROM properties WHERE id = ?').get(id)) notFound('no such property')
  db.prepare(
    `INSERT INTO property_valuations (property_id, valued_on, value_cents) VALUES (?, ?, ?)
     ON CONFLICT (property_id, valued_on) DO UPDATE SET value_cents = excluded.value_cents`,
  ).run(id, b.valuedOn, b.valueCents)
  return { ok: true as const }
}

/**
 * A loan against a property. With `balanceCents` (and its `balancedOn`) the
 * first balance is recorded in the same transaction, so "Add mortgage" is one
 * write that either lands whole or not at all.
 */
export function createLiability(
  db: DbLike,
  b: { propertyId?: number | null; name?: string; rateMicro?: number | null; balanceCents?: number | null; balancedOn?: string | null },
) {
  if (!b.name?.trim()) bad('name required')
  if (!absent(b.rateMicro) && !isMicroPct(b.rateMicro)) bad('rateMicro must be an integer from 0 to 1000000 (100%)')
  const withBalance = !absent(b.balanceCents)
  if (withBalance && !isCents(b.balanceCents)) bad('balanceCents must be a non-negative integer')
  if (withBalance && !isRealIsoDay(b.balancedOn)) bad('balancedOn (a real yyyy-mm-dd day) required with balanceCents')
  if (!absent(b.propertyId)) {
    if (!Number.isSafeInteger(b.propertyId)) bad('propertyId must be an integer')
    if (!db.prepare('SELECT id FROM properties WHERE id = ?').get(b.propertyId)) notFound('no such property')
  }
  let id = 0
  db.transaction(() => {
    const r = db
      .prepare('INSERT INTO liabilities (property_id, name, rate_micro) VALUES (?, ?, ?)')
      .run(absent(b.propertyId) ? null : b.propertyId, b.name!.trim(), absent(b.rateMicro) ? null : b.rateMicro)
    id = Number(r.lastInsertRowid)
    if (withBalance)
      db.prepare('INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (?, ?, ?)').run(
        id,
        b.balancedOn,
        b.balanceCents,
      )
  })()
  return { id }
}

export function putLiabilityBalance(db: DbLike, id: number, b: { balancedOn?: string; balanceCents?: number }) {
  if (!isRealIsoDay(b.balancedOn) || !Number.isSafeInteger(b.balanceCents))
    bad('balancedOn (a real yyyy-mm-dd day) and integer balanceCents required')
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

/** One row of GET /api/activity: a bank transaction (tag = its category, '—' when none) or a trade (tag = its account). */
export type ActivityItem = { on_date: string; description: string; cents: number; tag: string; kind: 'tx' | 'trade' }

/** A trade in the feed's words: bought or sold — or, when no cash changed hands, what it was instead (the Investments activity's tags). */
function tradeLabel(t: CashTrade & { symbol: string }): string {
  if (t.side === 'sell') return t.note === RSU_WITHHOLDING_NOTE ? `withheld for tax ${t.symbol}` : `sell ${t.symbol}`
  if (t.note === OPENING_NOTE) return `starting position ${t.symbol}`
  if (t.note === RSU_VEST_NOTE) return `vest ${t.symbol}`
  return t.acquired_on != null && t.acquired_on < t.traded_on ? `transfer in ${t.symbol}` : `buy ${t.symbol}`
}

/**
 * The eight most recent transactions and trades, newest first. `cents` is
 * the cash that moved: a transaction's amount; a trade's effect on its
 * account's cash (engine/holdings.ts cashEffectCents), so a starting
 * position, a vest and the shares withheld at one read 0 — they were booked,
 * paid in shares, or paid to the tax authorities, never bought or sold with
 * cash — and say which they were.
 */
export function getActivity(db: DbLike): ActivityItem[] {
  const tx = db
    .prepare(
      `SELECT t.posted_on AS on_date, t.description, t.amount_cents AS cents, COALESCE(c.name,'—') AS tag, 'tx' AS kind
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       ORDER BY t.posted_on DESC, t.id DESC LIMIT 8`,
    )
    .all() as ActivityItem[]
  const trades = (
    db
      .prepare(
        `SELECT tr.traded_on, tr.side, tr.total_cents, tr.acquired_on, tr.note, a.symbol, ia.name AS account
         FROM trades tr JOIN assets a ON a.id = tr.asset_id JOIN invest_accounts ia ON ia.id = tr.invest_account_id
         ORDER BY tr.traded_on DESC, tr.id DESC LIMIT 8`,
      )
      .all() as (CashTrade & { symbol: string; account: string })[]
  ).map((t): ActivityItem => ({ on_date: t.traded_on, description: tradeLabel(t), cents: cashEffectCents(t), tag: t.account, kind: 'trade' }))
  return [...tx, ...trades].sort((a, b) => b.on_date.localeCompare(a.on_date)).slice(0, 8)
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

/** A stored integer, or the fallback when an old row holds something else (settings are merged JSON). */
const intOr = (v: unknown, fallback: number) => (Number.isSafeInteger(v) ? (v as number) : fallback)

/** a·b / d for non-negative integers, exact at any size (BigInt), rounded half up or floored. */
function mulDiv(a: number, b: number, d: number, mode: 'round' | 'floor'): number {
  const p = BigInt(a) * BigInt(b)
  const D = BigInt(d)
  const q = p / D
  return Number(mode === 'round' && (p % D) * 2n >= D ? q + 1n : q)
}

/** An ETA further out than this is no ETA: the plan doesn't close the gap in any horizon worth a month name. */
const MAX_ETA_MONTHS = 1200

/**
 * The goal's headline numbers, from the stored settings and the fund's
 * balance — integer cents and micro only. The target is the cash to close
 * (down payment + closing costs). `etaMonth` counts whole months of the
 * monthly plan from today's month with integer (year, month) arithmetic, so a
 * 31st or an evening in a US time zone can't shift it.
 */
export function goalDerived(goal: GoalSettings, fundCents: number, today: string): GoalDerived {
  const price = Math.max(0, intOr(goal.targetPriceCents, GOAL_DEFAULTS.targetPriceCents))
  const downMicro = Math.min(1_000_000, Math.max(0, intOr(goal.downPctMicro, GOAL_DEFAULTS.downPctMicro)))
  const closing = Math.max(0, intOr(goal.closingCents, GOAL_DEFAULTS.closingCents))
  const plan = Math.max(0, intOr(goal.monthlyPlanCents, 0))
  const targetCents = mulDiv(price, downMicro, 1_000_000, 'round') + closing
  const remainingCents = Math.max(0, targetCents - fundCents)
  const pctMicro =
    remainingCents === 0 ? 1_000_000 : fundCents <= 0 ? 0 : mulDiv(fundCents, 1_000_000, targetCents, 'floor')
  let etaMonth: string | null = null
  if (remainingCents > 0 && plan > 0) {
    const months = Math.floor(remainingCents / plan) + (remainingCents % plan === 0 ? 0 : 1)
    if (months <= MAX_ETA_MONTHS) etaMonth = addMonthsToMonth(today.slice(0, 7), months)
  }
  return { targetCents, fundCents, remainingCents, monthlyPlanCents: plan, etaMonth, pctMicro }
}

/**
 * Everything the Dream Home screen reads, plus `derived` (GoalDerived): the
 * target, fund, gap, percent and ETA computed here rather than in each client.
 * `today` (yyyy-mm-dd) anchors the ETA; the server passes its day, the tab
 * its local day.
 */
export function getGoal(db: DbLike, today: string = todayLocal()) {
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
  const derived = goalDerived(goal, fundTotal, today)
  return { goal, rental, accounts, fundTotal, series, monthlySuggest, loans, properties, derived }
}

/**
 * What each stored setting may hold: whole cents ≥ 0, a rate in micro
 * (0 … 1e6 = 100%), a row id or null, or a list of row ids. putGoal checks a
 * patch against these before anything is written, so a bad value is a 400 —
 * never a NaN or a string quietly stored and read back as a number.
 */
type SettingRule = 'cents' | 'micro' | 'idOrNull' | 'ids'
const GOAL_RULES: Record<keyof GoalSettings, SettingRule> = {
  targetPriceCents: 'cents',
  downPctMicro: 'micro',
  closingCents: 'cents',
  fundAccountIds: 'ids',
  fundExtraCents: 'cents',
  monthlyPlanCents: 'cents',
  selectedLoanId: 'idOrNull',
  taxPctMicro: 'micro',
  insMonthlyCents: 'cents',
  capGainsRateMicro: 'micro',
  lossCarryforwardCents: 'cents',
  saleBasisPctMicro: 'micro',
}
const RENTAL_RULES: Record<keyof RentalSettings, SettingRule> = {
  propertyId: 'idOrNull',
  rentCents: 'cents',
  piCents: 'cents',
  taxCents: 'cents',
  insCents: 'cents',
  maintPctMicro: 'micro',
  vacancyPctMicro: 'micro',
}
const isId = (v: unknown) => Number.isSafeInteger(v) && (v as number) > 0

function checkSettings<T>(what: string, patch: unknown, rules: Record<string, SettingRule>): Partial<T> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) bad(`${what} must be an object`)
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const rule = Object.hasOwn(rules, k) ? rules[k] : undefined
    if (!rule) bad(`unknown ${what} setting: ${k}`)
    const ok =
      rule === 'cents' ? isCents(v)
      : rule === 'micro' ? isMicroPct(v)
      : rule === 'idOrNull' ? v === null || isId(v)
      : Array.isArray(v) && v.every(isId)
    if (!ok)
      bad(
        rule === 'cents' ? `${k} must be a non-negative integer (cents)`
        : rule === 'micro' ? `${k} must be an integer from 0 to 1000000 (100%)`
        : rule === 'idOrNull' ? `${k} must be an id or null`
        : `${k} must be a list of ids`,
      )
  }
  return patch as Partial<T>
}

/** Store a setting only when it changes: a no-op save writes nothing, so it never dirties a vault session. */
function writeSettingIfChanged(db: DbLike, key: string, value: unknown) {
  const next = JSON.stringify(value)
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(key) as { value: string } | undefined
  if (row?.value === next) return
  db.prepare(
    'INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, next)
}

export function putGoal(db: DbLike, b: { goal?: Partial<GoalSettings>; rental?: Partial<RentalSettings> }) {
  // Validate both halves before writing either.
  const goal = b.goal === undefined ? null : checkSettings<GoalSettings>('goal', b.goal, GOAL_RULES)
  const rental = b.rental === undefined ? null : checkSettings<RentalSettings>('rental', b.rental, RENTAL_RULES)
  if (goal && Object.keys(goal).length > 0)
    writeSettingIfChanged(db, 'goal', { ...readSetting(db, 'goal', GOAL_DEFAULTS), ...goal })
  if (rental && Object.keys(rental).length > 0)
    writeSettingIfChanged(db, 'rental', { ...readSetting(db, 'rental', RENTAL_DEFAULTS), ...rental })
  return { ok: true as const }
}

export function createLoan(
  db: DbLike,
  b: { name?: string; rateMicro?: number; termMonths?: number; pointsMicro?: number; note?: string | null },
) {
  if (
    !b.name?.trim() ||
    !Number.isSafeInteger(b.rateMicro) ||
    (b.rateMicro as number) <= 0 ||
    !Number.isSafeInteger(b.termMonths) ||
    (b.termMonths as number) <= 0
  )
    bad('name, rateMicro, termMonths required')
  if ((b.rateMicro as number) > 1_000_000) bad('rateMicro must be at most 1000000 (100%)')
  if ((b.termMonths as number) > 600) bad('termMonths must be at most 600 (50 years)')
  if (b.pointsMicro !== undefined && !isMicroPct(b.pointsMicro)) bad('pointsMicro must be an integer from 0 to 1000000')
  if (!absent(b.note) && typeof b.note !== 'string') bad('note must be text')
  const r = db
    .prepare('INSERT INTO loan_options (name, rate_micro, term_months, points_micro, note) VALUES (?, ?, ?, ?, ?)')
    .run(b.name!.trim(), b.rateMicro, b.termMonths, b.pointsMicro ?? 0, absent(b.note) ? null : b.note!.trim() || null)
  return { id: Number(r.lastInsertRowid) }
}

export function deleteLoan(db: DbLike, id: number) {
  const r = db.prepare('DELETE FROM loan_options WHERE id = ?').run(id)
  if (!r.changes) notFound('no such loan option')
  return { ok: true as const }
}
