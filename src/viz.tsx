import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { formatCents } from '../shared/money'

/** Axis-length money: $78K / $1.2M / $85. */
export function fmtShort(cents: number): string {
  const d = Math.abs(cents) / 100
  const sign = cents < 0 ? '-' : ''
  if (d >= 1e6) return `${sign}$${(d / 1e6).toFixed(d < 1e7 ? 1 : 0)}M`
  if (d >= 1e3) return `${sign}$${Math.round(d / 1e3)}K`
  return `${sign}$${Math.round(d)}`
}

/** "2026-08" → "Aug '26" (short: "Aug"). */
export function fmtMonth(month: string, withYear = false): string {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = names[Number(month.slice(5, 7)) - 1] ?? month
  return withYear ? `${m} '${month.slice(2, 4)}` : m
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="tip on" style={{ left: x, top: y }}>
      {children}
    </div>
  )
}

const ink3 = 'var(--ink-3)'
const grid = 'var(--grid)'

/* ---------------- grouped bars: income vs spending by month ---------------- */

export function GroupedBars({
  data,
  names,
  colors,
}: {
  data: { label: string; a: number; b: number }[]
  names: [string, string]
  colors: [string, string]
}) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const H = 220
  const padL = 56
  const padR = 10
  const padT = 12
  const padB = 24
  const hi = Math.max(1, ...data.flatMap((d) => [d.a, d.b])) * 1.08
  const n = Math.max(1, data.length)
  const gw = (W - padL - padR) / n
  const bw = Math.min(14, Math.max(4, (gw - 10) / 2))
  const y = (v: number) => padT + ((hi - v) * (H - padT - padB)) / hi

  return (
    <div className="chart" ref={ref}>
      {W > 0 && (
        <svg width={W} height={H} role="img" aria-label={`${names[0]} vs ${names[1]} by month`}>
          {[0, 1, 2, 3].map((i) => {
            const v = (hi * i) / 3
            return (
              <g key={i}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={grid} />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill={ink3} fontSize={10.5} fontFamily="var(--mono)">
                  {fmtShort(v)}
                </text>
              </g>
            )
          })}
          {data.map((d, i) => {
            const cx = padL + gw * i + gw / 2
            return (
              <g key={d.label}>
                <rect x={cx - bw - 1} y={y(d.a)} width={bw} height={H - padB - y(d.a)} rx={3} fill={colors[0]} />
                <rect x={cx + 1} y={y(d.b)} width={bw} height={H - padB - y(d.b)} rx={3} fill={colors[1]} />
                <text x={cx} y={H - 7} textAnchor="middle" fill={ink3} fontSize={10.5}>
                  {d.label}
                </text>
                <rect
                  x={padL + gw * i}
                  y={padT}
                  width={gw}
                  height={H - padT - padB}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
      )}
      {hover !== null && data[hover] && (
        <Tip x={Math.min(padL + gw * hover + gw + 8, W - 180)} y={18}>
          <div className="t">{data[hover].label}</div>
          <div className="r">
            <span className="sw" style={{ background: colors[0] }} />
            <span className="nm">{names[0]}</span>
            <span className="vl">{formatCents(data[hover].a)}</span>
          </div>
          <div className="r">
            <span className="sw" style={{ background: colors[1] }} />
            <span className="nm">{names[1]}</span>
            <span className="vl">{formatCents(data[hover].b)}</span>
          </div>
          <div className="r">
            <span className="sw" style={{ background: 'transparent' }} />
            <span className="nm">Net</span>
            <span className="vl" style={{ color: data[hover].a - data[hover].b >= 0 ? 'var(--up)' : 'var(--down)' }}>
              {formatCents(data[hover].a - data[hover].b, { sign: true })}
            </span>
          </div>
        </Tip>
      )}
    </div>
  )
}

/* ---------------- horizontal bars: category breakdown ---------------- */

export function HBars({ data, color }: { data: { name: string; cents: number }[]; color: string }) {
  const [ref, W] = useWidth()
  const rowH = 27
  const hi = Math.max(1, ...data.map((d) => d.cents))
  const lw = 110
  const vw = 64
  return (
    <div className="chart" ref={ref}>
      {W > 0 && (
        <svg width={W} height={data.length * rowH + 4} role="img" aria-label="spending by category">
          {data.map((d, i) => {
            const yy = i * rowH + rowH / 2
            const bw = Math.max(3, (W - lw - vw - 10) * (d.cents / hi))
            return (
              <g key={d.name}>
                <text x={0} y={yy + 4} fill="var(--ink-2)" fontSize={12}>
                  {d.name.length > 15 ? d.name.slice(0, 14) + '…' : d.name}
                </text>
                <rect x={lw} y={yy - 6} width={bw} height={12} rx={3} fill={color} />
                <text x={lw + bw + 8} y={yy + 4} fill="var(--ink-2)" fontSize={11.5} fontFamily="var(--mono)">
                  {fmtShort(d.cents)}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/* ---------------- bullets: plan vs actual ---------------- */

export function Bullets({ data }: { data: { name: string; actual: number; budget: number }[] }) {
  const [ref, W] = useWidth()
  const rowH = 34
  const hi = Math.max(1, ...data.map((d) => Math.max(d.budget, d.actual))) * 1.1
  const lw = 104
  const vw = 128
  return (
    <div className="chart" ref={ref}>
      {W > 0 && (
        <svg width={W} height={data.length * rowH} role="img" aria-label="budget plan vs actual">
          {data.map((d, i) => {
            const yy = i * rowH + rowH / 2
            const track = W - lw - vw
            const over = d.budget > 0 && d.actual > d.budget
            return (
              <g key={d.name}>
                <text x={0} y={yy + 4} fill="var(--ink-2)" fontSize={12}>
                  {d.name.length > 13 ? d.name.slice(0, 12) + '…' : d.name}
                </text>
                <rect x={lw} y={yy - 7} width={track} height={14} rx={4} fill="rgba(255,255,255,.05)" />
                <rect
                  x={lw}
                  y={yy - 7}
                  width={Math.max(3, track * (d.actual / hi))}
                  height={14}
                  rx={4}
                  fill={over ? 'var(--down)' : 'var(--s1)'}
                />
                {d.budget > 0 && (
                  <line
                    x1={lw + track * (d.budget / hi)}
                    x2={lw + track * (d.budget / hi)}
                    y1={yy - 10}
                    y2={yy + 10}
                    stroke="var(--ink-2)"
                    strokeWidth={2}
                  />
                )}
                <text
                  x={W}
                  y={yy + 4}
                  textAnchor="end"
                  fill={over ? 'var(--down)' : 'var(--ink-2)'}
                  fontSize={11.5}
                  fontFamily="var(--mono)"
                >
                  {fmtShort(d.actual)} / {d.budget > 0 ? fmtShort(d.budget) : '—'}
                </text>
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

/* ---------------- line chart with crosshair tooltip ---------------- */

export function LineChart({
  labels,
  series,
  bands = [],
  h = 230,
  maxXTicks = 6,
  tipLabel,
}: {
  labels: string[]
  series: { name: string; color: string; values: number[]; area?: boolean; dash?: string }[]
  bands?: { lo: number[]; hi: number[]; fill: string }[]
  h?: number
  maxXTicks?: number
  tipLabel?: (i: number) => string
}) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const H = h
  const padL = 60
  const padR = 14
  const padT = 12
  const padB = 24
  const n = Math.max(2, labels.length)
  const all = series.flatMap((s) => s.values).concat(bands.flatMap((b) => [...b.lo, ...b.hi]))
  let lo = Math.min(...all, 0)
  let hi = Math.max(...all, 1)
  const span = hi - lo || 1
  hi += span * 0.06
  const x = (i: number) => padL + (i * (W - padL - padR)) / (n - 1)
  const y = (v: number) => padT + ((hi - v) * (H - padT - padB)) / (hi - lo)
  const path = (vals: number[]) => vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join('')
  const step = Math.ceil(labels.length / maxXTicks)

  return (
    <div className="chart" ref={ref}>
      {W > 0 && labels.length >= 2 && (
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={series.map((s) => s.name).join(' vs ')}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(ev) => {
            const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
            const px = ev.clientX - rect.left
            const i = Math.round(((px - padL) * (n - 1)) / (W - padL - padR))
            setHover(i >= 0 && i < labels.length ? i : null)
          }}
        >
          {[0, 1, 2, 3].map((k) => {
            const v = lo + ((hi - lo) * k) / 3
            return (
              <g key={k}>
                <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={grid} />
                <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill={ink3} fontSize={10.5} fontFamily="var(--mono)">
                  {fmtShort(v)}
                </text>
              </g>
            )
          })}
          {labels.map((lb, i) =>
            i % step === 0 ? (
              <text key={i} x={x(i)} y={H - 7} textAnchor="middle" fill={ink3} fontSize={10.5}>
                {lb}
              </text>
            ) : null,
          )}
          {bands.map((b, bi) => {
            const up = b.hi.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join('')
            const down = [...b.lo].reverse().map((v, i) => `L${x(b.lo.length - 1 - i)} ${y(v)}`).join('')
            return <path key={bi} d={`${up}${down}Z`} fill={b.fill} stroke="none" />
          })}
          {series.map((s) => (
            <g key={s.name}>
              {s.area && (
                <path
                  d={`${path(s.values)}L${x(s.values.length - 1)} ${H - padB}L${x(0)} ${H - padB}Z`}
                  fill={s.color}
                  opacity={0.1}
                />
              )}
              <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" />
              <circle
                cx={x(s.values.length - 1)}
                cy={y(s.values[s.values.length - 1]!)}
                r={3.5}
                fill={s.color}
                stroke="var(--card)"
                strokeWidth={2}
              />
            </g>
          ))}
          {hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--axis)" />
              {series.map((s) => (
                <circle key={s.name} cx={x(hover)} cy={y(s.values[hover]!)} r={4.5} fill={s.color} stroke="#0c1017" strokeWidth={2} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover !== null && (
        <Tip x={Math.min(x(hover) + 14, W - 190)} y={Math.max(4, y(series[0]!.values[hover]!) - 44)}>
          <div className="t">{tipLabel ? tipLabel(hover) : labels[hover]}</div>
          {series.map((s) => (
            <div className="r" key={s.name}>
              <span className="sw" style={{ background: s.color }} />
              <span className="nm">{s.name}</span>
              <span className="vl">{formatCents(s.values[hover]!)}</span>
            </div>
          ))}
        </Tip>
      )}
    </div>
  )
}

/* ---------------- donut with legend ---------------- */

export function Donut({ data }: { data: { name: string; cents: number; color: string }[] }) {
  const [ref, W] = useWidth()
  const [hover, setHover] = useState<number | null>(null)
  const H = 200
  const shown = data.filter((d) => d.cents > 0)
  const tot = shown.reduce((s, d) => s + d.cents, 0)
  const cx = Math.min(W * 0.3, 110)
  const cy = H / 2
  const R = 74
  const r = 51
  let a0 = -Math.PI / 2

  return (
    <div className="chart donutwrap" ref={ref}>
      {W > 0 && tot > 0 && (
        <>
          <svg width={W} height={H} role="img" aria-label="allocation">
            {shown.map((d, i) => {
              const a1 = a0 + (d.cents / tot) * Math.PI * 2
              const large = a1 - a0 > Math.PI ? 1 : 0
              const p = (a: number, rr: number) => [cx + rr * Math.cos(a), cy + rr * Math.sin(a)]
              const [x0, y0] = p(a0, R)
              const [x1, y1] = p(a1, R)
              const [x2, y2] = p(a1, r)
              const [x3, y3] = p(a0, r)
              const dpath = `M${x0} ${y0}A${R} ${R} 0 ${large} 1 ${x1} ${y1}L${x2} ${y2}A${r} ${r} 0 ${large} 0 ${x3} ${y3}Z`
              a0 = a1
              return (
                <path
                  key={d.name}
                  d={dpath}
                  fill={d.color}
                  stroke="var(--card)"
                  strokeWidth={2}
                  opacity={hover === null || hover === i ? 1 : 0.45}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              )
            })}
            <text x={cx} y={cy - 2} textAnchor="middle" fill="var(--ink)" fontSize={16} fontWeight={650}>
              {fmtShort(hover !== null && shown[hover] ? shown[hover].cents : tot)}
            </text>
            <text x={cx} y={cy + 15} textAnchor="middle" fill={ink3} fontSize={10.5}>
              {hover !== null && shown[hover] ? shown[hover].name : 'total'}
            </text>
          </svg>
          <div className="donutlegend">
            {shown.map((d, i) => (
              <div
                key={d.name}
                className="r"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                style={{ opacity: hover === null || hover === i ? 1 : 0.5 }}
              >
                <span className="sw" style={{ background: d.color }} />
                <span className="nm">{d.name}</span>
                <span className="vl">{Math.round((d.cents / tot) * 100)}%</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
