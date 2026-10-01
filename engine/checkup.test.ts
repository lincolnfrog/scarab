import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { getAssumptions } from './assumptions'
import { ackCheckup, getCheckup } from './checkup'
import { putCheckupSettings, resolveRoles } from './checkup-settings'
import type { DbLike } from './db'
import { PMMS_KEY } from './digest'
import { deriveItemized, mortgageInterestYear, saltCapCents } from './itemize'
import { dumpDb, loadDump } from './snapshot'
import { computeTaxYear, putTaxSettings } from './tax'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'
const ME = 'max@x'

function bank(db: DbLike, openingCents: number, name = 'Checking'): number {
  return Number(db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES (?, 'checking', ?)").run(name, openingCents).lastInsertRowid)
}
function category(db: DbLike, name: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined
  if (row) return row.id
  return Number(db.prepare("INSERT INTO categories (name, kind) VALUES (?, 'expense')").run(name).lastInsertRowid)
}
let seq = 0
function tx(db: DbLike, account: number, on: string, cents: number, desc: string, cat?: string) {
  db.prepare('INSERT INTO transactions (account_id, posted_on, amount_cents, description, category_id, dedupe_hash) VALUES (?, ?, ?, ?, ?, ?)').run(
    account,
    on,
    cents,
    desc,
    cat ? category(db, cat) : null,
    `h${++seq}`,
  )
}
function investAccount(db: DbLike, name: string, kind: 'brokerage' | 'retirement' | 'crypto' = 'brokerage', stockPlan = false): number {
  return Number(
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking, stock_plan) VALUES (?, ?, 'lots', ?)").run(name, kind, stockPlan ? 1 : 0).lastInsertRowid,
  )
}
function asset(db: DbLike, symbol: string, kind: 'stock' | 'crypto' = 'stock'): number {
  return Number(db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?)').run(symbol, kind).lastInsertRowid)
}
function buy(db: DbLike, account: number, assetId: number, on: string, shares: number, totalCents: number) {
  db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, ?, ?, 'buy', ?, ?)").run(
    account,
    assetId,
    on,
    shares * 1_000_000,
    totalCents,
  )
}
function price(db: DbLike, assetId: number, on: string, cents: number) {
  db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, ?, ?)').run(assetId, on, cents)
}
/** Federal-only household (Texas) with a salary, so tax findings have income to work from. */
function taxes(db: DbLike, wagesDollars: number, patch: Parameters<typeof putTaxSettings>[1] = {}) {
  putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', wagesAnnualCents: $(wagesDollars), withheldFederalCents: $(1_000_000), ...patch })
}
const kinds = (db: DbLike) => getCheckup(db, today, ME).findings.map((f) => f.kind)
const finding = (db: DbLike, kind: string) => getCheckup(db, today, ME).findings.find((f) => f.kind === kind)

describe('every finding shows its work', () => {
  it('carries a rule with citation and vintage, inputs, arithmetic and an action', () => {
    const db = mem()
    const a = bank(db, $(20_000))
    for (const m of ['04', '05', '06', '07', '08', '09']) tx(db, a, `2026-${m}-10`, -$(3_000), 'WHOLE FOODS', 'Groceries')
    const f = finding(db, 'runway-low')!
    expect(f.rule.text).toBeTruthy()
    expect(f.rule.cite).toBeTruthy()
    expect(f.rule.vintage).toBeTruthy()
    expect(f.inputs.length).toBeGreaterThan(0)
    expect(f.math.length).toBeGreaterThan(0)
    expect(f.leavesOut.length).toBeGreaterThan(0)
    expect(f.action?.to.screen).toBe('cash')
  })
})

describe('concentration', () => {
  function seed(db: DbLike, bankDollars: number) {
    bank(db, $(bankDollars))
    const plan = investAccount(db, 'Morgan Stanley', 'brokerage', true)
    const goog = asset(db, 'GOOG')
    buy(db, plan, goog, '2024-01-10', 100, $(10_000))
    price(db, goog, '2026-09-30', $(200))
    db.prepare("INSERT INTO pay_sources (earner, employer, cadence, paid_on, gross_cents, invest_account_id) VALUES ('Max', 'Google', 'biweekly', '2026-09-25', 500000, ?)").run(plan)
  }
  it('fires when employer stock passes the threshold of liquid assets, naming the paycheck tied to it', () => {
    const db = mem()
    seed(db, 50_000)
    const f = finding(db, 'concentration')!
    expect(f.id).toBe('concentration:GOOG')
    expect(f.title).toContain('GOOG is 28.6% of liquid assets')
    expect(f.title).toContain("Max's paycheck")
    // $20,000 − 10% × $70,000
    expect(f.impactCents).toBe($(13_000))
  })
  it('stays quiet under the threshold, and follows the setting', () => {
    const db = mem()
    seed(db, 500_000)
    expect(kinds(db)).not.toContain('concentration')
    const db2 = mem()
    seed(db2, 50_000)
    putCheckupSettings(db2, { concentrationMicro: 300_000 })
    expect(kinds(db2)).not.toContain('concentration')
  })
})

describe('cash runway', () => {
  function seed(db: DbLike, openingDollars: number) {
    const a = bank(db, $(openingDollars))
    for (const m of ['04', '05', '06', '07', '08', '09']) tx(db, a, `2026-${m}-10`, -$(3_000), 'WHOLE FOODS', 'Groceries')
    return a
  }
  it('flags under three months of spending, with the shortfall as its impact', () => {
    const db = mem()
    seed(db, 20_000) // $2,000 left against $3,000 a month
    const f = finding(db, 'runway-low')!
    expect(f.title).toBe('Cash covers 0.7 months of spending')
    expect(f.impactCents).toBe($(7_000))
  })
  it('says nothing between three and twelve months', () => {
    const db = mem()
    seed(db, 40_000)
    expect(kinds(db).filter((k) => k === 'runway-low' || k === 'idle-cash')).toEqual([])
  })
  it('flags cash beyond a year of spending — unless it is set aside for the Dream Home', () => {
    const db = mem()
    const a = seed(db, 100_000) // $82,000 = 27 months
    expect(finding(db, 'idle-cash')!.impactCents).toBe($(46_000))
    db.prepare("INSERT INTO goal_settings (key, value) VALUES ('goal', ?)").run(JSON.stringify({ fundAccountIds: [a] }))
    expect(kinds(db)).not.toContain('idle-cash')
  })
  it('needs three months of history before it says anything', () => {
    const db = mem()
    const a = bank(db, $(100))
    tx(db, a, '2026-09-10', -$(3_000), 'WHOLE FOODS', 'Groceries')
    expect(kinds(db)).toEqual([])
  })
})

describe('itemized deductions from the ledger', () => {
  function seed(db: DbLike, opts: { mortgage?: number; propertyTax?: number; giving?: number } = {}) {
    const a = bank(db, $(500_000))
    if (opts.mortgage) {
      db.prepare("INSERT INTO properties (name, purchased_on, purchase_cents) VALUES ('Home', '2020-05-01', ?)").run($(900_000))
      db.prepare("INSERT INTO liabilities (property_id, name, rate_micro) VALUES (1, 'Mortgage', 60000)").run()
      db.prepare("INSERT INTO liability_balances (liability_id, balanced_on, balance_cents) VALUES (1, '2026-01-01', ?)").run($(opts.mortgage))
    }
    if (opts.propertyTax) tx(db, a, '2026-04-10', -$(opts.propertyTax), 'COUNTY TREASURER', 'Property tax')
    if (opts.giving) tx(db, a, '2026-06-01', -$(opts.giving), 'RED CROSS', 'Giving')
  }

  it('prices mortgage interest from the rate and balances, capped at $750,000 of debt', () => {
    const db = mem()
    seed(db, { mortgage: 600_000 })
    expect(mortgageInterestYear(db, 2026).loans[0]).toMatchObject({ interestCents: $(36_000), avgBalanceCents: $(600_000) })
    const db2 = mem()
    seed(db2, { mortgage: 1_000_000 })
    const it2 = deriveItemized(db2, today, 'mfj', 0, $(300_000))
    expect(it2.mortgageInterestCents).toBe($(60_000))
    expect(it2.mortgageDeductibleCents).toBe($(45_000))
  })

  it('caps SALT at $40,400, phased down by 30% of income over $505,000 to a $10,000 floor', () => {
    expect(saltCapCents('mfj', $(300_000))).toBe($(40_400))
    expect(saltCapCents('mfj', $(600_000))).toBe($(11_900))
    expect(saltCapCents('mfj', $(1_000_000))).toBe($(10_000))
    expect(saltCapCents('mfs', $(300_000))).toBe($(5_950))
  })

  it('finds the categories by name, and nets giving against the 0.5% floor', () => {
    const db = mem()
    seed(db, { mortgage: 600_000, propertyTax: 12_000, giving: 5_000 })
    const roles = resolveRoles(db)
    expect(roles.charity?.name).toBe('Giving')
    expect(roles.propertyTax?.name).toBe('Property tax')
    const it = deriveItemized(db, today, 'mfj', 0, $(300_000))
    expect(it).toMatchObject({ saltCents: $(12_000), charityFloorCents: $(1_500), charityDeductibleCents: $(3_500), totalCents: $(51_500) })
  })

  it('fires when itemizing beats the standard deduction, priced as the tax it saves', () => {
    const db = mem()
    seed(db, { mortgage: 600_000, propertyTax: 12_000, giving: 5_000 })
    taxes(db, 300_000)
    const f = finding(db, 'itemize')!
    expect(f.id).toBe('itemize:itemize')
    // $51,500 − $32,200 = $19,300 more, all inside the 24% bracket
    expect(f.impactCents).toBe($(4_632))
  })

  it('stays quiet when the standard deduction is larger, and flags a typed itemized total below it', () => {
    const db = mem()
    seed(db, { propertyTax: 12_000, giving: 5_000 })
    taxes(db, 300_000)
    expect(kinds(db)).not.toContain('itemize')
    putTaxSettings(db, { deductionMode: 'itemized', itemizedCents: $(20_000) })
    expect(finding(db, 'itemize')!.id).toBe('itemize:standard')
  })

  it('is the itemized figure Taxes uses when none is typed', () => {
    const db = mem()
    seed(db, { mortgage: 600_000, propertyTax: 12_000, giving: 5_000 })
    taxes(db, 300_000, { deductionMode: 'itemized' })
    const year = computeTaxYear(db, today)
    expect(year.incomes.deductionSource).toBe('derived')
    expect(year.incomes.deductionCents).toBe($(51_500))
    putTaxSettings(db, { itemizedCents: $(40_000) })
    expect(computeTaxYear(db, today).incomes).toMatchObject({ deductionSource: 'typed', deductionCents: $(40_000) })
  })

  it('leaves a role off when set to none', () => {
    const db = mem()
    seed(db, { giving: 5_000 })
    putCheckupSettings(db, { charityCategoryId: 0 })
    expect(resolveRoles(db).charity).toBeNull()
  })
})

describe('lots: give shares, harvest gains, harvest losses', () => {
  function seed(db: DbLike) {
    const a = bank(db, $(100_000))
    const acct = investAccount(db, 'Schwab')
    const vti = asset(db, 'VTI')
    const qqq = asset(db, 'QQQ')
    buy(db, acct, vti, '2020-01-02', 10, $(1_000)) // → $3,000, 67% gain
    buy(db, acct, qqq, '2021-01-04', 5, $(500)) // → $2,000, 75% gain
    price(db, vti, '2026-09-30', $(300))
    price(db, qqq, '2026-09-30', $(400))
    return { a, acct }
  }

  it('gives the lots with the most gain per dollar first, priced as the tax never owed', () => {
    const db = mem()
    const { a } = seed(db)
    tx(db, a, '2026-06-01', -$(5_000), 'RED CROSS', 'Giving')
    taxes(db, 300_000)
    const f = finding(db, 'give-shares')!
    expect(f.id).toBe('give-shares:QQQ')
    expect(f.inputs[1]!.label).toContain('QQQ')
    // $1,500 + $2,000 of gain avoided at 15%, plus the 3.8% NIIT above $250,000
    expect(f.impactCents).toBe($(658))
  })

  it('does not suggest giving shares without giving in the ledger', () => {
    const db = mem()
    seed(db)
    taxes(db, 300_000)
    expect(kinds(db)).not.toContain('give-shares')
  })

  it('fits long-term gains into the room left in the 0% band', () => {
    const db = mem()
    seed(db)
    taxes(db, 50_000) // $17,800 taxable: $81,100 of 0% room
    const f = finding(db, 'gain-harvest')!
    expect(f.impactCents).toBe($(525)) // $3,500 × 15% later, nothing now in Texas
    const c = getCheckup(db, today, ME)
    expect(c.headroom.lt0RoomCents).toBe($(81_100))
  })

  it('stays quiet with no 0% room, or with no wages entered', () => {
    const db = mem()
    seed(db)
    taxes(db, 300_000)
    expect(kinds(db)).not.toContain('gain-harvest')
    const db2 = mem()
    seed(db2)
    putTaxSettings(db2, { state: 'TX' })
    expect(kinds(db2)).not.toContain('gain-harvest')
    expect(getCheckup(db2, today, ME).headroom.wagesEntered).toBe(false)
  })

  it('prices loss harvesting exactly, and leaves out lots with a wash-sale risk', () => {
    const db = mem()
    const { acct } = seed(db)
    const arkk = asset(db, 'ARKK')
    buy(db, acct, arkk, '2026-03-02', 10, $(5_000))
    price(db, arkk, '2026-09-30', $(300)) // a $2,000 short-term loss
    taxes(db, 300_000)
    expect(finding(db, 'loss-harvest')!.impactCents).toBe($(480)) // $2,000 × 24%
    buy(db, investAccount(db, 'Roth', 'retirement'), arkk, '2026-09-20', 1, $(300))
    expect(kinds(db)).not.toContain('loss-harvest')
  })
})

describe('estimated tax and payroll', () => {
  it('flags a safe-harbor shortfall, and not once withholding covers it', () => {
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', wagesAnnualCents: $(300_000) })
    const f = finding(db, 'safe-harbor')!
    expect(f.id).toBe('safe-harbor:fed')
    expect(f.impactCents).toBeGreaterThan(0)
    expect(getCheckup(db, today, ME).calendar.some((x) => x.on === '2027-01-15' && x.title.startsWith('Federal'))).toBe(true)
    putTaxSettings(db, { withheldFederalCents: $(200_000) })
    expect(kinds(db)).not.toContain('safe-harbor')
  })

  it('flags the Additional Medicare Tax two employers never withheld', () => {
    const pay = (db: DbLike, earner: string) =>
      db.prepare("INSERT INTO pay_sources (earner, employer, cadence, paid_on, gross_cents) VALUES (?, 'Co', 'biweekly', '2026-09-25', ?)").run(earner, 576_923)
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX' })
    pay(db, 'Max')
    pay(db, 'Nicole') // ≈$150,000 each: $300,000 together, neither over $200,000
    const f = finding(db, 'addl-medicare')!
    expect(f.impactCents).toBeGreaterThan($(400))
    const db2 = mem()
    putTaxSettings(db2, { filingStatus: 'mfj', state: 'TX' })
    pay(db2, 'Max')
    expect(kinds(db2)).not.toContain('addl-medicare')
  })
})

describe('findings carried over from the digest', () => {
  it('flags an asset class that moved 3 points in 3 months, unpriced', () => {
    const db = mem()
    bank(db, $(100_000))
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('401(k)', 'retirement', 'balance')").run()
    const snap = db.prepare('INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, ?, ?)')
    snap.run('2026-07-15', $(100_000))
    snap.run('2026-09-30', $(300_000))
    const f = finding(db, 'allocation-drift')!
    expect(f.impactCents).toBe(0)
    expect(f.title).toContain('Cash went from 50.0% to 25.0%')
    expect(f.inputs).toContainEqual({ label: 'Retirement', value: '50.0% → 75.0%' })
    const db2 = mem()
    bank(db2, $(100_000))
    db2.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('401(k)', 'retirement', 'balance')").run()
    db2.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, '2026-07-15', ?)").run($(100_000))
    expect(kinds(db2)).not.toContain('allocation-drift')
  })

  it('annualizes recurring price creep', () => {
    const db = mem()
    const a = bank(db, $(10_000))
    for (const [on, cents] of [['2026-04-05', 1000], ['2026-05-05', 1000], ['2026-06-05', 1000], ['2026-07-05', 1000], ['2026-08-05', 1000], ['2026-09-05', 1200]] as const)
      tx(db, a, on, -cents, 'NETFLIX.COM', 'Subscriptions')
    const f = finding(db, 'price-creep')!
    expect(f.impactCents).toBe(2400) // $2 × 12
  })

  it('prices the mortgage-rate trigger on the Dream Home loan', () => {
    const db = mem()
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PMMS_KEY, JSON.stringify({ on: '2026-09-25', rateMicro: 60_000 }))
    db.prepare("INSERT INTO loan_options (name, rate_micro, term_months) VALUES ('Jumbo 30', 65000, 360)").run()
    db.prepare("INSERT INTO goal_settings (key, value) VALUES ('goal', ?)").run(JSON.stringify({ targetPriceCents: $(3_000_000), downPctMicro: 200_000 }))
    expect(finding(db, 'mortgage-rate')!.impactCents).toBe($(12_000)) // $2.4M × 0.5 points
    db.prepare('UPDATE app_meta SET value = ? WHERE key = ?').run(JSON.stringify({ on: '2026-09-25', rateMicro: 64_000 }), PMMS_KEY)
    expect(kinds(db)).not.toContain('mortgage-rate')
  })
})

describe('the list', () => {
  function busy(db: DbLike) {
    const a = bank(db, $(20_000))
    for (const m of ['04', '05', '06', '07', '08', '09']) tx(db, a, `2026-${m}-10`, -$(3_000), 'WHOLE FOODS', 'Groceries')
    for (const [on, cents] of [['2026-05-05', 1000], ['2026-06-05', 1000], ['2026-07-05', 1000], ['2026-08-05', 1000], ['2026-09-05', 1200]] as const)
      tx(db, a, on, -cents, 'NETFLIX.COM', 'Subscriptions')
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('401(k)', 'retirement', 'balance')").run()
    const snap = db.prepare('INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, ?, ?)')
    snap.run('2026-07-15', $(10_000))
    snap.run('2026-09-30', $(60_000))
  }

  it('sorts by dollar impact, the unpriced last', () => {
    const db = mem()
    busy(db)
    const fs = getCheckup(db, today, ME).findings
    expect(fs.map((f) => f.kind)).toEqual(['runway-low', 'price-creep', 'allocation-drift'])
    for (let i = 1; i < fs.length; i++) expect(fs[i - 1]!.impactCents).toBeGreaterThanOrEqual(fs[i]!.impactCents)
  })

  it('marks everything new until its reader marks it seen, per reader', () => {
    const db = mem()
    busy(db)
    expect(getCheckup(db, today, ME).findings.every((f) => f.isNew)).toBe(true)
    ackCheckup(db, today, ME)
    const after = getCheckup(db, today, ME)
    expect(after.seenAt).not.toBeNull()
    expect(after.findings.some((f) => f.isNew)).toBe(false)
    expect(getCheckup(db, today, 'nicole@x').findings.every((f) => f.isNew)).toBe(true)
    // A new finding arrives: only it is new.
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?)').run(PMMS_KEY, JSON.stringify({ on: '2026-09-25', rateMicro: 60_000 }))
    db.prepare("INSERT INTO loan_options (name, rate_micro, term_months) VALUES ('Jumbo 30', 65000, 360)").run()
    expect(getCheckup(db, today, ME).findings.filter((f) => f.isNew).map((f) => f.kind)).toEqual(['mortgage-rate'])
  })

  it('keeps the seen mark through a snapshot round trip', () => {
    const db = mem()
    busy(db)
    ackCheckup(db, today, ME)
    const copy = mem()
    loadDump(copy, dumpDb(db))
    const c = getCheckup(copy, today, ME)
    expect(c.findings.length).toBe(3)
    expect(c.findings.some((f) => f.isNew)).toBe(false)
  })

  it('is empty for an empty household', () => {
    const c = getCheckup(mem(), today, ME)
    expect(c.findings).toEqual([])
    expect(c.calendar.map((x) => x.on)).toEqual(['2026-12-31', '2027-04-15'])
  })
})

describe('calendar', () => {
  it('dates a Form 709 when a gift-category transaction passes the annual exclusion', () => {
    const db = mem()
    const a = bank(db, $(100_000))
    tx(db, a, '2026-03-01', -$(25_000), 'ZELLE TO SAM', 'Gifts')
    tx(db, a, '2026-04-01', -$(5_000), 'ZELLE TO ALEX', 'Gifts')
    const c = getCheckup(db, today, ME)
    expect(c.roles.gift?.name).toBe('Gifts')
    const gifts = c.calendar.filter((x) => x.title.includes('Form 709'))
    expect(gifts).toHaveLength(1)
    expect(gifts[0]).toMatchObject({ on: '2027-04-15', cents: $(25_000) })
  })
})

describe('assumptions', () => {
  it('reads the very tables the engine computes with, the state included', () => {
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'CA' })
    const groups = getAssumptions(db)
    const ids = groups.map((g) => g.id)
    expect(ids).toContain('state')
    expect(ids).toContain('itemized')
    expect(groups.find((g) => g.id === 'federal-deductions')!.rows).toContainEqual({ label: 'Married filing jointly', value: '$32,200' })
    expect(groups.find((g) => g.id === 'federal-brackets')!.rows[0]).toEqual({ label: '$0 – $24,800', value: '10%' })
    for (const g of groups) {
      expect(g.vintage).toBeTruthy()
      expect(g.source).toBeTruthy()
    }
  })
})
