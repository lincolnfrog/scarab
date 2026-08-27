import { useEffect, useState } from 'react'
import { formatCents } from '../shared/money'
import { get } from './api'

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

export default function RecurringCard() {
  const [data, setData] = useState<{ recurring: Rec[]; safeToSpend: SafeToSpend } | null>(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    get<{ recurring: Rec[]; safeToSpend: SafeToSpend }>('/api/recurring').then(setData).catch(console.error)
  }, [])

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
          Left to spend this month:{' '}
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
              <td className="desc">{r.merchant}</td>
              <td className="muted">{r.category ?? '—'}</td>
              <td className="muted">{r.cadence} · ×{r.occurrences}</td>
              <td className="r num">{formatCents(r.typicalCents)}</td>
              <td className={`r num ${r.priceCreepMicro > 0 ? 'neg' : ''}`}>{formatCents(r.lastCents)}</td>
              <td className="muted">{r.lapsed ? '—' : r.nextExpectedOn}</td>
              <td>
                {r.lapsed && <span className="tag" title="No charge when one was expected — cancelled, or the card changed">lapsed?</span>}
                {r.priceCreepMicro > 0 && !r.lapsed && <span className="tag" title="Latest charge is above the typical amount">↑ price</span>}
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
