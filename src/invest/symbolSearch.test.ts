import { describe, expect, it } from 'vitest'
import { formatCents } from '../../shared/money'
import {
  ambiguityText,
  displaySymbol,
  lockedKindText,
  marketIndex,
  mergeRecorded,
  resolveSymbol,
  searchSymbols,
  settleKind,
  symbolHint,
} from './symbolSearch'

// A slice of the basket as /api/basket serves it (Yahoo spelling for class shares).
const market = marketIndex([
  { symbol: 'VTI', kind: 'stock', name: 'Vanguard Total Stock Market ETF', etf: true, cents: 312_40, pricedOn: '2026-09-22' },
  { symbol: 'VT', kind: 'stock', name: 'Vanguard Total World Stock ETF', etf: true, cents: 120_10, pricedOn: '2026-09-22' },
  { symbol: 'VTIP', kind: 'stock', name: 'Vanguard Short-Term Inflation-Protected Securities ETF', etf: true, cents: 49_00, pricedOn: '2026-09-22' },
  { symbol: 'BRK-B', kind: 'stock', name: 'Berkshire Hathaway Inc. Class B', etf: false, cents: 480_00, pricedOn: '2026-09-22' },
  { symbol: 'BRK-A', kind: 'stock', name: 'Berkshire Hathaway Inc. Class A', etf: false, cents: 720_000_00, pricedOn: '2026-09-22' },
  { symbol: 'BTC', kind: 'stock', name: 'Grayscale Bitcoin Mini Trust ETF', etf: true, cents: 45_00, pricedOn: '2026-09-22' },
  { symbol: 'BTC', kind: 'crypto', name: 'Bitcoin', etf: false, cents: 6_300_000, pricedOn: '2026-09-23' },
  { symbol: 'ETH', kind: 'crypto', name: 'Ethereum', etf: false, cents: 250_000, pricedOn: '2026-09-23' },
  { symbol: 'AAPL', kind: 'stock', name: 'Apple Inc.', etf: false, cents: 230_00, pricedOn: '2026-09-22' },
  { symbol: 'NONAME', kind: 'stock', name: null, etf: false, cents: 1_00, pricedOn: '2026-09-22' },
  { symbol: '', kind: 'stock' }, // malformed rows are skipped
])

describe('the market list, indexed', () => {
  it('offers class shares with a dot and keeps names and the ETF flag', () => {
    expect(displaySymbol('BRK-B', 'stock')).toBe('BRK.B')
    expect(displaySymbol('btc', 'crypto')).toBe('BTC')
    expect(market.rows).toHaveLength(10)
    expect(market.byKey.get('BRK-B')).toEqual([expect.objectContaining({ symbol: 'BRK.B', key: 'BRK-B', name: 'Berkshire Hathaway Inc. Class B', etf: false })])
    expect(market.byKey.get('BTC')?.map((r) => r.kind)).toEqual(['stock', 'crypto'])
  })
})

describe('suggestions', () => {
  const recorded = [
    { symbol: 'VTI', kind: 'stock' as const },
    { symbol: 'PRIV', kind: 'stock' as const }, // private stock the market doesn't list
  ]

  it('an exact symbol first, then symbols starting with it (shorter first), then names', () => {
    const r = searchSymbols('vt', { recorded: [], market })
    expect(r.map((o) => o.symbol)).toEqual(['VT', 'VTI', 'VTIP'])
    expect(r[0]).toMatchObject({ name: 'Vanguard Total World Stock ETF', etf: true, recorded: false })
  })

  it('names match by word start from 2 letters, and inside a word from 3', () => {
    expect(searchSymbols('berk', { recorded: [], market }).map((o) => o.symbol)).toEqual(['BRK.A', 'BRK.B'])
    expect(searchSymbols('apple', { recorded: [], market }).map((o) => o.symbol)).toEqual(['AAPL'])
    expect(searchSymbols('hereu', { recorded: [], market }).map((o) => o.symbol)).toEqual(['ETH']) // inside "Ethereum"
    expect(searchSymbols('ap', { recorded: [], market }).map((o) => o.symbol)).toEqual(['AAPL'])
  })

  it('finds a class share by either spelling; the class shares of what is typed come before longer tickers', () => {
    expect(searchSymbols('BRK.B', { recorded: [], market })[0]).toMatchObject({ symbol: 'BRK.B' })
    expect(searchSymbols('brk-b', { recorded: [], market })[0]).toMatchObject({ symbol: 'BRK.B' })
    const withBrkr = marketIndex([
      { symbol: 'BRKR', kind: 'stock', name: 'Bruker Corporation' },
      { symbol: 'BRKC', kind: 'stock', name: 'YieldMax BRK.B Option Income Strategy ETF', etf: true },
      { symbol: 'BRK-B', kind: 'stock', name: 'Berkshire Hathaway Inc. New' },
      { symbol: 'BRK-A', kind: 'stock', name: 'Berkshire Hathaway Inc.' },
    ])
    expect(searchSymbols('brk', { recorded: [], market: withBrkr }).map((o) => o.symbol)).toEqual(['BRK.A', 'BRK.B', 'BRKC', 'BRKR'])
  })

  it('several words match words of the name in any order, the exact phrase first', () => {
    const funds = marketIndex([
      { symbol: 'VTI', kind: 'stock', name: 'Vanguard Morningstar Total Stock Market ETF', etf: true },
      { symbol: 'VXUS', kind: 'stock', name: 'Vanguard Total International Stock ETF', etf: true },
      { symbol: 'VOO', kind: 'stock', name: 'Vanguard S&P 500 ETF', etf: true },
      { symbol: 'ITOT', kind: 'stock', name: 'iShares Core S&P Total U.S. Stock Market ETF', etf: true },
    ])
    expect(searchSymbols('vanguard total', { recorded: [], market: funds }).map((o) => o.symbol)).toEqual(['VXUS', 'VTI'])
    expect(searchSymbols('total stock mar', { recorded: [], market: funds }).map((o) => o.symbol)).toEqual(['VTI', 'ITOT'])
    expect(searchSymbols('vanguard bond', { recorded: [], market: funds })).toEqual([])
  })

  it('what the account holds ranks first, then what Scarab recorded; a recorded symbol and its market row are one suggestion', () => {
    const r = searchSymbols('v', { recorded, market, held: new Set(['VTI']) })
    expect(r[0]).toMatchObject({ symbol: 'VTI', recorded: true, held: true, name: 'Vanguard Total Stock Market ETF' })
    expect(r.filter((o) => o.symbol === 'VTI')).toHaveLength(1)
    // A recorded symbol the market doesn't list still comes up.
    expect(searchSymbols('pri', { recorded, market })[0]).toMatchObject({ symbol: 'PRIV', recorded: true, name: null })
  })

  it('a recorded class share keeps its recorded spelling', () => {
    const r = searchSymbols('brk', { recorded: [{ symbol: 'BRK-B', kind: 'stock' }], market })
    expect(r[0]).toMatchObject({ symbol: 'BRK-B', recorded: true, name: 'Berkshire Hathaway Inc. Class B' })
    expect(r.map((o) => o.symbol)).toEqual(['BRK-B', 'BRK.A'])
  })

  it('a symbol listed both ways shows both; kinds narrows them; preferKind breaks the tie', () => {
    expect(searchSymbols('btc', { recorded: [], market }).map((o) => `${o.symbol}:${o.kind}`)).toEqual(['BTC:crypto', 'BTC:stock'])
    expect(searchSymbols('btc', { recorded: [], market, preferKind: 'stock' }).map((o) => o.kind)).toEqual(['stock', 'crypto'])
    expect(searchSymbols('btc', { recorded: [], market, kinds: ['stock'] }).map((o) => o.kind)).toEqual(['stock'])
  })

  it('empty text offers what is held, then the rest recorded; nothing from the market', () => {
    expect(searchSymbols('', { recorded, market, held: new Set(['PRIV']) }).map((o) => o.symbol)).toEqual(['PRIV', 'VTI'])
    expect(searchSymbols('  ', { recorded: [], market })).toEqual([])
  })

  it('caps the list, and works before the market list has loaded', () => {
    expect(searchSymbols('v', { recorded: [], market, limit: 2 })).toHaveLength(2)
    expect(searchSymbols('vt', { recorded, market: null }).map((o) => o.symbol)).toEqual(['VTI'])
  })
})

describe('what a typed symbol settles its kind to', () => {
  const recorded = [
    { symbol: 'BRK.B', kind: 'stock' as const },
    { symbol: 'SOL', kind: 'crypto' as const },
  ]

  it('recorded: its kind, locked — also under the other class-share spelling', () => {
    const r = resolveSymbol(' brk-b ', recorded, market)
    expect(r).toMatchObject({ text: 'BRK-B', recorded: { symbol: 'BRK.B' } })
    expect(settleKind(r, 'crypto', 'stock')).toEqual({ kind: 'stock', locked: true, ambiguous: false })
    expect(lockedKindText(r.recorded!)).toBe('BRK.B is recorded as a stock/ETF')
    expect(settleKind(resolveSymbol('sol', recorded, market), null, 'stock')).toEqual({ kind: 'crypto', locked: true, ambiguous: false })
  })

  it('listed both ways: ambiguous until someone picks', () => {
    const r = resolveSymbol('BTC', [], market)
    expect(r.stock?.name).toBe('Grayscale Bitcoin Mini Trust ETF')
    expect(r.crypto?.name).toBe('Bitcoin')
    expect(settleKind(r, null, 'crypto')).toEqual({ kind: 'crypto', locked: false, ambiguous: true })
    expect(settleKind(r, 'stock', 'crypto')).toEqual({ kind: 'stock', locked: false, ambiguous: false })
    expect(ambiguityText(r)).toBe('BTC is listed both as a stock/ETF (Grayscale Bitcoin Mini Trust ETF) and as a crypto (Bitcoin) — choose which under Kind.')
  })

  it('listed one way: that kind as a default, still changeable; unlisted: the fallback', () => {
    expect(settleKind(resolveSymbol('ETH', [], market), null, 'stock')).toEqual({ kind: 'crypto', locked: false, ambiguous: false })
    expect(settleKind(resolveSymbol('ETH', [], market), 'stock', 'stock')).toEqual({ kind: 'stock', locked: false, ambiguous: false })
    expect(settleKind(resolveSymbol('VTI', [], market), null, 'crypto').kind).toBe('stock')
    expect(settleKind(resolveSymbol('FXAIX', [], market), null, 'stock')).toEqual({ kind: 'stock', locked: false, ambiguous: false })
    expect(settleKind(resolveSymbol('', [], market), null, 'crypto')).toEqual({ kind: 'crypto', locked: false, ambiguous: false })
  })
})

describe('the line under the symbol box', () => {
  const hint = (text: string, recorded: { symbol: string; kind: 'stock' | 'crypto' }[] = [], loaded = true) => {
    const r = resolveSymbol(text, recorded, loaded ? market : null)
    const s = settleKind(r, null, 'stock')
    return symbolHint(r, s.kind, s.ambiguous, loaded, formatCents)
  }
  it("names what's typed, with its last close", () => {
    expect(hint('VTI')).toBe('Vanguard Total Stock Market ETF · ETF · last $312.40')
    expect(hint('ETH')).toBe('Ethereum · crypto · last $2,500.00')
    expect(hint('NONAME')).toBe('stock · last $1.00')
  })
  it('says when it was typed another way than recorded', () => {
    expect(hint('BRK-B', [{ symbol: 'BRK.B', kind: 'stock' }])).toBe('Berkshire Hathaway Inc. Class B · stock · recorded as BRK.B — the same stock · last $480.00')
  })
  it('an unlisted symbol is fine — once the list has loaded; nothing while empty or ambiguous', () => {
    expect(hint('FXAIX')).toMatch(/^Not in the market list — fine for a fund or private stock/)
    expect(hint('FXAIX', [], false)).toBeNull()
    expect(hint('PRIV', [{ symbol: 'PRIV', kind: 'stock' }])).toBeNull()
    expect(hint('')).toBeNull()
    expect(hint('BTC')).toBeNull()
  })
})

describe('recorded symbols to lock kinds from', () => {
  it('the asset list plus anything the portfolio already shows', () => {
    expect(mergeRecorded([{ symbol: 'VTI', kind: 'stock' }], [{ symbol: 'VTI', kind: 'stock' }, { symbol: 'BTC', kind: 'crypto' }])).toEqual([
      { symbol: 'VTI', kind: 'stock' },
      { symbol: 'BTC', kind: 'crypto' },
    ])
  })
})
