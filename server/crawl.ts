import type { DbLike } from '../engine/db'
import type { DailyPending, DailyStatus, HistoryPending, HistoryStatus } from '../shared/series-api'
import { dailyGate, dailyPending, dailyStatus, ensureDailyBuckets, isDailyBuilding } from './daily-buckets'
import { ensureHistoryPack, historyGate, historyPending, historyStatus, isHistoryBuilding, type HistoryGate, type HistoryRun, type HistoryRunOptions } from './history-pack'

/**
 * POST /api/basket/crawl: run the market-history builds inside this request.
 *
 * Cloud Run gives the container CPU only while a request is open (request-
 * based billing, min-instances 0), so a build left running after a response
 * crawls and dies with the idle instance. The monthly history's monthly
 * rebuild — ~600 Yahoo calls, paced — needed someone to keep a request open
 * for it; nobody browsing does. So a schedule (.github/workflows/history.yml,
 * as the scarab-history service account through IAP) calls this route, and
 * the run happens here, with the CPU the request brings, until the build is
 * done or CRAWL_REQUEST_BUDGET_MS is up; the caller reads `retryAfter` and
 * calls again. Two builds share the route and one budget (./crawl-budget.ts):
 * the monthly file (./history-pack.ts) first, since benchmarks and the
 * month-end import read it, then the daily buckets (./daily-buckets.ts).
 * Everything about the builds themselves — one call per 1.5 s, 160 a run,
 * runs 20 minutes apart, 640 a day, a refusal pauses the day — is theirs and
 * unchanged: this route only lends them a request.
 *
 * It is a trigger and nothing more: the request carries no body worth
 * reading, the answer is the builds' public progress, and calling it when
 * nothing is due (or too soon) does nothing — it is safe for any member to
 * call, and the vault-only allowlist lists it (server/zk-routes.ts,
 * PRIVACY.md "Market history the server serves").
 */

/** How long a run may hold the request: under Cloud Run's default 300 s request timeout (deploy.sh sets none), with room for the last call. */
export const CRAWL_REQUEST_BUDGET_MS = 240_000

export type CrawlWaiting = 'running' | 'current' | 'no-basket' | 'blocked' | 'gap' | 'day'

export type CrawlReport = {
  /** Which build this request ran (started here, or joined one already running); null when none. */
  ran: 'monthly' | 'daily' | null
  /** What that run did: calls made, symbols fetched, whether the build finished. Null when none ran (or a joined run outlived the budget). */
  run: HistoryRun | null
  /** The monthly file as it stands after the run. */
  history: HistoryStatus | HistoryPending
  /** The daily buckets as they stand after the run. */
  daily: DailyStatus | DailyPending
  /** A run is still going (it outlived this request's budget); the next call joins it. */
  building: boolean
  /** Why no further run can start right now, or null when one could. */
  waiting: CrawlWaiting | null
  /** Seconds until calling again can do more: 0 now, a wait, or null when nothing is due (both files current, or there is no basket yet). */
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

/**
 * Which build the next run belongs to: the monthly file when it is due and
 * allowed, else the daily buckets when they are; or why neither can run. A
 * budget answer (blocked, gap, day) from the monthly gate stands for both,
 * since they share the budget; only "nothing to build" passes the question on.
 */
export function nextCrawl(db: DbLike, now: Date, opts: HistoryRunOptions = {}): { which: 'monthly' | 'daily' } | { which: null; gate: Exclude<HistoryGate, { ready: true }> } {
  const monthly = historyGate(db, now, opts)
  if (monthly.ready) return { which: 'monthly' }
  if (monthly.why !== 'current' && monthly.why !== 'no-basket') return { which: null, gate: monthly }
  const daily = dailyGate(db, now, opts)
  if (daily.ready) return { which: 'daily' }
  return { which: null, gate: daily }
}

export async function runCrawl(db: DbLike, f: typeof fetch = fetch, now = new Date(), opts: CrawlOptions = {}): Promise<CrawlReport> {
  const started = Date.now()
  const deadline = started + (opts.budgetMs ?? CRAWL_REQUEST_BUDGET_MS)
  let run: HistoryRun | null = null
  let ran: CrawlReport['ran'] = null
  // A run already going (a tab's GET started it, or the previous call's outlived its budget) has no deadline of ours:
  // lend it this request for as long as the budget lasts.
  if (isHistoryBuilding()) {
    ran = 'monthly'
    run = await within(ensureHistoryPack(db, f, now, opts)!, deadline)
  } else if (isDailyBuilding()) {
    ran = 'daily'
    run = await within(ensureDailyBuckets(db, f, now, opts)!, deadline)
  } else {
    // A run of our own stops making calls at the deadline, so it comes back by itself: the deadline plus the call in progress.
    const next = nextCrawl(db, now, opts)
    if (next.which === 'monthly') run = await ensureHistoryPack(db, f, now, { ...opts, deadline })!
    else if (next.which === 'daily') run = await ensureDailyBuckets(db, f, now, { ...opts, deadline })!
    ran = next.which
  }
  // `now` is the caller's clock (tests set it); the time this request took moves it on.
  const after = new Date(now.getTime() + (Date.now() - started))
  const next = nextCrawl(db, after, opts)
  const history = historyStatus(db)
  const daily = dailyStatus(db)
  const today = after.toISOString().slice(0, 10)
  return {
    ran,
    run,
    history: history.ready ? history : historyPending(db, today),
    daily: daily.ready ? daily : dailyPending(db, today),
    building: isHistoryBuilding() || isDailyBuilding(),
    waiting: next.which ? null : next.gate.why,
    retryAfter: next.which ? 0 : 'waitMs' in next.gate ? Math.ceil(next.gate.waitMs / 1000) : next.gate.why === 'running' ? 60 : null,
  }
}
