import { addMonthsToMonth, monthEndIso } from '../shared/dates'
import { addDaysIso } from '../shared/dates'
import type { MarketKind } from '../shared/buckets'
import type { ChartResponse, DailyBucket, DailySeries, HistoryApplyResult, HistoryPack, HistorySeries, SparksResponse } from '../shared/series-api'
import type { MarketHistory } from './analytics'
import type { DbLike } from './db'
import { bad, isoDay, notFound } from './errors'

/**
 * Prices as the engine stores and reads them: quotes in, per-asset closes out.
 * Fetching stays with the caller (the server's Yahoo/CoinGecko clients, or the
 * shared basket in a zero-knowledge tab); engine/services.ts re-exports this.
 *
 * Two tables, both facts about the market rather than derived numbers:
 *   prices        one close per asset per day it was quoted — refreshes, plus
 *                 monthly history (month-end closes). Valuation reads this.
 *                 A refresh's row also keeps the previous session's close the
 *                 source reported with it (`prev_close_cents`): what the day's
 *                 gain or loss is measured from (engine/invest.ts).
 *   prices_daily  a daily close series for the price chart — Yahoo's daily
 *                 history on a household server; in a tab, which can't reach
 *                 Yahoo, each day's basket quote accrues here instead.
 */

/** `prevCents`: the previous session's close as the source reported it with this quote, when it did. */
type Quote = { symbol: string; cents: number; pricedOn: string; prevCents?: number | null }
type PriceTable = 'prices' | 'prices_daily'

// An identical close is left alone rather than rewritten: a refresh that
// brings nothing new then changes no rows, so the tab's data revision (and
// everything keyed on it, like Future's cached compare) stays put.
// A quote that brings no previous close (history, a hand-entered price) keeps
// the one the day's row already has.
const UPSERT: Record<PriceTable, string> = {
  prices: `INSERT INTO prices (asset_id, priced_on, close_cents, prev_close_cents) VALUES (?, ?, ?, ?)
     ON CONFLICT (asset_id, priced_on) DO UPDATE SET close_cents = excluded.close_cents,
       prev_close_cents = COALESCE(excluded.prev_close_cents, prev_close_cents)
     WHERE close_cents IS NOT excluded.close_cents
        OR (excluded.prev_close_cents IS NOT NULL AND prev_close_cents IS NOT excluded.prev_close_cents)`,
  prices_daily: `INSERT INTO prices_daily (asset_id, priced_on, close_cents) VALUES (?, ?, ?)
     ON CONFLICT (asset_id, priced_on) DO UPDATE SET close_cents = excluded.close_cents
     WHERE close_cents IS NOT excluded.close_cents`,
}

/* ---------- per-symbol flags ---------- */

/**
 * The app_meta flags the price fetchers keep per symbol, spelled in one place
 * so that removing a symbol (engine/invest.ts dropOrphanAssets) clears exactly
 * what they set. A flag left behind outlives its asset: the same symbol added
 * back later would be treated as already fetched and never get its history.
 *
 *   backfillDone    monthly history is in (server/prices.ts backfillMonthlyHistory)
 *   backfillFailed  the day the last backfill attempt came back empty
 *   dailyFetched    the day daily chart history was last fetched (server/charts.ts)
 */
export const priceFlags = {
  backfillDone: (symbol: string) => `backfilled:v2:${symbol}`,
  backfillFailed: (symbol: string) => `backfill_failed:${symbol}`,
  dailyFetched: (symbol: string) => `daily:v2:${symbol}`,
} as const

/** The pre-v2 backfill flag. Nothing sets it any more, but older databases still carry it. */
const LEGACY_BACKFILL_FLAG = (symbol: string) => `backfilled:${symbol}`

/** Every per-symbol price flag, the legacy one included: what removing a symbol clears. */
export const priceFlagKeys = (symbol: string): string[] => [
  LEGACY_BACKFILL_FLAG(symbol),
  ...Object.values(priceFlags).map((key) => key(symbol)),
]

/* ---------- quotes ---------- */

export function upsertPrices(db: DbLike, quotes: Quote[]) {
  const assets = db.prepare('SELECT id, symbol FROM assets').all() as { id: number; symbol: string }[]
  const byId = new Map(assets.map((a) => [a.symbol, a.id]))
  const upsert = db.prepare(UPSERT.prices)
  let updated = 0
  for (const q of quotes) {
    const id = byId.get(q.symbol)
    if (!id) continue
    upsert.run(id, q.pricedOn, q.cents, usablePrev(q.prevCents))
    updated++
  }
  return updated
}

/** The shared daily basket as served by GET /api/basket (server/basket.ts); extra fields are ignored. */
export type BasketInput = {
  builtAt: string | null
  quotes: { symbol: string; kind: 'stock' | 'crypto'; cents: number; pricedOn: string; prevCents?: number | null }[]
}

/**
 * Price this household's assets from the shared daily basket (server/basket.ts).
 * The basket is the same list for everyone; the matching happens here, on the
 * engine's side of the seam, so in a zero-knowledge session the symbols never
 * leave the tab. Stocks match on Yahoo spelling (BRK.B → BRK-B), crypto on
 * the bare ticker.
 *
 * Each matched quote is written to both tables: to `prices` for valuation
 * (with the previous close the basket carries for it, for the day's change), and
 * to `prices_daily`, where a tab's chart history builds up one day per visit
 * (it has no other daily source). Re-applying the same basket is a no-op in
 * effect: both are upserts keyed on (asset, day).
 */
export function applyBasket(db: DbLike, basket: BasketInput) {
  const assets = db.prepare('SELECT id, symbol, kind FROM assets').all() as { id: number; symbol: string; kind: 'stock' | 'crypto' }[]
  if (assets.length === 0) return { updated: 0, backfilled: 0, errors: ['no assets yet — record a trade first'], basketBuiltAt: basket.builtAt }
  if (basket.quotes.length === 0)
    return { updated: 0, backfilled: 0, errors: ['the price basket is empty — rebuild it from Data & Vault, or wait for today’s build'], basketBuiltAt: basket.builtAt }
  const byKey = new Map(basket.quotes.map((q) => [`${q.kind}:${q.symbol}`, q]))
  const matched: { assetId: number; cents: number; pricedOn: string; prev: number | null }[] = []
  const errors: string[] = []
  for (const a of assets) {
    const key = `${a.kind}:${a.kind === 'stock' ? a.symbol.toUpperCase().replace(/\./g, '-') : a.symbol.toUpperCase()}`
    const q = byKey.get(key)
    if (q && isUsableQuote(q)) matched.push({ assetId: a.id, cents: q.cents, pricedOn: q.pricedOn, prev: usablePrev(q.prevCents) })
    else errors.push(q ? `${a.symbol}: malformed quote in today’s basket` : `${a.symbol}: not in today’s basket`)
  }
  if (matched.length > 0) {
    const toPrices = db.prepare(UPSERT.prices)
    const toDaily = db.prepare(UPSERT.prices_daily)
    db.transaction(() => {
      for (const m of matched) {
        toPrices.run(m.assetId, m.pricedOn, m.cents, m.prev)
        toDaily.run(m.assetId, m.pricedOn, m.cents)
      }
    })()
  }
  return { updated: matched.length, backfilled: 0, errors, basketBuiltAt: basket.builtAt }
}

/** The basket crosses a network boundary into the tab: take only well-formed rows. */
const isUsableQuote = (q: { cents: unknown; pricedOn: unknown }) =>
  Number.isSafeInteger(q.cents) && (q.cents as number) > 0 && typeof q.pricedOn === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(q.pricedOn)

/** A previous close worth keeping: positive integer cents, else none. */
const usablePrev = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)

/* ---------- charts (reads only — fetching stays with the caller) ---------- */

/** One day's close, as the chart draws it. */
export type DayClose = { d: string; c: number }

/**
 * One asset's price history for the chart: a daily spine, with the quote
 * table filling in where it doesn't reach — the months before its first close
 * (monthly history may go back years) and any days after its last. The spine
 * is the daily table (Yahoo's daily history on a household server; in a tab,
 * each day's basket quote accrued), joined by `market` when the caller has
 * it: the shared daily bucket's closes for this symbol (two years, the same
 * for everyone — src/local/routes-analytics.ts fetches the bucket its symbol
 * falls in). Where both have a day the bucket's close wins, so the line is
 * Yahoo's adjusted series rather than a quote caught mid-day. Quote rows in
 * the spine's first month are left out: that month is the spine's, and an old
 * monthly row there would be dated at the month's open. No spine at all →
 * the quote table alone.
 */
export function getChartData(db: DbLike, symbolRaw: string, errors: string[] = [], market: readonly DayClose[] | null = null): ChartResponse {
  const symbol = symbolRaw.toUpperCase()
  const asset = db.prepare('SELECT id, symbol, kind FROM assets WHERE symbol = ?').get(symbol) as
    | { id: number; symbol: string; kind: 'stock' | 'crypto' }
    | undefined
  if (!asset) notFound('no such asset')
  const own = db
    .prepare('SELECT priced_on AS d, close_cents AS c FROM prices_daily WHERE asset_id = ? ORDER BY priced_on')
    .all(asset.id) as DayClose[]
  const daily = market && market.length > 0 ? joinDaily(market, own) : own
  const quotesWhere = (cond: string, bound: string) =>
    db
      .prepare(`SELECT priced_on AS d, close_cents AS c FROM prices WHERE asset_id = ? AND priced_on ${cond} ? ORDER BY priced_on`)
      .all(asset.id, bound) as DayClose[]
  let closes: DayClose[]
  let fromQuotes: boolean // does the history's start come from the quote table?
  if (daily.length === 0) {
    closes = quotesWhere('>=', '')
    fromQuotes = closes.length > 0
  } else {
    const before = quotesWhere('<', `${daily[0]!.d.slice(0, 7)}-01`)
    // Refresh quotes newer than the last daily close: same density, just fresher.
    const after = quotesWhere('>', daily[daily.length - 1]!.d)
    closes = [...before, ...daily, ...after]
    fromQuotes = before.length > 0
  }
  return {
    symbol,
    kind: asset.kind,
    closes,
    errors,
    coverage: {
      firstOn: closes[0]?.d ?? null,
      days: closes.length,
      source: fromQuotes ? 'quotes' : 'daily',
      dailyFrom: daily[0]?.d ?? null,
    },
  }
}

/** Two ascending daily series as one, a day at a time; where both have a day, `market`'s close. */
function joinDaily(market: readonly DayClose[], own: readonly DayClose[]): DayClose[] {
  const out: DayClose[] = []
  let i = 0
  let j = 0
  while (i < market.length || j < own.length) {
    const m = market[i]
    const o = own[j]
    if (m && (!o || m.d <= o.d)) {
      out.push(m)
      i++
      if (o && o.d === m.d) j++
    } else {
      out.push(o!)
      j++
    }
  }
  return out
}

/** How far back a holdings sparkline looks. */
export const SPARK_DAYS = 90

/**
 * Each traded asset's closes over the last SPARK_DAYS, oldest first — the
 * Holdings table's sparklines (GET /api/portfolio/sparks). Both price tables
 * together, one close per day: where they share a day the quote table's wins
 * (it is what the holding is valued at, so the line ends on the price shown).
 * Reads only what is stored — however sparse; nothing is fetched for it.
 */
export function getRecentCloses(db: DbLike, today: string): SparksResponse {
  const from = addDaysIso(today, -SPARK_DAYS)
  const rows = db
    .prepare(
      `SELECT asset_id, priced_on AS d, close_cents AS c FROM prices WHERE priced_on >= ? AND priced_on <= ?
       UNION ALL
       SELECT asset_id, priced_on, close_cents FROM prices_daily pd WHERE priced_on >= ? AND priced_on <= ?
         AND NOT EXISTS (SELECT 1 FROM prices p WHERE p.asset_id = pd.asset_id AND p.priced_on = pd.priced_on)
       ORDER BY asset_id, d`,
    )
    .all(from, today, from, today) as { asset_id: number; d: string; c: number }[]
  const series: SparksResponse['series'] = []
  for (const r of rows) {
    const last = series[series.length - 1]
    if (last && last.asset_id === r.asset_id) last.closes.push({ d: r.d, c: r.c })
    else series.push({ asset_id: r.asset_id, closes: [{ d: r.d, c: r.c }] })
  }
  return { from, to: today, series }
}

/* ---------- the shared monthly market history (GET /api/basket/history) ---------- */

// A zero-knowledge tab can't ask Yahoo for its own symbols' history (CORS, and
// the request would be the portfolio), so the server publishes month-end closes
// for its whole basket universe as one file, identical for everyone
// (server/history-pack.ts; wire shape: shared/series-api.ts HistoryPack). The
// tab keeps the file in memory: benchmarks read it there (packMarket) and never
// enter the vault, and only the assets this household has traded get their
// months written into its quote table (applyMonthlyHistory).

export type MonthClose = { month: string; cents: number }

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
/** More months than any history holds: a guard against a hostile offset. */
const MAX_OFFSET = 1200

/** b − a in months; both YYYY-MM. */
export function monthIndex(a: string, b: string): number {
  return (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + (Number(b.slice(5, 7)) - Number(a.slice(5, 7)))
}

/**
 * One symbol's closes → [offset, first, Δ, …] (null for a month without a
 * close). `closes` is oldest first, one per month, none before `start`, each a
 * positive integer number of cents.
 */
export function encodeMonthly(start: string, closes: readonly MonthClose[]): HistorySeries {
  const out: HistorySeries = []
  let prev: MonthClose | null = null
  for (const c of closes) {
    if (!Number.isSafeInteger(c.cents) || c.cents <= 0) throw new Error(`encodeMonthly: bad close ${c.cents} for ${c.month}`)
    const step = prev ? monthIndex(prev.month, c.month) : monthIndex(start, c.month)
    if (step < (prev ? 1 : 0)) throw new Error(`encodeMonthly: ${c.month} is out of order`)
    if (!prev) out.push(step, c.cents)
    else {
      for (let gap = step - 1; gap > 0; gap--) out.push(null)
      out.push(c.cents - prev.cents)
    }
    prev = c
  }
  return out
}

/** [offset, first, Δ, …] → closes, oldest first. null when the array is malformed (it crossed a network). */
export function decodeMonthly(start: string, enc: unknown): MonthClose[] | null {
  if (!Array.isArray(enc) || enc.length < 2 || !MONTH.test(start)) return null
  const offset: unknown = enc[0]
  const first: unknown = enc[1]
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_OFFSET) return null
  if (!Number.isSafeInteger(first) || (first as number) <= 0 || enc.length - 2 > MAX_OFFSET) return null
  // Walk the months as integers: month number n = year * 12 + (month - 1).
  let n = Number(start.slice(0, 4)) * 12 + Number(start.slice(5, 7)) - 1 + (offset as number)
  const label = (k: number) => `${String(Math.floor(k / 12)).padStart(4, '0')}-${String((k % 12) + 1).padStart(2, '0')}`
  let cents = first as number
  const out: MonthClose[] = [{ month: label(n), cents }]
  for (let i = 2; i < enc.length; i++) {
    n++
    const d: unknown = enc[i]
    if (d === null) continue
    if (!Number.isSafeInteger(d)) return null
    cents += d as number
    if (cents <= 0 || !Number.isSafeInteger(cents)) return null
    out.push({ month: label(n), cents })
  }
  return out
}

/** The file's envelope (each symbol's array is checked when it is read). */
export function isHistoryPack(x: unknown): x is HistoryPack {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const p = x as Record<string, unknown>
  const book = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b)
  return (
    p.v === 1 &&
    typeof p.start === 'string' &&
    MONTH.test(p.start) &&
    typeof p.final === 'string' &&
    MONTH.test(p.final) &&
    typeof p.asOf === 'string' &&
    isoDay.test(p.asOf) &&
    typeof p.builtAt === 'string' &&
    book(p.stock) &&
    book(p.crypto)
  )
}

/** Stocks as the basket spells them (BRK.B → BRK-B), crypto by the bare ticker. */
const marketSymbol = (a: { symbol: string; kind: 'stock' | 'crypto' }) =>
  a.kind === 'stock' ? a.symbol.toUpperCase().replace(/\./g, '-') : a.symbol.toUpperCase()

const seriesOf = (pack: HistoryPack, kind: 'stock' | 'crypto', symbol: string): MonthClose[] | null => {
  const book = pack[kind]
  return Object.hasOwn(book, symbol) ? decodeMonthly(pack.start, book[symbol]) : null
}

/**
 * The file as the series layer's MarketHistory, decoded one symbol at a time
 * on first use. Each month is dated at its last day; the month of `asOf` (still
 * in progress) at `asOf`.
 */
export function packMarket(pack: HistoryPack): MarketHistory {
  const memo = new Map<string, { on: string; cents: number }[] | null>()
  const asOfMonth = pack.asOf.slice(0, 7)
  const read = (kind: 'stock' | 'crypto', symbol: string) => {
    const key = `${kind}:${symbol}`
    if (!memo.has(key)) {
      const rows = seriesOf(pack, kind, symbol)
      memo.set(key, rows && rows.map((r) => ({ on: r.month < asOfMonth ? monthEndIso(r.month) : pack.asOf, cents: r.cents })))
    }
    return memo.get(key)!
  }
  return { closes: (symbol, kind) => (kind ? read(kind, symbol) : (read('stock', symbol) ?? read('crypto', symbol))) }
}

/** Is the file far (2× either way) from the household's own latest close, in that month or the one before? */
function disagrees(rows: MonthClose[], own: { on: string; cents: number }): boolean {
  const m = own.on.slice(0, 7)
  const before = addMonthsToMonth(m, -1)
  const near = rows.find((r) => r.month === m) ?? rows.find((r) => r.month === before)
  return !!near && (own.cents * 2 < near.cents || near.cents * 2 < own.cents)
}

/**
 * POST /api/prices/history: write the file's month-end closes (months through
 * `final`, dated at each month's last day) into `prices` for the assets this
 * household has traded — held now or before, since past months value them —
 * and for no other symbol. A close already there is never replaced (a refresh
 * quote, a hand-entered price, a household backfill), so applying the same
 * file again writes nothing and a vault session stays clean.
 *
 * An asset whose history is far from its own latest price (a coin that shares
 * a ticker, an unadjusted split) is left out and named in `errors`.
 */
export function applyMonthlyHistory(db: DbLike, pack: unknown): HistoryApplyResult {
  if (!isHistoryPack(pack)) bad('malformed market history')
  const held = db
    .prepare('SELECT id, symbol, kind FROM assets a WHERE EXISTS (SELECT 1 FROM trades t WHERE t.asset_id = a.id) ORDER BY id')
    .all() as { id: number; symbol: string; kind: 'stock' | 'crypto' }[]
  const latestOwn = db.prepare('SELECT priced_on AS "on", close_cents AS cents FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1')
  const errors: string[] = []
  const plan: { assetId: number; rows: MonthClose[] }[] = []
  for (const a of held) {
    const rows = seriesOf(pack, a.kind, marketSymbol(a))
    if (!rows) {
      errors.push(`${a.symbol}: not in the shared market history`)
      continue
    }
    const own = latestOwn.get(a.id) as { on: string; cents: number } | undefined
    if (own && disagrees(rows, own)) {
      errors.push(`${a.symbol}: the shared market history is far from this household’s own ${own.on} price, so it was left out`)
      continue
    }
    plan.push({ assetId: a.id, rows: rows.filter((r) => r.month <= pack.final) })
  }
  let written = 0
  if (plan.some((p) => p.rows.length > 0)) {
    const put = db.prepare(
      'INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?) ON CONFLICT (asset_id, priced_on) DO NOTHING',
    )
    db.transaction(() => {
      for (const p of plan) for (const r of p.rows) written += put.run(p.assetId, monthEndIso(r.month), r.cents).changes
    })()
  }
  return { written, matched: plan.length, errors, final: pack.final, pending: false }
}

/**
 * Should a refresh go on to apply the monthly history? Yes while some traded
 * asset has neither of the closes applying the file leaves behind. Such an
 * asset has no price history to chart (a starting position pasted as of
 * today, say), and if its first trade is back-dated, the months since are
 * valued at cost until a close shows up. It stops asking once it has, from
 * anywhere but a refresh:
 *
 *   · a close from before the month of its first trade — its history reaches
 *     back past the trade; or
 *   · a close at the end of a finished month, from the month of its first
 *     trade on. That is what applying the file leaves an asset it can't reach
 *     back before the trade for: a stock bought in the month it listed, or a
 *     buy from before the file's first month.
 *
 * A refresh quote doesn't count: every one is written to prices_daily as well
 * (applyBasket), and the file's closes aren't. Otherwise a position pasted on
 * the 1st, priced by the basket's quote from the last trading day of the month
 * before, would count as having history and never get it.
 *
 * Still asking after an apply that wrote nothing for it: an asset that listed
 * this month (the file has no finished month for it until next month's), and
 * one the file leaves out (not in it, or far from the household's own price;
 * see applyMonthlyHistory). The tab keeps its copy of the file while the
 * basket's `final` holds (src/local/routes-analytics.ts tabHistory), so asking
 * again within a page load downloads nothing and writes nothing. A hand-set
 * price dated at a month's end counts as the file's close.
 *
 * `covered`, when the caller has the basket (GET /api/basket) in hand, is its
 * `kind:SYMBOL` keys: an asset outside the basket isn't in the file either,
 * so without it that asset would download the file on every refresh.
 */
export function needsMonthlyHistory(db: DbLike, today: string, hints: { covered?: ReadonlySet<string> } = {}): boolean {
  const thisMonthStart = `${today.slice(0, 7)}-01`
  const firsts = db
    .prepare('SELECT a.id, a.symbol, a.kind, min(t.traded_on) AS first FROM trades t JOIN assets a ON a.id = t.asset_id GROUP BY a.id')
    .all() as { id: number; symbol: string; kind: 'stock' | 'crypto'; first: string }[]
  // A close no refresh wrote, dated before the first-trade month or at the end of a finished month after it.
  const settled = db.prepare(
    `SELECT 1 FROM prices p
      WHERE p.asset_id = ?
        AND (p.priced_on < ? OR (p.priced_on < ? AND substr(date(p.priced_on, '+1 day'), 9, 2) = '01'))
        AND NOT EXISTS (SELECT 1 FROM prices_daily d WHERE d.asset_id = p.asset_id AND d.priced_on = p.priced_on)
      LIMIT 1`,
  )
  return firsts.some((a) => {
    const firstMonthStart = `${a.first.slice(0, 7)}-01`
    if (firstMonthStart > thisMonthStart) return false // nothing dated yet
    if (hints.covered && !hints.covered.has(`${a.kind}:${marketSymbol(a)}`)) return false
    return settled.get(a.id, firstMonthStart, thisMonthStart) === undefined
  })
}

/* ---------- the shared daily history (GET /api/basket/daily/:bucket) ---------- */

// The daily companion of the monthly file: two years of daily closes for the
// basket universe, dealt into buckets by a hash of the symbol
// (shared/buckets.ts) so a tab asks for one of N files rather than for a
// symbol (server/daily-buckets.ts; wire shape: shared/series-api.ts
// DailyBucket). Same encoding idea as the monthly one, on a calendar-day axis:
// null marks a day without a close (a stock's weekends and holidays).

const DAY_MS = 86_400_000
/** More days than a daily file holds (two years is ~730): a guard against a hostile offset or length. */
const MAX_DAY_OFFSET = 4_000

/** Whole days from `start` to `day`, both YYYY-MM-DD, on the UTC calendar. */
export function dayIndex(start: string, day: string): number {
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS)
}

/** Day `n` counted from `start`. */
const dayLabel = (start: string, n: number) => new Date(Date.parse(`${start}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/**
 * One symbol's closes → [offset, first, Δ, …] (null for a day without a
 * close). `closes` is oldest first, one per day, none before `start`, each a
 * positive integer number of cents.
 */
export function encodeDaily(start: string, closes: readonly DayClose[]): DailySeries {
  const out: DailySeries = []
  let prev: DayClose | null = null
  for (const c of closes) {
    if (!Number.isSafeInteger(c.c) || c.c <= 0) throw new Error(`encodeDaily: bad close ${c.c} for ${c.d}`)
    const step = prev ? dayIndex(prev.d, c.d) : dayIndex(start, c.d)
    if (step < (prev ? 1 : 0)) throw new Error(`encodeDaily: ${c.d} is out of order`)
    if (!prev) out.push(step, c.c)
    else {
      for (let gap = step - 1; gap > 0; gap--) out.push(null)
      out.push(c.c - prev.c)
    }
    prev = c
  }
  return out
}

/** [offset, first, Δ, …] → closes, oldest first. null when the array is malformed (it crossed a network). */
export function decodeDaily(start: string, enc: unknown): DayClose[] | null {
  if (!Array.isArray(enc) || enc.length < 2 || !isoDay.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) return null
  const offset: unknown = enc[0]
  const first: unknown = enc[1]
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || (offset as number) > MAX_DAY_OFFSET) return null
  if (!Number.isSafeInteger(first) || (first as number) <= 0 || enc.length - 2 > MAX_DAY_OFFSET) return null
  let n = offset as number
  let cents = first as number
  const out: DayClose[] = [{ d: dayLabel(start, n), c: cents }]
  for (let i = 2; i < enc.length; i++) {
    n++
    const d: unknown = enc[i]
    if (d === null) continue
    if (!Number.isSafeInteger(d)) return null
    cents += d as number
    if (cents <= 0 || !Number.isSafeInteger(cents)) return null
    out.push({ d: dayLabel(start, n), c: cents })
  }
  return out
}

/** A bucket file's envelope (each symbol's array is checked when it is read). */
export function isDailyBucket(x: unknown): x is DailyBucket {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false
  const p = x as Record<string, unknown>
  const book = (b: unknown) => !!b && typeof b === 'object' && !Array.isArray(b)
  return (
    p.v === 1 &&
    Number.isInteger(p.of) &&
    (p.of as number) > 0 &&
    Number.isInteger(p.bucket) &&
    (p.bucket as number) >= 0 &&
    (p.bucket as number) < (p.of as number) &&
    typeof p.start === 'string' &&
    isoDay.test(p.start) &&
    typeof p.asOf === 'string' &&
    isoDay.test(p.asOf) &&
    typeof p.builtAt === 'string' &&
    book(p.stock) &&
    book(p.crypto)
  )
}

/** One symbol's closes from a bucket file (the basket's spelling), or null when the file has none. */
export function bucketCloses(file: DailyBucket, kind: MarketKind, symbol: string): DayClose[] | null {
  const book = file[kind]
  return Object.hasOwn(book, symbol) ? decodeDaily(file.start, book[symbol]) : null
}
