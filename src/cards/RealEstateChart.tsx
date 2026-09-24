import { todayLocal } from '../../shared/dates'
import { formatDollars } from '../../shared/money'
import { TipRow } from '../chart/ChartTip'
import { TimeChart, type TPointMark, type TSeries } from '../chart/TimeChart'
import type { PropertyDetail } from '../screens/RealEstate'
import { propertyLines } from './cardModel'

/**
 * One property's value against what's owed on it, on a real time axis: each
 * valuation and each recorded balance sits on its own date (bug #34 spaced
 * them evenly by month), the purchase is the value line's first point and a
 * marked dot, and the tooltip adds the equity as of the hovered date. Several
 * loans add up into one debt line. Nothing renders until there are two dates.
 * A valuation or a balance stands until the next one, so both lines run on to
 * today, where the tooltip reads them "as of" the day they were recorded.
 */
export default function RealEstateChart({ property: p }: { property: PropertyDetail }) {
  const lines = propertyLines(p)
  if (!lines) return null
  const { value, debt, bought } = lines
  const today = todayLocal()

  const debtLabel = p.liabilities.length === 1 ? `${p.liabilities[0]!.name} balance` : 'Mortgage balances'
  const series: TSeries[] = [{ id: 'value', label: 'Est. value', slot: 1, mark: 'area', points: value, carryTo: today }]
  if (debt.length > 0) series.push({ id: 'debt', label: debtLabel, slot: 2, points: debt, carryTo: today })
  const pointMarks: TPointMark[] = bought ? [{ id: 'bought', t: bought.t, v: bought.v, shape: 'dot', label: `Purchased · ${formatDollars(bought.v)}` }] : []
  const hasLoans = p.liabilities.length > 0

  return (
    <TimeChart
      ariaLabel={`${p.name}: estimated value${debt.length ? ' and mortgage balance' : ''} over time`}
      series={series}
      pointMarks={pointMarks}
      height={200}
      tooltipExtra={(_t, v) => {
        const val = v.value
        // Before the first recorded balance the debt is unknown, not zero — no equity figure then.
        if (val === null || val === undefined || (hasLoans && (v.debt === null || v.debt === undefined))) return null
        return <TipRow name="Equity" value={formatDollars(val - (v.debt ?? 0))} />
      }}
    />
  )
}
