import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRoute, isScreenId, parseHash, SCREENS, type RouteTarget } from './router'

describe('parseHash', () => {
  it('reads screen, sections and params', () => {
    expect(parseHash('#/cash?cat=12&month=2026-08')).toEqual({ screen: 'cash', rest: [], params: { cat: '12', month: '2026-08' }, state: {} })
    expect(parseHash('#/tax/paychecks')).toEqual({ screen: 'tax', rest: ['paychecks'], params: {}, state: {} })
    expect(parseHash('#/invest/a/b?d=trade')).toMatchObject({ screen: 'invest', rest: ['a', 'b'], params: { d: 'trade' } })
  })

  it('treats an empty or unknown fragment as the Dashboard, dropping the rest of it', () => {
    for (const h of ['', '#', '#/', '#//', '#/nope', '#/nope/x?cat=1', '#main', '#/CASH', '#/constructor', '#/__proto__'])
      expect(parseHash(h), h).toEqual({ screen: 'dash', rest: [], params: {}, state: {} })
  })

  it('accepts the fragment with or without "#" and the leading slash, and ignores empty segments', () => {
    for (const h of ['#/cash', 'cash', '/cash', '#cash', '#/cash/', '#//cash//'])
      expect(parseHash(h), h).toEqual({ screen: 'cash', rest: [], params: {}, state: {} })
    expect(parseHash('#/tax//paychecks/').rest).toEqual(['paychecks'])
  })

  it('decodes escapes, survives malformed ones', () => {
    expect(parseHash('#/tax/pay%2Dchecks').rest).toEqual(['pay-checks'])
    expect(parseHash('#/cash?month=2026%2D08').params).toEqual({ month: '2026-08' })
    expect(parseHash('#/tax/100%/paychecks')).toMatchObject({ screen: 'tax', rest: ['paychecks'] })
  })

  it('keeps the first of a repeated key', () => {
    expect(parseHash('#/cash?cat=1&cat=2').params).toEqual({ cat: '1' })
  })

  it('ignores sections, keys and values formatRoute could never have written (a pasted or old URL)', () => {
    const p = parseHash('#/cash?__proto__=x&a%20b=1&q.x=2&q=trader+joes&amt=%2412.50&ok=3').params
    expect(p).toEqual({ ok: '3' })
    expect(Object.getPrototypeOf(p)).toBe(Object.prototype)
    expect(parseHash('#/cash/Blue%20Bottle/ok').rest).toEqual(['ok'])
    // …so whatever a Route carries formats again without tripping the privacy check
    const r = parseHash('#/cash/Blue%20Bottle?q=a%20b&cat=3')
    expect(formatRoute({ screen: r.screen, rest: r.rest, params: r.params })).toBe('#/cash?cat=3')
  })

  it('returns frozen parts', () => {
    const r = parseHash('#/tax/paychecks?year=2026')
    expect(Object.isFrozen(r.rest)).toBe(true)
    expect(Object.isFrozen(r.params)).toBe(true)
    expect(Object.isFrozen(r.state)).toBe(true)
  })
})

describe('formatRoute', () => {
  it('writes screen, sections and params in order', () => {
    expect(formatRoute({ screen: 'cash', params: { cat: 12, month: '2026-08' } })).toBe('#/cash?cat=12&month=2026-08')
    expect(formatRoute({ screen: 'tax', rest: ['paychecks'] })).toBe('#/tax/paychecks')
    expect(formatRoute({ screen: 'dash' })).toBe('#/dash')
    expect(formatRoute({ screen: 'invest', params: { d: 'trade', acct: 3, lot: -1 } })).toBe('#/invest?d=trade&acct=3&lot=-1')
  })

  it('leaves out undefined params and an empty query', () => {
    expect(formatRoute({ screen: 'cash', params: { cat: undefined, month: '2026-08' } })).toBe('#/cash?month=2026-08')
    expect(formatRoute({ screen: 'cash', params: { cat: undefined } })).toBe('#/cash')
  })

  it('round-trips through parseHash', () => {
    const targets: RouteTarget[] = [
      { screen: 'cash', params: { cat: '12', month: '2026-08' } },
      { screen: 'tax', rest: ['paychecks'] },
      { screen: 'invest', params: { d: 'trade', acct: '3', lot: '41' } },
      { screen: 'compare', params: { v: 'v-3f2a' } },
    ]
    for (const t of targets) {
      const h = formatRoute(t)
      const r = parseHash(h)
      expect(formatRoute({ screen: r.screen, rest: r.rest, params: r.params }), h).toBe(h)
      expect(r.params).toEqual(t.params ?? {})
    }
  })

  describe('privacy: only hash-safe values reach the URL', () => {
    const unsafe: [string, RouteTarget][] = [
      ['search text', { screen: 'cash', params: { q: 'trader joes' } }],
      ['a dotted ticker', { screen: 'invest', params: { sym: 'BRK.B' } }],
      ['an amount', { screen: 'goal', params: { target: '$680,000' } }],
      ['a fractional number', { screen: 'goal', params: { target: 680000.5 } }],
      ['a huge number', { screen: 'goal', params: { n: 1e21 } }],
      ['NaN', { screen: 'goal', params: { n: Number.NaN } }],
      ['an empty value', { screen: 'cash', params: { q: '' } }],
      ['a long value', { screen: 'cash', params: { q: 'a'.repeat(25) } }],
      ['a merchant in a section', { screen: 'cash', rest: ['Blue Bottle'] }],
      ['an odd key', { screen: 'cash', params: { 'my key': '1' } }],
      ['an unknown screen', { screen: 'nope' as never }],
    ]

    it.each(unsafe)('throws in development for %s', (_, t) => {
      expect(() => formatRoute(t)).toThrow(/can't go in the URL/)
    })

    afterEach(() => {
      vi.unstubAllEnvs()
      vi.restoreAllMocks()
    })

    it('drops the value in production, and logs without it', () => {
      vi.stubEnv('DEV', false)
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      expect(formatRoute({ screen: 'cash', params: { q: 'trader joes', cat: 12 } })).toBe('#/cash?cat=12')
      expect(formatRoute({ screen: 'goal', params: { target: 680000.5 } })).toBe('#/goal')
      expect(formatRoute({ screen: 'cash', rest: ['Blue Bottle', 'ok'] })).toBe('#/cash/ok')
      expect(formatRoute({ screen: 'nope' as never })).toBe('#/dash')
      expect(log).toHaveBeenCalledTimes(4)
      expect(log.mock.calls.flat().join(' ')).not.toMatch(/trader|680000|Blue/)
    })
  })
})

describe('SCREENS', () => {
  it('lists every screen once, in nav order, with Compare between Future and Data & Vault', () => {
    const ids = SCREENS.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['dash', 'invest', 're', 'cash', 'goal', 'tax', 'future', 'compare', 'vault'])
    for (const id of ids) expect(isScreenId(id)).toBe(true)
    expect(isScreenId('toString')).toBe(false)
  })
})

describe('useRouteState carry-over (carryRouteState)', () => {
  /** Just enough of a browser for the router: a session history of { state, url } entries. */
  function fakeBrowser(start: string) {
    const entries: { state: unknown; url: string }[] = [{ state: null, url: `/${start}` }]
    let at = 0
    const hashOf = (url: string) => (url.includes('#') ? url.slice(url.indexOf('#')) : '')
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('location', {
      pathname: '/',
      search: '',
      get hash() {
        return hashOf(entries[at]!.url)
      },
      get href() {
        return `http://scarab.test${entries[at]!.url}`
      },
    })
    vi.stubGlobal('history', {
      get state() {
        return entries[at]!.state
      },
      pushState(state: unknown, _: string, url: string) {
        entries.splice(at + 1)
        entries.push({ state: structuredClone(state), url: `/${hashOf(url)}` })
        at++
      },
      replaceState(state: unknown, _: string, url: string) {
        entries[at] = { state: structuredClone(state), url: `/${hashOf(url)}` }
      },
    })
  }
  /** The router as a page load finds it: a fresh module over the same history (a reload of the current entry). */
  const load = async () => {
    vi.resetModules()
    return import('./router')
  }
  /** What useRouteState's set() does: write the value into the current entry. */
  const typeInto = (key: string, value: unknown) => history.replaceState({ ...(history.state as object | null), [key]: value }, '', location.href)

  beforeEach(() => fakeBrowser('#/cash'))
  afterEach(() => vi.unstubAllGlobals())

  it('stamps a kept-alive screen\'s value onto the new entry the nav opens, so a reload of it keeps the value', async () => {
    const router = await load()
    typeInto('q', 'coffee') // searched on Cash
    router.navigate({ screen: 'dash' })
    router.navigate({ screen: 'cash' }) // back through the sidebar: a new entry, no route state
    expect(history.state).toEqual({})
    expect(router.carryRouteState('cash', 'q', 'coffee', '')).toBe(true)
    expect(history.state).toEqual({ q: 'coffee' })
    // A second arrival finds it there and writes nothing.
    expect(router.carryRouteState('cash', 'q', 'coffee', '')).toBe(false)
    const reloaded = await load()
    expect(reloaded.lastRoute('cash')?.state).toEqual({ q: 'coffee' })
  })

  it('keeps the rest of the entry\'s route state', async () => {
    const router = await load()
    router.navigate({ screen: 'dash' })
    typeInto('nwView', 'breakdown')
    expect(router.carryRouteState('dash', 'priceChart', 'VTI', null)).toBe(true)
    expect(history.state).toEqual({ nwView: 'breakdown', priceChart: 'VTI' })
  })

  it('leaves an entry that has its own value alone, and never writes the default', async () => {
    const router = await load()
    typeInto('q', 'tea') // e.g. a merchant link's state
    expect(router.carryRouteState('cash', 'q', 'coffee', '')).toBe(false)
    expect(history.state).toEqual({ q: 'tea' })
    router.navigate({ screen: 'cash', params: { cat: 3 } })
    expect(router.carryRouteState('cash', 'q', '', '')).toBe(false)
    const none: string[] = []
    expect(router.carryRouteState('cash', 'ids', none, none)).toBe(false)
    expect(history.state).toEqual({})
  })

  it('a screen remounted while hidden (a data swap) starts from the value it left, and carries it into the next entry', async () => {
    const router = await load()
    expect(router.writeRouteState('cash', 'q', 'grocer')).toBe(true) // searched on Cash
    router.navigate({ screen: 'dash' })
    // Every visited screen remounts on a data swap; Cash is hidden behind the Dashboard.
    const seeded = router.routeStateSeed('cash', false, 'q', '')
    expect(seeded).toBe('grocer')
    router.navigate({ screen: 'cash' }) // back through the sidebar: a new entry, no route state
    expect(router.carryRouteState('cash', 'q', seeded, '')).toBe(true)
    expect(history.state).toEqual({ q: 'grocer' })
    // Never another screen's value, and the default for a screen never visited.
    expect(router.routeStateSeed('dash', false, 'q', '')).toBe('')
    expect(router.routeStateSeed('tax', false, 'q', 'none')).toBe('none')
  })

  it('a remount that only renders once the screen is revealed (on a new entry without the key) still starts from its value', async () => {
    const router = await load()
    router.writeRouteState('cash', 'q', 'grocer')
    router.navigate({ screen: 'dash' })
    router.navigate({ screen: 'cash' }) // revealed before the hidden remount rendered: the entry has no route state
    expect(history.state).toEqual({})
    expect(router.routeStateSeed('cash', true, 'q', '')).toBe('grocer')
    // The entry's own value (a link's state, Back/Forward) still wins.
    router.navigate({ screen: 'cash', params: { cat: 2 } }, { state: { q: 'tea' } })
    expect(router.routeStateSeed('cash', true, 'q', '')).toBe('tea')
    // …and is what the screen holds from then on.
    router.navigate({ screen: 'dash' })
    expect(router.routeStateSeed('cash', false, 'q', '')).toBe('tea')
  })

  it('a reload forgets what screens held (the entry alone speaks)', async () => {
    let router = await load()
    router.writeRouteState('cash', 'q', 'grocer')
    router.navigate({ screen: 'dash' })
    router = await load()
    expect(router.routeStateSeed('cash', false, 'q', '')).toBe('')
  })

  it('records carried and written values as the screen\'s last route state', async () => {
    const router = await load()
    router.writeRouteState('cash', 'q', 'coffee')
    expect(router.lastRoute('cash')?.state).toEqual({ q: 'coffee' })
    router.navigate({ screen: 'dash' })
    router.writeRouteState('cash', 'q', 'tea') // a hidden screen writes nothing
    expect(router.lastRoute('cash')?.state).toEqual({ q: 'coffee' })
    expect(history.state).toEqual({})
    router.navigate({ screen: 'cash', params: { cat: 3 } })
    router.carryRouteState('cash', 'q', 'coffee', '')
    expect(router.lastRoute('cash')).toMatchObject({ params: { cat: '3' }, state: { q: 'coffee' } })
  })

  it("never writes into another screen's entry: a hidden screen's value stays its own", async () => {
    const router = await load()
    router.navigate({ screen: 'dash' })
    expect(router.carryRouteState('cash', 'q', 'coffee', '')).toBe(false)
    expect(history.state).toEqual({})
    // Outside any screen (no scope), route state follows whatever entry is current.
    expect(router.carryRouteState(null, 'q', 'coffee', '')).toBe(true)
    expect(history.state).toEqual({ q: 'coffee' })
  })
})

describe('navigating to a section', () => {
  beforeEach(() => {
    const entries: { state: unknown; url: string }[] = [{ state: null, url: '/#/tax' }]
    let at = 0
    const hashOf = (url: string) => (url.includes('#') ? url.slice(url.indexOf('#')) : '')
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('location', {
      pathname: '/',
      search: '',
      get hash() {
        return hashOf(entries[at]!.url)
      },
      get href() {
        return `http://scarab.test${entries[at]!.url}`
      },
    })
    vi.stubGlobal('history', {
      get state() {
        return entries[at]!.state
      },
      pushState(state: unknown, _: string, url: string) {
        entries.splice(at + 1)
        entries.push({ state: structuredClone(state), url: `/${hashOf(url)}` })
        at++
      },
      replaceState(state: unknown, _: string, url: string) {
        entries[at] = { state: structuredClone(state), url: `/${hashOf(url)}` }
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('counts a visit even when the section is already in the URL (a link to it scrolls there again)', async () => {
    vi.resetModules()
    const router = await import('./router')
    const start = router.sectionVisit()
    router.navigate('#/tax/paychecks')
    expect(router.sectionVisit()).toBe(start + 1)
    // Same route: no new entry, no route change — but still a visit.
    router.navigate('#/tax/paychecks')
    router.navigate({ screen: 'tax', rest: ['paychecks'] }, { replace: false })
    expect(router.sectionVisit()).toBe(start + 3)
    expect(location.hash).toBe('#/tax/paychecks')
  })

  it('leaves the count alone for routes without a section and for param changes', async () => {
    vi.resetModules()
    const router = await import('./router')
    router.navigate('#/tax/paychecks')
    const n = router.sectionVisit()
    router.setParams({ year: 2026 })
    router.navigate('#/cash')
    router.navigate({ screen: 'dash' })
    expect(router.sectionVisit()).toBe(n)
  })
})
