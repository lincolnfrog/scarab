import { useId, useMemo, useState, type FocusEvent, type KeyboardEvent, type PointerEvent } from 'react'
import { formatCents, formatQtyMicro } from '../shared/money'
import { sma, weeklySmaDaily } from '../shared/series'
import { ChartTip, TipRow, type TipPoint } from './chart/ChartTip'
import { fmtAxis } from './chart/format'
import { Legend } from './chart/Legend'
import { blendMa, maSpanMs, timeWeightedMa } from './chart/maModel'
import { MARK_VAR, SLOT_VAR } from './chart/palette'
import { DAY_MS, decimateM4, fmtDay, logTicks, nearestIndex, niceTicks, parseT, timeTicks } from './chart/scale'
import { useChartSize } from './chart/useChartSize'
import { Segmented } from './ui/Segmented'
import './chart/chart.css'

type Pt = { d: string; c: number }
/**
 * Where the closes came from (A2, shared/series-api.ts PriceCoverage): daily
 * history throughout, or the quote table first — month-end closes (A5's
 * monthly history) until `dailyFrom`, the first daily close.
 */
export type ChartCoverage = { firstOn: string | null; days: number; source: 'daily' | 'quotes'; dailyFrom?: string | null }
export type ChartData = {
  symbol: string
  kind: 'stock' | 'crypto'
  closes: Pt[]
  errors?: string[]
  coverage?: ChartCoverage
}
/** A buy or sell to mark on the price line (the TradeRow fields it needs). */
export type ChartTrade = { id: number; traded_on: string; side: 'buy' | 'sell'; qty_micro: number; total_cents: number; account_name?: string }

const RANGES = { '1Y': 365, '4Y': 1461, ALL: Infinity } as const
type RangeKey = keyof typeof RANGES
type MaKey = '50D' | '200D' | '200W'
const MAS: { key: MaKey; label: string; color: string; kind: 'days' | 'weeks'; n: number }[] = [
  { key: '50D', label: '50D MA', color: SLOT_VAR[2], kind: 'days', n: 50 },
  { key: '200D', label: '200D MA', color: SLOT_VAR[3], kind: 'days', n: 200 },
  { key: '200W', label: '200W MA', color: SLOT_VAR[4], kind: 'weeks', n: 200 },
]
const PRICE = SLOT_VAR[1]

const H = 360
const padL = 64
const padR = 14
const padT = 12
const padB = 24

/** Below this hi/lo ratio a log axis shows next to nothing, so the chart draws linear. */
const LOG_MIN_RATIO = 2

/** ▲ under the line for a buy, ▼ over it for a sell — neutral ink, never up/down colours. */
function glyph(x: number, y: number, side: 'buy' | 'sell'): string {
  const s = 5
  return side === 'buy'
    ? `M${x} ${y}l${s} ${s * 1.6}h${-2 * s}Z`
    : `M${x} ${y}l${s} ${-s * 1.6}h${-2 * s}Z`
}

/**
 * Daily price history for one symbol: range presets, log/linear, three
 * moving averages, a crosshair tooltip and the household's own buys and
 * sells. Drawn at the card's real width, on a UTC time axis whose year ticks
 * thin evenly; long histories are M4-decimated per pixel column. A history
 * that starts in the quote table (month-end closes until the first daily
 * one) draws that stretch dotted, its moving averages over calendar time.
 *
 * The plot is one tab stop, like TimeChart's: ←/→ step through the closes in
 * view (Shift: about a tenth of them), Home/End jump to the ends, Esc clears;
 * each step is read out.
 */
export default function BigChart({ data, trades = [] }: { data: ChartData; trades?: ChartTrade[] }) {
  const { ref, width: W } = useChartSize()
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const clipId = `ch-clip-${uid}`
  const [scalePref, setScalePref] = useState<'log' | 'linear'>('log')
  const [range, setRange] = useState<RangeKey>('ALL')
  const [mas, setMas] = useState<Set<MaKey>>(() => new Set<MaKey>(['200D', '200W']))
  const [hoverX, setHoverX] = useState<number | null>(null)
  /** The close the keyboard is on (an index into the full series); wins over the pointer until the pointer moves. */
  const [keyI, setKeyI] = useState<number | null>(null)
  const [liveText, setLiveText] = useState('')
  const quotesOnly = data.coverage?.source === 'quotes'
  const dailyFrom = quotesOnly ? (data.coverage?.dailyFrom ?? null) : null

  const full = useMemo(() => {
    const ts = data.closes.map((p) => parseT(p.d))
    const vs = data.closes.map((p) => p.c)
    const exact: Record<MaKey, (number | null)[]> = {
      '50D': sma(vs, 50),
      '200D': sma(vs, 200),
      '200W': weeklySmaDaily(data.closes, 200),
    }
    // Month-ends before the daily closes (A5): there, a count of closes would span years, so each
    // average covers its calendar span instead (src/chart/maModel.ts).
    const parsed = dailyFrom ? parseT(dailyFrom) : NaN
    const dailyT = Number.isFinite(parsed) ? parsed : null
    const ma = quotesOnly
      ? (Object.fromEntries(
          MAS.map((m) => {
            const span = maSpanMs(m, data.kind)
            return [m.key, blendMa(ts, exact[m.key], timeWeightedMa(ts, vs, span), dailyT, span)]
          }),
        ) as Record<MaKey, (number | null)[]>)
      : exact
    // The first daily close: the dotted month-end stretch runs up to it (all of the line, with no daily closes).
    const at = dailyT === null ? -1 : ts.findIndex((t) => t >= dailyT)
    const firstDaily = !quotesOnly ? 0 : at < 0 ? ts.length : at
    return { ts, vs, ma, firstDaily }
  }, [data, quotesOnly, dailyFrom])

  const plotW = Math.max(1, W - padL - padR)
  const plotH = H - padT - padB

  const view = useMemo(() => {
    const { ts, vs, ma } = full
    const n = ts.length
    if (n < 2) return null
    const tEnd = ts[n - 1]!
    const t0 = range === 'ALL' ? ts[0]! : Math.max(ts[0]!, tEnd - RANGES[range] * DAY_MS)
    let i0 = ts.findIndex((t) => t >= t0)
    if (i0 < 0) i0 = n - 1
    let lo = Infinity
    let hi = -Infinity
    const take = (v: number | null | undefined) => {
      if (v === null || v === undefined) return
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    for (let i = i0; i < n; i++) {
      take(vs[i])
      for (const m of MAS) if (mas.has(m.key)) take(ma[m.key][i])
    }
    const logOk = lo > 0 && hi / lo >= LOG_MIN_RATIO
    const scale: 'log' | 'linear' = scalePref === 'log' && logOk ? 'log' : 'linear'
    let y: (v: number) => number
    let ticks: number[]
    if (scale === 'log') {
      const pad = (Math.log10(hi) - Math.log10(lo)) * 0.04
      const lLo = Math.log10(lo) - pad
      const lHi = Math.log10(hi) + pad
      y = (v) => padT + ((lHi - Math.log10(Math.max(v, 1e-9))) * plotH) / (lHi - lLo)
      ticks = logTicks(lo, hi)
    } else {
      const nt = niceTicks(lo, hi, 5)
      y = (v) => padT + ((nt.hi - v) * plotH) / (nt.hi - nt.lo || 1)
      ticks = nt.ticks
    }
    const x = (t: number) => padL + ((t - t0) / (tEnd - t0 || 1)) * plotW
    const keep = {
      price: decimateM4(ts, vs, t0, tEnd, plotW),
      ...Object.fromEntries(MAS.map((m) => [m.key, mas.has(m.key) ? decimateM4(ts, ma[m.key], t0, tEnd, plotW) : []])),
    } as Record<'price' | MaKey, number[]>
    return { t0, tEnd, i0, x, y, ticks, scale, logOk, keep, xTicks: timeTicks(t0, tEnd, plotW) }
  }, [full, range, scalePref, mas, plotW, plotH])

  const marks = useMemo(() => {
    if (!view) return []
    const { ts } = full
    const byDay = new Map<string, { t: number; buy: ChartTrade[]; sell: ChartTrade[] }>()
    for (const tr of trades) {
      const t = parseT(tr.traded_on)
      if (!Number.isFinite(t) || t < view.t0 || t > view.tEnd) continue
      const m = byDay.get(tr.traded_on) ?? { t, buy: [], sell: [] }
      m[tr.side].push(tr)
      byDay.set(tr.traded_on, m)
    }
    return [...byDay.entries()].map(([day, m]) => {
      // The close the trade sits on: that day's, or the last one before it (a weekend trade).
      let i = nearestIndex(ts, m.t)
      if (ts[i]! > m.t && i > 0) i--
      return { day, ...m, i }
    })
  }, [full, trades, view])

  if (!view) return <p className="sub2">Not enough history to draw yet.</p>
  const { t0, tEnd, x, y, ticks, xTicks, keep, scale, logOk } = view
  const { ts, vs, ma, firstDaily } = full
  // The drawn closes either side of the first daily one; the dotted month-end stretch runs on to it, so the line joins.
  const monthEnds = keep.price.filter((i) => i < firstDaily)
  const joined = monthEnds.length > 0 && firstDaily < ts.length
  const monthly = joined ? [...monthEnds, firstDaily] : monthEnds
  const daily = keep.price.filter((i) => i >= firstDaily)
  if (joined && daily[0] !== firstDaily) daily.unshift(firstDaily)

  const path = (idx: number[], vals: (number | null)[]) => {
    let d = ''
    let pen = false
    for (const i of idx) {
      const v = vals[i]
      if (v === null || v === undefined) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(ts[i]!).toFixed(1)} ${y(v).toFixed(1)}`
      pen = true
    }
    return d
  }

  const n = ts.length
  const kI = keyI !== null && keyI >= view.i0 && keyI < n ? keyI : null
  // Hover: the keyboard's close; else snap to the nearest close in view — or to a trade marker within 6px, so its row shows.
  let hoverI: number | null = null
  let hoverMark: (typeof marks)[number] | null = null
  if (kI !== null) {
    hoverI = kI
    hoverMark = marks.find((m) => m.i === kI) ?? null
  } else if (hoverX !== null) {
    const t = t0 + ((hoverX - padL) / plotW) * (tEnd - t0)
    hoverMark = marks.reduce<(typeof marks)[number] | null>((best, m) => {
      const dx = Math.abs(x(m.t) - hoverX)
      return dx <= 6 && (!best || dx < Math.abs(x(best.t) - hoverX)) ? m : best
    }, null)
    hoverI = hoverMark ? hoverMark.i : Math.max(view.i0, nearestIndex(ts, t))
  }
  const hoverT = hoverMark ? hoverMark.t : hoverI !== null ? ts[hoverI]! : null
  const at: TipPoint | null = hoverI !== null && hoverT !== null ? { x: x(hoverT), y: y(vs[hoverI]!) } : null

  const onMove = (ev: PointerEvent<SVGSVGElement>) => {
    const px = ev.clientX - ev.currentTarget.getBoundingClientRect().left
    setKeyI(null)
    setHoverX(px < padL - 4 || px > W - padR + 4 ? null : Math.min(W - padR, Math.max(padL, px)))
  }

  /* Keyboard: the same crosshair, stepped close by close. */
  const describe = (i: number) => {
    const parts = [`${data.symbol} ${formatCents(vs[i]!)}`]
    for (const m of MAS) {
      const v = ma[m.key][i]
      if (mas.has(m.key) && v != null) parts.push(`${m.label} ${formatCents(v)}`)
    }
    const mk = marks.find((x) => x.i === i)
    const done = mk ? [...mk.buy, ...mk.sell].map((tr) => `${tr.side === 'buy' ? 'bought' : 'sold'} ${formatQtyMicro(tr.qty_micro)} sh`) : []
    return `${fmtDay(ts[i]!)}: ${parts.join('; ')}${done.length ? `. You ${done.join(', ')}` : ''}`
  }
  const moveKey = (i: number | null) => {
    setKeyI(i)
    setHoverX(null)
    setLiveText(i === null ? '' : describe(i))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return
    const lo = view.i0
    const hi = n - 1
    const step = e.shiftKey ? Math.max(1, Math.round((hi - lo) / 10)) : 1
    let next: number | null
    switch (e.key) {
      case 'ArrowLeft':
        next = kI === null ? hi : Math.max(lo, kI - step)
        break
      case 'ArrowRight':
        next = kI === null ? lo : Math.min(hi, kI + step)
        break
      case 'Home':
        next = lo
        break
      case 'End':
        next = hi
        break
      case 'Escape':
        if (kI === null) return
        next = null
        break
      default:
        return
    }
    e.preventDefault()
    moveKey(next)
  }
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && kI === null && e.currentTarget.matches(':focus-visible')) moveKey(n - 1)
  }
  // Quote-table history (A5): month-end closes, then daily ones from the first daily close.
  const coverageNote = !quotesOnly
    ? ''
    : firstDaily < n
      ? `Monthly closes until ${fmtDay(ts[firstDaily]!)}, daily after.`
      : `Monthly closes only${data.coverage?.firstOn ? ` since ${fmtDay(parseT(data.coverage.firstOn))}` : ''} — no daily history yet.`
  const summary = `${fmtDay(t0)} to ${fmtDay(tEnd)}, ${scale} scale. Last close ${formatCents(vs[n - 1]!)} on ${fmtDay(ts[n - 1]!)}.${
    coverageNote ? ` ${coverageNote}` : ''
  }${marks.length ? ` Your trades are marked on ${marks.length} day${marks.length === 1 ? '' : 's'}.` : ''} Arrow keys step through the closes.`

  const toggleMa = (id: string, hidden: boolean) =>
    setMas((s) => {
      const next = new Set(s)
      if (hidden) next.delete(id as MaKey)
      else next.add(id as MaKey)
      return next
    })

  return (
    <div>
      <div className="ch-bar">
        <Segmented<RangeKey>
          aria-label="Range"
          value={range}
          onChange={setRange}
          options={(Object.keys(RANGES) as RangeKey[]).map((r) => ({ value: r, label: r }))}
        />
        <Segmented<'log' | 'linear'>
          aria-label="Scale"
          value={scale}
          onChange={setScalePref}
          options={[
            {
              value: 'log',
              label: 'Log',
              disabled: !logOk,
              title: logOk ? undefined : 'This range moves less than 2×, so a log scale would look flat — showing linear',
            },
            { value: 'linear', label: 'Linear' },
          ]}
        />
        <Legend
          aria-label="Series"
          min={1}
          onToggle={toggleMa}
          items={[
            { id: 'px', label: data.symbol, color: PRICE, mark: quotesOnly && firstDaily >= ts.length ? 'dash' : 'line', fixed: true },
            ...MAS.map((m) => ({ id: m.key, label: m.label, color: m.color, mark: 'line' as const, hidden: !mas.has(m.key) })),
          ]}
        />
      </div>
      <div
        className="chart ch-nav"
        ref={ref}
        tabIndex={0}
        role="group"
        aria-roledescription="chart"
        aria-label={`${data.symbol} price history`}
        aria-describedby={`${uid}-d`}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={() => setKeyI(null)}
      >
        {W > 0 && (
          <svg
            width={W}
            height={H}
            aria-hidden="true"
            onPointerMove={onMove}
            onPointerLeave={() => setHoverX(null)}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={padL} y={padT - 2} width={plotW} height={plotH + 4} />
              </clipPath>
            </defs>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill="var(--ink-3)" fontSize={10.5} fontFamily="var(--mono)">
                  {fmtAxis(v, 'cents')}
                </text>
              </g>
            ))}
            {xTicks.map((k) => (
              <text key={k.t} x={x(k.t)} y={H - 7} textAnchor="middle" fill={k.major ? 'var(--ink-2)' : 'var(--ink-3)'} fontSize={10.5}>
                {k.label}
              </text>
            ))}
            <g clipPath={`url(#${clipId})`}>
              {MAS.map((m) =>
                mas.has(m.key) ? <path key={m.key} d={path(keep[m.key], ma[m.key])} fill="none" stroke={m.color} strokeWidth={1.6} /> : null,
              )}
              {monthly.length > 0 && (
                // Month-ends: dotted, up to the first daily close, with a dot on each close while they're few enough to tell apart.
                <path d={path(monthly, vs)} fill="none" stroke={PRICE} strokeWidth={2.2} strokeDasharray="0 5" strokeLinecap="round" strokeLinejoin="round" />
              )}
              {daily.length > 0 && <path d={path(daily, vs)} fill="none" stroke={PRICE} strokeWidth={1.8} strokeLinejoin="round" />}
              {monthEnds.length > 0 &&
                monthEnds.length <= 160 &&
                monthEnds.map((i) => <circle key={i} cx={x(ts[i]!)} cy={y(vs[i]!)} r={2.4} fill={PRICE} />)}
              {marks.map((m) => {
                const mx = x(m.t)
                const py = y(vs[m.i]!)
                return (
                  <g key={m.day} fill={MARK_VAR} stroke="var(--card)" strokeWidth={1}>
                    {m.buy.length > 0 && <path d={glyph(mx, py + 7, 'buy')} />}
                    {m.sell.length > 0 && <path d={glyph(mx, py - 7, 'sell')} />}
                  </g>
                )
              })}
            </g>
            {hoverI !== null && hoverT !== null && (
              <g pointerEvents="none">
                <line x1={x(hoverT)} x2={x(hoverT)} y1={padT} y2={H - padB} stroke="var(--axis)" />
                <circle className="ch-pop" cx={x(hoverT)} cy={y(vs[hoverI]!)} r={4.5} fill={PRICE} stroke="#0c1017" strokeWidth={2} />
                {MAS.map((m) => {
                  const v = ma[m.key][hoverI!]
                  return mas.has(m.key) && v != null ? <circle key={m.key} className="ch-pop" cx={x(hoverT)} cy={y(v)} r={3.5} fill={m.color} stroke="#0c1017" strokeWidth={2} /> : null
                })}
              </g>
            )}
          </svg>
        )}
        <ChartTip at={at} box={{ w: W, h: H }}>
          {hoverI !== null && hoverT !== null && (
            <>
              <div className="t">
                {fmtDay(hoverT)}
                {hoverMark && ts[hoverI] !== hoverT && <span className="ch-sub">close {fmtDay(ts[hoverI]!)}</span>}
              </div>
              <TipRow color={PRICE} mark="line" name={data.symbol} value={formatCents(vs[hoverI]!)} />
              {MAS.map((m) => {
                const v = ma[m.key][hoverI!]
                return mas.has(m.key) && v != null ? <TipRow key={m.key} color={m.color} mark="line" name={m.label} value={formatCents(v)} /> : null
              })}
              {hoverMark &&
                [...hoverMark.buy, ...hoverMark.sell].map((tr) => (
                  <TipRow
                    key={tr.id}
                    name={`${tr.side === 'buy' ? '▲ Bought' : '▼ Sold'} ${formatQtyMicro(tr.qty_micro)} sh${tr.account_name ? ` · ${tr.account_name}` : ''}`}
                    value={formatCents(tr.total_cents)}
                  />
                ))}
            </>
          )}
        </ChartTip>
        <p id={`${uid}-d`} className="ui-sr">
          {summary}
        </p>
        <div className="ui-sr" aria-live="polite">
          {liveText}
        </div>
      </div>
      {(coverageNote || marks.length > 0) && (
        <div className="ch-note">
          {coverageNote && `${coverageNote} Dotted where it's month-ends; the moving averages there span calendar days, not closes. `}
          {marks.length > 0 && '▲ your buys · ▼ your sells.'}
        </div>
      )}
    </div>
  )
}
