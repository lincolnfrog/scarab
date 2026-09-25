import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import { todayLocal } from '../../shared/dates'
import { alignAsOf, anchorIndex, asOfIndex, pctChange, rebase } from '../../shared/series'
import { Button } from '../ui/Button'
import { DUR, prefersReducedMotion } from '../ui/motion'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { ChartTip, TipRow, type TipPoint } from './ChartTip'
import { fmtAxis, type AxisUnit } from './format'
import { Legend, type LegendItem } from './Legend'
import { GOAL_VAR, MARK_VAR, slotAt, slotColor, slotTint, type Slot } from './palette'
import { decimateM4, fmtDay, isoOf, logTicks, monthTicks, nearestIndex, niceTicks, parseT, timeTicks } from './scale'
import { divergingStack, stackBandPath, stackOnUnion, stackTipOrder } from './stackModel'
import {
  allMonthly,
  asOfText,
  availablePresets,
  capRugNotes,
  carryForward,
  DEFAULT_PRESETS,
  domainOf,
  fmtValue,
  isPreset,
  linePaths,
  placeMarkerLabels,
  placeThresholdLabel,
  presetWindow,
  rugPathData,
  wantsDollars,
  zoomWindow,
  type Carried,
  type LabelBox,
  type LinePaths,
  type TPreset,
  type Win,
} from './timeModel'
import { useChartSize } from './useChartSize'
import './chart.css'

/* ---------------- props (plan §C3) ---------------- */

/** One reading. `t`: 'YYYY-MM-DD' (that day), 'YYYY-MM' (month end; the current month = today) or 'YYYY' (Jan 1). */
export type TPoint = { t: string; v: number | null; est?: boolean }
export type TSeries = {
  id: string
  label: string
  points: TPoint[]
  /** Palette slot; defaults to the series' position (s1…s6, then a context line). */
  slot?: Slot
  /** Overrides the slot. Only the goal fund may pass 'var(--gold)' (GOAL_VAR). */
  color?: string
  mark?: 'line' | 'area' | 'step'
  dash?: boolean
  /** Starts hidden (legend toggle off). */
  hidden?: boolean
  /**
   * Hold the last reading flat through this date ('YYYY-MM-DD'; normally
   * today) when it is older — for facts that stand until the next one, like a
   * valuation or a loan balance. The line reaches the date, and the tooltip
   * reads the held value "as of" the day it was recorded.
   */
  carryTo?: string
  /**
   * Stacked with the chart's other `stack` series (value mode only) — a
   * composition: at each date the positive readings pile up from 0 in series
   * order and the negative ones hang below it. The tooltip reads each
   * layer's own value, top to bottom as drawn. `mark` is ignored.
   */
  stack?: boolean
}
/** A shaded range. `slot: null` is a context band in ink-3 (a seventh scenario's fan). */
export type TBand = { id: string; label: string; lo: TPoint[]; hi: TPoint[]; slot: Slot | null; /** 0–1 */ opacity: number }
export type TMarker = { id: string; t: string; label: string; tone?: 'gold' | 'neutral' }
export type TThreshold = { id: string; v: number; label: string; tone?: 'gold' | 'neutral' }
export type TPointMark = { id: string; t: string; v: number; shape: 'up' | 'down' | 'dot'; label: string }
/** A rug tick: a neutral ▲/▼ on the plot's floor at a date (a trade). Time-only, so it stays in every transform; listed in the tooltip. */
export type TRug = { id: string; t: string; shape: 'up' | 'down'; label: string }
export type { TPreset }

export type TimeChartProps = {
  ariaLabel: string
  title?: ReactNode
  /** Rendered at the left of the header row, in place of (or after) the title — a hero figure that shares the row with the range picker. */
  lead?: ReactNode
  actions?: ReactNode
  /** Plot height in px (default 230). */
  height?: number
  series: TSeries[]
  bands?: TBand[]
  markers?: TMarker[]
  thresholds?: TThreshold[]
  pointMarks?: TPointMark[]
  /** Ticks along the plot's floor — a trade rug. */
  rug?: TRug[]
  /** Units of the raw values: cents, a micro-fraction (1_000_000 = 100%), or index-micro (1_000_000 = 100). */
  unit?: 'cents' | 'pct' | 'index'
  /** The initial y scale (default linear). With the toggle shown, the person can switch it. */
  scale?: 'linear' | 'log'
  /** Show a Linear/Log switch in the header. Default: on for money values, off otherwise. */
  scaleToggle?: boolean
  /** 'fit' hugs the data (default); 'zero' keeps 0 on the axis. A stack always starts at 0. */
  baseline?: 'zero' | 'fit'
  /** 'rebased' reads 100 at each line's anchor, 'pct' reads % change from it. Thresholds, bands and point marks are raw-unit and drop out. */
  transform?: 'value' | 'rebased' | 'pct'
  /** A fixed anchor date for rebased/pct. Without one, each line anchors at its first value above zero in view. */
  anchorT?: string
  presets?: TPreset[] | false
  defaultPreset?: string
  /** Called when the person picks a range, zooms or resets — not on mount. ISO days. */
  onRangeChange?: (r: { from: string; to: string }) => void
  /**
   * The window actually drawn, whenever it changes for any reason — first
   * draw, new data, a preset, a zoom (or a zoom the new data no longer
   * allows). Epoch ms (UTC), for callers that summarize what is on screen.
   */
  onWindow?: (w: { t0: number; t1: number }) => void
  legend?: 'auto' | 'none'
  /** Where the legend sits: in the header row (default) or under the plot — for a long legend that would crowd the header. */
  legendAt?: 'head' | 'foot'
  onToggleSeries?: (id: string, hidden: boolean) => void
  /** Extra tooltip rows. `t` is the snapped point's own date string; `values` are every series' raw readings as of it, by id. */
  tooltipExtra?: (t: string, values: Record<string, number | null>) => ReactNode
  tipLabel?: (t: string) => string
  /** Data is reloading: the last drawn data stays, at 50% opacity. */
  pending?: boolean
}

/* ---------------- parsing (cached per points array) ---------------- */

type Parsed = Carried
const parseCache = new WeakMap<readonly TPoint[], { today: string; p: Parsed }>()

function parsePoints(points: readonly TPoint[], today: string): Parsed {
  const hit = parseCache.get(points)
  if (hit && hit.today === today) return hit.p
  let rows = points.map((pt) => ({ t: parseT(pt.t, today), pt })).filter((r) => Number.isFinite(r.t))
  if (rows.some((r, i) => i > 0 && r.t < rows[i - 1]!.t)) rows = [...rows].sort((a, b) => a.t - b.t)
  const p: Parsed = {
    ts: rows.map((r) => r.t),
    vs: rows.map((r) => (typeof r.pt.v === 'number' && Number.isFinite(r.pt.v) ? r.pt.v : null)),
    est: rows.map((r) => !!r.pt.est),
    src: rows.map((r) => r.pt.t),
  }
  parseCache.set(points, { today, p })
  return p
}

const NONE: never[] = []
const PAD_R = 14
const PAD_T = 12
const PAD_B = 26
const AXIS_FONT = 10.5
const HOVER_STROKE = '#0c1017'

/** A stacked layer's edges on the stack's timeline. */
type Band = { lo: number[]; hi: number[] }
type Pre = { s: TSeries; i: number; P: Parsed; disp: (number | null)[]; band?: Band }
/**
 * One drawn series. `disp` is what the tooltip reads (the transformed value;
 * a stacked layer's own value), `pos` where its dot sits (a stacked layer's
 * outer edge: the top of a positive layer, the bottom of a negative one).
 */
type Shown = {
  s: TSeries
  i: number
  color: string
  P: Parsed
  disp: (number | null)[]
  pos: (number | null)[]
  paths: LinePaths
  stackPath: string
  stacked: boolean
  dots: number[]
  last: number
}
type Refused = { id: string; label: string; reason: string }
type Held = Pick<TimeChartProps, 'series' | 'bands' | 'markers' | 'thresholds' | 'pointMarks' | 'rug'>

const lower = (ts: readonly number[], t: number) => asOfIndex(ts, t - 1) + 1
const toneColor = (tone: 'gold' | 'neutral' | undefined) => (tone === 'gold' ? GOAL_VAR : 'var(--ink-3)')
const toneText = (tone: 'gold' | 'neutral' | undefined) => (tone === 'gold' ? GOAL_VAR : 'var(--ink-2)')
const glyphOf = (shape: TPointMark['shape']) => (shape === 'up' ? '▲' : shape === 'down' ? '▼' : '●')

/** A point mark: ▲ with its tip just under the value, ▼ just over it, or a dot on it. */
function glyphPath(x: number, y: number, shape: 'up' | 'down'): string {
  const s = 4.5
  return shape === 'up' ? `M${x} ${y + 3}l${s} ${s * 1.6}h${-2 * s}Z` : `M${x} ${y - 3}l${s} ${-s * 1.6}h${-2 * s}Z`
}

function tipTitle(src: string, t: number): string {
  if (/^\d{4}-\d{2}$/.test(src)) return fmtDay(t, { month: true })
  if (/^\d{4}$/.test(src)) return src
  return fmtDay(t)
}

/**
 * The one time-series chart (plan §C3): a real UTC time axis; a crosshair
 * that snaps across every series and reads each "as of" the snapped date;
 * estimated stretches dashed; an automatic legend with toggles from two
 * series; range presets and drag-to-zoom (double-click or Esc resets);
 * ←/→/Home/End stepping; a clip-path reveal on first draw; `pending` holds
 * the previous render at half opacity; `stack` series draw a diverging
 * composition (positives up from 0, negatives down). One y-axis, always.
 */
export function TimeChart(p: TimeChartProps) {
  const H = p.height ?? 230
  const { ref, width: W } = useChartSize()
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const today = todayLocal()
  const tf = p.transform ?? 'value'

  // `pending`: keep drawing what was last drawn.
  const held = useRef<Held | null>(null)
  const live: Held = { series: p.series, bands: p.bands, markers: p.markers, thresholds: p.thresholds, pointMarks: p.pointMarks, rug: p.rug }
  if (!p.pending) held.current = live
  const d = p.pending && held.current ? held.current : live
  const series = d.series

  // Legend toggles: local overrides on top of each series' `hidden` prop; a prop change wins.
  const [overrides, setOverrides] = useState<Record<string, { hidden: boolean; prop: boolean }>>({})
  const hidden = series.map((s) => {
    const o = overrides[s.id]
    return o && o.prop === !!s.hidden ? o.hidden : !!s.hidden
  })
  const hiddenKey = hidden.map((h) => (h ? 1 : 0)).join('')

  const [presetPick, setPresetPick] = useState<TPreset>(() => (isPreset(p.defaultPreset) ? p.defaultPreset : 'ALL'))
  const [zoom, setZoom] = useState<Win | null>(null)
  const [cursor, setCursor] = useState<number | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  const [liveText, setLiveText] = useState('')
  const drag = useRef<{ x0: number; id: number; brushing: boolean } | null>(null)

  const presetList: TPreset[] = p.presets === false ? NONE : (p.presets ?? DEFAULT_PRESETS)
  const unit: AxisUnit = tf === 'rebased' ? 'index' : tf === 'pct' ? 'pct' : (p.unit ?? 'cents')
  const baseline = p.baseline ?? 'fit'
  const showScaleToggle = p.scaleToggle ?? (tf === 'value' && unit === 'cents')
  const [scalePick, setScalePick] = useState<'linear' | 'log'>(p.scale ?? 'linear')
  const scale = showScaleToggle ? scalePick : (p.scale ?? 'linear')

  const m = useMemo(() => {
    const parsed = series.map((s): Parsed => {
      const P = parsePoints(s.points, today)
      const tc = s.carryTo ? parseT(s.carryTo, today) : NaN
      return Number.isFinite(tc) ? carryForward(P, tc, s.carryTo!) : P
    })
    const bandsP = tf === 'value' ? (d.bands ?? NONE).map((b) => ({ b, lo: parsePoints(b.lo, today), hi: parsePoints(b.hi, today) })) : []

    // The data span — every series, hidden or not, so a toggle never moves the window.
    let tMin = Infinity
    let tMax = -Infinity
    const span = (ts: number[]) => {
      if (ts.length === 0) return
      tMin = Math.min(tMin, ts[0]!)
      tMax = Math.max(tMax, ts[ts.length - 1]!)
    }
    parsed.forEach((P) => span(P.ts))
    bandsP.forEach((x) => (span(x.lo.ts), span(x.hi.ts)))
    const hasData = tMin <= tMax

    const offered = hasData ? availablePresets(presetList, tMin, tMax) : []
    const preset: TPreset = offered.includes(presetPick) ? presetPick : 'ALL'
    const base: Win = hasData ? presetWindow(preset, tMin, tMax) : { t0: 0, t1: 0 }
    // Zoom is validated against the dates of every visible line (before any rebase refusal).
    const zoomTs = alignAsOf(parsed.filter((_, i) => !hidden[i]).map((P) => P.ts)).ts
    const zoomed = zoom ? zoomWindow(zoom.t0, zoom.t1, base, zoomTs) : null
    const win = zoomed ?? base
    const inWin = (t: number) => t >= win.t0 && t <= win.t1

    // Transforms, per visible series.
    const anchorAt = p.anchorT ? parseT(p.anchorT, today) : undefined
    const fixedAnchor = anchorAt !== undefined && Number.isFinite(anchorAt)
    const pre: Pre[] = []
    const refused: Refused[] = []
    series.forEach((s, i) => {
      if (hidden[i]) return
      const P = parsed[i]!
      if (tf === 'value') return void pre.push({ s, i, P, disp: P.vs })
      const ai = anchorIndex(P.ts, P.vs, fixedAnchor ? { at: anchorAt } : { from: win.t0, to: win.t1 })
      const out = (tf === 'rebased' ? rebase : pctChange)(P.vs, ai, { dropBefore: !fixedAnchor })
      if (out) return void pre.push({ s, i, P, disp: out })
      const why =
        ai < 0
          ? fixedAnchor
            ? `it has no value on ${fmtDay(anchorAt!)}`
            : 'it has no value above zero in this range'
          : `it is at or below zero on ${fmtDay(P.ts[ai]!)}`
      refused.push({ id: s.id, label: s.label, reason: `Can't ${tf === 'rebased' ? 'rebase' : 'show % change for'} ${s.label}: ${why}.` })
    })

    // A composition (value mode): the visible `stack` series pile up on the union of their dates,
    // positives up from 0 and negatives down from it. Each layer then reads its own as-of value there.
    const stacking = tf === 'value' && pre.some((x) => x.s.stack)
    if (stacking) {
      const layers = pre.filter((x) => x.s.stack)
      const U = stackOnUnion(layers.map((x) => ({ ts: x.P.ts, vs: x.P.vs })))
      const st = divergingStack(U.values)
      const srcOf = new Map<number, string>()
      for (const x of layers) x.P.ts.forEach((t, k) => srcOf.has(t) || srcOf.set(t, x.P.src[k]!))
      const src = U.ts.map((t) => srcOf.get(t) ?? isoOf(t))
      const est = U.ts.map(() => false)
      layers.forEach((x, k) => {
        x.P = { ts: U.ts, vs: U.values[k]!, est, src }
        x.disp = U.values[k]!
        x.band = { lo: st.lo[k]!, hi: st.hi[k]! }
      })
    }

    // The y domain: what is visible in the window (plus thresholds and bands, in value mode).
    const ys: number[] = []
    const raws: number[] = []
    for (const x of pre)
      for (let k = 0; k < x.P.ts.length; k++) {
        if (!inWin(x.P.ts[k]!)) continue
        if (x.band) ys.push(x.band.lo[k]!, x.band.hi[k]!)
        else {
          const v = x.disp[k]
          if (v !== null && v !== undefined) ys.push(v)
        }
        const r = x.P.vs[k]
        if (r !== null && r !== undefined) raws.push(r)
      }
    if (tf === 'value') {
      for (const { lo, hi } of bandsP)
        for (const P of [lo, hi]) P.ts.forEach((t, k) => inWin(t) && P.vs[k] !== null && ys.push(P.vs[k]!))
      for (const th of d.thresholds ?? NONE) if (Number.isFinite(th.v)) ys.push(th.v)
    }
    let lo = ys.length ? Math.min(...ys) : 0
    let hi = ys.length ? Math.max(...ys) : 1
    const plotH = Math.max(40, H - PAD_T - PAD_B)
    const logOk = lo > 0 && !stacking // a stack's heights only add up on a linear axis; log can't show 0 or less
    const log = scale === 'log' && logOk
    let yOf: (v: number) => number
    let ticks: number[]
    if (log) {
      const pad = (Math.log10(hi) - Math.log10(lo)) * 0.04 || 0.02
      const lLo = Math.log10(lo) - pad
      const lHi = Math.log10(hi) + pad
      yOf = (v) => PAD_T + ((lHi - Math.log10(Math.max(v, 1e-12))) * plotH) / (lHi - lLo)
      ticks = logTicks(lo, hi, Math.max(3, Math.floor(plotH / 32)))
    } else {
      if (baseline === 'zero' || stacking) {
        lo = Math.min(lo, 0)
        hi = Math.max(hi, 0)
      }
      const nt = niceTicks(lo, hi, plotH > 220 ? 5 : 4)
      lo = nt.lo
      hi = nt.hi
      yOf = (v) => PAD_T + ((nt.hi - v) * plotH) / (nt.hi - nt.lo || 1)
      ticks = nt.ticks
    }
    const tickLabels = ticks.map((v) => fmtAxis(v, unit))
    const padL = Math.max(44, Math.ceil(Math.max(0, ...tickLabels.map((l) => l.length)) * 6.4) + 14)
    const plotW = Math.max(1, W - padL - PAD_R)
    const dom = domainOf(win)
    const xOf = (t: number) => padL + ((t - dom.t0) / (dom.t1 - dom.t0)) * plotW
    const monthly = allMonthly([...pre.flatMap((x) => x.P.src), ...bandsP.flatMap((x) => x.lo.src)])
    const xTicks = W > 0 && hasData ? (monthly ? monthTicks(dom.t0, dom.t1, plotW, 56, today) : timeTicks(dom.t0, dom.t1, plotW)) : []
    const yBase = log ? PAD_T + plotH : yOf(Math.min(hi, Math.max(lo, 0)))
    // The reference line: $0 when the data crosses it, 100 when rebased, 0% for % change.
    const refLine = tf === 'rebased' ? 1_000_000 : tf === 'pct' ? 0 : !log && lo < 0 && hi > 0 ? 0 : null

    const shown: Shown[] = pre.map(({ s, i, P, disp, band }) => {
      const visible: number[] = []
      for (let k = 0; k < P.ts.length; k++) if (inWin(P.ts[k]!) && disp[k] !== null) visible.push(k)
      const color = s.color ?? slotColor(s.slot ?? slotAt(i))
      const last = visible[visible.length - 1] ?? -1
      if (band) {
        // Every date in view plus one beyond each edge (clipped), never decimated: the layers must share their edges.
        const k0 = Math.max(0, lower(P.ts, win.t0) - 1)
        const k1 = Math.min(P.ts.length - 1, asOfIndex(P.ts, win.t1) + 1)
        const idx: number[] = []
        for (let k = k0; k <= k1; k++) idx.push(k)
        const pos = disp.map((v, k) => (v === null ? null : v < 0 ? band.lo[k]! : band.hi[k]!))
        const stackPath = W > 0 ? stackBandPath(idx, P.ts, band.lo, band.hi, xOf, yOf) : ''
        return { s, i, color, P, disp, pos, paths: { solid: '', est: '', area: '' }, stackPath, stacked: true, dots: [], last }
      }
      const idx = W > 0 ? decimateM4(P.ts, disp, win.t0, win.t1, plotW) : []
      const paths = linePaths(idx, P.ts, disp, P.est, xOf, yOf, { step: s.mark === 'step', yBase: s.mark === 'area' ? yBase : undefined })
      return { s, i, color, P, disp, pos: disp, paths, stackPath: '', stacked: false, dots: visible.length <= 12 ? visible : [], last }
    })

    // The crosshair's timeline: the union of the drawn lines' dates, and the part of it in view.
    const union = alignAsOf(shown.map((x) => x.P.ts))
    const ua = lower(union.ts, win.t0)
    const ub = asOfIndex(union.ts, win.t1)
    const snapOf = (t: number) => {
      if (ub < ua) return -1
      return Math.min(ub, Math.max(ua, nearestIndex(union.ts, t)))
    }

    const bands = bandsP.map(({ b, lo: L, hi: U }) => {
      const up = U.ts.flatMap((t, k) => (U.vs[k] === null ? [] : [`${xOf(t).toFixed(1)} ${yOf(U.vs[k]!).toFixed(1)}`]))
      const dn = L.ts.flatMap((t, k) => (L.vs[k] === null ? [] : [`${xOf(t).toFixed(1)} ${yOf(L.vs[k]!).toFixed(1)}`])).reverse()
      const path = up.length && dn.length ? `M${up.join('L')}L${dn.join('L')}Z` : ''
      const pct = b.opacity > 1 ? b.opacity : b.opacity * 100
      // The legend swatch is a stronger wash of the same hue: a 16% tint on a 9px square reads as black.
      return { b, L, U, path, fill: slotTint(b.slot, pct), swatch: slotTint(b.slot, Math.min(100, Math.max(pct * 2.5, 35))) }
    })

    const markers = (d.markers ?? NONE)
      .map((mk) => ({ mk, t: parseT(mk.t, today) }))
      .filter((x) => Number.isFinite(x.t) && inWin(x.t))
      .map((x) => ({ ...x, x: xOf(x.t) }))
    const labels = placeMarkerLabels(
      markers.map((x) => ({ id: x.mk.id, x: x.x, label: x.mk.label })),
      padL,
      W - PAD_R,
    )
    // Marker labels' boxes, so a threshold label can move out of their way.
    const markerBoxes: LabelBox[] = labels.flatMap((lb) => {
      const mk = markers.find((x) => x.mk.id === lb.id)
      if (!mk) return []
      const w = mk.mk.label.length * 6.2
      const base = PAD_T + 11 + lb.row * 13
      return [{ x0: lb.anchor === 'start' ? lb.x : lb.x - w, x1: lb.anchor === 'start' ? lb.x + w : lb.x, y0: base - 10, y1: base + 2 }]
    })
    const thresholds =
      tf === 'value'
        ? (d.thresholds ?? NONE)
            .filter((th) => Number.isFinite(th.v))
            .map((th) => {
              const y = yOf(th.v)
              const ty = y - 5 < PAD_T + 9 ? y + 13 : y - 5
              return { th, y, ty, at: placeThresholdLabel(th.label, ty, padL, W - PAD_R, markerBoxes) }
            })
        : []
    const pointMarks =
      tf === 'value'
        ? (d.pointMarks ?? NONE)
            .map((pm) => ({ pm, t: parseT(pm.t, today) }))
            .filter((x) => Number.isFinite(x.t) && inWin(x.t) && Number.isFinite(x.pm.v))
            .map((x) => ({ ...x, x: xOf(x.t), y: yOf(x.pm.v) }))
        : []
    // Which union date each annotation belongs to, for the tooltip: the nearest one — or, on a
    // monthly chart, the month-end valuation that includes the event (a Nov 14 trade is November's).
    const noteIndex = (t: number) => (monthly && ub >= ua ? Math.min(ub, Math.max(ua, lower(union.ts, t))) : snapOf(t))
    const noted = new Map<number, { glyph: string; label: string; rug?: boolean }[]>()
    const note = (t: number, glyph: string, label: string, rug?: boolean) => {
      const k = noteIndex(t)
      if (k < 0) return
      const list = noted.get(k)
      if (list) list.push({ glyph, label, rug })
      else noted.set(k, [{ glyph, label, rug }])
    }
    // On a monthly chart the first point is its month's end, so a trade earlier in that month still
    // belongs to the chart: it sits on the left edge (and in that month's tooltip).
    const t0Month = new Date(win.t0)
    const rugFrom = monthly ? Date.UTC(t0Month.getUTCFullYear(), t0Month.getUTCMonth(), 1) : win.t0
    const rugs = (d.rug ?? NONE)
      .map((rg) => ({ rg, t: parseT(rg.t, today) }))
      .filter((x) => Number.isFinite(x.t) && x.t >= rugFrom && x.t <= win.t1)
    markers.forEach((x) => note(x.t, '│', x.mk.label))
    pointMarks.forEach((x) => note(x.t, glyphOf(x.pm.shape), x.pm.label))
    rugs.forEach((x) => note(x.t, glyphOf(x.rg.shape), x.rg.label, true))
    // Each tooltip lists a few of its trades and counts the rest.
    const notesAt = new Map<number, { glyph: string; label: string }[]>()
    for (const [k, list] of noted) notesAt.set(k, capRugNotes(list))
    // A tick sits on the date its trades are listed under (a monthly chart: their month's point), one ▲ and
    // one ▼ per pixel column, all in one path — a weekly habit is thousands of trades.
    const rugD =
      W > 0
        ? rugPathData(
            rugs.map((x) => {
              const k = noteIndex(x.t)
              return { x: xOf(k >= 0 ? union.ts[k]! : Math.max(x.t, win.t0)), shape: x.rg.shape }
            }),
            PAD_T + plotH,
          )
        : ''

    const drawable = hasData && shown.some((x) => x.P.ts.some((t, k) => inWin(t) && x.disp[k] !== null))
    return {
      parsed,
      span: { tMin, tMax },
      offered,
      preset,
      base,
      win,
      zoomed: !!zoomed,
      zoomTs,
      refused,
      shown,
      union,
      ua,
      ub,
      snapOf,
      padL,
      plotW,
      plotH,
      dom,
      xOf,
      yOf,
      ticks,
      tickLabels,
      xTicks,
      refLine,
      bands,
      markers,
      labels,
      thresholds,
      pointMarks,
      rugD,
      notesAt,
      drawable,
      hasData,
      fixedAnchor,
      dollars: unit === 'cents' && wantsDollars(raws),
      logOk,
      log,
    }
  }, [series, d.bands, d.markers, d.thresholds, d.pointMarks, d.rug, today, hiddenKey, tf, p.anchorT, unit, scale, baseline, presetPick, zoom, W, H, presetList])

  /* ---------------- the drawn window, reported ---------------- */
  const onWindow = useRef(p.onWindow)
  onWindow.current = p.onWindow
  const winT0 = m.hasData ? m.win.t0 : null
  const winT1 = m.hasData ? m.win.t1 : null
  useEffect(() => {
    if (winT0 !== null && winT1 !== null) onWindow.current?.({ t0: winT0, t1: winT1 })
  }, [winT0, winT1])

  /* ---------------- reveal on first draw ---------------- */
  const revealRect = useRef<SVGRectElement>(null)
  const revealed = useRef(false)
  const wNow = useRef(W)
  wNow.current = W
  const padLNow = useRef(m.padL)
  padLNow.current = m.padL
  const canDraw = W > 0 && m.drawable
  useLayoutEffect(() => {
    if (revealed.current || !canDraw) return
    revealed.current = true
    const el = revealRect.current
    if (!el || prefersReducedMotion()) return
    const from = padLNow.current
    const start = performance.now()
    let raf = 0
    let done = false
    const set = (w: number) => el.setAttribute('width', String(Math.max(0, w)))
    const tick = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - start) / DUR[4])) // a frame's timestamp can precede `start`
      const e = 1 - Math.pow(1 - k, 3) // ≈ --ease-out
      set(from + (wNow.current - from) * e)
      if (k < 1) raf = requestAnimationFrame(tick)
      else done = true
    }
    set(from)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      set(wNow.current)
      // Interrupted before it finished (StrictMode's rehearsal, a screen hidden mid-reveal): run it again next time.
      if (!done) revealed.current = false
    }
  }, [canDraw])

  /* ---------------- interaction ---------------- */
  const c = cursor !== null && cursor >= m.ua && cursor <= m.ub ? cursor : null
  const report = (w: Win) => p.onRangeChange?.({ from: isoOf(w.t0), to: isoOf(w.t1) })
  const tOfX = (px: number) => m.dom.t0 + ((px - m.padL) / m.plotW) * (m.dom.t1 - m.dom.t0)
  const clampX = (px: number) => Math.min(m.padL + m.plotW, Math.max(m.padL, px))
  const snapX = (px: number) => {
    const k = m.snapOf(tOfX(px))
    return k < 0 ? null : k
  }
  const pxOf = (ev: PointerEvent<SVGSVGElement>) => ev.clientX - ev.currentTarget.getBoundingClientRect().left

  const pickPreset = (v: TPreset) => {
    setPresetPick(v)
    setZoom(null)
    setCursor(null)
    if (m.hasData) report(presetWindow(v, m.span.tMin, m.span.tMax))
  }
  const resetZoom = () => {
    setZoom(null)
    report(m.base)
  }

  const onPointerDown = (ev: PointerEvent<SVGSVGElement>) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return
    const px = pxOf(ev)
    if (px < m.padL || px > m.padL + m.plotW) return
    if (ev.pointerType === 'touch') {
      setCursor(snapX(px)) // touch scrubs the crosshair; the page still scrolls vertically (touch-action: pan-y)
      return
    }
    drag.current = { x0: px, id: ev.pointerId, brushing: false }
    ev.currentTarget.setPointerCapture?.(ev.pointerId)
  }
  const onPointerMove = (ev: PointerEvent<SVGSVGElement>) => {
    const px = pxOf(ev)
    const dr = drag.current
    if (dr && dr.id === ev.pointerId) {
      if (dr.brushing || Math.abs(px - dr.x0) > 4) {
        dr.brushing = true
        setBrush({ a: dr.x0, b: clampX(px) })
        setCursor(null)
        return
      }
    }
    setCursor(px < m.padL - 8 || px > m.padL + m.plotW + 8 ? null : snapX(px))
  }
  const endDrag = (ev: PointerEvent<SVGSVGElement>, commit: boolean) => {
    const dr = drag.current
    if (!dr || dr.id !== ev.pointerId) return
    drag.current = null
    if (ev.currentTarget.hasPointerCapture?.(ev.pointerId)) ev.currentTarget.releasePointerCapture(ev.pointerId)
    setBrush(null)
    if (!commit || !dr.brushing) return
    const b = clampX(pxOf(ev))
    if (Math.abs(b - dr.x0) < 8) return
    const z = zoomWindow(tOfX(dr.x0), tOfX(b), m.win, m.zoomTs)
    if (!z) return
    setZoom(z)
    report(z)
  }

  const readingsAt = (k: number) => {
    const T = m.union.ts[k]!
    const all = m.shown.map((x, si) => {
      const j = m.union.at[si]![k]!
      const v = j >= 0 ? x.disp[j]! : null
      const t = j >= 0 ? x.P.ts[j]! : null
      // A held reading (carryTo) is as old as the reading it repeats.
      const asOf = j >= 0 && x.P.carry?.k === j ? x.P.carry.from : t
      return { x, j, v, y: j >= 0 ? x.pos[j]! : null, t, asOf, stale: asOf !== null && asOf < T, est: j >= 0 && x.P.est[j]! }
    })
    // Lines first, in series order; then a stack's layers top to bottom as drawn at this date.
    const layers = all.filter((r) => r.x.stacked)
    const rows = [...all.filter((r) => !r.x.stacked), ...stackTipOrder(layers.map((r) => r.v ?? 0)).map((i) => layers[i]!)]
    const own = rows.find((r) => r.t === T)
    const src = own ? own.x.P.src[own.j]! : isoOf(T)
    return { T, rows, src, title: p.tipLabel ? p.tipLabel(src) : tipTitle(src, T) }
  }
  const valueText = (v: number | null) => (v === null ? '—' : fmtValue(v, unit, m.dollars))
  const describe = (k: number) => {
    const r = readingsAt(k)
    const parts = r.rows.map((x) => `${x.x.s.label} ${valueText(x.v)}${x.stale && x.asOf !== null ? ` ${asOfText(x.asOf, r.T)}` : ''}${x.est && x.v !== null ? ', estimated' : ''}`)
    const notes = (m.notesAt.get(k) ?? []).map((n) => n.label)
    return [`${r.title}:`, parts.join('; '), ...notes].join(' ')
  }
  const moveTo = (k: number | null) => {
    setCursor(k)
    setLiveText(k === null ? '' : describe(k))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return
    const { ua, ub } = m
    if (ub < ua) return
    const step = e.shiftKey ? Math.max(1, Math.round((ub - ua) / 10)) : 1
    let next: number | null
    switch (e.key) {
      case 'ArrowLeft':
        next = c === null ? ub : Math.max(ua, c - step)
        break
      case 'ArrowRight':
        next = c === null ? ua : Math.min(ub, c + step)
        break
      case 'Home':
        next = ua
        break
      case 'End':
        next = ub
        break
      case 'Escape':
        if (c !== null) next = null
        else if (m.zoomed) {
          e.preventDefault()
          resetZoom()
          return
        } else return
        break
      default:
        return
    }
    e.preventDefault()
    moveTo(next)
  }
  const onFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && c === null && m.ub >= m.ua && e.currentTarget.matches(':focus-visible')) moveTo(m.ub)
  }

  const toggle = (id: string, hide: boolean) => {
    const i = series.findIndex((s) => s.id === id)
    if (i < 0) return
    if (hide && hidden.filter((h) => !h).length <= 1) return // never hide the last line
    setOverrides((o) => ({ ...o, [id]: { hidden: hide, prop: !!series[i]!.hidden } }))
    p.onToggleSeries?.(id, hide)
  }

  /* ---------------- render ---------------- */
  const refusedIds = new Map(m.refused.map((r) => [r.id, r]))
  const legendItems: LegendItem[] = [
    ...series.map((s, i): LegendItem => {
      const r = refusedIds.get(s.id)
      return {
        id: s.id,
        label: r ? (
          <span className="ch-refused" title={r.reason}>
            {s.label}
          </span>
        ) : (
          s.label
        ),
        color: s.color ?? slotColor(s.slot ?? slotAt(i)),
        mark: (s.stack && tf === 'value') || s.mark === 'area' ? 'box' : s.dash ? 'dash' : 'line',
        hidden: hidden[i],
        fixed: !!r,
      }
    }),
    ...m.bands.map((x): LegendItem => ({ id: `band:${x.b.id}`, label: x.b.label, color: x.swatch, mark: 'band', fixed: true })),
  ]
  const legendNode = p.legend === 'none' ? null : <Legend items={legendItems} onToggle={toggle} aria-label="Series" />
  const presetsNode =
    m.offered.length >= 2 ? (
      <Segmented<TPreset> aria-label="Range" value={m.preset} onChange={pickPreset} options={m.offered.map((v) => ({ value: v, label: v }))} />
    ) : null
  const scaleNode = showScaleToggle ? (
    <Segmented<'linear' | 'log'>
      aria-label="Scale"
      value={m.log ? 'log' : 'linear'}
      onChange={setScalePick}
      options={[
        { value: 'linear', label: 'Lin' },
        { value: 'log', label: 'Log', disabled: !m.logOk, title: m.logOk ? 'Logarithmic: equal steps are equal % changes' : 'Log needs every value in view above zero' },
      ]}
    />
  ) : null
  const legendFoot = p.legendAt === 'foot'
  const showHead = !!(p.title || p.lead || p.actions || presetsNode || scaleNode || m.zoomed || (!legendFoot && legendNode && legendItems.length >= 2))

  const r = c !== null ? readingsAt(c) : null
  const first = r?.rows.find((x) => x.y !== null)
  const at: TipPoint | null = r && !brush ? { x: m.xOf(r.T), y: first ? m.yOf(first.y!) : PAD_T + m.plotH / 3 } : null
  const extraValues: Record<string, number | null> = {}
  if (r && p.tooltipExtra)
    series.forEach((s, i) => {
      const P = m.parsed[i]!
      const j = asOfIndex(P.ts, r.T)
      extraValues[s.id] = j >= 0 ? P.vs[j]! : null
    })
  const anyEst = !!r?.rows.some((x) => x.est && x.v !== null)

  const summary = m.drawable
    ? `${fmtDay(m.win.t0)} to ${fmtDay(m.win.t1)}. ${m.shown
        .filter((x) => x.last >= 0)
        .map((x) => {
          const k = x.P.carry?.k === x.last ? x.last - 1 : x.last // a held reading: the day it was recorded
          const src = x.P.src[k]!
          return `${x.s.label}: ${valueText(x.disp[x.last]!)} ${/^\d{4}(-\d{2})?$/.test(src) ? 'in' : 'on'} ${tipTitle(src, x.P.ts[k]!)}`
        })
        .join('; ')}. Arrow keys step through the dates; drag across the plot to zoom, double-click or Escape to reset.`
    : ''

  const { padL, plotW, plotH, xOf, yOf } = m
  const right = padL + plotW
  const labelW = (s: string) => s.length * 6.2

  return (
    <div className={`ch-tc${p.pending ? ' is-pending' : ''}`} aria-busy={p.pending || undefined}>
      {showHead && (
        <div className="ch-head">
          {p.title && <h2>{p.title}</h2>}
          {p.lead && <div className="ch-head-lead">{p.lead}</div>}
          <div className="ch-head-r">
            {!legendFoot && legendNode}
            {p.actions}
            {m.zoomed && (
              <Button size="mini" variant="ghost" onClick={resetZoom} title="Or double-click the chart, or press Escape">
                Reset zoom
              </Button>
            )}
            {scaleNode}
            {presetsNode}
          </div>
        </div>
      )}
      <div
        className="chart ch-tc-plot"
        ref={ref}
        tabIndex={canDraw ? 0 : -1}
        role="group"
        aria-roledescription="chart"
        aria-label={p.ariaLabel}
        aria-describedby={`${uid}-d`}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        onBlur={() => setCursor(null)}
      >
        {W === 0 && <div style={{ height: H }} />}
        {W > 0 && !m.drawable &&
          (p.pending ? (
            <Skeleton h={H} radius={8} />
          ) : (
            <div className="ch-tc-empty" style={{ height: H }}>
              {m.refused.length && !m.shown.length ? 'Nothing here can be shown this way — see the note below.' : 'Nothing to chart in this range yet.'}
            </div>
          ))}
        {canDraw && (
          <svg
            width={W}
            height={H}
            aria-hidden="true"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(e) => endDrag(e, true)}
            onPointerCancel={(e) => endDrag(e, false)}
            onPointerLeave={() => !drag.current && setCursor(null)}
            onDoubleClick={() => m.zoomed && resetZoom()}
            className={brush ? 'is-brushing' : undefined}
          >
            <defs>
              <clipPath id={`${uid}-pl`}>
                <rect x={padL} y={PAD_T - 1} width={plotW} height={plotH + 2} />
              </clipPath>
              <clipPath id={`${uid}-rv`}>
                <rect ref={revealRect} x={0} y={0} width={W} height={H} />
              </clipPath>
            </defs>

            {m.ticks.map((v, k) => (
              <g key={v}>
                <line x1={padL} x2={right} y1={yOf(v)} y2={yOf(v)} stroke="var(--grid)" />
                <text x={padL - 8} y={yOf(v) + 4} textAnchor="end" fill="var(--ink-3)" fontSize={AXIS_FONT} fontFamily="var(--mono)">
                  {m.tickLabels[k]}
                </text>
              </g>
            ))}
            {m.refLine !== null && yOf(m.refLine) >= PAD_T - 1 && yOf(m.refLine) <= PAD_T + plotH + 1 && (
              <line x1={padL} x2={right} y1={yOf(m.refLine)} y2={yOf(m.refLine)} stroke="var(--axis)" />
            )}
            {m.xTicks.map((k) => {
              const lx = Math.max(labelW(k.label) / 2 + 2, Math.min(xOf(k.t), W - 2 - labelW(k.label) / 2))
              return (
                <text key={k.t} x={lx} y={H - 8} textAnchor="middle" fill={k.major ? 'var(--ink-2)' : 'var(--ink-3)'} fontSize={AXIS_FONT}>
                  {k.label}
                </text>
              )
            })}

            {m.thresholds.map(({ th, y }) =>
              y >= PAD_T - 1 && y <= PAD_T + plotH + 1 ? (
                <line key={th.id} x1={padL} x2={right} y1={y} y2={y} stroke={toneColor(th.tone)} strokeDasharray="4 4" opacity={0.85} />
              ) : null,
            )}
            {m.markers.map((x) => (
              <line key={x.mk.id} x1={x.x} x2={x.x} y1={PAD_T} y2={PAD_T + plotH} stroke={toneColor(x.mk.tone)} strokeDasharray="3 4" opacity={0.8} />
            ))}

            <g clipPath={`url(#${uid}-rv)`}>
              <g clipPath={`url(#${uid}-pl)`}>
                {m.shown.map((x) =>
                  x.stackPath ? (
                    // A 1px card-coloured edge is the surface gap between neighbouring layers.
                    <path key={`s-${x.s.id}`} className="ch-stack" d={x.stackPath} fill={x.color} fillOpacity={0.82} stroke="var(--card)" strokeWidth={1} strokeLinejoin="round" />
                  ) : null,
                )}
                {m.bands.map((x) => (x.path ? <path key={x.b.id} d={x.path} fill={x.fill} stroke="none" /> : null))}
                {m.shown.map((x) =>
                  x.paths.area ? <path key={`a-${x.s.id}`} d={x.paths.area} fill={x.color} opacity={0.1} stroke="none" /> : null,
                )}
                {m.shown.map((x) => (
                  <g key={`l-${x.s.id}`} fill="none" stroke={x.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
                    {x.paths.solid && <path d={x.paths.solid} strokeDasharray={x.s.dash ? '5 5' : undefined} strokeLinecap={x.s.dash ? 'butt' : 'round'} />}
                    {x.paths.est && <path className="ch-est" d={x.paths.est} strokeOpacity={0.6} strokeDasharray="3 4" strokeLinecap="butt" />}
                  </g>
                ))}
              </g>
              {m.shown.map((x) => (
                <g key={`d-${x.s.id}`} fill={x.color} stroke="var(--card)">
                  {x.dots.map((k) =>
                    k === x.last ? null : <circle key={k} cx={xOf(x.P.ts[k]!)} cy={yOf(x.disp[k]!)} r={2.4} strokeWidth={1.5} opacity={x.P.est[k] ? 0.6 : 1} />,
                  )}
                  {x.last >= 0 && !x.stacked && <circle cx={xOf(x.P.ts[x.last]!)} cy={yOf(x.disp[x.last]!)} r={3.5} strokeWidth={2} />}
                </g>
              ))}
              {m.pointMarks.map((x) =>
                x.pm.shape === 'dot' ? (
                  <circle key={x.pm.id} cx={x.x} cy={x.y} r={3} fill={MARK_VAR} stroke="var(--card)" strokeWidth={1} />
                ) : (
                  <path key={x.pm.id} d={glyphPath(x.x, x.y, x.pm.shape)} fill={MARK_VAR} stroke="var(--card)" strokeWidth={1} />
                ),
              )}
              {m.rugD && <path className="ch-rug" d={m.rugD} fill={MARK_VAR} stroke="var(--card)" strokeWidth={1} />}
            </g>

            {m.markers.map((x) => {
              const lb = m.labels.find((l) => l.id === x.mk.id)
              return lb ? (
                <text key={x.mk.id} x={lb.x} y={PAD_T + 11 + lb.row * 13} textAnchor={lb.anchor} fill={toneText(x.mk.tone)} fontSize={AXIS_FONT}>
                  {x.mk.label}
                </text>
              ) : null
            })}
            {m.thresholds.map(({ th, y, ty, at: lb }) =>
              y >= PAD_T - 1 && y <= PAD_T + plotH + 1 ? (
                <text key={th.id} x={lb.x} y={ty} textAnchor={lb.anchor} fill={toneText(th.tone)} fontSize={AXIS_FONT}>
                  {th.label}
                </text>
              ) : null,
            )}

            {r && !brush && (
              <g pointerEvents="none">
                <line x1={xOf(r.T)} x2={xOf(r.T)} y1={PAD_T} y2={PAD_T + plotH} stroke="var(--axis)" />
                {r.rows.map((x) =>
                  x.y === null || x.t === null || x.x.stacked || xOf(x.t) < padL - 0.5 ? null : (
                    <circle
                      key={x.x.s.id}
                      className="ch-pop"
                      cx={xOf(x.t)}
                      cy={yOf(x.y)}
                      r={4.5}
                      fill={x.x.color}
                      stroke={HOVER_STROKE}
                      strokeWidth={2}
                      opacity={x.stale ? 0.7 : 1}
                    />
                  ),
                )}
              </g>
            )}
            {brush && (
              <g pointerEvents="none">
                <rect className="ch-brush" x={Math.min(brush.a, brush.b)} y={PAD_T} width={Math.abs(brush.b - brush.a)} height={plotH} />
                <text x={(brush.a + brush.b) / 2} y={PAD_T + 12} textAnchor="middle" fill="var(--ink-2)" fontSize={AXIS_FONT}>
                  {`${fmtDay(tOfX(Math.min(brush.a, brush.b)))} – ${fmtDay(tOfX(Math.max(brush.a, brush.b)))}`}
                </text>
              </g>
            )}
          </svg>
        )}
        <ChartTip at={at} box={{ w: W, h: H }}>
          {r && (
            <>
              <div className="t">{r.title}</div>
              {r.rows.map((x) => (
                <TipRow
                  key={x.x.s.id}
                  color={x.x.color}
                  mark={x.x.stacked || x.x.s.mark === 'area' ? 'box' : x.x.s.dash ? 'dash' : 'line'}
                  name={x.x.s.label}
                  value={
                    <>
                      {valueText(x.v)}
                      {x.stale && x.asOf !== null && x.v !== null && <span className="ch-asof">{asOfText(x.asOf, r.T)}</span>}
                    </>
                  }
                />
              ))}
              {m.bands.map((x) => {
                const jl = asOfIndex(x.L.ts, r.T)
                const ju = asOfIndex(x.U.ts, r.T)
                const lo = jl >= 0 ? x.L.vs[jl]! : null
                const hi = ju >= 0 ? x.U.vs[ju]! : null
                return lo === null || hi === null ? null : (
                  <TipRow key={x.b.id} color={x.swatch} name={x.b.label} value={`${valueText(lo)} – ${valueText(hi)}`} />
                )
              })}
              {(m.notesAt.get(c!) ?? []).map((n, k) => (
                <TipRow key={`n${k}`} color="transparent" name={n.glyph ? `${n.glyph} ${n.label}` : n.label} value="" />
              ))}
              {p.tooltipExtra?.(r.src, extraValues)}
              {anyEst && <div className="ch-note">Dashed: estimated at cost — no price history</div>}
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
      {legendFoot && legendNode && <div className="ch-legend-below">{legendNode}</div>}
      {(m.refused.length > 0 || (tf !== 'value' && m.drawable)) && (
        <div className="ch-note">
          {tf === 'rebased' && m.drawable && (m.fixedAnchor ? `100 = each line's value on ${fmtDay(parseT(p.anchorT!, today))}. ` : "100 = each line's first value above zero in view. ")}
          {tf === 'pct' && m.drawable && (m.fixedAnchor ? `% change from ${fmtDay(parseT(p.anchorT!, today))}. ` : "% change from each line's first value above zero in view. ")}
          {m.refused.map((x) => x.reason).join(' ')}
        </div>
      )}
    </div>
  )
}
