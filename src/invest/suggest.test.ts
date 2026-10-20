import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fundTickers } from './fundTickers'
import type { MarketSymbols } from './marketSymbols'
import { canSuggest, onSuggestChange, resetSuggestions, scheduleSuggest, SUGGEST_DELAY_MAX_MS, SUGGEST_DELAY_MIN_MS, SUGGEST_K, suggestState } from './suggest'

const recorded: { method: string; url: string; body: unknown }[] = []
vi.mock('../local', () => ({
  localMode: { vault: null, active: true },
  localDispatch: async (method: string, url: string, body: unknown) => {
    recorded.push({ method, url, body })
    return { ok: true }
  },
}))

const market = (stocks: string[], crypto: string[] = []): MarketSymbols => ({
  stocks: new Set(stocks),
  crypto: new Set(crypto),
  quotes: new Map(),
  index: { rows: [], byKey: new Map() },
})

describe('canSuggest', () => {
  it('offers the ask for a registered fund the basket lacks, and not for what the basket quotes or what isn’t a fund', () => {
    const m = market(['SPY', 'BRK-B', 'VTI'], ['BTC'])
    expect(canSuggest('VFIAX', m)).toBe('yes')
    expect(canSuggest('vfiax', m)).toBe('yes')
    expect(canSuggest('SPY', m)).toBe('in-basket')
    expect(canSuggest('BRK.B', m)).toBe('in-basket')
    expect(canSuggest('BTC', m)).toBe('in-basket')
    expect(canSuggest('ACME', m)).toBe('not-a-fund') // private stock
    expect(canSuggest('VFIAX', null)).toBe('yes') // the market list not loaded yet: the fund list decides
    // The vault remembers a sent ask: not offered again, unless the basket has it by now.
    expect(canSuggest('VFIAX', m, { VFIAX: { on: '2026-10-19', k: 32 } })).toBe('asked')
    expect(canSuggest('SPY', m, { SPY: { on: '2026-10-19', k: 32 } })).toBe('in-basket')
  })
})

describe('scheduleSuggest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSuggestions()
    recorded.length = 0
  })

  it('refuses to schedule without the market list (the chaff would include symbols the basket quotes)', async () => {
    await expect(scheduleSuggest('VFIAX', null, { send: async () => ({ added: 0 }) })).rejects.toThrow(/market list/)
    expect(suggestState('VFIAX')).toBeNull()
  })
  afterEach(() => vi.useRealTimers())

  it('draws the chaff, waits a random delay inside the window, sends once, and reports each state', async () => {
    const sent: string[][] = []
    const send = async (symbols: string[]) => {
      sent.push(symbols)
      return { added: symbols.length }
    }
    const seen: string[] = []
    const off = onSuggestChange(() => seen.push(suggestState('VFIAX')?.state ?? 'none'))
    let r = 0.5
    const random = () => r
    const t0 = Date.now()
    const scheduled = await scheduleSuggest('vfiax', market(['SPY']), { send, random, now: () => t0 })
    const at = t0 + SUGGEST_DELAY_MIN_MS + Math.floor(0.5 * (SUGGEST_DELAY_MAX_MS - SUGGEST_DELAY_MIN_MS))
    expect(scheduled).toEqual({ state: 'scheduled', symbol: 'VFIAX', k: SUGGEST_K, at })
    expect(suggestState('VFIAX')).toEqual(scheduled)
    // Asking again while scheduled changes nothing.
    r = 0.1
    expect(await scheduleSuggest('VFIAX', market(['SPY']), { send, random })).toEqual(scheduled)
    await vi.advanceTimersByTimeAsync(SUGGEST_DELAY_MIN_MS - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(at - t0)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toHaveLength(SUGGEST_K)
    expect(sent[0]).toContain('VFIAX')
    expect(sent[0]!.every((s) => fundTickers().includes(s))).toBe(true)
    expect(suggestState('VFIAX')).toEqual({ state: 'sent', symbol: 'VFIAX', k: SUGGEST_K, added: SUGGEST_K })
    expect(seen).toEqual(['scheduled', 'sending', 'sent'])
    // Once sent, the ask is recorded in the vault through the tab's own dispatch (PUT /api/prices/asked).
    expect(recorded).toEqual([{ method: 'PUT', url: '/api/prices/asked', body: { symbol: 'VFIAX', k: SUGGEST_K } }])
    // Sent: asking again in this tab does nothing more.
    expect((await scheduleSuggest('VFIAX', market(['SPY']), { send, random })).state).toBe('sent')
    await vi.advanceTimersByTimeAsync(SUGGEST_DELAY_MAX_MS)
    expect(sent).toHaveLength(1)
    off()
  })

  it('a refused request is reported, and can be asked again', async () => {
    const send = vi.fn(async () => {
      throw new Error('the basket took a suggestion less than a minute ago')
    })
    await scheduleSuggest('SWPPX', market([]), { send, random: () => 0 })
    await vi.advanceTimersByTimeAsync(SUGGEST_DELAY_MIN_MS + 1)
    expect(suggestState('SWPPX')).toEqual({ state: 'failed', symbol: 'SWPPX', k: SUGGEST_K, error: 'the basket took a suggestion less than a minute ago' })
    expect(recorded).toEqual([]) // nothing was sent, so nothing is remembered
    const again = await scheduleSuggest('SWPPX', market([]), { send, random: () => 0 })
    expect(again.state).toBe('scheduled')
  })

  it('the delay never falls outside the window', async () => {
    const t0 = Date.now()
    for (const r of [0, 0.999_999, 0.42]) {
      resetSuggestions()
      const s = await scheduleSuggest('VBTLX', market([]), { send: async () => ({ added: 0 }), random: () => r, now: () => t0 })
      expect(s.state === 'scheduled' && s.at - t0).toBeGreaterThanOrEqual(SUGGEST_DELAY_MIN_MS)
      expect(s.state === 'scheduled' && s.at - t0).toBeLessThan(SUGGEST_DELAY_MAX_MS)
    }
  })
})
