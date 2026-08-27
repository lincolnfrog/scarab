import type { DbLike } from './db'
import { extractMerchant } from './import'

/**
 * Recurring-transaction detection. Pure derivation from the ledger: group by
 * extracted merchant, look at the rhythm of the dates, and classify the
 * cadence. Nothing is stored — a merchant "is recurring" only as long as the
 * facts keep saying so.
 *
 * The gate is cadence consistency, not amount: a utility bill that swings with
 * the seasons is still recurring; an irregular shop at the same store is not.
 */

export type Cadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly'

export type Recurrence = {
  merchant: string
  kind: 'income' | 'expense'
  category: string | null
  cadence: Cadence
  intervalDays: number // median observed gap
  typicalCents: number // median absolute amount, always positive
  lastCents: number
  firstOn: string
  lastOn: string
  nextExpectedOn: string
  occurrences: number
  lapsed: boolean // overdue by more than half a cycle
  priceCreepMicro: number // last vs typical, when last is ≥10% higher (else 0)
}

const DAY = 86400000
const CADENCE_BANDS: { name: Cadence; lo: number; hi: number }[] = [
  { name: 'weekly', lo: 5, hi: 9 },
  { name: 'biweekly', lo: 12, hi: 17 },
  { name: 'monthly', lo: 26, hi: 36 },
  { name: 'quarterly', lo: 80, hi: 100 },
  { name: 'yearly', lo: 340, hi: 395 },
]

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2)
}
const shiftDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY).toISOString().slice(0, 10)

export function detectRecurring(db: DbLike, today: string): Recurrence[] {
  const rows = db
    .prepare(
      `SELECT t.posted_on, t.amount_cents, t.description, c.name AS category, c.kind AS cat_kind
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE c.kind IS NULL OR c.kind != 'transfer'
       ORDER BY t.posted_on`,
    )
    .all() as { posted_on: string; amount_cents: number; description: string; category: string | null; cat_kind: string | null }[]

  // Group by merchant + direction; same-day rows at one merchant collapse into
  // one occurrence (split charges, partial captures).
  type Occ = { on: string; cents: number }
  const groups = new Map<string, { kind: 'income' | 'expense'; merchant: string; category: string | null; occs: Occ[] }>()
  for (const r of rows) {
    const merchant = extractMerchant(r.description)
    if (merchant.length < 3) continue
    const kind: 'income' | 'expense' = r.amount_cents > 0 ? 'income' : 'expense'
    const key = `${kind}:${merchant}`
    let g = groups.get(key)
    if (!g) {
      g = { kind, merchant, category: r.category, occs: [] }
      groups.set(key, g)
    }
    if (r.category) g.category = r.category
    const last = g.occs[g.occs.length - 1]
    if (last && last.on === r.posted_on) last.cents += Math.abs(r.amount_cents)
    else g.occs.push({ on: r.posted_on, cents: Math.abs(r.amount_cents) })
  }

  const out: Recurrence[] = []
  for (const g of groups.values()) {
    if (g.occs.length < 3) continue
    const gaps: number[] = []
    for (let i = 1; i < g.occs.length; i++)
      gaps.push(Math.round((Date.parse(g.occs[i]!.on) - Date.parse(g.occs[i - 1]!.on)) / DAY))
    const med = median(gaps)
    const band = CADENCE_BANDS.find((b) => med >= b.lo && med <= b.hi)
    if (!band) continue
    const inBand = gaps.filter((d) => d >= band.lo && d <= band.hi).length
    if (inBand / gaps.length < 0.6) continue

    const amounts = g.occs.map((o) => o.cents)
    const typical = median(amounts)
    const last = g.occs[g.occs.length - 1]!
    const nextExpected = shiftDays(last.on, med)
    const lapsed = Date.parse(today) - Date.parse(nextExpected) > (med / 2) * DAY
    const creep = typical > 0 && last.cents >= Math.round(typical * 1.1)
      ? Math.round(((last.cents - typical) * 1_000_000) / typical)
      : 0
    out.push({
      merchant: g.merchant,
      kind: g.kind,
      category: g.category,
      cadence: band.name,
      intervalDays: med,
      typicalCents: typical,
      lastCents: last.cents,
      firstOn: g.occs[0]!.on,
      lastOn: last.on,
      nextExpectedOn: nextExpected,
      occurrences: g.occs.length,
      lapsed,
      priceCreepMicro: creep,
    })
  }
  out.sort((a, b) => b.typicalCents - a.typicalCents)
  return out
}

/* --------------------------- safe to spend --------------------------- */

export type SafeToSpend = {
  month: string
  budgetCents: number // total monthly expense budget
  spentCents: number // actual spend so far this month (excl. transfers)
  upcomingBillsCents: number // recurring bills expected before month end, not yet posted
  safeCents: number // budget − spent − upcoming
  expectedIncomeRemainingCents: number
  bills: { merchant: string; cents: number; due: string }[]
}

const daysInMonth = (month: string) => new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()

export function safeToSpend(db: DbLike, today: string, recurring: Recurrence[]): SafeToSpend {
  const month = today.slice(0, 7)
  const monthEnd = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
  const budget = db
    .prepare(
      `SELECT COALESCE(SUM(b.monthly_cents), 0) AS s FROM budgets b
       JOIN categories c ON c.id = b.category_id WHERE c.kind = 'expense'`,
    )
    .get() as { s: number }
  const spent = db
    .prepare(
      `SELECT COALESCE(SUM(-t.amount_cents), 0) AS s
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
       WHERE t.posted_on LIKE ? AND t.amount_cents < 0 AND (c.kind IS NULL OR c.kind = 'expense')`,
    )
    .get(`${month}%`) as { s: number }

  // A bill still counts as "coming" when its expected date lands in this month
  // and the merchant hasn't hit the ledger this month yet. Slightly-overdue
  // (expected a few days ago, not lapsed) still counts — autopay drift.
  const bills: { merchant: string; cents: number; due: string }[] = []
  let income = 0
  for (const r of recurring) {
    if (r.lapsed) continue
    const postedThisMonth = r.lastOn.slice(0, 7) === month
    if (r.kind === 'expense') {
      if (r.cadence === 'weekly' || r.cadence === 'biweekly') {
        // remaining cycles between the later of (next expected, today) and month end
        let d = r.nextExpectedOn < today ? today : r.nextExpectedOn
        while (d <= monthEnd) {
          bills.push({ merchant: r.merchant, cents: r.typicalCents, due: d })
          d = shiftDays(d, r.intervalDays)
        }
      } else if (!postedThisMonth && r.nextExpectedOn <= monthEnd) {
        bills.push({ merchant: r.merchant, cents: r.typicalCents, due: r.nextExpectedOn })
      }
    } else if (!postedThisMonth || r.cadence === 'weekly' || r.cadence === 'biweekly') {
      if (r.nextExpectedOn <= monthEnd) income += r.typicalCents
    }
  }
  bills.sort((a, b) => b.cents - a.cents)
  const upcoming = bills.reduce((s, x) => s + x.cents, 0)
  return {
    month,
    budgetCents: budget.s,
    spentCents: spent.s,
    upcomingBillsCents: upcoming,
    safeCents: budget.s - spent.s - upcoming,
    expectedIncomeRemainingCents: income,
    bills,
  }
}

export function getRecurring(db: DbLike, today: string) {
  const recurring = detectRecurring(db, today)
  return { recurring, safeToSpend: safeToSpend(db, today, recurring) }
}
