import type { DbLike } from '../engine/db'
import { addDaysIso } from '../shared/dates'
import type { BasketQuoteRow, BasketResponse } from '../shared/series-api'
import { appendToHistory, historyStatus } from './history-pack'
import { upstreamSignal } from './upstream'

/**
 * The daily price basket: every US-listed stock and ETF plus the top crypto
 * assets, quoted once a day and served as ONE list that is identical for
 * every caller. A zero-knowledge session downloads the whole basket and
 * picks its own symbols out locally, so the server learns nothing about
 * what anyone holds — not even which tickers were looked up. (Contrast a
 * per-symbol proxy, whose request stream is the portfolio.)
 *
 * Sources (all keyless):
 *   universe  NASDAQ Trader symbol directory — nasdaqlisted.txt (NASDAQ) and
 *             otherlisted.txt (NYSE, NYSE American, Arca, BATS, IEX).
 *   quotes    Yahoo v8 spark, batched (no crumb needed); v7 quote with a
 *             crumb+cookie as the fallback.
 *   crypto    CoinGecko /coins/markets, top 500 by market cap.
 *
 * The build is best-effort: a failed source leaves yesterday's rows in
 * place and reports why, and the UI shows the basket's age.
 *
 * Each row also carries the security's name and whether it is an ETF (from
 * the symbol directory; CoinGecko's name for crypto), so a symbol search in
 * the tab can say "Vanguard Total Stock Market ETF" rather than just VTI.
 */

/** A quote as fetched. `name`/`etf` are filled in where the source knows them. */
export type BasketQuote = { symbol: string; kind: 'stock' | 'crypto'; cents: number; pricedOn: string; name?: string | null; etf?: boolean }
export type Listing = { symbol: string; name: string; etf: boolean }

const UA = { 'user-agent': 'Mozilla/5.0 (scarab price basket)' }
export const NASDAQ_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'
export const OTHER_LISTED_URL = 'https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'

/* ---------------- universe ---------------- */

/** Yahoo spells class shares and units with a dash: BRK.B → BRK-B. */
export const toYahooSymbol = (s: string) => s.trim().toUpperCase().replace(/\./g, '-')

/**
 * The directory's security names, minus the share-type boilerplate:
 * "Apple Inc. - Common Stock" → "Apple Inc.", "Alphabet Inc. - Class A Common
 * Stock" → "Alphabet Inc. Class A", "Berkshire Hathaway Inc. New Common Stock"
 * → "Berkshire Hathaway Inc.". A share class or series is kept; anything that
 * doesn't end in one of these suffixes is kept as written.
 */
const SHARE_SUFFIX =
  /^(.*?)(?:\s*-\s*|\s+)(?:New\s+)?(?:((?:Class|Series) [A-Z0-9]+)\s+)?(?:New\s+)?(?:Common Stock|Common Shares|Ordinary Shares|Capital Stock|American Deposit[ao]ry Shares)$/i
const ADR_TAIL = /\s*-?\s*American Deposit[ao]ry Shares?,? each represent.*$/i
export function cleanSecurityName(raw: string): string {
  const s = raw.trim().replace(/\s+/g, ' ').replace(ADR_TAIL, '') || raw.trim()
  const m = SHARE_SUFFIX.exec(s)
  if (!m || !m[1]) return s
  return m[2] ? `${m[1]} ${m[2]}` : m[1]
}

const SKIP_NAME = /\b(warrants?|units?|rights?|preferred|depositary shares?, each representing .* preferred|notes? due)\b/i

/** Pipe-delimited NASDAQ Trader directory → listings. Handles both files by header. */
export function parseSymbolDirectory(text: string): Listing[] {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('File Creation Time'))
  if (lines.length < 2) return []
  const header = lines[0]!.split('|').map((h) => h.trim())
  const col = (name: string) => header.indexOf(name)
  const iSym = col('ACT Symbol') >= 0 ? col('ACT Symbol') : col('Symbol')
  const iName = col('Security Name')
  const iTest = col('Test Issue')
  const iEtf = col('ETF')
  if (iSym < 0 || iName < 0) return []
  const out: Listing[] = []
  for (const line of lines.slice(1)) {
    const f = line.split('|')
    const raw = f[iSym]?.trim() ?? ''
    if (!raw || (iTest >= 0 && f[iTest]?.trim() === 'Y')) continue
    if (raw.includes('$')) continue // preferred series: BAC$B
    const name = f[iName]?.trim() ?? ''
    if (SKIP_NAME.test(name)) continue
    out.push({ symbol: toYahooSymbol(raw), name: cleanSecurityName(name), etf: f[iEtf]?.trim() === 'Y' })
  }
  return out
}

export async function fetchUniverse(f: typeof fetch = fetch): Promise<{ listings: Listing[]; errors: string[] }> {
  const errors: string[] = []
  const seen = new Set<string>()
  const listings: Listing[] = []
  for (const url of [NASDAQ_LISTED_URL, OTHER_LISTED_URL]) {
    try {
      const r = await f(url, { headers: UA, signal: upstreamSignal() })
      if (!r.ok) {
        errors.push(`universe: ${url.split('/').pop()} HTTP ${r.status}`)
        continue
      }
      for (const l of parseSymbolDirectory(await r.text()))
        if (!seen.has(l.symbol)) {
          seen.add(l.symbol)
          listings.push(l)
        }
    } catch (e) {
      errors.push(`universe: ${e instanceof Error ? e.message : 'fetch failed'}`)
    }
  }
  return { listings, errors }
}

/* ---------------- quotes ---------------- */

const day = (t: unknown) => (typeof t === 'number' ? new Date(t * 1000) : new Date()).toISOString().slice(0, 10)
const cents = (px: unknown) => (typeof px === 'number' && Number.isFinite(px) && px > 0 ? Math.round(px * 100) : null)

/** Yahoo v8 spark: { spark: { result: [{ symbol, response: [{ meta: { regularMarketPrice, regularMarketTime } }] }] } } */
export function parseSpark(body: unknown): BasketQuote[] {
  const results = (body as { spark?: { result?: { symbol?: string; response?: { meta?: Record<string, unknown> }[] }[] } })
    ?.spark?.result
  if (!Array.isArray(results)) return []
  const out: BasketQuote[] = []
  for (const r of results) {
    const meta = r.response?.[0]?.meta
    const c = cents(meta?.regularMarketPrice)
    if (!r.symbol || c === null) continue
    out.push({ symbol: r.symbol, kind: 'stock', cents: c, pricedOn: day(meta?.regularMarketTime) })
  }
  return out
}

/** Yahoo v7 quote: { quoteResponse: { result: [{ symbol, regularMarketPrice, regularMarketTime }] } } */
export function parseV7Quotes(body: unknown): BasketQuote[] {
  const results = (body as { quoteResponse?: { result?: Record<string, unknown>[] } })?.quoteResponse?.result
  if (!Array.isArray(results)) return []
  const out: BasketQuote[] = []
  for (const r of results) {
    const c = cents(r.regularMarketPrice)
    if (typeof r.symbol !== 'string' || c === null) continue
    out.push({ symbol: r.symbol, kind: 'stock', cents: c, pricedOn: day(r.regularMarketTime) })
  }
  return out
}

/** CoinGecko /coins/markets: [{ symbol: 'btc', current_price, last_updated }] — first (largest) wins on symbol clashes. */
export function parseCoinGeckoMarkets(body: unknown, seen = new Set<string>()): BasketQuote[] {
  if (!Array.isArray(body)) return []
  const out: BasketQuote[] = []
  for (const r of body as Record<string, unknown>[]) {
    const sym = typeof r.symbol === 'string' ? r.symbol.toUpperCase() : ''
    const c = cents(r.current_price)
    if (!sym || c === null || seen.has(sym)) continue
    seen.add(sym)
    const on = typeof r.last_updated === 'string' ? r.last_updated.slice(0, 10) : new Date().toISOString().slice(0, 10)
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    out.push({ symbol: sym, kind: 'crypto', cents: c, pricedOn: on, ...(name ? { name } : {}) })
  }
  return out
}

async function sparkBatch(symbols: string[], f: typeof fetch): Promise<BasketQuote[] | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=1d`
  const r = await f(url, { headers: UA, signal: upstreamSignal() })
  if (!r.ok) return null
  const q = parseSpark(await r.json())
  return q.length > 0 ? q : null
}

/** Yahoo's v7 quote endpoint wants a session cookie and a crumb minted from it. */
async function yahooCrumb(f: typeof fetch): Promise<{ cookie: string; crumb: string } | null> {
  try {
    const c = await f('https://fc.yahoo.com', { headers: UA, redirect: 'manual', signal: upstreamSignal() })
    const set = (c.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [c.headers.get('set-cookie') ?? '']
    const cookie = set
      .map((s) => s.split(';')[0]!)
      .filter(Boolean)
      .join('; ')
    if (!cookie) return null
    const r = await f('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: { ...UA, cookie }, signal: upstreamSignal() })
    if (!r.ok) return null
    const crumb = (await r.text()).trim()
    return crumb && !crumb.includes('<') ? { cookie, crumb } : null
  } catch {
    return null
  }
}

async function v7Batch(symbols: string[], auth: { cookie: string; crumb: string }, f: typeof fetch): Promise<BasketQuote[] | null> {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(auth.crumb)}`
  const r = await f(url, { headers: { ...UA, cookie: auth.cookie }, signal: upstreamSignal() })
  if (!r.ok) return null
  const q = parseV7Quotes(await r.json())
  return q.length > 0 ? q : null
}

export async function fetchStockBasket(
  symbols: string[],
  f: typeof fetch = fetch,
  opts: { batch?: number; concurrency?: number } = {},
): Promise<{ quotes: BasketQuote[]; errors: string[] }> {
  const batch = opts.batch ?? 200
  const concurrency = opts.concurrency ?? 3
  const batches: string[][] = []
  for (let i = 0; i < symbols.length; i += batch) batches.push(symbols.slice(i, i + batch))
  const quotes: BasketQuote[] = []
  const errors: string[] = []
  let auth: { cookie: string; crumb: string } | null | undefined // undefined = not tried yet
  let sparkDead = false
  let next = 0
  const worker = async () => {
    while (next < batches.length) {
      const mine = batches[next++]!
      try {
        let q = sparkDead ? null : await sparkBatch(mine, f)
        if (!q) {
          sparkDead = true
          if (auth === undefined) auth = await yahooCrumb(f)
          q = auth ? await v7Batch(mine, auth, f) : null
        }
        if (q) quotes.push(...q)
        else errors.push(`quotes: batch ${mine[0]}… returned nothing (spark and v7)`)
      } catch (e) {
        errors.push(`quotes: batch ${mine[0]}… ${e instanceof Error ? e.message : 'fetch failed'}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker))
  return { quotes, errors }
}

export async function fetchCryptoBasket(f: typeof fetch = fetch, pages = 2): Promise<{ quotes: BasketQuote[]; errors: string[] }> {
  const quotes: BasketQuote[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (let page = 1; page <= pages; page++) {
    try {
      const r = await f(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}`,
        { headers: UA, signal: upstreamSignal() },
      )
      if (!r.ok) {
        errors.push(`crypto: CoinGecko page ${page} HTTP ${r.status}`)
        break
      }
      quotes.push(...parseCoinGeckoMarkets(await r.json(), seen))
    } catch (e) {
      errors.push(`crypto: ${e instanceof Error ? e.message : 'fetch failed'}`)
      break
    }
  }
  return { quotes, errors }
}

/* ---------------- storage ---------------- */

export type BasketStatus = { builtAt: string | null; count: number; errors: string[] }

const meta = (db: DbLike, key: string) => (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
const setMeta = (db: DbLike, key: string, value: string) =>
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)

export function basketStatus(db: DbLike): BasketStatus {
  const errs = meta(db, 'basket:errors')
  return {
    builtAt: meta(db, 'basket:built_at') ?? null,
    count: (db.prepare('SELECT count(*) AS n FROM basket_quotes').get() as { n: number }).n,
    errors: errs ? (JSON.parse(errs) as string[]) : [],
  }
}

/**
 * The whole basket — identical for every caller, by design. Wire shape:
 * shared/series-api.ts BasketResponse. `history` says whether the monthly
 * market history (./history-pack.ts) is ready, so a tab asks for that file
 * only when there is one.
 */
export function getBasket(db: DbLike): BasketResponse {
  const rows = db
    .prepare('SELECT symbol, kind, cents, priced_on AS pricedOn, name, etf FROM basket_quotes ORDER BY kind, symbol')
    .all() as (Omit<BasketQuoteRow, 'etf'> & { etf: number })[]
  return { ...basketStatus(db), quotes: rows.map((r) => ({ ...r, etf: r.etf === 1 })), history: historyStatus(db) }
}

/**
 * How long a symbol that later builds no longer quote keeps its last quote. A
 * batch that failed today shouldn't make its symbols vanish from every tab
 * (yesterday's close, dated as such, beats "not in today's basket"); a
 * delisted symbol ages out.
 */
export const BASKET_KEEP_DAYS = 14

/**
 * Store a build. Only the kinds this build actually quoted are touched, so a
 * source that failed outright (CoinGecko down, say) leaves its kind's rows as
 * they were. Within a quoted kind, rows are upserted, and rows the build
 * didn't refresh are dropped once older than BASKET_KEEP_DAYS.
 */
export function storeBasket(db: DbLike, quotes: BasketQuote[], errors: string[], builtAt = new Date().toISOString()): void {
  db.transaction(() => {
    if (quotes.length > 0) {
      const cutoff = addDaysIso(builtAt.slice(0, 10), -BASKET_KEEP_DAYS)
      const prune = db.prepare('DELETE FROM basket_quotes WHERE kind = ? AND priced_on < ?')
      for (const kind of new Set(quotes.map((q) => q.kind))) prune.run(kind, cutoff)
      const put = db.prepare(
        `INSERT INTO basket_quotes (symbol, kind, cents, priced_on, name, etf) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (symbol, kind) DO UPDATE SET cents = excluded.cents, priced_on = excluded.priced_on,
           name = COALESCE(excluded.name, basket_quotes.name), etf = excluded.etf`,
      )
      for (const q of quotes) put.run(q.symbol, q.kind, q.cents, q.pricedOn, q.name || null, q.etf ? 1 : 0)
      setMeta(db, 'basket:built_at', builtAt)
    }
    setMeta(db, 'basket:errors', JSON.stringify(errors))
  })()
}

export type BuildResult = { stocks: number; crypto: number; universe: number; errors: string[]; ms: number }

export async function buildBasket(db: DbLike, f: typeof fetch = fetch): Promise<BuildResult> {
  const t0 = Date.now()
  const { listings, errors } = await fetchUniverse(f)
  const [stocks, crypto] = await Promise.all([
    listings.length > 0 ? fetchStockBasket(listings.map((l) => l.symbol), f) : { quotes: [], errors: ['quotes: no universe, skipped'] },
    fetchCryptoBasket(f),
  ])
  // Names and the ETF flag come from the directory, keyed by Yahoo spelling.
  const listing = new Map(listings.map((l) => [l.symbol, l]))
  const named = stocks.quotes.map((q) => {
    const l = listing.get(q.symbol)
    return l ? { ...q, name: l.name || null, etf: l.etf } : q
  })
  const all = [...named, ...crypto.quotes]
  const allErrors = [...errors, ...stocks.errors, ...crypto.errors]
  const builtAt = new Date().toISOString()
  storeBasket(db, all, allErrors, builtAt)
  // Keep the monthly history's month in progress current. Best-effort: the basket is served either way.
  try {
    appendToHistory(db, all, builtAt.slice(0, 10))
  } catch (e) {
    console.error('basket: merging quotes into the market history failed', e)
  }
  return { stocks: stocks.quotes.length, crypto: crypto.quotes.length, universe: listings.length, errors: allErrors, ms: Date.now() - t0 }
}

let inflight: Promise<BuildResult> | null = null
export const isBuilding = () => inflight !== null

/**
 * Build at most once per day, and never twice at once. Returns the running
 * build so a caller with nothing to serve can await it; callers that already
 * have a basket just let it run in the background.
 *
 * `force` skips the once-a-day check (a manual rebuild) but still joins a
 * build already running rather than starting a second one; throttling a
 * forced rebuild is the caller's call (basketStatus().builtAt says when the
 * last one finished).
 */
export function ensureBasket(
  db: DbLike,
  f: typeof fetch = fetch,
  today = new Date().toISOString().slice(0, 10),
  opts: { force?: boolean } = {},
): Promise<BuildResult> | null {
  if (inflight) return inflight
  if (!opts.force && meta(db, 'basket:attempted_on') === today) return null
  setMeta(db, 'basket:attempted_on', today) // stamp first: a crash mid-build shouldn't retry in a loop
  inflight = buildBasket(db, f).finally(() => {
    inflight = null
  })
  return inflight
}
