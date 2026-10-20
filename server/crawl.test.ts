import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { addMonthsToMonth } from '../shared/dates'
import { nextCrawl, runCrawl, type CrawlOptions } from './crawl'
import { dailyGate, dailyStatus, loadBucket } from './daily-buckets'
import { ensureHistoryPack, HISTORY_RUN_GAP_MS, historyGate, historyStatus, loadPack, untilNextUtcDay } from './history-pack'
import { openDb } from './migrations'

const mem = () => openDb(':memory:') as unknown as DbLike
const NOW = new Date('2026-10-02T09:17:00Z') // October: a build is due (September closed)
const later = (ms: number, from = NOW) => new Date(from.getTime() + ms)

/** A basket of `stocks` symbols plus bitcoin: the universe a build fetches. */
function seedBasket(db: DbLike, stocks: number) {
  const put = db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES (?, ?, ?, '2026-10-01')")
  for (let i = 0; i < stocks; i++) put.run(`S${String(i).padStart(2, '0')}`, 'stock', 50_000 + i)
  put.run('BTC', 'crypto', 11_300_000)
}

/** Unix seconds at a month's first day, 04:00Z (New York midnight in summer): how Yahoo stamps a monthly bar. */
const monthOpen = (month: string) => Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1, 4) / 1000

/** Unix seconds at a day's New York open (13:30Z in summer): how Yahoo stamps a daily bar. */
const dayOpen = (iso: string) => Date.parse(`${iso}T13:30:00Z`) / 1000

/**
 * Fake Yahoo spark: 24 months of closes (interval=1mo) or ten trading days
 * (interval=1d) for every symbol asked; `refuse` answers call n with that status.
 */
function fakeYahoo(refuse: (n: number) => number | null = () => null, onCall: () => void = () => {}) {
  const calls: { symbols: string[]; interval: string }[] = []
  const f = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    const symbols = decodeURIComponent(url.searchParams.get('symbols') ?? '').split(',')
    const interval = url.searchParams.get('interval') ?? ''
    const n = calls.length
    calls.push({ symbols, interval })
    onCall()
    const status = refuse(n)
    if (status !== null) return new Response('{}', { status })
    if (interval === '1d') {
      const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']
      return Response.json(Object.fromEntries(symbols.map((s) => [s, { timestamp: days.map(dayOpen), symbol: s, close: days.map((_, i) => 100 + i) }])))
    }
    const months = Array.from({ length: 24 }, (_, i) => addMonthsToMonth('2024-10', i))
    return Response.json(
      Object.fromEntries(symbols.map((s) => [s, { timestamp: months.map(monthOpen), symbol: s, close: months.map((_, i) => 10 + i) }])),
    )
  }) as typeof fetch
  return { f, calls }
}

const quiet = (o: CrawlOptions = {}): CrawlOptions => ({ paceMs: 1, sleep: async () => {}, ...o })

describe('historyGate: why a run can or cannot start', () => {
  it('names the reason and the wait', () => {
    const db = mem()
    expect(historyGate(db, NOW)).toEqual({ ready: false, why: 'no-basket' })
    seedBasket(db, 3)
    expect(historyGate(db, NOW)).toEqual({ ready: true })
    // A full day's budget spent: wait for the next UTC day.
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:crawl:budget', ?)").run(JSON.stringify({ day: '2026-10-02', calls: 640, lastRunAt: null, blockedOn: null }))
    expect(historyGate(db, NOW)).toEqual({ ready: false, why: 'day', waitMs: untilNextUtcDay(NOW) })
    expect(untilNextUtcDay(NOW)).toBe((24 - 9) * 3_600_000 - 17 * 60_000)
    db.prepare("UPDATE app_meta SET value = json_set(value, '$.calls', 1, '$.lastRunAt', ?) WHERE key = 'basket:crawl:budget'").run(NOW.toISOString())
    expect(historyGate(db, later(5 * 60_000))).toEqual({ ready: false, why: 'gap', waitMs: HISTORY_RUN_GAP_MS - 5 * 60_000 })
    expect(historyGate(db, later(HISTORY_RUN_GAP_MS))).toEqual({ ready: true })
    db.prepare("UPDATE app_meta SET value = json_set(value, '$.blockedOn', '2026-10-02') WHERE key = 'basket:crawl:budget'").run()
    expect(historyGate(db, later(HISTORY_RUN_GAP_MS))).toEqual({ ready: false, why: 'blocked', waitMs: untilNextUtcDay(later(HISTORY_RUN_GAP_MS)) })
    // The daily buckets' gate reads the same budget.
    expect(dailyGate(db, later(HISTORY_RUN_GAP_MS))).toEqual({ ready: false, why: 'blocked', waitMs: untilNextUtcDay(later(HISTORY_RUN_GAP_MS)) })
    // The monthly build comes first; a budget answer from it stands for both.
    expect(nextCrawl(db, later(HISTORY_RUN_GAP_MS))).toEqual({ which: null, gate: { ready: false, why: 'blocked', waitMs: untilNextUtcDay(later(HISTORY_RUN_GAP_MS)) } })
  })
})

describe('runCrawl: the build inside one request', () => {
  afterEach(() => vi.useRealTimers())

  it('does nothing without a basket, and says so', async () => {
    const db = mem()
    const { f, calls } = fakeYahoo()
    const r = await runCrawl(db, f, NOW, quiet())
    expect(r).toEqual({
      ran: null,
      run: null,
      history: { ready: false, building: false, done: 0, total: 0, reason: 'The server has no price basket yet, so no market history either' },
      daily: { ready: false, building: false, done: 0, total: 0, reason: 'The server has no price basket yet, so no daily history either' },
      building: false,
      waiting: 'no-basket',
      retryAfter: null,
    })
    expect(calls).toHaveLength(0)
  })

  it('runs the monthly build to the end, then — after the gap — the daily buckets, then reports both current with nothing to retry', async () => {
    const db = mem()
    seedBasket(db, 45) // 46 symbols: 3 calls per build
    const { f, calls } = fakeYahoo()
    const r = await runCrawl(db, f, NOW, quiet())
    expect(r.ran).toBe('monthly')
    expect(r.run).toMatchObject({ calls: 3, fetched: 46, done: true, blocked: false })
    expect(r.history).toMatchObject({ ready: true, final: '2026-09', asOf: '2026-10-02' })
    // The daily buckets are due next (their crawl is booked, nothing fetched yet), once the gap has passed: the budget is one for both.
    expect(r.daily).toMatchObject({ ready: false, building: true, done: 0, total: 46 })
    expect(r).toMatchObject({ building: false, waiting: 'gap', retryAfter: HISTORY_RUN_GAP_MS / 1000 })
    expect(calls.map((c) => c.interval)).toEqual(['1mo', '1mo', '1mo'])
    expect(loadPack(db)!.final).toBe('2026-09')
    // Too soon: nothing runs.
    expect(await runCrawl(db, f, later(60_000), quiet())).toMatchObject({ ran: null, run: null, waiting: 'gap' })
    expect(calls).toHaveLength(3)
    // After the gap: the daily crawl, same throttles, two years of daily bars.
    const d = await runCrawl(db, f, later(HISTORY_RUN_GAP_MS), quiet())
    expect(d.ran).toBe('daily')
    expect(d.run).toMatchObject({ calls: 3, fetched: 46, done: true, blocked: false })
    expect(calls.slice(3).map((c) => c.interval)).toEqual(['1d', '1d', '1d'])
    expect(calls[3]!.symbols).toHaveLength(20)
    expect(d.daily).toEqual({ ready: true, asOf: '2026-10-02', of: 64 })
    expect(dailyStatus(db).ready).toBe(true)
    // Every symbol landed in exactly the bucket the shared function names.
    const { dailyBucket } = await import('../shared/buckets')
    for (const [kind, sym] of [['stock', 'S07'], ['stock', 'S44'], ['crypto', 'BTC']] as const) {
      const file = loadBucket(db, dailyBucket(kind, sym))!
      expect(Object.keys(file[kind])).toContain(sym)
      expect(file.asOf).toBe('2026-10-02')
    }
    // Both current: nothing to retry. Calling again is harmless.
    expect(d).toMatchObject({ building: false, waiting: 'current', retryAfter: null })
    const again = await runCrawl(db, f, later(HISTORY_RUN_GAP_MS + 1), quiet())
    expect(again).toMatchObject({ ran: null, run: null, waiting: 'current', retryAfter: null })
    expect(calls).toHaveLength(6)
  })

  it('stops at the request budget with progress saved, tells the caller when to come back, and resumes there', async () => {
    const db = mem()
    seedBasket(db, 99) // 100 symbols: 5 calls
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    // Each Yahoo call "takes" 100 ms of wall clock; the budget allows two of them.
    const { f, calls } = fakeYahoo(() => null, () => vi.advanceTimersByTime(100))
    const r = await runCrawl(db, f, NOW, quiet({ budgetMs: 250 }))
    expect(r.ran).toBe('monthly')
    expect(r.run).toMatchObject({ calls: 3, done: false, blocked: false }) // the third call began before the clock passed the deadline
    expect(r.history).toMatchObject({ ready: false, building: true, done: 60, total: 100 })
    expect(r.building).toBe(false) // the run returned inside the request; nothing is left running
    expect(r.waiting).toBe('gap')
    expect(r.retryAfter).toBe(HISTORY_RUN_GAP_MS / 1000)
    // Too soon: nothing runs, the wait shrinks.
    const soon = await runCrawl(db, f, later(5 * 60_000), quiet())
    expect(soon).toMatchObject({ ran: null, run: null, waiting: 'gap', retryAfter: (HISTORY_RUN_GAP_MS - 5 * 60_000) / 1000 })
    expect(calls).toHaveLength(3)
    // After the gap: the rest, from where it stopped.
    vi.setSystemTime(later(HISTORY_RUN_GAP_MS))
    const rest = await runCrawl(db, f, later(HISTORY_RUN_GAP_MS), quiet())
    expect(rest.run).toMatchObject({ calls: 2, done: true })
    expect(calls[3]!.symbols[0]).toBe('S60')
    expect(rest).toMatchObject({ waiting: 'gap' }) // the daily buckets next
    expect(Object.keys(loadPack(db)!.stock)).toHaveLength(99)
  })

  it('lends its request to a run someone else started, and reports it still running when the budget ends first', async () => {
    const db = mem()
    seedBasket(db, 45)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { f, calls } = fakeYahoo()
    const slow = (async (...a: Parameters<typeof fetch>) => {
      await gate
      return f(...a)
    }) as typeof fetch
    const theirs = ensureHistoryPack(db, slow, NOW, quiet({ runCalls: 1 }))! // a tab's GET /basket/history started it
    const joined = runCrawl(db, slow, NOW, quiet({ budgetMs: 20 }))
    const r = await joined
    release() // before any assertion: a run left waiting would hang every later test on the module's in-flight guard
    expect(r).toMatchObject({ ran: 'monthly', run: null, building: true, waiting: 'running', retryAfter: 60 })
    expect(await theirs).toMatchObject({ calls: 1, done: false })
    expect(calls).toHaveLength(1)
  })

  it('a refusal pauses the build for the day: the caller is told to return tomorrow', async () => {
    const db = mem()
    seedBasket(db, 45)
    const { f } = fakeYahoo((n) => (n === 1 ? 429 : null))
    const r = await runCrawl(db, f, NOW, quiet())
    expect(r.ran).toBe('monthly')
    expect(r.run).toMatchObject({ calls: 2, blocked: true, done: false })
    expect(r.waiting).toBe('blocked')
    expect(r.retryAfter).toBeGreaterThan(untilNextUtcDay(NOW) / 1000 - 5)
    expect(r.retryAfter).toBeLessThanOrEqual(Math.ceil(untilNextUtcDay(NOW) / 1000))
    expect(historyStatus(db).ready).toBe(false)
  })
})

describe('POST /api/basket/crawl', () => {
  process.env.DB_PATH = ':memory:'
  process.env.NODE_ENV = 'test'
  let mod: typeof import('./app')
  // The singleton database never gets a basket here, so no build is due and nothing reaches the network.
  const network = vi.fn(async () => {
    throw new Error('no network in tests')
  })
  beforeAll(async () => {
    vi.stubGlobal('fetch', network)
    mod = await import('./app')
  })
  const as = (email: string, init: RequestInit = {}) => ({ ...init, headers: { 'x-goog-authenticated-user-email': `accounts.google.com:${email}` } })

  it('is on the vault-only allowlist, takes POST only, reads no body, and answers the same to every caller', async () => {
    expect(mod.ZK_ROUTES.test('/api/basket/crawl')).toBe(true)
    expect(mod.ZK_ROUTES.test('/api/basket/crawl/now')).toBe(false)
    for (const zkOnly of [true, false]) {
      const app = mod.createApp({ zkOnly })
      const a = await app.request('/api/basket/crawl', as('scarab-history@proj.iam.gserviceaccount.com', { method: 'POST' }))
      const b = await app.request('/api/basket/crawl', as('max@example.com', { method: 'POST', body: '{"anything":1}' }))
      expect(a.status).toBe(200)
      expect(await a.json()).toEqual(await b.json())
      expect(await (await app.request('/api/basket/crawl', as('max@example.com', { method: 'POST' }))).json()).toMatchObject({ ran: null, waiting: 'no-basket', retryAfter: null })
      expect((await app.request('/api/basket/crawl', as('max@example.com'))).status).toBe(404) // GET: no such endpoint
    }
    expect(network).not.toHaveBeenCalled()
  })
})
