import type { DbLike } from '../engine/db'
import { priceFlags } from '../engine/prices'
import { addDaysIso, monthEndIso } from '../shared/dates'
import { upstreamSignal } from './upstream'

export type Quote = { symbol: string; cents: number; pricedOn: string }
export type QuoteResult = { quotes: Quote[]; errors: string[] }

/**
 * Stocks/ETFs: Yahoo Finance v8 chart endpoint — free, no key, one call per
 * symbol. (Stooq's CSV quote API died behind bot protection in 2026.)
 * External API boundary: quotes arrive as floats; they are converted to
 * integer cents here, once, and stay integers everywhere after.
 */
export function parseYahooMeta(
  symbol: string,
  body: unknown,
): { cents: number; pricedOn: string } | { error: string } {
  const meta = (body as { chart?: { result?: { meta?: { regularMarketPrice?: number; regularMarketTime?: number } }[] } })
    ?.chart?.result?.[0]?.meta
  const px = meta?.regularMarketPrice
  if (typeof px !== 'number' || !Number.isFinite(px) || px <= 0) return { error: `${symbol}: no quote from Yahoo` }
  const t = meta?.regularMarketTime
  const pricedOn = (typeof t === 'number' ? new Date(t * 1000) : new Date()).toISOString().slice(0, 10)
  return { cents: Math.round(px * 100), pricedOn }
}

export async function fetchStockQuotes(symbols: string[], f: typeof fetch = fetch): Promise<QuoteResult> {
  const quotes: Quote[] = []
  const errors: string[] = []
  await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.toUpperCase())}?interval=1d&range=1d`
        const r = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (scarab household finance)' }, signal: upstreamSignal() })
        if (!r.ok) {
          errors.push(`${symbol}: Yahoo HTTP ${r.status}`)
          return
        }
        const parsed = parseYahooMeta(symbol.toUpperCase(), await r.json())
        if ('error' in parsed) errors.push(parsed.error)
        else quotes.push({ symbol: symbol.toUpperCase(), ...parsed })
      } catch (e) {
        errors.push(`${symbol}: ${e instanceof Error ? e.message : 'fetch failed'}`)
      }
    }),
  )
  return { quotes, errors }
}

/** Symbol → CoinGecko id for the coins a household portfolio plausibly holds. */
const COINGECKO_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  ADA: 'cardano',
  DOGE: 'dogecoin',
  LTC: 'litecoin',
  XRP: 'ripple',
  DOT: 'polkadot',
  AVAX: 'avalanche-2',
  LINK: 'chainlink',
}

export async function fetchCryptoQuotes(symbols: string[], f: typeof fetch = fetch): Promise<QuoteResult> {
  const errors: string[] = []
  const ids: string[] = []
  const bySymbol = new Map<string, string>()
  for (const sym of symbols) {
    const id = COINGECKO_IDS[sym.toUpperCase()]
    if (!id) {
      errors.push(`${sym}: not in the CoinGecko symbol map (server/prices.ts)`)
      continue
    }
    ids.push(id)
    bySymbol.set(id, sym.toUpperCase())
  }
  if (ids.length === 0) return { quotes: [], errors }
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`
  let body: Record<string, { usd?: number }>
  try {
    const r = await f(url, { signal: upstreamSignal() })
    if (!r.ok) return { quotes: [], errors: [...errors, `coingecko: HTTP ${r.status}`] }
    body = (await r.json()) as Record<string, { usd?: number }>
  } catch (e) {
    // A timeout or a dead network is this source's error, as for the stock quotes — not the whole refresh's.
    return { quotes: [], errors: [...errors, `coingecko: ${e instanceof Error ? e.message : 'fetch failed'}`] }
  }
  const today = new Date().toISOString().slice(0, 10)
  const quotes: Quote[] = []
  for (const [id, sym] of bySymbol) {
    const usd = body[id]?.usd
    if (typeof usd === 'number' && Number.isFinite(usd)) {
      quotes.push({ symbol: sym, cents: Math.round(usd * 100), pricedOn: today })
    } else errors.push(`${sym}: no USD quote from CoinGecko`)
  }
  return { quotes, errors }
}

/* ---------------- historical backfill ---------------- */

const utcToday = () => new Date().toISOString().slice(0, 10)

/** Unix seconds → YYYY-MM-DD in the exchange's own zone (historical DST included); UTC when the zone is unknown. */
export function exchangeDay(t: number, timeZone: string | undefined): string {
  const d = new Date(t * 1000)
  if (timeZone) {
    try {
      // en-CA formats as YYYY-MM-DD.
      return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
    } catch {
      /* unknown zone name: fall through to UTC */
    }
  }
  return d.toISOString().slice(0, 10)
}

/**
 * Yahoo chart history → closes. Crypto uses SYM-USD.
 *
 * Daily bars (the default) are dated by their timestamp's UTC day.
 *
 * Monthly bars (`monthly: true`) carry the month's LAST close but are
 * timestamped at the month's OPEN, so dating them by timestamp put each close
 * a month early (bug #57). Each bar is stamped at its month's end instead — or
 * at `today` for the month still in progress — with the month read in the
 * exchange's zone (a bar stamped at local midnight can be the previous day in
 * UTC). When two bars land on one stamp (Yahoo sometimes appends a live bar
 * for the current month), the later one wins.
 */
export function parseYahooHistory(
  symbol: string,
  body: unknown,
  opts: { monthly?: boolean; today?: string } = {},
): Quote[] {
  const result = (
    body as {
      chart?: {
        result?: {
          meta?: { exchangeTimezoneName?: string }
          timestamp?: number[]
          indicators?: { quote?: { close?: (number | null)[] }[] }
        }[]
      }
    }
  )?.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const closes = result?.indicators?.quote?.[0]?.close ?? []
  const today = opts.today ?? utcToday()
  const tz = result?.meta?.exchangeTimezoneName
  const out = new Map<string, Quote>()
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    const t = ts[i]
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || typeof t !== 'number' || !Number.isFinite(t)) continue
    let pricedOn: string
    if (opts.monthly) {
      const monthEnd = monthEndIso(exchangeDay(t, tz).slice(0, 7))
      pricedOn = monthEnd < today ? monthEnd : today
    } else pricedOn = new Date(t * 1000).toISOString().slice(0, 10)
    out.delete(pricedOn) // keep date order when a later bar replaces an earlier one
    out.set(pricedOn, { symbol, cents: Math.round(c * 100), pricedOn })
  }
  return [...out.values()]
}

export async function fetchHistory(
  symbol: string,
  kind: 'stock' | 'crypto',
  f: typeof fetch = fetch,
  today: string = utcToday(),
): Promise<QuoteResult> {
  const ySym = kind === 'crypto' ? `${symbol.toUpperCase()}-USD` : symbol.toUpperCase()
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1mo&range=max`
    const r = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (scarab household finance)' }, signal: upstreamSignal() })
    if (!r.ok) return { quotes: [], errors: [`${symbol}: Yahoo history HTTP ${r.status}`] }
    const quotes = parseYahooHistory(symbol.toUpperCase(), await r.json(), { monthly: true, today })
    return quotes.length > 0 ? { quotes, errors: [] } : { quotes: [], errors: [`${symbol}: no history from Yahoo`] }
  } catch (e) {
    return { quotes: [], errors: [`${symbol}: ${e instanceof Error ? e.message : 'history fetch failed'}`] }
  }
}

/**
 * Household-mode monthly backfill, once per asset: without it, months before
 * the first refresh value positions at cost and the net-worth chart jumps.
 * Its app_meta flags are spelled by engine/prices.ts priceFlags, so removing a
 * symbol clears exactly these:
 *
 *   backfilled:v2:<SYM>   done (a timestamp). v2 = month-end stamping; the
 *                         old `backfilled:<SYM>` flag no longer counts, so each
 *                         asset refetches once. Month-open rows written before
 *                         v2 are left as they are.
 *   backfill_failed:<SYM> the day the last attempt got nothing. Tried again
 *                         once that is BACKFILL_RETRY_DAYS old — not on every
 *                         refresh, which hammered Yahoo forever (bug #28).
 *
 * Writes go through `upsert` (the caller's engine function), in one
 * transaction per asset, together with the flag.
 */
export const BACKFILL_RETRY_DAYS = 7

export async function backfillMonthlyHistory(
  db: DbLike,
  assets: { symbol: string; kind: 'stock' | 'crypto' }[],
  upsert: (db: DbLike, quotes: Quote[]) => number,
  opts: { today?: string; fetchHistory?: typeof fetchHistory } = {},
): Promise<{ backfilled: number; errors: string[]; skipped: string[] }> {
  const today = opts.today ?? utcToday()
  const fetchOne = opts.fetchHistory ?? fetchHistory
  const get = db.prepare('SELECT value FROM app_meta WHERE key = ?')
  const set = db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
  const clear = db.prepare('DELETE FROM app_meta WHERE key = ?')
  const errors: string[] = []
  const skipped: string[] = []
  let backfilled = 0
  for (const a of assets) {
    const done = priceFlags.backfillDone(a.symbol)
    const failed = priceFlags.backfillFailed(a.symbol)
    if (get.get(done)) continue
    const failedOn = (get.get(failed) as { value: string } | undefined)?.value
    if (failedOn && today < addDaysIso(failedOn, BACKFILL_RETRY_DAYS)) {
      skipped.push(a.symbol)
      continue
    }
    const h = await fetchOne(a.symbol, a.kind, fetch, today)
    errors.push(...h.errors)
    if (h.quotes.length === 0) {
      set.run(failed, today)
      continue
    }
    db.transaction(() => {
      upsert(db, h.quotes)
      set.run(done, new Date().toISOString())
      clear.run(failed)
    })()
    backfilled += h.quotes.length
  }
  return { backfilled, errors, skipped }
}
