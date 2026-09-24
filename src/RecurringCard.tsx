import { useEffect, useState } from 'react'
import { formatCents } from '../shared/money'
import { get } from './api'
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

/**
 * Recurring charges and "left to spend", on the Cash screen. The merchant and
 * category link into the screen's transaction list and the left-to-spend line
 * into the budget; Cash owns those filters, so the jumps are callbacks.
 * `refreshKey` changes after a write that can move the rhythm (an import, a
 * re-categorization), so the card re-reads.
 */
export default function RecurringCard(p: {
  refreshKey?: number
  onMerchant?: (merchant: string) => void
  onCategory?: (name: string) => void
  onBudget?: (month: string) => void
}) {
  const [data, setData] = useState<{ recurring: Rec[]; safeToSpend: SafeToSpend } | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let live = true
    get<{ recurring: Rec[]; safeToSpend: SafeToSpend }>('/api/recurring')
      .then((d) => live && setData(d))
      .catch(console.error) // an extra card: on failure it stays as it was (or absent)
    return () => {
      live = false
    }
  }, [p.refreshKey])

  if (!data) return null
  const s = data.safeToSpend
  const expenses = data.recurring.filter((r) => r.kind === 'expense')
  const rows = showAll ? expenses : expenses.filter((r) => !r.lapsed).slice(0, 12)
  if (expenses.length === 0) return null

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
      <table>
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
