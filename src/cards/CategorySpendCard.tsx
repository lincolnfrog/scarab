import type { CategorySpend } from '../../shared/types'
import { SLOT_VAR } from '../chart/palette'
import { Select } from '../ui/Field'
import { fmtMonth, HBars } from '../viz'

export type CategorySpendCardProps = {
  rows: CategorySpend[]
  month: string
  monthOptions: string[]
  onMonth(m: string): void
  /** Filter the screen's transactions to one category (null = uncategorized) — for clicking a bar. */
  onSelectCategory(id: number | null): void
}

/**
 * One month's spending per category, with the month picker (Cash & budget).
 * Hovering a bar gives its full name, amount and share of the month; clicking
 * it lists that category's transactions for the month.
 */
export default function CategorySpendCard({ rows, month, monthOptions, onMonth, onSelectCategory }: CategorySpendCardProps) {
  return (
    <div className="card c4">
      <div className="h4row">
        <h2>Spending by category</h2>
        <div className="right">
          <Select className="mini" aria-label="Month" value={month} onChange={(e) => onMonth(e.target.value)}>
            {monthOptions.map((m) => (
              <option key={m} value={m}>
                {fmtMonth(m, true)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <HBars
        data={rows.map((c) => ({ name: c.name, cents: c.spend_cents }))}
        color={SLOT_VAR[2]}
        tipTitle={fmtMonth(month, true)}
        ariaLabel={`Spending by category, ${fmtMonth(month, true)}`}
        onSelect={(i) => {
          const r = rows[i]
          if (r) onSelectCategory(r.category_id)
        }}
        selectHint="Click to list these transactions"
      />
    </div>
  )
}
