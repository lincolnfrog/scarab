import type { ReactNode } from 'react'
import type { PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { formatCents, formatPercentMicro } from '../../shared/money'
import { fmtPctMicro } from '../chart/format'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { shortDay } from './balanceMath'
import { dayAmount, dayOf, dayPercent, toneOf, totalDay } from './dayMath'
import './invest.css'

export type InvestSummaryProps = {
  loaded: boolean
  /** Everything in view: holdings, cash and balance-tracked accounts (what the account tiles add up to). */
  valueCents: number
  /** The holdings' totals for the accounts in view. */
  totals: PortfolioResponse['totals'] | null
  positions: readonly PortfolioPosition[]
  /** Derived cash across the accounts in view, when any has a cash balance. */
  cashCents: number | null
  /** The latest balances of balance-tracked accounts in view (0 when there are none). */
  balanceCents: number
  /** The money-weighted rate over every holding that has one; null when unknown or narrowed. */
  rate: { irr_micro: number | null; annualized: boolean } | null
  today: string
  /** "Max’s accounts" when narrowed. */
  scopeLabel?: string
  /** The owner pills. */
  filter?: ReactNode
  /** Prices as of · Refresh prices. */
  actions?: ReactNode
}

/**
 * The screen's headline: what the investments are worth, what they did
 * today, and how they have done overall — so the first glance answers "how
 * are we doing?" before any table. The day's change covers holdings with a
 * market quote; balance-tracked accounts and hand-priced holdings have none.
 */
export default function InvestSummary(p: InvestSummaryProps) {
  const t = p.totals
  const day = t ? totalDay(t) : null
  const on = dayOf(p.positions)
  const when = on === null ? null : on === p.today ? 'today' : shortDay(on, p.today)
  const left = p.positions.filter((x) => x.day_change_cents == null).length
  const parts = [
    t && t.value > 0 && (p.cashCents !== null || p.balanceCents > 0) ? `holdings ${formatCents(t.value)}` : null,
    p.cashCents !== null ? `cash ${formatCents(p.cashCents)}` : null,
    p.balanceCents > 0 ? `tracked by balance ${formatCents(p.balanceCents)}` : null,
  ].filter(Boolean)
  return (
    <div className="card c12 inv-sum">
      <div className="h4row">
        <h2>
          Portfolio{p.scopeLabel && <span className="muted"> · {p.scopeLabel}</span>}
        </h2>
        {p.actions && <div className="right">{p.actions}</div>}
      </div>
      {p.loaded && p.filter}
      <div className="inv-sum-body">
        <div className="inv-sum-main">
          <span className="inv-sum-v">{p.loaded ? formatCents(p.valueCents) : <Skeleton h={34} w={220} />}</span>
          {day ? (
            <span className={`inv-sum-day ${toneOf(day.cents)}`}>
              <b>{dayAmount(day.cents)}</b>
              {day.micro !== null && <span>{dayPercent(day.micro)}</span>}
              <Tooltip
                content={
                  `Since the previous close, across holdings with a market quote` +
                  (left > 0 ? ` — ${left} holding${left === 1 ? ' has' : 's have'} no quote for the day` : '') +
                  (p.balanceCents > 0 ? '. Accounts tracked by balance move only when you record one.' : '.')
                }
              >
                <span className="inv-sum-when">{when}</span>
              </Tooltip>
            </span>
          ) : (
            p.loaded && p.positions.length > 0 && <span className="inv-sum-day muted">No change for the day yet — it comes with the next price refresh.</span>
          )}
          {parts.length > 0 && <span className="inv-sum-sub">{parts.join(' · ')}</span>}
        </div>
        {t && t.cost > 0 && (
          <dl className="inv-dsum-stats inv-sum-stats">
            <div>
              <dt>Unrealized</dt>
              <dd className={toneOf(t.unrealized)}>
                {formatCents(t.unrealized, { sign: t.unrealized > 0 })}
                <span className="inv-subline inv-subtone">{formatPercentMicro(Math.round((Math.abs(t.unrealized) * 1_000_000) / t.cost), 1)} of cost</span>
              </dd>
            </div>
            {p.rate && p.rate.irr_micro !== null && (
              <div>
                <dt>
                  <Tooltip content="Money-weighted: the yearly rate that turns what you paid, when you paid it, into what the holdings are worth now. Holdings without a price or a rate are left out.">
                    <span className="inv-hint">Return</span>
                  </Tooltip>
                </dt>
                <dd className={toneOf(p.rate.irr_micro)}>
                  {fmtPctMicro(p.rate.irr_micro, { sign: true })}
                  {p.rate.annualized ? '/yr' : ''}
                  <span className="inv-subline">{p.rate.annualized ? 'money-weighted' : 'under a year, not annualized'}</span>
                </dd>
              </div>
            )}
            <div>
              <dt>Cost basis</dt>
              <dd>{formatCents(t.cost)}</dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  )
}
