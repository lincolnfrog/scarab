import { bucketOf, type Bucket } from './buckets'
import type { DbLike } from './db'
import { bad, notFound } from './errors'
import { loadHoldings } from './holdings'
import { getPortfolio, listInvestAccounts } from './invest'
import { positionValueCents } from './lots'
import { resolveTaxContext } from './scenarios'
import { computeHarvest, realizedTaxEstimate, taxYear, type HarvestLot } from './tax'

/**
 * Target allocation and tax-aware rebalancing (copilot §4d).
 *
 * Every investable dollar gets an asset class: each asset's class (set on it,
 * or guessed from its symbol and name), bank and brokerage cash as cash, and a
 * balance-tracked account — known only by its total — by a class of its own.
 * Property stays out: this is the mix of what is invested, not of net worth.
 *
 * With a target (one settings blob, household data), the plan closes the gap
 * in the order that costs least: a year of new contributions (from the
 * paystub pace) into what's underweight, then trades inside sheltered
 * accounts (no tax), then sales in taxable accounts, lot by lot from the
 * least gain per dollar up, priced with the year's exact tax delta.
 */

export const ASSET_CLASSES = ['us_stock', 'intl_stock', 'bonds', 'cash', 'real_estate', 'crypto', 'other'] as const
export type AssetClass = (typeof ASSET_CLASSES)[number]
export const CLASS_LABEL: Record<AssetClass, string> = {
  us_stock: 'US stocks',
  intl_stock: 'International stocks',
  bonds: 'Bonds',
  cash: 'Cash',
  real_estate: 'Real estate (REITs)',
  crypto: 'Crypto',
  other: 'Other / mixed',
}
const isClass = (v: unknown): v is AssetClass => typeof v === 'string' && (ASSET_CLASSES as readonly string[]).includes(v)

/** Widely held funds whose class the name alone can't settle. */
const KNOWN: Record<string, AssetClass> = {}
const known = (cls: AssetClass, list: string) => list.split(' ').forEach((s) => (KNOWN[s] = cls))
known('us_stock', 'VTI VOO SPY IVV ITOT SCHB SCHX SCHK SPLG QQQ QQQM VUG VTV VB VO VXF IWM IWB IWV DIA RSP SCHD VIG VYM MGK SCHG VONG VTSAX VFIAX VFFVX FXAIX FSKAX FZROX SWTSX SWPPX')
known('intl_stock', 'VXUS VEA VWO IEFA IEMG EFA EEM IXUS SCHF SCHE SPDW ACWX VEU VTIAX VTMGX FTIHX FZILX SWISX')
known('bonds', 'BND AGG BNDX VGIT VGSH VGLT TLT IEF SHY SCHZ SCHR SCHO VTEB MUB TIP SCHP VTIP BSV BIV BLV LQD VCIT VCSH GOVT IUSB FBND VBTLX FXNAX SWAGX')
known('cash', 'SGOV BIL SHV TFLO USFR VMFXX SPAXX FDRXX SWVXX VUSXX SNVXX FZFXX')
known('real_estate', 'VNQ VNQI SCHH XLRE IYR USRT RWR FREL')
known('crypto', 'IBIT FBTC GBTC BITB ARKB BITO ETHA ETHE FETH')

/**
 * A class from the symbol and name: the known funds first, then words in the
 * name (bond, international, REIT, money market), then crypto by kind, and a
 * single stock or an unrecognised fund as US stock — the commonest case, and
 * the one most worth correcting by hand when it's wrong.
 */
export function guessClass(symbol: string, name: string | null, kind: 'stock' | 'crypto'): AssetClass {
  if (kind === 'crypto') return 'crypto'
  const k = KNOWN[symbol.toUpperCase()]
  if (k) return k
  const n = (name ?? '').toLowerCase()
  if (/money market|treasury bill|t-bill|ultra.?short treasury|government cash/.test(n)) return 'cash'
  if (/\bbond|treasur|fixed income|aggregate|municipal|\bmuni\b|tips\b|credit/.test(n)) return 'bonds'
  if (/\breit\b|real estate/.test(n)) return 'real_estate'
  if (/bitcoin|ether(eum)?\b|crypto/.test(n)) return 'crypto'
  if (/international|intl|ex[- ]u\.?s|emerging|developed|world ex|global ex|europe|pacific|japan|china/.test(n)) return 'intl_stock'
  if (/target|retirement 20\d\d|lifepath|balanced|allocation|moderate|conservative/.test(n)) return 'other'
  return 'us_stock'
}

/* ============================== settings ============================== */

const TARGET_KEY = 'allocation'

export function getTarget(db: DbLike): Partial<Record<AssetClass, number>> | null {
  const row = db.prepare('SELECT value FROM goal_settings WHERE key = ?').get(TARGET_KEY) as { value: string } | undefined
  if (!row) return null
  try {
    const t = (JSON.parse(row.value) as { targets?: Record<string, unknown> }).targets ?? {}
    const out: Partial<Record<AssetClass, number>> = {}
    for (const [k, v] of Object.entries(t)) if (isClass(k) && Number.isSafeInteger(v) && (v as number) > 0) out[k] = v as number
    return Object.keys(out).length ? out : null
  } catch {
    return null
  }
}

/** PUT /api/allocation/target: shares per class in micro that sum to 100% — or {} to clear the target. */
export function putTarget(db: DbLike, body: { targets?: unknown }) {
  const t = body?.targets
  if (t === null || typeof t !== 'object' || Array.isArray(t)) bad('targets must be an object of class → micro')
  const out: Partial<Record<AssetClass, number>> = {}
  let sum = 0
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (!isClass(k)) bad(`unknown asset class ${k}`)
    if (!Number.isSafeInteger(v) || (v as number) < 0) bad(`${k} must be a non-negative integer (micro)`)
    if ((v as number) > 0) out[k as AssetClass] = v as number
    sum += v as number
  }
  if (Object.keys(out).length && sum !== 1_000_000) bad(`the target adds up to ${(sum / 10_000).toFixed(2)}%, not 100%`)
  db.prepare('INSERT INTO goal_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
    TARGET_KEY,
    JSON.stringify({ targets: out }),
  )
  return { ok: true as const, targets: Object.keys(out).length ? out : null }
}

const classBody = (b: { assetClass?: unknown }): AssetClass | null => {
  const c = b?.assetClass ?? null
  if (c !== null && !isClass(c)) bad(`assetClass must be one of ${ASSET_CLASSES.join(', ')}, or null to guess`)
  return c as AssetClass | null
}

export function putAssetClass(db: DbLike, assetId: number, b: { assetClass?: unknown }) {
  const c = classBody(b)
  if (db.prepare('UPDATE assets SET asset_class = ? WHERE id = ?').run(c, assetId).changes === 0) notFound('no such asset')
  return { ok: true as const }
}

export function putAccountClass(db: DbLike, accountId: number, b: { assetClass?: unknown }) {
  const c = classBody(b)
  const r = db.prepare("UPDATE invest_accounts SET asset_class = ? WHERE id = ? AND tracking = 'balance'").run(c, accountId)
  if (r.changes === 0) notFound('no such balance-tracked account (an account with holdings is classed by its assets)')
  return { ok: true as const }
}

/* ============================ the allocation ============================ */

/** One slice of what's invested: an asset in an account, an account's cash, or a balance-only account. */
export type Slice = {
  cls: AssetClass
  cents: number
  bucket: Bucket
  accountId: number | null
  accountName: string
  assetId: number | null
  symbol: string | null
  /** Can be traded inside its account without tax (a sheltered account's holding or total). */
  sheltered: boolean
  /** A municipal bond fund: its interest is federally tax-free, so taxable is its natural home. */
  muni?: boolean
}

const MUNI = new Set(['VTEB', 'MUB', 'TFI', 'SUB', 'SHM', 'VWITX', 'VWIUX', 'FTABX', 'CMF', 'NYF'])
export const isMuni = (symbol: string, name: string | null) => MUNI.has(symbol.toUpperCase()) || /municipal|\bmuni\b|tax[- ]exempt/i.test(name ?? '')

export type AllocationRow = {
  cls: AssetClass
  label: string
  cents: number
  shareMicro: number
  targetMicro: number | null
  /** share − target, when there is a target. */
  driftMicro: number | null
  /** target × total − held: + to buy, − to sell. */
  toTargetCents: number | null
}

export type PlanStep = {
  step: 'contribute' | 'sheltered' | 'taxable'
  action: 'buy' | 'sell'
  cls: AssetClass
  cents: number
  where: string
  /** Taxable sales: the lot and what selling it realizes. */
  lot?: { symbol: string; openedOn: string; term: 'st' | 'lt'; gainCents: number; washRisk: boolean }
}

export type RebalancePlan = {
  contributionsCents: number
  steps: PlanStep[]
  taxable: { stGainCents: number; ltGainCents: number; taxCents: number }
  /** What no step reaches (not enough to sell in any account). */
  unresolvedCents: number
}

export type Allocation = {
  totalCents: number
  rows: AllocationRow[]
  target: Partial<Record<AssetClass, number>> | null
  assets: { id: number; symbol: string; name: string | null; cls: AssetClass; guessed: boolean; cents: number }[]
  accounts: { id: number; name: string; cls: AssetClass; guessed: boolean; cents: number }[]
  slices: Slice[]
  plan: RebalancePlan | null
}

function slicesOf(db: DbLike, today: string) {
  const assetRows = db
    .prepare(
      `SELECT a.id, a.symbol, a.kind, a.asset_class,
              COALESCE(a.name, (SELECT q.name FROM basket_quotes q WHERE q.symbol = a.symbol AND q.kind = a.kind)) AS name
       FROM assets a`,
    )
    .all() as { id: number; symbol: string; kind: 'stock' | 'crypto'; asset_class: string | null; name: string | null }[]
  const classOf = new Map(
    assetRows.map((a) => [a.id, { cls: isClass(a.asset_class) ? a.asset_class : guessClass(a.symbol, a.name, a.kind), guessed: !isClass(a.asset_class), a }]),
  )
  const slices: Slice[] = []
  const accts = listInvestAccounts(db)
  const accountClass = db.prepare('SELECT asset_class FROM invest_accounts WHERE id = ?')
  const bucketByAccount = new Map(accts.map((a) => [a.id, bucketOf(a.subtype, a.kind)]))

  // Bank accounts are cash, held in taxable.
  const banks = db
    .prepare(
      `SELECT a.name, a.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.posted_on <= ?), 0) AS cents
       FROM accounts a ORDER BY a.id`,
    )
    .all(today) as { name: string; cents: number }[]
  for (const b of banks) if (b.cents !== 0) slices.push({ cls: 'cash', cents: b.cents, bucket: 'taxable', accountId: null, accountName: b.name, assetId: null, symbol: null, sheltered: false })

  const price = db.prepare('SELECT close_cents FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1')
  for (const h of loadHoldings(db, today)) {
    if (h.pos.qty_micro <= 0) continue
    const p = price.get(h.assetId) as { close_cents: number } | undefined
    const cents = p ? positionValueCents(h.pos.qty_micro, p.close_cents) : h.pos.cost_cents
    const bucket = bucketByAccount.get(h.investAccountId) ?? 'taxable'
    slices.push({
      cls: classOf.get(h.assetId)?.cls ?? 'other',
      cents,
      bucket,
      accountId: h.investAccountId,
      accountName: h.accountName,
      assetId: h.assetId,
      symbol: h.symbol,
      sheltered: bucket !== 'taxable',
      muni: isMuni(h.symbol, classOf.get(h.assetId)?.a.name ?? null),
    })
  }
  for (const a of getPortfolio(db, today).accounts)
    if ((a.cash_cents ?? 0) !== 0) {
      const bucket = bucketByAccount.get(a.invest_account_id) ?? 'taxable'
      slices.push({ cls: 'cash', cents: a.cash_cents!, bucket, accountId: a.invest_account_id, accountName: a.name, assetId: null, symbol: null, sheltered: bucket !== 'taxable' })
    }
  const accounts: Allocation['accounts'] = []
  for (const a of accts) {
    if (a.tracking !== 'balance') continue
    const cents = a.latest_snapshot && a.latest_snapshot.balanced_on <= today ? a.latest_snapshot.balance_cents : 0
    const set = (accountClass.get(a.id) as { asset_class: string | null }).asset_class
    const cls: AssetClass = isClass(set) ? set : 'other'
    accounts.push({ id: a.id, name: a.name, cls, guessed: !isClass(set), cents })
    if (cents !== 0) {
      const bucket = bucketOf(a.subtype, a.kind)
      slices.push({ cls, cents, bucket, accountId: a.id, accountName: a.name, assetId: null, symbol: null, sheltered: bucket !== 'taxable' })
    }
  }
  const held = new Map<number, number>()
  for (const s of slices) if (s.assetId !== null) held.set(s.assetId, (held.get(s.assetId) ?? 0) + s.cents)
  const assets: Allocation['assets'] = [...classOf.entries()]
    .filter(([id]) => held.has(id))
    .map(([id, c]) => ({ id, symbol: c.a.symbol, name: c.a.name, cls: c.cls, guessed: c.guessed, cents: held.get(id)! }))
    .sort((x, y) => y.cents - x.cents)
  return { slices, assets, accounts }
}

export function getAllocation(db: DbLike, today: string, opts: { plan?: boolean } = {}): Allocation {
  const { slices, assets, accounts } = slicesOf(db, today)
  const total = slices.reduce((s, x) => s + x.cents, 0)
  const target = getTarget(db)
  const by = new Map<AssetClass, number>()
  for (const s of slices) by.set(s.cls, (by.get(s.cls) ?? 0) + s.cents)
  const rows: AllocationRow[] = ASSET_CLASSES.filter((c) => (by.get(c) ?? 0) !== 0 || (target?.[c] ?? 0) > 0).map((cls) => {
    const cents = by.get(cls) ?? 0
    const shareMicro = total > 0 ? Math.round((cents * 1_000_000) / total) : 0
    const t = target ? (target[cls] ?? 0) : null
    return {
      cls,
      label: CLASS_LABEL[cls],
      cents,
      shareMicro,
      targetMicro: t,
      driftMicro: t === null ? null : shareMicro - t,
      toTargetCents: t === null ? null : Math.round((total * t) / 1_000_000) - cents,
    }
  })
  return { totalCents: total, rows, target, assets, accounts, slices, plan: target && total > 0 && opts.plan !== false ? rebalancePlan(db, today, slices, target) : null }
}

/* ============================ the plan ============================ */

function rebalancePlan(db: DbLike, today: string, slices: Slice[], target: Partial<Record<AssetClass, number>>): RebalancePlan {
  const ctx = resolveTaxContext(db, today)
  const contributions = Math.max(0, ctx.saves.traditionalCents + ctx.saves.rothCents + ctx.saves.hsaCents)
  const total = slices.reduce((s, x) => s + x.cents, 0)
  const held = new Map<AssetClass, number>()
  for (const s of slices) held.set(s.cls, (held.get(s.cls) ?? 0) + s.cents)
  // Gaps against the total a year of contributions makes: they sum to the contributions, so new money closes
  // underweights first and only the rest needs selling.
  const after = total + contributions
  const gap = new Map<AssetClass, number>()
  for (const c of ASSET_CLASSES) gap.set(c, Math.round((after * (target[c] ?? 0)) / 1_000_000) - (held.get(c) ?? 0))
  const steps: PlanStep[] = []

  // 1 — contributions into what's underweight, in proportion to how far under.
  const under = ASSET_CLASSES.filter((c) => gap.get(c)! > 0)
  const underSum = under.reduce((s, c) => s + gap.get(c)!, 0)
  let given = 0
  under.forEach((c, i) => {
    const share = i === under.length - 1 ? Math.min(contributions, underSum) - given : Math.round((Math.min(contributions, underSum) * gap.get(c)!) / underSum)
    if (share <= 0) return
    given += share
    gap.set(c, gap.get(c)! - share)
    steps.push({ step: 'contribute', action: 'buy', cls: c, cents: share, where: 'new 401(k) / IRA / HSA contributions' })
  })

  // What remains: sell the overweight, buy the underweight, with the same dollars.
  let toSell = ASSET_CLASSES.reduce((s, c) => s + Math.max(0, gap.get(c)!), 0)
  const sellLeft = new Map<AssetClass, number>(ASSET_CLASSES.map((c) => [c, Math.max(0, -gap.get(c)!)]))

  // 2 — inside sheltered accounts: no tax on a sale there.
  const buyIn = (cents: number, where: string, step: PlanStep['step']) => {
    let left = cents
    for (const c of ASSET_CLASSES) {
      const need = gap.get(c)!
      if (need <= 0 || left <= 0) continue
      const x = Math.min(need, left)
      gap.set(c, need - x)
      left -= x
      steps.push({ step, action: 'buy', cls: c, cents: x, where })
    }
  }
  for (const s of slices.filter((x) => x.sheltered).sort((a, b) => b.cents - a.cents)) {
    if (toSell <= 0) break
    const left = sellLeft.get(s.cls)!
    if (left <= 0) continue
    const x = Math.min(left, s.cents, toSell)
    if (x <= 0) continue
    sellLeft.set(s.cls, left - x)
    toSell -= x
    const where = s.symbol ? `${s.symbol} in ${s.accountName}` : s.accountName
    steps.push({ step: 'sheltered', action: 'sell', cls: s.cls, cents: x, where })
    buyIn(x, `in ${s.accountName}`, 'sheltered')
  }

  // 3 — taxable: the overweight classes' lots, least gain per dollar first (losses before gains), long-term
  // before short-term at the same ratio; the last lot is sold in part.
  let st = 0
  let lt = 0
  if (toSell > 0) {
    const ty = taxYear(db, today)
    const clsOf = new Map(slices.filter((s) => s.symbol).map((s) => [s.symbol!, s.cls]))
    const lots = computeHarvest(db, today, ty.out.marginal)
      .rows.filter((l: HarvestLot) => l.value_cents > 0 && (sellLeft.get(clsOf.get(l.symbol) ?? 'other') ?? 0) > 0)
      .sort((a, b) => a.gain_cents / a.value_cents - b.gain_cents / b.value_cents || (a.term === b.term ? 0 : a.term === 'lt' ? -1 : 1))
    for (const l of lots) {
      if (toSell <= 0) break
      const cls = clsOf.get(l.symbol) ?? 'other'
      const left = sellLeft.get(cls)!
      if (left <= 0) continue
      const x = Math.min(left, l.value_cents, toSell)
      const gain = Math.round((l.gain_cents * x) / l.value_cents)
      if (l.term === 'st') st += gain
      else lt += gain
      sellLeft.set(cls, left - x)
      toSell -= x
      steps.push({
        step: 'taxable',
        action: 'sell',
        cls,
        cents: x,
        where: `${l.symbol} in ${l.account}`,
        lot: { symbol: l.symbol, openedOn: l.opened_on, term: l.term, gainCents: gain, washRisk: l.wash_risk || l.wash_upcoming !== null },
      })
      buyIn(x, `with the proceeds of ${l.symbol}`, 'taxable')
    }
  }
  const tax = st !== 0 || lt !== 0 ? realizedTaxEstimate(db, today, st, lt).deltaCents : 0
  return { contributionsCents: contributions, steps, taxable: { stGainCents: st, ltGainCents: lt, taxCents: tax }, unresolvedCents: toSell >= 1_00 ? toSell : 0 } // a few cents of rounding left over is nothing to report
}
