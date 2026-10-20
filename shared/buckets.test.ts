import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DAILY_BUCKETS, dailyBucket, isBucketIndex, marketSymbolOf } from './buckets'

/** The server's way of computing the same thing, with node:crypto — what the tab's pure-TS hash must agree with. */
const nodeBucket = (kind: string, symbol: string, n = DAILY_BUCKETS) =>
  Number.parseInt(createHash('sha1').update(`${kind}:${symbol}`).digest('hex').slice(0, 8), 16) % n

describe('dailyBucket: the same deal on the server and in the tab', () => {
  it('is stable, agrees with node:crypto, and treats both spellings of a share class alike', () => {
    const cases: [kind: 'stock' | 'crypto', symbol: string][] = [
      ['stock', 'SPY'],
      ['stock', 'VTI'],
      ['stock', 'BRK-B'],
      ['stock', 'brk.b'],
      ['stock', ' AAPL '],
      ['crypto', 'BTC'],
      ['stock', 'BTC'],
      ['stock', '^GSPC'],
    ]
    for (const [kind, symbol] of cases) {
      const b = dailyBucket(kind, symbol)
      expect(b, `${kind}:${symbol}`).toBe(nodeBucket(kind, marketSymbolOf(kind, symbol)))
      expect(dailyBucket(kind, symbol), 'deterministic').toBe(b)
      expect(isBucketIndex(b)).toBe(true)
    }
    expect(dailyBucket('stock', 'BRK.B')).toBe(dailyBucket('stock', 'BRK-B'))
    expect(dailyBucket('stock', 'brk-b')).toBe(dailyBucket('stock', 'BRK-B'))
    // A stock and a coin sharing a ticker are dealt separately (they may or may not collide; the key differs).
    expect(dailyBucket('stock', 'BTC')).toBe(nodeBucket('stock', 'BTC'))
    expect(dailyBucket('crypto', 'BTC')).toBe(nodeBucket('crypto', 'BTC'))
    // Pinned: a change here would move every symbol to another file and must be deliberate (PRIVACY.md "Daily history").
    expect(dailyBucket('stock', 'SPY')).toBe(nodeBucket('stock', 'SPY'))
    expect(DAILY_BUCKETS).toBe(64)
  })

  it('deals a universe the size of the basket evenly enough that every bucket is a crowd', () => {
    // ~11,000 synthetic tickers, shaped like real ones: 1–5 letters.
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const symbols = new Set<string>()
    // mulberry32: a small seeded generator in 32-bit arithmetic (a plain LCG in doubles loses bits and can cycle).
    let a = 7
    const rnd = () => {
      a = (a + 0x6d2b79f5) | 0
      let t = Math.imul(a ^ (a >>> 15), 1 | a)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
    }
    while (symbols.size < 11_000) {
      const len = 1 + Math.floor(rnd() * 5)
      let s = ''
      for (let i = 0; i < len; i++) s += letters[Math.floor(rnd() * 26)]
      symbols.add(s)
    }
    const counts = new Array<number>(DAILY_BUCKETS).fill(0)
    for (const s of symbols) counts[dailyBucket('stock', s)]!++
    const mean = symbols.size / DAILY_BUCKETS // ~172
    expect(Math.min(...counts)).toBeGreaterThan(mean * 0.7)
    expect(Math.max(...counts)).toBeLessThan(mean * 1.3)
  })

  it('refuses a bad bucket count and recognises a bucket number off the wire', () => {
    expect(() => dailyBucket('stock', 'SPY', 0)).toThrow(/positive integer/)
    expect(() => dailyBucket('stock', 'SPY', 1.5)).toThrow(/positive integer/)
    expect(dailyBucket('stock', 'SPY', 1)).toBe(0)
    for (const ok of [0, 1, 63]) expect(isBucketIndex(ok)).toBe(true)
    for (const bad of [-1, 64, 1.5, Number.NaN, '3', null, undefined]) expect(isBucketIndex(bad)).toBe(false)
    expect(isBucketIndex(7, 8)).toBe(true)
    expect(isBucketIndex(8, 8)).toBe(false)
  })
})
