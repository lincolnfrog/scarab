import { useChartSize } from './useChartSize'
import './chart.css'

/**
 * The mockup's tile sparkline: a line fitted to its own range, a 12% wash
 * down to the bottom edge, and a dot on the latest value. No axes and no
 * tooltip — it sits inside a tile that links to the full chart, and the tile
 * prints the figures it summarises. Nothing renders under two points.
 */
export function Sparkline({ values, color, height = 34, label }: { values: number[]; color: string; height?: number; label: string }) {
  const { ref, width: W } = useChartSize()
  const vs = values.filter((v) => Number.isFinite(v))
  const n = vs.length
  if (n < 2) return null
  const H = height
  const lo = Math.min(...vs)
  const hi = Math.max(...vs)
  const span = hi - lo || 1
  // A flat line sits mid-height rather than on the floor.
  const x = (i: number) => 2 + (i * (W - 6)) / (n - 1)
  const y = (v: number) => (hi === lo ? H / 2 : 3 + ((hi - v) * (H - 8)) / span)
  const line = vs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join('')
  return (
    <div className="chart ch-spark" ref={ref} style={{ height: H }}>
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={label}>
          <path d={`${line}L${x(n - 1).toFixed(1)} ${H - 1}L${x(0).toFixed(1)} ${H - 1}Z`} fill={color} opacity={0.12} />
          <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(n - 1)} cy={y(vs[n - 1]!)} r={2.6} fill={color} />
        </svg>
      )}
    </div>
  )
}
