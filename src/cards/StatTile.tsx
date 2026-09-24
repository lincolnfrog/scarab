import { formatDollars } from '../../shared/money'
import { changeBp } from '../../shared/series'
import { fmtChangeBp } from '../chart/format'
import { Sparkline } from '../chart/Sparkline'
import { Link, type RouteTarget } from '../router'
import '../chart/chart.css'

/**
 * "▲ $5,500 · 2.3% MoM": the change from `prev` to `cur` in whole dollars,
 * plus the percent as integer basis points of the previous value — left out
 * when there is no base to measure against (a class that was $0). Up/down
 * colour, because this is a gain or a loss.
 */
export function ChangeText({ cur, prev, suffix, className }: { cur: number; prev: number; suffix: string; className?: string }) {
  const d = cur - prev
  if (d === 0) return <span className={`ch-delta muted${className ? ` ${className}` : ''}`}>No change {suffix}</span>
  const bp = changeBp(cur, prev)
  return (
    <span className={`ch-delta ${d > 0 ? 'pos' : 'neg'}${className ? ` ${className}` : ''}`}>
      <span aria-hidden="true">{d > 0 ? '▲' : '▼'} </span>
      <span className="ui-sr">{d > 0 ? 'Up' : 'Down'} </span>
      {formatDollars(Math.abs(d))}
      {bp !== null && ` · ${fmtChangeBp(bp)}`} {suffix}
    </span>
  )
}

export type StatTileProps = {
  label: string
  cents: number
  /** Last month-end's value; null with a single month of history. */
  prevCents: number | null
  /** Up to 12 month-end values, oldest first, ending with `cents`. */
  spark: number[]
  color: string
  to: RouteTarget
  /** Grid class: the tiles share the row evenly (c3 × 4, c4 × 3, c6 × 2). */
  span: 'c3' | 'c4' | 'c6' | 'c12'
}

/**
 * A mockup `.tile`: one slice of net worth in whole dollars, its change since
 * last month, and a 12-month sparkline. The whole card links to the screen
 * the number comes from (the title is the link; its hit area covers the card).
 */
export default function StatTile({ label, cents, prevCents, spark, color, to, span }: StatTileProps) {
  const first = spark[0]
  return (
    <div className={`card ${span} ch-stat`}>
      <h2>
        <Link to={to} className="ch-stat-link">
          {label}
        </Link>
      </h2>
      <div className="ch-stat-v">{formatDollars(cents)}</div>
      {prevCents !== null && <ChangeText cur={cents} prev={prevCents} suffix="MoM" />}
      <Sparkline
        values={spark}
        color={color}
        label={
          first === undefined || spark.length < 2
            ? `${label}: no trend yet`
            : `${label} over the last ${spark.length} months: ${formatDollars(first)} to ${formatDollars(cents)}`
        }
      />
    </div>
  )
}
