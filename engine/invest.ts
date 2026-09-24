import { addMonthsIso, isRealIsoDay } from '../shared/dates'
import {
  INVEST_SUBTYPES,
  isInvestSubtype,
  OPENING_NOTE,
  RSU_VEST_NOTE,
  RSU_WITHHOLDING_NOTE,
  SUBTYPE_KIND,
  type BalanceSnapshotRow,
  type CheckinItem,
  type CheckinResponse,
  type InvestAccountCreate,
  type InvestAccountDetail,
  type InvestAccountPatch,
  type InvestAccountRow,
  type InvestAccountUpdateResult,
  type InvestKind,
  type InvestSubtype,
  type OpeningPositionsResult,
  type PortfolioAccount,
  type PortfolioPosition,
  type PortfolioResponse,
  type AssetRow,
  type TradeBody,
  type TradeDeleteResult,
  type TradeRow,
  type TradeUpdateResult,
  type UnvestedRow,
  type VestResult,
  symbolKey,
} from '../shared/invest-api'
import { formatCents, formatQtyMicro, parseQtyMicro } from '../shared/money'
import type { DbLike } from './db'
import { ApiError, bad, isoDay, notFound } from './errors'
import { ALL_TIME, cashAt, cashEffectCents, holdingLedger, loadHoldings, type CashTrade, type LedgerTrade } from './holdings'
import { computePosition, longTermOn, lotCostShare, positionValueCents, saleRealized, type Sale } from './lots'
import { priceFlagKeys, upsertPrices } from './prices'

/**
 * Investment accounts, trades, the portfolio and unvested RSUs, as pure
 * functions of (db, args) — the same contract as engine/services.ts, which
 * re-exports everything here so its importers see one module.
 */

/* ---------- investments ---------- */

export type { InvestAccountRow }

type AccountDbRow = Omit<InvestAccountRow, 'latest_snapshot' | 'counts'>
const ACCOUNT_COLS = 'id, name, kind, tracking, stock_plan, subtype, institution, owner, mask, sort'

/** Accounts in strip order (sort, then id), each with its latest balance and what is recorded against it. */
function accountRows(db: DbLike, onlyId?: number): InvestAccountRow[] {
  const rows = (
    onlyId === undefined
      ? db.prepare(`SELECT ${ACCOUNT_COLS} FROM invest_accounts ORDER BY sort, id`).all()
      : db.prepare(`SELECT ${ACCOUNT_COLS} FROM invest_accounts WHERE id = ?`).all(onlyId)
  ) as AccountDbRow[]
  const latest = db.prepare(
    'SELECT balanced_on, balance_cents FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on DESC LIMIT 1',
  )
  // Counts so a delete can say out loud what it is about to take with it.
  const counts = db.prepare(
    `SELECT (SELECT count(*) FROM trades WHERE invest_account_id = ?) AS trades,
            (SELECT count(*) FROM balance_snapshots WHERE invest_account_id = ?) AS balances,
            (SELECT count(*) FROM unvested_positions WHERE invest_account_id = ?) AS unvested,
            (SELECT count(*) FROM pay_sources WHERE invest_account_id = ?) AS paychecks`,
  )
  return rows.map((r) => ({
    ...r,
    subtype: isInvestSubtype(r.subtype) ? r.subtype : null,
    latest_snapshot: (latest.get(r.id) as InvestAccountRow['latest_snapshot'] | undefined) ?? null,
    counts: counts.get(r.id, r.id, r.id, r.id) as InvestAccountRow['counts'],
  }))
}

export function listInvestAccounts(db: DbLike): InvestAccountRow[] {
  return accountRows(db)
}

/** Unvested RSUs need somewhere to vest into: a lot-tracked account. */
const stockPlanOk = (tracking: string | undefined, stockPlan: boolean) => {
  if (stockPlan && tracking !== 'lots') bad('an employee stock plan has to track trades (vests land as buys)')
}

const MAX_NAME = 60
const MAX_INSTITUTION = 60
const MAX_OWNER = 40
const KINDS: readonly InvestKind[] = ['brokerage', 'retirement', 'crypto']
const isKind = (v: unknown): v is InvestKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v)
const isTracking = (v: unknown): v is 'lots' | 'balance' => v === 'lots' || v === 'balance'
/** How a type reads in a message. */
const TYPE_NAME: Record<InvestSubtype, string> = {
  taxable: 'taxable brokerage account',
  '401k': '401(k)',
  '403b': '403(b)',
  ira: 'IRA',
  roth_ira: 'Roth IRA',
  hsa: 'HSA',
  crypto: 'crypto account',
  stock_plan: 'stock plan',
  other: 'account',
}

/** An optional text field: undefined leaves it alone, null or blank clears it, anything else is trimmed and capped. */
function optText(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined
  if (v === null) return null
  if (typeof v !== 'string') bad(`${field} must be text`)
  const t = v.trim()
  if (t.length > max) bad(`${field}: at most ${max} characters`)
  return t || null
}

/** "1234", "••1234", "XXXX-5678" → the last few characters, as statements print them. */
function optMask(v: unknown): string | null | undefined {
  const t = optText(v, 'last 4', 24)
  if (t == null) return t
  let m = t.replace(/[^0-9A-Za-z]/g, '')
  while (m.length > 4 && /^[xX]/.test(m)) m = m.slice(1) // a statement's masking Xs
  if (!/^[0-9A-Za-z]{2,4}$/.test(m)) bad('last 4: the last 2–4 letters or digits of the account number')
  return m.toUpperCase()
}

/** Whose account: free text, and "Joint" (or blank) means both — stored as null. */
function optOwner(v: unknown): string | null | undefined {
  const t = optText(v, 'owner', MAX_OWNER)
  return t && /^joint$/i.test(t) ? null : t
}

function optSubtype(v: unknown): InvestSubtype | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  if (!isInvestSubtype(v)) bad(`subtype must be one of ${INVEST_SUBTYPES.join(', ')}`)
  return v
}

/** Every type but 'other' implies one kind — the tax truth (only 'retirement' is sheltered) can't contradict the label. */
function checkKindAndType(kind: InvestKind, subtype: InvestSubtype | null) {
  const implied = subtype ? SUBTYPE_KIND[subtype] : null
  if (implied && implied !== kind)
    bad(`a ${TYPE_NAME[subtype!]} is kind ${implied}, not ${kind} — send the matching kind, or leave kind out`)
}

function accountName(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) bad('name required')
  if (name.length > MAX_NAME) bad(`name: at most ${MAX_NAME} characters`)
  return name
}

/**
 * Add an account. `subtype` (401k, roth_ira, …) brings its kind along, so a
 * type card alone is enough; the profile — institution, owner (null =
 * joint), the last 4 — is descriptive and optional.
 */
export function createInvestAccount(db: DbLike, b: Partial<Record<keyof InvestAccountCreate, unknown>>) {
  const subtype = optSubtype(b.subtype) ?? null
  const kind = b.kind === undefined && subtype ? (SUBTYPE_KIND[subtype] ?? undefined) : b.kind
  if (typeof b.name !== 'string' || !b.name.trim() || !isKind(kind) || !isTracking(b.tracking))
    bad('name, kind (brokerage|retirement|crypto), tracking (lots|balance) required')
  const name = accountName(b.name)
  checkKindAndType(kind, subtype)
  const institution = optText(b.institution, 'institution', MAX_INSTITUTION) ?? null
  const owner = optOwner(b.owner) ?? null
  const mask = optMask(b.mask) ?? null
  const stockPlan = b.stockPlan === true
  stockPlanOk(b.tracking, stockPlan)
  const r = db
    .prepare(
      'INSERT INTO invest_accounts (name, kind, tracking, stock_plan, subtype, institution, owner, mask) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(name, kind, b.tracking, stockPlan ? 1 : 0, subtype, institution, owner, mask)
  return accountRows(db, Number(r.lastInsertRowid))[0]!
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/**
 * Change an account's profile: name, type, institution, owner, last 4,
 * order, employee-stock-plan flag — and, guarded, its kind and tracking.
 *
 * - A new type brings its kind along; a kind that contradicts the type is
 *   refused. Changing kind is allowed (a misfiled Roth is a real fix): the
 *   account's sales move on or off the tax bill, since shelter is derived.
 * - Tracking changes only while nothing of the current tracking is recorded.
 *   Trades on a lots account and balances on a balance account are what its
 *   value is derived from; switching would silently drop them from holdings,
 *   net worth and tax.
 *
 * Everything is checked before anything is written, and a patch that changes
 * nothing writes nothing (`changed: false`), so a tab session stays clean.
 */
export function updateInvestAccount(db: DbLike, id: number, b: Partial<Record<keyof InvestAccountPatch, unknown>>): InvestAccountUpdateResult {
  const cur = accountRows(db, id)[0]
  if (!cur) notFound('no such investment account')
  const next = {
    name: b.name === undefined ? cur.name : accountName(b.name),
    kind: cur.kind,
    tracking: cur.tracking,
    stock_plan: cur.stock_plan,
    subtype: cur.subtype,
    institution: cur.institution,
    owner: cur.owner,
    mask: cur.mask,
    sort: cur.sort,
  }
  const subtype = optSubtype(b.subtype)
  if (subtype !== undefined) next.subtype = subtype
  if (b.kind !== undefined) {
    if (!isKind(b.kind)) bad('kind must be brokerage, retirement or crypto')
    next.kind = b.kind
  } else if (subtype) next.kind = SUBTYPE_KIND[subtype] ?? next.kind // a new type brings its kind along
  checkKindAndType(next.kind, next.subtype)
  const institution = optText(b.institution, 'institution', MAX_INSTITUTION)
  if (institution !== undefined) next.institution = institution
  const owner = optOwner(b.owner)
  if (owner !== undefined) next.owner = owner
  const mask = optMask(b.mask)
  if (mask !== undefined) next.mask = mask
  if (b.sort !== undefined) {
    if (!Number.isSafeInteger(b.sort) || Math.abs(b.sort as number) > 1_000_000) bad('sort must be a whole number')
    next.sort = b.sort as number
  }
  if (b.tracking !== undefined) {
    if (!isTracking(b.tracking)) bad('tracking must be lots or balance')
    next.tracking = b.tracking
  }
  if (next.tracking !== cur.tracking) {
    if (cur.tracking === 'lots' && cur.counts.trades > 0)
      bad(
        `${cur.name} has ${plural(cur.counts.trades, 'trade')} — tracking it by balance would drop them from holdings, net worth and tax. Delete them first, or add a separate balance-tracked account`,
      )
    if (cur.tracking === 'balance' && cur.counts.balances > 0)
      bad(
        `${cur.name} has ${plural(cur.counts.balances, 'balance update')} — tracking trades would drop them from net worth. Delete them first, or add a separate account that tracks trades`,
      )
  }
  const stockPlan = b.stockPlan === undefined ? cur.stock_plan === 1 : b.stockPlan === true
  stockPlanOk(next.tracking, stockPlan)
  if (!stockPlan && cur.stock_plan === 1) {
    if (cur.counts.unvested > 0) bad('clear the unvested shares on this account before turning off its stock plan')
    if (cur.counts.paychecks > 0) bad('a paycheck still vests stock comp into this account — unlink it on Taxes first')
  }
  next.stock_plan = stockPlan ? 1 : 0

  const changed = (Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== cur[k])
  if (!changed) return { ok: true, changed: false, account: cur }
  db.prepare(
    `UPDATE invest_accounts SET name = ?, kind = ?, tracking = ?, stock_plan = ?, subtype = ?, institution = ?, owner = ?, mask = ?, sort = ?
     WHERE id = ?`,
  ).run(next.name, next.kind, next.tracking, next.stock_plan, next.subtype, next.institution, next.owner, next.mask, next.sort, id)
  return { ok: true, changed: true, account: accountRows(db, id)[0]! }
}

/**
 * Who accounts can belong to: each paycheck earner (Taxes), in their order,
 * then anyone else already named as an account's owner. Joint (null) isn't a
 * name, so it isn't listed — the screen offers it alongside.
 */
export function listInvestOwners(db: DbLike): string[] {
  const earners = db.prepare('SELECT earner FROM pay_sources ORDER BY sort, id').all() as { earner: string }[]
  const owners = db.prepare('SELECT owner FROM invest_accounts WHERE owner IS NOT NULL ORDER BY sort, id').all() as { owner: string }[]
  const seen = new Map<string, string>()
  for (const n of [...earners.map((e) => e.earner), ...owners.map((o) => o.owner)]) {
    const t = n.trim()
    if (t && !/^joint$/i.test(t) && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
  }
  return [...seen.values()]
}

/**
 * Everything one account's drawer shows: the account, its own open positions
 * and totals (lots pooled in this account alone — the same arithmetic as
 * getPortfolio, so its values are exactly that account's share of the
 * portfolio), its balance history (a lots account's cash balances), its
 * derived cash, its unvested grants and the counts.
 */
export function getInvestAccount(db: DbLike, id: number, today: string): InvestAccountDetail {
  if (!Number.isSafeInteger(id) || id <= 0) notFound('no such investment account')
  const account = accountRows(db, id)[0]
  if (!account) notFound('no such investment account')
  const pf = portfolioOf(db, today, id)
  return {
    account,
    positions: pf.positions,
    totals: pf.totals,
    warnings: pf.warnings,
    balances: listBalanceSnapshots(db, { accountId: id }),
    grants: getUnvested(db, { accountId: id }).rows,
    counts: account.counts,
    cash: pf.accounts[0] ?? null,
  }
}

/**
 * Delete an account and every dated fact recorded against it — trades, balance
 * snapshots, unvested shares. Nothing is derived-and-stored, so holdings, net
 * worth and the tax picture simply recompute without it. Paychecks that named
 * it as their stock-comp destination lose only that link. Assets left with no
 * trades and no unvested shares go too, along with their price history.
 */
export function deleteInvestAccount(db: DbLike, id: number) {
  const row = db.prepare('SELECT id, name FROM invest_accounts WHERE id = ?').get(id) as
    | { id: number; name: string }
    | undefined
  if (!row) notFound('no such investment account')
  const n = (t: string) =>
    (db.prepare(`SELECT count(*) AS n FROM ${t} WHERE invest_account_id = ?`).get(id) as { n: number }).n
  const removed = { trades: n('trades'), balances: n('balance_snapshots'), unvested: n('unvested_positions') }
  const unlinkedPaychecks = n('pay_sources')
  db.transaction(() => {
    // Lots pool per account, so a sell elsewhere that names a lot from here
    // (legacy data — createTrade refuses it now) never resolved against it:
    // it already counted as zero-basis proceeds with a warning. Dropping the
    // dangling pointer turns that sell into FIFO within its own account. It
    // carries no acquisition date or basis of its own to fall back on.
    db.prepare(
      'UPDATE trades SET sold_lot_trade_id = NULL WHERE sold_lot_trade_id IN (SELECT id FROM trades WHERE invest_account_id = ?)',
    ).run(id)
    db.prepare('UPDATE pay_sources SET invest_account_id = NULL WHERE invest_account_id = ?').run(id)
    for (const t of ['rsu_vests', 'unvested_positions', 'balance_snapshots', 'trades'])
      db.prepare(`DELETE FROM ${t} WHERE invest_account_id = ?`).run(id)
    db.prepare('DELETE FROM invest_accounts WHERE id = ?').run(id)
    dropOrphanAssets(db)
  })()
  return { ok: true as const, name: row!.name, removed, unlinkedPaychecks }
}

/**
 * Assets nothing refers to any more — no trades, no unvested shares, no
 * legacy vests — go, with their price history (`onlyAssetId` checks just
 * that one). A symbol recorded again later starts fresh: its kind is chosen
 * anew and its history backfills again.
 */
function dropOrphanAssets(db: DbLike, onlyAssetId?: number) {
  const orphanWhere = `id NOT IN (SELECT asset_id FROM trades)
     AND id NOT IN (SELECT asset_id FROM unvested_positions)
     AND id NOT IN (SELECT asset_id FROM rsu_vests)`
  const orphans = (
    onlyAssetId === undefined
      ? db.prepare(`SELECT id, symbol FROM assets WHERE ${orphanWhere}`).all()
      : db.prepare(`SELECT id, symbol FROM assets WHERE ${orphanWhere} AND id = ?`).all(onlyAssetId)
  ) as { id: number; symbol: string }[]
  for (const a of orphans) {
    db.prepare('DELETE FROM prices WHERE asset_id = ?').run(a.id)
    db.prepare('DELETE FROM prices_daily WHERE asset_id = ?').run(a.id)
    // So a symbol added back later backfills its history again, every flag
    // the price fetchers keep for it goes (engine/prices.ts priceFlags). A
    // hand-entered price's provenance goes with the price it described.
    const keys = [...priceFlagKeys(a.symbol), manualPriceKey(a.symbol)]
    db.prepare(`DELETE FROM app_meta WHERE key IN (${keys.map(() => '?').join(', ')})`).run(...keys)
    db.prepare('DELETE FROM assets WHERE id = ?').run(a.id)
  }
  return orphans.length
}

/** A real calendar day in yyyy-mm-dd (the isoDay shape alone lets 2026-02-30 through). */
const isRealDay = isRealIsoDay

/** The most statement balances one PUT may carry (the backfill grid sends 8). */
export const MAX_BALANCE_BATCH = 100

/**
 * Record what an account was worth on a day, as its statement or the
 * provider's site shows it. One snapshot, or a batch — `{ investAccountId,
 * balances: [{ balancedOn, balanceCents }, …] }` — written in one transaction
 * after every entry is checked. A day that already has a balance is
 * overwritten. Balances are known once the day has happened: nothing after
 * `today`.
 */
export function putBalanceSnapshot(
  db: DbLike,
  b: {
    investAccountId?: number
    balancedOn?: string
    balanceCents?: number
    balances?: { balancedOn?: string; balanceCents?: number }[]
  },
  today: string,
) {
  const batch = b.balances !== undefined
  if (batch && (b.balancedOn !== undefined || b.balanceCents !== undefined))
    bad('send balancedOn/balanceCents or balances[], not both')
  const entries = batch ? b.balances : [{ balancedOn: b.balancedOn, balanceCents: b.balanceCents }]
  if (!b.investAccountId || !Array.isArray(entries) || entries.length === 0)
    bad(
      batch
        ? 'investAccountId and a non-empty balances[] required'
        : 'investAccountId, balancedOn (yyyy-mm-dd), integer balanceCents required',
    )
  if (entries.length > MAX_BALANCE_BATCH) bad(`at most ${MAX_BALANCE_BATCH} balances at once`)
  const seen = new Set<string>()
  entries.forEach((e, i) => {
    const where = batch ? `balances[${i}]: ` : ''
    if (!e || !isRealDay(e.balancedOn) || !Number.isSafeInteger(e.balanceCents))
      bad(`${where}balancedOn (a real yyyy-mm-dd day) and integer balanceCents required`)
    if (e.balancedOn! > today) bad(`${where}${e.balancedOn} is after today (${today}) — a balance is recorded once the day has happened`)
    if (seen.has(e.balancedOn!)) bad(`${where}${e.balancedOn} appears twice`)
    seen.add(e.balancedOn!)
  })
  // Any tracking: a snapshot on a lots account is how a brokerage's cash
  // balance gets anchored, so only existence is checked here.
  if (!db.prepare('SELECT id FROM invest_accounts WHERE id = ?').get(b.investAccountId))
    notFound('no such investment account')
  const upsert = db.prepare(
    `INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (?, ?, ?)
     ON CONFLICT (invest_account_id, balanced_on) DO UPDATE SET balance_cents = excluded.balance_cents`,
  )
  db.transaction(() => {
    for (const e of entries) upsert.run(b.investAccountId, e.balancedOn, e.balanceCents)
  })()
  return { ok: true as const, written: entries.length }
}

/** Every recorded balance, per account and newest first; `accountId` narrows to one account. */
export function listBalanceSnapshots(db: DbLike, q: { accountId?: string | number | null } = {}): BalanceSnapshotRow[] {
  const raw = q.accountId
  if (raw === undefined || raw === null || raw === '')
    return db
      .prepare(
        'SELECT invest_account_id, balanced_on, balance_cents FROM balance_snapshots ORDER BY invest_account_id, balanced_on DESC',
      )
      .all() as BalanceSnapshotRow[]
  const id = Number(raw)
  if (!Number.isSafeInteger(id) || id <= 0) bad('accountId must be a positive integer')
  return db
    .prepare(
      'SELECT invest_account_id, balanced_on, balance_cents FROM balance_snapshots WHERE invest_account_id = ? ORDER BY balanced_on DESC',
    )
    .all(id) as BalanceSnapshotRow[]
}

/** Remove one recorded balance — a typo'd day, or a statement entered twice. */
export function deleteBalanceSnapshot(db: DbLike, accountId: number, balancedOn: string) {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !isoDay.test(balancedOn ?? ''))
    bad('an account id and a yyyy-mm-dd day are required')
  const r = db
    .prepare('DELETE FROM balance_snapshots WHERE invest_account_id = ? AND balanced_on = ?')
    .run(accountId, balancedOn)
  if (r.changes === 0) notFound(`no balance is recorded for that account on ${balancedOn}`)
  return { ok: true as const }
}

/* ---------- assets ---------- */

type AssetHit = { id: number; symbol: string; kind: 'stock' | 'crypto' }

/**
 * The recorded asset a symbol (already trimmed and upper-cased) means: that
 * exact spelling, else — for a stock — the same security under its other
 * class-share spelling. BRK.B and BRK-B are one stock (the market list spells
 * class shares with a dash, statements with a dot), so picking either never
 * opens a second holding beside the first. Undefined for a symbol Scarab
 * hasn't recorded.
 */
export function findAsset(db: DbLike, symbol: string): AssetHit | undefined {
  const get = db.prepare('SELECT id, symbol, kind FROM assets WHERE symbol = ?')
  const exact = get.get(symbol) as AssetHit | undefined
  if (exact) return exact
  for (const alt of new Set([symbol.replace(/\./g, '-'), symbol.replace(/-/g, '.')])) {
    if (alt === symbol) continue
    const hit = get.get(alt) as AssetHit | undefined
    if (hit?.kind === 'stock') return hit
  }
  return undefined
}

/** Every recorded symbol with its kind, by symbol — what the symbol box locks a kind from. */
export function listAssets(db: DbLike): AssetRow[] {
  return db.prepare('SELECT id, symbol, kind FROM assets ORDER BY symbol').all() as AssetRow[]
}

/** "1 share", "2.5 shares": a share count, for a message. */
export const sharesText = (micro: number): string => `${formatQtyMicro(micro)} ${micro === 1_000_000 ? 'share' : 'shares'}`

/** A trade that passed validateTrade: every field parsed, the asset resolved. */
export type ValidTrade = {
  investAccountId: number
  symbol: string
  assetKind: 'stock' | 'crypto'
  /** null: a symbol Scarab hasn't recorded yet (a buy creates it). */
  assetId: number | null
  side: 'buy' | 'sell'
  tradedOn: string
  qtyMicro: number
  totalCents: number
  soldLotTradeId: number | null
  acquiredOn: string | null
  basisCents: number | null
}

/**
 * The rules every trade meets, whether it's being recorded, edited or
 * previewed — read-only, so a refused trade has written nothing. `today` is
 * the household's day: a trade dated after it hasn't happened.
 *
 * `acquiredOn` means two things. On a sell with `basisCents` it is the
 * explicit basis's acquisition (shares Scarab never tracked). On a buy it is
 * when the shares were really acquired, if earlier than the day they were
 * booked here — the lot's holding period starts then (engine/lots.ts).
 */
export function validateTrade(db: DbLike, b: Partial<Record<keyof TradeBody, unknown>>, today: string): ValidTrade {
  if (
    !b.investAccountId ||
    typeof b.symbol !== 'string' ||
    !b.symbol.trim() ||
    !['stock', 'crypto'].includes(b.assetKind as string) ||
    !['buy', 'sell'].includes(b.side as string) ||
    typeof b.tradedOn !== 'string' ||
    !isoDay.test(b.tradedOn) ||
    !b.qty ||
    !Number.isSafeInteger(b.totalCents) ||
    (b.totalCents as number) < 0
  )
    bad('investAccountId, symbol, assetKind, side, tradedOn, qty, totalCents required')
  const tradedOn = b.tradedOn as string
  if (!isRealDay(tradedOn)) bad(`tradedOn ${tradedOn} is not a real day`)
  if (tradedOn > today) bad(`tradedOn ${tradedOn} is after today (${today}) — record a trade once it has happened`)
  if (!db.prepare("SELECT id FROM invest_accounts WHERE id = ? AND tracking = 'lots'").get(b.investAccountId))
    notFound('no such lots-tracked investment account')
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(String(b.qty))
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
  }
  const isSell = b.side === 'sell'
  if (!isSell && b.basisCents != null) bad("basisCents is for selling shares Scarab never tracked — a buy's cost is its totalCents")
  if (!isSell && b.acquiredOn != null) {
    if (!isRealDay(b.acquiredOn)) bad('acquiredOn must be a real yyyy-mm-dd day')
    if (b.acquiredOn > tradedOn) bad('acquiredOn must be on or before tradedOn — shares are acquired before they are booked')
  }
  const explicit = isSell && (b.acquiredOn != null || b.basisCents != null)
  if (explicit && (!isRealDay(b.acquiredOn) || !Number.isSafeInteger(b.basisCents) || (b.basisCents as number) < 0))
    bad('explicit basis needs side=sell, acquiredOn (yyyy-mm-dd), integer basisCents')
  if (explicit && (b.acquiredOn as string) > tradedOn) bad('acquiredOn must be on or before the sale date')
  if (b.soldLotTradeId != null && (!isSell || explicit)) bad('soldLotTradeId is for sells and excludes explicit basis')

  const typed = b.symbol!.trim().toUpperCase()
  const existing = findAsset(db, typed)
  // A recorded security keeps its spelling (BRK.B typed as BRK-B is the same holding).
  const symbol = existing?.symbol ?? typed
  if (existing && existing.kind !== b.assetKind)
    bad(`${symbol} is already recorded as ${existing.kind === 'crypto' ? 'crypto' : 'a stock/ETF'} — pick that kind`)
  if (b.soldLotTradeId != null) {
    const lot = (Number.isSafeInteger(b.soldLotTradeId)
      ? db.prepare("SELECT invest_account_id, asset_id, traded_on, note FROM trades WHERE id = ? AND side = 'buy'").get(b.soldLotTradeId)
      : undefined) as { invest_account_id: number; asset_id: number; traded_on: string; note: string | null } | undefined
    if (!lot) bad('soldLotTradeId does not reference a buy')
    // Lots pool per account (as the brokerage and the IRS pool them): a sale
    // can only consume shares this account holds, of this very asset.
    if (lot!.invest_account_id !== b.investAccountId) bad('that lot belongs to a different account')
    if (!existing || lot!.asset_id !== existing.id) bad(`that lot is not a ${symbol} lot`)
    // A lot exists from the day it was booked — a starting position from its
    // as-of date, whatever its acquisition date says.
    if (lot!.traded_on > tradedOn)
      bad(
        lot!.note === OPENING_NOTE
          ? `that lot is on the books from ${lot!.traded_on} (its starting-position date), after this sale`
          : `that lot was bought on ${lot!.traded_on}, after this sale`,
      )
  }
  return {
    investAccountId: b.investAccountId as number,
    symbol,
    assetKind: b.assetKind as 'stock' | 'crypto',
    assetId: existing?.id ?? null,
    side: b.side as 'buy' | 'sell',
    tradedOn,
    qtyMicro,
    totalCents: b.totalCents as number,
    soldLotTradeId: (b.soldLotTradeId as number | null | undefined) ?? null,
    acquiredOn: (b.acquiredOn as string | null | undefined) ?? null,
    basisCents: (b.basisCents as number | null | undefined) ?? null,
  }
}

/**
 * Record one buy or sell in a lots-tracked account. validateTrade runs every
 * check before the first write, so a refused trade leaves the database (and
 * an in-tab session's dirty flag) untouched.
 */
export function createTrade(db: DbLike, b: Partial<Record<keyof TradeBody, unknown>>, today: string) {
  const v = validateTrade(db, b, today)
  db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING').run(v.symbol, v.assetKind)
  const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(v.symbol) as { id: number }
  const r = db
    .prepare(
      `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents,
                           sold_lot_trade_id, acquired_on, basis_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(v.investAccountId, asset.id, v.tradedOn, v.side, v.qtyMicro, v.totalCents, v.soldLotTradeId, v.acquiredOn, v.basisCents)
  return { id: Number(r.lastInsertRowid) }
}

/* ---------- starting positions ---------- */

// The notes that mark what a trade is (a starting position, a vest, a vest's
// withholding) are part of the brokerage contract; re-exported for the engine's importers.
export { OPENING_NOTE, RSU_VEST_NOTE, RSU_WITHHOLDING_NOTE }
/** The most lots one paste may carry. */
export const MAX_OPENING_ROWS = 500

/**
 * Bring in lots an account already holds as of a date — pasted from a
 * statement or typed. Each row becomes a buy booked on `asOf` (Scarab's
 * records of the account start there, so a sale dated earlier can't touch
 * it) that keeps its real acquisition date in `acquired_on`, which sets its
 * holding period, and its total cost basis as the buy's total.
 *
 * All or nothing: every row is checked first, and if any fails nothing is
 * written and `errors` says which (by index into `rows`). Warnings never
 * block: a row with no acquisition date (its holding period then starts on
 * asOf), or a symbol this account already has trades in.
 *
 * A new symbol's kind: the row's `assetKind`, else crypto in a crypto
 * account, else stock. A symbol already recorded keeps its kind.
 */
export function createOpeningPositions(
  db: DbLike,
  b: {
    investAccountId?: number
    asOf?: string
    rows?: { symbol?: unknown; qty?: unknown; basisCents?: unknown; acquiredOn?: unknown; assetKind?: unknown }[]
  },
  today: string,
): OpeningPositionsResult {
  if (!b.investAccountId || !isRealDay(b.asOf) || !Array.isArray(b.rows))
    bad('investAccountId, asOf (a real yyyy-mm-dd day) and rows[] required')
  if (b.asOf! > today) bad(`asOf ${b.asOf} is after today (${today}) — starting positions are as of a statement date that has passed`)
  if (b.rows!.length === 0) bad('no rows — paste at least one position')
  if (b.rows!.length > MAX_OPENING_ROWS) bad(`at most ${MAX_OPENING_ROWS} rows at once`)
  const account = db.prepare("SELECT id, name, kind FROM invest_accounts WHERE id = ? AND tracking = 'lots'").get(b.investAccountId) as
    | { id: number; name: string; kind: InvestKind }
    | undefined
  if (!account) notFound('no such lots-tracked investment account')
  const asOf = b.asOf!

  const assetOf = db.prepare('SELECT id, kind FROM assets WHERE symbol = ?')
  const heldHere = db.prepare('SELECT count(*) AS n FROM trades WHERE invest_account_id = ? AND asset_id = ?')
  const kindOf = new Map<string, 'stock' | 'crypto'>() // symbols new to Scarab, as resolved in this batch
  // New stocks by symbolKey: BRK.B and BRK-B in one paste are one stock (the first spelling).
  const stockSpelling = new Map<string, string>()
  const errors: OpeningPositionsResult['errors'] = []
  const warnings: OpeningPositionsResult['warnings'] = []
  const valid: { symbol: string; kind: 'stock' | 'crypto'; qtyMicro: number; basisCents: number; acquiredOn: string | null }[] = []

  b.rows!.forEach((r, row) => {
    const fail = (message: string) => errors.push({ row, message })
    const typed = typeof r?.symbol === 'string' ? r.symbol.trim().toUpperCase() : ''
    if (!typed || typed.length > 20 || /\s/.test(typed)) return fail('a symbol is required (no spaces, up to 20 characters)')
    const existing = findAsset(db, typed)
    const symbol = existing?.symbol ?? stockSpelling.get(symbolKey(typed)) ?? typed
    let qtyMicro: number
    try {
      qtyMicro = parseQtyMicro(typeof r.qty === 'string' ? r.qty : '')
    } catch (e) {
      return fail(`${symbol}: shares — ${e instanceof Error ? e.message : 'unparseable'}`)
    }
    if (!Number.isSafeInteger(r.basisCents) || (r.basisCents as number) < 0)
      return fail(`${symbol}: cost basis must be whole cents, $0 or more`)
    let acquiredOn: string | null = null
    if (r.acquiredOn !== undefined && r.acquiredOn !== null && r.acquiredOn !== '') {
      if (!isRealDay(r.acquiredOn)) return fail(`${symbol}: acquired must be a real yyyy-mm-dd day`)
      if (r.acquiredOn > asOf) return fail(`${symbol}: acquired ${r.acquiredOn} is after the as-of date ${asOf}`)
      acquiredOn = r.acquiredOn
    }
    if (r.assetKind !== undefined && r.assetKind !== 'stock' && r.assetKind !== 'crypto')
      return fail(`${symbol}: assetKind must be stock or crypto`)
    let kind: 'stock' | 'crypto'
    if (existing) {
      if (r.assetKind !== undefined && r.assetKind !== existing.kind)
        return fail(`${symbol} is already recorded as ${existing.kind === 'crypto' ? 'crypto' : 'a stock/ETF'}`)
      kind = existing.kind
      if ((heldHere.get(account!.id, existing.id) as { n: number }).n > 0)
        warnings.push({ row, message: `${account!.name} already has ${symbol} trades — this lot is added to them` })
    } else {
      const wanted = (r.assetKind as 'stock' | 'crypto' | undefined) ?? kindOf.get(symbol) ?? (account!.kind === 'crypto' ? 'crypto' : 'stock')
      if (kindOf.has(symbol) && kindOf.get(symbol) !== wanted) return fail(`${symbol} is given two kinds in this paste`)
      kindOf.set(symbol, wanted)
      if (wanted === 'stock' && !stockSpelling.has(symbolKey(symbol))) stockSpelling.set(symbolKey(symbol), symbol)
      kind = wanted
    }
    if (acquiredOn === null)
      warnings.push({ row, message: `${symbol}: no acquisition date — its holding period starts on ${asOf}` })
    valid.push({ symbol, kind, qtyMicro, basisCents: r.basisCents as number, acquiredOn })
  })
  if (errors.length > 0) return { created: 0, tradeIds: [], errors, warnings }

  const newAsset = db.prepare('INSERT INTO assets (symbol, kind) VALUES (?, ?) ON CONFLICT (symbol) DO NOTHING')
  const insert = db.prepare(
    `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, acquired_on, note)
     VALUES (?, ?, ?, 'buy', ?, ?, ?, ?)`,
  )
  const tradeIds = db.transaction(() =>
    valid.map((v) => {
      newAsset.run(v.symbol, v.kind)
      const asset = assetOf.get(v.symbol) as { id: number }
      return Number(insert.run(account!.id, asset.id, asOf, v.qtyMicro, v.basisCents, v.acquiredOn, OPENING_NOTE).lastInsertRowid)
    }),
  )()
  return { created: tradeIds.length, tradeIds, errors: [], warnings }
}

/* ---------- the activity ledger ---------- */

type TradeDbRow = {
  id: number
  traded_on: string
  side: 'buy' | 'sell'
  qty_micro: number
  total_cents: number
  asset_id: number
  symbol: string
  asset_kind: 'stock' | 'crypto'
  invest_account_id: number
  account_name: string
  note: string | null
  acquired_on: string | null
  sold_lot_trade_id: number | null
  basis_cents: number | null
}

const TRADE_SELECT = `SELECT t.id, t.traded_on, t.side, t.qty_micro, t.total_cents, t.asset_id, a.symbol, a.kind AS asset_kind,
         t.invest_account_id, ia.name AS account_name, t.note, t.acquired_on, t.sold_lot_trade_id, t.basis_cents
  FROM trades t JOIN assets a ON a.id = t.asset_id JOIN invest_accounts ia ON ia.id = t.invest_account_id`

/**
 * The sells whose basis comes from buy `buyId`: every sale that took shares
 * from its lot, plus any sell that names it as its chosen lot (even one that
 * never resolved against it — legacy cross-account picks).
 */
function dependentSells(sales: Sale[], pointers: { id: number; sold_lot_trade_id: number }[], buyId: number): Set<number> {
  const out = new Set<number>()
  for (const s of sales) if (s.trade_id !== null && s.parts.some((p) => p.lot_trade_id === buyId)) out.add(s.trade_id)
  for (const p of pointers) if (p.sold_lot_trade_id === buyId) out.add(p.id)
  return out
}

const pointerSells = (db: DbLike) =>
  db.prepare('SELECT id, sold_lot_trade_id FROM trades WHERE sold_lot_trade_id IS NOT NULL').all() as { id: number; sold_lot_trade_id: number }[]

/**
 * Every trade, newest first — no cap. `accountId`, `symbol` and `year`
 * narrow it. Sells carry their realized gain by term (lots pooled per
 * account, every trade in the holding considered); buys carry how many sells
 * took shares from their lot, which is what deleting one would rewrite.
 */
export function listTrades(db: DbLike, q: { accountId?: unknown; symbol?: unknown; year?: unknown } = {}): TradeRow[] {
  const where: string[] = []
  const params: unknown[] = []
  if (q.accountId !== undefined && q.accountId !== null && q.accountId !== '') {
    const id = Number(q.accountId)
    if (!Number.isSafeInteger(id) || id <= 0) bad('accountId must be a positive integer')
    where.push('t.invest_account_id = ?')
    params.push(id)
  }
  if (q.symbol !== undefined && q.symbol !== null && q.symbol !== '') {
    where.push('a.symbol = ?')
    params.push(String(q.symbol).trim().toUpperCase())
  }
  if (q.year !== undefined && q.year !== null && q.year !== '') {
    if (typeof q.year !== 'string' || !/^\d{4}$/.test(q.year)) bad('year must be yyyy')
    where.push('substr(t.traded_on, 1, 4) = ?')
    params.push(q.year)
  }
  const rows = db
    .prepare(`${TRADE_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY t.traded_on DESC, t.id DESC`)
    .all(...params) as TradeDbRow[]

  // Re-derive each holding the listed trades belong to, whole.
  const sales = new Map<number, Sale>()
  const holdingSales = new Map<string, Sale[]>()
  for (const r of rows) {
    const key = `${r.invest_account_id}:${r.asset_id}`
    if (holdingSales.has(key)) continue
    const pos = computePosition(holdingLedger(db, r.invest_account_id, r.asset_id), ALL_TIME)
    holdingSales.set(key, pos.sales)
    for (const s of pos.sales) if (s.trade_id !== null) sales.set(s.trade_id, s)
  }
  const pointers = rows.some((r) => r.side === 'buy') ? pointerSells(db) : []
  // A vest's withholding sales: shown on the vest (they go with it), not as sales that depend on its lot.
  const withholding = rows.some((r) => r.side === 'buy' && r.note === RSU_VEST_NOTE)
    ? (db
        .prepare("SELECT id, sold_lot_trade_id, qty_micro FROM trades WHERE side = 'sell' AND note = ? AND sold_lot_trade_id IS NOT NULL")
        .all(RSU_WITHHOLDING_NOTE) as { id: number; sold_lot_trade_id: number; qty_micro: number }[])
    : []

  return rows.map((r) => {
    const row: TradeRow = {
      id: r.id,
      traded_on: r.traded_on,
      side: r.side,
      qty_micro: r.qty_micro,
      total_cents: r.total_cents,
      asset_id: r.asset_id,
      symbol: r.symbol,
      invest_account_id: r.invest_account_id,
      account_name: r.account_name,
      note: r.note,
      acquired_on: r.acquired_on,
      sold_lot_trade_id: r.sold_lot_trade_id,
      basis_cents: r.basis_cents,
    }
    if (r.side === 'sell') {
      const s = sales.get(r.id)
      if (s) row.realized = { ...saleRealized(s), zero_basis_cents: s.zero_basis_cents }
    } else {
      const deps = dependentSells(holdingSales.get(`${r.invest_account_id}:${r.asset_id}`) ?? [], pointers, r.id)
      if (r.note === RSU_VEST_NOTE) {
        const own = withholding.filter((w) => w.sold_lot_trade_id === r.id)
        for (const w of own) deps.delete(w.id)
        row.withheld_qty_micro = own.reduce((n, w) => n + w.qty_micro, 0)
      }
      row.dependents = deps.size
    }
    return row
  })
}

const IMMUTABLE = "account, symbol, kind and side can't change — delete the trade and record it again"

const sameSale = (a: Sale, b: Sale) =>
  a.zero_basis_cents === b.zero_basis_cents &&
  a.zero_basis_qty_micro === b.zero_basis_qty_micro &&
  a.parts.length === b.parts.length &&
  a.parts.every((p, i) => {
    const q = b.parts[i]!
    return p.lot_trade_id === q.lot_trade_id && p.qty_micro === q.qty_micro && p.cost_cents === q.cost_cents && p.proceeds_cents === q.proceeds_cents && p.term === q.term
  })

/**
 * Fix a recorded trade: its date, shares, total, and how a sell finds its
 * basis (FIFO, a chosen lot, or an explicit acquisition date and basis) — or
 * a buy's real acquisition date. Account, symbol, kind and side are the
 * trade's identity: changing those is a delete and a new trade.
 *
 * The edit meets every rule a new trade does (validateTrade), and then the
 * account's holding is replayed with it: an edit that would leave another
 * sale short of shares to sell — a buy moved after the sale that took from
 * it, shrunk below what was sold, a sale moved ahead of a later one's lot —
 * is refused. Gains that simply change (a corrected cost, an earlier
 * acquisition date, FIFO re-resolving) are the point of the edit; `affected`
 * counts the other sales whose realized gain moved. An edit that changes
 * nothing writes nothing.
 *
 * A vest and the shares withheld from it stay one event: correcting a vest's
 * value, shares or day re-prices its withholding sales at their cost share of
 * it, on its day — still exactly $0 gain; a withholding sale's own edit is
 * how many shares (its value follows the vest).
 */
export function updateTrade(db: DbLike, id: number, b: Record<string, unknown>, today: string): TradeUpdateResult {
  const row = (Number.isSafeInteger(id) ? db.prepare(`${TRADE_SELECT} WHERE t.id = ?`).get(id) : undefined) as TradeDbRow | undefined
  if (!row) notFound('no such trade')
  const r = row!
  if (!b || typeof b !== 'object') bad('a JSON object of the fields to change is required')
  if (b.investAccountId !== undefined && Number(b.investAccountId) !== r.invest_account_id) bad(IMMUTABLE)
  if (b.side !== undefined && b.side !== r.side) bad(IMMUTABLE)
  if (b.assetKind !== undefined && b.assetKind !== r.asset_kind) bad(IMMUTABLE)
  if (b.symbol !== undefined && (typeof b.symbol !== 'string' || b.symbol.trim().toUpperCase() !== r.symbol)) bad(IMMUTABLE)
  // The note marks what a buy is (an RSU vest counts as pay on Taxes; a
  // starting position isn't a cash purchase) — not free text to retype.
  if (b.note !== undefined && b.note !== r.note) bad("a trade's note can't be edited")
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k)
  // Shares withheld at a vest are sold from that vest's lot, that day, at that
  // lot's own cost share ($0 gain): only how many is theirs to edit.
  const vest =
    r.side === 'sell' && r.note === RSU_WITHHOLDING_NOTE && r.sold_lot_trade_id != null
      ? (db
          .prepare("SELECT id, traded_on, qty_micro, total_cents FROM trades WHERE id = ? AND side = 'buy' AND note = ?")
          .get(r.sold_lot_trade_id, RSU_VEST_NOTE) as { id: number; traded_on: string; qty_micro: number; total_cents: number } | undefined)
      : undefined
  if (vest) {
    if ((has('soldLotTradeId') && b.soldLotTradeId !== r.sold_lot_trade_id) || (has('acquiredOn') && b.acquiredOn != null) || (has('basisCents') && b.basisCents != null))
      bad('shares withheld at a vest are always sold from that vest’s lot — only how many can change')
    if (has('tradedOn') && b.tradedOn !== vest.traded_on)
      bad(`shares withheld at a vest are sold the day it vests (${vest.traded_on}) — change the vest’s date to move both`)
  }
  const v = validateTrade(
    db,
    {
      investAccountId: r.invest_account_id,
      symbol: r.symbol,
      assetKind: r.asset_kind,
      side: r.side,
      tradedOn: has('tradedOn') ? b.tradedOn : r.traded_on,
      qty: has('qty') ? b.qty : formatQtyMicro(r.qty_micro).replace(/,/g, ''),
      totalCents: has('totalCents') ? b.totalCents : r.total_cents,
      soldLotTradeId: has('soldLotTradeId') ? b.soldLotTradeId : r.sold_lot_trade_id,
      acquiredOn: has('acquiredOn') ? b.acquiredOn : r.acquired_on,
      basisCents: has('basisCents') ? b.basisCents : r.basis_cents,
    },
    today,
  )
  const next = {
    traded_on: v.tradedOn,
    qty_micro: v.qtyMicro,
    total_cents: v.totalCents,
    sold_lot_trade_id: v.soldLotTradeId,
    acquired_on: v.acquiredOn,
    basis_cents: v.basisCents,
  }
  if (vest) {
    if (v.qtyMicro > vest.qty_micro) bad(`${sharesText(v.qtyMicro)} withheld is more than the ${formatQtyMicro(vest.qty_micro)} that vested`)
    const derived = lotCostShare(vest.total_cents, v.qtyMicro, vest.qty_micro)
    // A total sent unchanged is just the form echoing it; a different one contradicts the vest.
    if (has('totalCents') && b.totalCents !== derived && b.totalCents !== r.total_cents)
      bad(
        `withheld shares are worth what they were at the vest — ${sharesText(v.qtyMicro)} is ${formatCents(derived)}; ` +
          'change the shares, or correct the vest’s value',
      )
    next.total_cents = derived
  }
  if ((Object.keys(next) as (keyof typeof next)[]).every((k) => next[k] === r[k])) return { ok: true, id, changed: false, affected: 0 }

  const ledger = holdingLedger(db, r.invest_account_id, r.asset_id)
  // A vest's withholding sales follow it: its day, and their cost share of its (new) value.
  const paired = r.side === 'buy' && r.note === RSU_VEST_NOTE ? ledger.filter((t) => t.side === 'sell' && t.note === RSU_WITHHOLDING_NOTE && t.sold_lot_trade_id === id) : []
  const withheld = paired.reduce((n, t) => n + t.qty_micro, 0)
  if (withheld > next.qty_micro)
    bad(`a vest can’t be smaller than the ${sharesText(withheld)} withheld from it — change that withholding sale first`)
  const follow = new Map(
    paired.map((t) => [t.id, { traded_on: next.traded_on, total_cents: lotCostShare(next.total_cents, t.qty_micro, next.qty_micro) }]),
  )
  const before = new Map(computePosition(ledger, ALL_TIME).sales.map((s) => [s.trade_id, s]))
  const after = computePosition(
    ledger.map((t) => (t.id === id ? { ...t, ...next } : follow.has(t.id) ? { ...t, ...follow.get(t.id)! } : t)),
    ALL_TIME,
  ).sales
  const atCost = (s: Sale) => {
    const g = saleRealized(s)
    return g.st_cents === 0 && g.lt_cents === 0 && s.zero_basis_qty_micro === 0
  }
  let affected = 0
  for (const s of after) {
    if (follow.has(s.trade_id!) || (s.trade_id === id && vest)) {
      if (!atCost(s)) bad('that edit would give a vest’s withheld shares a gain — edit the sales that took from the vest first')
      continue
    }
    if (s.trade_id === id) continue
    const was = before.get(s.trade_id)!
    if (s.zero_basis_qty_micro > was.zero_basis_qty_micro)
      bad(
        `that edit would leave the ${s.traded_on} sale of ${formatQtyMicro(s.qty_micro)} ${r.symbol} in ${r.account_name} ` +
          `short ${sharesText(s.zero_basis_qty_micro - was.zero_basis_qty_micro)} it could sell from — edit or delete that sale first`,
      )
    if (!sameSale(s, was)) affected++
  }
  db.transaction(() => {
    db.prepare(
      'UPDATE trades SET traded_on = ?, qty_micro = ?, total_cents = ?, sold_lot_trade_id = ?, acquired_on = ?, basis_cents = ? WHERE id = ?',
    ).run(next.traded_on, next.qty_micro, next.total_cents, next.sold_lot_trade_id, next.acquired_on, next.basis_cents, id)
    const move = db.prepare('UPDATE trades SET traded_on = ?, total_cents = ? WHERE id = ?')
    for (const [tid, f] of follow) move.run(f.traded_on, f.total_cents, tid)
  })()
  return { ok: true, id, changed: true, affected }
}

/** What a rewritten sell sells, and how its basis resolves. */
type SellTerms = Pick<LedgerTrade, 'qty_micro' | 'total_cents' | 'sold_lot_trade_id' | 'acquired_on' | 'basis_cents'>
type SellRewrite = { kind: 'update'; id: number; set: SellTerms } | { kind: 'insert'; from: number; t: Omit<LedgerTrade, 'id'> }

/**
 * Delete one trade, in one transaction.
 *
 * Deleting a buy removes its lot, but the sales that already took shares
 * from it keep their realized gains: each is rewritten to carry that basis
 * explicitly (acquired on the lot's date, at the cost it took), so no gain
 * that may already be on a return moves. A FIFO sale that took from this lot
 * and others is split — the part from this lot becomes its own
 * explicit-basis sell and the rest stays FIFO, re-resolving to exactly the
 * lots it took before. Where re-running FIFO on the rest would round a lot's
 * proceeds a cent differently, each remaining part becomes a sell of the lot
 * it took instead, at exactly its proceeds. A sell that names this lot but
 * never resolved against it (proceeds already counted at zero basis) keeps
 * that as an explicit $0 basis. The replay is checked before anything is
 * written: every sale's gain and every other open lot come out the same, or
 * nothing is deleted.
 * A legacy vest record that points at the buy lets go of it. Deleting a vest
 * takes the shares withheld from it (its $0 withholding sales) along.
 *
 * Deleting a sell just removes it: its gain disappears, and later FIFO sales
 * in that account take from the lots it had taken.
 *
 * An asset left with nothing recorded against it goes too (see dropOrphanAssets).
 */
export function deleteTrade(db: DbLike, id: number): TradeDeleteResult {
  const row = (Number.isSafeInteger(id) ? db.prepare(`${TRADE_SELECT} WHERE t.id = ?`).get(id) : undefined) as TradeDbRow | undefined
  if (!row) notFound('no such trade')
  const r = row!
  const rewrites: SellRewrite[] = []
  const withholding = new Set<number>()

  if (r.side === 'buy') {
    const ledger = holdingLedger(db, r.invest_account_id, r.asset_id)
    const byId = new Map(ledger.map((t) => [t.id, t]))
    const before = computePosition(ledger, ALL_TIME)
    const zeroBasisSell = (t: { id: number; traded_on: string; qty_micro: number; total_cents: number }): SellRewrite => ({
      kind: 'update',
      id: t.id,
      set: { qty_micro: t.qty_micro, total_cents: t.total_cents, sold_lot_trade_id: null, acquired_on: t.traded_on, basis_cents: 0 },
    })
    // A vest's withholding sales go with it — one event, and their gain is
    // exactly $0, so no gain moves. (One edited off $0 is rewritten like any sale.)
    for (const s of before.sales) {
      const t = byId.get(s.trade_id!)!
      const g = saleRealized(s)
      if (r.note === RSU_VEST_NOTE && t.note === RSU_WITHHOLDING_NOTE && t.sold_lot_trade_id === id && g.st_cents === 0 && g.lt_cents === 0 && s.zero_basis_qty_micro === 0)
        withholding.add(t.id)
    }

    // The sales to rewrite. `exactParts` false keeps a split FIFO sale's
    // remainder one FIFO sell — the fewest rewrites. But FIFO allocates
    // proceeds cumulatively over whatever it sells, so a smaller remainder
    // can round a lot's share a cent differently (and move that cent between
    // short- and long-term). With `exactParts` each remaining part becomes a
    // sell of the very lot it took, at exactly the proceeds it got.
    const plan = (exactParts: boolean): SellRewrite[] => {
      const out: SellRewrite[] = []
      const handled = new Set<number>()
      for (const s of before.sales) {
        const sell = byId.get(s.trade_id!)!
        if (withholding.has(sell.id)) {
          handled.add(sell.id)
          continue
        }
        const part = s.parts.find((p) => p.lot_trade_id === id)
        const pointer = sell.sold_lot_trade_id === id
        if (!part && !pointer) continue
        handled.add(sell.id)
        if (!part) {
          out.push(zeroBasisSell(sell)) // named this lot, never resolved: it was all zero-basis
          continue
        }
        const asExplicit = { sold_lot_trade_id: null, acquired_on: part.opened_on, basis_cents: part.cost_cents }
        if (s.parts.length === 1 && s.zero_basis_qty_micro === 0) {
          out.push({ kind: 'update', id: sell.id, set: { qty_micro: sell.qty_micro, total_cents: sell.total_cents, ...asExplicit } })
          continue
        }
        const twin = (t: SellTerms): SellRewrite => ({
          kind: 'insert',
          from: sell.id,
          t: { traded_on: sell.traded_on, side: 'sell', note: sell.note, ...t },
        })
        out.push(twin({ qty_micro: part.qty_micro, total_cents: part.proceeds_cents, ...asExplicit }))
        const rest = { id: sell.id, traded_on: sell.traded_on, qty_micro: sell.qty_micro - part.qty_micro, total_cents: sell.total_cents - part.proceeds_cents }
        // A chosen-lot sale's remainder was the excess over the lot: zero-basis, and stays so.
        if (pointer) {
          out.push(zeroBasisSell(rest))
          continue
        }
        const others = s.parts.filter((p) => p !== part)
        if (exactParts && others.every((p) => p.lot_trade_id !== null)) {
          const pieces: SellTerms[] = others.map((p) => ({ qty_micro: p.qty_micro, total_cents: p.proceeds_cents, sold_lot_trade_id: p.lot_trade_id, acquired_on: null, basis_cents: null }))
          // What no lot covered stays zero-basis, now said explicitly.
          if (s.zero_basis_qty_micro > 0)
            pieces.push({ qty_micro: s.zero_basis_qty_micro, total_cents: s.zero_basis_cents, sold_lot_trade_id: null, acquired_on: sell.traded_on, basis_cents: 0 })
          const [first, ...more] = pieces
          out.push({ kind: 'update', id: sell.id, set: first! })
          for (const x of more) out.push(twin(x))
          continue
        }
        out.push({ kind: 'update', id: sell.id, set: { qty_micro: rest.qty_micro, total_cents: rest.total_cents, sold_lot_trade_id: null, acquired_on: sell.acquired_on ?? null, basis_cents: sell.basis_cents ?? null } })
      }
      // Legacy picks of this lot from another account or asset never resolved
      // against it (lots pool per account): they were zero-basis all along.
      const strays = db
        .prepare('SELECT id, traded_on, qty_micro, total_cents FROM trades WHERE sold_lot_trade_id = ?')
        .all(id) as { id: number; traded_on: string; qty_micro: number; total_cents: number }[]
      for (const t of strays) if (!handled.has(t.id)) out.push(zeroBasisSell(t))
      return out
    }

    // Replay this holding as it will be, and make sure nothing else moved.
    const keepsEveryGain = (planned: SellRewrite[]): boolean => {
      let tempId = Number.MAX_SAFE_INTEGER - planned.length
      const twinOf = new Map<number, number>()
      const replay: LedgerTrade[] = ledger.filter((t) => t.id !== id && !withholding.has(t.id)).map((t) => {
        const u = planned.find((w): w is Extract<SellRewrite, { kind: 'update' }> => w.kind === 'update' && w.id === t.id)
        return u ? { ...t, ...u.set } : t
      })
      for (const w of planned)
        if (w.kind === 'insert') {
          twinOf.set(++tempId, w.from)
          replay.push({ ...w.t, id: tempId })
        }
      const after = computePosition(replay, ALL_TIME)
      // Term by term, not just in total: a gain that stayed the same size but
      // moved between short- and long-term would change the tax.
      const wanted = new Map(before.sales.filter((s) => !withholding.has(s.trade_id!)).map((s) => [s.trade_id, saleRealized(s)]))
      const got = new Map<number | null, { st_cents: number; lt_cents: number }>()
      for (const s of after.sales) {
        const k = twinOf.get(s.trade_id!) ?? s.trade_id
        const x = saleRealized(s)
        const prev = got.get(k) ?? { st_cents: 0, lt_cents: 0 }
        got.set(k, { st_cents: prev.st_cents + x.st_cents, lt_cents: prev.lt_cents + x.lt_cents })
      }
      const lotKey = (l: { trade_id?: number; opened_on: string; qty_micro: number; cost_cents: number }) =>
        `${l.trade_id}:${l.opened_on}:${l.qty_micro}:${l.cost_cents}`
      const lotsBefore = before.lots.filter((l) => l.trade_id !== id).map(lotKey).join('|')
      const lotsAfter = after.lots.map(lotKey).join('|')
      const moved = [...wanted].some(([k, g]) => got.get(k)?.st_cents !== g.st_cents || got.get(k)?.lt_cents !== g.lt_cents)
      return !moved && lotsBefore === lotsAfter
    }

    let planned = plan(false)
    if (!keepsEveryGain(planned)) {
      planned = plan(true)
      if (!keepsEveryGain(planned))
        bad("can't delete this buy without changing other sales' realized gains — edit or delete the sales that took from it first")
    }
    rewrites.push(...planned)
  }

  const insert = db.prepare(
    `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, acquired_on, basis_cents, note)
     VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?)`,
  )
  const update = db.prepare('UPDATE trades SET qty_micro = ?, total_cents = ?, sold_lot_trade_id = ?, acquired_on = ?, basis_cents = ? WHERE id = ?')
  const out = db.transaction(() => {
    for (const w of rewrites) {
      if (w.kind === 'update') update.run(w.set.qty_micro, w.set.total_cents, w.set.sold_lot_trade_id, w.set.acquired_on, w.set.basis_cents, w.id)
      else insert.run(r.invest_account_id, r.asset_id, w.t.traded_on, w.t.qty_micro, w.t.total_cents, w.t.sold_lot_trade_id, w.t.acquired_on, w.t.basis_cents, w.t.note)
    }
    const drop = db.prepare('DELETE FROM trades WHERE id = ?')
    for (const w of withholding) drop.run(w)
    const unlinkedVests = db.prepare('UPDATE rsu_vests SET converted_trade_id = NULL WHERE converted_trade_id = ?').run(id).changes
    db.prepare('DELETE FROM trades WHERE id = ?').run(id)
    dropOrphanAssets(db, r.asset_id)
    return { unlinkedVests }
  })()
  const rewritten = new Set(rewrites.map((w) => (w.kind === 'update' ? w.id : w.from))).size
  return { ok: true, id, rewritten, unlinkedVests: out.unlinkedVests, withholdingRemoved: withholding.size }
}

/**
 * Every open position as of today, one per symbol, split by account. Lots and
 * holding periods are pooled per account (engine/holdings.ts), so the same
 * ticker in a taxable account and a Roth never shares a FIFO queue.
 *
 * Values are computed per (account, asset) and summed upward: an account's
 * value is its shares at the latest price (at cost while unpriced), and a
 * position's value is the sum of its accounts' — the same arithmetic net
 * worth uses. `totals.value` is the holdings alone (the positions summed);
 * `totals.cash` is the derived cash of every account with a cash balance
 * recorded (see PortfolioAccount), and value + cash equals the current
 * month's lots-account value in `netWorthSeries` to the cent.
 *
 * Realized year-to-date gains split by shelter: `ytd_st` / `ytd_lt` count
 * taxable accounts only (what reaches the tax bill); `ytd_sheltered` is what
 * was realized inside tax-advantaged ones.
 */
export function getPortfolio(db: DbLike, today: string): PortfolioResponse {
  return portfolioOf(db, today)
}

/** getPortfolio's arithmetic over every lots account, or over one (`accountId`: the account drawer). */
function portfolioOf(db: DbLike, today: string, accountId?: number): PortfolioResponse {
  const latestPrice = db.prepare(
    'SELECT close_cents, priced_on FROM prices WHERE asset_id = ? ORDER BY priced_on DESC LIMIT 1',
  )
  const manual = manualPriceMarks(db)
  const priceOf = new Map<number, { close_cents: number; priced_on: string } | undefined>()
  const positions = new Map<number, PortfolioPosition>()
  const totals = { value: 0, cost: 0, unrealized: 0, cash: 0, ytd_st: 0, ytd_lt: 0, ytd_sheltered: 0 }
  const warnings: string[] = []
  const valueOf = new Map<number, number>() // holdings value per account

  for (const h of loadHoldings(db, today, accountId === undefined ? {} : { accountId })) {
    const { pos } = h
    for (const w of pos.warnings) warnings.push(`${h.symbol} · ${h.accountName}: ${w}`)
    if (h.sheltered) totals.ytd_sheltered += pos.realized_ytd_st_cents + pos.realized_ytd_lt_cents
    else {
      totals.ytd_st += pos.realized_ytd_st_cents
      totals.ytd_lt += pos.realized_ytd_lt_cents
    }
    if (pos.qty_micro === 0) continue

    if (!priceOf.has(h.assetId)) priceOf.set(h.assetId, latestPrice.get(h.assetId) as { close_cents: number; priced_on: string } | undefined)
    const price = priceOf.get(h.assetId)
    const value = price ? positionValueCents(pos.qty_micro, price.close_cents) : pos.cost_cents

    let p = positions.get(h.assetId)
    if (!p) {
      p = {
        asset_id: h.assetId,
        symbol: h.symbol,
        kind: h.assetKind,
        qty_micro: 0,
        cost_cents: 0,
        price_cents: price?.close_cents ?? null,
        priced_on: price?.priced_on ?? null,
        value_cents: 0,
        unrealized_cents: 0,
        lots: [],
        accounts: [],
        price_manual: isManualPrice(manual.get(h.symbol), price),
      }
      positions.set(h.assetId, p)
    }
    p.qty_micro += pos.qty_micro
    p.cost_cents += pos.cost_cents
    p.value_cents += value
    p.unrealized_cents += value - pos.cost_cents
    p.accounts.push({
      invest_account_id: h.investAccountId,
      name: h.accountName,
      kind: h.accountKind,
      qty_micro: pos.qty_micro,
      cost_cents: pos.cost_cents,
      value_cents: value,
    })
    for (const l of pos.lots)
      p.lots.push({
        trade_id: l.trade_id ?? null,
        opened_on: l.opened_on,
        lt_on: longTermOn(l.opened_on),
        qty_micro: l.qty_micro,
        cost_cents: l.cost_cents,
        invest_account_id: h.investAccountId,
        account_name: h.accountName,
        sheltered: h.sheltered,
      })
    valueOf.set(h.investAccountId, (valueOf.get(h.investAccountId) ?? 0) + value)
    totals.value += value
    totals.cost += pos.cost_cents
    totals.unrealized += value - pos.cost_cents
  }

  const accounts = accountCash(db, today, accountId).map((a): PortfolioAccount => ({ ...a, value_cents: valueOf.get(a.invest_account_id) ?? 0 }))
  for (const a of accounts) {
    if (a.cash_cents !== null) totals.cash += a.cash_cents
    // A negative balance the trades produced (not a margin balance recorded as one): a deposit Scarab doesn't know about.
    if (a.cash_cents !== null && a.cash_cents < 0 && (a.cash_anchor_cents ?? 0) >= 0)
      warnings.push(
        `Cash · ${a.name}: ${formatCents(a.cash_cents)} after the trades since the ${a.cash_as_of} cash balance — ` +
          'a deposit Scarab doesn’t know about? Update the cash balance.',
      )
  }

  const out = [...positions.values()].sort((a, b) => b.value_cents - a.value_cents || a.symbol.localeCompare(b.symbol))
  return { positions: out, totals, warnings, accounts }
}

/**
 * Each lots account's cash as of today (see PortfolioAccount): the latest
 * cash balance recorded on or before today plus what the trades since did to
 * it — or, with none recorded, the sale proceeds that go uncounted.
 */
function accountCash(db: DbLike, today: string, accountId?: number): Omit<PortfolioAccount, 'value_cents'>[] {
  const rows = (
    accountId === undefined
      ? db.prepare("SELECT id, name, kind FROM invest_accounts WHERE tracking = 'lots' ORDER BY sort, id").all()
      : db.prepare("SELECT id, name, kind FROM invest_accounts WHERE tracking = 'lots' AND id = ?").all(accountId)
  ) as { id: number; name: string; kind: InvestKind }[]
  const anchorsOf = db.prepare(
    'SELECT balanced_on, balance_cents FROM balance_snapshots WHERE invest_account_id = ? AND balanced_on <= ? ORDER BY balanced_on',
  )
  const tradesOf = db.prepare('SELECT traded_on, side, total_cents, acquired_on, note FROM trades WHERE invest_account_id = ? AND traded_on <= ?')
  return rows.map((r) => {
    const trades = tradesOf.all(r.id, today) as CashTrade[]
    const cash = cashAt(anchorsOf.all(r.id, today) as { balanced_on: string; balance_cents: number }[], trades, today)
    return {
      invest_account_id: r.id,
      name: r.name,
      kind: r.kind,
      cash_cents: cash?.cents ?? null,
      cash_as_of: cash?.as_of ?? null,
      cash_anchor_cents: cash?.anchor_cents ?? null,
      cash_trades: cash?.trades ?? 0,
      uncounted_proceeds_cents: cash ? 0 : trades.reduce((sum, t) => (t.side === 'sell' ? sum + cashEffectCents(t) : sum), 0),
    }
  })
}

/* ---------- the balance check-in ---------- */

/**
 * Everything whose number comes from a statement, for one sitting: each
 * balance-tracked account's total, each lots account's cash balance (with
 * the cash Scarab derives for today from it), each home's value and each
 * loan's balance — with the latest one recorded. Read-only: the check-in
 * saves through the routes each already has.
 */
export function getCheckin(db: DbLike, today: string): CheckinResponse {
  const items: CheckinItem[] = []
  const accounts = accountRows(db)
  const cash = new Map(accountCash(db, today).map((c) => [c.invest_account_id, c]))
  const where = (a: InvestAccountRow) => [a.institution, a.mask ? `··${a.mask}` : null].filter(Boolean).join(' ') || null
  const last = (a: InvestAccountRow) => (a.latest_snapshot ? { on: a.latest_snapshot.balanced_on, cents: a.latest_snapshot.balance_cents } : null)
  for (const a of accounts)
    if (a.tracking === 'balance')
      items.push({ kind: 'balance', id: a.id, name: a.name, detail: where(a), owner: a.owner, last: last(a), derived_cents: null, uncounted_cents: 0 })
  for (const a of accounts)
    if (a.tracking === 'lots') {
      const c = cash.get(a.id)
      items.push({
        kind: 'cash',
        id: a.id,
        name: a.name,
        detail: where(a),
        owner: a.owner,
        last: last(a),
        derived_cents: c?.cash_cents ?? null,
        uncounted_cents: c?.uncounted_proceeds_cents ?? 0,
      })
    }
  const valuation = db.prepare('SELECT valued_on AS "on", value_cents AS cents FROM property_valuations WHERE property_id = ? ORDER BY valued_on DESC LIMIT 1')
  for (const p of db.prepare('SELECT id, name FROM properties ORDER BY id').all() as { id: number; name: string }[])
    items.push({ kind: 'property', id: p.id, name: p.name, detail: null, owner: null, last: (valuation.get(p.id) as CheckinItem['last'] | undefined) ?? null, derived_cents: null, uncounted_cents: 0 })
  const owed = db.prepare('SELECT balanced_on AS "on", balance_cents AS cents FROM liability_balances WHERE liability_id = ? ORDER BY balanced_on DESC LIMIT 1')
  const loans = db
    .prepare('SELECT l.id, l.name, p.name AS property FROM liabilities l LEFT JOIN properties p ON p.id = l.property_id ORDER BY l.id')
    .all() as { id: number; name: string; property: string | null }[]
  for (const l of loans)
    items.push({ kind: 'liability', id: l.id, name: l.name, detail: l.property, owner: null, last: (owed.get(l.id) as CheckinItem['last'] | undefined) ?? null, derived_cents: null, uncounted_cents: 0 })
  return { items }
}

/* ---------- hand-entered prices ---------- */

/**
 * Where a hand-entered price is remembered: app_meta `price:manual:<SYMBOL>`
 * = `{"on":"2026-09-20","cents":1234}`, the newest one set. A fact about how
 * a price row was entered (it rides the vault like any household data), so
 * the screen can say "manual · Sep 20" while that row is still the latest.
 */
export const manualPriceKey = (symbol: string) => `price:manual:${symbol}`
type ManualMark = { on: string; cents: number }

function manualPriceMarks(db: DbLike): Map<string, ManualMark> {
  const rows = db.prepare("SELECT key, value FROM app_meta WHERE key LIKE 'price:manual:%'").all() as { key: string; value: string }[]
  const out = new Map<string, ManualMark>()
  for (const r of rows) {
    try {
      const v = JSON.parse(r.value) as Partial<ManualMark>
      if (typeof v.on === 'string' && Number.isSafeInteger(v.cents)) out.set(r.key.slice('price:manual:'.length), v as ManualMark)
    } catch {
      // A malformed mark only loses the "manual" tag.
    }
  }
  return out
}

/** The latest price is the hand-entered one — same day, same close (a market quote for that day would have replaced it). */
const isManualPrice = (mark: ManualMark | undefined, price: { close_cents: number; priced_on: string } | undefined) =>
  !!mark && !!price && mark.on === price.priced_on && mark.cents === price.close_cents

/**
 * Set a price by hand, for what no quote source covers — mutual funds and
 * CITs in a tab (the shared basket lists exchange-traded symbols), private
 * company stock anywhere. The asset must already be recorded; the price is a
 * close on a day that has happened, above $0. Stored like any quote
 * (upsertPrices), plus the provenance mark.
 */
export function setManualPrice(db: DbLike, b: { symbol?: string; pricedOn?: string; cents?: number }, today: string) {
  const typed = typeof b.symbol === 'string' ? b.symbol.trim().toUpperCase() : ''
  if (!typed || !isRealDay(b.pricedOn) || !Number.isSafeInteger(b.cents))
    bad('symbol, pricedOn (a real yyyy-mm-dd day) and integer cents required')
  if (b.pricedOn > today) bad(`pricedOn ${b.pricedOn} is after today (${today}) — a price is known once its day has happened`)
  if ((b.cents as number) <= 0) bad('a price must be more than $0')
  const asset = findAsset(db, typed)
  if (!asset) notFound(`no such asset: ${typed} — record a trade in it first`)
  const symbol = asset!.symbol
  const pricedOn = b.pricedOn
  const cents = b.cents as number
  db.transaction(() => {
    upsertPrices(db, [{ symbol, cents, pricedOn }])
    const prev = manualPriceMarks(db).get(symbol)
    // Keep the newest hand-entered day: backfilling an old statement price
    // doesn't untag the current one.
    if (!prev || prev.on <= pricedOn)
      db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(
        manualPriceKey(symbol),
        JSON.stringify({ on: pricedOn, cents }),
      )
  })()
  return { ok: true as const, symbol, pricedOn, cents }
}

/* ---------- unvested RSUs ---------- */

/*
 * A grant's vest schedule is stored as facts: an anchor day (`next_vest_on`,
 * the vest date the user entered), a cadence in months, and the shares per
 * vest. The k-th vest falls k × cadence months after the anchor — always
 * counted from the anchor, never stepped from the previous date: a clamped
 * day would stick (Mar 31 → Jun 30 → Sep 30 → Dec 30, where Dec 31 is due).
 * Which vest is next is derived, never stored: the first after the latest
 * vest recorded on or after the anchor (the ledger's RSU-vest buys), else the
 * anchor itself — so a scheduled vest that passed unrecorded stays due.
 */

/** The k-th vest of a cadence (k = 0 is the anchor). */
export const vestOn = (anchor: string, everyMonths: number, k: number): string => addMonthsIso(anchor, k * everyMonths)

/** The first vest of a cadence dated after `after`, with its index. */
export function firstVestAfter(anchor: string, everyMonths: number, after: string): { on: string; k: number } {
  let k = 0
  let on = anchor
  while (on <= after && k < 400) on = vestOn(anchor, everyMonths, ++k)
  return { on, k }
}

/** The latest vest recorded in this account and asset on or after the day a schedule is anchored on. */
function lastVestSince(db: DbLike, accountId: number, assetId: number, anchor: string): string | null {
  const r = db
    .prepare(
      `SELECT max(traded_on) AS d FROM trades
       WHERE invest_account_id = ? AND asset_id = ? AND side = 'buy' AND note = ? AND traded_on >= ?`,
    )
    .get(accountId, assetId, RSU_VEST_NOTE, anchor) as { d: string | null }
  return r.d
}

/** The next vest not yet recorded (see above). */
function nextUnrecordedVest(db: DbLike, accountId: number, assetId: number, anchor: string, everyMonths: number): string {
  const last = lastVestSince(db, accountId, assetId, anchor)
  return last === null ? anchor : firstVestAfter(anchor, everyMonths, last).on
}

/** Every unvested grant (`accountId`: one account's), valued at the latest price — never counted in net worth. */
export function getUnvested(db: DbLike, opts: { accountId?: number } = {}): { rows: UnvestedRow[]; total_est_cents: number } {
  const sql = `SELECT u.invest_account_id, u.qty_micro, u.updated_on, u.next_vest_on, u.vest_every_months, u.vest_qty_micro,
              a.symbol, a.id AS asset_id, ia.name AS account_name,
              (SELECT close_cents FROM prices WHERE asset_id = a.id ORDER BY priced_on DESC LIMIT 1) AS price_cents,
              (SELECT priced_on FROM prices WHERE asset_id = a.id ORDER BY priced_on DESC LIMIT 1) AS priced_on
       FROM unvested_positions u
       JOIN assets a ON a.id = u.asset_id
       JOIN invest_accounts ia ON ia.id = u.invest_account_id`
  const rows = (
    opts.accountId === undefined
      ? db.prepare(`${sql} ORDER BY a.symbol`).all()
      : db.prepare(`${sql} WHERE u.invest_account_id = ? ORDER BY a.symbol`).all(opts.accountId)
  ) as Omit<UnvestedRow, 'est_cents'>[]
  const est = (r: { qty_micro: number; price_cents: number | null }) =>
    r.price_cents === null ? null : positionValueCents(r.qty_micro, r.price_cents)
  const next = (r: Omit<UnvestedRow, 'est_cents'>) =>
    r.next_vest_on && r.vest_every_months ? nextUnrecordedVest(db, r.invest_account_id, r.asset_id, r.next_vest_on, r.vest_every_months) : r.next_vest_on
  return {
    rows: rows.map((r) => ({ ...r, next_vest_on: next(r), est_cents: est(r) })),
    total_est_cents: rows.reduce((s, r) => s + (est(r) ?? 0), 0),
  }
}

export type VestScheduleInput = { nextVestOn?: string; vestEveryMonths?: number | string; vestQty?: string }

/** Validate an optional vest cadence. `nextVestOn` absent → leave the stored
 *  schedule alone; empty → clear it; otherwise all three fields are required. */
function parseVestSchedule(b: VestScheduleInput) {
  if (b.nextVestOn === undefined) return undefined
  if (!b.nextVestOn) return null
  if (!isRealDay(b.nextVestOn)) bad('nextVestOn must be a real YYYY-MM-DD day')
  const every = Number(b.vestEveryMonths)
  if (!Number.isInteger(every) || every < 1 || every > 24) bad('vestEveryMonths must be a whole number of months, 1–24')
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(b.vestQty ?? '')
  } catch (e) {
    throw new ApiError(400, `vestQty: ${e instanceof Error ? e.message : 'bad qty'}`)
  }
  if (qtyMicro <= 0) bad('vestQty must be positive')
  return { nextVestOn: b.nextVestOn, every, qtyMicro }
}

export function putUnvested(
  db: DbLike,
  b: { investAccountId?: number; symbol?: string; qty?: string } & VestScheduleInput,
  today: string,
) {
  if (!b.investAccountId || !b.symbol?.trim() || b.qty == null) bad('investAccountId, symbol, qty required')
  if (!db.prepare("SELECT id FROM invest_accounts WHERE id = ? AND tracking = 'lots' AND stock_plan = 1").get(b.investAccountId))
    notFound('no such employee stock plan — turn on “Employee stock plan” in the account’s Settings on Investments')
  const schedule = parseVestSchedule(b)
  const typed = b.symbol!.trim().toUpperCase()
  const known = findAsset(db, typed)
  if (known && known.kind !== 'stock') bad(`${known.symbol} is recorded as crypto — grants are company stock`)
  const symbol = known?.symbol ?? typed
  const clear = String(b.qty).trim() === '0'
  // Everything is checked before the first write: a refused grant leaves no asset behind (and a tab session clean).
  let qtyMicro = 0
  if (!clear)
    try {
      qtyMicro = parseQtyMicro(String(b.qty))
    } catch (e) {
      throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
    }
  if (clear) {
    // Clearing a grant Scarab never recorded changes nothing; clearing one drops an asset nothing else refers to.
    if (known)
      db.transaction(() => {
        db.prepare('DELETE FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?').run(b.investAccountId, known.id)
        dropOrphanAssets(db, known.id)
      })()
    return { ok: true as const, qtyMicro: 0 }
  }
  db.transaction(() => {
    db.prepare("INSERT INTO assets (symbol, kind) VALUES (?, 'stock') ON CONFLICT (symbol) DO NOTHING").run(symbol)
    const asset = db.prepare('SELECT id FROM assets WHERE symbol = ?').get(symbol) as { id: number }
    const cur = db
      .prepare('SELECT next_vest_on, vest_every_months FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?')
      .get(b.investAccountId, asset.id) as { next_vest_on: string | null; vest_every_months: number | null } | undefined
    db.prepare(
      `INSERT INTO unvested_positions (invest_account_id, asset_id, qty_micro, updated_on)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (invest_account_id, asset_id)
       DO UPDATE SET qty_micro = excluded.qty_micro, updated_on = excluded.updated_on`,
    ).run(b.investAccountId, asset.id, qtyMicro, today)
    if (schedule !== undefined) {
      // A form sends back the next vest it was shown. When that and the
      // cadence are unchanged, the schedule is too: keep its anchor, whose
      // day of the month the shown date may have clamped (Jun 30 of a Mar 31 grant).
      const unchanged =
        schedule !== null &&
        cur?.next_vest_on != null &&
        cur.vest_every_months === schedule.every &&
        nextUnrecordedVest(db, b.investAccountId!, asset.id, cur.next_vest_on, cur.vest_every_months) === schedule.nextVestOn
      db.prepare(
        'UPDATE unvested_positions SET next_vest_on = ?, vest_every_months = ?, vest_qty_micro = ? WHERE invest_account_id = ? AND asset_id = ?',
      ).run(unchanged ? cur!.next_vest_on : (schedule?.nextVestOn ?? null), schedule?.every ?? null, schedule?.qtyMicro ?? null, b.investAccountId, asset.id)
    }
  })()
  return { ok: true as const, qtyMicro }
}

/**
 * Shares vested: record them as a buy at vest-day value (the cost basis, and
 * the income Taxes counts) in the employee stock plan, and lower the unvested
 * count by the gross shares. Vesting more than is recorded as unvested is
 * refused — usually a typo, and silently clamping it would hide the mistake —
 * unless `allowUntracked` says the extra shares came from a grant Scarab
 * never tracked.
 *
 * Net settlement: `withheldQty` shares the employer kept to pay the tax
 * withholding are recorded as a same-day sale of this vest's lot at
 * round(totalCents × withheld / gross) — the very cost share the lot engine
 * takes out for them (lotCostShare), so it realizes exactly $0. Its proceeds
 * paid the tax: they never count as the account's cash. Net shares
 * (gross − withheld) are what stay.
 */
export function vestUnvested(
  db: DbLike,
  b: {
    investAccountId?: number
    symbol?: string
    qty?: string
    tradedOn?: string
    totalCents?: number
    withheldQty?: string | null
    allowUntracked?: boolean
  },
  today: string,
): VestResult {
  if (
    !b.investAccountId ||
    !b.symbol?.trim() ||
    !b.qty ||
    !isoDay.test(b.tradedOn ?? '') ||
    !Number.isSafeInteger(b.totalCents) ||
    (b.totalCents as number) <= 0
  )
    bad('investAccountId, symbol, qty, tradedOn, totalCents required')
  if (!isRealDay(b.tradedOn)) bad(`tradedOn ${b.tradedOn} is not a real day`)
  if (b.tradedOn! > today) bad(`tradedOn ${b.tradedOn} is after today (${today}) — record a vest once it has happened`)
  if (!db.prepare("SELECT id FROM invest_accounts WHERE id = ? AND tracking = 'lots' AND stock_plan = 1").get(b.investAccountId))
    notFound('no such employee stock plan — vests land in a lots-tracked account marked as one')
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(b.qty!)
  } catch (e) {
    throw new ApiError(400, e instanceof Error ? e.message : 'bad qty')
  }
  if (qtyMicro <= 0) bad('the shares vested must be more than 0')
  let withheldMicro = 0
  if (b.withheldQty != null && String(b.withheldQty).trim() !== '') {
    try {
      withheldMicro = parseQtyMicro(String(b.withheldQty))
    } catch (e) {
      throw new ApiError(400, `withheldQty: ${e instanceof Error ? e.message : 'bad qty'}`)
    }
    if (withheldMicro > qtyMicro)
      bad(`${formatQtyMicro(withheldMicro)} shares withheld is more than the ${formatQtyMicro(qtyMicro)} that vested`)
  }
  const asset = findAsset(db, b.symbol!.trim().toUpperCase())
  if (!asset) notFound('no such asset')
  const symbol = asset!.symbol
  if (asset!.kind !== 'stock') bad(`${symbol} is not a stock — only stock grants vest`)
  const cur = db
    .prepare('SELECT qty_micro FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?')
    .get(b.investAccountId, asset!.id) as { qty_micro: number } | undefined
  const unvested = cur?.qty_micro ?? 0
  if (qtyMicro > unvested && b.allowUntracked !== true)
    bad(
      unvested === 0
        ? `no unvested ${symbol} is recorded in this account — set the grant first, or confirm these shares came from an untracked grant`
        : `only ${formatQtyMicro(unvested)} ${symbol} are unvested here — vesting ${formatQtyMicro(qtyMicro)} needs confirming that the rest came from an untracked grant`,
    )
  const withheldCents = withheldMicro > 0 ? lotCostShare(b.totalCents as number, withheldMicro, qtyMicro) : 0

  return db.transaction(() => {
    const trade = db
      .prepare(
        `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, note)
         VALUES (?, ?, ?, 'buy', ?, ?, ?)`,
      )
      .run(b.investAccountId, asset!.id, b.tradedOn, qtyMicro, b.totalCents, RSU_VEST_NOTE)
    const tradeId = Number(trade.lastInsertRowid)
    let withholdingTradeId: number | null = null
    if (withheldMicro > 0)
      withholdingTradeId = Number(
        db
          .prepare(
            `INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents, sold_lot_trade_id, note)
             VALUES (?, ?, ?, 'sell', ?, ?, ?, ?)`,
          )
          .run(b.investAccountId, asset!.id, b.tradedOn, withheldMicro, withheldCents, tradeId, RSU_WITHHOLDING_NOTE).lastInsertRowid,
      )
    let remaining = 0
    if (cur) {
      remaining = Math.max(0, cur.qty_micro - qtyMicro)
      if (remaining === 0)
        db.prepare('DELETE FROM unvested_positions WHERE invest_account_id = ? AND asset_id = ?').run(
          b.investAccountId,
          asset!.id,
        )
      // The vest trade itself is what moves the schedule on: the next vest
      // is derived from the ledger (see getUnvested), and the anchor stays.
      else
        db.prepare('UPDATE unvested_positions SET qty_micro = ?, updated_on = ? WHERE invest_account_id = ? AND asset_id = ?').run(
          remaining,
          today,
          b.investAccountId,
          asset!.id,
        )
    }
    return {
      ok: true as const,
      tradeId,
      withholdingTradeId,
      grossQtyMicro: qtyMicro,
      withheldQtyMicro: withheldMicro,
      netQtyMicro: qtyMicro - withheldMicro,
      withheldCents,
      remainingQtyMicro: remaining,
    }
  })()
}
