import { localMode } from '../local'
import { pickChaff, SUGGEST_K } from './chaff'
import { fundTickers, isFundTicker } from './fundTickers'
import type { MarketSymbols } from './marketSymbols'

/**
 * "Ask the basket to cover this fund": the request, scheduled after a random
 * delay and sent once per symbol per tab (PRIVACY.md "Anonymous add").
 *
 * The delay — between SUGGEST_DELAY_MIN_MS and SUGGEST_DELAY_MAX_MS, while
 * the tab stays open — unhooks the request from the moment the fund was
 * recorded: a save (ciphertext, but visible as a save) followed at once by a
 * suggestion would say "the household just recorded one of these k". The
 * view shows the state; nothing about it is stored anywhere.
 */
export const SUGGEST_DELAY_MIN_MS = 30_000
export const SUGGEST_DELAY_MAX_MS = 10 * 60_000

export type SuggestState =
  | { state: 'scheduled'; symbol: string; k: number; at: number }
  | { state: 'sending'; symbol: string; k: number }
  | { state: 'sent'; symbol: string; k: number; added: number }
  | { state: 'failed'; symbol: string; k: number; error: string }

const states = new Map<string, SuggestState>()
const listeners = new Set<() => void>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const announce = () => listeners.forEach((l) => l())

export function suggestState(symbol: string): SuggestState | null {
  return states.get(symbol.trim().toUpperCase()) ?? null
}
export function onSuggestChange(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** Can this holding be asked for: a registered fund's ticker that the basket doesn't quote? */
export function canSuggest(symbol: string, market: MarketSymbols | null): 'yes' | 'in-basket' | 'not-a-fund' {
  const s = symbol.trim().toUpperCase()
  if (market && (market.stocks.has(s.replace(/\./g, '-')) || market.crypto.has(s))) return 'in-basket'
  return isFundTicker(s) ? 'yes' : 'not-a-fund'
}

export type SuggestDeps = {
  /** POST /api/basket/suggest; the default fetches it. */
  send?: (symbols: string[]) => Promise<{ added: number }>
  random?: () => number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
}

async function defaultSend(symbols: string[]): Promise<{ added: number }> {
  const r = await fetch('/api/basket/suggest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ symbols }) })
  const body = (await r.json().catch(() => ({}))) as { added?: number; error?: string }
  if (!r.ok) throw new Error(body.error ?? `${r.status} ${r.statusText}`)
  return { added: typeof body.added === 'number' ? body.added : 0 }
}

/**
 * Schedule the ask for one fund. Draws the chaff now (so the view can say how
 * many), waits the random delay, sends. A symbol already scheduled or sent in
 * this tab is left alone.
 */
export async function scheduleSuggest(symbol: string, market: MarketSymbols | null, deps: SuggestDeps = {}): Promise<SuggestState> {
  const s = symbol.trim().toUpperCase()
  const have = states.get(s)
  if (have && have.state !== 'failed') return have
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? setTimeout
  const exclude = new Set<string>([...(market?.stocks ?? []), ...(market?.crypto ?? [])])
  const symbols = await pickChaff({ symbol: s, population: fundTickers(), exclude, secret: localMode.vault?.rawDataKey ?? null, random })
  const delay = SUGGEST_DELAY_MIN_MS + Math.floor(random() * (SUGGEST_DELAY_MAX_MS - SUGGEST_DELAY_MIN_MS))
  const scheduled: SuggestState = { state: 'scheduled', symbol: s, k: symbols.length, at: now() + delay }
  states.set(s, scheduled)
  announce()
  timers.set(
    s,
    setTimer(async () => {
      timers.delete(s)
      states.set(s, { state: 'sending', symbol: s, k: symbols.length })
      announce()
      try {
        const r = await (deps.send ?? defaultSend)(symbols)
        states.set(s, { state: 'sent', symbol: s, k: symbols.length, added: r.added })
      } catch (e) {
        states.set(s, { state: 'failed', symbol: s, k: symbols.length, error: e instanceof Error ? e.message : String(e) })
      }
      announce()
    }, delay),
  )
  return scheduled
}

/** Tests only. */
export function resetSuggestions(): void {
  for (const t of timers.values()) clearTimeout(t)
  timers.clear()
  states.clear()
}

export { SUGGEST_K }
