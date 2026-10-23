import type { BracketHeadroom, CalendarItem, Checkup, Finding } from '../shared/checkup-api'
import { getAllocation, getTarget } from './allocation'
import { addMonthsToMonth } from '../shared/dates'
import { formatDollars, formatQtyMicro } from '../shared/money'
import { saleCoverage, type SaleCoverage } from './capacity'
import { contributionFindings } from './checkup-contributions'
import { getCheckupSettings, resolveRoles, type Roles } from './checkup-settings'
import { computeContributions } from './contributions'
import type { DbLike } from './db'
import { allocationShift, DRIFT_MICRO, PMMS_KEY } from './digest'
import { cashAt, loadHoldings, type CashTrade } from './holdings'
import { CHARITY_AGI_FLOOR_MICRO, ITEMIZE_VINTAGE } from './itemize'
import { positionValueCents } from './lots'
import { netWorthSeries, type NetWorthPoint } from './networth'
import { listPaySources, PAYROLL_VINTAGE } from './paychecks'
import { detectRecurring, type Cadence } from './recurring'
import { cashflowByMonth } from './services'
import {
  ADDL_MEDICARE_THRESHOLD,
  computeHarvest,
  computeTax,
  FEDERAL_BRACKETS_2026,
  FEDERAL_LT_THRESHOLDS_2026,
  STATES,
  TAX_DATA_VINTAGE,
  taxYear,
  type HarvestLot,
  type TaxInputs,
} from './tax'
import { priceCapitalTiming, twoYearContext, type Context as TwoYearContext } from './twoyear'

/**
 * The Checkup: a derived, prioritized list of findings — what is true about
 * the household that a planner or a tax preparer would bring up — each one
 * showing its rule, its inputs, its arithmetic and what it leaves out.
 * Findings, never advice: a rule fires on the ledger and says what it saw.
 *
 * Same rules as the rest of engine/: isomorphic, synchronous, integer cents,
 * nothing stored but a per-person "seen" mark (app_meta, like the digest's),
 * so a finding is new until its reader marks the Checkup seen.
 */

const seenKey = (who: string) => `checkup:seen:${who}`
const nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** Below this many months of spending, cash is a finding; above IDLE, the opposite one. */
export const RUNWAY_LOW_MONTHS = 3
export const RUNWAY_IDLE_MONTHS = 12
/** Months of spending history the average needs before runway says anything. */
const RUNWAY_MIN_HISTORY = 3
/** The window the allocation drift finding compares across. */
const DRIFT_MONTHS = 3
/** The mortgage-rate finding fires when the market average is this far under the best saved option (micro: 0.25pp). */
const MORTGAGE_TRIGGER_MICRO = 2_500
/** The federal long-term rate a gain realized later is assumed to meet (the 15% band). */
const LATER_LT_MICRO = 150_000
/** Annual gift-tax exclusion per recipient, 2026 (Rev. Proc. 2025-32). */
export const GIFT_EXCLUSION_2026 = 19_000_00

const $ = (cents: number) => formatDollars(cents)
const pct = (micro: number, digits = 1) => `${(micro / 10_000).toFixed(digits)}%`
const share = (part: number, whole: number) => (whole > 0 ? Math.round((part * 1_000_000) / whole) : 0)

type Seen = { at: string; ids: string[] }
function readSeen(db: DbLike, who: string): Seen | null {
  const r = db.prepare('SELECT value FROM app_meta WHERE key = ?').get(seenKey(who)) as { value: string } | undefined
  if (!r) return null
  try {
    const v = JSON.parse(r.value) as Seen
    return typeof v.at === 'string' && Array.isArray(v.ids) ? v : null
  } catch {
    return null
  }
}

/** Everything the finders share, computed once per read. */
type Ctx = {
  db: DbLike
  today: string
  year: number
  ty: ReturnType<typeof taxYear>
  roles: Roles
  concentrationMicro: number
  nw: NetWorthPoint | null
  harvest: ReturnType<typeof computeHarvest>
  wagesEntered: boolean
  /** This year's total tax with the inputs changed by `patch`. */
  taxWith: (patch: Partial<TaxInputs>) => number
  /** The tax-timing findings speak up at this much (a Checkup setting). */
  timingThresholdCents: number
  /** The two-year context (engine/twoyear.ts), built on first use from this read's year picture. */
  two: () => TwoYearContext
}

type Draft = Omit<Finding, 'isNew'>

/* ============================ the findings ============================ */

function concentration(c: Ctx): Draft[] {
  const plans = c.db.prepare("SELECT id FROM invest_accounts WHERE stock_plan = 1 AND tracking = 'lots'").all() as { id: number }[]
  if (plans.length === 0 || !c.nw) return []
  const planIds = plans.map((p) => p.id)
  const marks = planIds.map(() => '?').join(',')
  const assets = c.db
    .prepare(
      `SELECT a.id, a.symbol FROM assets a WHERE a.kind = 'stock' AND a.id IN (
         SELECT asset_id FROM trades WHERE invest_account_id IN (${marks})
         UNION SELECT asset_id FROM unvested_positions WHERE invest_account_id IN (${marks}))
       ORDER BY a.symbol`,
    )
    .all(...planIds, ...planIds) as { id: number; symbol: string }[]
  const nw = c.nw
  const liquid = nw.cash + nw.brokerage + nw.retirement + nw.crypto
  const out: Draft[] = []
  for (const a of assets) {
    const price = c.db.prepare('SELECT close_cents, priced_on FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1').get(a.id) as
      | { close_cents: number; priced_on: string }
      | undefined
    let qty = 0
    let value = 0
    const accounts = new Set<string>()
    for (const h of loadHoldings(c.db, c.today, { assetId: a.id })) {
      if (h.pos.qty_micro <= 0) continue
      qty += h.pos.qty_micro
      value += price ? positionValueCents(h.pos.qty_micro, price.close_cents) : h.pos.cost_cents
      accounts.add(h.accountName)
    }
    if (value <= 0 || liquid <= 0) continue
    const ofLiquid = share(value, liquid)
    if (ofLiquid < c.concentrationMicro) continue
    const unvested = (c.db.prepare('SELECT COALESCE(SUM(qty_micro), 0) AS q FROM unvested_positions WHERE asset_id = ?').get(a.id) as { q: number }).q
    const unvestedCents = price && unvested > 0 ? positionValueCents(unvested, price.close_cents) : 0
    const pay = c.db
      .prepare(`SELECT DISTINCT earner, employer FROM pay_sources WHERE invest_account_id IN (${marks}) ORDER BY earner`)
      .all(...planIds) as { earner: string; employer: string }[]
    const earners = [...new Set(pay.map((p) => p.earner))]
    const limit = Math.round((liquid * c.concentrationMicro) / 1_000_000)
    out.push({
      id: `concentration:${a.symbol}`,
      kind: 'concentration',
      tone: 'risk',
      title:
        `${a.symbol} is ${pct(ofLiquid)} of liquid assets` +
        (earners.length ? ` — and ${earners.join(' and ')}'s paycheck${earners.length > 1 ? 's come' : ' comes'} from the same company` : ''),
      impactCents: value - limit,
      impactLabel: `above your ${pct(c.concentrationMicro, 0)} threshold`,
      rule: {
        text: `One employer's stock above ${pct(c.concentrationMicro, 0)} of liquid assets is flagged — more so when a paycheck depends on the same company.`,
        cite: 'Diversification rule of thumb; the threshold is a Checkup setting',
        vintage: `Threshold: ${pct(c.concentrationMicro, 0)} (your setting)`,
      },
      inputs: [
        { label: `${a.symbol} held (${[...accounts].join(', ')})`, value: `${formatQtyMicro(qty)} sh` },
        { label: price ? `Price (${price.priced_on})` : 'Price', value: price ? formatDollars(price.close_cents) : 'none on file — valued at cost' },
        { label: `${a.symbol} value`, value: $(value) },
        { label: 'Liquid assets (cash, brokerage, retirement, crypto)', value: $(liquid) },
        { label: 'Net worth', value: $(nw.total) },
        ...(pay.length ? [{ label: 'Paid by the same company', value: pay.map((p) => (p.employer ? `${p.earner} (${p.employer})` : p.earner)).join(', ') }] : []),
        ...(unvestedCents > 0 ? [{ label: 'Unvested, not counted', value: `${formatQtyMicro(unvested)} sh ≈ ${$(unvestedCents)}` }] : []),
      ],
      math: [
        `${$(value)} ÷ ${$(liquid)} liquid = ${pct(ofLiquid)}`,
        `${$(value)} ÷ ${$(nw.total)} net worth = ${pct(share(value, nw.total))}`,
        `${$(value)} − ${pct(c.concentrationMicro, 0)} × ${$(liquid)} = ${$(value - limit)} above the threshold`,
      ],
      leavesOut: [
        ...(unvestedCents > 0 ? [`Unvested shares (≈${$(unvestedCents)} at today's price) are future pay, not assets — they add to the exposure when they vest.`] : []),
        'Funds that hold the company are not looked through.',
        'The tax cost of selling — the lot picker on Investments shows it per lot.',
      ],
      action: { label: 'See the holdings', to: { screen: 'invest' } },
    })
  }
  return out
}

/**
 * Cash on hand today: every bank account, plus the cash in brokerage accounts
 * that record it, less what the credit cards owe (their bills come out of it).
 */
function cashOnHand(db: DbLike, today: string) {
  const accounts = db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.posted_on <= ?), 0) AS cents
       FROM accounts a ORDER BY a.id`,
    )
    .all(today) as { id: number; name: string; kind: string; cents: number }[]
  const banks = accounts.filter((a) => a.kind !== 'credit')
  const cardCents = accounts.filter((a) => a.kind === 'credit').reduce((s, a) => s + a.cents, 0)
  let brokerage = 0
  const anchored = db
    .prepare("SELECT DISTINCT ia.id FROM invest_accounts ia JOIN balance_snapshots s ON s.invest_account_id = ia.id WHERE ia.tracking = 'lots'")
    .all() as { id: number }[]
  for (const ia of anchored) {
    const anchors = db.prepare('SELECT balanced_on, balance_cents FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on').all(ia.id) as {
      balanced_on: string
      balance_cents: number
    }[]
    const trades = db
      .prepare('SELECT traded_on, side, total_cents, acquired_on, note FROM trades WHERE invest_account_id = ? ORDER BY traded_on, id')
      .all(ia.id) as CashTrade[]
    brokerage += cashAt(anchors, trades, today)?.cents ?? 0
  }
  return { banks, bankCents: banks.reduce((s, b) => s + b.cents, 0), cardCents, brokerageCents: brokerage }
}

function runway(c: Ctx): Draft[] {
  const month = c.today.slice(0, 7)
  const months = cashflowByMonth(c.db).filter((m) => m.month < month && m.month >= addMonthsToMonth(month, -12))
  if (months.length < RUNWAY_MIN_HISTORY) return []
  const spent = months.reduce((s, m) => s + m.spend_cents, 0)
  const avg = Math.round(spent / months.length)
  if (avg <= 0) return []
  const cash = cashOnHand(c.db, c.today)
  const total = cash.bankCents + cash.cardCents + cash.brokerageCents
  const covered = total / avg
  const window = `${months[0]!.month} – ${months[months.length - 1]!.month}`
  const baseInputs = [
    { label: 'Bank accounts', value: $(cash.bankCents) },
    ...(cash.cardCents !== 0 ? [{ label: 'Less credit card balances', value: $(cash.cardCents) }] : []),
    ...(cash.brokerageCents !== 0 ? [{ label: 'Cash in brokerage accounts', value: $(cash.brokerageCents) }] : []),
    { label: `Average monthly spending (${months.length} month${months.length > 1 ? 's' : ''}, ${window})`, value: $(avg) },
  ]
  const cite = 'Emergency-fund guideline: 3–6 months of expenses; the 3- and 12-month lines are Checkup defaults'
  const vintage = `Thresholds: ${RUNWAY_LOW_MONTHS} and ${RUNWAY_IDLE_MONTHS} months`
  const action = { label: 'See spending', to: { screen: 'cash' } }

  if (covered < RUNWAY_LOW_MONTHS) {
    const need = RUNWAY_LOW_MONTHS * avg - total
    return [
      {
        id: 'runway-low',
        kind: 'runway-low',
        tone: 'risk',
        title: `Cash covers ${covered.toFixed(1)} months of spending`,
        impactCents: need,
        impactLabel: `short of ${RUNWAY_LOW_MONTHS} months`,
        rule: { text: `Cash under ${RUNWAY_LOW_MONTHS} months of average spending is flagged.`, cite, vintage },
        inputs: baseInputs,
        math: [`${$(total)} ÷ ${$(avg)} a month = ${covered.toFixed(1)} months`, `${RUNWAY_LOW_MONTHS} × ${$(avg)} − ${$(total)} = ${$(need)} short`],
        leavesOut: [
          'Money-market and T-bill funds held as positions count as investments here, not cash.',
          'Credit available, unvested pay and the paychecks still to come.',
          'Spending is the trailing average — a large planned expense is not in it.',
        ],
        action,
      },
    ]
  }
  // Cash set aside for the Dream Home is spoken for: it isn't idle.
  const goal = c.db.prepare("SELECT value FROM goal_settings WHERE key = 'goal'").get() as { value: string } | undefined
  let fundIds: number[] = []
  try {
    const ids = goal ? (JSON.parse(goal.value) as { fundAccountIds?: unknown }).fundAccountIds : undefined
    if (Array.isArray(ids)) fundIds = ids.filter((x): x is number => Number.isSafeInteger(x))
  } catch { /* unreadable goal — nothing earmarked */ }
  const earmarked = cash.banks.filter((b) => fundIds.includes(b.id)).reduce((s, b) => s + b.cents, 0)
  const free = total - earmarked
  const excess = free - RUNWAY_IDLE_MONTHS * avg
  if (excess <= 0) return []
  return [
    {
      id: 'idle-cash',
      kind: 'idle-cash',
      tone: 'heads-up',
      title: `${$(excess)} in cash beyond a year of spending`,
      impactCents: excess,
      impactLabel: `over ${RUNWAY_IDLE_MONTHS} months of spending`,
      rule: { text: `Cash beyond ${RUNWAY_IDLE_MONTHS} months of average spending, not set aside for a goal, is flagged.`, cite, vintage },
      inputs: [...baseInputs, ...(earmarked > 0 ? [{ label: 'Set aside for the Dream Home (not counted)', value: $(earmarked) }] : [])],
      math: [
        `${$(total)}${earmarked > 0 ? ` − ${$(earmarked)} set aside` : ''} = ${$(free)} = ${(free / avg).toFixed(1)} months`,
        `${$(free)} − ${RUNWAY_IDLE_MONTHS} × ${$(avg)} = ${$(excess)} beyond a year`,
      ],
      leavesOut: [
        'What the cash earns — a high-yield account may already be the right home for it.',
        'Plans other than the Dream Home goal (a car, tuition, a tax bill).',
        'Spending is the trailing average — a large planned expense is not in it.',
      ],
      action,
    },
  ]
}

function itemize(c: Ctx): Draft[] {
  const { out, inputs } = c.ty
  const it = out.itemized
  const std = out.incomes.standardDeductionCents
  const source = out.incomes.deductionSource
  const current = inputs.deductionCents
  const taxStd = c.taxWith({ deductionCents: std })
  const lines = [
    ...it.loans.map((l) => ({ label: `Interest: ${l.name} (${pct(l.rateMicro, 3)} on ≈${$(l.avgBalanceCents)})`, value: $(l.interestCents) })),
    ...(it.mortgageDeductibleCents < it.mortgageInterestCents
      ? [{ label: `Interest on the first ${$(it.mortgageDebtLimitCents)} of debt`, value: $(it.mortgageDeductibleCents) }]
      : []),
    { label: 'State income tax (this year’s estimate)', value: $(it.stateIncomeTaxCents) },
    { label: it.roles.propertyTax ? `Property tax (${it.roles.propertyTax.name}, last 12 months)` : 'Property tax (no category)', value: $(it.propertyTaxCents) },
    { label: `SALT cap at your income`, value: $(it.saltCapCents) },
    { label: it.roles.charity ? `Giving (${it.roles.charity.name}, last 12 months)` : 'Giving (no category)', value: $(it.charityCents) },
    { label: 'Itemized total', value: $(it.totalCents) },
    { label: 'Standard deduction', value: $(std) },
  ]
  const avgDebt = it.loans.reduce((s, l) => s + l.avgBalanceCents, 0)
  const math = [
    it.mortgageDeductibleCents < it.mortgageInterestCents
      ? `Mortgage interest: ${$(it.mortgageInterestCents)} × ${$(it.mortgageDebtLimitCents)} ÷ ${$(avgDebt)} of debt = ${$(it.mortgageDeductibleCents)}`
      : `Mortgage interest: ${$(it.mortgageDeductibleCents)}`,
    `SALT: min(${$(it.stateIncomeTaxCents)} + ${$(it.propertyTaxCents)}, ${$(it.saltCapCents)}) = ${$(it.saltCents)}`,
    `Giving: max(0, ${$(it.charityCents)} − ${pct(CHARITY_AGI_FLOOR_MICRO, 1)} × ${$(out.incomes.totalIncomeCents)}) = ${$(it.charityDeductibleCents)}`,
    `Itemized: ${$(it.mortgageDeductibleCents)} + ${$(it.saltCents)} + ${$(it.charityDeductibleCents)} = ${$(it.totalCents)}`,
  ]
  const rule = {
    text: 'Deduct whichever is larger: the standard deduction, or the itemized total.',
    cite: 'IRC §63, §163(h)(3), §164(b)(7), §170(b)(1)(I)',
    vintage: `${ITEMIZE_VINTAGE} · ${TAX_DATA_VINTAGE}`,
  }
  const leavesOut = [
    'Property tax paid from a mortgage escrow account isn’t in the ledger unless a category holds it.',
    'Interest is estimated from the recorded balances, held flat between entries — Form 1098 is the real figure.',
    'Medical costs over 7.5% of income, investment interest, and the cap on itemized deductions in the 37% bracket.',
    ...(it.unratedLoans.length ? [`Loans without a rate: ${it.unratedLoans.join(', ')}.`] : []),
  ]
  const action = { label: 'Deduction setting', to: { screen: 'tax', rest: ['settings'] } }
  if (source === 'standard' && it.totalCents > std) {
    const saved = taxStd - c.taxWith({ deductionCents: it.totalCents })
    if (saved <= 0) return []
    return [
      {
        id: 'itemize:itemize',
        kind: 'itemize',
        tone: 'saving',
        title: `Itemizing would deduct ${$(it.totalCents - std)} more than the standard deduction`,
        impactCents: saved,
        impactLabel: 'tax saved this year',
        rule,
        inputs: lines,
        math: [...math, `Tax with the standard deduction − tax itemizing = ${$(saved)}`],
        leavesOut,
        action,
      },
    ]
  }
  if (source !== 'standard' && current < std) {
    const saved = c.taxWith({ deductionCents: current }) - taxStd
    if (saved <= 0) return []
    return [
      {
        id: 'itemize:standard',
        kind: 'itemize',
        tone: 'saving',
        title: `The standard deduction is ${$(std - current)} more than your itemized total`,
        impactCents: saved,
        impactLabel: 'tax saved this year',
        rule,
        inputs: source === 'typed' ? [...lines, { label: 'Itemized total you typed (used instead)', value: $(current) }] : lines,
        math: [...math, `Tax itemizing ${$(current)} − tax with the standard deduction = ${$(saved)}`],
        leavesOut,
        action,
      },
    ]
  }
  return []
}

const isCrypto = (c: Ctx, symbol: string) =>
  !!c.db.prepare("SELECT 1 FROM assets WHERE symbol = ? AND kind = 'crypto'").get(symbol)

/** Long-term lots with a gain, in taxable accounts, at today's prices. */
const ltGainLots = (c: Ctx): HarvestLot[] => c.harvest.rows.filter((r) => r.term === 'lt' && r.gain_cents > 0 && r.value_cents > 0)

function giveShares(c: Ctx): Draft[] {
  const role = c.roles.charity
  if (!role) return []
  const it = c.ty.out.itemized
  const giving = it.charityCents
  if (giving <= 0) return []
  // The most gain per dollar given first: it is the gain that never gets taxed.
  const lots = ltGainLots(c).sort((x, y) => y.gain_cents * x.value_cents - x.gain_cents * y.value_cents)
  if (lots.length === 0) return []
  let left = giving
  let gainAvoided = 0
  const used: { lot: HarvestLot; cents: number; gain: number }[] = []
  for (const lot of lots) {
    if (left <= 0) break
    const cents = Math.min(left, lot.value_cents)
    const gain = Math.round((lot.gain_cents * cents) / lot.value_cents)
    used.push({ lot, cents, gain })
    gainAvoided += gain
    left -= cents
  }
  const base = c.taxWith({})
  const saved = c.taxWith({ ltGainCents: c.ty.inputs.ltGainCents + gainAvoided }) - base
  if (saved <= 0) return []
  const top = used[0]!.lot
  return [
    {
      id: `give-shares:${top.symbol}`,
      kind: 'give-shares',
      tone: 'saving',
      title: `Giving appreciated ${top.symbol} instead of cash avoids ≈${$(saved)} of tax`,
      impactCents: saved,
      impactLabel: 'tax never owed',
      rule: {
        text: 'Shares held over a year, given to a qualified charity, deduct at market value and their gain is never taxed; give the lots with the most gain per dollar.',
        cite: 'IRC §170(e)(1), §170(b)(1)(C)',
        vintage: TAX_DATA_VINTAGE,
      },
      inputs: [
        { label: `Giving (${role.name}, last 12 months)`, value: $(giving) },
        ...used.map((u) => ({
          label: `${u.lot.symbol} lot of ${u.lot.opened_on} in ${u.lot.account} (${pct(share(u.lot.gain_cents, u.lot.value_cents), 0)} gain)`,
          value: `${$(u.cents)} of ${$(u.lot.value_cents)}`,
        })),
      ],
      math: [
        ...used.map((u) => `${$(u.cents)} × ${pct(share(u.lot.gain_cents, u.lot.value_cents), 0)} gain = ${$(u.gain)}`),
        `Tax on ${$(gainAvoided)} more long-term gain this year = ${$(saved)}`,
      ],
      leavesOut: [
        'Only gifts to qualified charities and donor-advised funds; not every charity takes stock.',
        'The cash kept would rebuy the shares at a fresh, higher basis — the saving shows up when they are sold.',
        'Gifts of appreciated stock deduct up to 30% of income a year (the excess carries forward).',
        ...(used.some((u) => isCrypto(c, u.lot.symbol))
          ? ['Crypto gifts over $5,000 need a qualified appraisal to deduct at market value.']
          : []),
      ],
      action: { label: 'See the lots', to: { screen: 'invest' } },
    },
  ]
}

function headroom(c: Ctx): BracketHeadroom {
  const { out } = c.ty
  const filing = out.settings.filingStatus
  const brackets = FEDERAL_BRACKETS_2026[filing]
  const ord = out.tax.taxableOrdinaryCents
  let idx = brackets.findIndex((b) => b.upToCents === null || ord < b.upToCents)
  if (idx < 0) idx = brackets.length - 1
  const top = brackets[idx]!.upToCents
  const [t0, t15] = FEDERAL_LT_THRESHOLDS_2026[filing]
  const end = ord + out.tax.taxableLtCents
  return {
    year: out.year,
    filing,
    wagesEntered: c.wagesEntered,
    ordinaryTaxableCents: ord,
    brackets,
    bracketIndex: idx,
    roomCents: top === null ? null : top - ord,
    ltTaxableCents: out.tax.taxableLtCents,
    lt0TopCents: t0,
    lt15TopCents: t15,
    lt0RoomCents: Math.max(0, t0 - end),
    lt15RoomCents: Math.max(0, t15 - end),
    vintage: TAX_DATA_VINTAGE,
  }
}

function gainHarvest(c: Ctx, h: BracketHeadroom): Draft[] {
  if (!c.wagesEntered || h.lt0RoomCents <= 0) return []
  const lots = ltGainLots(c).sort((x, y) => y.gain_cents - x.gain_cents)
  if (lots.length === 0) return []
  let room = h.lt0RoomCents
  const picks: { lot: HarvestLot; gain: number }[] = []
  for (const lot of lots) {
    if (room <= 0) break
    const gain = Math.min(room, lot.gain_cents)
    picks.push({ lot, gain })
    room -= gain
  }
  const gain = picks.reduce((s, p) => s + p.gain, 0)
  const nowTax = c.taxWith({ ltGainCents: c.ty.inputs.ltGainCents + gain }) - c.taxWith({})
  const later = Math.round((gain * LATER_LT_MICRO) / 1_000_000)
  const net = later - nowTax
  if (net <= 0) return []
  return [
    {
      id: 'gain-harvest',
      kind: 'gain-harvest',
      tone: 'saving',
      title: `${$(gain)} of long-term gains fit in this year’s 0% federal band`,
      impactCents: net,
      impactLabel: 'future federal tax avoided, net of tax now',
      rule: {
        text: 'Long-term gains that stack under the top of the 0% band are taxed at 0% federally; realizing them resets the basis higher.',
        cite: 'IRC §1(h)(1); thresholds per Rev. Proc. 2025-32',
        vintage: TAX_DATA_VINTAGE,
      },
      inputs: [
        { label: 'Ordinary taxable income', value: $(h.ordinaryTaxableCents) },
        { label: 'Long-term gains & qualified dividends already this year', value: $(h.ltTaxableCents) },
        { label: 'Top of the 0% band', value: $(h.lt0TopCents) },
        ...picks.map((p) => ({ label: `${p.lot.symbol} lot of ${p.lot.opened_on} in ${p.lot.account}`, value: `${$(p.gain)} of ${$(p.lot.gain_cents)} gain` })),
      ],
      math: [
        `${$(h.lt0TopCents)} − ${$(h.ordinaryTaxableCents)} − ${$(h.ltTaxableCents)} = ${$(h.lt0RoomCents)} of room`,
        `Tax now on ${$(gain)} (state, and anything else it touches) = ${$(nowTax)}`,
        `${$(gain)} × ${pct(LATER_LT_MICRO, 0)} federal later − ${$(nowTax)} now = ${$(net)}`,
      ],
      leavesOut: [
        'Assumes the gain would otherwise meet the 15% federal rate later; in another 0% year it would cost nothing either way.',
        'Income still to come this year (a bonus, a vest, a sale) shrinks the band.',
        'Selling and buying back restarts the holding period on the new lot.',
        'Income-tested benefits (ACA premium credits, FAFSA) that a higher AGI can cost.',
      ],
      action: { label: 'See the lots', to: { screen: 'invest' } },
    },
  ]
}

function lossHarvest(c: Ctx): Draft[] {
  const lots = c.harvest.rows.filter((r) => r.gain_cents < 0 && !r.wash_risk && r.wash_upcoming === null)
  if (lots.length === 0) return []
  const st = lots.filter((r) => r.term === 'st').reduce((s, r) => s + r.gain_cents, 0)
  const lt = lots.filter((r) => r.term === 'lt').reduce((s, r) => s + r.gain_cents, 0)
  const saved = c.taxWith({}) - c.taxWith({ stGainCents: c.ty.inputs.stGainCents + st, ltGainCents: c.ty.inputs.ltGainCents + lt })
  if (saved <= 0) return []
  const flagged = c.harvest.totals.washFlagged
  return [
    {
      id: 'loss-harvest',
      kind: 'loss-harvest',
      tone: 'saving',
      title: `${$(-(st + lt))} of losses could be realized this year`,
      impactCents: saved,
      impactLabel: 'tax saved this year',
      rule: {
        text: 'Realized losses net against gains, then up to $3,000 of ordinary income; the rest carries forward.',
        cite: 'IRC §1211(b), §1212(b), §1091 (wash sales)',
        vintage: TAX_DATA_VINTAGE,
      },
      inputs: [
        { label: `Loss lots in taxable accounts (${lots.length})`, value: $(st + lt) },
        { label: 'Short-term', value: $(st) },
        { label: 'Long-term', value: $(lt) },
        { label: 'Gains already realized this year (ST / LT)', value: `${$(c.ty.inputs.stGainCents)} / ${$(c.ty.inputs.ltGainCents)}` },
        ...(flagged > 0 ? [{ label: 'Lots left out for a wash-sale risk', value: String(flagged) }] : []),
      ],
      math: [`Tax this year − tax with ${$(st)} short-term and ${$(lt)} long-term more = ${$(saved)}`],
      leavesOut: [
        'The carryforward’s value in later years.',
        'Buying the same or a substantially identical security within 30 days — in any account, either spouse’s — disallows the loss.',
        'What to hold instead to stay invested.',
      ],
      action: { label: 'See the harvest table', to: { screen: 'tax', rest: ['harvest'] } },
    },
  ]
}

function safeHarbor(c: Ctx): Draft[] {
  const { out } = c.ty
  const out2: Draft[] = []
  const one = (who: 'fed' | 'state', sh: NonNullable<typeof out.stateSafeHarbor>, name: string) => {
    if (sh.remainingCents <= 0) return
    const next = sh.quarters.find((q) => !q.past && q.cents > 0)
    out2.push({
      id: `safe-harbor:${who}`,
      kind: 'safe-harbor',
      tone: 'risk',
      title: `${$(sh.remainingCents)} of ${name} estimated tax still needed to stay in the safe harbor`,
      impactCents: sh.remainingCents,
      impactLabel: 'still to pay',
      rule: {
        text:
          'Pay in at least the smaller of 90% of this year’s tax and 100% of last year’s (110% after a prior-year income over $150,000), through withholding and on-time installments, and no underpayment penalty applies.' +
          (sh.priorYearHarborAvailable ? '' : ' At this year’s income the prior-year route isn’t available.'),
        cite: who === 'fed' ? 'IRC §6654(d); Form 1040-ES' : sh.rule,
        vintage: `${TAX_DATA_VINTAGE}${sh.assumed ? ' · state schedule assumed federal-style' : ''}`,
      },
      inputs: [
        { label: `Required (${sh.basis})`, value: $(sh.requiredCents) },
        { label: 'Withheld and paid so far (projected to Dec 31)', value: $(sh.paidCents) },
        ...(next ? [{ label: `Next due ${next.due}`, value: $(next.cents) }] : []),
      ],
      math: [`${$(sh.requiredCents)} − ${$(sh.paidCents)} = ${$(sh.remainingCents)}`],
      leavesOut: [
        'The penalty is interest on each late installment, not a share of the whole gap.',
        'The annualized-income method (Form 2210 Schedule AI) when income arrived late in the year.',
        'Withholding counts as paid evenly through the year, whenever it happened.',
      ],
      action: { label: 'See the schedule', to: { screen: 'tax', rest: ['safe-harbor'] } },
    })
  }
  one('fed', out.safeHarbor, 'federal')
  if (out.stateSafeHarbor) {
    one('state', out.stateSafeHarbor, STATES.find((x) => x.code === out.settings.state)?.name ?? out.settings.state)
  }
  return out2
}

function addlMedicare(c: Ctx): Draft[] {
  const { out } = c.ty
  const p = out.payroll
  if (p.sources.length === 0) return []
  const gap = out.tax.addlMedicareCents - p.addlMedicareWithheldCents
  if (gap <= 0) return []
  const threshold = ADDL_MEDICARE_THRESHOLD[out.settings.filingStatus]
  return [
    {
      id: 'addl-medicare',
      kind: 'addl-medicare',
      tone: 'heads-up',
      title: `Additional Medicare Tax: ${$(gap)} not withheld`,
      impactCents: gap,
      impactLabel: 'owed at filing',
      rule: {
        text: '0.9% on household Medicare wages over the filing-status threshold; employers withhold it only above $200,000 per employee.',
        cite: 'IRC §3101(b)(2), §3102(f); Form 8959',
        vintage: PAYROLL_VINTAGE,
      },
      inputs: [
        { label: 'Household Medicare wages (paychecks + stock comp)', value: $(p.ficaWagesCents) },
        { label: 'Threshold for your filing status', value: $(threshold) },
        { label: 'Withheld by employers', value: $(p.addlMedicareWithheldCents) },
      ],
      math: [
        `(${$(p.ficaWagesCents)} − ${$(threshold)}) × 0.9% = ${$(out.tax.addlMedicareCents)}`,
        `${$(out.tax.addlMedicareCents)} − ${$(p.addlMedicareWithheldCents)} withheld = ${$(gap)}`,
      ],
      leavesOut: ['It is already part of the federal gap and the safe-harbor figure — not extra on top of them.'],
      action: { label: 'See the paychecks', to: { screen: 'tax', rest: ['paychecks'] } },
    },
  ]
}

const CLASS_LABEL: Record<string, string> = { cash: 'Cash', brokerage: 'Brokerage', retirement: 'Retirement', crypto: 'Crypto', property: 'Property' }

/** Off the household's target allocation (engine/allocation.ts), with the plan that closes it. */
function offTarget(c: Ctx): Draft[] {
  const a = getAllocation(c.db, c.today)
  const off = a.rows.filter((r) => r.targetMicro !== null && Math.abs(r.driftMicro!) >= DRIFT_MICRO)
  if (off.length === 0 || !a.plan) return []
  const worst = off.reduce((m, r) => (Math.abs(r.driftMicro!) > Math.abs(m.driftMicro!) ? r : m))
  const toMove = a.rows.reduce((s, r) => s + Math.max(0, -(r.toTargetCents ?? 0)), 0)
  const p = a.plan
  const by = (step: string) => p.steps.filter((x) => x.step === step && x.action === (step === 'contribute' ? 'buy' : 'sell')).reduce((s, x) => s + x.cents, 0)
  return [
    {
      id: `allocation-target:${off.map((r) => `${r.cls}${r.driftMicro! > 0 ? '+' : '-'}`).join(',')}`,
      kind: 'allocation-drift',
      tone: 'heads-up',
      title: `${worst.label} is ${pct(worst.shareMicro)} of what's invested — target ${pct(worst.targetMicro!)}`,
      impactCents: toMove,
      impactLabel: 'above target, to move',
      rule: {
        text: `A class ${DRIFT_MICRO / 10_000} or more percentage points off its target is flagged; the plan closes it with new contributions first, then trades inside sheltered accounts, then taxable sales with the least gain.`,
        cite: 'Your target allocation (Investments)',
        vintage: TAX_DATA_VINTAGE,
      },
      inputs: off.map((r) => ({ label: r.label, value: `${pct(r.shareMicro)} vs ${pct(r.targetMicro!)} target` })),
      math: [
        `Above target in total: ${$(toMove)} of ${$(a.totalCents)}`,
        `A year of contributions into the underweight: ${$(by('contribute'))} · trades inside sheltered accounts: ${$(by('sheltered'))} · taxable sales: ${$(by('taxable'))}`,
        `Taxable gain realized ${$(p.taxable.stGainCents + p.taxable.ltGainCents)} → tax ${$(p.taxable.taxCents)}`,
      ],
      leavesOut: [
        'Funds inside a balance-tracked account (a 401(k) known by its total) are one class each — set it on Investments.',
        'Trading costs, and whether each account offers the funds the plan buys.',
        'Waiting: next year’s contributions can close more of it without a sale.',
      ],
      action: { label: 'See the rebalance plan', to: { screen: 'invest', rest: ['allocation'] } },
    },
  ]
}

/** Asset location: bonds where their income is taxed every year, or in Roth where growth is worth most. */
function assetLocation(c: Ctx): Draft[] {
  const a = getAllocation(c.db, c.today, { plan: false })
  const sum = (pred: (s: (typeof a.slices)[number]) => boolean) => a.slices.filter(pred).reduce((s, x) => s + x.cents, 0)
  const stocks = (s: (typeof a.slices)[number]) => s.cls === 'us_stock' || s.cls === 'intl_stock'
  const bondsTaxable = sum((s) => s.cls === 'bonds' && s.bucket === 'taxable' && !s.muni)
  const bondsRoth = sum((s) => s.cls === 'bonds' && s.bucket === 'roth')
  const stockTrad = sum((s) => stocks(s) && s.bucket === 'traditional')
  const stockTaxable = sum((s) => stocks(s) && s.bucket === 'taxable')
  const swapTaxable = Math.min(bondsTaxable, stockTrad)
  const swapRoth = Math.min(bondsRoth, stockTrad + stockTaxable)
  if (swapTaxable <= 0 && swapRoth <= 0) return []
  const parts = [
    swapTaxable > 0 ? `${$(bondsTaxable)} of bonds sit in taxable while traditional accounts hold ${$(stockTrad)} of stock` : null,
    swapRoth > 0 ? `${$(bondsRoth)} of bonds sit in Roth while ${$(stockTrad + stockTaxable)} of stock sits elsewhere` : null,
  ].filter(Boolean) as string[]
  return [
    {
      id: `asset-location:${swapTaxable > 0 ? 't' : ''}${swapRoth > 0 ? 'r' : ''}`,
      kind: 'asset-location',
      tone: 'heads-up',
      title: parts.join('; '),
      impactCents: 0,
      impactLabel: 'unpriced — depends on yields',
      rule: {
        text: 'The same mix can be held in different accounts: bonds’ interest is taxed as ordinary income each year, so they usually sit best in traditional accounts; the highest expected growth in Roth, where it is never taxed; broad index stock in taxable, where gains wait and qualify for the lower rates.',
        cite: 'Asset location — a rule of thumb, not a law',
        vintage: 'Classes as set or guessed on Investments',
      },
      inputs: [
        { label: 'Bonds in taxable', value: $(bondsTaxable) },
        { label: 'Bonds in Roth', value: $(bondsRoth) },
        { label: 'Stock in traditional', value: $(stockTrad) },
        { label: 'Stock in taxable', value: $(stockTaxable) },
      ],
      math: [
        ...(swapTaxable > 0 ? [`Swappable without changing the mix: min(${$(bondsTaxable)}, ${$(stockTrad)}) = ${$(swapTaxable)}`] : []),
        ...(swapRoth > 0 ? [`Swappable into Roth growth: min(${$(bondsRoth)}, ${$(stockTrad + stockTaxable)}) = ${$(swapRoth)}`] : []),
      ],
      leavesOut: [
        'Selling stock in taxable to make room realizes its gain — the swap is cheapest done with new money or inside sheltered accounts.',
        'Municipal bonds, whose interest is already federally tax-free, belong in taxable.',
        'What each account’s plan offers.',
      ],
      action: { label: 'See the allocation', to: { screen: 'invest', rest: ['allocation'] } },
    },
  ]
}

function allocationDrift(c: Ctx): Draft[] {
  if (getTarget(c.db)) return offTarget(c)
  if (!c.nw) return []
  const month = c.today.slice(0, 7)
  const baseMonth = addMonthsToMonth(month, -DRIFT_MONTHS)
  // Only what Scarab already knew at the baseline: an account entered since is new data, not drift.
  const comparable = netWorthSeries(c.db, c.today, { knownBy: `${baseMonth}-99` })
  const base = comparable.find((p) => p.month === baseMonth)
  const cur = comparable[comparable.length - 1]
  if (!base || !cur || cur.month !== month) return []
  const rows = allocationShift(base, cur)
  if (rows.length === 0) return []
  const assets = cur.cash + cur.brokerage + cur.retirement + cur.crypto + cur.property
  const biggest = rows.reduce((m, r) => (Math.abs(r.deltaMicro) > Math.abs(m.deltaMicro) ? r : m))
  return [
    {
      id: `allocation-drift:${rows.map((r) => `${r.name}${r.deltaMicro > 0 ? '+' : '-'}`).join(',')}`,
      kind: 'allocation-drift',
      tone: 'heads-up',
      title: `${CLASS_LABEL[biggest.name] ?? biggest.name} went from ${pct(biggest.thenMicro)} to ${pct(biggest.nowMicro)} of assets in ${DRIFT_MONTHS} months`,
      // No target to measure against yet (target allocation, §4d), so nothing here is a dollar at stake.
      impactCents: 0,
      impactLabel: 'unpriced until there is a target',
      rule: {
        text: `An asset class whose share of everything owned moved ${DRIFT_MICRO / 10_000} percentage points or more over ${DRIFT_MONTHS} months is flagged.`,
        cite: 'Checkup rule — there is no target allocation yet, so this says only that it moved',
        vintage: `Window: ${baseMonth} → ${month}`,
      },
      inputs: rows.map((r) => ({ label: CLASS_LABEL[r.name] ?? r.name, value: `${pct(r.thenMicro)} → ${pct(r.nowMicro)}` })),
      math: rows.map((r) => `${CLASS_LABEL[r.name] ?? r.name}: ${pct(r.nowMicro)} − ${pct(r.thenMicro)} = ${r.deltaMicro > 0 ? '+' : '−'}${pct(Math.abs(r.deltaMicro))} (≈${$(Math.round((Math.abs(r.deltaMicro) * assets) / 1_000_000))} of ${$(assets)})`),
      leavesOut: ['Market moves and new money count alike.', 'Debts — this is shares of what is owned.', 'A target to drift from (it arrives with target allocation).'],
      action: { label: 'See net worth', to: { screen: 'dash' } },
    },
  ]
}

const PER_YEAR: Record<Cadence, number> = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, yearly: 1 }

function priceCreep(c: Ctx): Draft[] {
  const creep = detectRecurring(c.db, c.today).filter((r) => r.kind === 'expense' && r.priceCreepMicro > 0 && !r.lapsed)
  if (creep.length === 0) return []
  const rows = creep.map((r) => ({ r, yearly: (r.lastCents - r.typicalCents) * PER_YEAR[r.cadence] })).sort((a, b) => b.yearly - a.yearly)
  const total = rows.reduce((s, x) => s + x.yearly, 0)
  return [
    {
      id: `price-creep:${rows.map((x) => x.r.merchant).sort().join('|')}`,
      kind: 'price-creep',
      tone: 'heads-up',
      title: `${rows.length} recurring charge${rows.length > 1 ? 's' : ''} went up — ${$(total)} a year more`,
      impactCents: total,
      impactLabel: 'more a year',
      rule: { text: 'A recurring charge whose latest amount is 10% or more above its typical one is flagged.', cite: 'Checkup rule (recurring-charge detection)', vintage: 'Threshold: 10%' },
      inputs: rows.map((x) => ({ label: `${x.r.merchant} (${x.r.cadence})`, value: `${$(x.r.typicalCents)} → ${$(x.r.lastCents)}` })),
      math: rows.map((x) => `${x.r.merchant}: (${$(x.r.lastCents)} − ${$(x.r.typicalCents)}) × ${PER_YEAR[x.r.cadence]} = ${$(x.yearly)}`),
      leavesOut: ['A one-off larger charge (an extra item, a late fee) looks the same as a price rise.', 'Charges that moved to a new merchant name.'],
      action: { label: 'See recurring charges', to: { screen: 'cash' } },
    },
  ]
}

function mortgageRate(c: Ctx): Draft[] {
  const raw = c.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(PMMS_KEY) as { value: string } | undefined
  if (!raw) return []
  let pmms: { on: string; rateMicro: number }
  try {
    pmms = JSON.parse(raw.value) as { on: string; rateMicro: number }
  } catch {
    return []
  }
  const best = c.db.prepare('SELECT name, rate_micro FROM loan_options ORDER BY rate_micro ASC LIMIT 1').get() as { name: string; rate_micro: number } | undefined
  if (!best || !(pmms.rateMicro > 0) || pmms.rateMicro > best.rate_micro - MORTGAGE_TRIGGER_MICRO) return []
  const goal = c.db.prepare("SELECT value FROM goal_settings WHERE key = 'goal'").get() as { value: string } | undefined
  let loan = 0
  try {
    const g = goal ? (JSON.parse(goal.value) as { targetPriceCents?: number; downPctMicro?: number }) : {}
    const price = Number.isSafeInteger(g.targetPriceCents) ? g.targetPriceCents! : 0
    const down = Number.isSafeInteger(g.downPctMicro) ? g.downPctMicro! : 200_000
    loan = Math.round((price * (1_000_000 - down)) / 1_000_000)
  } catch { /* no goal — unpriced */ }
  const yearly = Math.round((loan * (best.rate_micro - pmms.rateMicro)) / 1_000_000)
  return [
    {
      id: `mortgage-rate:${best.name}`,
      kind: 'mortgage-rate',
      tone: 'heads-up',
      title: `The 30-year average (${pct(pmms.rateMicro, 2)}) is below your best saved loan option (${pct(best.rate_micro, 3)})`,
      impactCents: Math.max(0, yearly),
      impactLabel: 'a year of interest, first year',
      rule: {
        text: 'The weekly market average at least 0.25 points under the best saved loan option is flagged.',
        cite: 'Freddie Mac Primary Mortgage Market Survey (30-year fixed)',
        vintage: `Market rate as of ${pmms.on}`,
      },
      inputs: [
        { label: 'Market average (30-year fixed)', value: pct(pmms.rateMicro, 2) },
        { label: `Best saved option: ${best.name}`, value: pct(best.rate_micro, 3) },
        ...(loan > 0 ? [{ label: 'Dream Home loan (price less down payment)', value: $(loan) }] : []),
      ],
      math: loan > 0 ? [`${$(loan)} × (${pct(best.rate_micro, 3)} − ${pct(pmms.rateMicro, 2)}) = ${$(yearly)} a year`] : ['No Dream Home price set — the difference is unpriced.'],
      leavesOut: ['The average is not a quote for your credit, loan size or points.', 'Interest falls as the loan amortizes — this is the first year.'],
      action: { label: 'Compare the loan sheets', to: { screen: 'goal', rest: ['loans'] } },
    },
  ]
}

/* ============================ tax timing ============================ */

const dayYear = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const signed = (cents: number) => formatDollars(cents, { sign: true })

/** How a planned sale's day stands: what made the room, as one sum. */
function roomLine(v: SaleCoverage): string {
  const on = v.sale.planned_on
  const parts: string[] = []
  const add = (cents: number, what: string) => {
    if (cents === 0) return
    parts.push(parts.length === 0 ? `${cents < 0 ? '−' : ''}${$(Math.abs(cents))} ${what}` : `${cents < 0 ? '−' : '+'} ${$(Math.abs(cents))} ${what}`)
  }
  add(v.carryInCents, 'carried in')
  add(v.forecastByCents, `the forecast expects by ${on}`)
  add(-v.realizedCents, v.realizedCents < 0 ? 'of losses realized so far' : 'of gains realized so far')
  add(-v.earlierCents, v.earlierCents < 0 ? 'of planned losses before it' : 'of planned gains before it')
  const room = -v.netBeforeCents
  return `Room on ${on}: ${parts.length ? parts.join(' ') : 'nothing'} = ${room >= 0 ? $(room) : `none — gains already ${$(-room)} ahead`}`
}

/** A planned sale the losses expected by its day don't cover (engine/capacity.ts saleCoverage). */
function saleUncovered(c: Ctx): Draft[] {
  if (!c.db.prepare('SELECT 1 FROM planned_sales LIMIT 1').get()) return []
  const out: Draft[] = []
  for (const v of saleCoverage(c.db, c.today, c.two())) {
    if (v.uncoveredCents <= 0 || v.taxByThenCents <= 0 || v.taxByThenCents < c.timingThresholdCents) continue
    const s = v.sale
    const on = s.planned_on
    const gain = s.st_cents + s.lt_cents
    const room = Math.max(0, -v.netBeforeCents)
    const later = v.year > c.year
    const price =
      s.price_source === 'typed' ? 'the typed price' : s.price_source === 'quote' ? `the ${s.priced_on} quote` : 'no price on file'
    out.push({
      id: `sale-uncovered:${s.id}`,
      kind: 'sale-uncovered',
      tone: v.uncoveredAtYearEndCents > 0 ? 'risk' : 'heads-up',
      title: `${$(v.uncoveredCents)} of the gain on the ${s.symbol} sale planned for ${dayYear(on)} isn’t covered by the losses expected by then`,
      impactCents: v.taxByThenCents,
      impactLabel: 'tax if no more losses come that year',
      rule: {
        text: 'A year’s gains and losses net on the return whatever their order. What a planned sale’s day doesn’t cover rests on losses still to come that year — a manager’s forecast is an estimate — or is taxed.',
        cite: 'IRC §1211(b), §1212(b), §1222; your harvest forecast',
        vintage:
          `${TAX_DATA_VINTAGE}${later ? ` — held for ${v.year}` : ''}` +
          (v.forecasts.length ? ` · forecast: ${v.forecasts.map((f) => `${f.account} as of ${f.asOf}`).join(', ')}` : ''),
      },
      inputs: [
        { label: `Planned: ${formatQtyMicro(s.qty_micro)} ${s.symbol} from ${s.account} on ${on}`, value: `${$(s.proceeds_cents)} at ${price}` },
        { label: 'Its gain, short / long-term (the lots as they stand)', value: `${signed(s.st_cents)} / ${signed(s.lt_cents)}` },
        ...(v.carryInCents > 0 ? [{ label: `Loss carried into ${v.year}`, value: $(v.carryInCents) }] : []),
        ...(v.year === c.year && v.realizedCents !== 0 ? [{ label: `Realized so far in ${v.year} (recorded sales and broker reports)`, value: signed(v.realizedCents) }] : []),
        ...(v.forecasts.length || v.forecastByCents > 0 ? [{ label: `Losses the forecast expects through ${on}`, value: $(v.forecastByCents) }] : []),
        ...(v.earlierCents !== 0 ? [{ label: `Planned sales before it in ${v.year}`, value: signed(v.earlierCents) }] : []),
        ...(v.forecastAfterCents > 0 ? [{ label: `Losses the forecast expects after it, through Dec 31`, value: $(v.forecastAfterCents) }] : []),
      ],
      math: [
        roomLine(v),
        `${$(gain)} gain − ${$(room)} of room = ${$(v.uncoveredCents)} not covered on the day`,
        `${v.year} tax with the sale, the day as it stands − without it = ${$(v.taxByThenCents)}`,
        v.forecastAfterCents === 0
          ? `No more losses are expected in ${v.year}: the sale costs ${$(v.taxByYearEndCents)} on the return`
          : v.uncoveredAtYearEndCents === 0
            ? `With the ${$(v.forecastAfterCents)} the forecast expects after it, ${v.year} covers it by Dec 31 — the sale then costs ${$(v.taxByYearEndCents)}`
            : `Even with the ${$(v.forecastAfterCents)} the forecast expects after it, ${$(v.uncoveredAtYearEndCents)} stays uncovered by Dec 31 — the sale then costs ${$(v.taxByYearEndCents)}`,
      ],
      leavesOut: [
        'The return nets the whole year: losses that come after the sale still cover it. This is how much of it rests on them.',
        'Forecast losses are taken as short-term, as loss capacity takes them; the broker’s report settles the split.',
        'The gain follows today’s quote unless a price is typed, and the lots as they stand today.',
        ...(later ? [`${v.year} is priced on this year’s brackets and income.`] : []),
      ],
      action: { label: 'See loss capacity', to: { screen: 'tax', rest: ['capacity'] } },
    })
  }
  return out
}

/**
 * Loss lots whose harvest is worth more in one year than the other: the
 * lots the loss-harvest finding counts, realized before Dec 31 or in January,
 * over both years' tax with the carryforward (engine/twoyear.ts).
 */
function harvestTiming(c: Ctx): Draft[] {
  if (!c.wagesEntered) return []
  const lots = c.harvest.rows.filter((r) => r.gain_cents < 0 && !r.wash_risk && r.wash_upcoming === null)
  if (lots.length === 0) return []
  const next = c.year + 1
  const jan1 = `${next}-01-01`
  // Today's term this year; by January a lot may have turned long-term.
  const sides = (rows: HarvestLot[]) => {
    const now = { stCents: 0, ltCents: 0 }
    const later = { stCents: 0, ltCents: 0 }
    for (const r of rows) {
      if (r.term === 'lt') now.ltCents += r.gain_cents
      else now.stCents += r.gain_cents
      if (r.lt_on <= jan1) later.ltCents += r.gain_cents
      else later.stCents += r.gain_cents
    }
    return { now, later }
  }
  const two = c.two()
  const all = sides(lots)
  const t = priceCapitalTiming(two, all.now, all.later)
  const diff = t.nowSavesCents
  if (diff === 0 || Math.abs(diff) < c.timingThresholdCents) return []
  const byHolding = new Map<string, HarvestLot[]>()
  for (const r of lots) {
    const k = `${r.account_id}:${r.symbol}`
    const g = byHolding.get(k)
    if (g) g.push(r)
    else byHolding.set(k, [r])
  }
  const holdings = [...byHolding.values()]
    .map((rs) => {
      const h = sides(rs)
      return { symbol: rs[0]!.symbol, account: rs[0]!.account, lots: rs.length, lossCents: -(h.now.stCents + h.now.ltCents), savesCents: priceCapitalTiming(two, h.now, h.later).nowSavesCents }
    })
    .sort((a, b) => Math.abs(b.savesCents) - Math.abs(a.savesCents) || b.lossCents - a.lossCents)
  const loss = -(all.now.stCents + all.now.ltCents)
  const nowWins = diff > 0
  const when = nowWins ? 'before Dec 31' : 'in January'
  const other = nowWins ? 'in January' : 'before Dec 31'
  const one = holdings.length === 1 ? holdings[0]! : null
  const turning = all.later.ltCents - all.now.ltCents
  const shown = holdings.slice(0, 5)
  const nextView = two.view.nextYear
  return [
    {
      id: `timing:harvest:${nowWins ? 'now' : 'january'}`,
      kind: 'timing',
      tone: 'saving',
      title: one
        ? `Harvesting the ${$(loss)} loss in ${one.symbol} ${when} is worth ${$(Math.abs(diff))} more than ${other}`
        : `Harvesting ${$(loss)} of losses ${when} is worth ${$(Math.abs(diff))} more than ${other}`,
      impactCents: Math.abs(diff),
      impactLabel: `less tax over ${c.year} and ${next}`,
      rule: {
        text: 'A realized loss offsets the gains of its own year first, then up to $3,000 of ordinary income, and carries the rest forward by character. The same harvest priced in each year, over both years’ tax with the carryforward, shows which year it is worth more in.',
        cite: 'IRC §1211(b), §1212(b), §1222',
        vintage: `${TAX_DATA_VINTAGE} — held for ${next}`,
      },
      inputs: [
        { label: `Loss lots in taxable accounts (${lots.length}), short / long-term today`, value: `${$(all.now.stCents)} / ${$(all.now.ltCents)}` },
        ...(turning !== 0 ? [{ label: 'Turning long-term by Jan 1', value: $(-turning) }] : []),
        { label: `${c.year} gains and losses with the plan, short / long-term`, value: `${signed(two.thisInputs.stGainCents)} / ${signed(two.thisInputs.ltGainCents)}` },
        {
          label: `${next}: planned sales, short / long-term${nextView.forecastLossCents ? ', and the forecast’s losses' : ''}`,
          value: `${signed(nextView.plannedStCents)} / ${signed(nextView.plannedLtCents)}${nextView.forecastLossCents ? ` · −${$(nextView.forecastLossCents)}` : ''}`,
        },
        ...shown.map((h) => ({
          label: `${h.symbol} in ${h.account} (${h.lots} lot${h.lots === 1 ? '' : 's'}, ${$(h.lossCents)} loss), alone`,
          value: h.savesCents > 0 ? `${$(h.savesCents)} more before Dec 31` : h.savesCents < 0 ? `${$(-h.savesCents)} more in January` : 'the same either way',
        })),
        ...(holdings.length > shown.length ? [{ label: `${holdings.length - shown.length} more holding${holdings.length - shown.length === 1 ? '' : 's'}`, value: 'in the total' }] : []),
        { label: 'Speaks up at (your setting)', value: $(c.timingThresholdCents) },
      ],
      math: [
        `Harvested before Dec 31: ${$(t.nowCents.thisYear)} in ${c.year} + ${$(t.nowCents.nextYear)} in ${next} = ${$(t.nowCents.total)}`,
        `Harvested in January: ${$(t.laterCents.thisYear)} in ${c.year} + ${$(t.laterCents.nextYear)} in ${next} = ${$(t.laterCents.total)}`,
        nowWins
          ? `${$(t.laterCents.total)} − ${$(t.nowCents.total)} = ${$(diff)} less tax harvesting before Dec 31`
          : `${$(t.nowCents.total)} − ${$(t.laterCents.total)} = ${$(-diff)} less tax waiting for January`,
      ],
      leavesOut: [
        'A loss carried past next year is still worth something later; the two years here count none of it, which flatters harvesting before Dec 31 when neither year can use it all.',
        'Lots with a wash-sale risk are left out; a buy of the same or a substantially identical security within 30 days of the sale disallows the loss either year.',
        'The loss is today’s; prices move before either date. Each lot’s term is today’s for this year and Jan 1’s for January.',
        `${next} is priced on this year’s brackets, with this year’s paychecks for a full year.`,
      ],
      action: { label: 'See next year’s tax', to: { screen: 'tax', rest: ['two-year'] } },
    },
  ]
}

/* ============================ the calendar ============================ */

function calendar(c: Ctx): CalendarItem[] {
  const { out } = c.ty
  const year = out.year
  const items: CalendarItem[] = []
  const quarters = (sh: NonNullable<typeof out.stateSafeHarbor>, name: string) =>
    sh.quarters.forEach((q, i) => {
      if (q.past || q.cents <= 0) return
      items.push({
        on: q.due,
        title: `${name} estimated payment (installment ${i + 1})`,
        detail: `${sh.rule} · to stay in the safe harbor (${sh.basis})`,
        cents: q.cents,
        to: { screen: 'tax', rest: ['safe-harbor'] },
      })
    })
  quarters(out.safeHarbor, 'Federal')
  if (out.stateSafeHarbor) quarters(out.stateSafeHarbor, STATES.find((x) => x.code === out.settings.state)?.name ?? out.settings.state)
  items.push({
    on: `${year}-12-31`,
    title: `Last day for ${year} payroll 401(k) / 403(b) deferrals and for sales to count in ${year}`,
    detail: 'Deferrals come out of paychecks dated by Dec 31; a sale counts on its trade date.',
    cents: null,
    to: { screen: 'tax', rest: ['paychecks'] },
  })
  items.push({
    on: `${year + 1}-04-15`,
    title: `${year} IRA and HSA contributions, and the ${year} return`,
    detail: 'Contributions for the year can be made until the filing deadline (extensions don’t extend them).',
    cents: null,
    to: null,
  })
  const gift = c.roles.gift
  if (gift) {
    const big = c.db
      .prepare('SELECT posted_on, amount_cents FROM transactions WHERE category_id = ? AND posted_on LIKE ? AND -amount_cents > ? ORDER BY posted_on')
      .all(gift.id, `${year}%`, GIFT_EXCLUSION_2026) as { posted_on: string; amount_cents: number }[]
    for (const g of big)
      items.push({
        on: `${year + 1}-04-15`,
        title: 'Gift tax return (Form 709)',
        detail: `${$(-g.amount_cents)} on ${g.posted_on} (${gift.name}) is over the ${$(GIFT_EXCLUSION_2026)} annual exclusion, if it went to one person. Usually no tax — it counts against the lifetime exemption.`,
        cents: -g.amount_cents,
        to: { screen: 'cash' },
      })
  }
  return items.filter((x) => x.on >= c.today).sort((a, b) => a.on.localeCompare(b.on))
}

/* ============================== the read ============================== */

function context(db: DbLike, today: string): Ctx {
  const ty = taxYear(db, today)
  const settings = getCheckupSettings(db)
  const series = netWorthSeries(db, today)
  const base = computeTax(ty.inputs).totalCents
  let two: TwoYearContext | null = null
  return {
    db,
    today,
    year: ty.out.year,
    ty,
    roles: ty.out.itemized.roles,
    concentrationMicro: settings.concentrationMicro,
    nw: series[series.length - 1] ?? null,
    harvest: computeHarvest(db, today, ty.out.marginal),
    wagesEntered: listPaySources(db).length > 0 || ty.out.settings.wagesAnnualCents > 0,
    taxWith: (patch) => (Object.keys(patch).length === 0 ? base : computeTax({ ...ty.inputs, ...patch }).totalCents),
    timingThresholdCents: settings.timingThresholdCents,
    two: () => (two ??= twoYearContext(db, today, ty)),
  }
}

/**
 * The Checkup as `reader` sees it: every finding, largest dollar impact
 * first (unpriced ones last, in a fixed order), each marked new unless it was
 * on the list when the reader last marked it seen; the bracket headroom; and
 * the dated items ahead.
 */
export function getCheckup(db: DbLike, today: string, reader: string): Checkup {
  const c = context(db, today)
  const h = headroom(c)
  const drafts = [
    ...concentration(c),
    ...runway(c),
    ...itemize(c),
    ...giveShares(c),
    ...gainHarvest(c, h),
    ...lossHarvest(c),
    ...safeHarbor(c),
    ...addlMedicare(c),
    ...allocationDrift(c),
    ...assetLocation(c),
    ...priceCreep(c),
    ...mortgageRate(c),
    ...saleUncovered(c),
    ...harvestTiming(c),
    ...contributionFindings(
      computeContributions(db, today, c.ty.out.settings.filingStatus, c.ty.out.incomes.totalIncomeCents),
      // Deferrals, HSA money and conversions move income tax only — never Medicare wages, so no 0.9% surtax.
      Math.round(((c.taxWith({ ordinaryCents: c.ty.inputs.ordinaryCents + 1_000_00 }) - c.taxWith({})) * 1_000_000) / 1_000_00),
      c.wagesEntered,
    ),
  ]
  const seen = readSeen(db, reader)
  const findings = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) => b.d.impactCents - a.d.impactCents || a.i - b.i)
    .map(({ d }): Finding => ({ ...d, isNew: !seen?.ids.includes(d.id) }))
  const settings = getCheckupSettings(db)
  return {
    today,
    findings,
    headroom: h,
    calendar: calendar(c),
    settings,
    roles: c.roles,
    seenAt: seen?.at ?? null,
  }
}

/** Mark everything on the reader's Checkup right now as seen: later reads flag only what is new since. */
export function ackCheckup(db: DbLike, today: string, reader: string) {
  const ids = getCheckup(db, today, reader).findings.map((f) => f.id)
  const at = nowStamp()
  db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    seenKey(reader),
    JSON.stringify({ at, ids } satisfies Seen),
  )
  return { ok: true as const, seenAt: at }
}

