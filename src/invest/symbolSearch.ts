import { symbolKey, type AssetRow } from '../../shared/invest-api'

/**
 * The symbol box's brain: which securities a typed text could mean, from the
 * household's own recorded symbols and the shared market list (the daily
 * basket, with names where the source gave one), and what a typed symbol
 * settles its kind to. Pure and node-tested; SymbolInput only renders it.
 *
 * Spelling: the market list spells class shares the way Yahoo does (BRK-B);
 * statements and brokerages write BRK.B. Matching goes through symbolKey, so
 * either finds it; a stock new to the household is offered with the dot, and
 * a recorded one always keeps its recorded spelling.
 */

export type SymbolKind = 'stock' | 'crypto'

/** One security in the market list. */
export type MarketRow = {
  /** How it's offered: BRK.B for a class share, the bare ticker for crypto. */
  symbol: string
  /** symbolKey(symbol) — the matching spelling. */
  key: string
  kind: SymbolKind
  name: string | null
  etf: boolean
  cents: number | null
  pricedOn: string | null
  /** Upper-cased name, and where each of its words starts — for name search. */
  nameUp: string
  wordStarts: number[]
}

/** The market list, indexed. */
export type MarketIndex = { rows: readonly MarketRow[]; byKey: ReadonlyMap<string, readonly MarketRow[]> }

export type BasketLikeRow = { symbol: string; kind: SymbolKind; cents?: number | null; pricedOn?: string | null; name?: string | null; etf?: boolean }

/** How the market list offers a basket symbol: class shares with a dot (BRK-B → BRK.B). Crypto as is. */
export const displaySymbol = (basketSymbol: string, kind: SymbolKind): string =>
  kind === 'stock' ? basketSymbol.trim().toUpperCase().replace(/-/g, '.') : basketSymbol.trim().toUpperCase()

function wordStarts(up: string): number[] {
  const out: number[] = []
  for (let i = 0; i < up.length; i++) if (/[A-Z0-9]/.test(up[i]!) && (i === 0 || !/[A-Z0-9]/.test(up[i - 1]!))) out.push(i)
  return out
}

export function marketIndex(rows: readonly BasketLikeRow[]): MarketIndex {
  const out: MarketRow[] = []
  const byKey = new Map<string, MarketRow[]>()
  for (const q of rows) {
    if (typeof q.symbol !== 'string' || !q.symbol.trim() || (q.kind !== 'stock' && q.kind !== 'crypto')) continue
    const symbol = displaySymbol(q.symbol, q.kind)
    const name = typeof q.name === 'string' && q.name.trim() ? q.name.trim() : null
    const nameUp = name ? name.toUpperCase() : ''
    const row: MarketRow = {
      symbol,
      key: symbolKey(symbol),
      kind: q.kind,
      name,
      etf: q.etf === true,
      cents: typeof q.cents === 'number' && Number.isSafeInteger(q.cents) ? q.cents : null,
      pricedOn: typeof q.pricedOn === 'string' ? q.pricedOn : null,
      nameUp,
      wordStarts: wordStarts(nameUp),
    }
    out.push(row)
    const list = byKey.get(row.key)
    if (list) list.push(row)
    else byKey.set(row.key, [row])
  }
  return { rows: out, byKey }
}

/** One suggestion in the list. */
export type SymbolOption = {
  /** What goes in the box. */
  symbol: string
  kind: SymbolKind
  name: string | null
  etf: boolean
  /** Scarab has recorded this symbol: its kind is fixed. */
  recorded: boolean
  /** Held in the account the form is about (a sale's candidates). */
  held: boolean
  cents: number | null
  pricedOn: string | null
}

export type SearchOpts = {
  recorded: readonly Pick<AssetRow, 'symbol' | 'kind'>[]
  market: MarketIndex | null
  /** Symbols to rank first — what the account holds. */
  held?: ReadonlySet<string>
  /** Only these kinds (a stock grant: stock). */
  kinds?: readonly SymbolKind[]
  /** Ties go to this kind (a crypto account: crypto). */
  preferKind?: SymbolKind
  limit?: number
}

/** The engine's rule (findAsset): the exact spelling, or a stock under its other class-share spelling. */
const recordedMatches = (a: Pick<AssetRow, 'symbol' | 'kind'>, typed: string) =>
  a.symbol.toUpperCase() === typed || (a.kind === 'stock' && symbolKey(a.symbol) === symbolKey(typed))

/** A symbol-and-name match's rank (lower is better), or null for no match. */
function rank(q: string, qKey: string, key: string, nameUp: string, starts: readonly number[]): number | null {
  if (key === qKey) return 0
  // A class share of exactly what's typed ("BRK" → BRK.A, BRK.B) before longer tickers (BRKR).
  const dash = key.indexOf('-')
  if (dash > 0 && key.slice(0, dash) === qKey) return 50 + (key.length - qKey.length)
  if (key.startsWith(qKey)) return 100 + (key.length - qKey.length)
  if (q.length >= 2 && nameUp) {
    const wordAt = (w: string) => starts.findIndex((s) => nameUp.startsWith(w, s))
    const words = q.split(/\s+/).filter(Boolean)
    if (words.length > 1) {
      // Every word starts a word of the name, in any order ("vanguard total" → Vanguard Morningstar Total …); the phrase itself first.
      const at = words.map(wordAt)
      if (at.every((i) => i >= 0)) return (nameUp.includes(q) ? 290 : 310) + Math.min(at[0]!, 20)
      return null
    }
    // A word of the name starting with the text ("vang" → Vanguard …), earlier words first.
    const i = wordAt(q)
    if (i >= 0) return 300 + Math.min(i, 20)
    if (q.length >= 3 && nameUp.includes(q)) return 400
  }
  return null
}

/**
 * The suggestions for what's typed, best first: an exact symbol, then symbols
 * starting with it, then names with a word starting with it (from 2
 * characters) or containing it (from 3). What the account holds comes first,
 * then what Scarab has recorded, then the market list. A recorded symbol and
 * its market row are one suggestion (the recorded spelling, the market's
 * name). Empty text offers what the account holds, then the rest recorded.
 */
export function searchSymbols(text: string, o: SearchOpts): SymbolOption[] {
  const limit = o.limit ?? 8
  const q = text.trim().toUpperCase()
  const qKey = symbolKey(q)
  const kindOk = (k: SymbolKind) => !o.kinds || o.kinds.includes(k)
  const held = o.held ?? new Set<string>()
  const scored: { opt: SymbolOption; score: number }[] = []
  const covered = new Set<string>() // `${kind}:${key}` of recorded symbols

  const marketFor = (symbol: string, kind: SymbolKind) => o.market?.byKey.get(symbolKey(symbol))?.find((r) => r.kind === kind) ?? null
  const boost = (opt: SymbolOption) => (opt.held ? -60 : 0) + (opt.recorded ? -30 : 0) + (o.preferKind && opt.kind !== o.preferKind ? 5 : 0)

  for (const a of o.recorded) {
    if (!kindOk(a.kind)) continue
    const m = marketFor(a.symbol, a.kind)
    const key = symbolKey(a.symbol)
    covered.add(`${a.kind}:${key}`)
    const opt: SymbolOption = {
      symbol: a.symbol,
      kind: a.kind,
      name: m?.name ?? null,
      etf: m?.etf ?? false,
      recorded: true,
      held: held.has(a.symbol),
      cents: m?.cents ?? null,
      pricedOn: m?.pricedOn ?? null,
    }
    const r = q === '' ? 200 : rank(q, qKey, key, m?.nameUp ?? '', m?.wordStarts ?? [])
    if (r !== null) scored.push({ opt, score: r + boost(opt) })
  }
  if (q !== '' && o.market)
    for (const m of o.market.rows) {
      if (!kindOk(m.kind) || covered.has(`${m.kind}:${m.key}`)) continue
      const r = rank(q, qKey, m.key, m.nameUp, m.wordStarts)
      if (r === null) continue
      const opt: SymbolOption = { symbol: m.symbol, kind: m.kind, name: m.name, etf: m.etf, recorded: false, held: false, cents: m.cents, pricedOn: m.pricedOn }
      scored.push({ opt, score: r + boost(opt) })
    }
  scored.sort((a, b) => a.score - b.score || a.opt.symbol.length - b.opt.symbol.length || a.opt.symbol.localeCompare(b.opt.symbol) || a.opt.kind.localeCompare(b.opt.kind))
  return scored.slice(0, limit).map((s) => s.opt)
}

/** What a typed symbol is: recorded here (its kind fixed), and/or in the market list as a stock and/or a crypto. */
export type SymbolResolution = {
  /** The typed text, trimmed and upper-cased ('' when empty). */
  text: string
  recorded: Pick<AssetRow, 'symbol' | 'kind'> | null
  stock: MarketRow | null
  crypto: MarketRow | null
}

export function resolveSymbol(text: string, recorded: readonly Pick<AssetRow, 'symbol' | 'kind'>[], market: MarketIndex | null): SymbolResolution {
  const t = text.trim().toUpperCase()
  if (!t) return { text: '', recorded: null, stock: null, crypto: null }
  // The exact spelling wins over a class-share alias.
  const rec = recorded.find((a) => a.symbol.toUpperCase() === t) ?? recorded.find((a) => recordedMatches(a, t)) ?? null
  const rows = market?.byKey.get(symbolKey(t)) ?? []
  return {
    text: t,
    recorded: rec,
    stock: rows.find((r) => r.kind === 'stock') ?? null,
    crypto: rows.find((r) => r.kind === 'crypto' && r.key === t) ?? null,
  }
}

/**
 * The kind a typed symbol settles on.
 *  - recorded: its recorded kind, locked (the engine refuses the other).
 *  - in both market universes (BTC is a Bitcoin ETF and Bitcoin itself):
 *    `ambiguous` until someone picks — `picked` or a pick from the list.
 *  - in one: that kind, as a default (still changeable: a private share
 *    that shares a crypto ticker is a stock).
 *  - in neither: `fallback` (the account's usual kind).
 */
export function settleKind(
  r: SymbolResolution,
  picked: SymbolKind | null,
  fallback: SymbolKind,
): { kind: SymbolKind; locked: boolean; ambiguous: boolean } {
  if (r.recorded) return { kind: r.recorded.kind, locked: true, ambiguous: false }
  if (picked) return { kind: picked, locked: false, ambiguous: false }
  if (r.stock && r.crypto) return { kind: fallback, locked: false, ambiguous: true }
  if (r.stock) return { kind: 'stock', locked: false, ambiguous: false }
  if (r.crypto) return { kind: 'crypto', locked: false, ambiguous: false }
  return { kind: fallback, locked: false, ambiguous: false }
}

/** "Vanguard Total Stock Market ETF · ETF", "Bitcoin · crypto" — a market row in a few words. */
export function describeMarket(m: Pick<MarketRow, 'name' | 'etf' | 'kind'>): string {
  const what = m.kind === 'crypto' ? 'crypto' : m.etf ? 'ETF' : 'stock'
  return m.name ? `${m.name} · ${what}` : what
}

/**
 * The recorded symbols to lock kinds from: the asset list, plus anything the
 * portfolio already shows (so a held symbol is locked before the list answers).
 */
export function mergeRecorded(
  assets: readonly Pick<AssetRow, 'symbol' | 'kind'>[],
  held: readonly { symbol: string; kind: SymbolKind }[],
): Pick<AssetRow, 'symbol' | 'kind'>[] {
  const out = new Map<string, Pick<AssetRow, 'symbol' | 'kind'>>()
  for (const a of assets) out.set(a.symbol, { symbol: a.symbol, kind: a.kind })
  for (const p of held) if (!out.has(p.symbol)) out.set(p.symbol, { symbol: p.symbol, kind: p.kind })
  return [...out.values()]
}

const kindWords = (k: SymbolKind) => (k === 'crypto' ? 'crypto' : 'a stock/ETF')

/**
 * The line under the symbol box: what the typed symbol is. The market's name
 * (and last close), the recorded spelling when it was typed another way, or —
 * once the market list has loaded — that it isn't listed (fine for a fund or
 * private stock). Null while empty or ambiguous (the kind asks then).
 */
export function symbolHint(r: SymbolResolution, kind: SymbolKind, ambiguous: boolean, marketLoaded: boolean, money: (cents: number) => string): string | null {
  if (!r.text || ambiguous) return null
  const m = kind === 'crypto' ? r.crypto : r.stock
  const parts: string[] = []
  if (m) parts.push(describeMarket(m))
  if (r.recorded && r.recorded.symbol.toUpperCase() !== r.text) parts.push(`recorded as ${r.recorded.symbol} — the same ${r.recorded.kind === 'crypto' ? 'coin' : 'stock'}`)
  if (m?.cents != null) parts.push(`last ${money(m.cents)}`)
  if (!m && !r.recorded && marketLoaded) return 'Not in the market list — fine for a fund or private stock; set its price by hand in Holdings.'
  return parts.length ? parts.join(' · ') : null
}

/** Why a typed symbol needs its kind chosen: it's listed both ways. */
export function ambiguityText(r: SymbolResolution): string {
  const s = r.stock?.name ? ` (${r.stock.name})` : ''
  const c = r.crypto?.name ? ` (${r.crypto.name})` : ''
  return `${r.text} is listed both as a stock/ETF${s} and as a crypto${c} — choose which under Kind.`
}

/** "VTI is recorded as a stock/ETF" — why the kind can't change. */
export const lockedKindText = (rec: Pick<AssetRow, 'symbol' | 'kind'>): string => `${rec.symbol} is recorded as ${kindWords(rec.kind)}`
