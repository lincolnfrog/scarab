import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TradeRow } from '../../shared/invest-api'
import { formatCents, formatDollars } from '../../shared/money'
import { MAX_SERIES_IDS, type SeriesResponse } from '../../shared/series-api'
import { get } from '../api'
import { TipRow } from '../chart/ChartTip'
import { fmtPctMicro } from '../chart/format'
import { signColor } from '../chart/palette'
import { TimeChart, type TSeries } from '../chart/TimeChart'
import { wantsDollars } from '../chart/timeModel'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { sumSeries, tradeRug, unrealizedAt } from './cardModel'
import '../chart/chart.css'

export type PortfolioValueCardProps = {
  /** One investment account; omitted = every lots-tracked account together. */
  accountId?: number
  /** Bump to refetch (Investments passes its load counter, so a recorded trade shows at once). Without it, every keep-alive reveal refetches. */
  rev?: number
  /**
   * Only these lots-tracked accounts (an owner pill), their inv:<id> series
   * added up; `scopeLabel` names them under the title. Ignored with `accountId`.
   */
  accountIds?: ReadonlySet<number>
  scopeLabel?: string
}

type Loaded = { series: TSeries[]; rug: ReturnType<typeof tradeRug>; title: string; valueId: string; costId: string | null }

/** The ids in a stable order, as a dependency key: null = unscoped. */
const idsKey = (ids: ReadonlySet<number> | undefined) => (ids ? [...ids].sort((a, b) => a - b).join(',') : null)

/**
 * An owner pill's accounts: each one's inv:<id>:value and :cost (a few per
 * request — the series API takes MAX_SERIES_IDS ids), summed month by month
 * into what inv:all would be for just those accounts, and their trades.
 */
async function fetchScoped(ids: number[]): Promise<{ value: TSeries['points'] | null; cost: TSeries['points'] | null; trades: TradeRow[] }> {
  const wanted = ids.flatMap((id) => [`inv:${id}:value`, `inv:${id}:cost`])
  const chunks: string[][] = []
  for (let i = 0; i < wanted.length; i += MAX_SERIES_IDS) chunks.push(wanted.slice(i, i + MAX_SERIES_IDS))
  const [replies, trades] = await Promise.all([
    Promise.all(chunks.map((c) => get<SeriesResponse>(`/api/series?ids=${encodeURIComponent(c.join(','))}`))),
    get<TradeRow[]>('/api/trades').catch(() => [] as TradeRow[]), // the rug is optional
  ])
  const got = replies.flatMap((r) => r.series)
  const part = (kind: 'value' | 'cost') => got.filter((x) => x.id.endsWith(`:${kind}`)).map((x) => x.points)
  const values = part('value')
  const costs = part('cost')
  const mine = new Set(ids)
  return {
    value: values.length ? sumSeries(values) : null,
    cost: costs.length ? sumSeries(costs) : null,
    trades: Array.isArray(trades) ? trades.filter((t) => mine.has(t.invest_account_id)) : [],
  }
}

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: Loaded }

/** Whole dollars when the chart reads in dollars (TimeChart's own rule, so the rows agree), cents otherwise. */
const money = (c: number, dollars: boolean, sign = false) => (dollars ? formatDollars(c, { sign }) : formatCents(c, { sign }))

/**
 * Portfolio value vs. cost basis over time (the mockup's Investments hero
 * chart): inv:<scope>:value as an s1 area and inv:<scope>:cost as a dashed s2
 * line. Months valued partly at cost (a holding with no price yet) draw
 * dashed and say so. The tooltip adds "Unrealized +$X (+Y%)" in up/down —
 * the only place gain colours appear. Trades sit on the chart's floor as a
 * rug of neutral ▲/▼ ticks, listed in the tooltip for their month.
 *
 * Renders nothing when nothing is held yet (Investments shows its own
 * onboarding); a failed load says so and offers Retry.
 */
export default function PortfolioValueCard({ accountId, rev, accountIds, scopeLabel }: PortfolioValueCardProps) {
  const scope = accountId === undefined ? 'all' : String(accountId)
  const pill = accountId === undefined ? idsKey(accountIds) : null
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const seq = useRef(0)

  const fetchAll = useCallback(async (retry = false) => {
    const valueId = `inv:${scope}:value`
    const costId = `inv:${scope}:cost`
    const n = ++seq.current
    if (retry) setLoad({ state: 'loading' })
    try {
      if (pill !== null) {
        const ids = pill ? pill.split(',').map(Number) : []
        const got = ids.length ? await fetchScoped(ids) : { value: null, cost: null, trades: [] }
        if (n !== seq.current) return
        const series: TSeries[] = []
        if (got.value) series.push({ id: valueId, label: 'Market value', mark: 'area', slot: 1, points: got.value })
        if (got.cost) series.push({ id: costId, label: 'Cost basis', dash: true, slot: 2, points: got.cost })
        setLoad({
          state: 'ok',
          data: { series, rug: tradeRug(got.trades), title: got.cost ? 'Portfolio value vs. cost basis' : 'Portfolio value', valueId, costId: got.cost ? costId : null },
        })
        return
      }
      const [res, trades] = await Promise.all([
        get<SeriesResponse>(`/api/series?ids=${encodeURIComponent(`${valueId},${costId}`)}`),
        get<TradeRow[]>(`/api/trades${accountId === undefined ? '' : `?accountId=${accountId}`}`).catch(() => [] as TradeRow[]), // the rug is optional
      ])
      if (n !== seq.current) return
      const value = res.series.find((s) => s.id === valueId)
      const cost = res.series.find((s) => s.id === costId) // absent for a balance-tracked account (a warning)
      const series: TSeries[] = []
      if (value) series.push({ id: valueId, label: 'Market value', mark: 'area', slot: 1, points: value.points })
      if (cost) series.push({ id: costId, label: 'Cost basis', dash: true, slot: 2, points: cost.points })
      const name = accountId === undefined ? 'Portfolio' : (value?.label.replace(/ · value$/, '') ?? 'Account')
      setLoad({
        state: 'ok',
        data: {
          series,
          rug: tradeRug(Array.isArray(trades) ? trades : []),
          title: cost ? `${name} value vs. cost basis` : `${name} value`,
          valueId,
          costId: cost ? costId : null,
        },
      })
    } catch (e) {
      // A quiet refetch that fails keeps what is drawn; only a first load shows the error.
      if (n === seq.current) setLoad((l) => (l.state === 'ok' ? l : { state: 'error', message: e instanceof Error ? e.message : String(e) }))
    }
  }, [scope, accountId, pill])

  // Runs on mount, whenever Investments reloads (so on every keep-alive reveal, since it reloads then) and
  // when the scope changes.
  const fetched = useRef<{ fetchAll: typeof fetchAll; rev: number } | null>(null)
  useEffect(() => {
    if (rev !== undefined) {
      if (fetched.current?.fetchAll === fetchAll && fetched.current.rev === rev) return
      fetched.current = { fetchAll, rev }
    }
    void fetchAll()
  }, [fetchAll, rev])

  const data = load.state === 'ok' ? load.data : null
  const tooltipExtra = useMemo(() => {
    if (!data?.costId) return undefined
    const { valueId, costId } = data
    const dollars = wantsDollars(data.series.flatMap((x) => x.points.map((pt) => pt.v)))
    return (_t: string, values: Record<string, number | null>) => {
      const u = unrealizedAt(values[valueId], values[costId])
      if (!u) return null
      const color = signColor(u.cents)
      return (
        <TipRow
          name="Unrealized"
          value={`${money(u.cents, dollars, true)}${u.micro !== null ? ` (${fmtPctMicro(u.micro, { sign: true })})` : ''}`}
          valueColor={color}
        />
      )
    }
  }, [data])

  if (load.state === 'loading')
    return (
      <div className="card c12" aria-busy="true" aria-label="Loading portfolio value">
        <Skeleton h={14} w={220} />
        <Skeleton h={230} radius={8} style={{ marginTop: 16 }} />
      </div>
    )
  if (load.state === 'error')
    return (
      <div className="card c12">
        <h2>Portfolio value vs. cost basis</h2>
        <div className="ch-empty">
          <p className="ch-hint">Couldn’t load the portfolio’s history: {load.message}</p>
          <Button size="mini" onClick={() => void fetchAll(true)}>
            Retry
          </Button>
        </div>
      </div>
    )

  const d = load.data
  if (!d.series.some((s) => s.points.some((p) => p.v !== null))) return null
  return (
    <div className="card c12 ch-pv">
      <TimeChart
        ariaLabel={`${d.title}${pill !== null && scopeLabel ? `, ${scopeLabel}` : ''}, by month`}
        title={
          pill !== null && scopeLabel ? (
            <>
              {d.title} <span className="muted">· {scopeLabel}</span>
            </>
          ) : (
            d.title
          )
        }
        series={d.series}
        rug={d.rug}
        unit="cents"
        tooltipExtra={tooltipExtra}
      />
      {d.rug.length > 0 && <p className="ch-note ch-rug-key">▲ buy · ▼ sell — trades along the bottom, listed in the tooltip for their month.</p>}
    </div>
  )
}
