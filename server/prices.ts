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
        const r = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (scarab household finance)' } })
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
  const r = await f(url)
  if (!r.ok) return { quotes: [], errors: [...errors, `coingecko: HTTP ${r.status}`] }
  const body = (await r.json()) as Record<string, { usd?: number }>
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

/** Yahoo monthly history → month-by-month closes. Crypto uses SYM-USD. */
export function parseYahooHistory(symbol: string, body: unknown): Quote[] {
  const result = (
    body as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } }
  )?.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const closes = result?.indicators?.quote?.[0]?.close ?? []
  const out: Quote[] = []
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i]
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
    out.push({ symbol, cents: Math.round(c * 100), pricedOn: new Date(ts[i]! * 1000).toISOString().slice(0, 10) })
  }
  return out
}

export async function fetchHistory(
  symbol: string,
  kind: 'stock' | 'crypto',
  f: typeof fetch = fetch,
): Promise<QuoteResult> {
  const ySym = kind === 'crypto' ? `${symbol.toUpperCase()}-USD` : symbol.toUpperCase()
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1mo&range=max`
    const r = await f(url, { headers: { 'user-agent': 'Mozilla/5.0 (scarab household finance)' } })
    if (!r.ok) return { quotes: [], errors: [`${symbol}: Yahoo history HTTP ${r.status}`] }
    const quotes = parseYahooHistory(symbol.toUpperCase(), await r.json())
    return quotes.length > 0 ? { quotes, errors: [] } : { quotes: [], errors: [`${symbol}: no history from Yahoo`] }
  } catch (e) {
    return { quotes: [], errors: [`${symbol}: ${e instanceof Error ? e.message : 'history fetch failed'}`] }
  }
}
