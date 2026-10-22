import { describe, expect, it } from 'vitest'
import { ApiError } from './errors'
import { BASKET_ASKS_KEY, listBasketAsks, recordBasketAsk } from './basket-asks'
import { onBothEngines } from './test/parity'

describe('the vault’s memory of basket asks', () => {
  it('records a sent ask under a ui:* key (household data), refreshes it, refuses junk, and reads back the same on both engines', async () => {
    const { server, browser } = await onBothEngines(
      () => {},
      (db) => {
        expect(listBasketAsks(db)).toEqual({})
        expect(recordBasketAsk(db, { symbol: 'vfiax', k: 32 }, '2026-10-20')).toEqual({ ok: true, symbol: 'VFIAX', on: '2026-10-20', k: 32 })
        recordBasketAsk(db, { symbol: 'SWPPX', k: 32 }, '2026-10-21')
        recordBasketAsk(db, { symbol: 'VFIAX', k: 32 }, '2026-10-22') // asked again (another device): the later day stands
        for (const bad of [{ symbol: '', k: 32 }, { symbol: 'VFIAX' }, { symbol: 'VFIAX', k: 1 }, { symbol: 'VFIAX', k: 65 }, { symbol: '__proto__', k: 3 }, { k: 3 }])
          expect(() => recordBasketAsk(db, bad as never, '2026-10-22'), JSON.stringify(bad)).toThrow(ApiError)
        const key = (db.prepare('SELECT key FROM app_meta WHERE key = ?').get(BASKET_ASKS_KEY) as { key: string }).key
        return { asks: listBasketAsks(db), key }
      },
    )
    expect(browser).toEqual(server)
    expect(server.key).toBe('ui:basket-asks')
    expect(server.asks).toEqual({ VFIAX: { on: '2026-10-22', k: 32 }, SWPPX: { on: '2026-10-21', k: 32 } })
  })

  it('ignores a malformed stored value and keeps only well-formed entries', async () => {
    const { server, browser } = await onBothEngines(
      (db) => db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(BASKET_ASKS_KEY, JSON.stringify({ VFIAX: { on: '2026-10-20', k: 32 }, bad: { on: 'x', k: 32 }, 'A B': { on: '2026-10-20', k: 3 }, NOK: { on: '2026-10-20', k: 1 } })),
      (db) => listBasketAsks(db),
    )
    expect(browser).toEqual(server)
    expect(server).toEqual({ VFIAX: { on: '2026-10-20', k: 32 } })
  })
})
