// The brokerage contract: what the investment routes answer. The engine
// (engine/invest.ts, engine/holdings.ts) implements it; the Investments screen
// and the chart cards consume it and never re-declare these types.

export type InvestKind = 'brokerage' | 'retirement' | 'crypto'

/* ---------- what a trade's note marks it as ---------- */

// Not free text: these notes say what a trade is, and the engine keeps them
// fixed (a trade's note can't be edited).
/** A starting position: booked on its as-of date, not bought with cash that day. */
export const OPENING_NOTE = 'Opening position'
/** Shares that vested: pay (Taxes counts the buy's total as income), not a purchase. */
export const RSU_VEST_NOTE = 'RSU vest'
/**
 * Shares the employer kept at a vest to pay its tax withholding (net
 * settlement): a same-day sale of that vest's lot at its own cost — exactly
 * $0 gain — whose proceeds went to the tax authorities, never into the account.
 */
export const RSU_WITHHOLDING_NOTE = 'RSU withholding'

/* ---------- accounts ---------- */

/**
 * What an account is, the way its statement names it (migration #18's
 * `subtype`). Descriptive: the tax truth is `kind` — only 'retirement' is
 * sheltered — so every type but 'other' implies exactly one kind and the
 * engine keeps the two consistent. NULL on an account means "infer it from
 * kind" (every account written before #18).
 */
export const INVEST_SUBTYPES = ['taxable', '401k', '403b', 'ira', 'roth_ira', 'hsa', 'crypto', 'stock_plan', 'other'] as const
export type InvestSubtype = (typeof INVEST_SUBTYPES)[number]
/** The kind each type implies; null: 'other' goes with any kind. */
export const SUBTYPE_KIND: Readonly<Record<InvestSubtype, InvestKind | null>> = {
  taxable: 'brokerage',
  '401k': 'retirement',
  '403b': 'retirement',
  ira: 'retirement',
  roth_ira: 'retirement',
  hsa: 'retirement',
  crypto: 'crypto',
  stock_plan: 'brokerage',
  other: null,
}
export const isInvestSubtype = (s: unknown): s is InvestSubtype => typeof s === 'string' && (INVEST_SUBTYPES as readonly string[]).includes(s)

// GET /api/invest/accounts → InvestAccountRow[], ordered by sort then id.
export type InvestAccountRow = {
  id: number
  name: string
  kind: InvestKind
  tracking: 'lots' | 'balance'
  stock_plan: number
  /** null: not set — infer the type from kind. */
  subtype: InvestSubtype | null
  institution: string | null
  /** Whose account it is (free text, usually a paycheck earner); null = joint. */
  owner: string | null
  /** The last few characters of the account number, as statements print them. */
  mask: string | null
  sort: number
  latest_snapshot: { balanced_on: string; balance_cents: number } | null
  counts: { trades: number; balances: number; unvested: number; paychecks: number }
}

/**
 * POST /api/invest/accounts. `kind` may be left out when `subtype` implies
 * one (every type but 'other'); when both are sent they must agree.
 */
export type InvestAccountCreate = {
  name: string
  kind?: InvestKind
  tracking: 'lots' | 'balance'
  stockPlan?: boolean
  subtype?: InvestSubtype | null
  institution?: string | null
  owner?: string | null
  mask?: string | null
}
/**
 * PATCH /api/invest/accounts/:id — only the fields sent change; null or ''
 * clears an optional one. Tracking changes only while nothing of the current
 * tracking is recorded (no trades on a lots account, no balances on a balance
 * account). A kind change moves the account's sales on or off the tax bill.
 */
export type InvestAccountPatch = Partial<Omit<InvestAccountCreate, 'kind'>> & { kind?: InvestKind; sort?: number }
/** `changed` false: the patch matched what was stored and nothing was written. */
export type InvestAccountUpdateResult = { ok: true; changed: boolean; account: InvestAccountRow }

/** One unvested grant (GET /api/unvested rows). */
export type UnvestedRow = {
  invest_account_id: number
  asset_id: number
  symbol: string
  account_name: string
  qty_micro: number
  updated_on: string
  /**
   * The next scheduled vest not yet recorded: the schedule's anchor day moved
   * past the latest vest recorded on or after it (engine/invest.ts getUnvested).
   * It may be past — a vest that is due. Sending it back unchanged keeps the anchor.
   */
  next_vest_on: string | null
  vest_every_months: number | null
  vest_qty_micro: number | null
  price_cents: number | null
  /** The day of that latest price (a vest's value is prefilled only from a close on the vest day itself). */
  priced_on: string | null
  est_cents: number | null
}

/**
 * GET /api/invest/accounts/:id — one account, everything its drawer shows:
 * its own open positions and totals (lots pooled in this account alone, the
 * same arithmetic as /api/portfolio), its balance history, its unvested
 * grants, and the counts a delete would take with it.
 */
export type InvestAccountDetail = {
  account: InvestAccountRow
  positions: PortfolioPosition[]
  totals: PortfolioResponse['totals']
  warnings: string[]
  /** A lots account's balance snapshots are its cash balances (see PortfolioAccount); a balance account's are its totals. */
  balances: BalanceSnapshotRow[]
  grants: UnvestedRow[]
  counts: InvestAccountRow['counts']
  /** A lots account's holdings value and derived cash (the portfolio's row for it); null for a balance account. */
  cash: PortfolioAccount | null
}

// GET /api/invest/owners → string[]: paycheck earners, then anyone else named as an account's owner.

/** One open lot, pooled per account: VTI in a taxable account and in a Roth are separate lots. */
export type PortfolioLot = {
  trade_id: number | null
  opened_on: string
  lt_on: string // first day a sale counts as long-term
  qty_micro: number
  cost_cents: number
  invest_account_id: number
  account_name: string
  sheltered: boolean // tax-advantaged account: no tax on sale
}

/** One symbol across every lots-tracked account, with its per-account split. */
export type PortfolioPosition = {
  asset_id: number
  symbol: string
  kind: 'stock' | 'crypto'
  qty_micro: number
  cost_cents: number
  price_cents: number | null
  priced_on: string | null
  value_cents: number
  unrealized_cents: number
  lots: PortfolioLot[]
  accounts: { invest_account_id: number; name: string; kind: InvestKind; qty_micro: number; cost_cents: number; value_cents: number }[]
  /** The latest price was entered by hand (POST /api/prices/manual), not quoted by the market. */
  price_manual?: boolean
}

/**
 * One lots-tracked account: what its holdings are worth, and its cash.
 *
 * A balance snapshot on a lots account is its cash balance at the end of that
 * day (the cash anchor). Cash on a later day is the latest anchor on or before
 * it, plus sale proceeds and minus buys dated after the anchor — except trades
 * no cash changed hands for: vests (pay), starting positions and other buys
 * booked after their shares were acquired (transfers in), and shares withheld
 * at a vest (their proceeds paid the tax). Deposits and withdrawals aren't
 * recorded, so a new anchor re-bases it. With no anchor there is no cash:
 * sale proceeds leave the account's value (`uncounted_proceeds_cents`).
 */
export type PortfolioAccount = {
  invest_account_id: number
  name: string
  kind: InvestKind
  /** Holdings at the latest price (at cost while unpriced): this account's share of totals.value. */
  value_cents: number
  /** Derived cash as of today; null: no cash balance recorded. */
  cash_cents: number | null
  /** The day of the cash balance it builds from. */
  cash_as_of: string | null
  /** That recorded cash balance. */
  cash_anchor_cents: number | null
  /** Trades dated after the anchor that moved the cash. */
  cash_trades: number
  /** No anchor: proceeds of sales (through today) that net worth doesn't count anywhere. 0 once anchored. */
  uncounted_proceeds_cents: number
}

// GET /api/portfolio → PortfolioResponse. Warnings name the holding as `SYM · Account` (or `Cash · Account`).
export type PortfolioResponse = {
  positions: PortfolioPosition[]
  warnings: string[]
  /**
   * value / cost / unrealized are holdings only (value is the positions summed); cash is the derived
   * cash of every anchored account, so value + cash is what net worth counts for lots accounts.
   * ytd_st / ytd_lt count taxable accounts only; ytd_sheltered is realized inside tax-advantaged ones.
   */
  totals: { value: number; cost: number; unrealized: number; cash: number; ytd_st: number; ytd_lt: number; ytd_sheltered: number }
  /** Every lots-tracked account in scope, in strip order (sort, then id). */
  accounts: PortfolioAccount[]
}

// GET /api/trades?accountId=&symbol=&year= → TradeRow[] (unbounded, newest first)
export type TradeRow = {
  id: number
  traded_on: string
  side: 'buy' | 'sell'
  qty_micro: number
  total_cents: number
  asset_id: number
  symbol: string
  invest_account_id: number
  account_name: string
  note: string | null
  acquired_on: string | null
  /** Sells only: realized gain by term, lots pooled per account. zero_basis_cents is proceeds no lot covered (inside st_cents). */
  realized?: { st_cents: number; lt_cents: number; zero_basis_cents?: number }
  /** A sell's chosen lot (the buy's trade id), or null for FIFO / explicit basis. */
  sold_lot_trade_id?: number | null
  /** A sell's explicit basis (shares Scarab never tracked), with acquired_on. */
  basis_cents?: number | null
  /** Buys only: how many sells took shares from this lot — what deleting it rewrites (a vest's withholding isn't counted). */
  dependents?: number
  /** Vest buys only: shares withheld for tax at this vest (its RSU withholding sales) — they go with it if it's deleted. */
  withheld_qty_micro?: number
}

/* ---------- recording, editing and previewing trades ---------- */

/** POST /api/trades and POST /api/trades/preview. `qty` is text (micro-shares parse exactly); totalCents includes fees. */
export type TradeBody = {
  investAccountId: number
  symbol: string
  assetKind: 'stock' | 'crypto'
  side: 'buy' | 'sell'
  tradedOn: string
  qty: string
  totalCents: number
  /** Sell: the buy whose lot it consumes (same account and asset). Omit for FIFO. */
  soldLotTradeId?: number | null
  /** Sell with basisCents: the explicit basis's acquisition. Buy: when the shares were really acquired. */
  acquiredOn?: string | null
  /** Sell only: explicit total cost basis for shares Scarab never tracked. */
  basisCents?: number | null
}

/** PATCH /api/trades/:id — the fields to change; null clears an optional one. Account, symbol, kind and side are fixed. */
export type TradePatch = Partial<Pick<TradeBody, 'tradedOn' | 'qty' | 'totalCents' | 'soldLotTradeId' | 'acquiredOn' | 'basisCents'>>
/** `changed` false: the edit matched what was stored and nothing was written. `affected`: other sales whose gain moved. */
export type TradeUpdateResult = { ok: true; id: number; changed: boolean; affected: number }
// DELETE /api/trades/:id — `rewritten`: sells now carrying the deleted lot's basis explicitly;
// `withholdingRemoved`: a deleted vest's withholding sales ($0 gain), deleted with it.
export type TradeDeleteResult = { ok: true; id: number; rewritten: number; unlinkedVests: number; withholdingRemoved: number }

export type TradePreviewPart = {
  lot_trade_id: number | null // null: explicit basis
  opened_on: string
  qty_micro: number
  cost_cents: number
  proceeds_cents: number
  term: 'st' | 'lt'
}
/**
 * A buy of the same asset, in any account, inside a loss sale's ±30-day wash
 * window. `sheltered`: bought in a tax-advantaged account — a loss it
 * disallows is lost for good, never added to the IRA shares' basis.
 */
export type WashBuy = { trade_id: number; account: string; account_id: number; acquired_on: string; qty_micro: number; note: string | null; sheltered: boolean }
/** A loss sale in a taxable account that a buy lands within 30 days of. */
export type WashLossSale = { trade_id: number; account: string; account_id: number; traded_on: string; loss_cents: number }
export type WashVest = { vest_on: string; qty_micro: number; account: string; account_id: number }

/**
 * POST /api/trades/preview → what recording the trade would do, written
 * nowhere. Realized gain by term with the lots it takes; the estimated tax
 * change on this year's return (null when the sale falls in an earlier tax
 * year; 0 in a tax-advantaged account); wash-sale traps: for a loss sale, buys
 * of the asset in any account within 30 days either side and a scheduled vest
 * within 30 days after; for a buy, taxable loss sales within 30 days of it.
 */
export type TradePreview = {
  side: 'buy' | 'sell'
  account: string
  sheltered: boolean
  realized: { stCents: number; ltCents: number }
  parts: TradePreviewPart[]
  zeroBasisCents: number
  estTaxCents: number | null
  taxYear: number
  warnings: string[]
  washSale: { risk: boolean; buys: WashBuy[]; upcomingVest: WashVest | null; lossSales: WashLossSale[] }
  /** Other sales in the account whose realized gain would change (a trade dated before them re-resolves FIFO). */
  affectedSales: number
}

/* ---------- RSU vests ---------- */

/**
 * POST /api/unvested/vest. `qty` is the gross shares that vested and
 * `totalCents` their value at vest (FMV × gross — income on Taxes, and the
 * lot's cost basis). `withheldQty`: shares the employer kept to pay the
 * withholding (net settlement), recorded as a same-day sale of this lot at
 * round(totalCents × withheld / gross) — exactly its cost, so $0 gain.
 */
export type VestBody = {
  investAccountId: number
  symbol: string
  qty: string
  tradedOn: string
  totalCents: number
  withheldQty?: string | null
  /** Vesting more than is recorded as unvested: the rest came from a grant Scarab doesn't track. */
  allowUntracked?: boolean
}
export type VestResult = {
  ok: true
  tradeId: number
  /** The withholding sale, or null when nothing was withheld. */
  withholdingTradeId: number | null
  grossQtyMicro: number
  withheldQtyMicro: number
  netQtyMicro: number
  /** The withheld shares' value at vest: the tax they paid. */
  withheldCents: number
  remainingQtyMicro: number
}

/* ---------- balance-tracked accounts ---------- */

// GET /api/invest/balances[?accountId=] → BalanceSnapshotRow[] (per account, newest first)
export type BalanceSnapshotRow = { invest_account_id: number; balanced_on: string; balance_cents: number }
// PUT /api/invest/balances takes one snapshot, or a batch written in one transaction:
export type BalancePut =
  | { investAccountId: number; balancedOn: string; balanceCents: number }
  | { investAccountId: number; balances: { balancedOn: string; balanceCents: number }[] }
// DELETE /api/invest/balances/:accountId/:date → { ok: true }

/* ---------- the balance check-in ---------- */

/**
 * One number that comes from a statement, with the latest one recorded. Each
 * saves through its own existing route:
 *  - 'balance': a balance-tracked account's total — PUT /api/invest/balances
 *  - 'cash': a lots account's cash balance (its cash anchor) — the same route
 *  - 'property': a home's value — PUT /api/properties/:id/valuation
 *  - 'liability': what a loan still owes — PUT /api/liabilities/:id/balance
 */
export type CheckinItem = {
  kind: 'balance' | 'cash' | 'property' | 'liability'
  /** The account, property or liability id. */
  id: number
  name: string
  /** A second line: institution and last 4, or the property a loan is against. */
  detail: string | null
  /** Accounts: whose it is (null = joint). Always null for property and loans. */
  owner: string | null
  last: { on: string; cents: number } | null
  /** Cash only: today's cash as Scarab derives it from `last` and the trades since (null with no cash balance). */
  derived_cents: number | null
  /** Cash only, with no cash balance recorded: sale proceeds net worth isn't counting anywhere. */
  uncounted_cents: number
}
// GET /api/invest/checkin → CheckinResponse: balance accounts and lots accounts' cash (strip order), then homes, then loans.
export type CheckinResponse = { items: CheckinItem[] }

/* ---------- starting positions ---------- */

/** One lot already held when Scarab's records begin. `qty` is text, as for trades. */
export type OpeningPositionRow = { symbol: string; qty: string; basisCents: number; acquiredOn?: string | null; assetKind?: 'stock' | 'crypto' }
// POST /api/trades/opening
export type OpeningPositionsBody = { investAccountId: number; asOf: string; rows: OpeningPositionRow[] }
/** All rows or none: any error means nothing was written. `row` indexes the request's rows. */
export type OpeningPositionsResult = {
  created: number
  tradeIds: number[]
  errors: { row: number; message: string }[]
  warnings: { row: number; message: string }[]
}

/* ---------- prices ---------- */

// POST /api/prices/manual — a price typed in by hand (mutual funds, CITs, private stock)
export type ManualPriceBody = { symbol: string; pricedOn: string; cents: number }

/* ---------- the realized-gains report ---------- */

/**
 * One line of a year's realized gains, the way Form 8949 lists them: the
 * shares one sale took from one lot (a sale across three lots is three
 * lines), in a taxable account. `basis`: 'lot' — a lot Scarab tracked;
 * 'entered' — the basis typed on the sale (shares Scarab never tracked);
 * 'none' — shares no lot covered, counted at zero basis and short-term
 * until the basis is entered.
 */
export type RealizedLine = {
  sale_trade_id: number | null
  account: string
  account_id: number
  symbol: string
  qty_micro: number
  /** null when no lot covered the shares (basis 'none'). */
  acquired_on: string | null
  sold_on: string
  proceeds_cents: number
  cost_cents: number
  gain_cents: number
  term: 'st' | 'lt'
  basis: 'lot' | 'entered' | 'none'
  /** The sale's note. (A vest's net-settlement withholding is never a line: see RealizedReport.withheld.) */
  note: string | null
  /** A loss with a buy of the same asset in any account (IRAs included) within 30 days either side: the loss may be disallowed (code W). */
  wash_risk: boolean
}
export type RealizedTotals = { proceeds_cents: number; cost_cents: number; gain_cents: number; lines: number }
// GET /api/invest/realized?year=YYYY → RealizedReport (the current year through today).
export type RealizedReport = {
  year: number
  /** Years with any sale in a taxable account, newest first (the asked-for year included). */
  years: number[]
  lines: RealizedLine[]
  st: RealizedTotals
  lt: RealizedTotals
  /** Short against long, then up to $3,000 of a net loss against ordinary income (§1211/1222). */
  netted: { netStCents: number; netLtCents: number; capLossUsedCents: number; capLossCarryCents: number }
  /** Sales inside tax-advantaged accounts that year: never reported, never taxed. */
  sheltered: { sales: number; gain_cents: number }
  /**
   * Shares withheld at vests that year (net settlement: RSU withholding "sales" at cost). The employer
   * kept them to pay the tax — no sale of yours and no 1099-B — so they are not lines; `cents` is their value.
   */
  withheld: { sales: number; cents: number }
  /** Lines needing attention before filing: shares with no basis, possible wash sales. */
  flags: { no_basis: number; wash_risk: number }
}

/* ---------- assets ---------- */

/**
 * GET /api/invest/assets → AssetRow[] (by symbol): every symbol Scarab has
 * recorded — traded, held or granted — with the kind it was recorded as. A
 * recorded symbol's kind is fixed (the engine refuses the other one).
 */
export type AssetRow = { id: number; symbol: string; kind: 'stock' | 'crypto' }

/**
 * One spelling per security, for matching: upper case, class shares with a
 * dash (BRK.B → BRK-B, the market list's spelling). Two stock symbols with
 * the same key are the same stock; crypto tickers have no dots, so the key is
 * the ticker itself.
 */
export const symbolKey = (s: string): string => s.trim().toUpperCase().replace(/\./g, '-')
