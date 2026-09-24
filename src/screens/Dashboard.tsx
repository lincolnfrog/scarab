import { useEffect, useMemo, useState } from 'react'
import { formatDollars } from '../../shared/money'
import type { GoalDerived } from '../../shared/types'
import { get } from '../api'
import ActivityCard, { type ActivityRow } from '../cards/ActivityCard'
import DreamHomeTile from '../cards/DreamHomeTile'
import { tileGroups, tileSpan, type NetWorthPoint } from '../cards/cardModel'
import StatTile, { ChangeText } from '../cards/StatTile'
import { CountUp } from '../chart/CountUpText'
import { SLOT_VAR } from '../chart/palette'
import { compositionLayers } from '../chart/stackModel'
import { TimeChart, type TSeries } from '../chart/TimeChart'
import DigestCard from '../DigestCard'
import { Link, useRouteState } from '../router'
import { Button } from '../ui/Button'
import { HeaderSlot } from '../ui/HeaderSlot'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { Donut } from '../viz'
import '../chart/chart.css'

type Point = NetWorthPoint
type NetWorth = { series: Point[]; current: Point | null; prev: Point | null }
type GoalResponse = { goal: { fundAccountIds: number[]; fundExtraCents: number }; derived?: GoalDerived }

/** How many month-ends a tile's sparkline covers. */
const SPARK_MONTHS = 12

type NwView = 'total' | 'parts'

/**
 * The net-worth chart's two views. Total: one area. Breakdown (plan §C10): a
 * diverging stack — what's owned piles up from $0 in the donut's fixed slots
 * (Brokerage s1 … Cash s5), every debt hangs below it as one Liabilities
 * layer in s6 — with net worth as a neutral ink line through it. Built once
 * per reply, so TimeChart's per-points parse cache holds across renders.
 */
function netWorthSeries(series: readonly Point[]): { total: TSeries[]; parts: TSeries[] | null } {
  const totalPts = series.map((p) => ({ t: p.month, v: p.total }))
  const layers = compositionLayers(series)
  return {
    total: [{ id: 'nw:total', label: 'Net worth', mark: 'area', points: totalPts }],
    // A breakdown of a single part says nothing the total doesn't.
    parts:
      layers.length >= 2
        ? [
            { id: 'nw:total', label: 'Net worth', mark: 'line', color: 'var(--ink)', points: totalPts },
            ...layers.map(
              (l): TSeries => ({ id: l.id, label: l.label, slot: l.slot, stack: true, points: series.map((p, k) => ({ t: p.month, v: l.values[k]! })) }),
            ),
          ]
        : null,
  }
}

function DashboardSkeleton() {
  return (
    <div className="grid12" aria-busy="true">
      <div className="card c8">
        <Skeleton h={12} w={160} />
        <Skeleton h={44} w={300} style={{ marginTop: 16 }} />
        <Skeleton h={230} style={{ marginTop: 16 }} radius={8} />
      </div>
      <div className="card c4">
        <Skeleton h={12} w={90} />
        <Skeleton h={168} w={168} radius={84} style={{ marginTop: 16 }} />
      </div>
      {[0, 1, 2, 3].map((k) => (
        <div className="card c3" key={k}>
          <Skeleton h={12} w={90} />
          <Skeleton h={24} w={140} style={{ marginTop: 12 }} />
          <Skeleton h={34} style={{ marginTop: 12 }} />
        </div>
      ))}
    </div>
  )
}

/**
 * The hub: net worth over time (with a way into Compare), what it's made of,
 * one tile per slice with its 12-month trend, recent activity, and the dream
 * home fund. Every figure is derived from the ledger on request. Revisiting
 * the screen refetches quietly; the last numbers stay up meanwhile.
 */
export default function Dashboard() {
  const [nw, setNw] = useState<NetWorth | null>(null)
  const [nwError, setNwError] = useState<string | null>(null)
  const [activity, setActivity] = useState<ActivityRow[] | null>(null)
  const [goal, setGoal] = useState<GoalResponse | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [view, setView] = useRouteState<NwView>('nwView', 'total')
  const nwSeries = useMemo(() => (nw ? netWorthSeries(nw.series) : null), [nw])

  useEffect(() => {
    let live = true
    get<NetWorth>('/api/networth')
      .then((r) => {
        if (!live) return
        setNw(r)
        setNwError(null)
      })
      .catch((e: unknown) => live && setNwError(e instanceof Error ? e.message : String(e)))
    get<ActivityRow[]>('/api/activity')
      .then((r) => live && setActivity(r))
      .catch(() => live && setActivity((a) => a ?? []))
    // The goal tile is optional: a failure just leaves it out.
    get<GoalResponse>('/api/goal')
      .then((r) => live && setGoal(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [attempt])

  const header = <HeaderSlot sub="Everything you own, minus everything you owe" />

  if (!nw) {
    if (nwError)
      return (
        <>
          {header}
          <div className="card wide" role="alert">
            <h2>Net worth</h2>
            <p className="sub2">Couldn't add up net worth: {nwError}</p>
            <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        </>
      )
    return (
      <>
        {header}
        <DashboardSkeleton />
      </>
    )
  }

  const { series, current, prev } = nw
  if (!current)
    return (
      <>
        {header}
        <div className="card wide">
          <h2>Nothing to add up yet</h2>
          <p>
            Net worth assembles itself from the other screens: import bank files on{' '}
            <Link to={{ screen: 'cash' }} className="ch-a">Cash &amp; budget</Link>, record trades or balances on{' '}
            <Link to={{ screen: 'invest' }} className="ch-a">Investments</Link>, add your house on{' '}
            <Link to={{ screen: 're' }} className="ch-a">Real estate</Link>. Each one lights up a slice here.
          </p>
        </div>
      </>
    )

  const recent = series.slice(-SPARK_MONTHS)
  const groups = tileGroups(recent)
  const span = tileSpan(groups.length)
  const equity = current.property + current.liabilities
  // The donut can't draw a negative slice; when one is clamped to zero the ring no longer sums to net worth.
  const clamped = equity < 0 || current.cash < 0
  const parts = view === 'parts' && nwSeries?.parts ? nwSeries.parts : null
  const hero = (
    <div className="ch-hero-row">
      <div className="heronum ch-hero">
        <CountUp value={current.total} format={formatDollars} />
      </div>
      {prev && <ChangeText cur={current.total} prev={prev.total} suffix="this month" className="ch-hero-delta" />}
    </div>
  )
  const compare = (
    <Link
      to={{ screen: 'compare' }}
      // A fresh net-worth selection, in dollars, over all of it — whatever Compare showed last.
      state={{ ids: ['nw:total'], mode: 'value', win: {} }}
      className="btn mini ch-compare"
      title="Overlay net worth with its parts, an account, a holding, a benchmark…"
    >
      <span aria-hidden="true">⇄</span>Compare
    </Link>
  )
  const viewPicker = nwSeries?.parts ? (
    <Segmented<NwView>
      aria-label="Net worth view"
      size="sm"
      value={parts ? 'parts' : 'total'}
      onChange={setView}
      options={[
        { value: 'total', label: 'Total' },
        { value: 'parts', label: 'Breakdown', title: 'What net worth is made of: what you own above $0, what you owe below it' },
      ]}
    />
  ) : null
  const setUp = !!goal && (goal.goal.fundAccountIds.length > 0 || goal.goal.fundExtraCents > 0)
  const dream = goal?.derived ?? null

  return (
    <>
      {header}
      <div className="grid12">
        <DigestCard />
        <div className="card c8">
          <h2>Household net worth</h2>
          {series.length >= 2 ? (
            <TimeChart
              ariaLabel={parts ? 'Household net worth by month, broken down into what is owned and owed' : 'Household net worth by month'}
              lead={hero}
              actions={
                <>
                  {viewPicker}
                  {compare}
                </>
              }
              series={parts ?? nwSeries?.total ?? []}
              legendAt="foot"
              height={230}
            />
          ) : (
            <>
              {hero}
              <p className="sub2" style={{ marginTop: 10 }}>
                The trend line appears once there's more than one month of history.
              </p>
            </>
          )}
        </div>
        <div className="card c4">
          <h2>Allocation</h2>
          <Donut
            centerLabel={clamped ? 'assets' : 'total'}
            data={[
              { name: 'Brokerage', cents: current.brokerage, color: SLOT_VAR[1] },
              { name: 'Retirement', cents: current.retirement, color: SLOT_VAR[2] },
              { name: 'Home equity', cents: Math.max(0, equity), color: SLOT_VAR[3] },
              { name: 'Crypto', cents: current.crypto, color: SLOT_VAR[4] },
              { name: 'Cash', cents: Math.max(0, current.cash), color: SLOT_VAR[5] },
            ]}
          />
          {current.property > 0 && (
            <div className="sub2 topline">
              Home equity = {formatDollars(current.property)} value
              {current.liabilities !== 0 ? ` − ${formatDollars(-current.liabilities)} debt` : ', nothing owed'}
            </div>
          )}
          {clamped && (
            <div className="muted ch-note">
              {equity < 0 ? 'Home equity is under water' : 'Cash is overdrawn'}, so the ring shows assets, not net worth.
            </div>
          )}
        </div>

        {groups.map((g) => (
          <StatTile
            key={g.key}
            label={g.label}
            cents={g.of(current)}
            prevCents={prev ? g.of(prev) : null}
            spark={recent.map(g.of)}
            color={g.color}
            to={g.to}
            span={span}
          />
        ))}

        <ActivityCard rows={activity} span={dream ? 'c7' : 'c12'} />
        {dream && <DreamHomeTile derived={dream} setUp={setUp} span="c5" />}
      </div>
    </>
  )
}
