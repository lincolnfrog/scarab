import type { Dump } from '../../../engine/snapshot'

/**
 * Pure helpers for looking at earlier versions and backups: row counts per
 * table, then against now, and the words for them. (Named versions.ts, not
 * history.ts: History.tsx lives next to it on a case-insensitive disk.)
 */

/** Rows per table as a snapshot carries them. The price basket's app_meta keys never belong to a snapshot. */
export function countRows(dump: Dump): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [t, rows] of Object.entries(dump.tables ?? {})) {
    if (!Array.isArray(rows)) continue
    out[t] = t === 'app_meta' ? rows.filter((r) => !String((r as { key?: unknown }).key ?? '').toLowerCase().startsWith('basket:')).length : rows.length
  }
  return out
}

/** What a person calls each table. Anything not listed shows its own name. */
export const TABLE_LABELS: Readonly<Record<string, string>> = {
  app_meta: 'Settings and marks',
  accounts: 'Cash accounts',
  categories: 'Categories',
  imports: 'Statement imports',
  transactions: 'Transactions',
  rules: 'Categorizing rules',
  budgets: 'Budgets',
  invest_accounts: 'Investment accounts',
  assets: 'Securities',
  trades: 'Trades',
  prices: 'Prices',
  prices_daily: 'Daily prices',
  balance_snapshots: 'Balance check-ins',
  properties: 'Properties',
  property_valuations: 'Property valuations',
  liabilities: 'Loans and mortgages',
  liability_balances: 'Loan balances',
  rsu_vests: 'Stock vests',
  unvested_positions: 'Unvested grants',
  goal_settings: 'Goal settings',
  pay_sources: 'Paychecks',
  loan_options: 'Loan options',
  scenarios: 'Scenarios',
}

export type CountRow = { table: string; label: string; then: number; now: number | null; delta: number | null }

/**
 * The tables worth showing — any with rows on either side — in the
 * snapshot's own table order, then any only `now` has. `now` null: nothing
 * to compare with (the front door, before any session).
 */
export function compareCounts(then: Record<string, number>, now: Record<string, number> | null): CountRow[] {
  const tables = [...Object.keys(then), ...Object.keys(now ?? {}).filter((t) => !(t in then))]
  return tables
    .map((table) => {
      const a = then[table] ?? 0
      const b = now ? (now[table] ?? 0) : null
      return { table, label: TABLE_LABELS[table] ?? table, then: a, now: b, delta: b === null ? null : a - b }
    })
    .filter((r) => r.then > 0 || (r.now ?? 0) > 0)
}

/** "The same rows as now" — by count; the data can still differ inside a table. */
export const sameCounts = (rows: readonly CountRow[]): boolean => rows.every((r) => r.delta === 0)

/** "+3" / "−2" / "" — a row-count change, never coloured as a gain or loss. */
export const deltaText = (d: number | null): string => (d === null || d === 0 ? '' : d > 0 ? `+${d}` : `−${-d}`)

/** Why the server keeps a version past the ordinary rules, in words. */
export function pinLabel(pin: string | null): string | null {
  if (pin === 'pre-upgrade') return 'kept from before an upgrade'
  if (pin === 'pre-restore') return 'kept from before a restore'
  return pin ? `kept (${pin})` : null
}

/** The retention policy, in one sentence. */
export function policyText(p: { keepLast: number; dailyDays: number; byteCap: number }): string {
  const mb = Math.round(p.byteCap / (1024 * 1024))
  return `The server keeps the last ${p.keepLast} versions, the last one of each day for ${p.dailyDays} days, and versions kept from before an upgrade or a restore — up to ${mb} MB in all.`
}

/** A download: a file the person keeps. Nothing is uploaded. */
export function downloadFile(filename: string, contents: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
