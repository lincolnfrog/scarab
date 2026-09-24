import type { BrowserDb } from '../../engine/sqljs-db'

/**
 * The in-tab route table. Local mode answers the same /api paths the server
 * does, from the tab's own database; each route here mirrors one server route
 * exactly — method, path (without the /api prefix), and `:param` segments —
 * so a new path can never fall into a handler it merely shares a prefix with.
 * src/local/drift.test.ts holds the two tables together.
 *
 * Matching is first-match-wins in list order (Hono's rule too) with an exact
 * segment count: '/invest/accounts/:id' matches '/invest/accounts/3' and
 * nothing longer or shorter.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

/** What a handler gets: the tab's database plus the request, already parsed. */
export type LocalCtx = {
  db: BrowserDb
  /** Decoded `:param` values, by name. */
  params: Record<string, string>
  query: URLSearchParams
  /** The parsed JSON body ({} when none was sent). Untyped on purpose: the engine validates it. */
  body: any
  /** The household's day — todayLocal() in the tab's zone, not UTC. */
  today: string
  /** The IAP identity the tab was opened by (localMode.setIdentity), or null before it is known. */
  identity: string | null
}

/**
 * Whether a successful call can leave the tab with unsaved work. 'auto' (the
 * default for writes) dirties it only when the database actually changed;
 * 'never' is for read-like POSTs and for refetchable public data (price
 * quotes) that can ride along with the next real save. GET is always 'never'.
 */
export type DirtyPolicy = 'auto' | 'never'

export type LocalRoute = {
  method: HttpMethod
  /** Server path without the /api prefix: '/invest/accounts/:id'. */
  path: string
  handler: (c: LocalCtx) => unknown | Promise<unknown>
  dirty?: DirtyPolicy
  /**
   * The handler swaps the whole database for another (POST /import): the
   * dispatcher bumps localMode.dataEpoch and fires 'scarab-data', as
   * loadLocalDump does, so screens re-read instead of showing the old data.
   */
  replacesData?: boolean
}

// One or more '/segment' parts; a segment is a literal or a ':name' param.
const PATH_SHAPE = /^(?:\/:?[A-Za-z0-9_.-]+)+$/

/** Declare a route. GET routes are always 'never' dirty, whatever is passed. */
export const r = (
  method: HttpMethod,
  path: string,
  handler: LocalRoute['handler'],
  dirty: DirtyPolicy = 'auto',
): LocalRoute => {
  if (!PATH_SHAPE.test(path) || path.startsWith('/api/'))
    throw new Error(`local route path must look like '/invest/accounts/:id' (no /api prefix): ${JSON.stringify(path)}`)
  return { method, path, handler, dirty: method === 'GET' ? 'never' : dirty }
}

/** The dirty policy a matched route actually runs under. */
export const policyOf = (route: LocalRoute): DirtyPolicy => (route.method === 'GET' ? 'never' : (route.dirty ?? 'auto'))

// Hono decodes params the same way, keeping the raw text if it isn't valid percent-encoding.
function decodeParam(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * The first route whose method and shape match `path` (a pathname without
 * the /api prefix, still percent-encoded), with its params decoded. Literal
 * segments compare exactly (case-sensitive); a param matches any non-empty
 * segment. A trailing slash is one more (empty) segment, so it never matches.
 */
export function matchRoute(
  routes: LocalRoute[],
  method: string,
  path: string,
): { route: LocalRoute; params: Record<string, string> } | null {
  if (!path.startsWith('/')) return null
  const verb = method.toUpperCase()
  const segs = path.split('/').slice(1)
  for (const route of routes) {
    if (route.method !== verb) continue
    const pattern = route.path.split('/').slice(1)
    if (pattern.length !== segs.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < pattern.length && ok; i++) {
      const p = pattern[i]!
      const s = segs[i]!
      if (p.startsWith(':')) {
        if (s === '') ok = false
        else params[p.slice(1)] = decodeParam(s)
      } else if (p !== s) ok = false
    }
    if (ok) return { route, params }
  }
  return null
}
