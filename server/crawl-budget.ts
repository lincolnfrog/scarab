import type { DbLike } from '../engine/db'

/**
 * One budget for every history crawl of Yahoo's spark endpoint — the monthly
 * file (history-pack.ts) and the daily buckets (daily-buckets.ts) draw on it
 * together, so what PRIVACY.md promises about the server's manners toward
 * Yahoo holds for the server as a whole, not per file:
 *   - one call at a time, CRAWL_PACE_MS apart;
 *   - a run makes at most CRAWL_RUN_CALLS calls, runs start at least
 *     CRAWL_RUN_GAP_MS apart, and a UTC day allows CRAWL_DAY_CALLS;
 *   - Yahoo refusing (429/403/5xx, an unreadable reply, a network error) ends
 *     the run and pauses every crawl until the next UTC day.
 * Kept in app_meta `basket:crawl:budget` (server infrastructure: never in a
 * snapshot, kept by the zero-knowledge purge).
 */
export const CRAWL_PACE_MS = 1_500
export const CRAWL_RUN_CALLS = 160
export const CRAWL_RUN_GAP_MS = 20 * 60_000
export const CRAWL_DAY_CALLS = 640

export type BudgetOptions = { gapMs?: number; dayCalls?: number }
/** Why no run may start now, and how long until one may: a refusal today, the gap since the last run, or the day's calls spent. */
export type BudgetGate = { ready: true } | { ready: false; why: 'blocked' | 'gap' | 'day'; waitMs: number }

type Budget = { day: string; calls: number; lastRunAt: string | null; blockedOn: string | null }
const KEY = 'basket:crawl:budget'

const dayOf = (d: Date) => d.toISOString().slice(0, 10)
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)

function write(db: DbLike, b: Budget): void {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(KEY, JSON.stringify(b))
}

/** Today's budget: the day's calls so far (a new day starts at zero), the last run's start, and whether Yahoo refused today. */
export function readBudget(db: DbLike, today: string): Budget {
  const raw = (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(KEY) as { value: string } | undefined)?.value
  let b: Budget = { day: today, calls: 0, lastRunAt: null, blockedOn: null }
  if (raw) {
    try {
      const x: unknown = JSON.parse(raw)
      if (isObject(x) && typeof x.day === 'string' && Number.isSafeInteger(x.calls))
        b = {
          day: x.day,
          calls: x.calls as number,
          lastRunAt: typeof x.lastRunAt === 'string' ? x.lastRunAt : null,
          blockedOn: typeof x.blockedOn === 'string' ? x.blockedOn : null,
        }
    } catch {
      /* unreadable: start fresh */
    }
  }
  if (b.day !== today) b = { ...b, day: today, calls: 0 }
  return b
}

/** Milliseconds from `now` to the next UTC midnight: when the day's budget resets and a refusal's pause ends. */
export const untilNextUtcDay = (now: Date): number =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - now.getTime()

export function budgetGate(db: DbLike, now: Date, opts: BudgetOptions = {}): BudgetGate {
  const today = dayOf(now)
  const b = readBudget(db, today)
  if (b.blockedOn === today) return { ready: false, why: 'blocked', waitMs: untilNextUtcDay(now) }
  if (b.lastRunAt) {
    const wait = Date.parse(b.lastRunAt) + (opts.gapMs ?? CRAWL_RUN_GAP_MS) - now.getTime()
    if (wait > 0) return { ready: false, why: 'gap', waitMs: wait }
  }
  if (b.calls >= (opts.dayCalls ?? CRAWL_DAY_CALLS)) return { ready: false, why: 'day', waitMs: untilNextUtcDay(now) }
  return { ready: true }
}

/** A run starts now (the gap counts from here). */
export function noteRunStart(db: DbLike, now: Date): void {
  write(db, { ...readBudget(db, dayOf(now)), lastRunAt: now.toISOString() })
}

/** One call made; returns the day's count including it. */
export function noteCall(db: DbLike, today: string): number {
  const b = readBudget(db, today)
  b.calls++
  write(db, b)
  return b.calls
}

/** Yahoo refused: no crawl runs again before the next UTC day. */
export function noteRefusal(db: DbLike, today: string): void {
  write(db, { ...readBudget(db, today), blockedOn: today })
}
