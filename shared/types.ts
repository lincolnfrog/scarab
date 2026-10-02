// Types shared between server responses and the client.
export type AccountKind = 'checking' | 'savings' | 'credit'
/** A bank account; balance_cents is the ledger's balance today (opening + every transaction) — negative on a card while it's owed. */
export type Account = { id: number; name: string; kind: AccountKind; balance_cents: number }
/** One thing owed, as of today (GET /api/networth `debts`). owedCents is positive while owed; a card in credit is negative. */
export type Debt =
  | { kind: 'loan'; id: number; name: string; property: string | null; rateMicro: number | null; owedCents: number }
  | { kind: 'card'; id: number; name: string; owedCents: number }
export type Category = { id: number; name: string; kind: 'income' | 'expense' | 'transfer'; sort: number }

export type Tx = {
  id: number
  account_id: number
  account_name: string
  posted_on: string
  amount_cents: number
  description: string
  category_id: number | null
  category_name: string | null
  categorized_by: string | null
}

/**
 * One month of GET /api/cashflow/monthly. tax_cents is the part of spend_cents
 * filed under Taxes; moved_cents is money moved out of the bank and card
 * accounts to accounts outside them (net; negative when more came in).
 */
export type MonthlyFlow = { month: string; income_cents: number; spend_cents: number; tax_cents: number; moved_cents: number }
export type CategorySpend = { category_id: number | null; name: string; spend_cents: number }
export type BudgetRow = {
  category_id: number | null
  name: string
  kind: 'income' | 'expense'
  monthly_cents: number
  actual_cents: number
}
export type ImportSummary = {
  format: string
  rowsTotal: number
  imported: number
  skipped: number
  transfersFiled: number
}
/** POST /api/rules/import: what a pasted rule list changed (engine importRules). */
export type RulesImportResult = {
  added: number
  updated: number
  unchanged: number
  /** Names of the spending categories the list created. */
  categoriesCreated: string[]
  /** Transactions whose category changed. */
  refiled: number
}
export type ImportRecord = {
  id: number
  account_name: string
  filename: string
  format: string
  rows_total: number
  rows_imported: number
  rows_skipped: number
  imported_at: string
  imported_by: string
}

/** The Dream-home goal's numbers, derived by the engine: GET /api/goal → { …settings, derived }. */
export type GoalDerived = {
  targetCents: number // down payment + closing costs
  fundCents: number // fund accounts + earmarked extra; negative if the accounts are overdrawn
  remainingCents: number // max(0, target − fund)
  monthlyPlanCents: number
  etaMonth: string | null // YYYY-MM the monthly plan closes the gap (calendar months from today's month); null without a plan, once funded, or > 100 years out
  pctMicro: number // fund / target, floored and clamped to 0…1e6 (1e6 = 100%, reached only once funded)
}

/** GET /api/transactions?q=&month=&category_id=|uncategorized=1&account_id=&offset=&limit= — one page, newest first. */
export type TxPage = {
  rows: Tx[]
  total: number // every transaction in the ledger
  matching: number // every row the filters select; the page is `limit` of them from `offset`
  uncategorized: number // rows "uncategorized=1" would select with the other filters unchanged
  offset: number
  limit: number
}
