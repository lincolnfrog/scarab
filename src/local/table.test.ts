import { describe, expect, it } from 'vitest'
import { loadRoutes } from './routes'
import { matchRoute, policyOf, r, type LocalRoute } from './table'

const noop = () => null
const paths = (hit: ReturnType<typeof matchRoute>) => hit && `${hit.route.method} ${hit.route.path}`

describe('matchRoute', () => {
  const routes: LocalRoute[] = [
    r('GET', '/invest/accounts', noop),
    r('PATCH', '/invest/accounts/:id', noop),
    r('DELETE', '/invest/accounts/:id', noop),
    r('PUT', '/properties/:id/valuation', noop),
    r('GET', '/charts/:symbol', noop),
    r('POST', '/scenarios/compare', noop),
    r('POST', '/scenarios/:id', noop), // same shape as the literal above; listed after it
  ]

  it('matches literal paths by method', () => {
    expect(paths(matchRoute(routes, 'GET', '/invest/accounts'))).toBe('GET /invest/accounts')
    expect(matchRoute(routes, 'POST', '/invest/accounts')).toBeNull()
    expect(matchRoute(routes, 'GET', '/invest')).toBeNull()
  })

  it('treats the method case-insensitively and literals case-sensitively', () => {
    expect(paths(matchRoute(routes, 'get', '/invest/accounts'))).toBe('GET /invest/accounts')
    expect(matchRoute(routes, 'GET', '/Invest/accounts')).toBeNull()
  })

  it('binds :params, including one in the middle of a path', () => {
    expect(matchRoute(routes, 'DELETE', '/invest/accounts/3')?.params).toEqual({ id: '3' })
    const hit = matchRoute(routes, 'PUT', '/properties/12/valuation')
    expect(paths(hit)).toBe('PUT /properties/:id/valuation')
    expect(hit?.params).toEqual({ id: '12' })
  })

  it('decodes params, keeping text that is not valid percent-encoding as sent', () => {
    expect(matchRoute(routes, 'GET', '/charts/BRK.B')?.params).toEqual({ symbol: 'BRK.B' })
    expect(matchRoute(routes, 'GET', '/charts/A%20B')?.params).toEqual({ symbol: 'A B' })
    expect(matchRoute(routes, 'GET', '/charts/a%2Fb')?.params).toEqual({ symbol: 'a/b' }) // one segment, decoded after the split
    expect(matchRoute(routes, 'GET', '/charts/%E0%A4%A')?.params).toEqual({ symbol: '%E0%A4%A' })
  })

  it('requires the exact segment count', () => {
    // The bug this table exists for: a longer path under a shared prefix
    // (a future DELETE /invest/balances/3/2026-06-30, say) must not land in a
    // shorter route's handler.
    expect(matchRoute(routes, 'DELETE', '/invest/accounts/3/2026-06-30')).toBeNull()
    expect(matchRoute(routes, 'DELETE', '/invest/accounts')).toBeNull()
    expect(matchRoute(routes, 'PUT', '/properties/12')).toBeNull()
    expect(matchRoute(routes, 'PUT', '/properties/12/valuation/x')).toBeNull()
  })

  it('never matches a trailing slash or an empty param', () => {
    expect(matchRoute(routes, 'GET', '/invest/accounts/')).toBeNull()
    expect(matchRoute(routes, 'DELETE', '/invest/accounts/')).toBeNull()
    expect(matchRoute(routes, 'PUT', '/properties//valuation')).toBeNull()
    expect(matchRoute(routes, 'GET', 'invest/accounts')).toBeNull()
  })

  it('takes the first match in list order', () => {
    expect(paths(matchRoute(routes, 'POST', '/scenarios/compare'))).toBe('POST /scenarios/compare')
    expect(paths(matchRoute(routes, 'POST', '/scenarios/7'))).toBe('POST /scenarios/:id')
    const flipped = [r('POST', '/scenarios/:id', noop), r('POST', '/scenarios/compare', noop)]
    expect(paths(matchRoute(flipped, 'POST', '/scenarios/compare'))).toBe('POST /scenarios/:id')
  })
})

describe('r', () => {
  it("defaults writes to 'auto' and forces GET to 'never'", () => {
    expect(r('POST', '/trades', noop).dirty).toBe('auto')
    expect(r('POST', '/prices/refresh', noop, 'never').dirty).toBe('never')
    expect(r('GET', '/trades', noop).dirty).toBe('never')
    expect(r('GET', '/trades', noop, 'auto').dirty).toBe('never')
    // A route built by hand still runs GET as 'never'.
    expect(policyOf({ method: 'GET', path: '/x', handler: noop, dirty: 'auto' })).toBe('never')
    expect(policyOf({ method: 'PUT', path: '/x', handler: noop })).toBe('auto')
  })

  it('refuses paths that cannot match a server route', () => {
    for (const bad of ['trades', '/api/trades', '/trades/', '/', '', '/trades//x', '/trades?x=1'])
      expect(() => r('GET', bad, noop), bad).toThrow(/local route path/)
  })
})

describe('the real table', () => {
  it('sends invest paths to exactly one handler each', async () => {
    const routes = await loadRoutes()
    expect(paths(matchRoute(routes, 'DELETE', '/invest/accounts/3'))).toBe('DELETE /invest/accounts/:id')
    expect(paths(matchRoute(routes, 'DELETE', '/invest/balances/3/2026-06-30'))).toBe('DELETE /invest/balances/:accountId/:date')
    expect(matchRoute(routes, 'DELETE', '/invest/accounts/3/x')).toBeNull()
    expect(paths(matchRoute(routes, 'PUT', '/invest/balances'))).toBe('PUT /invest/balances')
    expect(paths(matchRoute(routes, 'POST', '/unvested/vest'))).toBe('POST /unvested/vest')
    expect(paths(matchRoute(routes, 'PUT', '/unvested'))).toBe('PUT /unvested')
  })

  it("marks the read-like and refetchable writes 'never', and real writes 'auto'", async () => {
    const policy = new Map((await loadRoutes()).map((rt) => [`${rt.method} ${rt.path}`, policyOf(rt)]))
    for (const k of ['POST /prices/refresh', 'POST /scenarios/compare', 'POST /scenarios/price', 'POST /simulate'])
      expect(policy.get(k), k).toBe('never')
    for (const k of ['POST /trades', 'PUT /goal', 'POST /imports', 'POST /digest/ack', 'POST /import', 'PUT /unvested'])
      expect(policy.get(k), k).toBe('auto')
  })
})
