import { useState, type ReactNode } from 'react'
import { formatCents, formatDollars } from '../../shared/money'
import { Link, type RouteTarget } from '../router'
import { ChartTip, TipRow } from './ChartTip'
import { signColor } from './palette'
import { useChartSize } from './useChartSize'
import { growStyle, useGrow } from './useGrow'
import './chart.css'

export type DriverRow = { id: string; name: string; cents: number; to?: RouteTarget }

const ROW_H = 26
const LABEL_W = 108
const VALUE_W = 92
const GAP = 12

/**
 * What moved a total, as diverging bars around a zero line: a gain grows
 * right in --up, a loss grows left in --down (gains and losses are the only
 * thing those colours mean). Bars share one scale, so the biggest mover spans
 * half the track. Each name links to where the number lives when `to` is set.
 * Hover shows the exact figure; the row itself prints it in whole dollars.
 */
export function DriverBars({ rows, tipTitle, ariaLabel }: { rows: DriverRow[]; tipTitle?: string; ariaLabel: string }) {
  const { ref, width: W } = useChartSize()
  const [hover, setHover] = useState<number | null>(null)
  const grow = useGrow(W > 0, rows.length)
  if (rows.length === 0) return null
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.cents)))
  const trackX = LABEL_W + GAP
  const trackW = Math.max(1, W - LABEL_W - VALUE_W - 2 * GAP)
  // Half the track at most, and never thinner than a hairline for a real change.
  const halfPct = (c: number) => (c === 0 ? 0 : Math.max(0.8, (Math.abs(c) / max) * 48))
  const h = hover !== null ? rows[hover] : undefined
  // Beside the bar, never over it: a gain's tip starts past its end, a loss's past the zero line (the empty half).
  const at = h ? { x: trackX + (trackW * (50 + (h.cents > 0 ? halfPct(h.cents) : 0))) / 100, y: hover! * ROW_H + ROW_H / 2 } : null

  return (
    <div
      className={`chart ch-drivers${grow ? ' ch-grow' : ''}`}
      ref={ref}
      role="list"
      aria-label={ariaLabel}
      onPointerLeave={() => setHover(null)}
    >
      {rows.map((r, i) => {
        const w = halfPct(r.cents)
        const color = signColor(r.cents)
        const name: ReactNode = r.to ? <Link to={r.to} className="ch-a">{r.name}</Link> : r.name
        return (
          <div
            key={r.id}
            role="listitem"
            className={`ch-driver${hover === i ? ' on' : ''}`}
            style={{ height: ROW_H, gridTemplateColumns: `${LABEL_W}px 1fr ${VALUE_W}px`, columnGap: GAP }}
            onPointerEnter={() => setHover(i)}
          >
            <span className="ch-driver-nm">{name}</span>
            <svg width="100%" height={ROW_H} aria-hidden="true">
              <line x1="50%" x2="50%" y1={4} y2={ROW_H - 4} stroke="var(--axis)" />
              {w > 0 && (
                <rect
                  className={`ch-bar-h${r.cents < 0 ? ' neg' : ''}`}
                  style={growStyle(i)}
                  x={`${r.cents > 0 ? 50 : 50 - w}%`}
                  y={ROW_H / 2 - 5}
                  width={`${w}%`}
                  height={10}
                  rx={2.5}
                  fill={color}
                />
              )}
            </svg>
            <span className="ch-driver-vl" style={{ color }}>
              {formatDollars(r.cents, { sign: true })}
            </span>
          </div>
        )
      })}
      <ChartTip at={at} box={{ w: W, h: rows.length * ROW_H }} rise={ROW_H / 2}>
        {h && (
          <>
            {tipTitle && <div className="t">{tipTitle}</div>}
            <TipRow color={signColor(h.cents)} name={h.name} value={formatCents(h.cents, { sign: true })} valueColor={signColor(h.cents)} />
          </>
        )}
      </ChartTip>
    </div>
  )
}
