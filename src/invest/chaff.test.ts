import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fundTickers, isFundTicker } from './fundTickers'
import { pickChaff, SUGGEST_K } from './chaff'

const sha256 = async (data: Uint8Array): Promise<ArrayBuffer> => {
  const d = createHash('sha256').update(data).digest()
  return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer
}
const key = (fill: number) => new Uint8Array(32).fill(fill)

describe('the bundled fund-ticker list', () => {
  it('is the SEC’s list: tens of thousands of registered share classes, sorted, upper case, with its provenance in the header', () => {
    const list = fundTickers()
    expect(list.length).toBeGreaterThan(25_000)
    expect(list.every((s) => /^[A-Z][A-Z0-9]{0,9}$/.test(s))).toBe(true)
    expect([...list].sort()).toEqual([...list])
    expect(new Set(list).size).toBe(list.length)
    for (const fund of ['VFIAX', 'FXAIX', 'VTSAX', 'SWPPX', 'VBTLX']) expect(isFundTicker(fund), fund).toBe(true)
    expect(isFundTicker('vfiax')).toBe(true)
    for (const not of ['AAPL', 'BRK.B', 'BRK-B', 'ZZZZZZZZ', '', 'A B']) expect(isFundTicker(not), not).toBe(false)
  })
})

describe('pickChaff: the wanted fund among k−1 others from the same population', () => {
  const population = fundTickers()

  it('names k distinct fund tickers, the wanted one among them, in sorted order, none from the basket', async () => {
    const exclude = new Set(['VTSAX', 'FXAIX', 'AAA']) // say the basket already quotes these
    const picked = await pickChaff({ symbol: 'vfiax', population, exclude, secret: key(1), digest: sha256 })
    expect(picked).toHaveLength(SUGGEST_K)
    expect(picked).toContain('VFIAX')
    expect(new Set(picked).size).toBe(SUGGEST_K)
    expect([...picked].sort()).toEqual(picked)
    for (const s of picked) {
      expect(isFundTicker(s), s).toBe(true)
      expect(exclude.has(s), s).toBe(false)
    }
  })

  it('is deterministic for one household and one fund, and different for another fund or another household', async () => {
    const a1 = await pickChaff({ symbol: 'VFIAX', population, exclude: new Set(), secret: key(1), digest: sha256 })
    const a2 = await pickChaff({ symbol: 'VFIAX', population, exclude: new Set(), secret: key(1), digest: sha256 })
    expect(a2).toEqual(a1) // asking again (another day, the other member's device) names the same k
    const otherFund = await pickChaff({ symbol: 'SWPPX', population, exclude: new Set(), secret: key(1), digest: sha256 })
    const otherHousehold = await pickChaff({ symbol: 'VFIAX', population, exclude: new Set(), secret: key(2), digest: sha256 })
    expect(otherFund).not.toEqual(a1)
    expect(otherHousehold).not.toEqual(a1)
    // The two households' chaff for the same fund overlap only by chance: a secret-seeded draw is no lookup table.
    const shared = a1.filter((s) => otherHousehold.includes(s))
    expect(shared.length).toBeLessThan(4) // VFIAX itself, and at most a coincidence or two
  })

  it('without a secret draws at random from the same population', async () => {
    let n = 0.001
    const random = () => (n = (n * 97 + 0.137) % 1)
    const picked = await pickChaff({ symbol: 'VFIAX', population, exclude: new Set(), secret: null, random })
    expect(picked).toHaveLength(SUGGEST_K)
    expect(picked).toContain('VFIAX')
    expect(picked.every((s) => isFundTicker(s))).toBe(true)
  })

  it('refuses when the population can’t supply the chaff', async () => {
    await expect(pickChaff({ symbol: 'VFIAX', population: ['VFIAX', 'A', 'B'], exclude: new Set(), secret: key(1), digest: sha256, k: 5 })).rejects.toThrow(/not enough/)
  })
})
