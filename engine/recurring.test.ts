import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { detectRecurring, getRecurring, safeToSpend } from './recurring'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)

function tx(db: DbLike, postedOn: string, cents: number, desc: string, category?: string) {
  const cat = category
    ? (db.prepare('SELECT id FROM categories WHERE name = ?').get(category) as { id: number } | undefined)?.id ?? null
    : null
  db.prepare(
    "INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (1, ?, ?, ?, ?, ?)",
  ).run(postedOn, cents, desc, cat, `${postedOn}:${desc}:${cents}:${Math.random()}`)
}
function seedAccount(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
}

describe('detectRecurring', () => {
  it('finds a monthly subscription despite date jitter', () => {
    const db = mem()
    seedAccount(db)
    for (const d of ['2026-03-15', '2026-04-16', '2026-05-14', '2026-06-15', '2026-07-15', '2026-08-16'])
      tx(db, d, -$(15.49), 'NETFLIX.COM 866-579-7172', 'Subscriptions')
    const recs = detectRecurring(db, '2026-08-27')
    expect(recs).toHaveLength(1)
    const r = recs[0]!
    expect(r.merchant).toContain('NETFLIX')
    expect(r.cadence).toBe('monthly')
    expect(r.kind).toBe('expense')
    expect(r.typicalCents).toBe($(15.49))
    expect(r.lapsed).toBe(false)
    expect(r.nextExpectedOn > '2026-09-01').toBe(true)
  })

  it('ignores irregular merchants and short histories', () => {
    const db = mem()
    seedAccount(db)
    // same store, no rhythm
    for (const d of ['2026-01-03', '2026-01-20', '2026-03-02', '2026-03-09', '2026-06-28'])
      tx(db, d, -$(60), 'TARGET 00012 SPRINGFIELD', 'Shopping')
    // rhythm but only two occurrences
    for (const d of ['2026-06-01', '2026-07-01']) tx(db, d, -$(9.99), 'HULU 877-8244858', 'Subscriptions')
    expect(detectRecurring(db, '2026-08-27')).toHaveLength(0)
  })

  it('detects yearly renewals and biweekly payroll (as income)', () => {
    const db = mem()
    seedAccount(db)
    for (const d of ['2024-05-10', '2025-05-11', '2026-05-09']) tx(db, d, -$(139), 'AMAZON PRIME MEMBERSHIP', 'Subscriptions')
    for (const d of ['2026-06-05', '2026-06-19', '2026-07-03', '2026-07-17', '2026-07-31', '2026-08-14'])
      tx(db, d, $(8_400), 'ACME CORP PAYROLL 260605 DIRECT DEP', 'Salary')
    const recs = detectRecurring(db, '2026-08-27')
    const prime = recs.find((r) => r.merchant.includes('AMAZON PRIME'))!
    expect(prime.cadence).toBe('yearly')
    const pay = recs.find((r) => r.kind === 'income')!
    expect(pay.cadence).toBe('biweekly')
    expect(pay.typicalCents).toBe($(8_400))
  })

  it('flags lapses and price creep', () => {
    const db = mem()
    seedAccount(db)
    // stopped charging: last hit in May, monthly cadence
    for (const d of ['2026-02-10', '2026-03-10', '2026-04-10', '2026-05-10'])
      tx(db, d, -$(11), 'SPOTIFY USA', 'Subscriptions')
    // price hike on the last charge
    for (const [d, amt] of [['2026-05-02', 22.99], ['2026-06-02', 22.99], ['2026-07-02', 22.99], ['2026-08-02', 27.99]] as const)
      tx(db, d, -$(amt), 'YOUTUBEPREMIUM G.CO', 'Subscriptions')
    const recs = detectRecurring(db, '2026-08-27')
    expect(recs.find((r) => r.merchant.includes('SPOTIFY'))!.lapsed).toBe(true)
    const yt = recs.find((r) => r.merchant.includes('YOUTUBE'))!
    expect(yt.lapsed).toBe(false)
    expect(yt.priceCreepMicro).toBeGreaterThan(200_000) // ~+21.7%
  })

  it('collapses same-day split charges into one occurrence', () => {
    const db = mem()
    seedAccount(db)
    for (const d of ['2026-06-01', '2026-07-01', '2026-08-01']) {
      tx(db, d, -$(50), 'CITY OF SPRINGFIELD UTIL', 'Utilities')
      tx(db, d, -$(30), 'CITY OF SPRINGFIELD UTIL', 'Utilities')
    }
    const recs = detectRecurring(db, '2026-08-27')
    expect(recs).toHaveLength(1)
    expect(recs[0]!.typicalCents).toBe($(80))
    expect(recs[0]!.occurrences).toBe(3)
  })

  it('never surfaces transfers', () => {
    const db = mem()
    seedAccount(db)
    for (const d of ['2026-06-03', '2026-07-03', '2026-08-03'])
      tx(db, d, -$(12_000), 'ONLINE TRANSFER TO WEALTHFRONT', 'Transfer')
    expect(detectRecurring(db, '2026-08-27')).toHaveLength(0)
  })
})

describe('safeToSpend', () => {
  it('budget − spent − bills still coming, without double counting posted bills', () => {
    const db = mem()
    seedAccount(db)
    const cat = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id
    db.prepare('INSERT INTO budgets (category_id, monthly_cents) VALUES (?, ?)').run(cat('Housing'), $(3_500))
    db.prepare('INSERT INTO budgets (category_id, monthly_cents) VALUES (?, ?)').run(cat('Groceries'), $(1_500))
    // mortgage: monthly on the 28th — NOT yet posted in August
    for (const d of ['2026-05-28', '2026-06-28', '2026-07-28']) tx(db, d, -$(3_418), 'MR. COOPER MORTGAGE PYMT', 'Housing')
    // groceries so far this month
    tx(db, '2026-08-05', -$(400), 'WHOLE FOODS #123', 'Groceries')
    const recs = detectRecurring(db, '2026-08-20')
    const s = safeToSpend(db, '2026-08-20', recs)
    expect(s.budgetCents).toBe($(5_000))
    expect(s.spentCents).toBe($(400))
    expect(s.upcomingBillsCents).toBe($(3_418))
    expect(s.safeCents).toBe($(5_000) - $(400) - $(3_418))
    expect(s.bills[0]!.merchant).toContain('MR. COOPER')

    // once the mortgage posts, it moves from "coming" to "spent" — no double count
    tx(db, '2026-08-28', -$(3_418), 'MR. COOPER MORTGAGE PYMT', 'Housing')
    const recs2 = detectRecurring(db, '2026-08-29')
    const s2 = safeToSpend(db, '2026-08-29', recs2)
    expect(s2.upcomingBillsCents).toBe(0)
    expect(s2.spentCents).toBe($(400) + $(3_418))
    expect(s2.safeCents).toBe(s.safeCents)
  })

  it('getRecurring bundles both views', () => {
    const db = mem()
    seedAccount(db)
    const r = getRecurring(db, '2026-08-27')
    expect(r.recurring).toEqual([])
    expect(r.safeToSpend.month).toBe('2026-08')
  })
})
