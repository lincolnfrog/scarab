import type { LocalRoute } from './table'

/**
 * The only place the per-area route lists are joined. Each list lives in its
 * own file so parallel work never edits the same lines:
 *
 *   routes-core.ts       accounts, cash, budget, property, goal, tax, digest, scenarios, export/import
 *   routes-invest.ts     investment accounts, trades, portfolio, unvested grants
 *   routes-analytics.ts  prices, charts, series
 *
 * Order matters only where two routes share a method and shape (first match
 * wins); the lists never overlap today.
 */

/**
 * Server paths the tab never answers itself: the encrypted-vault courier, the
 * shared price basket and the mode probe. They always go to the network,
 * whether or not a session is active. Prefixes, matched per segment.
 */
export const NETWORK_ONLY = ['/vault', '/basket', '/mode'] as const

/** Is this path (without /api) one of the network-only prefixes above? */
export const isNetworkOnly = (path: string): boolean =>
  NETWORK_ONLY.some((p) => path === p || path.startsWith(`${p}/`))

let loading: Promise<LocalRoute[]> | null = null

/**
 * Every in-tab route, loaded on first use. The route modules import the
 * engine, so keeping them behind a dynamic import keeps the engine out of the
 * household bundle. A failed chunk load isn't cached; the next call retries.
 */
export async function loadRoutes(): Promise<LocalRoute[]> {
  loading ??= Promise.all([import('./routes-core'), import('./routes-invest'), import('./routes-analytics')]).then(
    ([core, invest, analytics]) => Object.freeze([...core.CORE, ...invest.INVEST, ...analytics.ANALYTICS]) as LocalRoute[],
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}
