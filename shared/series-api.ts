// The series contract: every trend Scarab can draw, addressed by a string id,
// monthly, derived from the ledger on request. The engine (engine/analytics.ts)
// implements it; charts and Compare consume it and never re-declare these types.
//
// ID grammar:
//   nw:<total|cash|brokerage|retirement|crypto|property|liabilities|equity>   — v0 (foundation)
//   inv:<all|accountId>:<value|cost|twr>  pos:<assetId>:<value|cost|twr>  set:<assetId>(+<assetId>)*:<value|cost|twr>
//   px:<assetId>  bench:<SYMBOL>  cash:<accountId>  prop:<id>:<value|equity>  liab:<id>  goal:fund  cf:<income|spend|net>
//
// Ids never contain whitespace. `set:` ids carry a literal '+', so a client
// builds the query with encodeURIComponent (a bare '+' in a query string
// decodes as a space; the engine maps it back, but don't rely on that).
//
// What each family means (v1, engine/analytics.ts):
//   - Grid: one point per month. A past month is valued at its last day; the
//     current month as of today. Same cutoffs as net worth.
//   - Range: a series runs from the month of its own first fact through this
//     month, with no gaps. cash:<id> and goal:fund run over the net-worth
//     months instead, because opening balances are undated.
//   - inv:all = every lots-tracked account together. Its current month equals
//     GET /api/portfolio totals.value (…:value) and totals.cost (…:cost).
//   - inv:<id> for a balance-tracked account (a 401(k) updated by hand) is its
//     snapshots, value only. inv:<id>:cost there comes back as a warning.
//   - pos:<assetId> sums one asset across accounts. set:A+B is exactly
//     pos:A + pos:B. Sets are not listed in the catalog; compose them from
//     pos:* ids. A set naming an asset that is no longer held is a warning.
//   - `est: true` on a value point: some holding had no price by that month end
//     and is carried at cost. Cost points are never estimates.
//   - px:<assetId> is the month-end close from the quote table, in
//     cents_per_share, from the first priced month.
//   - liab:<id> is negative, as it enters net worth (like nw:liabilities).
//     prop:<id>:equity = the property's value + its own liabilities.
//   - cf:* are flows (kind 'flow'): income and spend (positive), and
//     net = income − spend. Transfers are excluded; empty months are 0.
//     Same definition as the Cash screen's bars (GET /api/cashflow/monthly):
//     a refund nets against its expense category instead of counting as income.
//
// Performance (A6):
//   - inv:<all|accountId>:twr, pos:<assetId>:twr, set:<a>+<b>…:twr are
//     time-weighted return indexes, unit 'index_micro' (1_000_000 = 100). They
//     measure price moves only: buys and sales are flows, so buying more is not
//     a gain and selling is not a loss. Monthly Modified Dietz, chain-linked:
//     exact when trades fall at month ends or prices are flat; within a month a
//     trade is assumed to earn the month's return pro rata to its days.
//   - Base: 1_000_000 just before the scope's first trade, so the first point
//     already carries the first (partial) month. Same range as :value.
//   - Only priced value counts. A holding joins the index from its first
//     month end with a market price; months that leave part of the scope out
//     are `est: true`. When under 90% of the value in the requested window had
//     a market price, every point is `v: null` and SeriesResponse.warnings
//     carries the reason (`<id>: only N% of the value in these months had a
//     market price; …`). The same test over the whole history sets the catalog
//     entry's `available`/`reason`. Narrowing the window can bring it back.
//   - The index itself doesn't depend on the window; only whether it is shown.
//   - inv:* labels read "(securities only)": a sale's proceeds leave the scope,
//     because brokerage cash isn't tracked yet (the B12 cash anchor). Holdings
//     (pos:, set:) are securities anyway. A balance-tracked account has no :twr
//     (a warning). Set ids aren't in the catalog; compose them from pos:*.
//   - A starting position ('Opening position' trades, or a buy acquired before
//     it was recorded) enters at its market value on its as-of day — a close at
//     most a week old — not at its historical cost.
//   - bench:<SYMBOL> is a market price as the same kind of index: 1_000_000 at
//     its first month, then close ÷ first close. Price only (no dividends; :twr
//     has none either). SYMBOL is upper-case Yahoo spelling (SPY, BRK-B, ^GSPC,
//     BTC); BRK.B is not an id. Closes come from the shared market history when
//     the server has it, and from the household's own price tables for a symbol
//     it holds or held. No history: an empty series, no warning; the catalog
//     lists SPY, QQQ, VTI, VXUS, AGG and BTC, greyed out until they have data.
//     While the server is still building the market history (or a tab can't
//     reach it), an empty benchmark comes back with a warning
//     `<id>: <reason>` and its catalog entry carries the same reason.
//   - Market history (A5): the series layer reads GET /api/basket/history in
//     memory. In a tab, GET /api/series/catalog (and a series request naming a
//     bench: id) fetches that file (~1.5 MB gzipped) on first use and keeps it
//     for 30 minutes, waiting at most 8 s for it; call the catalog from the
//     screens that offer benchmarks (Compare), not on every screen.
//   - To overlay performance against a benchmark, rebase both at one month
//     (Compare's Rebased mode): their own bases differ.
// Integer cents throughout (index_micro for :twr and bench:*).

export type SeriesUnit = 'cents' | 'index_micro' | 'cents_per_share'

export type SeriesMeta = {
  id: string
  label: string
  group: 'Net worth' | 'Accounts' | 'Holdings' | 'Prices' | 'Benchmarks' | 'Property' | 'Cash flow' | 'Goal'
  unit: SeriesUnit
  kind: 'level' | 'flow'
  firstMonth: string | null
  lastMonth: string | null
  /** A picker hint: false greys the entry out with `reason`. GET /api/series still answers for it. */
  available: boolean
  reason?: string
}
export type SeriesGroup = SeriesMeta['group']

export type SeriesPoint = {
  t: string // YYYY-MM, valued at month end; the current month is as of today
  v: number | null
  est?: boolean // valued at cost / no price
}

export type Series = { id: string; label: string; unit: SeriesUnit; kind: 'level' | 'flow'; points: SeriesPoint[] }

/** Unknown or deleted ids come back as warnings, never as a 400. */
export type SeriesResponse = { series: Series[]; warnings: string[] }

// GET /api/series/catalog → SeriesCatalogResponse
// GET /api/series?ids=a,b&from=YYYY-MM&to=YYYY-MM → SeriesResponse (at most MAX_SERIES_IDS ids)
export type SeriesCatalogResponse = { asOf: string; entries: SeriesMeta[] }
export const MAX_SERIES_IDS = 6

// GET /api/series/views → ChartView[]; PUT /api/series/views (the whole list).
// Stored in app_meta 'ui:chart-views', so saved views ride the vault.
// The PUT body is a JSON array. Its reply is the list as stored.
//   - `by` and `created_at` belong to the server. A new id gets the caller's
//     identity (IAP email; null in a tab with none) and the time. An id already
//     stored keeps its own. Whatever the client sends for either is ignored.
//   - Limits: at most 50 views. id: 1–64 chars of [A-Za-z0-9_-], unique.
//     name: 1–80 chars, trimmed. ids: 1–MAX_SERIES_IDS series ids, duplicates
//     dropped. from/to: optional YYYY-MM, with from ≤ to.
//   - Anything else is a 400, and nothing is written.
//   - An unchanged list writes nothing, so it never dirties a vault session.
export type ChartView = {
  id: string
  name: string
  ids: string[]
  mode: 'value' | 'rebased' | 'pct' | 'diff'
  from?: string
  to?: string
  by: string | null
  created_at: string
}

// GET /api/portfolio/returns → ReturnsResponse (engine/returns.ts). One row per
// open position (all accounts pooled, in the portfolio's order). Money-weighted:
// each open lot's cost on the day it opened, against the value today. A
// starting position pasted without its acquisition date enters at its market
// value on its as-of day instead (a close at most a week old); with no such
// close its holding has no rate (irr_micro null, priced still true).
//   - irr_micro: an annual rate when `annualized` (the oldest open lot is at
//     least 365 days old). Otherwise it is the return over the whole holding
//     period of held_days, which is never annualized. null when the holding is
//     unpriced, or when no rate exists.
//   - held_days: from the oldest open lot to as_of.
//   - unrealized_micro = unrealized / cost; null when unpriced or cost is 0.
//   - weight_micro = value / totals.value_cents.
//   - priced: false means valued at cost (as the portfolio does).
// Values, costs and totals are GET /api/portfolio's, to the cent.
// totals.irr_micro covers only the holdings that have a rate.
export type HoldingReturn = {
  asset_id: number
  symbol: string
  value_cents: number
  cost_cents: number
  unrealized_cents: number
  unrealized_micro: number | null
  irr_micro: number | null
  annualized: boolean
  held_days: number
  weight_micro: number
  priced: boolean
}
export type ReturnsResponse = {
  as_of: string
  rows: HoldingReturn[]
  totals: { value_cents: number; cost_cents: number; unrealized_cents: number; irr_micro: number | null; annualized: boolean }
}

// GET /api/charts/:symbol → ChartResponse. One held asset's price history,
// oldest first. The daily table (prices_daily: Yahoo daily history on a
// household server, basket quotes accrued day by day in a zero-knowledge tab)
// is the spine; where it doesn't reach — before its first month, or after its
// last day — the quote table (prices: refresh quotes plus monthly history)
// fills in, so a young daily history still charts the months before it.
export type PriceCoverage = {
  firstOn: string | null // first close in `closes`; null when there are none
  days: number // number of closes (distinct priced days), not a calendar span
  source: 'daily' | 'quotes' // 'quotes' when the history starts in the quote table (sparser there: monthly, until dailyFrom)
  dailyFrom: string | null // first daily close (quote rows fill in before its month and after the last daily close); null = no daily history
}
export type ChartResponse = {
  symbol: string
  kind: 'stock' | 'crypto'
  closes: { d: string; c: number }[] // d = YYYY-MM-DD, c = close in integer cents
  errors: string[]
  coverage: PriceCoverage
}

// GET /api/basket → BasketResponse (server/basket.ts). The whole shared daily
// price basket, identical for every caller; network-only (a tab fetches it and
// matches its own symbols locally). `name` is the security's name where the
// source gave one (null otherwise); `etf` is true for exchange-traded funds.
export type BasketQuoteRow = {
  symbol: string // Yahoo spelling for stocks (BRK-B), bare ticker for crypto
  kind: 'stock' | 'crypto'
  cents: number
  pricedOn: string // YYYY-MM-DD, the quote's own market day
  name: string | null
  etf: boolean
}
export type BasketResponse = {
  builtAt: string | null
  count: number
  errors: string[]
  quotes: BasketQuoteRow[]
  /** Whether the monthly market history (below) is ready, so a tab asks for it only when there is one. */
  history?: HistoryStatus
}

// GET /api/basket/history → HistoryPack (server/history-pack.ts). Month-end
// closes for the whole basket universe over ten years: the same file for every
// caller (gzip, with an ETag), network-only like the basket. While the first
// build runs there is no file yet: 202 with HistoryPending instead.
//
// Each symbol's closes are one compact array, [offset, first, Δ, Δ, …]:
// `offset` is the first close's month counted from `start`, `first` its close
// in cents, and each later entry the change in cents from the previous close
// (null = no close that month). engine/prices.ts decodeMonthly reads it.
//   - Months through `final` are Yahoo's month-end closes from the last full
//     build (split-adjusted, no dividends). Later months are the latest close
//     the daily basket has seen in that month; the newest is as of `asOf`.
//   - Keys: Yahoo spelling for stocks (BRK-B), the bare ticker for crypto.
export type HistorySeries = (number | null)[]
export type HistoryPack = {
  v: 1
  start: string // YYYY-MM, month 0 of every offset
  final: string // YYYY-MM, the last month of true month-end closes
  asOf: string // YYYY-MM-DD, the newest close in the file
  builtAt: string // ISO time the last full build finished
  stock: Record<string, HistorySeries>
  crypto: Record<string, HistorySeries>
}
export type HistoryPending = { ready: false; building: boolean; done: number; total: number; reason: string }
/** In BasketResponse: `etag` names the current file (it changes whenever the file does). */
export type HistoryStatus = { ready: boolean; etag: string | null; final: string | null; asOf: string | null }

// POST /api/prices/history → HistoryApplyResult. Writes the shared history's
// month-end closes (months through `final`) into the quote table for the
// assets this household has traded, never overwriting a close it already has.
// In a tab it runs by itself after a price refresh when a traded asset the
// basket covers has no price history yet (engine/prices.ts needsMonthlyHistory:
// no close from before its first trade and no finished-month close from then
// on; refresh quotes don't count); it is the one price write that dirties
// the tab: a big one-time import should persist. `pending`: no history file yet.
export type HistoryApplyResult = {
  written: number // rows added
  matched: number // held assets the history covers
  errors: string[] // '<SYM>: …' for assets it doesn't cover or disagrees with
  final: string | null
  pending: boolean
}
