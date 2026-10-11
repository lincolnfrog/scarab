import { useEffect, useState } from 'react'
import { formatCents } from '../shared/money'
import { get } from './api'
import { EmptyState } from './ui/EmptyState'
import { Skeleton } from './ui/Skeleton'
import { Tooltip } from './ui/Tooltip'
import './screens/screens.css'

type Rec = {
  merchant: string
  kind: 'income' | 'expense'
  category: string | null
  cadence: string
  typicalCents: number
  lastCents: number
  lastOn: string
  nextExpectedOn: string
  occurrences: number
  lapsed: boolean
  priceCreepMicro: number
}
type SafeToSpend = {
  month: string
  budgetCents: number
  spentCents: number
  upcomingBillsCents: number
  safeCents: number
  expectedIncomeRemainingCents: number
  bills: { merchant: string; cents: number; due: string }[]
}

export type RecurringData = { recurring: Rec[]; safeToSpend: SafeToSpend }

/**
 * The household's recurring charges and "left to spend", read once for the
 * Cash screen: its overview summarises them and its Recurring view lists them.
 * `refreshKey` changes after a write that can move the rhythm (an import, a
 * re-categorization), so it re-reads. Null until loaded; on failure it stays
 * as it was.
 */
export function useRecurring(refreshKey?: number): RecurringData | null {
  const [data, setData] = useState<RecurringData | null>(null)
  useEffect(() => {
    let live = true
    get<RecurringData>('/api/recurring')
      .then((d) => live && setData(d))
      .catch(console.error)
    return () => {
      live = false
    }
  }, [refreshKey])
  return data
}

/**
 * The overview's line on recurring charges: how many are active, the next few
 * expected (soonest first), and what's left to spend when a budget is set.
 */
export function recurringSummary(data: RecurringData, today: string) {
  const active = data.recurring.filter((r) => r.kind === 'expense' && !r.lapsed)
  const upcoming = active
    .filter((r) => r.nextExpectedOn >= today)
    .sort((a, b) => (a.nextExpectedOn < b.nextExpectedOn ? -1 : a.nextExpectedOn > b.nextExpectedOn ? 1 : 0))
  const s = data.safeToSpend
  return {
    active: active.length,
    upcoming,
    priceUp: active.filter((r) => r.priceCreepMicro > 0).length,
    safe: s.budgetCents > 0 ? { cents: s.safeCents, billsCents: s.upcomingBillsCents } : null,
  }
}

/**
 * Recurring charges and "left to spend", the Cash screen's Recurring view.
 * The merchant and category link into the screen's transaction list and the
 * left-to-spend line into the budget; Cash owns those filters, so the jumps
 * are callbacks.
 */
export default function RecurringCard(p: {
  data: RecurringData | null
  onMerchant?: (merchant: string) => void
  onCategory?: (name: string) => void
  onBudget?: (month: string) => void
}) {
  const { data } = p
  const [showAll, setShowAll] = useState(false)

  if (!data)
    return (
      <div className="card c12" aria-busy="true">
        <Skeleton h={18} w={220} />
        <Skeleton h={160} style={{ marginTop: 12 }} />
      </div>
    )
  const s = data.safeToSpend
  const expenses = data.recurring.filter((r) => r.kind === 'expense')
  const rows = showAll ? expenses : expenses.filter((r) => !r.lapsed).slice(0, 12)
  if (expenses.length === 0)
    return (
      <div className="card c12">
        <EmptyState
          title="No recurring charges yet"
          body="A merchant is listed here once its charges keep a steady rhythm — a few months of imports is usually enough."
        />
      </div>
    )

  return (
    <div className="card c12">
      <div className="h4row">
        <h2>Recurring &amp; subscriptions</h2>
        <div className="right">
          {expenses.length > rows.length || showAll ? (
            <button className="btn mini ghosty" onClick={() => setShowAll(!showAll)}>
              {showAll ? 'Show active' : `Show all ${expenses.length}`}
            </button>
          ) : null}
        </div>
      </div>
      {s.budgetCents > 0 && (
        <div className="sub2" style={{ marginBottom: 10 }}>
          {p.onBudget ? (
            <button className="scr-link" onClick={() => p.onBudget!(s.month)}>
              Left to spend this month
            </button>
          ) : (
            'Left to spend this month'
          )}
          :{' '}
          <b className={`inkstrong ${s.safeCents < 0 ? 'neg' : ''}`} style={{ fontSize: 16 }}>{formatCents(s.safeCents)}</b>
          {' '}<span className="muted">= {formatCents(s.budgetCents)} budgeted − {formatCents(s.spentCents)} spent − ≈{formatCents(s.upcomingBillsCents)} in bills still coming{s.bills.length > 0 && ` (${s.bills.slice(0, 3).map((x) => x.merchant).join(', ')}${s.bills.length > 3 ? '…' : ''})`}</span>
        </div>
      )}
      <table className="scr-recurring">
        <thead>
          <tr>
            <th>Merchant</th><th>Category</th><th>Cadence</th>
            <th className="r">Typical</th><th className="r">Last</th><th>Next expected</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.merchant}>
              <td className="desc">
                {p.onMerchant ? (
                  <button className="scr-link" aria-label={`Show transactions from ${r.merchant}`} onClick={() => p.onMerchant!(r.merchant)}>
                    {r.merchant}
                  </button>
                ) : (
                  r.merchant
                )}
              </td>
              <td className="muted">
                {r.category && p.onCategory ? (
                  <button className="scr-link" aria-label={`Show ${r.category} transactions`} onClick={() => p.onCategory!(r.category!)}>
                    {r.category}
                  </button>
                ) : (
                  (r.category ?? '—')
                )}
              </td>
              <td className="muted">{r.cadence} · ×{r.occurrences}</td>
              <td className="r num">{formatCents(r.typicalCents)}</td>
              <td className={`r num ${r.priceCreepMicro > 0 ? 'neg' : ''}`}>{formatCents(r.lastCents)}</td>
              <td className="muted">{r.lapsed ? '—' : r.nextExpectedOn}</td>
              <td>
                {r.lapsed && (
                  <Tooltip content="No charge when one was expected — cancelled, or the card changed">
                    <span className="tag">lapsed?</span>
                  </Tooltip>
                )}
                {r.priceCreepMicro > 0 && !r.lapsed && (
                  <Tooltip content={`Latest charge is above the typical ${formatCents(r.typicalCents)}`}>
                    <span className="tag">↑ price</span>
                  </Tooltip>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="sub2" style={{ marginTop: 8 }}>
        Detected from the rhythm of the ledger — a merchant is listed while its charges keep a steady cadence.
        Transfers are excluded; amounts are medians.
      </p>
    </div>
  )
}
