import type { MonthlyFlow } from '../../shared/types'
import { Legend } from '../chart/Legend'
import { SLOT_VAR } from '../chart/palette'
import { axisMonth, fmtMonth, GroupedBars } from '../viz'

export type CashFlowCardProps = {
  monthly: MonthlyFlow[]
  /** The month the rest of the screen is showing, and how to change it — for clicking a month's bars. */
  month: string
  onSelectMonth(m: string): void
}

/**
 * Income vs. spending, one pair of bars per month (Cash & budget). The month
 * the screen is showing carries a gold-dim wash; clicking another month (or
 * stepping to it with the arrow keys and pressing Enter) shows that one.
 */
export default function CashFlowCard({ monthly, month, onSelectMonth }: CashFlowCardProps) {
  const months = monthly.map((m) => m.month)
  const selected = months.indexOf(month)
  return (
    <div className="card c8">
      <div className="h4row">
        <h2>Income vs. spending</h2>
        <div className="right">
          <Legend
            items={[
              { id: 'income', label: 'Income', color: SLOT_VAR[3] },
              { id: 'spending', label: 'Spending', color: SLOT_VAR[5] },
            ]}
          />
        </div>
      </div>
      <GroupedBars
        data={monthly.map((m, i) => ({ label: axisMonth(months, i), a: m.income_cents, b: m.spend_cents }))}
        tipLabel={(i) => fmtMonth(monthly[i]!.month, true)}
        names={['Income', 'Spending']}
        colors={[SLOT_VAR[3], SLOT_VAR[5]]}
        ariaLabel="Income vs. spending by month"
        selected={selected >= 0 ? selected : null}
        onSelect={(i) => {
          const m = monthly[i]?.month
          if (m && m !== month) onSelectMonth(m)
        }}
        selectHint={{ idle: 'Click to show this month', on: 'Showing this month' }}
      />
    </div>
  )
}
