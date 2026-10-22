import { addDaysIso, addMonthsIso, addMonthsToMonth, monthEndIso, monthsBetween } from '../shared/dates'
import { putAccountClass, putAssetClass, putTarget } from './allocation'
import type { MarketHistory } from './analytics'
import type { DbLike } from './db'
import { createPaySource } from './paychecks'
import { putPeople } from './people'
import { upsertPrices } from './prices'
import {
  anchorAccount,
  createAccount,
  createInvestAccount,
  createLiability,
  createLoan,
  createProperty,
  createTrade,
  importRules,
  putBalanceSnapshot,
  putBudget,
  putGoal,
  putLiabilityBalance,
  putUnvested,
  putValuation,
  runImport,
  setManualPrice,
  vestUnvested,
} from './services'
import { putTaxSettings } from './tax'

/**
 * The sample household the front door opens before anyone has a vault: two
 * earners with paychecks — one with RSUs in a stock plan — a house with a
 * mortgage, a taxable brokerage, a 401(k) and a 403(b), a credit card, and two
 * years of bank and card transactions, categorized by the seed rules and a few
 * of the household's own. Every person, employer, town and amount is made up.
 *
 * Built the way scripts/mkfixture.ts builds a fixture: through the engine's
 * own write paths (an import is a CSV run through runImport, a vest is
 * vestUnvested), so every screen reads it as it would a real household's,
 * and nothing derived is stored. Dated back from `today`, so it always looks
 * current; deterministic for a given day — the amounts come from a hash of
 * the calendar date, never from a clock or Math.random.
 *
 * Prices: `market`, when the tab has the shared monthly history (the file
 * every session reads), prices the index funds with their real month-end
 * closes; otherwise, and for the employer's stock (made up, so no quote
 * exists — it carries a hand-entered price), a synthetic monthly path.
 * Integer cents throughout, like everything else.
 */

/* ---------- the made-up household ---------- */

const EARNER_A = 'Alex'
const EARNER_B = 'Sam'
const IMPORTER = 'alex@example.com'
const STOCK = 'LRKS' // Larkspur Systems — fictional; no exchange lists it
const ALEX_PAYDAY = '2024-01-05' // a Friday: Alex is paid every other Friday from it
const MORTGAGE = { refiOn: '2020-12-01', principal: 59_800_000, rateMicro: 28_750, pi: 248_108, escrow: 65_000 }
const HOME = { purchasedOn: '2019-06-14', purchase: 78_000_000, growthMicro: 35_000 }

/* ---------- deterministic noise ---------- */

/** A 32-bit hash of a key (FNV-1a with a murmur3 finish): the same key always draws the same number. */
function hash(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}
/** A whole number from lo to hi, inclusive, drawn by `key`. */
const between = (key: string, lo: number, hi: number) => lo + (hash(key) % (hi - lo + 1))
/** True with probability `pct`/100, drawn by `key`. */
const chance = (key: string, pct: number) => hash(key) % 100 < pct
const pick = <T>(key: string, xs: readonly T[]): T => xs[hash(key) % xs.length]!
/** a·b/d rounded half away from zero, for integers (|a·b| stays far inside 2^53 here). */
const mulDiv = (a: number, b: number, d: number) => Math.sign(a * b) * Math.round(Math.abs(a * b) / d)

/* ---------- calendar ---------- */

const DAY_MS = 86_400_000
const dayNumber = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS
/** 0 Sunday … 6 Saturday. */
const weekday = (iso: string) => (((dayNumber(iso) + 4) % 7) + 7) % 7
/** The Friday before a weekend day; a weekday as it is. */
const backToFriday = (iso: string) => (weekday(iso) === 6 ? addDaysIso(iso, -1) : weekday(iso) === 0 ? addDaysIso(iso, -2) : iso)
/** The Monday after a weekend day; a weekday as it is. */
const onToMonday = (iso: string) => (weekday(iso) === 6 ? addDaysIso(iso, 2) : weekday(iso) === 0 ? addDaysIso(iso, 1) : iso)
const dayOf = (month: string, d: number) => (d > 28 ? monthEndIso(month) : `${month}-${String(d).padStart(2, '0')}`)

/* ---------- prices ---------- */

type Path = { ref: string; refCents: number; growthMicro: number; noiseMicro: number }

/** Each fund's synthetic month-end path: a level at a reference month, a yearly drift, and a monthly wobble. */
const PATHS: Record<string, Path> = {
  VTI: { ref: '2024-10', refCents: 28_100, growthMicro: 120_000, noiseMicro: 35_000 },
  VXUS: { ref: '2024-10', refCents: 6_200, growthMicro: 90_000, noiseMicro: 35_000 },
  BND: { ref: '2024-10', refCents: 7_300, growthMicro: 0, noiseMicro: 9_000 },
  [STOCK]: { ref: '2024-10', refCents: 8_400, growthMicro: 150_000, noiseMicro: 70_000 },
}

/**
 * Month-end closes for `months` (oldest first): the market's real close where
 * it has one, else a step from the month before along the symbol's path — so
 * a synthetic stretch carries on from the last real close.
 */
function monthlyCloses(symbol: string, months: readonly string[], market: MarketHistory | undefined): Map<string, number> {
  const p = PATHS[symbol]!
  const real = new Map<string, number>()
  for (const c of (symbol === STOCK ? null : market?.closes(symbol, 'stock')) ?? []) real.set(c.on.slice(0, 7), c.cents)
  const out = new Map<string, number>()
  let prev: number | null = null
  for (const m of months) {
    let cents = real.get(m)
    if (cents === undefined) {
      if (prev === null) {
        // No earlier close to step from: walk the drift from the reference month to this one.
        let level = p.refCents
        const steps = monthsBetween(m < p.ref ? m : p.ref, m < p.ref ? p.ref : m).length - 1
        for (let k = 0; k < steps; k++) level = m < p.ref ? mulDiv(level, 12_000_000, 12_000_000 + p.growthMicro) : level + mulDiv(level, p.growthMicro, 12_000_000)
        cents = level
      } else {
        const wobble = between(`${symbol}:${m}`, -p.noiseMicro, p.noiseMicro)
        cents = Math.max(100, prev + mulDiv(prev, Math.round(p.growthMicro / 12) + wobble, 1_000_000))
      }
    }
    out.set(m, cents)
    prev = cents
  }
  return out
}

/* ---------- pay ---------- */

/** The year a raise belongs to: raises land each March. */
const compYear = (iso: string) => Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) < 3 ? 1 : 0)
/** Gross per check: a base salary in 2024 dollars, up `raiseMicro` each March, split over the year's checks. */
function grossOn(iso: string, base2024: number, raiseMicro: number, checks: number): number {
  let salary = base2024
  for (let y = 2024; y < compYear(iso); y++) salary += mulDiv(salary, raiseMicro, 1_000_000)
  for (let y = 2024; y > compYear(iso); y--) salary = mulDiv(salary, 1_000_000, 1_000_000 + raiseMicro)
  return Math.round(salary / checks)
}

type Stub = { gross: number; retirement: number; benefits: number; fed: number; state: number; net: number }

/** One paycheck, the way the stub reads: deferral and benefits off the top, then withholding and FICA. */
function stub(gross: number, retirementMicro: number, benefits: number, fedMicro: number, stateMicro: number): Stub {
  const retirement = mulDiv(gross, retirementMicro, 1_000_000)
  const taxable = gross - retirement - benefits
  const fed = mulDiv(taxable, fedMicro, 1_000_000)
  const state = mulDiv(taxable, stateMicro, 1_000_000)
  const fica = mulDiv(gross - benefits, 76_500, 1_000_000) // 6.2% Social Security + 1.45% Medicare
  return { gross, retirement, benefits, fed, state, net: taxable - fed - state - fica }
}
const alexStub = (on: string) => stub(grossOn(on, 15_800_000, 40_000, 26), 80_000, 21_000, 155_000, 68_000)
const samStub = (on: string) => stub(grossOn(on, 11_800_000, 35_000, 24), 60_000, 15_000, 120_000, 50_000)

const isAlexPayday = (iso: string) => (dayNumber(iso) - dayNumber(ALEX_PAYDAY)) % 14 === 0
const samPaydays = (month: string) => [backToFriday(dayOf(month, 15)), backToFriday(monthEndIso(month))]

/* ---------- the statements ---------- */

type Row = { on: string; cents: number; text: string }

/** Integer cents as a statement prints them: -1234 → '-12.34'. */
const amount = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`
const csv = (rows: readonly Row[]) =>
  `Date,Description,Amount\n${rows.map((r) => `${r.on},"${r.text.replace(/"/g, '""')}",${amount(r.cents)}`).join('\n')}\n`

const GROCERS = ['WHOLE FOODS MARKET #10234', 'SAFEWAY #1532', "TRADER JOE'S #212"] as const
const DINING = ['TST* LUNA TAQUERIA', 'TST* HARBOR NOODLE BAR', 'DOORDASH*THAI SPICE', 'SQ *PIER 9 PIZZA', 'TST* OLIVE & FIG'] as const
/** Electricity by calendar month: winter heating and summer cooling, in cents. */
const POWER = [26_800, 24_100, 19_800, 16_200, 14_100, 15_500, 18_900, 21_400, 17_800, 15_200, 19_700, 25_100] as const

type Statements = { checking: Row[]; savings: Row[]; card: Row[]; opening: { checking: number; savings: number; card: number } }

/**
 * Two years of the household's money, day by day: paychecks into checking;
 * the mortgage, preschool, utilities, a monthly brokerage contribution and a
 * savings sweep out of it; everyday spending on the card, paid in full each
 * month. Balances are tracked as it goes, so checking keeps a cushion and
 * the card payment is the statement it pays.
 */
function statements(start: string, today: string, sale: { on: string; cents: number } | null): Statements {
  const opening = { checking: 980_000, savings: 3_850_000, card: -214_000 }
  const out: Statements = { checking: [], savings: [], card: [], opening }
  const bal = { ...opening }
  let statement = 0
  const add = (acct: 'checking' | 'savings' | 'card', on: string, cents: number, text: string) => {
    out[acct].push({ on, cents, text })
    bal[acct] += cents
  }
  const recent = addDaysIso(today, -21) // the last three weeks: a few merchants no rule knows yet
  const creep = (months: number) => addMonthsIso(today, -months) // when a subscription's price went up
  for (let on = start; on <= today; on = addDaysIso(on, 1)) {
    const d = Number(on.slice(8, 10))
    const month = on.slice(0, 7)
    const mo = Number(on.slice(5, 7))
    const wd = weekday(on)
    const k = (what: string) => `${what}:${on}`

    /* ----- money in ----- */
    if (isAlexPayday(on)) add('checking', on, alexStub(on).net, 'LARKSPUR SYSTEMS PAYROLL PPD')
    if (samPaydays(month).includes(on)) add('checking', on, samStub(on).net, 'BAYVIEW HEALTH DIRECT DEP')
    if (sale && on === onToMonday(addDaysIso(sale.on, 2))) add('checking', on, sale.cents, 'VANGUARD EDI WITHDRAWAL')

    /* ----- bills out of checking ----- */
    if (d === 1) {
      add('checking', on, -(MORTGAGE.pi + MORTGAGE.escrow), 'MR. COOPER MORTGAGE PMT')
      add('checking', on, -185_000, 'LITTLE ACORNS PRESCHOOL TUITION')
    }
    if (d === 2) {
      add('checking', on, -100_000, 'ONLINE TRANSFER TO HIGH-YIELD SAVINGS XXXX4410')
      add('savings', on, 100_000, 'ONLINE TRANSFER FROM EVERYDAY CHECKING XXXX2291')
      // Anything well past a cushion goes to savings too.
      const sweep = Math.floor((bal.checking - 1_200_000) / 50_000) * 50_000
      if (bal.checking > 1_600_000 && sweep > 0) {
        add('checking', on, -sweep, 'ONLINE TRANSFER TO HIGH-YIELD SAVINGS XXXX4410')
        add('savings', on, sweep, 'ONLINE TRANSFER FROM EVERYDAY CHECKING XXXX2291')
      }
    }
    if (d === 3) add('checking', on, -14_500, 'BAYPORT CLIMBING GYM')
    if (on === onToMonday(dayOf(month, 6))) add('checking', on, -300_000, 'VANGUARD BROKERAGE INVESTMENT')
    if (d === 9) add('checking', on, -13_140, 'STATE FARM INSURANCE')
    if (d === 12) add('checking', on, on >= creep(4) ? -9_499 : -8_999, 'COX COMMUNICATIONS')
    if (d === 18) add('checking', on, -(POWER[mo - 1]! + between(k('power'), -1_500, 1_500)), 'PG&E WEB ONLINE')
    if (d === 20 && mo % 2 === 0) add('checking', on, -between(k('water'), 8_600, 16_400), 'CITY OF BAYPORT WATER')
    if (mo === 4 && on === onToMonday(dayOf(month, 15))) {
      add('checking', on, -between(k('irs'), 160_000, 260_000), 'IRS USATAXPYMT')
      add('checking', on, -between(k('ftb'), 45_000, 90_000), 'FRANCHISE TAX BO PAYMENTS')
    }
    if (wd === 6 && chance(k('venmo'), 20)) add('checking', on, -between(k('venmo$'), 2_000, 12_000), 'VENMO PAYMENT')
    if (d === 21) statement = bal.card // the card's statement closes
    if (d === 26 && statement < 0) {
      add('checking', on, statement, 'RWRDS VISA AUTOPAY')
      add('card', on, -statement, 'PAYMENT THANK YOU')
      statement = 0
    }

    /* ----- savings ----- */
    if (on === monthEndIso(month)) add('savings', on, mulDiv(bal.savings, 41_000, 12_000_000), 'INTEREST PAYMENT')

    /* ----- everyday spending on the card ----- */
    if (wd === 6) add('card', on, -between(k('shop'), 9_500, 22_000), pick(k('grocer'), GROCERS))
    if (wd === 3 && chance(k('topup'), 55)) add('card', on, -between(k('topup$'), 2_800, 7_500), "TRADER JOE'S #212")
    if (wd === 0 && d <= 7) add('card', on, -between(k('costco'), 16_000, 34_000), 'COSTCO WHSE #0471')
    if (chance(k('dine'), wd === 5 ? 60 : 28)) add('card', on, -between(k('dine$'), wd === 5 ? 4_500 : 1_400, wd === 5 ? 12_000 : 6_800), pick(k('where'), DINING))
    if (wd >= 1 && wd <= 5 && chance(k('coffee'), 35)) add('card', on, -between(k('coffee$'), 525, 1_150), 'SQ *MORNING BIRD COFFEE')
    if (chance(k('amzn'), 14)) add('card', on, -between(k('amzn$'), 1_200, 14_000), `AMAZON.COM*${(hash(k('ref')) % 46656).toString(36).toUpperCase().padStart(3, 'X')}`)
    if (wd === 0 && chance(k('target'), 45)) add('card', on, -between(k('target$'), 2_500, 13_000), 'TARGET 00012345')
    if (wd === 6 && chance(k('depot'), 18)) add('card', on, -between(k('depot$'), 1_800, 19_000), 'THE HOME DEPOT #0612')
    if (chance(k('gas'), 10)) add('card', on, -between(k('gas$'), 4_200, 7_600), pick(k('station'), ['CHEVRON 0209876', 'SHELL OIL 57444']))
    if (chance(k('uber'), 4)) add('card', on, -between(k('uber$'), 1_200, 4_500), 'UBER *TRIP')
    if (chance(k('kaiser'), 3)) add('card', on, -between(k('kaiser$'), 2_000, 7_500), 'KAISER PERMANENTE COPAY')
    if (chance(k('cvs'), 5)) add('card', on, -between(k('cvs$'), 900, 4_800), 'CVS/PHARMACY #9921')
    if (d === 5) add('card', on, on >= creep(9) ? -1_799 : -1_549, 'NETFLIX.COM')
    if (d === 11) add('card', on, -1_699, 'SPOTIFY USA')
    if (d === 22) add('card', on, -999, 'APPLE.COM/BILL')
    if (d === 14) add('card', on, -between(k('chewy'), 5_200, 7_900), 'CHEWY.COM')
    if ((mo === 3 || mo === 9) && d === 9) add('card', on, -between(k('vet'), 18_000, 42_000), 'BAYPORT VETERINARY HOSPITAL')
    if (mo >= 3 && mo <= 6 && wd === 6 && chance(k('nursery'), 35)) add('card', on, -between(k('nursery$'), 2_400, 14_000), 'SUNSET NURSERY')
    if (wd === 5 && chance(k('wine'), 25)) add('card', on, -between(k('wine$'), 3_200, 9_600), 'TOTAL WINE & MORE 1104')
    // Two trips a year: summer by air and a rented house, winter by air and a hotel.
    if (mo === 5 && d === 28) add('card', on, -between(k('fly'), 52_000, 78_000), 'SOUTHWES 5262341187')
    if (mo === 6 && d === 2) add('card', on, -between(k('stay'), 110_000, 170_000), 'AIRBNB * HM4K2J8X')
    if (mo === 10 && d === 30) add('card', on, -between(k('fly'), 48_000, 72_000), 'SOUTHWES 5262984410')
    if (mo === 11 && d === 15) add('card', on, -between(k('stay'), 60_000, 90_000), 'HOTEL MIRADOR SANTA FE')
    if (on >= recent && wd === 0 && chance(k('market'), 80)) add('card', on, -between(k('market$'), 2_200, 4_600), 'FARMERS MARKET BAYPORT')
    if (on >= recent && wd === 4 && chance(k('hardware'), 70)) add('card', on, -between(k('hardware$'), 1_200, 5_200), 'BAYPORT HARDWARE CO')
  }
  return out
}

/** The household's own rules, pasted the way Cash's "Import rules" takes them: what the seed list doesn't know. */
const RULES = `LITTLE ACORNS PRESCHOOL\tChildcare
BAYPORT CLIMBING\tHealth
CVS/PHARMACY\tHealth
HOME DEPOT\tHousing
VANGUARD\tTransfer`

/** Plan per month, by category name. */
const BUDGET: Record<string, number> = {
  Groceries: 110_000,
  Dining: 55_000,
  Shopping: 45_000,
  Transportation: 30_000,
  Subscriptions: 6_000,
  Travel: 45_000,
  Pets: 12_000,
  Health: 30_000,
  Childcare: 185_000,
}

/* ---------- the build ---------- */

/** Every vest of a quarterly schedule (the 15th of Mar, Jun, Sep, Dec) from `from` through `to`. */
function quarterlyVests(from: string, to: string): string[] {
  const out: string[] = []
  for (const m of monthsBetween(from.slice(0, 7), to.slice(0, 7))) {
    const on = `${m}-15`
    if (Number(m.slice(5, 7)) % 3 === 0 && on >= from && on <= to) out.push(on)
  }
  return out
}

const qtyText = (micro: number) => `${Math.floor(micro / 1_000_000)}${micro % 1_000_000 ? `.${String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '')}` : ''}`
const idOf = (db: DbLike, sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { id: number }).id

/**
 * Write the sample household into an empty, migrated database. `today` is
 * the household's day; facts run from the first of the month two years
 * before it through it, and nothing is dated after it.
 */
export function buildSampleHousehold(db: DbLike, today: string, o: { market?: MarketHistory } = {}): void {
  const start = `${addMonthsToMonth(today.slice(0, 7), -24)}-01`
  const thisMonth = today.slice(0, 7)
  const months = monthsBetween(addMonthsToMonth(start.slice(0, 7), -1), thisMonth)
  const finished = months.filter((m) => m < thisMonth)
  const close = Object.fromEntries(['VTI', 'VXUS', 'BND', STOCK].map((s) => [s, monthlyCloses(s, months, o.market)])) as Record<string, Map<string, number>>
  /** What a trade on `on` pays: the month-end close before it. */
  const priceFor = (symbol: string, on: string) => close[symbol]!.get(addMonthsToMonth(on.slice(0, 7), -1))!

  // A sale of long-held shares five months back (a kitchen), its cash landing in checking.
  const saleOn = onToMonday(dayOf(addMonthsToMonth(thisMonth, -5), 20))
  const saleQty = 40_000_000
  const sale = { on: saleOn, cents: mulDiv(saleQty, priceFor('VTI', saleOn), 1_000_000) }

  /* ----- cash: the household's rules, then two years of statements, then the real balances ----- */
  importRules(db, { text: RULES })
  const checking = createAccount(db, { name: 'Everyday Checking', kind: 'checking' })
  const savings = createAccount(db, { name: 'High-Yield Savings', kind: 'savings' })
  const card = createAccount(db, { name: 'Rewards Visa', kind: 'credit' })
  const st = statements(start, today, sale)
  for (const [acct, rows, opening, name] of [
    [checking, st.checking, st.opening.checking, 'checking'],
    [savings, st.savings, st.opening.savings, 'savings'],
    [card, st.card, st.opening.card, 'visa'],
  ] as const) {
    // One download per quarter, the way a household catches up on its statements.
    const quarters = new Map<string, Row[]>()
    for (const r of rows) {
      const q = `${r.on.slice(0, 4)}-q${Math.ceil(Number(r.on.slice(5, 7)) / 3)}`
      quarters.set(q, [...(quarters.get(q) ?? []), r])
    }
    for (const [q, part] of quarters) runImport(db, { accountId: acct.id, filename: `${name}-${q}.csv`, content: csv(part) }, IMPORTER)
    anchorAccount(db, acct.id, { currentBalanceCents: opening + rows.reduce((s, r) => s + r.cents, 0) })
  }
  for (const [name, cents] of Object.entries(BUDGET)) putBudget(db, { categoryId: idOf(db, 'SELECT id FROM categories WHERE name = ?', name), monthlyCents: cents })

  /* ----- the taxable brokerage: lots held for years, then a contribution invested each month ----- */
  const brokerage = createInvestAccount(db, { name: 'Joint brokerage', subtype: 'taxable', tracking: 'lots', institution: 'Vanguard' })
  const held: [string, string, number, number][] = [
    // symbol, acquired, shares, cost per share — booked at the start of the two years, held since `acquired`
    ['VTI', '2018-02-14', 120, 13_920],
    ['VTI', '2019-11-04', 150, 16_010],
    ['VTI', '2021-03-15', 100, 20_680],
    ['VXUS', '2019-11-04', 300, 5_420],
    ['VXUS', '2021-03-15', 250, 6_310],
    ['BND', '2020-08-03', 200, 8_850],
    ['BND', '2022-10-17', 150, 7_020],
  ]
  const lotIds = held.map(
    ([symbol, acquiredOn, shares, each]) =>
      createTrade(
        db,
        { investAccountId: brokerage.id, symbol, assetKind: 'stock', side: 'buy', tradedOn: start, acquiredOn, qty: String(shares), totalCents: shares * each },
        today,
      ).id,
  )
  for (const m of months.slice(1)) {
    const on = onToMonday(dayOf(m, 7))
    if (on > today) continue
    for (const [symbol, cents] of [['VTI', 180_000], ['VXUS', 75_000], ['BND', 45_000]] as const) {
      const price = priceFor(symbol, on)
      const qtyMicro = Math.floor((cents * 1_000) / price) * 1_000
      createTrade(
        db,
        { investAccountId: brokerage.id, symbol, assetKind: 'stock', side: 'buy', tradedOn: on, qty: qtyText(qtyMicro), totalCents: mulDiv(qtyMicro, price, 1_000_000) },
        today,
      )
    }
  }
  createTrade(
    db,
    { investAccountId: brokerage.id, symbol: 'VTI', assetKind: 'stock', side: 'sell', tradedOn: saleOn, qty: qtyText(saleQty), totalCents: sale.cents, soldLotTradeId: lotIds[0] },
    today,
  )

  /* ----- Alex's stock plan: a new-hire grant and a refresh, vesting quarterly; the employer keeps shares for the tax ----- */
  const plan = createInvestAccount(db, { name: 'Larkspur stock plan', subtype: 'stock_plan', tracking: 'lots', stockPlan: true, owner: EARNER_A })
  const vestsA = quarterlyVests(start, today)
  const refreshFrom = addMonthsIso(start, 8)
  const vestsB = quarterlyVests(refreshFrom, today)
  const grantA = putUnvested(
    db,
    { investAccountId: plan.id, symbol: STOCK, qty: String(vestsA.length * 120 + 240), nextVestOn: vestsA[0] ?? quarterlyVests(start, addMonthsIso(start, 3))[0], vestEveryMonths: 3, vestQty: '120' },
    today,
  ).id!
  const grantB = putUnvested(
    db,
    { investAccountId: plan.id, symbol: STOCK, qty: String(vestsB.length * 40 + 400), nextVestOn: vestsB[0] ?? quarterlyVests(refreshFrom, addMonthsIso(refreshFrom, 3))[0], vestEveryMonths: 3, vestQty: '40' },
    today,
  ).id!
  const vests = [...vestsA.map((on) => ({ on, qty: 120, grantId: grantA })), ...vestsB.map((on) => ({ on, qty: 40, grantId: grantB }))].sort((a, b) => a.on.localeCompare(b.on))
  for (const v of vests) {
    const price = close[STOCK]!.get(v.on.slice(0, 7))!
    vestUnvested(
      db,
      { investAccountId: plan.id, symbol: STOCK, qty: String(v.qty), tradedOn: v.on, totalCents: v.qty * price, withheldQty: String(Math.round((v.qty * 39) / 100)), grantId: v.grantId },
      today,
    )
  }

  /* ----- prices: month-end closes (and the stock's vest days); the stock's latest is a hand-entered price ----- */
  upsertPrices(
    db,
    ['VTI', 'VXUS', 'BND'].flatMap((symbol) => finished.map((m) => ({ symbol, cents: close[symbol]!.get(m)!, pricedOn: monthEndIso(m) }))),
  )
  // The market's close for the month in progress, when it has one (dated the day it was taken).
  for (const symbol of ['VTI', 'VXUS', 'BND']) {
    const now = o.market?.closes(symbol, 'stock')?.find((c) => c.on.slice(0, 7) === thisMonth && c.on <= today)
    if (now) upsertPrices(db, [{ symbol, cents: now.cents, pricedOn: now.on }])
  }
  const stockDays = [...finished.map((m) => ({ on: monthEndIso(m), cents: close[STOCK]!.get(m)! })), ...vests.map((v) => ({ on: v.on, cents: close[STOCK]!.get(v.on.slice(0, 7))! }))].sort((a, b) => a.on.localeCompare(b.on))
  upsertPrices(db, stockDays.slice(0, -1).map((p) => ({ symbol: STOCK, cents: p.cents, pricedOn: p.on })))
  const latest = stockDays.at(-1)!
  setManualPrice(db, { symbol: STOCK, pricedOn: latest.on, cents: latest.cents }, today)

  /* ----- retirement accounts, by statement balance: contributions plus most of the market's move ----- */
  for (const r of [
    { name: `${EARNER_A}’s 401(k)`, subtype: '401k', owner: EARNER_A, institution: 'Fidelity', opening: 18_600_000, monthly: 156_800 },
    { name: `${EARNER_B}’s 403(b)`, subtype: '403b', owner: EARNER_B, institution: 'TIAA', opening: 9_400_000, monthly: 101_800 },
  ]) {
    const acct = createInvestAccount(db, { name: r.name, subtype: r.subtype, tracking: 'balance', owner: r.owner, institution: r.institution })
    let balance = r.opening
    const balances = months.slice(1).flatMap((m, i) => {
      const before = close.VTI!.get(months[i]!)!
      const move = mulDiv(close.VTI!.get(m)! - before, 850_000, before) // micro: 85% of the stock market's month
      balance += mulDiv(balance, move, 1_000_000) + r.monthly
      return monthEndIso(m) <= today ? [{ balancedOn: monthEndIso(m), balanceCents: balance }] : []
    })
    putBalanceSnapshot(db, { investAccountId: acct.id, balances }, today)
  }

  /* ----- the house and its mortgage: a quarterly estimate, and the balance after each payment ----- */
  const home = createProperty(db, { name: 'Larch Avenue house', purchasedOn: HOME.purchasedOn, purchaseCents: HOME.purchase })
  for (const m of months.slice(1).filter((_, i) => i % 3 === 0)) {
    const on = dayOf(m, 15) <= today ? dayOf(m, 15) : today
    let value = HOME.purchase
    for (let k = monthsBetween(HOME.purchasedOn.slice(0, 7), m).length - 1; k > 0; k--) value += mulDiv(value, HOME.growthMicro, 12_000_000)
    // An estimate, to the nearest $1,000, a little either side of the trend.
    putValuation(db, home.id, { valuedOn: on, valueCents: Math.round(value / 100_000) * 100_000 + between(`home:${m}`, -6, 6) * 100_000 })
  }
  let owed = MORTGAGE.principal
  const loanMonths = monthsBetween(addMonthsToMonth(MORTGAGE.refiOn.slice(0, 7), 1), thisMonth)
  const mortgage = createLiability(db, { propertyId: home.id, name: 'Mr. Cooper mortgage', rateMicro: MORTGAGE.rateMicro })
  for (const m of loanMonths) {
    owed -= MORTGAGE.pi - mulDiv(owed, MORTGAGE.rateMicro, 12_000_000)
    if (`${m}-01` >= start) putLiabilityBalance(db, mortgage.id, { balancedOn: `${m}-01`, balanceCents: owed })
  }

  /* ----- paychecks (the latest stub each), the people, and how they file ----- */
  let alexOn = today
  while (!isAlexPayday(alexOn)) alexOn = addDaysIso(alexOn, -1)
  const samOn = [...samPaydays(thisMonth), ...samPaydays(addMonthsToMonth(thisMonth, -1))].filter((on) => on <= today).sort().at(-1)!
  for (const p of [
    { earner: EARNER_A, employer: 'Larkspur Systems', cadence: 'biweekly', paidOn: alexOn, s: alexStub(alexOn), investAccountId: plan.id, matchRateMicro: 500_000, matchCapMicro: 60_000 },
    { earner: EARNER_B, employer: 'Bayview Health', cadence: 'semimonthly', paidOn: samOn, s: samStub(samOn), investAccountId: null, matchRateMicro: 1_000_000, matchCapMicro: 40_000 },
  ])
    createPaySource(db, {
      earner: p.earner,
      employer: p.employer,
      cadence: p.cadence,
      paidOn: p.paidOn,
      grossCents: p.s.gross,
      retirementCents: p.s.retirement,
      benefitsCents: p.s.benefits,
      fedWithheldCents: p.s.fed,
      stateWithheldCents: p.s.state,
      investAccountId: p.investAccountId,
      matchRateMicro: p.matchRateMicro,
      matchCapMicro: p.matchCapMicro,
    })
  putPeople(db, { people: [{ name: EARNER_A, birthYear: 1987 }, { name: EARNER_B, birthYear: 1989 }] }, today)
  putTaxSettings(db, {
    filingStatus: 'mfj',
    state: 'CA',
    priorYearTaxFederalCents: 3_850_000,
    priorYearTaxStateCents: 1_480_000,
    priorYearAgiOver150k: true,
    qualifiedDividendShareMicro: 800_000,
  })

  /* ----- the next house, an allocation target ----- */
  putGoal(db, {
    goal: { targetPriceCents: 135_000_000, downPctMicro: 200_000, closingCents: 3_500_000, fundAccountIds: [savings.id], monthlyPlanCents: 350_000 },
    rental: { propertyId: home.id, rentCents: 520_000, piCents: MORTGAGE.pi, taxCents: 52_000, insCents: 14_500 },
  })
  createLoan(db, { name: '30-year fixed', rateMicro: 62_500, termMonths: 360 })
  createLoan(db, { name: '7/6 ARM', rateMicro: 56_250, termMonths: 360, pointsMicro: 5_000, note: 'Fixed for 7 years' })
  for (const [symbol, assetClass] of [['VTI', 'us_stock'], ['VXUS', 'intl_stock'], ['BND', 'bonds'], [STOCK, 'us_stock']] as const)
    putAssetClass(db, idOf(db, 'SELECT id FROM assets WHERE symbol = ?', symbol), { assetClass })
  for (const id of (db.prepare("SELECT id FROM invest_accounts WHERE tracking = 'balance'").all() as { id: number }[]).map((r) => r.id))
    putAccountClass(db, id, { assetClass: 'us_stock' })
  putTarget(db, { targets: { us_stock: 600_000, intl_stock: 150_000, bonds: 100_000, cash: 150_000 } })
}
