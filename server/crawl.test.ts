import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { addMonthsToMonth } from '../shared/dates'
import { runCrawl, type CrawlOptions } from './crawl'
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

/** Fake Yahoo spark: 24 months of closes for every symbol asked; `refuse` answers call n with that status. */
function fakeYahoo(refuse: (n: number) => number | null = () => null, onCall: () => void = () => {}) {
  const calls: string[][] = []
  const f = (async (input: string | URL | Request) => {
    const symbols = decodeURIComponent(new URL(String(input)).searchParams.get('symbols') ?? '').split(',')
    const n = calls.length
    calls.push(symbols)
    onCall()
    const status = refuse(n)
    if (status !== null) return new Response('{}', { status })
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
    db.prepare("UPDATE app_meta SET value = json_set(value, '$.calls', 640) WHERE key = 'basket:history:build'").run()
    expect(historyGate(db, NOW)).toEqual({ ready: false, why: 'day', waitMs: untilNextUtcDay(NOW) })
    expect(untilNextUtcDay(NOW)).toBe((24 - 9) * 3_600_000 - 17 * 60_000)
    db.prepare("UPDATE app_meta SET value = json_set(value, '$.calls', 1, '$.lastRunAt', ?) WHERE key = 'basket:history:build'").run(NOW.toISOString())
    expect(historyGate(db, later(5 * 60_000))).toEqual({ ready: false, why: 'gap', waitMs: HISTORY_RUN_GAP_MS - 5 * 60_000 })
    expect(historyGate(db, later(HISTORY_RUN_GAP_MS))).toEqual({ ready: true })
    db.prepare("UPDATE app_meta SET value = json_set(value, '$.blockedOn', '2026-10-02') WHERE key = 'basket:history:build'").run()
    expect(historyGate(db, later(HISTORY_RUN_GAP_MS))).toEqual({ ready: false, why: 'blocked', waitMs: untilNextUtcDay(later(HISTORY_RUN_GAP_MS)) })
  })
})

describe('runCrawl: the build inside one request', () => {
  afterEach(() => vi.useRealTimers())

  it('does nothing without a basket, and says so', async () => {
    const db = mem()
    const { f, calls } = fakeYahoo()
    const r = await runCrawl(db, f, NOW, quiet())
    expect(r).toEqual({
      ran: false,
      run: null,
      history: { ready: false, building: false, done: 0, total: 0, reason: 'The server has no price basket yet, so no market history either' },
      building: false,
      waiting: 'no-basket',
      retryAfter: null,
    })
    expect(calls).toHaveLength(0)
  })

  it('runs the build to the end when the budget allows, then reports the file current with nothing to retry', async () => {
    const db = mem()
    seedBasket(db, 45) // 46 symbols: 3 calls
    const { f, calls } = fakeYahoo()
    const r = await runCrawl(db, f, NOW, quiet())
    expect(r.ran).toBe(true)
    expect(r.run).toMatchObject({ calls: 3, fetched: 46, done: true, blocked: false })
    expect(r.history).toMatchObject({ ready: true, final: '2026-09', asOf: '2026-10-02' })
    expect(r).toMatchObject({ building: false, waiting: 'current', retryAfter: null })
    expect(calls).toHaveLength(3)
    expect(loadPack(db)!.final).toBe('2026-09')
    // Calling again is harmless: nothing is due.
    const again = await runCrawl(db, f, later(1), quiet())
    expect(again).toMatchObject({ ran: false, run: null, waiting: 'current', retryAfter: null })
    expect(calls).toHaveLength(3)
  })

  it('stops at the request budget with progress saved, tells the caller when to come back, and resumes there', async () => {
    const db = mem()
    seedBasket(db, 99) // 100 symbols: 5 calls
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    // Each Yahoo call "takes" 100 ms of wall clock; the budget allows two of them.
    const { f, calls } = fakeYahoo(() => null, () => vi.advanceTimersByTime(100))
    const r = await runCrawl(db, f, NOW, quiet({ budgetMs: 250 }))
    expect(r.ran).toBe(true)
    expect(r.run).toMatchObject({ calls: 3, done: false, blocked: false }) // the third call began before the clock passed the deadline
    expect(r.history).toMatchObject({ ready: false, building: true, done: 60, total: 100 })
    expect(r.building).toBe(false) // the run returned inside the request; nothing is left running
    expect(r.waiting).toBe('gap')
    expect(r.retryAfter).toBe(HISTORY_RUN_GAP_MS / 1000)
    // Too soon: nothing runs, the wait shrinks.
    const soon = await runCrawl(db, f, later(5 * 60_000), quiet())
    expect(soon).toMatchObject({ ran: false, run: null, waiting: 'gap', retryAfter: (HISTORY_RUN_GAP_MS - 5 * 60_000) / 1000 })
    expect(calls).toHaveLength(3)
    // After the gap: the rest, from where it stopped.
    vi.setSystemTime(later(HISTORY_RUN_GAP_MS))
    const rest = await runCrawl(db, f, later(HISTORY_RUN_GAP_MS), quiet())
    expect(rest.run).toMatchObject({ calls: 2, done: true })
    expect(calls[3]![0]).toBe('S60')
    expect(rest).toMatchObject({ waiting: 'current', retryAfter: null })
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
    expect(r).toMatchObject({ ran: true, run: null, building: true, waiting: 'running', retryAfter: 60 })
    release()
    expect(await theirs).toMatchObject({ calls: 1, done: false })
    expect(calls).toHaveLength(1)
  })

  it('a refusal pauses the build for the day: the caller is told to return tomorrow', async () => {
    const db = mem()
    seedBasket(db, 45)
    const { f } = fakeYahoo((n) => (n === 1 ? 429 : null))
    const r = await runCrawl(db, f, NOW, quiet())
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
      expect(await (await app.request('/api/basket/crawl', as('max@example.com', { method: 'POST' }))).json()).toMatchObject({ ran: false, waiting: 'no-basket', retryAfter: null })
      expect((await app.request('/api/basket/crawl', as('max@example.com'))).status).toBe(404) // GET: no such endpoint
    }
    expect(network).not.toHaveBeenCalled()
  })
})
