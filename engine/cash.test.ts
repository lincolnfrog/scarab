import { beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { CORE } from '../src/local/routes-core'
import { matchRoute } from '../src/local/table'
import { monthsBetween } from '../shared/dates'
import type { CategorySpend, GoalDerived, MonthlyFlow } from '../shared/types'
import { resolveContext } from './scenarios'
import {
  ApiError,
  cashflowCategories,
  cashflowMonthly,
  createLiability,
  createLoan,
  createProperty,
  getBudget,
  getGoal,
  goalDerived,
  listProperties,
  listTransactions,
  putBudget,
  putGoal,
  TX_PAGE_DEFAULT,
  type GoalSettings,
} from './services'
import { seedHousehold } from './test/household'
import { onBothEngines } from './test/parity'

/**
 * The U-owned half of services.ts: cash, budget, property, goal and loans.
 * These cover the write paths the screens call — every bad value is a 400
 * before anything is written, and a save that changes nothing writes nothing.
 */

const mem = () => openDb(':memory:') as unknown as DbLike
const changes = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

describe('putGoal', () => {
  it('stores a valid patch and reads it back', () => {
    const db = mem()
    putGoal(db, { goal: { targetPriceCents: 250_000_000, downPctMicro: 250_000 }, rental: { rentCents: 450_000 } })
    const g = getGoal(db)
    expect(g.goal.targetPriceCents).toBe(250_000_000)
    expect(g.goal.downPctMicro).toBe(250_000)
    expect(g.goal.closingCents).toBe(8_000_000) // untouched default
    expect(g.rental.rentCents).toBe(450_000)
  })

  it.each([
    [{ goal: { targetPriceCents: 12.5 } }, /targetPriceCents must be a non-negative integer/],
    [{ goal: { closingCents: -1 } }, /closingCents must be a non-negative integer/],
    [{ goal: { downPctMicro: 1_000_001 } }, /downPctMicro must be an integer from 0 to 1000000/],
    [{ goal: { capGainsRateMicro: '35' } }, /capGainsRateMicro/],
    [{ goal: { selectedLoanId: 0 } }, /selectedLoanId must be an id or null/],
    [{ goal: { fundAccountIds: [1, 'x'] } }, /fundAccountIds must be a list of ids/],
    [{ goal: { targetPrice: 1 } }, /unknown goal setting: targetPrice/],
    [{ goal: JSON.parse('{"__proto__":1}') }, /unknown goal setting: __proto__/],
    [{ goal: { constructor: 1 } }, /unknown goal setting: constructor/],
    [{ goal: [] }, /goal must be an object/],
    [{ rental: { maintPctMicro: -5 } }, /maintPctMicro/],
    [{ rental: { propertyId: 'house' } }, /propertyId must be an id or null/],
  ])('refuses %j with a 400', (body, msg) => {
    const db = mem()
    expect(() => putGoal(db, body as Parameters<typeof putGoal>[1])).toThrow(msg)
    try {
      putGoal(db, body as Parameters<typeof putGoal>[1])
    } catch (e) {
      expect((e as { status?: number }).status).toBe(400)
    }
  })

  it('validates both halves before writing either', () => {
    const db = mem()
    const before = changes(db)
    expect(() => putGoal(db, { goal: { targetPriceCents: 1 }, rental: { rentCents: -1 } })).toThrow(/rentCents/)
    expect(changes(db)).toBe(before)
    expect(getGoal(db).goal.targetPriceCents).toBe(300_000_000)
  })

  it('writes nothing when the value is unchanged (a blur that changed nothing never dirties a session)', () => {
    const db = mem()
    putGoal(db, { goal: { monthlyPlanCents: 500_000 } })
    const before = changes(db)
    putGoal(db, { goal: { monthlyPlanCents: 500_000 } })
    putGoal(db, { goal: {} })
    putGoal(db, {})
    expect(changes(db)).toBe(before)
    putGoal(db, { goal: { monthlyPlanCents: 600_000 } })
    expect(changes(db)).toBe(before + 1)
  })

  it('accepts null ids and clears them', () => {
    const db = mem()
    putGoal(db, { goal: { selectedLoanId: 3, fundAccountIds: [1, 2] }, rental: { propertyId: 1 } })
    putGoal(db, { goal: { selectedLoanId: null, fundAccountIds: [] }, rental: { propertyId: null } })
    const g = getGoal(db)
    expect(g.goal.selectedLoanId).toBeNull()
    expect(g.goal.fundAccountIds).toEqual([])
    expect(g.rental.propertyId).toBeNull()
  })
})

describe('createLoan', () => {
  it('creates a loan option with rate, term and points in integer micro', () => {
    const db = mem()
    const { id } = createLoan(db, { name: ' 30-yr jumbo ', rateMicro: 63_750, termMonths: 360, pointsMicro: 5_000, note: '' })
    expect(getGoal(db).loans).toEqual([{ id, name: '30-yr jumbo', rate_micro: 63_750, term_months: 360, points_micro: 5_000, note: null }])
  })

  it.each([
    [{ name: 'x', rateMicro: 0, termMonths: 360 }, /required/],
    [{ name: 'x', rateMicro: 6.375, termMonths: 360 }, /required/],
    [{ name: 'x', rateMicro: 2_000_000, termMonths: 360 }, /at most 1000000/],
    [{ name: 'x', rateMicro: 60_000, termMonths: 1200 }, /at most 600/],
    [{ name: 'x', rateMicro: 60_000, termMonths: 360, pointsMicro: -1 }, /pointsMicro/],
    [{ name: 'x', rateMicro: 60_000, termMonths: 360, note: 5 }, /note must be text/],
  ])('refuses %j', (body, msg) => {
    expect(() => createLoan(mem(), body as Parameters<typeof createLoan>[1])).toThrow(msg)
  })
})

describe('properties and liabilities', () => {
  it('creates a property with optional purchase facts', () => {
    const db = mem()
    createProperty(db, { name: 'Foothill Rd', purchasedOn: '2019-06-01', purchaseCents: 68_000_000 })
    createProperty(db, { name: 'Cabin', purchasedOn: '', purchaseCents: null })
    const [a, b] = listProperties(db) as unknown as { name: string; purchased_on: string | null; purchase_cents: number | null }[]
    expect(a).toMatchObject({ name: 'Foothill Rd', purchased_on: '2019-06-01', purchase_cents: 68_000_000 })
    expect(b).toMatchObject({ name: 'Cabin', purchased_on: null, purchase_cents: null })
  })

  it.each([
    [{ name: 'x', purchasedOn: '6/1/2019' }, /purchasedOn/],
    [{ name: 'x', purchaseCents: 680000.5 }, /purchaseCents/],
    [{ name: 'x', purchaseCents: -1 }, /purchaseCents/],
  ])('refuses property %j', (body, msg) => {
    expect(() => createProperty(mem(), body as Parameters<typeof createProperty>[1])).toThrow(msg)
  })

  it('adds a mortgage and its first balance in one write', () => {
    const db = mem()
    const { id: propertyId } = createProperty(db, { name: 'Home' })
    createLiability(db, { propertyId, name: 'Mortgage', rateMicro: 31_250, balanceCents: 41_200_000, balancedOn: '2026-09-01' })
    const [p] = listProperties(db) as unknown as { liabilities: { name: string; rate_micro: number; latest_balance: unknown }[] }[]
    expect(p!.liabilities).toHaveLength(1)
    expect(p!.liabilities[0]).toMatchObject({
      name: 'Mortgage',
      rate_micro: 31_250,
      latest_balance: { balanced_on: '2026-09-01', balance_cents: 41_200_000 },
    })
  })

  it('refuses a bad mortgage without writing anything', () => {
    const db = mem()
    const { id: propertyId } = createProperty(db, { name: 'Home' })
    const before = changes(db)
    expect(() => createLiability(db, { propertyId, name: 'M', rateMicro: 3.125 })).toThrow(/rateMicro/)
    expect(() => createLiability(db, { propertyId, name: 'M', balanceCents: 100 })).toThrow(/balancedOn/)
    expect(() => createLiability(db, { propertyId, name: 'M', balanceCents: -100, balancedOn: '2026-09-01' })).toThrow(/balanceCents/)
    expect(() => createLiability(db, { propertyId: 99, name: 'M' })).toThrow(/no such property/)
    expect(changes(db)).toBe(before)
  })

  it('a liability without a balance still works (rate optional)', () => {
    const db = mem()
    const { id: propertyId } = createProperty(db, { name: 'Home' })
    createLiability(db, { propertyId, name: 'HELOC', rateMicro: null })
    const [p] = listProperties(db) as unknown as { liabilities: { rate_micro: number | null; latest_balance: unknown }[] }[]
    expect(p!.liabilities[0]).toMatchObject({ rate_micro: null, latest_balance: null })
  })
})

describe('putBudget', () => {
  it('refuses a negative budget', () => {
    expect(() => putBudget(mem(), { categoryId: 1, monthlyCents: -100 })).toThrow(/negative/)
  })
})

describe('parity', () => {
  it('goal, loans and property writes read back identically on both engines', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        putGoal(db, { goal: { targetPriceCents: 200_000_000, fundAccountIds: [] }, rental: { rentCents: 300_000 } })
        createLoan(db, { name: '15-yr', rateMicro: 55_000, termMonths: 180 })
        const { id } = createProperty(db, { name: 'Home', purchasedOn: '2020-01-15', purchaseCents: 50_000_000 })
        createLiability(db, { propertyId: id, name: 'Mortgage', rateMicro: 30_000, balanceCents: 30_000_000, balancedOn: '2026-08-31' })
      },
      (db) => ({ goal: getGoal(db), props: listProperties(db) }),
    )
    expect(server.goal.loans).toHaveLength(1)
    expect(server.props).toHaveLength(1)
    expect(browser).toEqual(server)
  })
})

/* ---------- U6: the goal's derived numbers ---------- */

const GOAL: GoalSettings = {
  targetPriceCents: 300_000_000, // $3M
  downPctMicro: 200_000, // 20%
  closingCents: 8_000_000, // $80K
  fundAccountIds: [],
  fundExtraCents: 0,
  monthlyPlanCents: 1_000_000, // $10K/mo
  selectedLoanId: null,
  taxPctMicro: 11_000,
  insMonthlyCents: 32_000,
  capGainsRateMicro: 350_000,
  lossCarryforwardCents: 0,
  saleBasisPctMicro: 20_000,
}
const derive = (patch: Partial<GoalSettings>, fund: number, today = '2026-09-23') => goalDerived({ ...GOAL, ...patch }, fund, today)

describe('goalDerived', () => {
  it('target is down payment + closing; remaining and percent follow from the fund', () => {
    expect(derive({}, 17_000_000)).toEqual<GoalDerived>({
      targetCents: 68_000_000, // $600K down + $80K closing
      fundCents: 17_000_000,
      remainingCents: 51_000_000,
      monthlyPlanCents: 1_000_000,
      etaMonth: '2030-12', // 51 months after 2026-09
      pctMicro: 250_000, // 25%
    })
  })

  it('counts ETA months on the calendar: the 31st and month ends never skip a month', () => {
    // One month of plan left. The old Date math (setMonth(+1) on the 31st) rolled into the month after.
    expect(derive({}, 67_000_000, '2026-01-31').etaMonth).toBe('2026-02')
    expect(derive({}, 67_000_000, '2026-08-31').etaMonth).toBe('2026-09')
    expect(derive({}, 67_000_000, '2026-12-31').etaMonth).toBe('2027-01')
    expect(derive({}, 67_000_000, '2028-02-29').etaMonth).toBe('2028-03')
    // A partial month rounds up: $10,000.01 left at $10K/mo is two months.
    expect(derive({}, 67_000_000 - 1, '2026-01-31').etaMonth).toBe('2026-03')
    // Exactly divisible: no extra month.
    expect(derive({}, 66_000_000, '2026-01-15').etaMonth).toBe('2026-03')
  })

  it('no ETA without a plan, once funded, or beyond a century', () => {
    expect(derive({ monthlyPlanCents: 0 }, 0).etaMonth).toBeNull()
    const funded = derive({}, 70_000_000)
    expect(funded).toMatchObject({ remainingCents: 0, pctMicro: 1_000_000, etaMonth: null })
    expect(derive({ monthlyPlanCents: 1 }, 0).etaMonth).toBeNull() // 68M months
    expect(derive({ monthlyPlanCents: 56_667 }, 0).etaMonth).toBe('2126-09') // exactly 1200 months
  })

  it('percent floors, so it reads 100% only when the fund truly covers the target', () => {
    expect(derive({}, 68_000_000 - 1).pctMicro).toBe(999_999)
    expect(derive({}, 68_000_000).pctMicro).toBe(1_000_000)
    expect(derive({}, 1).pctMicro).toBe(0)
  })

  it('an overdrawn fund is 0% and widens the gap', () => {
    expect(derive({}, -500_000)).toMatchObject({ pctMicro: 0, remainingCents: 68_500_000, fundCents: -500_000 })
  })

  it('a zero target is funded from the start', () => {
    expect(derive({ downPctMicro: 0, closingCents: 0 }, 0)).toMatchObject({ targetCents: 0, remainingCents: 0, pctMicro: 1_000_000, etaMonth: null })
  })

  it('is exact past the float-safe range and rounds the down payment half up', () => {
    // $250M × 33.3333% = $83,333,250.00 exactly; the product 2.5e10 × 333_333 overflows 2^53.
    expect(derive({ targetPriceCents: 25_000_000_000, downPctMicro: 333_333, closingCents: 0 }, 0).targetCents).toBe(8_333_325_000)
    // 1 cent × 50% = 0.5 cents → 1
    expect(derive({ targetPriceCents: 1, downPctMicro: 500_000, closingCents: 0 }, 0).targetCents).toBe(1)
  })

  it('falls back to defaults for a malformed stored value instead of throwing', () => {
    const odd = { ...GOAL, targetPriceCents: 12.5 as unknown as number, monthlyPlanCents: '100' as unknown as number }
    expect(goalDerived(odd, 0, '2026-09-23')).toMatchObject({ targetCents: 68_000_000, monthlyPlanCents: 0, etaMonth: null })
  })
})

describe('getGoal(db, today).derived', () => {
  const seed = (db: DbLike) => {
    seedHousehold(db) // Checking: $1,000 opening + $6,300 of flows = $7,300
    putGoal(db, { goal: { fundAccountIds: [1], fundExtraCents: 270_000, monthlyPlanCents: 250_000, targetPriceCents: 10_000_000, downPctMicro: 100_000, closingCents: 0 } })
  }

  it('matches the fund total and settings the response already carries', () => {
    const db = mem()
    seed(db)
    const g = getGoal(db, '2026-08-31')
    expect(g.fundTotal).toBe(1_000_000) // $7,300 + $2,700 earmarked
    expect(g.derived).toEqual<GoalDerived>({
      targetCents: 1_000_000,
      fundCents: 1_000_000,
      remainingCents: 0,
      monthlyPlanCents: 250_000,
      etaMonth: null,
      pctMicro: 1_000_000,
    })
    putGoal(db, { goal: { downPctMicro: 200_000 } }) // $20K target, $10K to go at $2,500/mo
    expect(getGoal(db, '2026-08-31').derived).toMatchObject({ targetCents: 2_000_000, remainingCents: 1_000_000, pctMicro: 500_000, etaMonth: '2026-12' })
  })

  it('reads identically on both engines', async () => {
    const { server, browser } = await onBothEngines(seed, (db) => getGoal(db, '2026-09-23').derived)
    expect(server.fundCents).toBe(1_000_000)
    expect(browser).toEqual(server)
  })

  it('the tab route passes its local day through', () => {
    const db = mem()
    seed(db)
    putGoal(db, { goal: { downPctMicro: 200_000 } })
    const m = matchRoute(CORE, 'GET', '/goal')!
    const out = m.route.handler({ db: db as never, params: m.params, query: new URLSearchParams(), body: {}, today: '2027-01-31', identity: null }) as ReturnType<typeof getGoal>
    expect(out.derived.etaMonth).toBe('2027-05') // 4 months after January, not after a rolled-over March
  })

  it("the Future screen's home terms read the same settings", () => {
    const db = mem()
    seed(db)
    createLoan(db, { name: '30-yr', rateMicro: 60_000, termMonths: 360 })
    const { home } = resolveContext(db, '2026-09-23')
    expect(home).toMatchObject({ priceCents: 10_000_000, cashOutCents: getGoal(db, '2026-09-23').derived.targetCents })
  })
})

/* ---------- U5: the Cash ledger's pages, months and one spending definition ---------- */

/**
 * Two accounts and a ledger with the awkward cases: a refund inside a month,
 * an over-refund (bought last month, returned this month), uncategorized money
 * both ways, a transfer pair, empty months in between, and descriptions with
 * LIKE wildcards in them.
 */
function seedCash(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking'), ('Savings', 'savings')").run()
  const cat = (name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id
  const tx = db.prepare(
    'INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?)',
  )
  let h = 0
  const add = (acct: number, on: string, cents: number, desc: string, category: string | null) =>
    tx.run(acct, on, cents, desc, category === null ? null : cat(category), `h${++h}`)
  add(1, '2026-05-01', 800_000, 'ACME PAYROLL', 'Salary')
  add(1, '2026-05-03', -12_000, 'TRADER JOES #123', 'Groceries')
  // June and July: nothing.
  add(1, '2026-08-01', 800_000, 'ACME PAYROLL', 'Salary')
  add(1, '2026-08-04', -20_000, 'WHOLE FOODS 10234', 'Groceries')
  add(1, '2026-08-09', 5_000, 'WHOLE FOODS REFUND', 'Groceries') // a refund: Groceries spent $150, no $50 of income
  add(1, '2026-08-10', -3_000, 'AMAZON MKTP', 'Shopping')
  add(1, '2026-08-20', 4_500, 'AMAZON RETURN', 'Shopping') // more back than spent this month: Shopping $0, not income
  add(1, '2026-08-15', -7_700, 'MYSTERY CHARGE', null)
  add(1, '2026-08-16', 2_500, 'VENMO CASHOUT', null)
  add(1, '2026-08-17', -100_000, 'TO SAVINGS', 'Transfer')
  add(2, '2026-08-17', 100_000, 'FROM CHECKING', 'Transfer')
  add(1, '2026-08-25', -1_000, 'COUPON 100% OFF', 'Dining')
  add(1, '2026-08-26', -2_000, 'ROOM 1005 SERVICE', 'Dining')
  add(1, '2026-08-27', -500, 'A_B CAFE', 'Dining')
  add(1, '2026-08-28', -600, 'AXB CAFE', 'Dining')
}
const catId = (db: DbLike, name: string) => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number }).id
const seeded = () => {
  const db = mem()
  seedCash(db)
  return db
}

describe('listTransactions', () => {
  it('pages newest first without overlap, and counts what the filters match', () => {
    const db = seeded()
    const all = listTransactions(db, {})
    expect(all).toMatchObject({ total: 15, matching: 15, uncategorized: 2, offset: 0, limit: TX_PAGE_DEFAULT })
    expect(all.rows.map((r) => r.posted_on)).toEqual([...all.rows.map((r) => r.posted_on)].sort().reverse())
    const pages = [0, 4, 8, 12].map((offset) => listTransactions(db, { limit: '4', offset: String(offset) }))
    expect(pages.map((p) => p.rows.length)).toEqual([4, 4, 4, 3])
    expect(pages.flatMap((p) => p.rows.map((r) => r.id))).toEqual(all.rows.map((r) => r.id))
    for (const p of pages) expect(p).toMatchObject({ matching: 15, total: 15, limit: 4 })
    expect(listTransactions(db, { offset: 99 }).rows).toEqual([]) // past the end: an empty page, not an error
  })

  it('filters by category, month, account and text; total never moves', () => {
    const db = seeded()
    const groceries = catId(db, 'Groceries')
    expect(listTransactions(db, { categoryId: String(groceries) })).toMatchObject({ matching: 3, total: 15 })
    expect(listTransactions(db, { categoryId: groceries, month: '2026-08' })).toMatchObject({ matching: 2 })
    expect(listTransactions(db, { accountId: '2' })).toMatchObject({ matching: 1, uncategorized: 0 })
    expect(listTransactions(db, { uncategorized: true }).rows.map((r) => r.description)).toEqual(['VENMO CASHOUT', 'MYSTERY CHARGE'])
    expect(listTransactions(db, { q: '  whole foods ' })).toMatchObject({ matching: 2 }) // trimmed, case-insensitive
    expect(listTransactions(db, { q: 'grocer' })).toMatchObject({ matching: 3 }) // the category's name matches too
    expect(listTransactions(db, { month: '2026-05' })).toMatchObject({ matching: 2, uncategorized: 0 })
  })

  it("counts uncategorized rows under the other filters, whatever category is picked", () => {
    const db = seeded()
    const dining = catId(db, 'Dining')
    // "Uncategorized (2)" stays right while Dining is the filter: it's what picking Uncategorized would show.
    expect(listTransactions(db, { categoryId: dining })).toMatchObject({ matching: 4, uncategorized: 2 })
    expect(listTransactions(db, { categoryId: dining, q: 'mystery' })).toMatchObject({ matching: 0, uncategorized: 1 })
    expect(listTransactions(db, { month: '2026-05', categoryId: dining })).toMatchObject({ matching: 0, uncategorized: 0 })
  })

  it('searches for the text as typed: % and _ are not wildcards', () => {
    const db = seeded()
    expect(listTransactions(db, { q: '100%' }).rows.map((r) => r.description)).toEqual(['COUPON 100% OFF'])
    expect(listTransactions(db, { q: 'A_B' }).rows.map((r) => r.description)).toEqual(['A_B CAFE'])
    expect(listTransactions(db, { q: '%' }).matching).toBe(1)
  })

  it.each([
    [{ limit: '0' }, /limit must be a whole number from 1 to 500/],
    [{ limit: '501' }, /limit/],
    [{ limit: '10.5' }, /limit/],
    [{ offset: '-1' }, /offset must be a whole number of at least 0/],
    [{ offset: 'x' }, /offset/],
    [{ categoryId: 'food' }, /category_id/],
    [{ accountId: '0' }, /account_id/],
    [{ month: '2026-8' }, /month must be YYYY-MM/],
    [{ month: '%' }, /month/],
    [{ categoryId: '3', uncategorized: true }, /exclusive/],
  ])('refuses %j with a 400', (q, msg) => {
    const db = seeded()
    expect(() => listTransactions(db, q)).toThrow(msg)
    try {
      listTransactions(db, q)
    } catch (e) {
      expect((e as ApiError).status).toBe(400)
    }
  })
})

describe('cashflowMonthly', () => {
  it('fills empty months with zero so the bars keep calendar spacing', () => {
    const db = seeded()
    expect(cashflowMonthly(db)).toEqual<MonthlyFlow[]>([
      { month: '2026-05', income_cents: 800_000, spend_cents: 12_000 },
      { month: '2026-06', income_cents: 0, spend_cents: 0 },
      { month: '2026-07', income_cents: 0, spend_cents: 0 },
      { month: '2026-08', income_cents: 802_500, spend_cents: 26_800 }, // $150 groceries + $41 dining + $77 uncategorized
    ])
  })

  it('ends at the latest month with a transaction and keeps at most `months` of them', () => {
    const db = seeded()
    expect(cashflowMonthly(db, { months: '2' }).map((m) => m.month)).toEqual(['2026-07', '2026-08'])
    expect(cashflowMonthly(db, { months: 1 }).map((m) => m.month)).toEqual(['2026-08'])
    expect(cashflowMonthly(db, { months: '120' })).toHaveLength(4) // never before the first month
    // A long ledger across a year boundary: the default window is the last 12 contiguous months.
    db.prepare("INSERT INTO transactions (account_id, posted_on, amount_cents, description, dedupe_hash) VALUES (1, '2024-11-30', -100, 'OLD', 'old')").run()
    const twelve = cashflowMonthly(db)
    expect(twelve.map((m) => m.month)).toEqual(monthsBetween('2025-09', '2026-08'))
    expect(cashflowMonthly(db, { months: 24 })[0]).toEqual({ month: '2024-11', income_cents: 0, spend_cents: 100 })
  })

  it('an empty ledger is no months; transfers alone are not a month', () => {
    const db = mem()
    expect(cashflowMonthly(db)).toEqual([])
    seedCash(db)
    db.prepare(
      "INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (1, '2026-09-02', -5000, 'TO SAVINGS', ?, 'tx9')",
    ).run(catId(db, 'Transfer'))
    expect(cashflowMonthly(db).at(-1)!.month).toBe('2026-08')
  })

  it.each(['0', '121', 'twelve', '1.5', '-3'])('refuses months=%s with a 400', (months) => {
    expect(() => cashflowMonthly(seeded(), { months })).toThrow(/months must be a whole number from 1 to 120/)
  })
})

describe('one spending definition across the Cash screen', () => {
  it('a refund lowers its category’s spending — in the category bars and the budget actuals alike — and is never income', () => {
    const db = seeded()
    const cats = cashflowCategories(db, '2026-08')
    expect(cats).toEqual<CategorySpend[]>([
      { category_id: catId(db, 'Groceries'), name: 'Groceries', spend_cents: 15_000 }, // $200 − $50 refund
      { category_id: null, name: 'Uncategorized', spend_cents: 7_700 },
      { category_id: catId(db, 'Dining'), name: 'Dining', spend_cents: 4_100 },
      // Shopping: $30 out, $45 back → $0, left out rather than −$15
    ])
    const budget = getBudget(db, '2026-08')
    const row = (name: string, kind: 'income' | 'expense' = 'expense') => budget.find((b) => b.name === name && b.kind === kind)!
    expect(row('Groceries').actual_cents).toBe(15_000)
    expect(row('Shopping').actual_cents).toBe(0) // never negative
    expect(row('Salary', 'income').actual_cents).toBe(800_000)
    expect(row('Uncategorized', 'income').actual_cents).toBe(2_500)
    expect(row('Uncategorized').actual_cents).toBe(7_700)
    for (const c of cats) expect(budget.find((b) => b.kind === 'expense' && b.category_id === c.category_id)!.actual_cents, c.name).toBe(c.spend_cents)
  })

  it('every month: the bars equal the category total and the budget actuals', () => {
    const db = seeded()
    for (const m of cashflowMonthly(db)) {
      const budget = getBudget(db, m.month)
      const sum = (rows: { actual_cents: number }[]) => rows.reduce((s, r) => s + r.actual_cents, 0)
      expect(cashflowCategories(db, m.month).reduce((s, r) => s + r.spend_cents, 0), m.month).toBe(m.spend_cents)
      expect(sum(budget.filter((b) => b.kind === 'expense')), m.month).toBe(m.spend_cents)
      expect(sum(budget.filter((b) => b.kind === 'income')), m.month).toBe(m.income_cents)
    }
  })

  it('reads identically on both engines', async () => {
    const { server, browser } = await onBothEngines(seedCash, (db) => ({
      monthly: cashflowMonthly(db, { months: 6 }),
      cats: cashflowCategories(db, '2026-08'),
      budget: getBudget(db, '2026-08'),
      page: listTransactions(db, { q: 'cafe', limit: 1, offset: 1 }),
      uncat: listTransactions(db, { uncategorized: true, month: '2026-08' }),
    }))
    expect(server.monthly).toHaveLength(4)
    expect(server.page.rows).toHaveLength(1)
    expect(server.uncat.matching).toBe(2)
    expect(browser).toEqual(server)
  })
})

describe('the Cash routes in both universes', () => {
  let mod: typeof import('../server/app')
  let serverDb: DbLike
  beforeAll(async () => {
    process.env.DB_PATH = ':memory:'
    process.env.NODE_ENV = 'test'
    mod = await import('../server/app')
    serverDb = (await import('../server/db')).db as unknown as DbLike
    seedCash(serverDb)
  })

  it('the server and the tab answer the same query the same way', async () => {
    const app = mod.createApp({ zkOnly: false })
    const tabDb = seeded()
    const tab = (path: string) => {
      const u = new URL(path, 'http://x')
      const m = matchRoute(CORE, 'GET', u.pathname.replace(/^\/api/, ''))!
      return m.route.handler({ db: tabDb as never, params: m.params, query: u.searchParams, body: {}, today: '2026-09-23', identity: null })
    }
    const groceries = catId(tabDb, 'Groceries')
    for (const path of [
      '/api/transactions?limit=3&offset=2',
      `/api/transactions?category_id=${groceries}&month=2026-08`,
      '/api/transactions?uncategorized=1&account_id=1&q=a',
      '/api/cashflow/monthly?months=2',
      '/api/cashflow/monthly',
      '/api/cashflow/categories?month=2026-08',
      '/api/budget?month=2026-08',
    ]) {
      const r = await app.request(path)
      expect(r.status, path).toBe(200)
      expect(await r.json(), path).toEqual(JSON.parse(JSON.stringify(tab(path))))
    }
    for (const path of ['/api/transactions?limit=0', '/api/cashflow/monthly?months=0']) {
      const r = await app.request(path)
      expect(r.status, path).toBe(400)
      expect(() => tab(path), path).toThrow((await r.json() as { error: string }).error)
    }
  })
})
