import { useState } from 'react'
import type { BalanceSnapshotRow, InvestAccountRow, PortfolioAccount } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { Button } from '../ui/Button'
import { HistoryRow, UpdateBalanceButton } from './BalanceAccounts'
import { cashView } from './cashMath'
import './invest.css'

/**
 * A lots account's cash (the cash anchor): what it is now — the latest cash
 * balance recorded plus what the trades since did to it — the button that
 * records a new balance from a statement, and the recorded balances, each
 * editable in place and deletable. With none recorded, sale proceeds leave
 * the account's value; this says how much.
 */
export default function CashPanel({ account, cash, anchors, today, onChanged, inTable = false }: {
  account: InvestAccountRow
  /** The portfolio's row for this account (GET /api/invest/accounts/:id → cash). */
  cash: PortfolioAccount | null
  /** Its recorded cash balances, newest first (the detail's balances). */
  anchors: readonly BalanceSnapshotRow[]
  today: string
  onChanged: () => void
  /** The holdings table above already shows the cash row (its amount and source): say what it is, not the numbers again. */
  inTable?: boolean
}) {
  const [open, setOpen] = useState(false)
  const v = cashView(cash, today)
  let text
  if (v?.state === 'set' && inTable && !v.short)
    text = 'Cash follows your trades from the last balance you recorded — sales add, buys spend. Update it from each statement.'
  else if (v?.state === 'set')
    text = (
      <>
        Cash <b className="inkstrong">{formatCents(v.cents)}</b> · {v.line}
        {v.short && ' — below $0: a deposit Scarab doesn’t know about? Record the cash from your latest statement.'}
      </>
    )
  else if (v && v.uncountedCents > 0)
    text = (
      <>
        <b className="inkstrong">{formatCents(v.uncountedCents)}</b> from sales isn’t counted in net worth. Record this account’s cash
        balance and sale proceeds land there; buys spend from it.
      </>
    )
  else text = 'No cash balance recorded — its value is its holdings. Record one and sales and buys move it until the next statement.'

  return (
    <section className="inv-cash" aria-label={`${account.name} cash`}>
      <div className="inv-paneltools">
        <span className="inv-note">{text}</span>
        <span className="inv-rowactions">
          {anchors.length > 0 && (
            <Button size="mini" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              {open ? 'Hide history' : `History (${anchors.length})`}
            </Button>
          )}
          <UpdateBalanceButton
            mode="cash"
            account={account}
            snapshots={anchors}
            today={today}
            onSaved={onChanged}
            initialCents={v?.state === 'set' ? v.cents : null}
          >
            {v?.state === 'set' ? 'Update cash' : 'Set cash balance'}
          </UpdateBalanceButton>
        </span>
      </div>
      {open && anchors.length > 0 && (
        <table className="inv-baltable">
          <thead>
            <tr>
              <th>As of</th>
              <th className="r">Cash balance</th>
              <th />
              <th />
            </tr>
          </thead>
          <tbody>
            {anchors.map((s) => (
              <HistoryRow key={s.balanced_on} mode="cash" account={account} snap={s} today={today} onChanged={onChanged} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
