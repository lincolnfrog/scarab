import { daysBetween } from './lotMath'

/**
 * When the Investments screen fetches prices by itself — and when it
 * doesn't. The old rule refetched on every visit whenever any price was
 * older than today, which on a weekend, for a fund no source quotes, or for
 * hand-priced private stock meant forever.
 *
 * The rule now: refresh only when fresher prices can exist than what is
 * stored, and at most once per clock tick.
 *   · The clock is when fresher prices could have appeared. In a tab
 *     (zero-knowledge session) prices come from the shared daily basket, so
 *     it is `basket/status.builtAt`. On the household server the refresh
 *     asks the quote sources directly and no basket is involved, so it is
 *     the household's day.
 *   · A holding needs a refresh when it has no price or its price is dated
 *     before the clock's day — unless its symbol already failed to price in
 *     this tab (not in the basket, unknown to the source): those are skipped
 *     for the rest of the tab and are priced by hand instead.
 *   · After a refresh against a clock, the same clock never triggers another
 *     one for the symbols that refresh covered: a basket built Saturday
 *     carries Friday's closes, and asking again would only fetch them again.
 *     A symbol that arrived after it (a trade, a vest, starting positions)
 *     took no part in it, so it still gets its one refresh on that clock.
 */

/** A market price older than this is shown as stale and offered a hand-set price. */
export const PRICE_STALE_DAYS = 7

export type PricedHolding = { symbol: string; priced_on: string | null }

/** No price at all, or none within the last PRICE_STALE_DAYS days. */
export function priceStale(pricedOn: string | null, today: string, days: number = PRICE_STALE_DAYS): boolean {
  return pricedOn === null || daysBetween(pricedOn, today) > days
}

/** The clock for this data universe: the basket's build time in a tab, the household's day on the server. */
export function priceClock(mode: 'session' | 'household', basketBuiltAt: string | null, today: string): string | null {
  return mode === 'session' ? basketBuiltAt : today
}

/**
 * Should the screen refresh prices by itself now? `clock` is priceClock()'s
 * answer (null: nothing to refresh from); `refreshedFor` is the clock the
 * last refresh in this tab ran against, and `covered` the symbols held when
 * it ran (null: not known — every holding counts as covered).
 */
export function shouldRefresh(
  positions: readonly PricedHolding[],
  clock: string | null,
  failed: ReadonlySet<string>,
  refreshedFor: string | null = null,
  covered: ReadonlySet<string> | null = null,
): boolean {
  if (!clock) return false
  const again = refreshedFor !== null && clock <= refreshedFor
  if (again && covered === null) return false
  const day = clock.slice(0, 10)
  return positions.some(
    (p) => !failed.has(p.symbol) && (p.priced_on === null || p.priced_on < day) && !(again && covered!.has(p.symbol)),
  )
}

/**
 * The held symbols a refresh reported as unpriceable. Both refresh paths
 * report per-symbol problems as `SYM: reason` ("ACME: not in today's
 * basket", "ACME: Yahoo HTTP 404"). History backfill errors are not quote
 * failures — the symbol may well have a fresh quote — so they don't count.
 */
export function failedSymbols(errors: readonly string[], held: readonly string[]): string[] {
  const bySym = new Map(held.map((s) => [s.toUpperCase(), s]))
  const out = new Set<string>()
  for (const e of errors) {
    const i = e.indexOf(':')
    if (i <= 0 || /history/i.test(e)) continue
    const sym = bySym.get(e.slice(0, i).trim().toUpperCase())
    if (sym) out.add(sym)
  }
  return [...out]
}

/* ---------- tab memory ---------- */

type Memory = { failed: Set<string>; refreshedFor: string | null; covered: Set<string> | null }
const memories = new Map<string, Memory>()
// The household's last refresh day survives a reload of the tab (a day, not
// household data); which symbols a refresh covered, and which failed, stay in
// memory only and end with the page.
const HOUSEHOLD_KEY = 'scarab:prices-refreshed-for'

function readStored(): string | null {
  try {
    return sessionStorage.getItem(HOUSEHOLD_KEY)
  } catch {
    return null
  }
}

/**
 * What this tab remembers about refreshing one data universe: `h` for the
 * household server, `s<epoch>` for a session (a new epoch — another vault's
 * data loaded — starts fresh).
 */
export function refreshMemory(universe: string): {
  readonly failed: ReadonlySet<string>
  readonly refreshedFor: string | null
  /** The symbols held when the refresh against `refreshedFor` ran; null before adopt() when this page didn't run it. */
  readonly covered: ReadonlySet<string> | null
  /**
   * The last refresh ran before this page loaded (the household's day, kept
   * across a reload): take what is held now as what it covered, so only a
   * symbol added from here on asks again on the same clock.
   */
  adopt(held: readonly string[]): void
  /** A refresh ran against `clock` while `held` were held; `failedNow` of them found no quote. */
  record(clock: string, failedNow: readonly string[], held?: readonly string[]): void
} {
  let m = memories.get(universe)
  if (!m) {
    m = { failed: new Set(), refreshedFor: universe === 'h' ? readStored() : null, covered: null }
    memories.set(universe, m)
  }
  const mem = m
  return {
    get failed() {
      return mem.failed
    },
    get refreshedFor() {
      return mem.refreshedFor
    },
    get covered() {
      return mem.covered
    },
    adopt(held) {
      if (mem.refreshedFor !== null && mem.covered === null) mem.covered = new Set(held)
    },
    record(clock, failedNow, held = []) {
      // Another refresh on the same clock adds to what it covered; a new clock starts over.
      if (mem.refreshedFor !== clock || mem.covered === null) mem.covered = new Set()
      for (const s of held) mem.covered.add(s)
      mem.refreshedFor = clock
      for (const s of failedNow) mem.failed.add(s)
      if (universe === 'h')
        try {
          sessionStorage.setItem(HOUSEHOLD_KEY, clock)
        } catch {
          // Storage blocked: the memory still holds for this page.
        }
    },
  }
}
