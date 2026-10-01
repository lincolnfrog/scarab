import { fmtPctMicro } from '../chart/format'
import { signColor } from '../chart/palette'

const W = 92
const H = 26
const PAD = 3

/**
 * A holding's last 90 days as one small line (GET /api/portfolio/sparks),
 * placed by date so sparse closes don't bunch up, on its own scale. Up or
 * down over the window is the line's colour — a gain or a loss, the only
 * thing those colours mean. Fewer than two closes draws nothing.
 */
export default function Sparkline({ symbol, closes, from, to }: { symbol: string; closes: readonly { d: string; c: number }[] | undefined; from: string; to: string }) {
  if (!closes || closes.length < 2) return <span className="muted">—</span>
  const t0 = Date.parse(from)
  const span = Math.max(1, Date.parse(to) - t0)
  let lo = Infinity
  let hi = -Infinity
  for (const p of closes) {
    if (p.c < lo) lo = p.c
    if (p.c > hi) hi = p.c
  }
  const x = (d: string) => PAD + ((Date.parse(d) - t0) / span) * (W - 2 * PAD)
  const y = (c: number) => (hi === lo ? H / 2 : H - PAD - ((c - lo) / (hi - lo)) * (H - 2 * PAD))
  const first = closes[0]!
  const last = closes[closes.length - 1]!
  const change = last.c - first.c
  const micro = Math.round((change * 1_000_000) / first.c)
  const color = signColor(change)
  return (
    <svg
      className="inv-spark"
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`${symbol} over the last 90 days: ${change === 0 ? 'flat' : `${change > 0 ? 'up' : 'down'} ${fmtPctMicro(Math.abs(micro))}`}`}
    >
      <polyline points={closes.map((p) => `${x(p.d).toFixed(1)},${y(p.c).toFixed(1)}`).join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(last.d)} cy={y(last.c)} r={2} fill={color} />
    </svg>
  )
}
