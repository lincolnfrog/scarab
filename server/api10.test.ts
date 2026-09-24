import { beforeAll, describe, expect, it } from 'vitest'
import { getSeries } from '../engine/analytics'
import type { DbLike } from '../engine/db'
import { getHoldingsReturns } from '../engine/returns'
import { seedHousehold } from '../engine/test/household'

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

let db: DbLike
let mod: typeof import('./app')
beforeAll(async () => {
  mod = await import('./app')
  db = (await import('./db')).db as unknown as DbLike
})

const get = async (app: ReturnType<typeof mod.createApp>, path: string) => {
  const r = await app.request(path)
  return { status: r.status, body: (await r.json()) as Record<string, unknown> }
}

// One file-wide database: the moved routes are checked on it empty (so
// nothing reaches the network), then the series routes on a seeded household.
describe('api10: market data and series', () => {
  it('serves the price routes moved out of api2, unchanged', async () => {
    const app = mod.createApp({ zkOnly: false })
    expect(await get(app, '/api/charts/nope')).toEqual({ status: 404, body: { error: 'no such asset' } })
    const refresh = await app.request('/api/prices/refresh', { method: 'POST' })
    expect(refresh.status).toBe(200)
    expect(await refresh.json()).toEqual({ updated: 0, errors: ['no assets yet — record a trade first'] })
  })

  it('answers GET /api/series/catalog and GET /api/series exactly as the engine does', async () => {
    seedHousehold(db)
    const app = mod.createApp({ zkOnly: false })
    const today = new Date().toISOString().slice(0, 10)

    const catalog = await get(app, '/api/series/catalog')
    expect(catalog.status).toBe(200)
    expect(catalog.body.asOf).toBe(today)
    expect((catalog.body.entries as { id: string; available: boolean }[]).map((e) => e.id)).toContain('nw:equity')

    const r = await get(app, '/api/series?ids=nw:total,nw:bogus,nw:cash&from=2026-03')
    expect(r.status).toBe(200)
    expect(r.body).toEqual(getSeries(db, today, { ids: ['nw:total', 'nw:bogus', 'nw:cash'], from: '2026-03' }))
    expect(r.body.warnings).toEqual(['unknown series: nw:bogus'])
    expect((r.body.series as { points: unknown[] }[])[0]!.points.length).toBeGreaterThan(0)

    // A bare '+' decodes as a space; the id still arrives intact.
    const set = await get(app, '/api/series?ids=set:1+2:value')
    expect(set.body.warnings).toEqual([])
    expect((set.body.series as { id: string }[]).map((s) => s.id)).toEqual(['set:1+2:value'])
    expect(set.body).toEqual(await get(app, `/api/series?ids=${encodeURIComponent('set:1+2:value')}`).then((r) => r.body))
    expect((await get(app, '/api/series')).body).toEqual({ series: [], warnings: [] })
  })

  it('refuses a malformed request with a 400 and a message', async () => {
    const app = mod.createApp({ zkOnly: false })
    const seven = 'nw:total,nw:cash,nw:brokerage,nw:retirement,nw:crypto,nw:property,nw:equity'
    expect(await get(app, `/api/series?ids=${seven}`)).toEqual({ status: 400, body: { error: 'at most 6 series per request' } })
    expect((await get(app, '/api/series?ids=nw:total&from=2026')).status).toBe(400)
    expect((await get(app, '/api/series?ids=nw:total&from=2026-05&to=2026-04')).status).toBe(400)
  })

  it('serves saved views: new ones stamped with the caller, a bad list refused with a 400', async () => {
    const app = mod.createApp({ zkOnly: false })
    const put = (body: unknown) =>
      app.request('/api/series/views', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(await get(app, '/api/series/views')).toEqual({ status: 200, body: [] })
    const saved = await put([{ id: 'v1', name: 'Stocks', ids: ['set:1+2:value'], mode: 'rebased', by: 'forged' }])
    expect(saved.status).toBe(200)
    const [v] = (await saved.json()) as Record<string, unknown>[]
    expect(v).toMatchObject({ id: 'v1', name: 'Stocks', ids: ['set:1+2:value'], mode: 'rebased', by: 'dev@localhost' })
    expect(Date.parse(v!.created_at as string)).not.toBeNaN()
    expect((await get(app, '/api/series/views')).body).toEqual([v])

    expect((await put({ id: 'v1' })).status).toBe(400)
    const notJson = await app.request('/api/series/views', { method: 'PUT', body: 'nope' })
    expect(notJson.status).toBe(400)
    expect((await get(app, '/api/series/views')).body).toEqual([v]) // untouched
  })

  it('serves holdings returns exactly as the engine does', async () => {
    const app = mod.createApp({ zkOnly: false })
    const today = new Date().toISOString().slice(0, 10)
    const r = await get(app, '/api/portfolio/returns')
    expect(r.status).toBe(200)
    expect(r.body).toEqual(getHoldingsReturns(db, today))
    expect((r.body.rows as { symbol: string }[]).map((x) => x.symbol).sort()).toEqual(['BTC', 'QQQ', 'VTI'])
  })

  it('is plaintext-only: a vault-only server refuses every api10 route', async () => {
    const app = mod.createApp({ zkOnly: true })
    for (const [method, p] of [
      ['GET', '/api/series/catalog'],
      ['GET', '/api/series?ids=nw:total'],
      ['GET', '/api/series/views'],
      ['PUT', '/api/series/views'],
      ['GET', '/api/portfolio/returns'],
      ['GET', '/api/charts/VTI'],
      ['POST', '/api/prices/refresh'],
    ] as const)
      expect((await app.request(p, { method })).status, `${method} ${p}`).toBe(403)
  })
})
