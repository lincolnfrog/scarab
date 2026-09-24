import type { ReactNode } from 'react'
import type { InvestAccountRow, PortfolioAccount, PortfolioPosition } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { OwnerAvatar } from './AccountFields'
import { accountValueCents, heldLine, institutionLine, staleReason, typeLabel, unvestedLine } from './accountTypes'
import { shortDay } from './balanceMath'
import './invest.css'

export type AccountStripProps = {
  accounts: readonly InvestAccountRow[]
  /** Portfolio positions — each lots account's value is its share of them. */
  positions: readonly PortfolioPosition[]
  /** The portfolio's per-account rows (their cash is part of a lots account's value), by account id. */
  cash?: ReadonlyMap<number, PortfolioAccount>
  /** Unvested shares per stock-plan account id (never in its value). */
  unvested: ReadonlyMap<number, number>
  owners: readonly string[]
  today: string
  /** False until the first load answers: tiles show their shape, not "no accounts". */
  loaded: boolean
  onOpen: (accountId: number) => void
  onAdd: () => void
  /** The card header's right side (prices as of · Refresh prices). */
  actions?: ReactNode
  /** Above the tiles: the owner pills. */
  filter?: ReactNode
}

/**
 * Every investment account as a compact tile — name, owner, value, type and
 * a quiet dot when its number is old — plus the dashed add tile. A tile
 * opens that account's drawer; nothing is edited here.
 */
export default function AccountStrip(p: AccountStripProps) {
  let body: ReactNode
  if (!p.loaded)
    body = (
      <ul className="inv-strip" aria-busy="true" aria-label="Loading accounts">
        {[0, 1, 2].map((i) => (
          <li key={i} className="inv-tile inv-tile-skel">
            <Skeleton h={12} w="55%" />
            <Skeleton h={20} w="70%" />
            <Skeleton h={10} w="40%" />
          </li>
        ))}
      </ul>
    )
  else if (p.accounts.length === 0)
    body = (
      <EmptyState
        title="Add your first account"
        body="Brokerages and crypto follow each trade, so holdings, cost basis and tax come out right. 401(k)s, IRAs and HSAs can simply take the balance from each statement."
        action={{ label: 'Add an account', onClick: p.onAdd }}
      />
    )
  else
    body = (
      <ul className="inv-strip">
        {p.accounts.map((a) => (
          <li key={a.id}>
            <AccountTile a={a} {...p} />
          </li>
        ))}
        <li>
          <button type="button" className="inv-tile inv-tile-add" data-acct="add" onClick={p.onAdd}>
            <span className="inv-tile-plus" aria-hidden="true">+</span>
            Add account
          </button>
        </li>
      </ul>
    )

  return (
    <div className="card c12 inv-accounts">
      <div className="h4row">
        <h2>Accounts</h2>
        {p.actions && <div className="right">{p.actions}</div>}
      </div>
      {p.loaded && p.filter}
      {body}
    </div>
  )
}

export function AccountTile({ a, positions, cash, unvested, owners, today, onOpen }: { a: InvestAccountRow } & AccountStripProps) {
  const own = a.tracking === 'lots' ? cash?.get(a.id) : undefined
  const value = accountValueCents(a, positions, own)
  const stale = staleReason(a, positions, today)
  const where = institutionLine(a)
  const unvestedMicro = a.stock_plan === 1 ? unvested.get(a.id) : undefined
  const sub =
    a.tracking === 'balance'
      ? a.latest_snapshot
        ? `as of ${shortDay(a.latest_snapshot.balanced_on, today)}`
        : 'no balance yet'
      : heldLine(a, positions)
  const owner = a.owner ?? 'joint'
  return (
    <button
      type="button"
      className="inv-tile"
      data-acct={a.id}
      onClick={() => onOpen(a.id)}
      aria-label={`${a.name}: ${typeLabel(a)}, ${owner}, ${value !== null ? formatCents(value) : sub}${stale ? ` — ${stale}` : ''}. Open account`}
    >
      <span className="inv-tile-head">
        <OwnerAvatar owner={a.owner} owners={owners} />
        <span className="inv-tile-name">{a.name}</span>
        {stale && <span className="inv-dot" aria-hidden="true" />}
      </span>
      <span className={`inv-tile-v${value === null ? ' inv-tile-v-none' : ''}`}>{value !== null ? formatCents(value) : '—'}</span>
      <span className="inv-tile-sub">
        <span className="inv-tag">{typeLabel(a)}</span>
        {where && <span className="inv-tile-where">{where}</span>}
      </span>
      <span className="inv-tile-foot">
        {stale ? <span className="inv-tile-stale">{stale}</span> : <span>{sub}</span>}
        {own?.cash_cents != null && <span>{formatCents(own.cash_cents)} cash</span>}
        {unvestedMicro !== undefined && <span>+ {unvestedLine(unvestedMicro)}</span>}
      </span>
    </button>
  )
}
