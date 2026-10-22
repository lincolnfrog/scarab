import raw from './fund-tickers.txt?raw'

/**
 * The chaff population for "Ask the basket to cover this fund": every ticker
 * of a US-registered mutual fund share class, from the SEC's own list
 * (fund-tickers.txt — its header says where and when; scripts/fetch-fund-
 * tickers.mjs refreshes it). Imported lazily by the view that needs it, so
 * the ~165 KB ride in their own chunk and load only when someone opens it.
 */
let parsed: readonly string[] | null = null

/** Every ticker, sorted, upper case. */
export function fundTickers(): readonly string[] {
  parsed ??= Object.freeze(
    raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  )
  return parsed
}

/** Is this a registered fund share class's ticker? (BRK.B-style spelling is a stock's; funds have none.) */
export function isFundTicker(symbol: string, list: readonly string[] = fundTickers()): boolean {
  const s = symbol.trim().toUpperCase()
  // The list is sorted: binary search.
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid]! < s) lo = mid + 1
    else hi = mid
  }
  return list[lo] === s
}
