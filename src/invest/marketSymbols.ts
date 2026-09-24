import { useEffect, useState } from 'react'
import { get } from '../api'
import { marketIndex, type BasketLikeRow, type MarketIndex } from './symbolSearch'

/**
 * The symbols the shared daily basket quotes — the market list — loaded once
 * per tab, on first need. The basket is identical for every caller, so asking
 * for it says nothing about what this household holds; which symbols matter
 * is decided here, in the tab. Used for the symbol box's suggestions (with
 * names, where the source gave one), for soft "not in the market list"
 * warnings (a fund or private stock is fine, it just gets a hand-set price),
 * and for a vest's fair market value when the basket's close is from the vest day.
 */
export type MarketSymbols = {
  stocks: ReadonlySet<string>
  crypto: ReadonlySet<string>
  /** Stock quotes by the basket's (Yahoo) spelling: the close and its day. */
  quotes: ReadonlyMap<string, { cents: number; pricedOn: string }>
  /** Every row, indexed for search (src/invest/symbolSearch.ts). */
  index: MarketIndex
}

let cache: Promise<MarketSymbols> | null = null
let settled: MarketSymbols | null = null

export function loadMarketSymbols(): Promise<MarketSymbols> {
  cache ??= get<{ quotes: (BasketLikeRow & { cents?: number; pricedOn?: string })[] }>('/api/basket')
    .then((b) => {
      const stocks = new Set<string>()
      const crypto = new Set<string>()
      const quotes = new Map<string, { cents: number; pricedOn: string }>()
      for (const q of b.quotes) {
        ;(q.kind === 'crypto' ? crypto : stocks).add(q.symbol)
        if (q.kind === 'stock' && typeof q.cents === 'number' && typeof q.pricedOn === 'string') quotes.set(q.symbol, { cents: q.cents, pricedOn: q.pricedOn })
      }
      settled = { stocks, crypto, quotes, index: marketIndex(b.quotes) }
      return settled
    })
    .catch((e: unknown) => {
      cache = null // try again next time
      throw e
    })
  return cache
}

/**
 * The market list for a component: null until it has loaded (or if it can't
 * — the symbol box then works from the household's own symbols alone).
 */
export function useMarketSymbols(): MarketSymbols | null {
  const [m, setM] = useState<MarketSymbols | null>(settled)
  useEffect(() => {
    if (m) return
    let live = true
    loadMarketSymbols()
      .then((x) => live && setM(x))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [m])
  return m
}

/** The basket's spelling of a stock symbol: BRK.B → BRK-B. */
const yahoo = (symbol: string) => symbol.trim().toUpperCase().replace(/\./g, '-')

/** Is this symbol in the market list? Stocks match on the basket's Yahoo spelling (BRK.B → BRK-B). */
export function inMarketList(m: MarketSymbols, symbol: string): boolean {
  const s = symbol.trim().toUpperCase()
  return m.stocks.has(yahoo(s)) || m.crypto.has(s)
}

/** The basket's latest close for a stock, with its day, or null. */
export function stockQuote(m: MarketSymbols, symbol: string): { cents: number; pricedOn: string } | null {
  return m.quotes.get(yahoo(symbol)) ?? null
}
