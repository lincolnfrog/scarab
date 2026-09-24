import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PortfolioPosition } from '../../shared/invest-api'
import { formatCents, formatDollars } from '../../shared/money'
import type { ReturnsResponse } from '../../shared/series-api'
import { get } from '../api'
import { ChartTip, TipRow } from '../chart/ChartTip'
import { fmtPctMicro, shortDay } from '../chart/format'
import { MARK_VAR, signColor } from '../chart/palette'
import { useBarNav } from '../chart/useBarNav'
import { useChartSize } from '../chart/useChartSize'
import { growStyle, useGrow } from '../chart/useGrow'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import { heldText, noRateDay, returnBars, scopeReturns, unrealizedAt, type ReturnBar, type ScopedReturn, type ScopedReturns } from './cardModel'
import '../chart/chart.css'

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ReturnsResponse }

const ROW_H = 30
const LABEL_W = 76
const VALUE_W = 132
const GAP = 12

/** Whole dollars from $10,000, cents below. Pass `dollars` to keep one figure's rows in one format. */
const money = (c: number, sign = false, dollars = Math.abs(c) >= 10_000_00) => (dollars ? formatDollars(c, { sign }) : formatCents(c, { sign }))
const bigAny = (...c: number[]) => c.some((x) => Math.abs(x) >= 10_000_00)

/** The money-weighted rate, worded by what it is: '6.4%/yr' once held a year, else '+0.4% over 4 mo'. */
function rateText(r: Pick<ReturnBar, 'irr_micro' | 'annualized' | 'held_days'>): string | null {
  if (r.irr_micro === null) return null
  return r.annualized ? `${fmtPctMicro(r.irr_micro, { sign: true })}/yr` : `${fmtPctMicro(r.irr_micro, { sign: true })} over ${heldText(r.held_days)}`
}

/**
 * Why a priced holding shows no money-weighted rate, and what would give it
 * one. A starting position pasted without its acquisition date enters at its
 * market value on its as-of day; with no close near that day there is no
 * rate (never a 0%). Narrowed to an owner's accounts, a holding also held
 * outside them has none either.
 */
function noRateHint(b: ScopedReturn, positions: readonly PortfolioPosition[] | undefined, today: string): string {
  if (b.shared) return 'also held in accounts outside this view — its rate covers the whole holding, under Household'
  const day = noRateDay(b.asset_id, positions)
  return day ? `add the acquisition date or a price for ${shortDay(day, today)}` : 'add the starting position’s acquisition date, or a price for its as-of day'
}

export type HoldingsReturnsCardProps = {
  /** Bump to refetch (Investments passes its load counter). Without it, every keep-alive reveal refetches. */
  rev?: number
  /** The household's positions (GET /api/portfolio): the per-account split behind `accountIds`, and the day a missing rate needs a price for. */
  positions?: readonly PortfolioPosition[]
  /** Only these accounts (an owner pill; needs `positions`), named by `scopeLabel`. */
  accountIds?: ReadonlySet<number>
  scopeLabel?: string
}

/**
 * Return by holding: one diverging bar per open position, sorted best to
 * worst — unrealized return on what was paid, right in --up for a gain, left
 * in --down for a loss (the only thing those colours mean), all on one scale.
 * The annualized money-weighted rate shows beside it only once a holding is a
 * year old; younger ones name their holding period instead, since
 * annualizing a few weeks turns a small move into a huge rate. A holding with
 * no price yet is valued at cost, so it gets a hollow bar and says so.
 *
 * Hover or ←/→ on the chart for the figures behind each bar.
 */
export default function HoldingsReturnsCard({ rev, positions, accountIds, scopeLabel }: HoldingsReturnsCardProps) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const seq = useRef(0)
  const fetchReturns = useCallback(async (retry = false) => {
    const n = ++seq.current
    if (retry) setLoad({ state: 'loading' })
    try {
      const data = await get<ReturnsResponse>('/api/portfolio/returns')
      if (n === seq.current) setLoad({ state: 'ok', data })
    } catch (e) {
      if (n === seq.current) setLoad((l) => (l.state === 'ok' ? l : { state: 'error', message: e instanceof Error ? e.message : String(e) }))
    }
  }, [])
  // With `rev`, only a new one refetches: Investments reloads on every keep-alive reveal, so a reveal needn't too.
  const fetchedRev = useRef<number | null>(null)
  useEffect(() => {
    if (rev !== undefined) {
      if (fetchedRev.current === rev) return
      fetchedRev.current = rev
    }
    void fetchReturns()
  }, [fetchReturns, rev])
  const scoped = !!accountIds && !!positions
  const view = useMemo(
    (): ScopedReturns | null => (load.state !== 'ok' ? null : scoped ? scopeReturns(load.data, positions!, accountIds!) : load.data),
    [load, scoped, positions, accountIds],
  )

  if (load.state === 'loading')
    return (
      <div className="card c12" aria-busy="true" aria-label="Loading returns by holding">
        <Skeleton h={14} w={180} />
        <div className="ch-skel-rows">
          {[0, 1, 2].map((k) => (
            <Skeleton key={k} h={14} />
          ))}
        </div>
      </div>
    )
  if (load.state === 'error')
    return (
      <div className="card c12">
        <h2>Return by holding</h2>
        <div className="ch-empty">
          <p className="ch-hint">Couldn’t load the returns: {load.message}</p>
          <Button size="mini" onClick={() => void fetchReturns(true)}>
            Retry
          </Button>
        </div>
      </div>
    )
  if (!view || view.rows.length === 0) return null
  return <ReturnsChart data={view} positions={positions} scopeLabel={scoped ? scopeLabel : undefined} />
}

function ReturnsChart({ data, positions, scopeLabel }: { data: ScopedReturns; positions?: readonly PortfolioPosition[]; scopeLabel?: string }) {
  const { ref, width: W } = useChartSize()
  const { bars, zeroPct } = returnBars(data.rows)
  const grow = useGrow(W > 0, bars.length)
  const describe = (i: number) => {
    const b = bars[i]!
    if (!b.priced) return `${b.symbol}: no price yet, valued at cost ${money(b.cost_cents)}`
    const rate = rateText(b)
    const rateWords = rate ? `; ${rate} money-weighted` : `; no money-weighted rate — ${noRateHint(b, positions, data.as_of)}`
    return `${b.symbol}: ${b.unrealized_micro === null ? 'no return' : fmtPctMicro(b.unrealized_micro, { sign: true })} on cost, ${money(b.unrealized_cents, true)}${rateWords}; held ${heldText(b.held_days)}`
  }
  const nav = useBarNav({ n: bars.length, start: () => 0, describe })
  const t = data.totals
  const total = unrealizedAt(t.value_cents, t.cost_cents)
  const totalDollars = bigAny(t.value_cents, t.cost_cents, t.unrealized_cents)
  const trackX = LABEL_W + GAP
  const trackW = Math.max(1, W - LABEL_W - VALUE_W - 2 * GAP)
  const h = nav.hover !== null ? bars[nav.hover] : undefined
  const tipDollars = !!h && bigAny(h.value_cents, h.cost_cents, h.unrealized_cents)
  // Beside the bar, never over it: a gain's tip opens in the room left of zero when there is some, else past the bar's end.
  const tipX = (b: ReturnBar) => {
    const m = b.priced ? (b.unrealized_micro ?? 0) : 0
    if (m < 0) return zeroPct
    return zeroPct >= 30 ? 0 : Math.min(100, b.x + Math.max(b.w, b.priced ? 0 : 14))
  }
  const at = h ? { x: trackX + (trackW * tipX(h)) / 100, y: nav.hover! * ROW_H + ROW_H / 2 } : null
  const totalRate = t.irr_micro === null ? null : t.annualized ? `${fmtPctMicro(t.irr_micro, { sign: true })}/yr` : fmtPctMicro(t.irr_micro, { sign: true })

  return (
    <div className="card c12 ch-ret">
      <div className="h4row">
        <h2>
          Return by holding{scopeLabel && <span className="muted"> · {scopeLabel}</span>}
        </h2>
        <span className="sub2 ch-ret-sub">on what you paid · money-weighted rate once held a year</span>
      </div>
      <div
        className={`chart ch-nav ch-rets${grow ? ' ch-grow' : ''}`}
        ref={ref}
        role="group"
        aria-roledescription="bar chart"
        aria-label={`Return by holding${scopeLabel ? `, ${scopeLabel}` : ''}, ${bars.length} holdings, best first`}
        {...nav.focusProps}
        onPointerLeave={() => nav.setHover(null)}
      >
        {bars.map((b, i) => {
          const m = b.priced ? (b.unrealized_micro ?? 0) : 0
          const color = b.priced ? signColor(m) : MARK_VAR
          const rate = rateText(b)
          return (
            <div
              key={b.asset_id}
              className={`ch-driver ch-ret-row${nav.hover === i ? ' on' : ''}`}
              style={{ height: ROW_H, gridTemplateColumns: `${LABEL_W}px 1fr ${VALUE_W}px`, columnGap: GAP }}
              onPointerEnter={() => nav.setHover(i)}
            >
              <span className="ch-driver-nm ch-ret-sym">{b.symbol}</span>
              <svg width="100%" height={ROW_H} aria-hidden="true">
                <line x1={`${zeroPct}%`} x2={`${zeroPct}%`} y1={4} y2={ROW_H - 4} stroke="var(--axis)" />
                {!b.priced ? (
                  // No price yet: a hollow bar — there is no return to draw, only a holding carried at cost.
                  <rect className="ch-ret-hollow" x={`${zeroPct}%`} y={ROW_H / 2 - 5} width="14%" height={10} rx={2.5} />
                ) : b.w > 0 ? (
                  <rect
                    className={`ch-bar-h${m < 0 ? ' neg' : ''}`}
                    style={growStyle(i)}
                    x={`${b.x}%`}
                    y={ROW_H / 2 - 5}
                    width={`${b.w}%`}
                    height={10}
                    rx={2.5}
                    fill={color}
                  />
                ) : null}
              </svg>
              <span className="ch-driver-vl ch-ret-vl">
                {b.priced ? (
                  <>
                    <b style={{ color }}>{b.unrealized_micro === null ? '—' : fmtPctMicro(b.unrealized_micro, { sign: true })}</b>
                    {b.annualized && rate && <span className="ch-ret-rate">{rate}</span>}
                    {b.irr_micro === null && (
                      <span className="ch-ret-rate" title={`No money-weighted rate: ${noRateHint(b, positions, data.as_of)}`}>
                        rate —
                      </span>
                    )}
                  </>
                ) : (
                  <span className="ch-ret-none">No price yet</span>
                )}
              </span>
            </div>
          )
        })}
        <ChartTip at={at} box={{ w: W, h: bars.length * ROW_H }} rise={ROW_H / 2}>
          {h && (
            <>
              <div className="t">
                {h.symbol}
                <span className="ch-sub">held {heldText(h.held_days)}</span>
              </div>
              <TipRow name="Value" value={money(h.value_cents, false, tipDollars)} />
              <TipRow name="Cost basis" value={money(h.cost_cents, false, tipDollars)} />
              {h.priced ? (
                <>
                  <TipRow
                    name="Unrealized"
                    value={`${money(h.unrealized_cents, true, tipDollars)}${h.unrealized_micro !== null ? ` (${fmtPctMicro(h.unrealized_micro, { sign: true })})` : ''}`}
                    valueColor={signColor(h.unrealized_cents)}
                  />
                  <TipRow name="Money-weighted" value={rateText(h) ?? '—'} />
                  <TipRow name={scopeLabel ? 'Share of these accounts' : 'Share of portfolio'} value={fmtPctMicro(h.weight_micro)} />
                  {h.irr_micro === null && <div className="ch-note">No rate: {noRateHint(h, positions, data.as_of)}.</div>}
                </>
              ) : (
                <div className="ch-note">No price yet — valued at cost until one is recorded.</div>
              )}
            </>
          )}
        </ChartTip>
        <div className="ui-sr" aria-live="polite">
          {nav.live}
        </div>
      </div>
      <p className="ch-note ch-ret-total">
        {scopeLabel ? `All holdings in ${scopeLabel}:` : 'All holdings:'}{' '}
        <span style={{ color: signColor(t.unrealized_cents) }}>
          {money(t.unrealized_cents, true, totalDollars)}
          {total?.micro != null && ` (${fmtPctMicro(total.micro, { sign: true })})`}
        </span>{' '}
        on {money(t.cost_cents, false, totalDollars)} paid
        {totalRate && <> · {totalRate} money-weighted{t.annualized ? '' : ' (under a year, not annualized)'}</>}
        {totalRate && bars.some((b) => b.irr_micro === null) && ' · holdings without a price or a rate are left out of it'}
        {!totalRate && scopeLabel && ' · the combined money-weighted rate shows under Household'}
      </p>
    </div>
  )
}
