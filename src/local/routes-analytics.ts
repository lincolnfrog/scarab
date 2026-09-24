import { getChartViews, getSeries, getSeriesCatalog, parseSeriesQuery, putChartViews, type MarketHistory } from '../../engine/analytics'
import { applyBasket, applyMonthlyHistory, getChartData, isHistoryPack, needsMonthlyHistory, packMarket } from '../../engine/prices'
import { getHoldingsReturns } from '../../engine/returns'
import type { BasketResponse, HistoryApplyResult, HistoryPack, HistoryPending } from '../../shared/series-api'
import { r, type LocalRoute } from './table'

/**
 * Prices, price charts and the series layer — the in-tab mirror of api10.ts.
 * The server fetches quotes from Yahoo and CoinGecko; a tab can't (CORS, and
 * asking for its own symbols would tell the server what it holds), so its
 * price sources are the two shared files every caller gets alike: the daily
 * basket (GET /api/basket) and the monthly market history
 * (GET /api/basket/history).
 */

/* ---------- the monthly market history, kept in memory per tab ---------- */

// Public data, so it outlives a session switch; it never enters the vault on
// its own — benchmarks read it here, and only POST /prices/history copies the
// household's own assets' months into the database.
type TabHistory = { pack: HistoryPack; market: MarketHistory }
type Cached = { at: number; settled: boolean; ok: boolean; final: string | null; pending: string | null; value: Promise<TabHistory | null> }

/** Keep a file this long before asking again (an unchanged file is a 304 from the browser cache). */
const HISTORY_TTL_MS = 30 * 60_000
/** While the server is still building (202) or unreachable, ask again after this long. */
const HISTORY_RETRY_MS = 60_000
/** A series request waits this long for the file before answering without it. */
const HISTORY_WAIT_MS = 8_000

let cached: Cached | null = null

async function fetchHistory(entry: Cached): Promise<TabHistory | null> {
  const res = await fetch('/api/basket/history')
  if (res.status === 202) {
    const body = (await res.json().catch(() => null)) as HistoryPending | null
    entry.pending = typeof body?.reason === 'string' ? body.reason : 'The server is still building the market history'
    return null
  }
  if (!res.ok) throw new Error(`market history: ${res.status} ${res.statusText}`)
  const pack: unknown = await res.json()
  if (!isHistoryPack(pack)) throw new Error('market history: malformed file')
  return { pack, market: packMarket(pack) }
}

/**
 * The tab's copy of the file: fetched once and shared by every caller until it
 * is HISTORY_TTL_MS old. Given the `final` month the basket names, it is fresh
 * exactly while it has that `final`: applying the file writes only months
 * through `final`, which change only when the server rebuilds (the daily
 * merges touch later months), so a copy with the same `final` needs no
 * refetch. null while there is none (see `historyPending`).
 */
export function tabHistory(final?: string | null): Promise<TabHistory | null> {
  const c = cached
  if (c) {
    if (!c.settled) return c.value
    const fresh = final ? c.ok && c.final === final : Date.now() - c.at < (c.ok ? HISTORY_TTL_MS : HISTORY_RETRY_MS)
    if (fresh) return c.value
  }
  const entry: Cached = { at: Date.now(), settled: false, ok: false, final: null, pending: null, value: Promise.resolve(null) }
  entry.value = fetchHistory(entry).then(
    (h) => {
      Object.assign(entry, { settled: true, ok: h !== null, final: h?.pack.final ?? null })
      return h
    },
    () => {
      Object.assign(entry, { settled: true, ok: false, pending: 'Couldn’t reach the server for market history' })
      return null
    },
  )
  cached = entry
  return entry.value
}

/** Why the tab has no market history right now; null when it has one (or hasn't asked yet). */
const historyPending = () => (cached?.settled && !cached.ok ? cached.pending : null)

/** Tests only: forget the tab's copy. */
export function forgetTabHistory() {
  cached = null
}

/** The file for a series request, waiting at most HISTORY_WAIT_MS. */
async function marketFor(): Promise<{ market?: MarketHistory; marketPending?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const h = await Promise.race([tabHistory(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), HISTORY_WAIT_MS)))])
  clearTimeout(timer)
  if (h) return { market: h.market }
  const pending = historyPending()
  return pending ? { marketPending: pending } : {}
}

const NO_HISTORY: HistoryApplyResult = { written: 0, matched: 0, errors: [], final: null, pending: true }

export const ANALYTICS: LocalRoute[] = [
  r(
    'POST',
    '/prices/refresh',
    async (c) => {
      // Which symbols matter is decided here, in the tab, after the fetch.
      const res = await fetch('/api/basket')
      if (!res.ok) throw new Error(`price basket: ${res.status} ${res.statusText}`)
      const basket = (await res.json()) as BasketResponse
      const out = applyBasket(c.db, basket)
      // An asset with no closes from before its first trade has no price
      // history to chart, and a back-dated one is valued at cost until its
      // first quote: when the server has the monthly history, fill them in
      // through POST /prices/history — its own route, so that import (unlike
      // these quotes) dirties the tab. Only for assets the basket (so the
      // file) covers, and only until the file has been applied for them
      // (needsMonthlyHistory): otherwise refreshes would download it for
      // nothing.
      const covered = new Set(Array.isArray(basket.quotes) ? basket.quotes.map((q) => `${q.kind}:${q.symbol}`) : [])
      if (basket.history?.ready && needsMonthlyHistory(c.db, c.today, { covered })) {
        await tabHistory(basket.history.final)
        const { localDispatch } = await import('../local')
        const history = (await localDispatch('POST', '/api/prices/history').catch((e: unknown) => ({
          ...NO_HISTORY,
          pending: false,
          errors: [`market history: ${e instanceof Error ? e.message : String(e)}`],
        }))) as HistoryApplyResult
        return { ...out, history }
      }
      return out
    },
    // Public, refetchable quotes: opening Investments must not create a vault
    // version. They ride along with the next real save.
    'never',
  ),
  // The shared history's month-end closes for the assets this household has
  // traded. A real import dirties the tab (it should persist); applying the
  // same file again writes nothing and leaves it clean.
  r('POST', '/prices/history', async (c) => {
    // Any good copy already in memory will do, however old: its months
    // through `final` are final. Otherwise ask (the refresh above has asked).
    const h = await (cached?.settled && cached.ok ? cached.value : tabHistory())
    return h ? applyMonthlyHistory(c.db, h.pack) : NO_HISTORY
  }),
  // No daily-history fetch in a tab: each refresh's basket quotes accrue in
  // prices_daily (applyBasket), and the quote table fills in the months before
  // that. `coverage` says how much there is and where it came from.
  r('GET', '/charts/:symbol', (c) => getChartData(c.db, c.params.symbol!, [])),

  r('GET', '/series/catalog', async (c) => getSeriesCatalog(c.db, c.today, await marketFor())),
  r('GET', '/series', async (c) => {
    const q = parseSeriesQuery({ ids: c.query.get('ids'), from: c.query.get('from'), to: c.query.get('to') })
    // Only benchmarks read the market history; nothing else waits for it.
    return getSeries(c.db, c.today, q.ids.some((id) => id.startsWith('bench:')) ? { ...q, ...(await marketFor()) } : q)
  }),
  // Saved views are household data: a real change dirties the tab and rides
  // the vault; re-saving an unchanged list writes nothing, so it doesn't.
  r('GET', '/series/views', (c) => getChartViews(c.db)),
  r('PUT', '/series/views', (c) => putChartViews(c.db, c.body, { by: c.identity, now: new Date().toISOString() })),

  r('GET', '/portfolio/returns', (c) => getHoldingsReturns(c.db, c.today)),
]
