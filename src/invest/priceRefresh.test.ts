import { describe, expect, it } from 'vitest'
import { BALANCE_STALE_DAYS, isBalanceStale, quarterEnds, shortDay } from './balanceMath'
import { failedSymbols, priceClock, priceStale, refreshMemory, shouldRefresh } from './priceRefresh'

const held = (...rows: [string, string | null][]) => rows.map(([symbol, priced_on]) => ({ symbol, priced_on }))
const NONE = new Set<string>()

describe('shouldRefresh', () => {
  const built = '2026-09-23T07:38:35.118Z' // Wednesday's basket: Tuesday's closes

  it('refreshes when a holding is priced before the clock day, or not at all', () => {
    expect(shouldRefresh(held(['VTI', '2026-09-21']), built, NONE)).toBe(true)
    expect(shouldRefresh(held(['VTI', null]), built, NONE)).toBe(true)
  })

  it('does nothing when every price is as fresh as the clock, with no holdings, or with no clock', () => {
    expect(shouldRefresh(held(['VTI', '2026-09-23']), built, NONE)).toBe(false)
    expect(shouldRefresh([], built, NONE)).toBe(false)
    expect(shouldRefresh(held(['VTI', null]), null, NONE)).toBe(false) // a tab with no basket yet
  })

  it('never asks twice for the same clock — a weekend basket carries Friday’s closes', () => {
    const saturday = '2026-09-26T07:00:00.000Z'
    const afterFirst = held(['VTI', '2026-09-25']) // refreshed: Friday is the newest close there is
    expect(shouldRefresh(afterFirst, saturday, NONE)).toBe(true)
    expect(shouldRefresh(afterFirst, saturday, NONE, saturday)).toBe(false)
    // Monday's basket is a new clock.
    expect(shouldRefresh(afterFirst, '2026-09-29T07:00:00.000Z', NONE, saturday)).toBe(true)
  })

  it('still refreshes on the same clock for a symbol that arrived after that refresh (F11)', () => {
    // VTI was held and priced by the refresh against `built`; SPY was bought afterwards and has no price.
    const after = held(['VTI', '2026-09-22'], ['SPY', null])
    expect(shouldRefresh(after, built, NONE, built, new Set(['VTI']))).toBe(true)
    // Once SPY took part too, that clock is done — even though the basket's closes are a day old.
    expect(shouldRefresh(held(['VTI', '2026-09-22'], ['SPY', '2026-09-22']), built, NONE, built, new Set(['VTI', 'SPY']))).toBe(false)
    // A newcomer the basket can't quote fails once and is left to a hand-set price.
    expect(shouldRefresh(after, built, new Set(['SPY']), built, new Set(['VTI']))).toBe(false)
    // Unknown coverage (a refresh from before this page loaded) keeps the old once-per-clock rule.
    expect(shouldRefresh(after, built, NONE, built, null)).toBe(false)
  })

  it('skips symbols that already failed in this tab (funds, private stock), but not the rest', () => {
    const failed = new Set(['ACME'])
    expect(shouldRefresh(held(['ACME', null]), built, failed)).toBe(false)
    expect(shouldRefresh(held(['ACME', '2026-09-01']), built, failed)).toBe(false)
    expect(shouldRefresh(held(['ACME', null], ['VTI', '2026-09-20']), built, failed)).toBe(true)
  })

  it('uses the household’s day on the server, where no basket is involved', () => {
    expect(priceClock('household', null, '2026-09-23')).toBe('2026-09-23')
    expect(priceClock('household', built, '2026-09-23')).toBe('2026-09-23')
    expect(priceClock('session', built, '2026-09-23')).toBe(built)
    expect(priceClock('session', null, '2026-09-23')).toBeNull()
    const today = priceClock('household', null, '2026-09-23')
    expect(shouldRefresh(held(['VTI', '2026-09-22']), today, NONE)).toBe(true)
    expect(shouldRefresh(held(['VTI', '2026-09-22']), today, NONE, '2026-09-23')).toBe(false) // once a day
    expect(shouldRefresh(held(['VTI', '2026-09-22']), '2026-09-24', NONE, '2026-09-23')).toBe(true)
  })
})

describe('failedSymbols', () => {
  it('reads SYM: reason lines for held symbols only, and ignores history failures', () => {
    const errors = [
      'ACME: not in today’s basket',
      'FXAIX: Yahoo HTTP 404',
      'vti: no quote from Yahoo',
      'VXUS: no history from Yahoo',
      'coingecko: HTTP 429',
      'no assets yet — record a trade first',
      'OTHER: not held here',
    ]
    expect(failedSymbols(errors, ['ACME', 'FXAIX', 'VTI', 'VXUS']).sort()).toEqual(['ACME', 'FXAIX', 'VTI'])
  })
})

describe('refreshMemory', () => {
  it('keeps failed symbols and the last clock per data universe', () => {
    const a = refreshMemory('s-test-1')
    expect(a.refreshedFor).toBeNull()
    a.record('2026-09-23T07:00:00Z', ['ACME'])
    const again = refreshMemory('s-test-1')
    expect(again.refreshedFor).toBe('2026-09-23T07:00:00Z')
    expect([...again.failed]).toEqual(['ACME'])
    expect(refreshMemory('s-test-2').failed.size).toBe(0) // another vault's data starts fresh
  })

  it('remembers which symbols each clock covered, adding up on the same clock and starting over on a new one', () => {
    const m = refreshMemory('s-test-3')
    expect(m.covered).toBeNull()
    m.adopt(['VTI']) // nothing refreshed yet: nothing to adopt
    expect(m.covered).toBeNull()
    const c1 = '2026-09-23T07:00:00Z'
    m.record(c1, [], ['VTI'])
    expect([...m.covered!]).toEqual(['VTI'])
    // SPY bought later, then refreshed against the same basket.
    expect(shouldRefresh(held(['VTI', '2026-09-22'], ['SPY', null]), c1, m.failed, m.refreshedFor, m.covered)).toBe(true)
    m.record(c1, [], ['VTI', 'SPY'])
    expect([...m.covered!].sort()).toEqual(['SPY', 'VTI'])
    m.record('2026-09-24T07:00:00Z', [], ['VTI'])
    expect([...m.covered!]).toEqual(['VTI'])
  })

  it('adopts what is held as covered when the last refresh predates the page (the household day survives a reload)', () => {
    const store = new Map<string, string>([['scarab:prices-refreshed-for', '2026-09-23']])
    const g = globalThis as { sessionStorage?: unknown }
    const had = g.sessionStorage
    g.sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    try {
      const h = refreshMemory('h')
      expect(h.refreshedFor).toBe('2026-09-23')
      expect(h.covered).toBeNull()
      h.adopt(['VTI'])
      expect(shouldRefresh(held(['VTI', '2026-09-22']), '2026-09-23', h.failed, h.refreshedFor, h.covered)).toBe(false)
      // Bought after the reload: its own refresh, the same day.
      expect(shouldRefresh(held(['VTI', '2026-09-22'], ['SPY', null]), '2026-09-23', h.failed, h.refreshedFor, h.covered)).toBe(true)
      h.adopt(['VTI', 'SPY']) // adopting happens once; a later call can't swallow the newcomer
      expect([...h.covered!]).toEqual(['VTI'])
    } finally {
      g.sessionStorage = had
    }
  })
})

describe('priceStale', () => {
  it('is stale with no price or one more than 7 days old', () => {
    expect(priceStale(null, '2026-09-23')).toBe(true)
    expect(priceStale('2026-09-16', '2026-09-23')).toBe(false)
    expect(priceStale('2026-09-15', '2026-09-23')).toBe(true)
  })
})

describe('balance accounts', () => {
  it('a balance is stale after 45 days; a missing one is not "stale"', () => {
    expect(BALANCE_STALE_DAYS).toBe(45)
    expect(isBalanceStale('2026-08-09', '2026-09-23')).toBe(false) // 45 days
    expect(isBalanceStale('2026-08-08', '2026-09-23')).toBe(true) // 46
    expect(isBalanceStale(null, '2026-09-23')).toBe(false)
  })

  it('offers the last 8 quarter-ends on or before today, newest first', () => {
    expect(quarterEnds('2026-09-23')).toEqual([
      '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31', '2024-09-30',
    ])
    expect(quarterEnds('2026-09-30', 2)).toEqual(['2026-09-30', '2026-06-30'])
    expect(quarterEnds('2024-03-31', 3)).toEqual(['2024-03-31', '2023-12-31', '2023-09-30'])
    expect(quarterEnds('2024-01-01', 1)).toEqual(['2023-12-31'])
  })

  it('short day labels carry the year only outside today’s', () => {
    expect(shortDay('2026-09-20', '2026-09-23')).toBe('Sep 20')
    expect(shortDay('2025-12-31', '2026-09-23')).toBe('Dec 31, 2025')
  })
})
