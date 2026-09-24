import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import type { MarketHistory } from '../engine/analytics'
import type { DbLike } from '../engine/db'
import { applyMonthlyHistory, decodeMonthly, encodeMonthly, isHistoryPack, packMarket, type MonthClose } from '../engine/prices'
import { addDaysIso, addMonthsToMonth } from '../shared/dates'
import type { HistoryApplyResult, HistoryPack, HistoryPending, HistorySeries, HistoryStatus } from '../shared/series-api'
import { exchangeDay } from './prices'
import { upstreamSignal } from './upstream'

/**
 * The monthly market history: month-end closes for the whole basket universe
 * (every US-listed stock and ETF plus the top crypto) over ten years, served as
 * ONE file that is identical for every caller — GET /api/basket/history. It is
 * the basket's companion: a zero-knowledge tab downloads it whole and picks
 * out its own symbols locally, so asking for history tells the server nothing
 * about what anyone holds. Wire shape: shared/series-api.ts HistoryPack.
 *
 * Built from Yahoo's v8 spark endpoint, 20 symbols per call (its limit), about
 * 630 calls for the universe. That is a lot to ask of a keyless API from one
 * datacenter IP, so the build is gentle and resumable:
 *   - one call at a time, HISTORY_PACE_MS apart;
 *   - a run makes at most HISTORY_RUN_CALLS calls, runs start at least
 *     HISTORY_RUN_GAP_MS apart, and a day allows HISTORY_DAY_CALLS;
 *   - progress is saved every few batches, so a restart loses little and the
 *     next run picks up where the last one stopped;
 *   - Yahoo refusing (429/403/5xx, an unreadable reply, a network error) ends
 *     the run and pauses the build until the next day.
 * Runs are started only by someone wanting the history (GET /basket/history,
 * GET /series/catalog), never on a timer, and never twice at once.
 *
 * A full build happens when there is no file, and again each month once a new
 * month has closed (so the months since the last build become true month-end
 * closes, and split adjustments stay consistent). Between builds each daily
 * basket build merges its quotes in (buildBasket → appendToHistory), keeping
 * the month in progress current. The file being built never replaces the one
 * being served until it is complete; until the first one is, the route
 * answers 202.
 *
 * Storage, all app_meta `basket:*` keys (server infrastructure: never in a
 * snapshot, kept by the zero-knowledge purge):
 *   basket:history:v1           the file, as served
 *   basket:history:head         { etag, final, asOf, builtAt, symbols } — cheap to read
 *   basket:history:build        a build in progress: cursor, call budget, pause
 *   basket:history:build:keys   its universe, fixed when it started
 *   basket:history:part:<n>     its closes so far, a few batches per part
 */

export const HISTORY_KEY = 'basket:history:v1'
const HEAD_KEY = 'basket:history:head'
const BUILD_KEY = 'basket:history:build'
const KEYS_KEY = 'basket:history:build:keys'
const PART_PREFIX = 'basket:history:part:'

export const HISTORY_YEARS = 10
/** Yahoo spark answers 400 for more than 20 symbols per call. */
export const HISTORY_BATCH = 20
export const HISTORY_PACE_MS = 1_500
export const HISTORY_RUN_CALLS = 160
export const HISTORY_RUN_GAP_MS = 20 * 60_000
export const HISTORY_DAY_CALLS = 640
/** Batches between progress saves. */
const SAVE_EVERY = 10

const UA = { 'user-agent': 'Mozilla/5.0 (scarab price basket)' }
/** Symbols the file can carry: Yahoo spelling (BRK-B, ^GSPC) and plain tickers — never a prototype name. */
const SYMBOL_OK = /^[\^A-Z0-9][A-Z0-9.=-]{0,23}$/

type Book = { stock: Record<string, HistorySeries>; crypto: Record<string, HistorySeries> }
type Head = { etag: string; final: string; asOf: string; builtAt: string; symbols: number }
type BuildState = {
  v: 1
  startedOn: string // the day it started: `final` is the month before
  start: string // month 0 of every offset in its parts
  next: number // index into its keys
  parts: number
  day: string // the day `calls` counts
  calls: number
  lastRunAt: string | null
  blockedOn: string | null // Yahoo refused on this day: no more runs until the next
  missing: number // symbols Yahoo had no history for
  errors: string[] // the latest few
}
export type HistoryRun = { calls: number; fetched: number; done: boolean; blocked: boolean; errors: string[] }
export type HistoryRunOptions = {
  paceMs?: number
  runCalls?: number
  dayCalls?: number
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}

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
const isHead = (x: unknown) => isObject(x) && typeof x.etag === 'string' && typeof x.final === 'string' && typeof x.asOf === 'string'
const isState = (x: unknown) => isObject(x) && x.v === 1 && typeof x.startedOn === 'string' && typeof x.start === 'string' && Number.isSafeInteger(x.next)

const readHead = (db: DbLike) => readJson<Head>(db, HEAD_KEY, isHead)
const readState = (db: DbLike) => readJson<BuildState>(db, BUILD_KEY, isState)
const readKeys = (db: DbLike) => readJson<string[]>(db, KEYS_KEY, (x) => Array.isArray(x) && x.every((k) => typeof k === 'string'))
const clearBuild = (db: DbLike) =>
  db.prepare(`DELETE FROM app_meta WHERE key IN (?, ?) OR key LIKE '${PART_PREFIX}%'`).run(BUILD_KEY, KEYS_KEY)

const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/* ---------------- the file ---------------- */

/** The stored file, parsed; null before the first build finishes. */
export function loadPack(db: DbLike): HistoryPack | null {
  return readJson<HistoryPack>(db, HISTORY_KEY, isHistoryPack)
}

/** Store a file and its head (the ETag names exactly these bytes). */
export function storePack(db: DbLike, pack: HistoryPack): void {
  const json = JSON.stringify(pack)
  const etag = `"${createHash('sha256').update(json).digest('hex').slice(0, 32)}"`
  const head: Head = {
    etag,
    final: pack.final,
    asOf: pack.asOf,
    builtAt: pack.builtAt,
    symbols: Object.keys(pack.stock).length + Object.keys(pack.crypto).length,
  }
  db.transaction(() => {
    setMeta(db, HISTORY_KEY, json)
    setMeta(db, HEAD_KEY, JSON.stringify(head))
  })()
  // Compress it now, off the event loop, so the first GET after the daily build doesn't wait for it.
  cacheBody(etag, json)
}

/** For GET /api/basket: is there a file, and which one. */
export function historyStatus(db: DbLike): HistoryStatus {
  const head = readHead(db)
  return head ? { ready: true, etag: head.etag, final: head.final, asOf: head.asOf } : { ready: false, etag: null, final: null, asOf: null }
}

/** The 202 body while there is no file yet. The reason is written for a person (Compare shows it on a greyed benchmark). */
export function historyPending(db: DbLike, today = dayOf(new Date())): HistoryPending {
  const state = readState(db)
  if (!state) {
    const basket = (db.prepare('SELECT count(*) AS n FROM basket_quotes').get() as { n: number }).n
    return {
      ready: false,
      building: false,
      done: 0,
      total: 0,
      reason: basket === 0 ? 'The server has no price basket yet, so no market history either' : 'The server hasn’t built the market history yet',
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
      state.blockedOn === today
        ? `The server’s market-history build paused after an upstream error (${pct}% done); it resumes tomorrow`
        : `The server is still building the market history (${pct}% done)`,
  }
}

/**
 * Merge daily quotes into a file: each quote becomes its symbol's close for
 * the month it is dated in — replacing that month's value if it is the
 * symbol's latest month, starting a new month (after empty months if any)
 * otherwise. Months through `final` are Yahoo's month-end closes and stay
 * as built; a quote older than the symbol's latest month is ignored. Returns
 * whether anything changed.
 */
export function mergeQuotes(
  pack: HistoryPack,
  quotes: readonly { symbol: string; kind: string; cents: number; pricedOn: string }[],
  today: string,
): boolean {
  const latest = addDaysIso(today, 1) // a quote stamped tomorrow in UTC is still today's
  let changed = false
  for (const q of quotes) {
    if (q.kind !== 'stock' && q.kind !== 'crypto') continue
    if (typeof q.symbol !== 'string' || !SYMBOL_OK.test(q.symbol) || !Number.isSafeInteger(q.cents) || q.cents <= 0) continue
    if (typeof q.pricedOn !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(q.pricedOn) || q.pricedOn > latest) continue
    const month = q.pricedOn.slice(0, 7)
    if (month <= pack.final || month < pack.start) continue
    const book = pack[q.kind]
    const rows = (Object.hasOwn(book, q.symbol) ? decodeMonthly(pack.start, book[q.symbol]) : null) ?? []
    const last = rows[rows.length - 1]
    if (last && month < last.month) continue
    if (q.pricedOn > pack.asOf) {
      pack.asOf = q.pricedOn
      changed = true
    }
    if (last && month === last.month) {
      if (last.cents === q.cents) continue
      last.cents = q.cents
    } else rows.push({ month, cents: q.cents })
    book[q.symbol] = encodeMonthly(pack.start, rows)
    changed = true
  }
  return changed
}

/** The daily basket build's hook: merge today's quotes into the stored file (no file yet: nothing to do). */
export function appendToHistory(
  db: DbLike,
  quotes: readonly { symbol: string; kind: string; cents: number; pricedOn: string }[],
  today = dayOf(new Date()),
): boolean {
  const pack = loadPack(db)
  if (!pack || !mergeQuotes(pack, quotes, today)) return false
  storePack(db, pack)
  return true
}

/* ---------------- serving ---------------- */

/**
 * One gzip per file, shared by every caller; the head's ETag says when it
 * changed. It is compressed once — by storePack as the file is written, or by
 * the first request after a restart — on zlib's thread pool, never on the
 * request path of the single instance: a synchronous level-9 gzip of the file
 * (~3.5 MB of JSON) blocked every request, vault saves included, for over a
 * second, where level 6 is half the work for a file 0.6% bigger. Callers that
 * arrive while it runs share the one promise. `gz` null: compression failed,
 * serve the JSON as it is.
 */
const GZIP_LEVEL = 6
const gzipAsync = promisify(gzip)
type Body = { etag: string; json: string; gz: Promise<Uint8Array<ArrayBuffer> | null> }
let body: Body | null = null
let parsed: { etag: string; pack: HistoryPack; market: MarketHistory } | null = null

function cacheBody(etag: string, json: string): Body {
  const gz = gzipAsync(json, { level: GZIP_LEVEL }).then(
    (b) => new Uint8Array(b),
    (e: unknown) => {
      console.error('market history: gzip failed; serving it uncompressed', e)
      return null
    },
  )
  body = { etag, json, gz }
  return body
}

function packBody(db: DbLike): Body | null {
  const head = readHead(db)
  if (!head) return null
  if (body?.etag === head.etag) return body
  const json = getMeta(db, HISTORY_KEY)
  return json ? cacheBody(head.etag, json) : null
}

/**
 * GET /api/basket/history: the same bytes for everyone — gzip when the client
 * takes it, with an ETag so a tab that has the file gets a 304 — or 202 with
 * the build's progress while there is no file yet.
 */
export async function packResponse(db: DbLike, acceptEncoding: string | undefined, ifNoneMatch: string | undefined): Promise<Response> {
  const b = packBody(db)
  if (!b) return Response.json(historyPending(db), { status: 202, headers: { 'cache-control': 'no-store' } })
  // no-cache: a browser keeps the file but asks each time, and an unchanged one is a 304.
  const headers: Record<string, string> = {
    etag: b.etag,
    'content-type': 'application/json; charset=utf-8',
    vary: 'accept-encoding',
    'cache-control': 'no-cache',
  }
  const tags = (ifNoneMatch ?? '').split(',').map((t) => t.trim().replace(/^W\//, ''))
  if (tags.includes(b.etag)) return new Response(null, { status: 304, headers })
  if (/\bgzip\b/i.test(acceptEncoding ?? '')) {
    const gz = await b.gz
    if (gz) return new Response(gz, { status: 200, headers: { ...headers, 'content-encoding': 'gzip' } })
  }
  return new Response(b.json, { status: 200, headers })
}

function parsedPack(db: DbLike): { pack: HistoryPack; market: MarketHistory } | null {
  const head = readHead(db)
  if (!head) return null
  if (parsed?.etag !== head.etag) {
    const pack = loadPack(db)
    if (!pack) return null
    parsed = { etag: head.etag, pack, market: packMarket(pack) }
  }
  return parsed
}

/** The file as the series layer's benchmarks read it, in memory; or why there is none. */
export function serverMarket(db: DbLike): { market?: MarketHistory; marketPending?: string } {
  const p = parsedPack(db)
  return p ? { market: p.market } : { marketPending: historyPending(db).reason }
}

/** POST /api/prices/history on a household server: apply the stored file to the household's own assets. */
export function applyServerHistory(db: DbLike): HistoryApplyResult {
  const p = parsedPack(db)
  return p ? applyMonthlyHistory(db, p.pack) : { written: 0, matched: 0, errors: [], final: null, pending: true }
}

/* ---------------- building ---------------- */

type SparkBars = { symbol: string; ts: unknown[]; closes: unknown[]; tz?: string }

/** Both spark shapes: v8's flat { SYM: { timestamp, close } } and v7's { spark: { result: [...] } }. */
function sparkBars(body: unknown): SparkBars[] {
  if (!isObject(body)) return []
  if (isObject(body.spark)) {
    const results = body.spark.result
    if (!Array.isArray(results)) return []
    const out: SparkBars[] = []
    for (const r of results as Record<string, unknown>[]) {
      const resp = (r?.response as Record<string, unknown>[] | undefined)?.[0]
      if (typeof r?.symbol !== 'string' || !isObject(resp)) continue
      const quote = (resp.indicators as { quote?: { close?: unknown }[] } | undefined)?.quote?.[0]?.close
      const tz = (resp.meta as { exchangeTimezoneName?: unknown } | undefined)?.exchangeTimezoneName
      out.push({
        symbol: r.symbol,
        ts: Array.isArray(resp.timestamp) ? resp.timestamp : [],
        closes: Array.isArray(quote) ? quote : [],
        ...(typeof tz === 'string' ? { tz } : {}),
      })
    }
    return out
  }
  const out: SparkBars[] = []
  for (const [key, v] of Object.entries(body))
    if (isObject(v) && Array.isArray(v.timestamp) && Array.isArray(v.close))
      out.push({ symbol: typeof v.symbol === 'string' ? v.symbol : key, ts: v.timestamp, closes: v.close })
  return out
}

/**
 * A spark reply (range=10y, interval=1mo) → each symbol's month closes, oldest
 * first. A monthly bar carries the month's last close but is stamped at the
 * month's open, local midnight — so the month is read in the exchange's zone
 * when the reply names it (v7), else in UTC (v8 doesn't; for US listings and
 * crypto, the universe, the open still falls on the 1st in UTC). Yahoo appends
 * a live bar for the month in progress: the later bar wins its month. Floats
 * become integer cents here, once.
 */
export function parseSparkHistory(body: unknown, today: string): Map<string, MonthClose[]> {
  const out = new Map<string, MonthClose[]>()
  const thisMonth = today.slice(0, 7)
  for (const b of sparkBars(body)) {
    const byMonth = new Map<string, number>()
    for (let i = 0; i < b.ts.length; i++) {
      const t = b.ts[i]
      const c = b.closes[i]
      if (typeof t !== 'number' || !Number.isFinite(t) || typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue
      const cents = Math.round(c * 100)
      if (!Number.isSafeInteger(cents) || cents <= 0) continue
      const month = exchangeDay(t, b.tz).slice(0, 7)
      if (month <= thisMonth) byMonth.set(month, cents)
    }
    const rows = [...byMonth].sort(([a], [z]) => (a < z ? -1 : a > z ? 1 : 0)).map(([month, cents]) => ({ month, cents }))
    if (rows.length > 0) out.set(b.symbol, rows)
  }
  return out
}

type BatchResult = { bars: Map<string, MonthClose[]> } | { error: string; blocked: boolean }

/** One spark call for up to HISTORY_BATCH universe keys ('s:SYM' / 'c:SYM'). */
async function fetchBatch(keys: string[], f: typeof fetch, today: string): Promise<BatchResult> {
  const yahoo = keys.map((k) => (k.startsWith('c:') ? `${k.slice(2)}-USD` : k.slice(2)))
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(yahoo.join(','))}&range=${HISTORY_YEARS}y&interval=1mo`
  let r: Response
  try {
    r = await f(url, { headers: UA, signal: upstreamSignal() })
  } catch (e) {
    return { error: `history: ${yahoo[0]}… ${e instanceof Error ? e.message : 'fetch failed'}`, blocked: true }
  }
  if (r.status === 429 || r.status === 403 || r.status === 999 || r.status >= 500)
    return { error: `history: Yahoo HTTP ${r.status} at ${yahoo[0]}…`, blocked: true }
  if (!r.ok) return { error: `history: batch ${yahoo[0]}… HTTP ${r.status}`, blocked: false }
  let json: unknown
  try {
    json = await r.json()
  } catch {
    return { error: `history: batch ${yahoo[0]}… unreadable reply`, blocked: true } // a consent or block page, typically
  }
  const got = parseSparkHistory(json, today)
  const bars = new Map<string, MonthClose[]>()
  keys.forEach((k, i) => {
    const rows = got.get(yahoo[i]!)
    if (rows) bars.set(k, rows)
  })
  return { bars }
}

/** The universe for a new build: today's basket, as 's:SYM' / 'c:SYM'. */
function universe(db: DbLike): string[] {
  const rows = db.prepare('SELECT symbol, kind FROM basket_quotes ORDER BY kind DESC, symbol').all() as { symbol: string; kind: string }[]
  return rows.filter((r) => SYMBOL_OK.test(r.symbol)).map((r) => `${r.kind === 'crypto' ? 'c' : 's'}:${r.symbol}`)
}

let inflight: Promise<HistoryRun> | null = null
export const isHistoryBuilding = () => inflight !== null

/**
 * Start or continue a build if one is due and allowed now; otherwise null.
 * Never two runs at once (a caller during a run gets the running one). A new
 * build is due when there is no file, or when a month has closed since the
 * last build's `final`. It needs a basket: the universe is today's basket.
 */
export function ensureHistoryPack(
  db: DbLike,
  f: typeof fetch = fetch,
  now = new Date(),
  opts: HistoryRunOptions = {},
): Promise<HistoryRun> | null {
  if (inflight) return inflight
  const today = dayOf(now)
  let state = readState(db)
  if (!state) {
    const head = readHead(db)
    if (head && head.final >= addMonthsToMonth(today.slice(0, 7), -1)) return null
    const keys = universe(db)
    if (keys.length === 0) return null
    const fresh: BuildState = {
      v: 1,
      startedOn: today,
      start: addMonthsToMonth(today.slice(0, 7), -12 * HISTORY_YEARS),
      next: 0,
      parts: 0,
      day: today,
      calls: 0,
      lastRunAt: null,
      blockedOn: null,
      missing: 0,
      errors: [],
    }
    db.transaction(() => {
      clearBuild(db)
      setMeta(db, KEYS_KEY, JSON.stringify(keys))
      setMeta(db, BUILD_KEY, JSON.stringify(fresh))
    })()
    state = fresh
  }
  if (state.blockedOn === today) return null
  if (state.lastRunAt && now.getTime() - Date.parse(state.lastRunAt) < (opts.gapMs ?? HISTORY_RUN_GAP_MS)) return null
  if (state.day === today && state.calls >= (opts.dayCalls ?? HISTORY_DAY_CALLS)) return null
  inflight = runBuild(db, f, now, opts).finally(() => {
    inflight = null
  })
  return inflight
}

async function runBuild(db: DbLike, f: typeof fetch, now: Date, o: HistoryRunOptions): Promise<HistoryRun> {
  const today = dayOf(now)
  const pace = o.paceMs ?? HISTORY_PACE_MS
  const runCalls = o.runCalls ?? HISTORY_RUN_CALLS
  const dayCalls = o.dayCalls ?? HISTORY_DAY_CALLS
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const state = readState(db)
  const keys = readKeys(db)
  if (!state || !keys) {
    clearBuild(db) // unreadable build state: the next call starts over
    return { calls: 0, fetched: 0, done: false, blocked: false, errors: ['history: build state unreadable; starting over'] }
  }
  if (state.day !== today) {
    state.day = today
    state.calls = 0
  }
  state.lastRunAt = now.toISOString()
  setMeta(db, BUILD_KEY, JSON.stringify(state))

  let part: Book = { stock: {}, crypto: {} }
  let batches = 0
  let calls = 0
  let fetched = 0
  let blocked = false
  const errors: string[] = []
  // The cursor and the closes it covers are saved together, so a restart refetches only unsaved batches.
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
  while (state.next < keys.length && calls < runCalls && state.calls < dayCalls) {
    if (calls > 0) await sleep(pace)
    const batch = keys.slice(state.next, state.next + HISTORY_BATCH)
    calls++
    state.calls++
    const got = await fetchBatch(batch, f, today)
    let found = 0
    if ('error' in got) {
      errors.push(got.error)
      if (got.blocked) {
        blocked = true
        state.blockedOn = today
        break // this batch is retried by the next run
      }
    } else
      for (const [key, rows] of got.bars) {
        const kept = rows.filter((r) => r.month >= state.start)
        if (kept.length === 0) continue
        part[key.startsWith('c:') ? 'crypto' : 'stock'][key.slice(2)] = encodeMonthly(state.start, kept)
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

/** The last batch is in: put the parts together, bring the month in progress up to today's basket, and swap it in. */
function assemble(db: DbLike, state: BuildState, now: Date): void {
  const today = dayOf(now)
  const pack: HistoryPack = {
    v: 1,
    start: state.start,
    final: addMonthsToMonth(state.startedOn.slice(0, 7), -1),
    asOf: today,
    builtAt: now.toISOString(),
    stock: {},
    crypto: {},
  }
  for (let i = 0; i < state.parts; i++) {
    const part = readJson<Book>(db, `${PART_PREFIX}${i}`, isBook)
    if (!part) continue
    for (const kind of ['stock', 'crypto'] as const)
      for (const [sym, enc] of Object.entries(part[kind])) if (SYMBOL_OK.test(sym)) pack[kind][sym] = enc
  }
  const basket = db.prepare('SELECT symbol, kind, cents, priced_on AS pricedOn FROM basket_quotes').all() as {
    symbol: string
    kind: string
    cents: number
    pricedOn: string
  }[]
  mergeQuotes(pack, basket, today)
  db.transaction(() => {
    storePack(db, pack)
    clearBuild(db)
  })()
}
