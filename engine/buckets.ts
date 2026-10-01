import type { InvestSubtype } from '../shared/invest-api'
import type { DbLike } from './db'
import { loadHoldings } from './holdings'
import { getPortfolio, listInvestAccounts } from './invest'

/**
 * The liquid balance sheet as Future v3's three tax buckets (copilot §4c),
 * resolved from account subtypes at read time:
 *
 *   taxable      bank accounts, taxable brokerage, crypto, stock plans — with
 *                cost basis from the lots (a bank balance and a lots
 *                account's cash are their own basis; a balance-tracked
 *                taxable account's basis is unknown and taken at its value)
 *   traditional  401(k), 403(b), IRA — and a retirement account with no type
 *   roth         Roth IRA
 *   hsa          kept apart: the scenario decides (Roth by default — medical
 *                spending in retirement usually uses all of it)
 *
 * Unvested grants stay out, as they do of net worth.
 */

export type Bucket = 'taxable' | 'traditional' | 'roth' | 'hsa'
export type BucketRow = { name: string; bucket: Bucket; cents: number; basisCents: number | null }
export type Buckets = {
  taxableCents: number
  taxableBasisCents: number
  traditionalCents: number
  rothCents: number
  hsaCents: number
  /** Taxable accounts whose basis isn't known (balance-tracked): taken at value. */
  unknownBasis: string[]
  rows: BucketRow[]
}

export function bucketOf(subtype: InvestSubtype | null, kind: 'brokerage' | 'retirement' | 'crypto'): Bucket {
  switch (subtype) {
    case '401k':
    case '403b':
    case 'ira':
      return 'traditional'
    case 'roth_ira':
      return 'roth'
    case 'hsa':
      return 'hsa'
    case 'taxable':
    case 'crypto':
    case 'stock_plan':
      return 'taxable'
    default:
      return kind === 'retirement' ? 'traditional' : 'taxable'
  }
}

export function resolveBuckets(db: DbLike, today: string): Buckets {
  const rows: BucketRow[] = []
  const banks = db
    .prepare(
      `SELECT a.name, a.opening_cents + COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.account_id = a.id AND t.posted_on <= ?), 0) AS cents
       FROM accounts a ORDER BY a.id`,
    )
    .all(today) as { name: string; cents: number }[]
  for (const b of banks) rows.push({ name: b.name, bucket: 'taxable', cents: b.cents, basisCents: b.cents })

  const portfolio = new Map(getPortfolio(db, today).accounts.map((a) => [a.invest_account_id, a]))
  const cost = new Map<number, number>()
  for (const h of loadHoldings(db, today)) if (h.pos.qty_micro > 0) cost.set(h.investAccountId, (cost.get(h.investAccountId) ?? 0) + h.pos.cost_cents)
  const unknownBasis: string[] = []
  for (const a of listInvestAccounts(db)) {
    const bucket = bucketOf(a.subtype, a.kind)
    let cents: number
    let basis: number | null = null
    if (a.tracking === 'lots') {
      const p = portfolio.get(a.id)
      const cash = p?.cash_cents ?? 0
      cents = (p?.value_cents ?? 0) + cash
      basis = (cost.get(a.id) ?? 0) + cash
    } else {
      cents = a.latest_snapshot && a.latest_snapshot.balanced_on <= today ? a.latest_snapshot.balance_cents : 0
      if (bucket === 'taxable' && cents !== 0) unknownBasis.push(a.name)
    }
    rows.push({ name: a.name, bucket, cents, basisCents: bucket === 'taxable' ? (basis ?? cents) : null })
  }
  const sum = (b: Bucket) => rows.filter((r) => r.bucket === b).reduce((s, r) => s + r.cents, 0)
  return {
    taxableCents: sum('taxable'),
    taxableBasisCents: rows.filter((r) => r.bucket === 'taxable').reduce((s, r) => s + (r.basisCents ?? 0), 0),
    traditionalCents: sum('traditional'),
    rothCents: sum('roth'),
    hsaCents: sum('hsa'),
    unknownBasis,
    rows,
  }
}
