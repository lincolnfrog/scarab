import { monthsBetween, todayLocal } from '../../shared/dates'
import { projectToTarget } from '../../shared/series'
import type { GoalDerived } from '../../shared/types'
import { TipRow } from '../chart/ChartTip'
import { pctOfTarget, projectionHorizon } from './cardModel'
import { fmtAxis, monthLong } from '../chart/format'
import { GOAL_VAR } from '../chart/palette'
import { TimeChart, type TMarker, type TPoint, type TSeries, type TThreshold } from '../chart/TimeChart'

/**
 * The down-payment fund month by month, in gold (it is the goal): the fund
 * as an area; the cash-to-close target as a gold threshold; the monthly plan
 * projected forward as a dashed gold line, built month by month in integer
 * cents from today's fund (`derived.monthlyPlanCents`), ending on the ETA
 * month, which gets a gold marker. The tooltip adds "% of target". Every
 * number comes from GET /api/goal. Nothing renders until there are two
 * points to draw.
 */
export default function GoalFundChart({ series, derived }: { series: { month: string; cents: number }[]; derived?: GoalDerived }) {
  const month = todayLocal().slice(0, 7)
  const fund: TPoint[] = series.map((s) => ({ t: s.month, v: s.cents }))
  // The fund is worth today's balance this month even before this month's first deposit.
  if (derived && (fund.length === 0 ? derived.fundCents > 0 : fund[fund.length - 1]!.t < month))
    fund.push({ t: month, v: derived.fundCents })
  const history = fund.length > 0 && fund[0]!.t <= month ? monthsBetween(fund[0]!.t, month).length : 0
  const etaMonths = derived?.etaMonth && derived.etaMonth > month ? monthsBetween(month, derived.etaMonth).length - 1 : null
  const plan = derived
    ? projectToTarget(month, derived.fundCents, derived.monthlyPlanCents, derived.targetCents, projectionHorizon(history, etaMonths))
    : []
  if (fund.length < 2 && plan.length < 2) return null

  const eta = derived?.etaMonth
  const reaches = !!eta && plan.length >= 2 && plan[plan.length - 1]!.t === eta
  const lines: TSeries[] = [{ id: 'fund', label: 'Fund', color: GOAL_VAR, mark: 'area', points: fund }]
  if (derived && plan.length >= 2)
    lines.push({
      id: 'plan',
      label: `Plan · ${fmtAxis(derived.monthlyPlanCents, 'cents')}/mo${eta && !reaches ? ` → ${monthLong(eta)}` : ''}`,
      color: GOAL_VAR,
      dash: true,
      points: plan,
    })
  const thresholds: TThreshold[] =
    derived && derived.targetCents > 0
      ? [{ id: 'target', v: derived.targetCents, label: `Target ${fmtAxis(derived.targetCents, 'cents')}`, tone: 'gold' }]
      : []
  const markers: TMarker[] = reaches ? [{ id: 'eta', t: eta!, label: `ETA ${monthLong(eta!)}`, tone: 'gold' }] : []
  const target = derived?.targetCents ?? 0

  return (
    <TimeChart
      ariaLabel="Down-payment fund by month, with the target and the monthly plan projected to it"
      series={lines}
      thresholds={thresholds}
      markers={markers}
      presets={false}
      height={180}
      tooltipExtra={
        target > 0
          ? (_t, v) => {
              // Ahead of today the plan speaks; before it, the fund.
              const at = v.plan ?? v.fund
              return at === null || at === undefined ? null : <TipRow name="of target" value={`${pctOfTarget(at, target)}%`} />
            }
          : undefined
      }
    />
  )
}
