import { useId, useState, type PointerEvent } from 'react'
import { todayLocal } from '../shared/dates'
import { formatCents } from '../shared/money'
import { budgetLeft, bulletLayout, paceCents, shareText } from './chart/barsModel'
import { ChartTip, TipRow, type TipPoint } from './chart/ChartTip'
import { fmtAxis } from './chart/format'
import { DOWN_VAR, UP_VAR } from './chart/palette'
import { indexTicks, niceTicks } from './chart/scale'
import { useBarNav } from './chart/useBarNav'
import { useChartSize } from './chart/useChartSize'
import { growStyle, useGrow } from './chart/useGrow'
import './chart/chart.css'

/** Compact money: $78K / $1.2M / $85. Rounds across a unit boundary ($999,950 → "$1.0M", never "$1000K"). */
export function fmtShort(cents: number): string {
  const d = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  const k = Math.round(d / 1e3)
  if (d >= 1e6 || k >= 1000) {
    const m = d / 1e6
    return `${sign}$${m.toFixed(m < 9.95 ? 1 : 0)}M`
  }
  if (d >= 1e3 || Math.round(d) >= 1000) return `${sign}$${Math.max(1, k)}K`
  return `${sign}$${Math.round(d)}`
}

/** "2026-08" → "Aug '26" (short: "Aug"). */
export function fmtMonth(month: string, withYear = false): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = names[Number(month.slice(5, 7)) - 1] ?? month
  return withYear ? `${m} '${month.slice(2, 4)}` : m
}

/**
 * An x-axis month label for position i of n: the first and last carry the
 * year, and so does every January, so a reader never has to guess which year
 * a month belongs to.
 */
export function axisMonth(months: string[], i: number): string {
  const m = months[i] ?? ''
  return fmtMonth(m, i === 0 || i === months.length - 1 || m.slice(5, 7) === '01')
}

const ink3 = 'var(--ink-3)'
const grid = 'var(--grid)'
const AXIS_FONT = 10.5
/** The neutral hover wash behind a mark (the selected month's wash is --gold-dim). */
const WASH = 'rgba(255,255,255,.035)'

/* ---------------- grouped bars: income vs spending by month ---------------- */

export function GroupedBars({
  data,
  names,
  colors,
  tipLabel,
  selected = null,
  onSelect,
  selectHint = { idle: 'Click to select', on: 'Selected' },
  ariaLabel,
}: {
  data: { label: string; a: number; b: number }[]
  names: [string, string]
  colors: [string, string]
  /** The tooltip's title for group i (defaults to its axis label). */
  tipLabel?: (i: number) => string
  /** The group the rest of the screen is showing (Cash's month): a gold-dim column wash. */
  selected?: number | null
  /** Click (or Enter on) group i. Without it the groups only hover. */
  onSelect?: (i: number) => void
  /** The tooltip's last line when groups are selectable: before, and once this group is the selected one. */
  selectHint?: { idle: string; on: string }
  ariaLabel?: string
}) {
  const { ref, width: W } = useChartSize()
  const n = data.length
  const sel = selected !== null && selected >= 0 && selected < n ? selected : null
  const title = (i: number) => (tipLabel ? tipLabel(i) : (data[i]?.label ?? ''))
  const nav = useBarNav({
    n,
    start: () => sel ?? n - 1,
    describe: (i) => {
      const d = data[i]!
      return `${title(i)}: ${names[0]} ${formatCents(d.a)}, ${names[1]} ${formatCents(d.b)}${sel === i ? ', selected' : ''}`
    },
    onActivate: onSelect,
  })
  const grow = useGrow(W > 0, n)
  const hover = nav.hover
  const H = 220
  const padL = 56
  const padR = 10
  const padT = 12
  const padB = 24
  const vals = data.flatMap((d) => [d.a, d.b])
  const nt = niceTicks(Math.min(0, ...vals), Math.max(1, ...vals), 4)
  const plotW = Math.max(1, W - padL - padR)
  const gw = plotW / Math.max(1, n)
  const bw = Math.min(14, Math.max(4, (gw - 10) / 2))
  const y = (v: number) => padT + ((nt.hi - v) * (H - padT - padB)) / (nt.hi - nt.lo)
  const y0 = y(0)
  const bar = (cx: number, v: number, fill: string, i: number) => (
    <rect
      className={`ch-bar-v${v < 0 ? ' neg' : ''}`}
      style={growStyle(i)}
      x={cx}
      y={Math.min(y(v), y0)}
      width={bw}
      height={Math.abs(y0 - y(v))}
      rx={3}
      fill={fill}
    />
  )
  const cap = Math.max(2, Math.floor(plotW / 44))
  const labelled = new Set(n <= cap ? data.map((_, i) => i) : indexTicks(n, cap))
  const h = hover !== null ? data[hover] : undefined
  const at: TipPoint | null = hover !== null && h ? { x: padL + gw * hover + gw / 2 + bw + 2, y: padT + 6 } : null
  const label = ariaLabel ?? `${names[0]} vs ${names[1]} by month`
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  return (
    <div
      className={`chart ch-bars ch-nav${grow ? ' ch-grow' : ''}${onSelect ? ' is-selectable' : ''}`}
      ref={ref}
      role="group"
      aria-roledescription="bar chart"
      aria-label={label}
      aria-describedby={n ? `${uid}-d` : undefined}
      {...nav.focusProps}
      onPointerLeave={() => nav.setHover(null)}
    >
      {W > 0 && (
        <svg width={W} height={H} aria-hidden="true">
          {nt.ticks.map((v) => (
            <g key={v}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={grid} />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill={ink3} fontSize={AXIS_FONT} fontFamily="var(--mono)">
                {fmtAxis(v, 'cents')}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + gw * i + gw / 2
            return (
              <g key={`${d.label}-${i}`}>
                {sel === i && <rect className="ch-wash-sel" x={padL + gw * i + 2} y={padT} width={gw - 4} height={H - padT - padB} rx={4} fill="var(--gold-dim)" />}
                {hover === i && <rect className="ch-wash" x={padL + gw * i + 2} y={padT} width={gw - 4} height={H - padT - padB} rx={4} fill={WASH} />}
                {bar(cx - bw - 1, d.a, colors[0], i)}
                {bar(cx + 1, d.b, colors[1], i)}
                {labelled.has(i) && (
                  <text x={cx} y={H - 7} textAnchor="middle" fill={sel === i ? 'var(--ink)' : ink3} fontWeight={sel === i ? 600 : undefined} fontSize={AXIS_FONT}>
                    {d.label}
                  </text>
                )}
                <rect
                  x={padL + gw * i}
                  y={padT}
                  width={gw}
                  height={H - padT - padB}
                  fill="transparent"
                  onPointerEnter={() => nav.setHover(i)}
                  onClick={onSelect ? () => onSelect(i) : undefined}
                  style={onSelect ? { cursor: 'pointer' } : undefined}
                />
              </g>
            )
          })}
        </svg>
      )}
      <ChartTip at={at} box={{ w: W, h: H }} rise={0}>
        {h && hover !== null && (
          <>
            <div className="t">{title(hover)}</div>
            <TipRow color={colors[0]} name={names[0]} value={formatCents(h.a)} />
            <TipRow color={colors[1]} name={names[1]} value={formatCents(h.b)} />
            <TipRow name="Net" value={formatCents(h.a - h.b, { sign: true })} valueColor={h.a - h.b >= 0 ? UP_VAR : DOWN_VAR} />
            {onSelect && <div className="ch-note">{sel === hover ? selectHint.on : selectHint.idle}</div>}
          </>
        )}
      </ChartTip>
      {n > 0 && (
        <p id={`${uid}-d`} className="ui-sr">
          {`${title(0)} to ${title(n - 1)}.${sel !== null ? ` ${title(sel)} is selected.` : ''} Arrow keys step through them${onSelect ? '; Enter selects one' : ''}.`}
        </p>
      )}
      <div className="ui-sr" aria-live="polite">
        {nav.live}
      </div>
    </div>
  )
}

/* ---------------- horizontal bars: category breakdown ---------------- */

export function HBars({
  data,
  color,
  tipTitle,
  total,
  onSelect,
  selectHint = 'Click to select',
  ariaLabel = 'Spending by category',
}: {
  data: { name: string; cents: number }[]
  color: string
  /** The tooltip's title (the month the bars describe). */
  tipTitle?: string
  /** What a bar's share is of; defaults to the sum of the positive bars. */
  total?: number
  /** Click (or Enter on) bar i. */
  onSelect?: (i: number) => void
  /** The tooltip's last line when bars are clickable. */
  selectHint?: string
  ariaLabel?: string
}) {
  const { ref, width: W } = useChartSize()
  const n = data.length
  const whole = total ?? data.reduce((s, d) => s + Math.max(0, d.cents), 0)
  const nav = useBarNav({
    n,
    start: () => 0,
    describe: (i) => `${data[i]!.name}: ${formatCents(data[i]!.cents)}, ${shareText(data[i]!.cents, whole)} of the total`,
    onActivate: onSelect,
  })
  const grow = useGrow(W > 0, n)
  const hover = nav.hover
  const rowH = 27
  const hi = Math.max(1, ...data.map((d) => d.cents))
  const lw = 110
  const vw = 64
  const barW = (cents: number) => Math.max(3, (W - lw - vw - 10) * (cents / hi))
  const h = hover !== null ? data[hover] : undefined
  const at: TipPoint | null = h && hover !== null ? { x: lw + barW(h.cents) + 52, y: hover * rowH + rowH / 2 } : null

  return (
    <div
      className={`chart ch-bars ch-nav${grow ? ' ch-grow' : ''}`}
      ref={ref}
      role="group"
      aria-roledescription="bar chart"
      aria-label={ariaLabel}
      {...nav.focusProps}
      onPointerLeave={() => nav.setHover(null)}
    >
      {W > 0 && (
        <svg width={W} height={n * rowH + 4} aria-hidden="true">
          {data.map((d, i) => {
            const yy = i * rowH + rowH / 2
            const bw = barW(d.cents)
            return (
              <g
                key={`${d.name}-${i}`}
                onPointerEnter={() => nav.setHover(i)}
                onClick={onSelect ? () => onSelect(i) : undefined}
                style={onSelect ? { cursor: 'pointer' } : undefined}
              >
                <rect className={hover === i ? 'ch-wash' : undefined} x={0} y={i * rowH + 1} width={W} height={rowH - 2} rx={5} fill={hover === i ? WASH : 'transparent'} />
                <text x={6} y={yy + 4} fill={hover === i ? 'var(--ink)' : 'var(--ink-2)'} fontSize={12}>
                  {d.name.length > 15 ? d.name.slice(0, 14) + '…' : d.name}
                </text>
                <rect className="ch-bar-h" style={growStyle(i)} x={lw} y={yy - 6} width={bw} height={12} rx={3} fill={color} />
                <text x={lw + bw + 8} y={yy + 4} fill="var(--ink-2)" fontSize={11.5} fontFamily="var(--mono)">
                  {fmtShort(d.cents)}
                </text>
              </g>
            )
          })}
        </svg>
      )}
      <ChartTip at={at} box={{ w: W, h: n * rowH + 4 }} rise={rowH / 2}>
        {h && (
          <>
            {tipTitle && <div className="t">{tipTitle}</div>}
            <TipRow color={color} name={h.name} value={formatCents(h.cents)} />
            <TipRow name="Share" value={shareText(h.cents, whole)} />
            {onSelect && <div className="ch-note">{selectHint}</div>}
          </>
        )}
      </ChartTip>
      <div className="ui-sr" aria-live="polite">
        {nav.live}
      </div>
    </div>
  )
}

/* ---------------- bullets: plan vs actual ---------------- */

const BULLET_ROW = 34
const BULLET_CAPTION = 24

/**
 * Plan vs. actual per category (mockup `bullets`): the month's spending as a
 * bar against its budget line, --down once it is over. `month` (YYYY-MM) is
 * the month the rows describe; while it is the current month a dashed pace
 * tick shows where spending would be today if the budget were spent evenly.
 * Rows without a budget sit apart under a "No budget" caption in neutral ink,
 * so they never read as a nearly-full plan (bug #43).
 */
export function Bullets({ data, month }: { data: { name: string; actual: number; budget: number }[]; month?: string }) {
  const { ref, width: W } = useChartSize()
  const today = todayLocal()
  const layout = bulletLayout(data, BULLET_ROW, BULLET_CAPTION)
  const rows = layout.rows
  const n = rows.length
  const paceOf = (budget: number) => (month ? paceCents(budget, month, today) : null)
  const anyPace = rows.some((r) => paceOf(r.row.budget) !== null)
  const anyBudget = rows.some((r) => r.row.budget > 0)
  const nav = useBarNav({
    n,
    start: () => 0,
    describe: (i) => {
      const d = rows[i]!.row
      if (!(d.budget > 0)) return `${d.name}: spent ${formatCents(d.actual)}, no budget`
      const pace = paceOf(d.budget)
      const lft = budgetLeft(d.actual, d.budget)
      return `${d.name}: spent ${formatCents(d.actual)} of ${formatCents(d.budget)}${
        lft && 'over' in lft ? `, over by ${formatCents(lft.over)}` : ''
      }${pace !== null ? `; pace for today ${formatCents(pace)}` : ''}`
    },
  })
  const grow = useGrow(W > 0, n)
  const hover = nav.hover
  const hi = Math.max(1, ...data.map((d) => Math.max(d.budget, d.actual))) * 1.1
  const valueText = (d: { actual: number; budget: number }) => (d.budget > 0 ? `${fmtShort(d.actual)} / ${fmtShort(d.budget)}` : fmtShort(d.actual))
  const lw = 104
  // The value column is as wide as its widest label (monospace ≈ 7px a character), so a narrow card keeps its track.
  const vw = Math.max(48, ...rows.map((r) => valueText(r.row).length * 7 + 14))
  const track = Math.max(1, W - lw - vw)
  const xOf = (cents: number) => lw + track * (Math.max(0, cents) / hi)
  const hr = hover !== null ? rows[hover] : undefined
  const at: TipPoint | null = hr ? { x: Math.max(xOf(hr.row.actual), hr.row.budget > 0 ? xOf(hr.row.budget) : 0) + 6, y: hr.y + BULLET_ROW / 2 } : null
  const hd = hr?.row
  const hPace = hd ? paceOf(hd.budget) : null
  const hLeft = hd ? budgetLeft(hd.actual, hd.budget) : null

  return (
    <div className="ch-bullets">
      {anyBudget && (
        <div className="legend ch-bullets-legend" aria-hidden="true">
          <span className="li">
            <span className="sw" style={{ background: 'var(--s1)' }} />
            Spent
          </span>
          <span className="li">
            <span className="sw ch-sw-tick" />
            Budget
          </span>
          {anyPace && (
            <span className="li">
              <span className="sw ch-sw-pace" />
              Pace today
            </span>
          )}
        </div>
      )}
      <div
        className={`chart ch-bars ch-nav${grow ? ' ch-grow' : ''}`}
        ref={ref}
        role="group"
        aria-roledescription="bar chart"
        aria-label={`Budget plan vs actual${month ? `, ${fmtMonth(month, true)}` : ''}`}
        {...nav.focusProps}
        onPointerLeave={() => nav.setHover(null)}
      >
        {W > 0 && (
          <svg width={W} height={layout.height} aria-hidden="true">
            {layout.captionY !== null && (
              <g>
                <line x1={0} x2={W} y1={layout.captionY + 5} y2={layout.captionY + 5} stroke="var(--line)" />
                <text x={6} y={layout.captionY + 19} fill={ink3} fontSize={11}>
                  No budget
                </text>
              </g>
            )}
            {rows.map(({ row: d, y: top }, i) => {
              const yy = top + BULLET_ROW / 2
              const budgeted = d.budget > 0
              const over = budgeted && d.actual > d.budget
              const pace = paceOf(d.budget)
              return (
                <g key={`${d.name}-${i}`} onPointerEnter={() => nav.setHover(i)}>
                  <rect className={hover === i ? 'ch-wash' : undefined} x={0} y={top + 2} width={W} height={BULLET_ROW - 4} rx={5} fill={hover === i ? WASH : 'transparent'} />
                  <text x={6} y={yy + 4} fill={hover === i ? 'var(--ink)' : budgeted ? 'var(--ink-2)' : ink3} fontSize={12}>
                    {d.name.length > 13 ? d.name.slice(0, 12) + '…' : d.name}
                  </text>
                  <rect x={lw} y={yy - 7} width={track} height={14} rx={4} fill="rgba(255,255,255,.05)" />
                  <rect
                    className="ch-bar-h"
                    style={growStyle(i)}
                    x={lw}
                    y={yy - 7}
                    width={Math.max(3, xOf(d.actual) - lw)}
                    height={14}
                    rx={4}
                    fill={!budgeted ? ink3 : over ? DOWN_VAR : 'var(--s1)'}
                    opacity={budgeted ? 1 : 0.6}
                  />
                  {budgeted && <line x1={xOf(d.budget)} x2={xOf(d.budget)} y1={yy - 10} y2={yy + 10} stroke="var(--ink-2)" strokeWidth={2} />}
                  {pace !== null && (
                    <line className="ch-pace" x1={xOf(pace)} x2={xOf(pace)} y1={yy - 7} y2={yy + 7} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="2 2" opacity={0.85} />
                  )}
                  <text x={W} y={yy + 4} textAnchor="end" fill={over ? DOWN_VAR : budgeted ? 'var(--ink-2)' : ink3} fontSize={11.5} fontFamily="var(--mono)">
                    {valueText(d)}
                  </text>
                </g>
              )
            })}
          </svg>
        )}
        <ChartTip at={at} box={{ w: W, h: layout.height }} rise={BULLET_ROW / 2}>
          {hd && (
            <>
              <div className="t">
                {hd.name}
                {month && <span className="ch-sub">{fmtMonth(month, true)}</span>}
              </div>
              <TipRow color={!(hd.budget > 0) ? ink3 : hLeft && 'over' in hLeft ? DOWN_VAR : 'var(--s1)'} name="Spent" value={formatCents(hd.actual)} />
              {hd.budget > 0 ? (
                <>
                  <TipRow name="Budget" value={formatCents(hd.budget)} />
                  {hPace !== null && <TipRow name="Pace for today" value={formatCents(hPace)} />}
                  {hLeft && ('over' in hLeft ? <TipRow name="Over by" value={formatCents(hLeft.over)} valueColor={DOWN_VAR} /> : <TipRow name="Left" value={formatCents(hLeft.left)} />)}
                </>
              ) : (
                <div className="ch-note">No budget set for this category</div>
              )}
            </>
          )}
        </ChartTip>
        <div className="ui-sr" aria-live="polite">
          {nav.live}
        </div>
      </div>
    </div>
  )
}

/* ---------------- donut with legend ---------------- */

const TAU = Math.PI * 2

/**
 * One ring segment from angle a0 to a1. A full turn is drawn as two half
 * arcs — an SVG arc whose start and end coincide draws nothing, which made
 * the ring vanish at 100% of one class (bug #33).
 */
export function ringPath(cx: number, cy: number, R: number, r: number, a0: number, a1: number): string {
  const p = (a: number, rr: number) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`
  if (a1 - a0 >= TAU - 1e-6) {
    const mid = a0 + Math.PI
    return (
      `M${p(a0, R)}A${R} ${R} 0 0 1 ${p(mid, R)}A${R} ${R} 0 0 1 ${p(a0, R)}Z` +
      `M${p(a0, r)}A${r} ${r} 0 0 0 ${p(mid, r)}A${r} ${r} 0 0 0 ${p(a0, r)}Z`
    )
  }
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${p(a0, R)}A${R} ${R} 0 ${large} 1 ${p(a1, R)}L${p(a1, r)}A${r} ${r} 0 ${large} 0 ${p(a0, r)}Z`
}

export function Donut({ data, centerLabel = 'total' }: { data: { name: string; cents: number; color: string }[]; centerLabel?: string }) {
  const { ref, width: W } = useChartSize()
  const [hover, setHover] = useState<number | null>(null)
  const [tipAt, setTipAt] = useState<TipPoint | null>(null)
  const shown = data.filter((d) => d.cents > 0)
  const tot = shown.reduce((s, d) => s + d.cents, 0)
  const S = 168
  const c = S / 2
  const R = 74
  const r = 51
  const share = (cents: number) => Math.round((cents * 100) / tot)
  let a0 = -Math.PI / 2
  const hv = hover !== null ? shown[hover] : undefined

  const enter = (i: number) => setHover(i)
  const leave = () => {
    setHover(null)
    setTipAt(null)
  }
  const move = (ev: PointerEvent<SVGPathElement>) => {
    const box = (ev.currentTarget.closest('.chart') as HTMLElement | null)?.getBoundingClientRect()
    if (box) setTipAt({ x: ev.clientX - box.left, y: ev.clientY - box.top - 34 })
  }

  return (
    <div className="chart ch-donut" ref={ref}>
      {W > 0 && tot > 0 && (
        <>
          <svg width={S} height={S} role="img" aria-label={`allocation: ${shown.map((d) => `${d.name} ${share(d.cents)}%`).join(', ')}`}>
            {shown.map((d, i) => {
              const a1 = a0 + (d.cents / tot) * TAU
              const dpath = ringPath(c, c, R, r, a0, a1)
              a0 = a1
              return (
                <path
                  key={d.name}
                  d={dpath}
                  fill={d.color}
                  fillRule="evenodd"
                  stroke="var(--card)"
                  strokeWidth={shown.length > 1 ? 2 : 0}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                  onPointerEnter={() => enter(i)}
                  onPointerMove={move}
                  onPointerLeave={leave}
                />
              )
            })}
            <text x={c} y={c - 2} textAnchor="middle" fill="var(--ink)" fontSize={16} fontWeight={650} pointerEvents="none">
              {fmtShort(hv ? hv.cents : tot)}
            </text>
            <text x={c} y={c + 15} textAnchor="middle" fill={ink3} fontSize={10.5} pointerEvents="none">
              {hv ? hv.name : centerLabel}
            </text>
          </svg>
          <div className="ch-donut-legend">
            {shown.map((d, i) => (
              <div key={d.name} className="r" onPointerEnter={() => enter(i)} onPointerLeave={leave} style={{ opacity: hover === null || hover === i ? 1 : 0.5 }}>
                <span className="sw" style={{ background: d.color }} />
                <span className="nm">{d.name}</span>
                <span className="vl">{share(d.cents)}%</span>
              </div>
            ))}
          </div>
          <ChartTip at={tipAt && hv ? tipAt : null} box={{ w: W, h: 0 }} rise={0}>
            {hv && <TipRow color={hv.color} name={hv.name} value={`${fmtShort(hv.cents)} · ${share(hv.cents)}%`} />}
          </ChartTip>
        </>
      )}
    </div>
  )
}
