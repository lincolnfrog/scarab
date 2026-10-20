import type { DbLike } from '../engine/db'
import type { HistoryPending, HistoryStatus } from '../shared/series-api'
import { ensureHistoryPack, historyGate, historyPending, historyStatus, isHistoryBuilding, type HistoryRun, type HistoryRunOptions } from './history-pack'

/**
 * POST /api/basket/crawl: run the market-history build inside this request.
 *
 * Cloud Run gives the container CPU only while a request is open (request-
 * based billing, min-instances 0), so a build left running after a response
 * crawls and dies with the idle instance. The monthly history's monthly
 * rebuild — ~600 Yahoo calls, paced — needed someone to keep a request open
 * for it; nobody browsing does. So a schedule (.github/workflows/history.yml,
 * as the scarab-history service account through IAP) calls this route, and
 * the run happens here, with the CPU the request brings, until the build is
 * done or CRAWL_REQUEST_BUDGET_MS is up; the caller reads `retryAfter` and
 * calls again. Everything about the build itself — one call per 1.5 s, 160 a
 * run, runs 20 minutes apart, 640 a day, a refusal pauses it for the day —
 * is history-pack.ts's and unchanged: this route only lends it a request.
 *
 * It is a trigger and nothing more: the request carries no body worth
 * reading, the answer is the build's public progress, and calling it when
 * nothing is due (or too soon) does nothing — it is safe for any member to
 * call, and the vault-only allowlist lists it (server/zk-routes.ts,
 * PRIVACY.md "Market history the server serves").
 */

/** How long a run may hold the request: under Cloud Run's default 300 s request timeout (deploy.sh sets none), with room for the last call. */
export const CRAWL_REQUEST_BUDGET_MS = 240_000

export type CrawlReport = {
  /** A run happened in this request (started here, or joined one already running). */
  ran: boolean
  /** What that run did: calls made, symbols fetched, whether the build finished. Null when none ran (or a joined run outlived the budget). */
  run: HistoryRun | null
  /** The monthly file as it stands after the run. */
  history: HistoryStatus | HistoryPending
  /** A run is still going (it outlived this request's budget); the next call joins it. */
  building: boolean
  /** Why no further run can start right now (see HistoryGate), or null when one could. */
  waiting: 'running' | 'current' | 'no-basket' | 'blocked' | 'gap' | 'day' | null
  /** Seconds until calling again can do more: 0 now, a wait, or null when nothing is due (the file is current, or there is no basket yet). */
  retryAfter: number | null
}

export type CrawlOptions = HistoryRunOptions & { budgetMs?: number }

/** Resolve to the run's result, or to null when the budget runs out first (the run goes on; a later call joins it). */
async function within<T>(p: Promise<T>, deadline: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const out = await Promise.race([
    p,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    }),
  ])
  clearTimeout(timer)
  return out
}

export async function runCrawl(db: DbLike, f: typeof fetch = fetch, now = new Date(), opts: CrawlOptions = {}): Promise<CrawlReport> {
  const started = Date.now()
  const deadline = started + (opts.budgetMs ?? CRAWL_REQUEST_BUDGET_MS)
  let run: HistoryRun | null = null
  let ran = false
  // A run already going (a tab's GET /basket/history started it, or the previous call's outlived its budget) has no deadline
  // of ours: lend it this request for as long as the budget lasts.
  const joined = isHistoryBuilding() ? ensureHistoryPack(db, f, now, opts) : null
  if (joined) {
    ran = true
    run = await within(joined, deadline)
  } else if (historyGate(db, now, opts).ready) {
    // A run of our own stops making calls at the deadline, so it comes back by itself: the deadline plus the call in progress.
    ran = true
    run = await ensureHistoryPack(db, f, now, { ...opts, deadline })!
  }
  // `now` is the caller's clock (tests set it); the time this request took moves it on.
  const after = new Date(now.getTime() + (Date.now() - started))
  const gate = historyGate(db, after, opts)
  const status = historyStatus(db)
  return {
    ran,
    run,
    history: status.ready ? status : historyPending(db, after.toISOString().slice(0, 10)),
    building: isHistoryBuilding(),
    waiting: gate.ready ? null : gate.why,
    retryAfter: gate.ready ? 0 : 'waitMs' in gate ? Math.ceil(gate.waitMs / 1000) : gate.why === 'running' ? 60 : null,
  }
}
