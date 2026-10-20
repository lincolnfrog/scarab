/**
 * Chaff for "Ask the basket to cover this fund" (PRIVACY.md "Anonymous add").
 *
 * Every request to the server carries the IAP identity, so a request that
 * named one fund would tie that fund to this household. The only tool left is
 * k-anonymity: name the wanted fund among k−1 others drawn from the same
 * population — real tickers of registered fund share classes, the kind the
 * basket lacks (src/invest/fundTickers.ts) — and have the server add all k
 * alike. What it then learns is "one of these k", not which.
 *
 * Which k−1: a deterministic draw seeded from a secret this household holds
 * (the vault's data key) and the wanted symbol. Deterministic, so asking again
 * — tomorrow, from the other member's phone — names the same k and gives an
 * observer nothing to intersect; secret, so the server can't run the draw for
 * every fund and match the set it saw (a draw seeded from the symbol alone
 * would be exactly that lookup table). Without a vault yet there is no
 * secret: the draw is random, and the view says to ask once.
 *
 * Pure: the seed material comes in, the symbols go out; the digest is
 * WebCrypto's (this is the client, async is fine).
 */

/** How many symbols a suggestion names: the wanted fund and SUGGEST_K − 1 others. */
export const SUGGEST_K = 32

const enc = new TextEncoder()
const hex = (b: ArrayBuffer | Uint8Array) => Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')

/** A stream of 32-bit numbers from SHA-256 over (secret, symbol, counter). */
async function* draws(secret: Uint8Array, symbol: string, digest: (data: Uint8Array) => Promise<ArrayBuffer>): AsyncGenerator<number> {
  for (let i = 0; ; i++) {
    const data = enc.encode(`scarab:suggest:v1:${hex(secret)}:${symbol}:${i}`)
    const d = new Uint8Array(await digest(data))
    for (let o = 0; o + 4 <= d.length; o += 4) yield ((d[o]! << 24) | (d[o + 1]! << 16) | (d[o + 2]! << 8) | d[o + 3]!) >>> 0
  }
}

export type ChaffInput = {
  /** The wanted fund, as typed (upper-cased here). */
  symbol: string
  /** The population to draw from: fund tickers, sorted, upper case. */
  population: readonly string[]
  /** Symbols that make no chaff — the basket's own (the server has them already), spelled the basket's way. */
  exclude: ReadonlySet<string>
  /** The household's secret (the vault's data key), or null when there is none yet. */
  secret: Uint8Array | null
  k?: number
  /** For tests: WebCrypto's SHA-256 by default. */
  digest?: (data: Uint8Array) => Promise<ArrayBuffer>
  /** For tests: Math.random by default (used only without a secret). */
  random?: () => number
}

/**
 * The k symbols to send: the wanted one, then k−1 distinct others from the
 * population that are neither it nor excluded, in a fixed order (sorted) so
 * the wanted one's position says nothing. Throws when the population can't
 * supply k−1.
 */
export async function pickChaff(i: ChaffInput): Promise<string[]> {
  const k = i.k ?? SUGGEST_K
  const want = i.symbol.trim().toUpperCase()
  const pool = i.population.filter((s) => s !== want && !i.exclude.has(s))
  if (pool.length < k - 1) throw new Error(`not enough fund tickers to draw ${k - 1} others from`)
  const chosen = new Set<string>()
  // A draw that lands on a symbol already chosen takes the next one along (linear probing): the draw stays
  // deterministic, and it always finishes — however the numbers come out — once the pool can supply k−1.
  const take = (n: number) => {
    let at = n % pool.length
    while (chosen.has(pool[at]!)) at = (at + 1) % pool.length
    chosen.add(pool[at]!)
  }
  if (i.secret) {
    const digest = i.digest ?? ((data: Uint8Array) => crypto.subtle.digest('SHA-256', data as BufferSource))
    const stream = draws(i.secret, want, digest)
    while (chosen.size < k - 1) take((await stream.next()).value as number)
  } else {
    const random = i.random ?? Math.random
    while (chosen.size < k - 1) take(Math.floor(random() * pool.length))
  }
  return [want, ...chosen].sort()
}
