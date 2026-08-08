import { useMemo, useState } from 'react'
import { formatCents } from '../shared/money'
import { sma } from '../shared/series'
import { fmtShort } from './viz'

type Pt = { d: string; c: number }
export type ChartData = {
  symbol: string
  kind: 'stock' | 'crypto'
  closes: Pt[]
  errors?: string[]
}

const RANGES = { '1Y': 365, '4Y': 1461, ALL: Infinity } as const
type RangeKey = keyof typeof RANGES
const MAS = [
  { key: '50D', days: 50, color: 'var(--s2)' },
  { key: '200D', days: 200, color: 'var(--s3)' },
  { key: '200W', days: 1400, color: 'var(--s4)' },
] as const

const DAY = 86400000

export default function BigChart({ data }: { data: ChartData }) {
  const [scale, setScale] = useState<'log' | 'linear'>('log')
  const [range, setRange] = useState<RangeKey>('ALL')
  const [mas, setMas] = useState<Set<string>>(new Set(['200D', '200W']))
  const [hover, setHover] = useState<number | null>(null) // timestamp

  const full = useMemo(() => {
    const ts = data.closes.map((p) => Date.parse(p.d))
    const vs = data.closes.map((p) => p.c)
    const maSeries = MAS.map((m) => sma(vs, m.days))
    return { ts, vs, maSeries }
  }, [data])

  const W = 1140
  const H = 360
  const padL = 64
  const padR = 14
  const padT = 10
  const padB = 22

  const view = useMemo(() => {
    const n = full.ts.length
    if (n < 2) return null
    const tEnd = full.ts[n - 1]!
    const t0 = range === 'ALL' ? full.ts[0]! : Math.max(full.ts[0]!, tEnd - RANGES[range] * DAY)
    const i0 = Math.max(0, full.ts.findIndex((t) => t >= t0))
    const vis = full.vs.slice(i0)
    let lo = vis.length ? Math.min(...vis) : 1
    let hi = vis.length ? Math.max(...vis) : 2
    for (const [k, m] of MAS.entries())
      if (mas.has(m.key))
        for (let i = i0; i < n; i++) {
          const v = full.maSeries[k]![i]
          if (v != null) {
            lo = Math.min(lo, v)
            hi = Math.max(hi, v)
          }
        }
    if (scale === 'linear') lo = 0
    const x = (t: number) => padL + ((t - t0) / (tEnd - t0)) * (W - padL - padR)
    const yLin = (v: number) => padT + ((hi - v) * (H - padT - padB)) / (hi - lo || 1)
    const lLo = Math.log10(Math.max(1, lo))
    const lHi = Math.log10(Math.max(2, hi))
    const yLog = (v: number) => padT + ((lHi - Math.log10(Math.max(1, v))) * (H - padT - padB)) / (lHi - lLo || 1)
    const y = scale === 'log' ? yLog : yLin
    // ticks: log → 1/2/5×10^k inside domain; linear → quarters
    const ticks: number[] = []
    if (scale === 'log') {
      for (let k = Math.floor(lLo); k <= Math.ceil(lHi); k++)
        for (const m of [1, 2, 5]) {
          const v = m * Math.pow(10, k)
          if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v)
        }
    } else for (let i = 0; i <= 4; i++) ticks.push(lo + ((hi - lo) * i) / 4)
    return { t0, tEnd, i0, x, y, ticks, lo, hi }
  }, [full, range, scale, mas])

  if (!view || full.ts.length < 2) return <p className="sub2">No daily history yet — hit “Refresh prices”.</p>
  const { t0, tEnd, x, y, ticks } = view

  const stride = Math.max(1, Math.floor(full.ts.length / (W * 2)))
  const path = (ts: number[], vs: (number | null)[], yFn: (v: number) => number) => {
    let d = ''
    let pen = false
    for (let i = 0; i < ts.length; i += stride) {
      const t = ts[i]!
      const v = vs[i]
      if (t < t0 || v === null || v === undefined) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)} ${yFn(v).toFixed(1)}`
      pen = true
    }
    return d
  }

  const yearTicks: number[] = []
  for (let yr = new Date(t0).getFullYear() + 1; yr <= new Date(tEnd).getFullYear(); yr++) {
    const t = Date.parse(`${yr}-01-01`)
    if (t >= t0 && yearTicks.length < 14) yearTicks.push(t)
  }

  // hover lookups
  const hoverIdx =
    hover === null
      ? null
      : (() => {
          let lo2 = 0
          let hi2 = full.ts.length - 1
          while (lo2 < hi2) {
            const mid = (lo2 + hi2) >> 1
            if (full.ts[mid]! < hover) lo2 = mid + 1
            else hi2 = mid
          }
          return lo2
        })()
  const hoverDay = hoverIdx !== null ? data.closes[hoverIdx]!.d : null


  const chip = (label: string, on: boolean, toggle: () => void, color?: string) => (
    <button key={label} className={`chipbtn ${on ? 'on' : ''}`} style={{ padding: '3px 10px', fontSize: 12 }} onClick={toggle}>
      {color && <span style={{ display: 'inline-block', width: 8, height: 3, background: color, borderRadius: 2, marginRight: 5, verticalAlign: 'middle' }} />}
      {label}
    </button>
  )

  return (
    <div>
      <div className="importbar" style={{ marginBottom: 8 }}>
        {(Object.keys(RANGES) as RangeKey[]).map((r) => chip(r, range === r, () => setRange(r)))}
        <span style={{ width: 10 }} />
        {chip('Log', scale === 'log', () => setScale('log'))}
        {chip('Linear', scale === 'linear', () => setScale('linear'))}
        <span style={{ width: 10 }} />
        {MAS.map((m) =>
          chip(m.key + ' MA', mas.has(m.key), () => {
            setMas((s) => {
              const n2 = new Set(s)
              if (n2.has(m.key)) n2.delete(m.key)
              else n2.add(m.key)
              return n2
            })
          }, m.color),
        )}
      </div>
      <div className="chart" style={{ overflowX: 'auto' }}>
        <svg
          width={W}
          height={H}
          role="img"
          aria-label={`${data.symbol} price history`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(ev) => {
            const rect = (ev.currentTarget as SVGSVGElement).getBoundingClientRect()
            const px = ev.clientX - rect.left
            if (px < padL || px > W - padR) return setHover(null)
            setHover(t0 + ((px - padL) / (W - padL - padR)) * (tEnd - t0))
          }}
        >
          {ticks.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
              <text x={padL - 8} y={y(v) + 4} textAnchor="end" fill="var(--ink-3)" fontSize={10.5} fontFamily="var(--mono)">
                {fmtShort(v)}
              </text>
            </g>
          ))}
          {yearTicks.map((t) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor="middle" fill="var(--ink-3)" fontSize={10.5}>
              {new Date(t).getFullYear()}
            </text>
          ))}
          {MAS.map((m, k) =>
            mas.has(m.key) ? (
              <path key={m.key} d={path(full.ts, full.maSeries[k]!, y)} fill="none" stroke={m.color} strokeWidth={1.6} />
            ) : null,
          )}
          <path d={path(full.ts, full.vs, y)} fill="none" stroke="var(--s1)" strokeWidth={1.8} />
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={H - padB} stroke="var(--axis)" />}

        </svg>
        {hoverIdx !== null && hoverDay && (
          <div className="tip on" style={{ left: Math.min(x(hover!) + 14, W - 210), top: 14 }}>
            <div className="t">{hoverDay}</div>
            <div className="r"><span className="sw" style={{ background: 'var(--s1)' }} /><span className="nm">{data.symbol}</span><span className="vl">{formatCents(full.vs[hoverIdx]!)}</span></div>
            {MAS.map((m, k) =>
              mas.has(m.key) && full.maSeries[k]![hoverIdx] !== null ? (
                <div className="r" key={m.key}><span className="sw" style={{ background: m.color }} /><span className="nm">{m.key} MA</span><span className="vl">{formatCents(full.maSeries[k]![hoverIdx]!)}</span></div>
              ) : null,
            )}
          </div>
        )}
      </div>
    </div>
  )
}
