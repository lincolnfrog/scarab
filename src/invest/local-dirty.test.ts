import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The real in-tab engine (sql.js) in node, as src/local/dispatch.test.ts runs it.
vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})
vi.stubGlobal('window', new EventTarget())

type Local = typeof import('../local')
let local: Local
const writes: string[] = []
const record = (e: Event) => writes.push(e.type)

beforeAll(async () => {
  local = await import('../local')
  window.addEventListener('scarab-write', record)
})
afterAll(() => vi.unstubAllGlobals())

const call = (method: string, url: string, body?: unknown) => local.localDispatch(method, url, body)

let lots = 0
let k = 0
beforeEach(async () => {
  await local.enterLocalMode(null)
  lots = ((await call('POST', '/api/invest/accounts', { name: 'Schwab', kind: 'brokerage', tracking: 'lots' })) as { id: number }).id
  k = ((await call('POST', '/api/invest/accounts', { name: '401(k)', kind: 'retirement', tracking: 'balance' })) as { id: number }).id
  local.localMode.markSaved(1)
  writes.length = 0
})

/**
 * The brokerage routes this pass adds, under the tab's dirty rule: a refused
 * or no-op request leaves the session clean (no vault version for nothing),
 * a real change dirties it once.
 */
describe('brokerage writes in a zero-knowledge tab', () => {
  it('starting positions: a paste with a bad row writes nothing and stays clean; a good one dirties', async () => {
    const refused = (await call('POST', '/api/trades/opening', {
      investAccountId: lots,
      asOf: '2026-09-01',
      rows: [
        { symbol: 'VTI', qty: '10', basisCents: 1_000_00, acquiredOn: '2019-03-15' },
        { symbol: 'QQQ', qty: 'ten', basisCents: 1_000_00 },
      ],
    })) as { created: number; errors: unknown[] }
    expect(refused).toMatchObject({ created: 0, errors: [{ row: 1 }] })
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])

    const ok = (await call('POST', '/api/trades/opening', {
      investAccountId: lots,
      asOf: '2026-09-01',
      rows: [{ symbol: 'VTI', qty: '10', basisCents: 1_000_00, acquiredOn: '2019-03-15' }],
    })) as { created: number }
    expect(ok.created).toBe(1)
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])
  })

  it('a hand-entered price persists: it dirties the tab (unlike a basket refresh)', async () => {
    await call('POST', '/api/trades/opening', { investAccountId: lots, asOf: '2026-09-01', rows: [{ symbol: 'FXAIX', qty: '1', basisCents: 100_00 }] })
    local.localMode.markSaved(2)
    writes.length = 0
    await expect(call('POST', '/api/prices/manual', { symbol: 'FXAIX', pricedOn: '2999-01-01', cents: 100 })).rejects.toThrow(/after today/)
    expect(local.localMode.dirty).toBe(false)
    await call('POST', '/api/prices/manual', { symbol: 'FXAIX', pricedOn: '2026-09-01', cents: 101_00 })
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])
  })

  it('balance history: a refused batch stays clean; a batch and a delete each dirty; a missing day 404s clean', async () => {
    await expect(
      call('PUT', '/api/invest/balances', { investAccountId: k, balances: [{ balancedOn: '2026-03-31', balanceCents: 1 }, { balancedOn: '2026-02-30', balanceCents: 1 }] }),
    ).rejects.toThrow(/balances\[1\]/)
    expect(local.localMode.dirty).toBe(false)

    await call('PUT', '/api/invest/balances', { investAccountId: k, balances: [{ balancedOn: '2026-03-31', balanceCents: 1 }, { balancedOn: '2026-06-30', balanceCents: 2 }] })
    expect(local.localMode.dirty).toBe(true)
    expect(await call('GET', `/api/invest/balances?accountId=${k}`)).toEqual([
      { invest_account_id: k, balanced_on: '2026-06-30', balance_cents: 2 },
      { invest_account_id: k, balanced_on: '2026-03-31', balance_cents: 1 },
    ])

    local.localMode.markSaved(3)
    await expect(call('DELETE', `/api/invest/balances/${k}/2025-12-31`)).rejects.toThrow(/no balance is recorded/)
    expect(local.localMode.dirty).toBe(false)
    await call('DELETE', `/api/invest/balances/${k}/2026-06-30`)
    expect(local.localMode.dirty).toBe(true)
    expect(await call('GET', '/api/invest/balances')).toEqual([{ invest_account_id: k, balanced_on: '2026-03-31', balance_cents: 1 }])
  })

  it('trades: a preview never dirties; a refused or unchanged edit stays clean; an edit and a delete each dirty once', async () => {
    const buy = { investAccountId: lots, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2024-03-04', qty: '10', totalCents: 1_000_00 }
    const lot = ((await call('POST', '/api/trades', buy)) as { id: number }).id
    const sale = { ...buy, side: 'sell', tradedOn: '2026-05-01', qty: '4', totalCents: 800_00 }
    const sell = ((await call('POST', '/api/trades', sale)) as { id: number }).id
    local.localMode.markSaved(2)
    writes.length = 0

    const preview = (await call('POST', '/api/trades/preview', { ...sale, qty: '2', totalCents: 400_00 })) as { realized: { ltCents: number } }
    expect(preview.realized.ltCents).toBe(200_00)
    await expect(call('POST', '/api/trades/preview', { ...sale, tradedOn: '2999-01-01' })).rejects.toThrow(/after today/)
    expect(await call('GET', `/api/trades?accountId=${lots}&year=2026`)).toMatchObject([{ id: sell, realized: { lt_cents: 400_00 } }])
    await expect(call('PATCH', `/api/trades/${lot}`, { qty: '3' })).rejects.toThrow(/short/)
    expect(await call('PATCH', `/api/trades/${lot}`, { totalCents: 1_000_00 })).toMatchObject({ changed: false })
    await expect(call('DELETE', '/api/trades/999999')).rejects.toThrow(/no such trade/)
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])

    expect(await call('PATCH', `/api/trades/${lot}`, { totalCents: 1_200_00 })).toMatchObject({ changed: true, affected: 1 })
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])

    local.localMode.markSaved(3)
    writes.length = 0
    expect(await call('DELETE', `/api/trades/${lot}`)).toMatchObject({ rewritten: 1 })
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])
  })

  it('the account drawer: reading never dirties; a refused or unchanged patch stays clean; a real one dirties once (B8)', async () => {
    const detail = (await call('GET', `/api/invest/accounts/${lots}`)) as { account: { id: number } }
    expect(detail.account.id).toBe(lots)
    await call('GET', '/api/invest/owners')
    expect(local.localMode.dirty).toBe(false)

    await call('PUT', '/api/invest/balances', { investAccountId: k, balancedOn: '2026-06-30', balanceCents: 1_00 })
    local.localMode.markSaved(2)
    writes.length = 0
    await expect(call('PATCH', `/api/invest/accounts/${k}`, { tracking: 'lots' })).rejects.toThrow(/1 balance update/)
    expect(await call('PATCH', `/api/invest/accounts/${lots}`, { name: 'Schwab', owner: 'joint' })).toMatchObject({ changed: false })
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])

    expect(await call('PATCH', `/api/invest/accounts/${lots}`, { subtype: 'taxable', owner: 'Max', mask: '9876' })).toMatchObject({ changed: true })
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])
  })

  it('a vest: refused stays clean; a net-settled one dirties once; an unchanged vest edit stays clean (B9)', async () => {
    await call('PATCH', `/api/invest/accounts/${lots}`, { stockPlan: true })
    await call('PUT', '/api/unvested', { investAccountId: lots, symbol: 'ACME', qty: '100' })
    local.localMode.markSaved(2)
    writes.length = 0
    const body = { investAccountId: lots, symbol: 'ACME', qty: '25', tradedOn: '2026-08-15', totalCents: 10_000_00 }
    await expect(call('POST', '/api/unvested/vest', { ...body, withheldQty: '26' })).rejects.toThrow(/more than the 25/)
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])

    const r = (await call('POST', '/api/unvested/vest', { ...body, withheldQty: '9' })) as { tradeId: number; withholdingTradeId: number }
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write'])

    local.localMode.markSaved(3)
    writes.length = 0
    expect(await call('PATCH', `/api/trades/${r.withholdingTradeId}`, { qty: '9' })).toMatchObject({ changed: false })
    await expect(call('PATCH', `/api/trades/${r.withholdingTradeId}`, { totalCents: 1 })).rejects.toThrow(/worth what they were at the vest/)
    const pf = (await call('GET', '/api/portfolio')) as { accounts: { cash_cents: number | null }[] }
    expect(pf.accounts[0]!.cash_cents).toBeNull()
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])
  })

  it('reading symbols, the check-in and the realized report never dirties; a check-in sitting dirties once per number saved (B10, B11, B14)', async () => {
    await call('POST', '/api/trades', { investAccountId: lots, symbol: 'BRK.B', assetKind: 'stock', side: 'buy', tradedOn: '2026-03-02', qty: '1', totalCents: 400_00 })
    const house = ((await call('POST', '/api/properties', { name: 'House' })) as { id: number }).id
    local.localMode.markSaved(2)
    writes.length = 0
    expect(await call('GET', '/api/invest/assets')).toEqual([{ id: expect.any(Number), symbol: 'BRK.B', kind: 'stock' }])
    const checkin = (await call('GET', '/api/invest/checkin')) as { items: { kind: string; id: number }[] }
    expect(checkin.items.map((i) => `${i.kind}:${i.id}`)).toEqual([`balance:${k}`, `cash:${lots}`, `property:${house}`])
    expect(await call('GET', '/api/invest/realized?year=2026')).toMatchObject({ year: 2026, lines: [] })
    await expect(call('GET', '/api/invest/realized?year=nope')).rejects.toThrow(/year must be/)
    expect(local.localMode.dirty).toBe(false)
    expect(writes).toEqual([])

    // The drawer saves each number through its own route.
    await call('PUT', '/api/invest/balances', { investAccountId: k, balancedOn: '2026-09-01', balanceCents: 45_000_00 })
    await call('PUT', `/api/properties/${house}/valuation`, { valuedOn: '2026-09-01', valueCents: 900_000_00 })
    expect(local.localMode.dirty).toBe(true)
    expect(writes).toEqual(['scarab-write', 'scarab-write'])
  })
})
