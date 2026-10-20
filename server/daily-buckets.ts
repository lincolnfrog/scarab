import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { DbLike } from '../engine/db'
import { decodeDaily, encodeDaily, isDailyBucket, type DayClose } from '../engine/prices'
import { DAILY_BUCKETS, DAILY_YEARS, dailyBucket, isBucketIndex } from '../shared/buckets'
import { addDaysIso, addMonthsIso } from '../shared/dates'
import type { DailyBucket, DailyPending, DailySeries, DailyStatus } from '../shared/series-api'
import { budgetGate, CRAWL_DAY_CALLS, CRAWL_PACE_MS, CRAWL_RUN_CALLS, noteCall, noteRefusal, noteRunStart, readBudget } from './crawl-budget'
import { basketUniverse, HISTORY_BATCH, sparkBars, sparkCall, SYMBOL_OK, yahooSymbols, type HistoryGate, type HistoryRun, type HistoryRunOptions } from './history-pack'
import { exchangeDay } from './prices'

/**
 * The daily market history, in hashed symbol buckets (PRIVACY.md, "Daily
 * history"): two years of daily closes for every symbol in the basket
 * universe, dealt into DAILY_BUCKETS files by shared/buckets.ts dailyBucket
 * and served one file at a time — GET /api/basket/daily/:bucket, the same
 * bytes for every caller. A zero-knowledge tab asks for the bucket a held
 * symbol falls in, never for the symbol: the server learns one of N, each
 * holding ~universe/N candidates. Wire shape: shared/series-api.ts DailyBucket.
 *
 * Built like the monthly file (./history-pack.ts) and on the same budget
 * (./crawl-budget.ts): Yahoo's spark endpoint, 20 symbols a call,
 * range=2y&interval=1d, one call per 1.5 s, resumable, a refusal pauses the
 * day. One crawl of the universe is about a day's budget. Between crawls each
 * daily basket build folds its quotes into every bucket (buildBasket →
 * appendDailyQuotes), so the crawl is one-time plus a monthly catch-up: once a
 * month has closed since the last crawl, the files are crawled again (a day
 * the basket missed, split adjustments, the window moving on). The files
 * being built never replace the ones served until the crawl is complete.
 * Runs are started by the scheduled trigger (POST /basket/crawl,
 * ./crawl.ts) or by someone asking for a bucket, never twice at once.
 *
 * Storage, all app_meta `basket:daily:*` keys (server infrastructure: never
 * in a snapshot, kept by the zero-knowledge purge):
 *   basket:daily:head          { v, of, start, asOf, builtAt, etags[] } — cheap to read
 *   basket:daily:file:<b>      bucket b, as served
 *   basket:daily:build         a crawl in progress: cursor, pause
 *   basket:daily:build:keys    its universe, fixed when it started
 *   basket:daily:part:<n>      its closes so far, a few batches per part
 */

const HEAD_KEY = 'basket:daily:head'
const FILE_PREFIX = 'basket:daily:file:'
const BUILD_KEY = 'basket:daily:build'
const KEYS_KEY = 'basket:daily:build:keys'
const PART_PREFIX = 'basket:daily:part:'
const SAVE_EVERY = 10
const GZIP_LEVEL = 6

type Book = { stock: Record<string, DailySeries>; crypto: Record<string, DailySeries> }
type Head = { v: 1; of: number; start: string; asOf: string; builtAt: string; etags: string[] }
type BuildState = { v: 1; startedOn: string; start: string; next: number; parts: number; missing: number; errors: string[] }

/* ---------------- app_meta ---------------- */

const getMeta = (db: DbLike, key: string) =>
  (db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined)?.value
const setMeta = (db: DbLike, key: string, value: string) =>
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
function readJson<T>(db: DbLike, key: string, ok: (x: unknown) => boolean): T | null {
  const v = getMeta(db, key)
  if (!v) return null
  try {
    const x: unknown = JSON.parse(v)
    return ok(x) ? (x as T) : null
  } catch {
    return null
  }
}
const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const isBook = (x: unknown) => isObject(x) && isObject(x.stock) && isObject(x.crypto)
const isHead = (x: unknown) =>
  isObject(x) && x.v === 1 && Number.isInteger(x.of) && typeof x.start === 'string' && typeof x.asOf === 'string' && Array.isArray(x.etags)
const isState = (x: unknown) => isObject(x) && x.v === 1 && typeof x.startedOn === 'string' && typeof x.start === 'string' && Number.isSafeInteger(x.next)

const readHead = (db: DbLike) => readJson<Head>(db, HEAD_KEY, isHead)
const readState = (db: DbLike) => readJson<BuildState>(db, BUILD_KEY, isState)
const readKeys = (db: DbLike) => readJson<string[]>(db, KEYS_KEY, (x) => Array.isArray(x) && x.every((k) => typeof k === 'string'))
const clearBuild = (db: DbLike) =>
  db.prepare(`DELETE FROM app_meta WHERE key IN (?, ?) OR key LIKE '${PART_PREFIX}%'`).run(BUILD_KEY, KEYS_KEY)
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/* ---------------- the files ---------------- */

/** One stored bucket, parsed; null before the first crawl finishes (or for a bucket number the server doesn't have). */
export function loadBucket(db: DbLike, bucket: number): DailyBucket | null {
  return readJson<DailyBucket>(db, `${FILE_PREFIX}${bucket}`, isDailyBucket)
}

const etagOf = (json: string) => `"${createHash('sha256').update(json).digest('hex').slice(0, 32)}"`

/** The newest day a series holds: its first day plus the entries after it (an encoding never ends in null). */
function lastDay(start: string, enc: DailySeries): string | null {
  const offset = enc[0]
  if (typeof offset !== 'number' || enc.length < 2) return null
  return addDaysIso(start, offset + enc.length - 2)
}

/** The newest close in a file, over every series. */
function newestDay(file: DailyBucket): string {
  let asOf = file.start
  for (const kind of ['stock', 'crypto'] as const)
    for (const enc of Object.values(file[kind])) {
      const d = lastDay(file.start, enc)
      if (d && d > asOf) asOf = d
    }
  return asOf
}

/**
 * Store a complete set of files and a head naming them (each ETag names
 * exactly its file's bytes). Everything in one transaction, so a request
 * never sees a head whose files aren't there.
 */
export function storeBuckets(db: DbLike, files: readonly DailyBucket[], builtAt: string): void {
  const jsons = files.map((f) => JSON.stringify(f))
  const head: Head = {
    v: 1,
    of: files.length,
    start: files[0]?.start ?? dayOf(new Date()),
    asOf: files.reduce((m, f) => (f.asOf > m ? f.asOf : m), files[0]?.start ?? ''),
    builtAt,
    etags: jsons.map(etagOf),
  }
  db.transaction(() => {
    db.prepare(`DELETE FROM app_meta WHERE key LIKE '${FILE_PREFIX}%'`).run()
    files.forEach((f, i) => setMeta(db, `${FILE_PREFIX}${f.bucket}`, jsons[i]!))
    setMeta(db, HEAD_KEY, JSON.stringify(head))
  })()
  bodies.clear()
}

/** For the trigger's report and the tab: are there files, how fresh, how many. */
export function dailyStatus(db: DbLike): DailyStatus {
  const head = readHead(db)
  return head ? { ready: true, asOf: head.asOf, of: head.of } : { ready: false, asOf: null, of: null }
}

/** The 202 body while there are no files yet, written for a person. */
export function dailyPending(db: DbLike, today = dayOf(new Date())): DailyPending {
  const state = readState(db)
  if (!state) {
    const basket = (db.prepare('SELECT count(*) AS n FROM basket_quotes').get() as { n: number }).n
    return {
      ready: false,
      building: false,
      done: 0,
      total: 0,
      reason: basket === 0 ? 'The server has no price basket yet, so no daily history either' : 'The server hasn’t built the daily history yet',
    }
  }
  const total = readKeys(db)?.length ?? 0
  const pct = total > 0 ? Math.floor((state.next * 100) / total) : 0
  return {
    ready: false,
    building: true,
    done: state.next,
    total,
    reason:
      readBudget(db, today).blockedOn === today
        ? `The server’s daily-history crawl paused after an upstream error (${pct}% done); it resumes tomorrow`
        : `The server is still building the daily history (${pct}% done)`,
  }
}

/* ---------------- folding the daily basket in ---------------- */

/**
 * Merge daily quotes into one file: each quote becomes its symbol's close for
 * the day it is dated — replacing that day's value if it is the symbol's
 * latest day, extending the series (across empty days) otherwise; a quote
 * older than the symbol's latest day is ignored (the crawl's closes are the
 * record), as is one before the file's first day or dated past tomorrow. A
 * symbol the file doesn't have yet (added to the basket since the crawl)
 * starts a series. Returns whether anything changed. The caller has already
 * dealt the quotes to this file's bucket.
 */
export function mergeDailyQuotes(
  file: DailyBucket,
  quotes: readonly { symbol: string; kind: string; cents: number; pricedOn: string }[],
  today: string,
): boolean {
  const latest = addDaysIso(today, 1) // a quote stamped tomorrow in UTC is still today's
  let changed = false
  for (const q of quotes) {
    if (q.kind !== 'stock' && q.kind !== 'crypto') continue
    if (typeof q.symbol !== 'string' || !SYMBOL_OK.test(q.symbol) || !Number.isSafeInteger(q.cents) || q.cents <= 0) continue
    if (typeof q.pricedOn !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(q.pricedOn) || q.pricedOn > latest || q.pricedOn < file.start) continue
    const book = file[q.kind]
    const rows = (Object.hasOwn(book, q.symbol) ? decodeDaily(file.start, book[q.symbol]) : null) ?? []
    const last = rows[rows.length - 1]
    if (last && q.pricedOn < last.d) continue
    if (last && q.pricedOn === last.d) {
      if (last.c === q.cents) continue
      last.c = q.cents
    } else rows.push({ d: q.pricedOn, c: q.cents })
    book[q.symbol] = encodeDaily(file.start, rows)
    if (q.pricedOn > file.asOf) file.asOf = q.pricedOn
    changed = true
  }
  return changed
}

/**
 * The daily basket build's hook: fold today's quotes into every bucket they
 * belong to (no files yet: nothing to do). Returns how many files changed.
 * Each file is read, merged, written and let go in turn — never all of them
 * in memory at once.
 */
export function appendDailyQuotes(
  db: DbLike,
  quotes: readonly { symbol: string; kind: string; cents: number; pricedOn: string }[],
  today = dayOf(new Date()),
): number {
  const head = readHead(db)
  if (!head) return 0
  const byBucket = new Map<number, typeof quotes[number][]>()
  for (const q of quotes) {
    if ((q.kind !== 'stock' && q.kind !== 'crypto') || typeof q.symbol !== 'string' || !SYMBOL_OK.test(q.symbol)) continue
    const b = dailyBucket(q.kind, q.symbol, head.of)
    const list = byBucket.get(b)
    if (list) list.push(q)
    else byBucket.set(b, [q])
  }
  let changed = 0
  db.transaction(() => {
    for (const [b, qs] of byBucket) {
      const file = loadBucket(db, b)
      if (!file || !mergeDailyQuotes(file, qs, today)) continue
      const json = JSON.stringify(file)
      setMeta(db, `${FILE_PREFIX}${b}`, json)
      head.etags[b] = etagOf(json)
      if (file.asOf > head.asOf) head.asOf = file.asOf
      bodies.delete(b)
      changed++
    }
    if (changed > 0) setMeta(db, HEAD_KEY, JSON.stringify(head))
  })()
  return changed
}

/* ---------------- serving ---------------- */

type Body = { etag: string; json: string; gz: Promise<Uint8Array<ArrayBuffer> | null> }
/** One gzip per bucket, by bucket number, compressed off the event loop on first request (as the monthly file is). */
const bodies = new Map<number, Body>()
const gzipAsync = promisify(gzip)

function bucketBody(db: DbLike, head: Head, b: number): Body | null {
  const etag = head.etags[b]
  if (!etag) return null
  const cached = bodies.get(b)
  if (cached?.etag === etag) return cached
  const json = getMeta(db, `${FILE_PREFIX}${b}`)
  if (!json) return null
  const body: Body = {
    etag,
    json,
    gz: gzipAsync(json, { level: GZIP_LEVEL }).then(
      (buf) => new Uint8Array(buf),
      (e: unknown) => {
        console.error(`daily history: gzip of bucket ${b} failed; serving it uncompressed`, e)
        return null
      },
    ),
  }
  bodies.set(b, body)
  return body
}

/**
 * GET /api/basket/daily/:bucket: the same bytes for everyone — gzip when the
 * client takes it, with an ETag so a tab that has the file gets a 304 — 202
 * with the crawl's progress while there are no files yet, 404 for a bucket
 * number the server doesn't deal.
 */
export async function bucketResponse(db: DbLike, bucketParam: string, acceptEncoding: string | undefined, ifNoneMatch: string | undefined): Promise<Response> {
  const b = /^\d{1,3}$/.test(bucketParam) ? Number(bucketParam) : NaN
  const head = readHead(db)
  const of = head?.of ?? DAILY_BUCKETS
  if (!isBucketIndex(b, of)) return Response.json({ error: `no such bucket: the daily history is dealt into ${of} (0–${of - 1})` }, { status: 404 })
  const body = head && bucketBody(db, head, b)
  if (!body) return Response.json(dailyPending(db), { status: 202, headers: { 'cache-control': 'no-store' } })
  const headers: Record<string, string> = {
    etag: body.etag,
    'content-type': 'application/json; charset=utf-8',
    vary: 'accept-encoding',
    'cache-control': 'no-cache',
  }
  const tags = (ifNoneMatch ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''))
  if (tags.includes(body.etag)) return new Response(null, { status: 304, headers })
  if (/\bgzip\b/i.test(acceptEncoding ?? '')) {
    const gz = await body.gz
    if (gz) return new Response(gz, { status: 200, headers: { ...headers, 'content-encoding': 'gzip' } })
  }
  return new Response(body.json, { status: 200, headers })
}

/* ---------------- building ---------------- */

/**
 * A spark reply (range=2y, interval=1d) → each symbol's daily closes, oldest
 * first. A daily bar is stamped at its session's open — New York morning for a
 * US listing (the same UTC day), midnight UTC for crypto — so its UTC day is
 * its trading day; a reply that names an exchange zone (v7) is read in it.
 * Yahoo's live bar for a day in progress is the day's latest; a later bar for
 * the same day wins. Floats become integer cents here, once.
 */
export function parseSparkDaily(body: unknown, today: string): Map<string, DayClose[]> {
  const out = new Map<string, DayClose[]>()
  for (const b of sparkBars(body)) {
    const byDay = new Map<string, number>()
    for (let i = 0; i < b.ts.length; i++) {
      const t = b.ts[i]
      const c = b.closes[i]
      if (typeof t !== 'number' || !Number.isFinite(t) || typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
      const cents = Math.round(c * 100)
      if (!Number.isSafeInteger(cents) || cents <= 0) continue
      const day = exchangeDay(t, b.tz)
      if (day <= today) byDay.set(day, cents)
    }
    const rows = [...byDay].sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0)).map(([d, c]) => ({ d, c }))
    if (rows.length > 0) out.set(b.symbol, rows)
  }
  return out
}

type BatchResult = { bars: Map<string, DayClose[]> } | { error: string; blocked: boolean }

async function fetchBatch(keys: string[], f: typeof fetch, today: string): Promise<BatchResult> {
  const yahoo = yahooSymbols(keys)
  const reply = await sparkCall(yahoo, `${DAILY_YEARS}y`, '1d', f, 'daily history')
  if ('error' in reply) return reply
  const got = parseSparkDaily(reply.json, today)
  const bars = new Map<string, DayClose[]>()
  keys.forEach((k, i) => {
    const rows = got.get(yahoo[i]!)
    if (rows) bars.set(k, rows)
  })
  return { bars }
}

let inflight: Promise<HistoryRun> | null = null
export const isDailyBuilding = () => inflight !== null

/**
 * The crawl in progress, or a new one if one is due — when there are no files,
 * or a month has closed since the last crawl — else why there is none. A new
 * crawl needs a basket: the universe is today's basket.
 */
function dueCrawl(db: DbLike, now: Date): BuildState | 'current' | 'no-basket' {
  const state = readState(db)
  if (state) return state
  const today = dayOf(now)
  const head = readHead(db)
  if (head && head.builtAt.slice(0, 7) >= today.slice(0, 7)) return 'current'
  const keys = basketUniverse(db)
  if (keys.length === 0) return 'no-basket'
  const fresh: BuildState = { v: 1, startedOn: today, start: addMonthsIso(today, -12 * DAILY_YEARS), next: 0, parts: 0, missing: 0, errors: [] }
  db.transaction(() => {
    clearBuild(db)
    setMeta(db, KEYS_KEY, JSON.stringify(keys))
    setMeta(db, BUILD_KEY, JSON.stringify(fresh))
  })()
  return fresh
}

/** May a crawl run start now? Same answers as the monthly build's gate (history-pack.ts HistoryGate), on the shared budget. */
export function dailyGate(db: DbLike, now = new Date(), opts: HistoryRunOptions = {}): HistoryGate {
  if (inflight) return { ready: false, why: 'running' }
  const state = dueCrawl(db, now)
  if (typeof state === 'string') return { ready: false, why: state }
  return budgetGate(db, now, opts)
}

/** Start or continue a crawl if one is due and allowed now; otherwise null. Never two runs at once. */
export function ensureDailyBuckets(db: DbLike, f: typeof fetch = fetch, now = new Date(), opts: HistoryRunOptions = {}): Promise<HistoryRun> | null {
  if (inflight) return inflight
  if (!dailyGate(db, now, opts).ready) return null
  inflight = runCrawl(db, f, now, opts).finally(() => {
    inflight = null
  })
  return inflight
}

async function runCrawl(db: DbLike, f: typeof fetch, now: Date, o: HistoryRunOptions): Promise<HistoryRun> {
  const today = dayOf(now)
  const pace = o.paceMs ?? CRAWL_PACE_MS
  const runCalls = o.runCalls ?? CRAWL_RUN_CALLS
  const dayCalls = o.dayCalls ?? CRAWL_DAY_CALLS
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const state = readState(db)
  const keys = readKeys(db)
  if (!state || !keys) {
    clearBuild(db)
    return { calls: 0, fetched: 0, done: false, blocked: false, errors: ['daily history: crawl state unreadable; starting over'] }
  }
  noteRunStart(db, now)
  let dayUsed = readBudget(db, today).calls
  let part: Book = { stock: {}, crypto: {} }
  let batches = 0
  let calls = 0
  let fetched = 0
  let blocked = false
  const errors: string[] = []
  const save = () => {
    db.transaction(() => {
      if (batches > 0) {
        setMeta(db, `${PART_PREFIX}${state.parts}`, JSON.stringify(part))
        state.parts++
      }
      setMeta(db, BUILD_KEY, JSON.stringify(state))
    })()
    part = { stock: {}, crypto: {} }
    batches = 0
  }
  while (state.next < keys.length && calls < runCalls && dayUsed < dayCalls) {
    if (calls > 0) await sleep(pace)
    if (o.deadline !== undefined && Date.now() >= o.deadline) break
    const batch = keys.slice(state.next, state.next + HISTORY_BATCH)
    calls++
    dayUsed = noteCall(db, today)
    const got = await fetchBatch(batch, f, today)
    let found = 0
    if ('error' in got) {
      errors.push(got.error)
      if (got.blocked) {
        blocked = true
        noteRefusal(db, today)
        break
      }
    } else
      for (const [key, rows] of got.bars) {
        const kept = rows.filter((r) => r.d >= state.start)
        if (kept.length === 0) continue
        part[key.startsWith('c:') ? 'crypto' : 'stock'][key.slice(2)] = encodeDaily(state.start, kept)
        found++
      }
    fetched += found
    state.missing += batch.length - found
    state.next += batch.length
    batches++
    if (batches >= SAVE_EVERY) save()
  }
  state.errors = [...state.errors, ...errors].slice(-20)
  save()
  if (state.next < keys.length) return { calls, fetched, done: false, blocked, errors }
  assemble(db, state, now)
  return { calls, fetched, done: true, blocked, errors }
}

/** The last batch is in: deal the parts into buckets, fold today's basket in, and swap the files in. */
function assemble(db: DbLike, state: BuildState, now: Date): void {
  const today = dayOf(now)
  const builtAt = now.toISOString()
  const files: DailyBucket[] = Array.from({ length: DAILY_BUCKETS }, (_, bucket) => ({
    v: 1,
    bucket,
    of: DAILY_BUCKETS,
    start: state.start,
    asOf: state.start,
    builtAt,
    stock: {},
    crypto: {},
  }))
  for (let i = 0; i < state.parts; i++) {
    const part = readJson<Book>(db, `${PART_PREFIX}${i}`, isBook)
    if (!part) continue
    for (const kind of ['stock', 'crypto'] as const)
      for (const [sym, enc] of Object.entries(part[kind])) if (SYMBOL_OK.test(sym)) files[dailyBucket(kind, sym)]![kind][sym] = enc
  }
  const basket = db.prepare('SELECT symbol, kind, cents, priced_on AS pricedOn FROM basket_quotes').all() as {
    symbol: string
    kind: string
    cents: number
    pricedOn: string
  }[]
  const byBucket = new Map<number, typeof basket>()
  for (const q of basket) {
    if ((q.kind !== 'stock' && q.kind !== 'crypto') || !SYMBOL_OK.test(q.symbol)) continue
    const b = dailyBucket(q.kind, q.symbol)
    const list = byBucket.get(b)
    if (list) list.push(q)
    else byBucket.set(b, [q])
  }
  for (const file of files) {
    mergeDailyQuotes(file, byBucket.get(file.bucket) ?? [], today)
    file.asOf = newestDay(file)
  }
  db.transaction(() => {
    storeBuckets(db, files, builtAt)
    clearBuild(db)
  })()
}
