/**
 * The Cash screen's view state as it lives in the URL fragment, and the
 * transactions query built from it. Pure, so node tests can drive it.
 *
 *   #/cash?month=2026-08&cat=12&acct=3&scope=month
 *
 * Only a YYYY-MM month, numeric ids and enums go in the fragment (browser
 * history syncs it). The search text is household data — merchant names — so
 * it rides in route state (useRouteState('q')), never here.
 *
 *   month  the month the charts, budget and savings show; absent = the latest
 *          month with transactions
 *   cat    a category id, or 'uncat'; absent = every category
 *   acct   an account id; absent = every account
 *   scope  'month' limits the transaction list to `month`; absent = all months
 */

export type CatFilter = 'all' | 'uncategorized' | number
export type CashFilters = { month: string | null; cat: CatFilter; acct: number | 'all'; scope: 'all' | 'month' }

/** Rows per page of the transaction list, and the most one refresh re-reads (the engine's TX_PAGE_MAX). */
export const TX_PAGE = 100
export const TX_REFRESH_MAX = 500

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
const ID = /^[1-9]\d{0,14}$/

const id = (s: string | undefined): number | null => (s !== undefined && ID.test(s) ? Number(s) : null)

/** Read the filters from a route's params. Anything malformed means "no filter" — a stale or hand-edited link never breaks the screen. */
export function readCashParams(p: Readonly<Record<string, string>>): CashFilters {
  return {
    month: p.month !== undefined && MONTH.test(p.month) ? p.month : null,
    cat: p.cat === 'uncat' ? 'uncategorized' : (id(p.cat) ?? 'all'),
    acct: id(p.acct) ?? 'all',
    scope: p.scope === 'month' ? 'month' : 'all',
  }
}

/** The setParams patch for a change of filters: a default removes its key, so the fragment stays short. */
export function cashParamsPatch(f: Partial<CashFilters>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {}
  if ('month' in f) out.month = f.month ?? null
  if ('cat' in f) out.cat = f.cat === undefined || f.cat === 'all' ? null : f.cat === 'uncategorized' ? 'uncat' : f.cat
  if ('acct' in f) out.acct = f.acct === undefined || f.acct === 'all' ? null : f.acct
  if ('scope' in f) out.scope = f.scope === 'month' ? 'month' : null
  return out
}

/**
 * GET /api/transactions query string for the filters (no offset/limit): the
 * cache key for "same list", too. `month` is the month the screen shows,
 * used only when the list is scoped to it.
 */
export function txFilterQuery(f: Pick<CashFilters, 'cat' | 'acct' | 'scope'> & { month: string; q: string }): string {
  const p = new URLSearchParams()
  const q = f.q.trim()
  if (q) p.set('q', q)
  if (f.scope === 'month') p.set('month', f.month)
  if (f.cat === 'uncategorized') p.set('uncategorized', '1')
  else if (typeof f.cat === 'number') p.set('category_id', String(f.cat))
  if (f.acct !== 'all') p.set('account_id', String(f.acct))
  return p.toString()
}

/** One page of that list: the filter query plus offset and limit. */
export function txPageQuery(filterQuery: string, offset: number, limit: number): string {
  const p = new URLSearchParams(filterQuery)
  p.set('offset', String(offset))
  p.set('limit', String(limit))
  return p.toString()
}

/** The month picker's choices: the chart's months, plus the one the URL asks for when it's older than they reach. */
export function monthChoices(months: readonly string[], selected: string): string[] {
  return months.includes(selected) ? [...months] : [...months, selected].sort()
}
