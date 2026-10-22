import type { DbLike } from './db'
import { bad } from './errors'
import { isRealIsoDay } from '../shared/dates'

/**
 * The household's memory of the funds it asked the shared basket to cover
 * (PRIVACY.md "Anonymous add"; src/invest/suggest.ts sends the ask). A sent
 * ask is recorded here — app_meta `ui:basket-asks`, household data that rides
 * the vault like any setting — so a reload, or the other member's device,
 * doesn't offer the same fund again: a second ask would hand the server a
 * second list, and two lists with one fund in common name it. What is kept:
 * the symbol, the day, and how many symbols the request named. Not the
 * chaff, which is derived again from the key when needed, and nothing the
 * server didn't see.
 *
 *   GET /api/prices/asked         → BasketAsks
 *   PUT /api/prices/asked {symbol, k} → records (or refreshes) one; unchanged is no write
 */
export const BASKET_ASKS_KEY = 'ui:basket-asks'
export type BasketAsk = { on: string; k: number }
export type BasketAsks = Record<string, BasketAsk>

const SYMBOL = /^[A-Z][A-Z0-9.-]{0,9}$/
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

export function listBasketAsks(db: DbLike): BasketAsks {
  const raw = (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(BASKET_ASKS_KEY) as { value: string } | undefined)?.value
  if (!raw) return {}
  try {
    const x: unknown = JSON.parse(raw)
    if (!isObject(x)) return {}
    const out: BasketAsks = {}
    for (const [sym, v] of Object.entries(x))
      if (SYMBOL.test(sym) && isObject(v) && typeof v.on === 'string' && isRealIsoDay(v.on) && Number.isSafeInteger(v.k) && (v.k as number) >= 2)
        out[sym] = { on: v.on, k: v.k as number }
    return out
  } catch {
    return {}
  }
}

export function recordBasketAsk(db: DbLike, b: { symbol?: unknown; k?: unknown }, today: string): { ok: true; symbol: string; on: string; k: number } {
  const symbol = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : ''
  if (!SYMBOL.test(symbol)) bad('symbol: a ticker (letters, digits, a dot or dash)')
  if (!Number.isSafeInteger(b.k) || (b.k as number) < 2 || (b.k as number) > 64) bad('k: how many symbols the request named, 2–64')
  const k = b.k as number
  const asks = listBasketAsks(db)
  const have = asks[symbol]
  if (!have || have.on !== today || have.k !== k) {
    asks[symbol] = { on: today, k }
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(BASKET_ASKS_KEY, JSON.stringify(asks))
  }
  return { ok: true, symbol, on: today, k }
}
