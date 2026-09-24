import type { ScenarioParams, ScenarioRun } from '../../engine/scenarios'
import { CONTEXT_VAR, scenarioSlots } from '../chart/palette'
import { TimeChart, type TBand, type TMarker, type TPoint, type TSeries } from '../chart/TimeChart'
import { fanMarkers } from './cardModel'

/** One scenario as POST /api/scenarios/compare returns it: its knobs, its simulated fan, its delta vs the baseline. */
export type CompareRun = ScenarioRun

export type FutureFanProps = {
  runs: CompareRun[]
  selectedId: number
  baselineId: number
  /** The selected scenario's knobs: where the Buy and Retire markers go. */
  params: ScenarioParams
  /**
   * Whether the selected run models a purchase: the scenario buys and the
   * Dream Home has loan options (without them the engine simulates no
   * purchase, so there is nothing to mark).
   */
  buys: boolean
  /** Odds the crossing year had to clear, for the Crossing marker's label. */
  thresholdPct: number
}

/** A simulated year on the time axis: Jan 1 of it (the tooltip names the year alone). */
const yearT = (y: number) => `${y}-01-01`

/**
 * Household net worth, simulated: every scenario's median, with the selected
 * one's 10–90th and 25–75th percentile bands (the tooltip reads both ranges
 * for the hovered year). Markers: Today, Buy dream home (when the run models
 * a purchase), Retire, and the Crossing year in gold — the headline. Colours come
 * from scenarioSlots, so the baseline is always s1, a scenario keeps its
 * colour however the list changes, and a seventh or later draws as an ink-3
 * context line rather than a recycled colour (bug #35).
 */
export default function FutureFan({ runs, selectedId, baselineId, params, buys, thresholdPct }: FutureFanProps) {
  const run = runs.find((r) => r.id === selectedId)
  if (!run) return null
  const slots = scenarioSlots(runs, baselineId)
  const slot = slots.get(run.id) ?? null
  const years = run.result.years
  const pts = (ys: number[], vs: number[]): TPoint[] => ys.map((y, i) => ({ t: yearT(y), v: vs[i] ?? null }))

  const series: TSeries[] = runs.map((r) => {
    const s = slots.get(r.id) ?? null
    return {
      id: `run:${r.id}`,
      label: r.name,
      points: pts(r.result.years, r.result.p50),
      ...(s === null ? { color: CONTEXT_VAR } : { slot: s }),
      dash: r.id !== run.id,
    }
  })
  const bands: TBand[] = [
    { id: 'p10', label: '10–90th', lo: pts(years, run.result.p10), hi: pts(years, run.result.p90), slot, opacity: 0.16 },
    { id: 'p25', label: '25–75th', lo: pts(years, run.result.p25), hi: pts(years, run.result.p75), slot, opacity: 0.32 },
  ]
  const markers: TMarker[] = fanMarkers({
    years,
    buys,
    buyYear: params.buyYear,
    retireYear: params.retireYear,
    crossingYear: run.crossingYear,
    thresholdPct,
  })

  return (
    <div className="card c9">
      <TimeChart
        title="Net worth · simulated"
        ariaLabel={`Simulated household net worth by year in today's dollars: every scenario's median, with ${run.name}'s percentile bands`}
        series={series}
        bands={bands}
        markers={markers}
        presets={false}
        height={300}
        tipLabel={(t) => t.slice(0, 4)}
      />
      <div className="sub2" style={{ marginTop: 6 }}>
        Today's dollars. Solid line and bands: {run.name}. Dashed: the other scenarios' medians.
      </div>
    </div>
  )
}
