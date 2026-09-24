import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type JSX, type MouseEvent, type ReactNode } from 'react'
import { withViewTransition } from './ui/motion'

/**
 * Hash routing: every screen has a URL fragment, so Back/Forward work, a
 * reload stays put, and a link can point at a section or a filtered view.
 *
 *   #/<screen>[/<section>…][?key=value&…]      '#/tax/paychecks'  '#/cash?cat=12&month=2026-08'
 *
 * Privacy. Browsers sync full URLs — fragments included — to the signed-in
 * account's history, so a fragment carries only screen ids, numeric ids,
 * enums and YYYY-MM months. Tickers, search text, merchant names and amounts
 * are household data: they ride in route state instead (the history entry's
 * `history.state`, through useRouteState or navigate's `state`), which stays
 * in this browser's own session history. formatRoute enforces the rule: in
 * development an unsafe value throws; in a production build it is dropped.
 *
 * The router is a tiny external store over the address bar. navigate() and
 * setParams() write history synchronously (so back-to-back calls see each
 * other) and publish to React afterwards; a change of screen publishes inside
 * a view transition, so the screen crossfades.
 */

export type ScreenId = 'dash' | 'invest' | 're' | 'cash' | 'goal' | 'tax' | 'future' | 'compare' | 'vault'

/** Every screen, in nav order, with the name the nav, the page heading and the route announcement use. */
export const SCREENS: readonly { id: ScreenId; label: string }[] = [
  { id: 'dash', label: 'Dashboard' },
  { id: 'invest', label: 'Investments' },
  { id: 're', label: 'Real estate' },
  { id: 'cash', label: 'Cash & budget' },
  { id: 'goal', label: 'Dream Home' },
  { id: 'tax', label: 'Taxes' },
  { id: 'future', label: 'Future' },
  { id: 'compare', label: 'Compare' },
  { id: 'vault', label: 'Data & Vault' },
]

const IDS: ReadonlySet<string> = new Set(SCREENS.map((s) => s.id))
export const isScreenId = (s: string): s is ScreenId => IDS.has(s)

/**
 * Where the address bar points. `rest` is the path after the screen (a section
 * for useAnchor); `params` the query; `state` the history entry's route state
 * (never in the URL). All three are frozen.
 */
export type Route = { screen: ScreenId; rest: string[]; params: Readonly<Record<string, string>>; state: Readonly<Record<string, unknown>> }
export type RouteTarget = { screen: ScreenId; rest?: string[]; params?: Record<string, string | number | undefined> }

const EMPTY: Readonly<Record<string, never>> = Object.freeze({})
const NO_REST: string[] = Object.freeze([]) as unknown as string[]

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s // malformed %-escape: keep the raw text rather than lose the segment
  }
}

/** What may appear in a fragment: a param key, a param value or a section. Anything else is (or could be) household data. */
const HASH_SAFE = /^[a-z0-9-]{1,24}$/i

/**
 * Read a fragment — whatever the address bar holds, pasted or bookmarked. An
 * unknown screen means the Dashboard, and a section, key or value formatRoute
 * could never have written is ignored, so everything a Route carries can be
 * formatted again. `state` is always empty here; useRoute fills it from the
 * history entry.
 */
export function parseHash(hash: string): Route {
  const s = hash.startsWith('#') ? hash.slice(1) : hash
  const q = s.indexOf('?')
  const segs = (q < 0 ? s : s.slice(0, q)).split('/').filter(Boolean).map(decode)
  const head = segs[0]
  if (head === undefined || !isScreenId(head)) return { screen: 'dash', rest: NO_REST, params: EMPTY, state: EMPTY }
  const rest = segs.slice(1).filter((seg) => HASH_SAFE.test(seg))
  const params: Record<string, string> = {}
  if (q >= 0)
    for (const [k, v] of new URLSearchParams(s.slice(q + 1)))
      if (HASH_SAFE.test(k) && HASH_SAFE.test(v) && !Object.hasOwn(params, k)) params[k] = v // first occurrence wins, as URLSearchParams.get
  return {
    screen: head,
    rest: rest.length ? (Object.freeze(rest) as string[]) : NO_REST,
    params: Object.keys(params).length ? Object.freeze(params) : EMPTY,
    state: EMPTY,
  }
}

/** A value that doesn't belong in a URL: throws while developing; in production it is dropped (and logged without the value). */
function refuse(what: string, value: string): false {
  if (import.meta.env.DEV)
    throw new Error(
      `formatRoute: ${what} ${JSON.stringify(value)} can't go in the URL — fragments sync to browser history. ` +
        'Use screen ids, numeric ids, enums or YYYY-MM months there, and useRouteState for anything else.',
    )
  console.error(`formatRoute: dropped a ${what} that isn't hash-safe`)
  return false
}
const hashSafe = (value: string, what: string): boolean => HASH_SAFE.test(value) || refuse(what, value)

/** Build a fragment: '#/cash?cat=12&month=2026-08'. Params that are undefined are left out; everything else must be hash-safe (see the privacy note). */
export function formatRoute(t: RouteTarget): string {
  const screen = isScreenId(t.screen) ? t.screen : (refuse('screen', String(t.screen)), 'dash')
  const path = [screen, ...(t.rest ?? []).filter((seg) => hashSafe(seg, 'section'))].join('/')
  const query = new URLSearchParams()
  for (const [k, v] of Object.entries(t.params ?? {})) {
    if (v === undefined || !hashSafe(k, 'param key')) continue
    // An amount is the likeliest non-integer here, and exactly what must not leak.
    if (typeof v === 'number' && !Number.isSafeInteger(v)) {
      refuse(`param "${k}" (numbers must be whole)`, String(v))
      continue
    }
    const s = String(v)
    if (hashSafe(s, `param "${k}"`)) query.append(k, s)
  }
  const qs = query.toString()
  return `#/${path}${qs ? `?${qs}` : ''}`
}

const sameRoute = (a: Route, b: Route) =>
  a.screen === b.screen &&
  a.rest.join('/') === b.rest.join('/') &&
  Object.keys(a.params).length === Object.keys(b.params).length &&
  Object.entries(a.params).every(([k, v]) => b.params[k] === v)

const toHash = (to: string | RouteTarget): string => (typeof to === 'string' ? formatRoute(parseHash(to)) : formatRoute(to))

/* ---------- the store ---------- */

const hasWindow = typeof window !== 'undefined'
const listeners = new Set<() => void>()
const lastByScreen = new Map<ScreenId, Route>()
/**
 * Every route-state value each screen has shown this page load, newest per
 * key: written by useRouteState, carried into entries, or adopted from one
 * (a link's state, Back/Forward). What a kept-alive screen still holds in
 * memory — so a remount (a data swap remounts every screen) starts from it.
 */
const keptByScreen = new Map<ScreenId, Readonly<Record<string, unknown>>>()
const keep = (screen: ScreenId, st: Record<string, unknown>) => {
  if (Object.keys(st).length) keptByScreen.set(screen, { ...keptByScreen.get(screen), ...st })
}
let seenHash: string | null = null
let seenState: unknown
let current: Route = parseHash('')
/** A screen change is waiting on its view transition; anything arriving meanwhile folds into it. */
let pending = false

function entryState(): Record<string, unknown> {
  const s: unknown = hasWindow ? history.state : null
  return s !== null && typeof s === 'object' && !Array.isArray(s) ? (s as Record<string, unknown>) : {}
}

/** Bring `current` up to date with the address bar and history entry. True if it moved. */
function sync(): boolean {
  const hash = location.hash
  const st: unknown = history.state
  if (hash === seenHash && st === seenState) return false
  seenHash = hash
  seenState = st
  const state = entryState()
  current = { ...parseHash(hash), state: Object.keys(state).length ? Object.freeze({ ...state }) : EMPTY }
  lastByScreen.set(current.screen, current)
  keep(current.screen, state)
  return true
}

function publish(): void {
  if (sync()) for (const l of listeners) l()
}

/**
 * Write route state into the current history entry, and record it as what
 * its screen holds (lastRoute, and the values a remount starts from).
 * Publishes nothing: the screen writing it already shows the value.
 */
function writeEntryState(next: Record<string, unknown>): void {
  history.replaceState(next, '', location.href)
  const here = parseHash(location.hash)
  lastByScreen.set(here.screen, { ...here, state: Object.keys(next).length ? Object.freeze({ ...next }) : EMPTY })
  keep(here.screen, next)
}

/** Publish the address bar to React — inside a view transition when the screen changes. */
function commit(screenChanges: boolean): void {
  if (pending) return // the waiting transition reads the address bar when it runs
  if (!screenChanges) return publish()
  pending = true
  const run = () => {
    pending = false
    publish()
  }
  try {
    withViewTransition(run)
  } catch (e) {
    console.error('router: view transition failed to start', e)
    if (pending) run()
  }
}

if (hasWindow) {
  sync()
  // Back/Forward, a typed fragment, a plain <a href="#/…">. Both events can fire for one step; the second finds nothing new.
  const onBrowserNav = (e: Event) => {
    // A browser that already animated the step itself (a swipe back) doesn't get a second animation.
    const uaAnimated = (e as PopStateEvent).hasUAVisualTransition === true
    commit(!uaAnimated && parseHash(location.hash).screen !== current.screen)
  }
  window.addEventListener('popstate', onBrowserNav)
  window.addEventListener('hashchange', onBrowserNav)
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
const snapshot = () => current

/** The current route. Re-renders on every navigation, Back/Forward and param change. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** The last route seen for a screen this tab — what it showed when it was left. Null if it was never visited. */
export function lastRoute(screen: ScreenId): Route | null {
  return lastByScreen.get(screen) ?? null
}

/**
 * How many times navigate() has pointed at a section this tab. A link to the
 * section the address bar already shows changes no route, but it still means
 * "take me there": useAnchor keys on this to scroll (and pulse) again.
 */
let sectionVisits = 0
const sectionListeners = new Set<() => void>()
const subscribeSections = (l: () => void) => {
  sectionListeners.add(l)
  return () => {
    sectionListeners.delete(l)
  }
}
const sectionSnapshot = () => sectionVisits
/** The section-visit count (see sectionVisits): changes on every navigate() to a route with a section, including the one already showing. */
export function useSectionVisit(): number {
  return useSyncExternalStore(subscribeSections, sectionSnapshot, sectionSnapshot)
}
/** The section-visit count, outside React. For the tests. */
export const sectionVisit = (): number => sectionVisits
function visitSection(): void {
  sectionVisits++
  for (const l of sectionListeners) l()
}

const urlFor = (hash: string) => `${location.pathname}${location.search}${hash}`

/**
 * Go somewhere. A string is a fragment ('#/compare'); a target is formatted
 * (and privacy-checked) by formatRoute. `state` becomes the new entry's route
 * state. Navigating to where the address bar already points adds no history
 * entry (with `state`, it replaces the entry's state) — though a route with a
 * section still scrolls to it again (useSectionVisit). A screen change runs
 * as a view transition.
 */
export function navigate(to: string | RouteTarget, o: { replace?: boolean; state?: Record<string, unknown> } = {}): void {
  if (!hasWindow) return
  const hash = toHash(to)
  const next = parseHash(hash)
  const same = sameRoute(next, parseHash(location.hash))
  if (same && !o.state && !o.replace) {
    if (location.hash !== hash) history.replaceState(history.state, '', urlFor(hash)) // '' → '#/dash': same route, canonical spelling
    if (next.rest.length) visitSection()
    return commit(false)
  }
  const state = o.state ? { ...o.state } : {}
  if (o.replace || same) history.replaceState(state, '', urlFor(hash))
  else history.pushState(state, '', urlFor(hash))
  if (next.rest.length) visitSection()
  commit(next.screen !== current.screen)
}

/**
 * Change query params on the current screen: null removes one. Replaces the
 * history entry unless `replace: false`. Route state carries over either way —
 * a filter change is still the same screen.
 */
export function setParams(patch: Record<string, string | number | null>, o: { replace?: boolean } = {}): void {
  if (!hasWindow) return
  const here = parseHash(location.hash)
  const params: Record<string, string | number | undefined> = { ...here.params }
  for (const [k, v] of Object.entries(patch)) params[k] = v === null ? undefined : v
  const url = urlFor(formatRoute({ screen: here.screen, rest: here.rest, params }))
  if (o.replace ?? true) history.replaceState(history.state, '', url)
  else history.pushState(history.state, '', url)
  commit(false)
}

/**
 * The screen a subtree belongs to, for route state. App's ScreenProvider sets
 * it; outside any screen, route state follows whatever entry is current.
 */
export const RouteScope = createContext<ScreenId | null>(null)

/**
 * useRouteState's carry-over, on arriving at an entry of `scope`'s screen: a
 * kept-alive screen keeps its value across visits, but a visit through a new
 * history entry (the nav, a Link without state) starts that entry without it,
 * so a reload there would lose what the screen still shows. Writes the value
 * into the entry — unless the entry has its own, or the value is the default
 * (a reload brings that back anyway), or the address bar is on another screen
 * (a hidden screen never writes into another screen's entry). True if it
 * wrote. Exported for the tests; screens use useRouteState.
 */
export function carryRouteState(scope: ScreenId | null, key: string, value: unknown, initial: unknown): boolean {
  if (!hasWindow || (scope !== null && parseHash(location.hash).screen !== scope)) return false
  const st = entryState()
  if (Object.hasOwn(st, key) || Object.is(value, initial)) return false
  writeEntryState({ ...st, [key]: value })
  return true
}

/**
 * useRouteState's setter, past setting the value: write it into the current
 * entry — unless the address bar is on another screen. True if it wrote.
 * Exported for the tests.
 */
export function writeRouteState(scope: ScreenId | null, key: string, value: unknown): boolean {
  if (!hasWindow || (scope !== null && parseHash(location.hash).screen !== scope)) return false
  writeEntryState({ ...entryState(), [key]: value })
  return true
}

/**
 * The value useRouteState starts from: the entry's own value when the
 * address bar is on this screen and the entry has one; else the value the
 * screen last held this page load — a data swap remounts every visited
 * screen, hidden ones too, and a remount must not forget a search or a
 * selection it was still showing (nor must one that only renders once the
 * screen is revealed, on a new entry without the key); else `initial`.
 * Exported for the tests.
 */
export function routeStateSeed<T>(scope: ScreenId | null, mine: boolean, key: string, initial: T): T {
  const entry = mine ? entryState() : EMPTY
  if (Object.hasOwn(entry, key)) return entry[key] as T
  const kept = scope !== null ? keptByScreen.get(scope) : undefined
  return kept && Object.hasOwn(kept, key) ? (kept[key] as T) : initial
}

/**
 * State that belongs to this history entry but never to the URL — search
 * text, a ticker, a half-built selection. Like useState, plus:
 *   - the value is written into the entry (history.state), so Back/Forward
 *     to the entry and a reload bring it back;
 *   - arriving at another entry of this screen that carries a value for the
 *     key (a link's `state`, Back/Forward) adopts it; an entry without one
 *     keeps the current value, and has it written in (carryRouteState), so a
 *     reload of that entry keeps it too;
 *   - a hidden screen keeps its value and never writes into another screen's entry;
 *     remounted while hidden (a data swap remounts every screen), it starts
 *     from the value it left in its last entry, not the default.
 * Values must be structured-cloneable.
 */
export function useRouteState<T>(key: string, initial: T): [T, (v: T) => void] {
  const scope = useContext(RouteScope)
  const route = useRoute()
  const mine = scope === null || route.screen === scope
  const [value, setValue] = useState<T>(() => routeStateSeed(scope, mine, key, initial))
  // The default as first passed: callers often pass a fresh [] or {} each render.
  const initialRef = useRef(initial)
  const [seen, setSeen] = useState(route)
  if (seen !== route) {
    setSeen(route)
    if (mine && Object.hasOwn(route.state, key) && !Object.is(route.state[key], value)) setValue(route.state[key] as T)
  }
  useEffect(() => {
    if (mine) carryRouteState(scope, key, value, initialRef.current)
  }, [route, mine, scope, key, value])
  const set = useCallback(
    (v: T) => {
      setValue(v)
      writeRouteState(scope, key, v)
    },
    [key, scope],
  )
  return [value, set]
}

/**
 * An in-app link. Renders a real <a href="#/…"> (so it can be copied or
 * opened in a new tab); a plain click navigates in place, with a view
 * transition and optional route state.
 */
export function Link(p: {
  to: string | RouteTarget
  children: ReactNode
  className?: string
  title?: string
  state?: Record<string, unknown>
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void
}): JSX.Element {
  const href = toHash(p.to)
  return createElement(
    'a',
    {
      href,
      className: p.className,
      title: p.title,
      onClick: (e: MouseEvent<HTMLAnchorElement>) => {
        p.onClick?.(e)
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigate(href, { state: p.state })
      },
    },
    p.children,
  )
}
