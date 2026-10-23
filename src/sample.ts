import type { MarketHistory } from '../engine/analytics'
import { enterSampleMode } from './local'
import { navigate } from './router'

/**
 * The front door's "Look around with a sample household": a way to see what
 * Scarab does before typing in real numbers. The household is made up and
 * built here, in the tab, by engine/sample.ts — through the engine's own
 * write paths, onto a fresh in-tab database — then opened as a session that
 * never has a vault (src/local.ts enterSampleMode): no save queue, no
 * autosave, no PUT /api/vault. Leaving reloads the page, which drops it.
 *
 * This module and the builder load only when someone asks for the sample, so
 * the entry bundle carries neither.
 */
export async function openSample(): Promise<void> {
  const [{ buildSampleHousehold }, market] = await Promise.all([import('../engine/sample'), sharedMarket()])
  await enterSampleMode((db, today) => buildSampleHousehold(db, today, { market }))
  navigate({ screen: 'dash' }, { replace: true }) // it opens on its Dashboard, whatever the address bar held
}

/** How long opening the sample waits for the market history before pricing its funds itself. */
const MARKET_WAIT_MS = 4_000

/**
 * The shared monthly market history — the same file every session reads,
 * identical for every caller — so the sample's index funds carry their real
 * month-end closes. Without it (a server still building it, offline, slow),
 * the sample prices itself.
 */
async function sharedMarket(): Promise<MarketHistory | undefined> {
  const { tabHistory } = await import('./local/routes-analytics')
  let timer: ReturnType<typeof setTimeout> | undefined
  const h = await Promise.race([tabHistory(), new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), MARKET_WAIT_MS)))])
  clearTimeout(timer)
  return h?.market
}
