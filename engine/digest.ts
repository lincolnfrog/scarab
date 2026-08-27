import type { DbLike } from './db'
import { netWorthSeries, type NetWorthPoint } from './networth'
import { detectRecurring, type Recurrence } from './recurring'

/**
 * The "since you were last here" digest. Everything is derived on read from
 * the ledger against a per-person high-water mark stored in app_meta —
 * household mode keys it by IAP email, local mode by 'local'. Works
 * identically in both universes; the one household-only extra (a cached
 * mortgage-rate quote) degrades to whatever the snapshot carried.
 */

const seenKey = (email: string) => `digest:last_seen:${email}`
export const PMMS_KEY = 'rates:pmms30y' // JSON { on: 'yyyy-mm-dd', rateMicro }

// app_meta timestamps use SQLite's datetime('now') shape: 'YYYY-MM-DD HH:MM:SS' (UTC).
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const DAY = 86400000

export type DriftRow = { name: string; nowMicro: number; thenMicro: number; deltaMicro: number }
export type Digest = {
  since: string // datetime the digest covers from
  sinceDay: string
  netWorth: null | {
    baselineMonth: string
    totalCents: number
    deltaCents: number
    drivers: { name: string; deltaCents: number }[]
  }
  newTx: { count: number; uncategorized: number }
  newRecurring: Recurrence[]
  priceCreep: Recurrence[]
  lapsed: Recurrence[]
  allocationDrift: DriftRow[] // classes that moved ≥ 3 percentage points
  budgetOverruns: { name: string; budgetCents: number; actualCents: number }[]
  mortgage: null | {
    marketRateMicro: number
    marketOn: string
    bestLoanName: string
    bestLoanRateMicro: number
    triggered: boolean // market is ≥ 25bp below your best saved option
  }
  notable: boolean
}

function meta(db: DbLike, key: string): string | null {
  const r = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as { value: string } | undefined
  return r?.value ?? null
}
function setMeta(db: DbLike, key: string, value: string) {
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
}

const ASSET_CLASSES = ['cash', 'brokerage', 'retirement', 'crypto', 'property'] as const

export function getDigest(db: DbLike, email: string, today: string): Digest {
  const since = meta(db, seenKey(email)) ?? new Date(Date.parse(today) - 7 * DAY).toISOString().slice(0, 19).replace('T', ' ')
  const sinceDay = since.slice(0, 10)
  // Caught-up today: only genuinely incremental facts justify re-surfacing the
  // card — month-to-date deltas and standing alerts wait for tomorrow.
  const sameDay = sinceDay >= today

  // --- net worth vs a baseline month-end ---------------------------------
  const series = netWorthSeries(db, today)
  let netWorth: Digest['netWorth'] = null
  if (!sameDay && series.length >= 2) {
    const current = series[series.length - 1]!
    const sinceMonth = sinceDay.slice(0, 7)
    const baselineMonth = sinceMonth === current.month ? series[series.length - 2]!.month : sinceMonth
    let base: NetWorthPoint | undefined
    for (const p of series) if (p.month <= baselineMonth) base = p
    if (base && base.month !== current.month) {
      const drivers = [...ASSET_CLASSES.map((k) => ({ name: k as string, deltaCents: current[k] - base[k] })),
        { name: 'liabilities', deltaCents: current.liabilities - base.liabilities }]
        .filter((d) => d.deltaCents !== 0)
        .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
        .slice(0, 3)
      netWorth = { baselineMonth: base.month, totalCents: current.total, deltaCents: current.total - base.total, drivers }
    }
  }

  // --- rows that arrived since -------------------------------------------
  const newTx = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN category_id IS NULL THEN 1 ELSE 0 END) AS u
       FROM transactions WHERE created_at > ?`,
    )
    .get(since) as { n: number; u: number | null }

  // --- recurring: new, creeping, lapsed ----------------------------------
  const recurring = detectRecurring(db, today)
  const newRecurring = recurring.filter((r) => r.firstOn >= sinceDay && r.kind === 'expense')
  const priceCreep = recurring.filter((r) => r.priceCreepMicro > 0 && !r.lapsed && r.kind === 'expense')
  const lapsed = recurring.filter((r) => r.lapsed && r.kind === 'expense' && r.lastOn >= new Date(Date.parse(today) - 120 * DAY).toISOString().slice(0, 10))

  // --- allocation drift ---------------------------------------------------
  const allocationDrift: DriftRow[] = []
  if (series.length >= 2 && netWorth) {
    const current = series[series.length - 1]!
    let base: NetWorthPoint | undefined
    for (const p of series) if (p.month <= netWorth.baselineMonth) base = p
    if (base) {
      const tot = (p: NetWorthPoint) => ASSET_CLASSES.reduce((s, k) => s + p[k], 0)
      const ct = tot(current)
      const bt = tot(base)
      if (ct > 0 && bt > 0)
        for (const k of ASSET_CLASSES) {
          const nowMicro = Math.round((current[k] * 1_000_000) / ct)
          const thenMicro = Math.round((base[k] * 1_000_000) / bt)
          if (Math.abs(nowMicro - thenMicro) >= 30_000)
            allocationDrift.push({ name: k, nowMicro, thenMicro, deltaMicro: nowMicro - thenMicro })
        }
    }
  }

  // --- budget overruns this month ----------------------------------------
  const month = today.slice(0, 7)
  const budgetOverruns = (db
    .prepare(
      `SELECT c.name, b.monthly_cents AS budgetCents,
              COALESCE((SELECT SUM(-t.amount_cents) FROM transactions t
                        WHERE t.category_id = c.id AND t.posted_on LIKE ? AND t.amount_cents < 0), 0) AS actualCents
       FROM budgets b JOIN categories c ON c.id = b.category_id
       WHERE c.kind = 'expense' AND b.monthly_cents > 0`,
    )
    .all(`${month}%`) as { name: string; budgetCents: number; actualCents: number }[])
    .filter((r) => r.actualCents > r.budgetCents)
    .sort((a, b) => (b.actualCents - b.budgetCents) - (a.actualCents - a.budgetCents))
    .slice(0, 3)

  // --- mortgage-rate trigger vs saved loan options ------------------------
  let mortgage: Digest['mortgage'] = null
  const pmmsRaw = meta(db, PMMS_KEY)
  if (pmmsRaw) {
    try {
      const pmms = JSON.parse(pmmsRaw) as { on: string; rateMicro: number }
      const best = db
        .prepare('SELECT name, rate_micro FROM loan_options ORDER BY rate_micro ASC LIMIT 1')
        .get() as { name: string; rate_micro: number } | undefined
      if (best && pmms.rateMicro > 0)
        mortgage = {
          marketRateMicro: pmms.rateMicro,
          marketOn: pmms.on,
          bestLoanName: best.name,
          bestLoanRateMicro: best.rate_micro,
          triggered: pmms.rateMicro <= best.rate_micro - 2_500,
        }
    } catch { /* stale/garbled cache — omit the section */ }
  }

  const notable = sameDay
    ? newTx.n > 0 || newRecurring.length > 0
    : (netWorth !== null && netWorth.deltaCents !== 0) ||
      newTx.n > 0 ||
      newRecurring.length > 0 ||
      priceCreep.length > 0 ||
      lapsed.length > 0 ||
      allocationDrift.length > 0 ||
      budgetOverruns.length > 0 ||
      (mortgage?.triggered ?? false)

  return {
    since,
    sinceDay,
    netWorth,
    newTx: { count: newTx.n, uncategorized: newTx.u ?? 0 },
    newRecurring,
    priceCreep,
    lapsed,
    allocationDrift,
    budgetOverruns,
    mortgage,
    notable,
  }
}

export function ackDigest(db: DbLike, email: string) {
  setMeta(db, seenKey(email), nowStamp())
  return { ok: true as const, seenAt: nowStamp() }
}

/** Store today's market mortgage rate (server-side fetcher writes through here). */
export function putPmmsRate(db: DbLike, on: string, rateMicro: number) {
  setMeta(db, PMMS_KEY, JSON.stringify({ on, rateMicro }))
  return { ok: true as const }
}
