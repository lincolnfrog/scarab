import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { buildBasket, fetchCryptoBasket, fetchStockBasket, fetchUniverse } from './basket'
import { ensureDailyHistory } from './charts'
import { openDb } from './migrations'
import { fetchCryptoQuotes, fetchHistory, fetchStockQuotes } from './prices'
import { ensurePmmsRate } from './rates'
import { UPSTREAM_TIMEOUT_MS } from './upstream'

/**
 * Every upstream call carries a deadline (server/upstream.ts), so one stalled
 * connection can't hold the basket build — and everyone waiting on it — open.
 */

afterEach(() => vi.restoreAllMocks())

type Call = { url: string; signal: AbortSignal | null | undefined }

/** An upstream that answers 503 to everything except the crumb handshake, so every Yahoo path is walked. */
function recording() {
  const calls: Call[] = []
  const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, signal: init?.signal })
    if (url === 'https://fc.yahoo.com') return new Response('', { status: 404, headers: { 'set-cookie': 'A3=session; Path=/' } })
    if (url.includes('/getcrumb')) return new Response('crumb123')
    return new Response('down', { status: 503 })
  })
  return { f: f as unknown as typeof fetch, calls }
}

describe('every upstream call carries a deadline', () => {
  it.each([
    ['fetchUniverse', (f: typeof fetch) => fetchUniverse(f)],
    ['fetchStockBasket (spark, then the crumb handshake and v7)', (f: typeof fetch) => fetchStockBasket(['AAPL', 'MSFT'], f)],
    ['fetchCryptoBasket', (f: typeof fetch) => fetchCryptoBasket(f)],
    ['fetchStockQuotes', (f: typeof fetch) => fetchStockQuotes(['VTI', 'VXUS'], f)],
    ['fetchCryptoQuotes', (f: typeof fetch) => fetchCryptoQuotes(['BTC'], f)],
    ['fetchHistory', (f: typeof fetch) => fetchHistory('VTI', 'stock', f, '2026-09-23')],
    ['ensureDailyHistory', (f: typeof fetch) => ensureDailyHistory(openDb(':memory:') as unknown as Database, { id: 1, symbol: 'VTI', kind: 'stock' }, f)],
    ['ensurePmmsRate', (f: typeof fetch) => ensurePmmsRate(openDb(':memory:') as unknown as DbLike, f)],
  ])('%s', async (name, run) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const { f, calls } = recording()
    await run(f)
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c.signal, c.url).toBeInstanceOf(AbortSignal)
    // A fresh 30-second deadline per call: a shared one would start its clock before the call it guards.
    expect(timeout).toHaveBeenCalledTimes(calls.length)
    for (const [ms] of timeout.mock.calls) expect(ms).toBe(UPSTREAM_TIMEOUT_MS)
    if (name.startsWith('fetchStockBasket')) expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/v8/finance/spark', '/', '/v1/test/getcrumb', '/v7/finance/quote'])
  })
})

describe('a stalled upstream call ends at its deadline', () => {
  /** Deadlines the test controls: AbortSignal.timeout hands out signals that fire when the test says so. */
  function deadlines() {
    const issued: AbortController[] = []
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const c = new AbortController()
      issued.push(c)
      return c.signal
    })
    const expire = () => {
      for (const c of issued) if (!c.signal.aborted) c.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    }
    return { issued, expire }
  }
  /** Accepts every connection and never answers — until the caller's signal gives up on it. */
  const stalled = vi.fn(
    (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal
        signal?.addEventListener('abort', () => reject(signal.reason))
      }),
  ) as unknown as typeof fetch

  it('the basket build finishes with what it has, each stalled source recorded as its error', async () => {
    const clock = deadlines()
    const db = openDb(':memory:') as unknown as DbLike
    let finished = false
    const build = buildBasket(db, stalled).finally(() => (finished = true))
    // Let the clock run out on each call as it is made (the universe's two files one after the other, then crypto).
    while (!finished) {
      clock.expire()
      await new Promise((r) => setTimeout(r, 1))
    }
    const result = await build
    expect(clock.issued.length).toBe(3)
    expect(result).toMatchObject({ stocks: 0, crypto: 0, universe: 0 })
    expect(result.errors).toEqual([
      'universe: The operation was aborted due to timeout',
      'universe: The operation was aborted due to timeout',
      'quotes: no universe, skipped',
      'crypto: The operation was aborted due to timeout',
    ])
  })

  it('a timed-out crypto quote is that source’s error, not a failed refresh', async () => {
    const clock = deadlines()
    const pending = fetchCryptoQuotes(['BTC', 'DOGE'], stalled)
    await vi.waitFor(() => expect(clock.issued).toHaveLength(1))
    clock.expire()
    expect(await pending).toEqual({ quotes: [], errors: ['coingecko: The operation was aborted due to timeout'] })
  })
})
