import { describe, expect, it } from 'vitest'
import { formatRoute, parseHash } from '../router'
import { cashParamsPatch, monthChoices, readCashParams, txFilterQuery, txPageQuery, type CashFilters } from './cash-route'

const NONE: CashFilters = { month: null, cat: 'all', acct: 'all', scope: 'all' }

/** What setParams would leave in the fragment for this patch, starting from `from`. */
function applied(from: string, f: Partial<CashFilters>): string {
  const here = parseHash(from)
  const params: Record<string, string | number | undefined> = { ...here.params }
  for (const [k, v] of Object.entries(cashParamsPatch(f))) params[k] = v === null ? undefined : v
  return formatRoute({ screen: here.screen, rest: here.rest, params })
}

describe('readCashParams', () => {
  it('reads month, category, account and scope', () => {
    expect(readCashParams(parseHash('#/cash?month=2026-08&cat=12&acct=3&scope=month').params)).toEqual({
      month: '2026-08',
      cat: 12,
      acct: 3,
      scope: 'month',
    })
    expect(readCashParams(parseHash('#/cash?cat=uncat').params)).toEqual({ ...NONE, cat: 'uncategorized' })
    expect(readCashParams({})).toEqual(NONE)
  })

  it('treats anything malformed as no filter', () => {
    for (const [k, v] of [
      ['month', '2026-13'],
      ['month', '2026-8'],
      ['month', 'latest'],
      ['cat', '0'],
      ['cat', '012'],
      ['cat', '-3'],
      ['cat', 'uncategorized'],
      ['cat', '1e3'],
      ['acct', 'all'],
      ['acct', '99999999999999999999'],
      ['scope', 'year'],
    ])
      expect(readCashParams({ [k!]: v! }), `${k}=${v}`).toEqual(NONE)
  })
})

describe('cashParamsPatch', () => {
  it('writes only hash-safe values, and a default removes its key', () => {
    expect(applied('#/cash', { month: '2026-08', cat: 12, acct: 3, scope: 'month' })).toBe('#/cash?month=2026-08&cat=12&acct=3&scope=month')
    expect(applied('#/cash?month=2026-08&cat=12&scope=month', { cat: 'all', scope: 'all' })).toBe('#/cash?month=2026-08')
    expect(applied('#/cash?cat=12', { cat: 'uncategorized' })).toBe('#/cash?cat=uncat')
    expect(applied('#/cash?acct=3&month=2026-07', { month: null, acct: 'all' })).toBe('#/cash')
  })

  it('leaves the keys it is not given, and a section, alone', () => {
    expect(cashParamsPatch({ cat: 5 })).toEqual({ cat: 5 })
    expect(applied('#/cash/transactions?month=2026-08', { cat: 5 })).toBe('#/cash/transactions?month=2026-08&cat=5')
  })

  it('round-trips through the fragment', () => {
    for (const f of [
      { month: '2025-12', cat: 'uncategorized', acct: 7, scope: 'month' },
      { month: null, cat: 41, acct: 'all', scope: 'all' },
      NONE,
    ] as CashFilters[])
      expect(readCashParams(parseHash(applied('#/cash', f)).params)).toEqual(f)
  })
})

describe('transactions query', () => {
  it('carries the filters, the month only when scoped to it, and the search text trimmed', () => {
    expect(txFilterQuery({ cat: 'all', acct: 'all', scope: 'all', month: '2026-08', q: '' })).toBe('')
    expect(txFilterQuery({ cat: 12, acct: 3, scope: 'month', month: '2026-08', q: ' trader joe ' })).toBe(
      'q=trader+joe&month=2026-08&category_id=12&account_id=3',
    )
    expect(txFilterQuery({ cat: 'uncategorized', acct: 'all', scope: 'all', month: '2026-08', q: '100%' })).toBe('q=100%25&uncategorized=1')
  })

  it('a page adds offset and limit to the filter query', () => {
    expect(txPageQuery('category_id=12', 100, 100)).toBe('category_id=12&offset=100&limit=100')
    expect(txPageQuery('', 0, 100)).toBe('offset=0&limit=100')
  })
})

describe('monthChoices', () => {
  it('adds a linked month older than the chart reaches, in order', () => {
    expect(monthChoices(['2026-07', '2026-08'], '2026-08')).toEqual(['2026-07', '2026-08'])
    expect(monthChoices(['2026-07', '2026-08'], '2025-01')).toEqual(['2025-01', '2026-07', '2026-08'])
    expect(monthChoices([], '2026-09')).toEqual(['2026-09'])
  })
})
