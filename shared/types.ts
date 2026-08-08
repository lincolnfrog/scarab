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
