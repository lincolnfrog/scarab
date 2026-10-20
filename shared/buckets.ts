import { sha1Hex } from '../engine/hash'

/**
 * Hashed symbol buckets for the shared daily price history (PRIVACY.md,
 * "Daily history"; server/daily-buckets.ts serves them, src/local/
 * routes-analytics.ts reads them).
 *
 * A zero-knowledge tab can't ask the server for one symbol's daily closes:
 * the request would name a holding. Instead the universe is dealt into
 * DAILY_BUCKETS files by a stable hash of the symbol, and the tab asks for
 * the whole bucket its symbol falls in — Safe-Browsing style, one of N rather
 * than one of ~11,000. The server and the tab must deal the same way, so the
 * function lives here, used by both: the first 32 bits of SHA-1 over
 * "kind:SYMBOL" (the basket's spelling: Yahoo's for stocks, BRK-B; the bare
 * ticker for crypto), modulo the bucket count. A stock and a coin that share
 * a ticker hash separately.
 */
export const DAILY_BUCKETS = 64

/** How far back the daily files reach; the monthly file keeps the long tail. */
export const DAILY_YEARS = 2

export type MarketKind = 'stock' | 'crypto'

/** The basket's spelling of a symbol: upper case; a stock's share class with a dash (BRK.B → BRK-B). */
export const marketSymbolOf = (kind: MarketKind, symbol: string): string =>
  kind === 'stock' ? symbol.trim().toUpperCase().replace(/\./g, '-') : symbol.trim().toUpperCase()

/** Which of `n` buckets a symbol's daily closes are in. Either spelling of a stock (BRK.B, BRK-B) lands in the same one. */
export function dailyBucket(kind: MarketKind, symbol: string, n: number = DAILY_BUCKETS): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`dailyBucket: bucket count must be a positive integer, not ${n}`)
  const hex = sha1Hex(`${kind}:${marketSymbolOf(kind, symbol)}`)
  return Number.parseInt(hex.slice(0, 8), 16) % n
}

/** Is this a bucket number a server with `n` buckets serves? (A path segment crossed the network.) */
export const isBucketIndex = (b: unknown, n: number = DAILY_BUCKETS): b is number => Number.isInteger(b) && (b as number) >= 0 && (b as number) < n
