import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { parsePmmsCsv } from '../server/rates'
import type { DbLike } from './db'
import { ackDigest, getDigest, inheritDigestMark, putPmmsRate } from './digest'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-08-27'

function tx(db: DbLike, postedOn: string, cents: number, desc: string, category?: string) {
  const cat = category
    ? (db.prepare('SELECT id FROM categories WHERE name = ?').get(category) as { id: number } | undefined)?.id ?? null
    : null
  db.prepare(
    'INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (1, ?, ?, ?, ?, ?)',
  ).run(postedOn, cents, desc, cat, `${postedOn}:${desc}:${cents}:${Math.random()}`)
}
const lastSeen = (db: DbLike, email: string, stamp: string) =>
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(`digest:last_seen:${email}`, stamp)

describe('getDigest', () => {
  it('counts arrivals, spots new recurring charges and budget overruns', () => {
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    lastSeen(db, 'max@x', '2026-07-01 00:00:00')
    // a subscription that started after last-seen (weekly, 4 hits)
    for (const d of ['2026-07-20', '2026-07-27', '2026-08-03', '2026-08-10'])
      tx(db, d, -$(12), 'FANCY SAUNA CLUB WEEKLY', 'Subscriptions')
    // uncategorized arrivals
    tx(db, '2026-08-20', -$(80), 'MYSTERY MERCHANT LLC')
    // budget overrun this month
    const dining = (db.prepare("SELECT id FROM categories WHERE name = 'Dining'").get() as { id: number }).id
    db.prepare('INSERT INTO budgets (category_id, monthly_cents) VALUES (?, ?)').run(dining, $(200))
    tx(db, '2026-08-15', -$(340), 'TST* SOME BISTRO', 'Dining')

    const d = getDigest(db, 'max@x', today)
    expect(d.sinceDay).toBe('2026-07-01')
    expect(d.newTx.count).toBe(6)
    expect(d.newTx.uncategorized).toBe(1)
    expect(d.newRecurring.map((r) => r.merchant).join()).toContain('FANCY SAUNA')
    expect(d.budgetOverruns[0]).toMatchObject({ budgetCents: $(200), actualCents: $(340) })
    expect(d.notable).toBe(true)
  })

  it('ack quiets the card until something new lands', () => {
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    tx(db, '2026-08-15', -$(340), 'TST* SOME BISTRO', 'Dining')
    ackDigest(db, 'max@x')
    const d = getDigest(db, 'max@x', new Date().toISOString().slice(0, 10))
    expect(d.notable).toBe(false)
    expect(d.netWorth).toBeNull()
    // a new arrival re-surfaces it, even same-day
    tx(db, '2026-08-27', -$(10), 'NEW THING INC')
    // created_at must be strictly after the ack stamp
    db.prepare("UPDATE transactions SET created_at = datetime('now', '+2 seconds') WHERE description = 'NEW THING INC'").run()
    const d2 = getDigest(db, 'max@x', new Date().toISOString().slice(0, 10))
    expect(d2.newTx.count).toBe(1)
    expect(d2.notable).toBe(true)
  })

  it('tracks net worth movement and allocation drift across months', () => {
    const db = mem()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    tx(db, '2026-06-01', $(10_000), 'OPENING', 'Other income')
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Broker', 'brokerage', 'lots')").run()
    db.prepare("INSERT INTO assets (symbol, kind) VALUES ('ZOOM', 'stock')").run()
    db.prepare(
      "INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, '2026-06-05', 'buy', 10000000, ?)",
    ).run($(1_000))
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-06-30', 10000)").run()
    db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-08-25', 40000)").run()
    lastSeen(db, 'max@x', '2026-07-02 00:00:00')

    const d = getDigest(db, 'max@x', today)
    expect(d.netWorth).not.toBeNull()
    expect(d.netWorth!.baselineMonth).toBe('2026-07')
    expect(d.netWorth!.deltaCents).toBe($(3_000)) // 10 sh × ($400 − $100)
    expect(d.netWorth!.drivers[0]).toMatchObject({ name: 'brokerage', deltaCents: $(3_000) })
    const brok = d.allocationDrift.find((x) => x.name === 'brokerage')!
    expect(brok.deltaMicro).toBeGreaterThan(150_000) // ~9% → ~29% of assets
  })

  it('raises the mortgage trigger only when the market beats the best saved loan', () => {
    const db = mem()
    db.prepare("INSERT INTO loan_options (name, rate_micro, term_months) VALUES ('Chase 30yr', 62_500, 360)").run()
    lastSeen(db, 'max@x', '2026-07-01 00:00:00')
    putPmmsRate(db, '2026-08-21', 61_000) // 6.10% vs 6.25% saved — 15bp, below the 25bp bar
    expect(getDigest(db, 'max@x', today).mortgage!.triggered).toBe(false)
    putPmmsRate(db, '2026-08-21', 59_900) // 5.99% — 26bp better
    const m = getDigest(db, 'max@x', today).mortgage!
    expect(m.triggered).toBe(true)
    expect(m.bestLoanName).toBe('Chase 30yr')
  })
})

describe('inheritDigestMark', () => {
  it("copies another identity's mark once and never overwrites one that exists", () => {
    const db = mem()
    expect(inheritDigestMark(db, 'max@x', 'local')).toBe(false) // nothing to inherit
    lastSeen(db, 'local', '2026-08-01 09:00:00')
    expect(inheritDigestMark(db, 'max@x', 'local')).toBe(true)
    expect(getDigest(db, 'max@x', today).since).toBe('2026-08-01 09:00:00')
    lastSeen(db, 'max@x', '2026-08-20 10:00:00')
    expect(inheritDigestMark(db, 'max@x', 'local')).toBe(false)
    expect(getDigest(db, 'max@x', today).since).toBe('2026-08-20 10:00:00')
    expect(getDigest(db, 'local', today).since).toBe('2026-08-01 09:00:00') // the source stays for the other member
    expect(inheritDigestMark(db, 'local', 'local')).toBe(false)
  })
})

describe('PMMS CSV parsing', () => {
  it('parses FRED rows, skips missing values, and normalizes PMMS-style dates', () => {
    const fred = 'observation_date,MORTGAGE30US\n2026-08-14,6.51\n2026-08-21,6.42\n2026-08-28,.'
    expect(parsePmmsCsv(fred)).toEqual({ on: '2026-08-21', rateMicro: 64_200 })
    const pmms = 'date,pmms30,pmms30fees,pmms15\n1/2/2025,6.91,0.7,6.13\n8/21/2026,6.42,0.6,5.71\n,,,\ntotals,junk,,'
    expect(parsePmmsCsv(pmms)).toEqual({ on: '2026-08-21', rateMicro: 64_200 })
  })
  it('returns null rather than garbage', () => {
    expect(parsePmmsCsv('nothing,useful\nhere,at all')).toBeNull()
    expect(parsePmmsCsv('')).toBeNull()
  })
})
