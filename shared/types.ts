// Types shared between server responses and the client.
export type Account = { id: number; name: string; kind: 'checking' | 'savings' }
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

export type MonthlyFlow = { month: string; income_cents: number; spend_cents: number }
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
