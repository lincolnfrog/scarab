import { todayLocal } from '../../shared/dates'
import { formatCents } from '../../shared/money'
import { shortDay } from '../chart/format'
import { Link, type RouteTarget } from '../router'
import { Skeleton } from '../ui/Skeleton'
import '../chart/chart.css'

/** One row of GET /api/activity: a bank transaction (tag = its category, '—' when none) or a trade (tag = its account). */
export type ActivityRow = { on_date: string; description: string; cents: number; tag: string; kind: 'tx' | 'trade' }

const capital = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

/**
 * Recent activity (mockup c7): date, what happened, a `.cat` pill (the
 * category of a transaction, the account of a trade) and the signed amount.
 * Each row is a link: a transaction opens Cash & budget with its description
 * as the search — carried in route state, never in the URL — and a trade
 * opens Investments. `rows: null` while the first load is in flight: a
 * skeleton, never the empty copy.
 */
export default function ActivityCard({ rows, span }: { rows: ActivityRow[] | null; span: 'c7' | 'c12' }) {
  const today = todayLocal()
  return (
    <div className={`card ${span}`}>
      <div className="h4row">
        <h2>Recent activity</h2>
        <div className="right">
          <span className="muted">transactions and trades</span>
        </div>
      </div>
      {rows === null ? (
        <div className="ch-skel-rows">
          {[0, 1, 2, 3, 4].map((k) => (
            <Skeleton key={k} h={16} />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="sub2">Nothing recorded yet. Imported transactions and recorded trades show up here.</p>
      ) : (
        <table className="ch-activity">
          <tbody>
            {rows.map((a, i) => {
              const trade = a.kind === 'trade'
              // A transaction lands on Cash's list (the path scrolls to it), searched for its description.
              const to: RouteTarget = trade ? { screen: 'invest' } : { screen: 'cash', rest: ['transactions'] }
              const uncat = !trade && (a.tag === '—' || a.tag === '')
              return (
                <tr key={`${a.on_date}-${i}`} className="ch-act">
                  <td className="muted nowrap ch-act-day">{shortDay(a.on_date, today)}</td>
                  <td className="desc">
                    <Link
                      to={to}
                      state={trade ? undefined : { q: a.description }}
                      className="ch-act-link"
                      title={trade ? 'Open Investments' : 'Find it in Cash & budget'}
                    >
                      {trade ? capital(a.description) : a.description}
                    </Link>
                  </td>
                  <td className="ch-act-tag">
                    <span className={`ch-cat${uncat ? ' is-none' : ''}`}>{uncat ? 'Uncategorized' : a.tag}</span>
                  </td>
                  <td className={`r num nowrap ${a.cents > 0 ? 'pos' : ''}`}>{formatCents(a.cents, { sign: a.cents > 0 })}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}
