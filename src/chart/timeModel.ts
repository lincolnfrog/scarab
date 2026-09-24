/**
 * The pure half of TimeChart: range presets and zoom windows, path building
 * (solid vs estimated segments, steps, area runs), marker-label placement and
 * the tooltip's value formatting. No React, no DOM — node-tested in
 * timeModel.test.ts; TimeChart.tsx draws what these return.
 */
import { formatCents, formatDollars, formatPercentMicro } from '../../shared/money'
import type { AxisUnit } from './format'
import { addMonthsUTC, DAY_MS, MONTH_NAMES } from './scale'

export type TPreset = '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'ALL'
export const PRESET_MONTHS: Record<Exclude<TPreset, 'ALL'>, number> = { '3M': 3, '6M': 6, '1Y': 12, '2Y': 24, '5Y': 60 }
export const ALL_PRESETS: TPreset[] = ['3M', '6M', '1Y', '2Y', '5Y', 'ALL']
export const DEFAULT_PRESETS: TPreset[] = ['6M', '1Y', '2Y', '5Y', 'ALL']

export type Win = { t0: number; t1: number }

export const isPreset = (s: unknown): s is TPreset => typeof s === 'string' && (ALL_PRESETS as string[]).includes(s)

/**
 * The window a preset shows: the last N calendar months up to the newest
 * point, never starting before the oldest one. ALL is the whole span.
 */
export function presetWindow(preset: TPreset, tMin: number, tMax: number): Win {
  if (preset === 'ALL') return { t0: tMin, t1: tMax }
  return { t0: Math.max(tMin, addMonthsUTC(tMax, -PRESET_MONTHS[preset])), t1: tMax }
}

/**
 * The presets worth offering for a data span: those strictly shorter than it,
 * plus ALL. A preset as long as the data would just repeat ALL. A lone ALL
 * means "offer none".
 */
export function availablePresets(presets: readonly TPreset[], tMin: number, tMax: number): TPreset[] {
  return presets.filter((p) => p === 'ALL' || addMonthsUTC(tMax, -PRESET_MONTHS[p]) > tMin)
}

/** How many of the ascending `ts` fall inside [t0, t1]. */
export function countIn(ts: readonly number[], w: Win): number {
  let n = 0
  for (const t of ts) if (t >= w.t0 && t <= w.t1) n++
  return n
}

/**
 * A brushed window, kept only when it is worth drawing: clamped to `within`,
 * at least `minPoints` union dates inside it. Otherwise null (the brush is
 * ignored rather than zooming into an empty plot).
 */
export function zoomWindow(a: number, b: number, within: Win, ts: readonly number[], minPoints = 2): Win | null {
  const w = { t0: Math.max(within.t0, Math.min(a, b)), t1: Math.min(within.t1, Math.max(a, b)) }
  if (!(w.t1 > w.t0)) return null
  return countIn(ts, w) >= minPoints ? w : null
}

/** The x-scale domain for a window: a lone date gets ±15 days so its point sits mid-plot. */
export function domainOf(w: Win): Win {
  return w.t1 - w.t0 < DAY_MS ? { t0: w.t0 - 15 * DAY_MS, t1: w.t1 + 15 * DAY_MS } : w
}

/* ---------------- paths ---------------- */

export type LinePaths = {
  /** Segments between two real values. */
  solid: string
  /** Segments touching an estimated point (valued at cost): drawn dashed at 60%. */
  est: string
  /** Closed polygons from the line down to `yBase`, one per unbroken run. */
  area: string
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

/**
 * SVG path data for one series over the kept indices `idx` (ascending):
 * nulls break the line; a segment is estimated when either end is; the pen
 * continues one subpath while the kind stays the same, so a dash pattern
 * never restarts mid-run. `step` draws step-after (hold, then jump).
 */
export function linePaths(
  idx: readonly number[],
  ts: readonly number[],
  vs: readonly (number | null)[],
  est: readonly boolean[],
  x: (t: number) => number,
  y: (v: number) => number,
  o: { step?: boolean; yBase?: number } = {},
): LinePaths {
  const out = { solid: '', est: '', area: '' }
  let pen: 'solid' | 'est' | null = null
  let prev = -1
  let run: string[] = []
  let runX0 = 0
  let runX1 = 0
  const flush = () => {
    if (o.yBase !== undefined && run.length > 1) out.area += `M${f1(runX0)} ${f1(o.yBase)}${run.join('')}L${f1(runX1)} ${f1(o.yBase)}Z`
    run = []
  }
  for (const i of idx) {
    const v = vs[i]
    if (v === null || v === undefined) {
      flush()
      pen = null
      prev = -1
      continue
    }
    const X = x(ts[i]!)
    const Y = y(v)
    if (prev < 0) {
      runX0 = X
      run.push(`L${f1(X)} ${f1(Y)}`)
    } else {
      const pv = vs[prev]!
      const pX = x(ts[prev]!)
      const pY = y(pv)
      const kind = est[prev] || est[i] ? 'est' : 'solid'
      if (pen !== kind) out[kind] += `M${f1(pX)} ${f1(pY)}`
      pen = kind
      const seg = o.step ? `L${f1(X)} ${f1(pY)}L${f1(X)} ${f1(Y)}` : `L${f1(X)} ${f1(Y)}`
      out[kind] += seg
      run.push(seg)
    }
    runX1 = X
    prev = i
  }
  flush()
  return out
}

/* ---------------- annotations ---------------- */

export type PlacedLabel = { id: string; x: number; row: number; anchor: 'start' | 'end' }

/**
 * Marker labels along the top of the plot: right of their line when there is
 * room, left of it near the right edge, on a second row when the first is
 * taken, and dropped (the line and its tooltip row stay) when neither fits.
 */
export function placeMarkerLabels(
  marks: readonly { id: string; x: number; label: string }[],
  left: number,
  right: number,
  o: { rows?: number; charW?: number; gap?: number } = {},
): PlacedLabel[] {
  const rows = o.rows ?? 2
  const charW = o.charW ?? 6
  const gap = o.gap ?? 6
  const used: [number, number][][] = Array.from({ length: rows }, () => [])
  const free = (row: number, a: number, b: number) => used[row]!.every(([u0, u1]) => b + gap <= u0 || a >= u1 + gap)
  const out: PlacedLabel[] = []
  for (const m of [...marks].sort((a, b) => a.x - b.x)) {
    const w = m.label.length * charW
    for (let row = 0; row < rows; row++) {
      const startA = m.x + gap
      const endB = m.x - gap
      if (startA + w <= right && free(row, startA, startA + w)) {
        used[row]!.push([startA, startA + w])
        out.push({ id: m.id, x: startA, row, anchor: 'start' })
        break
      }
      if (endB - w >= left && free(row, endB - w, endB)) {
        used[row]!.push([endB - w, endB])
        out.push({ id: m.id, x: endB, row, anchor: 'end' })
        break
      }
    }
  }
  return out
}

/** A text box on the plot, for collision checks: x0..x1 across, y0..y1 down. */
export type LabelBox = { x0: number; x1: number; y0: number; y1: number }

const overlaps = (a: LabelBox, b: LabelBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/**
 * Where a threshold's label goes on its line: at the right end (the default,
 * reading "Target $680K" where the eye ends), or at the left end when the
 * right would collide with a marker label (an ETA marker near the right edge
 * sits exactly there). `baseline` is the text's y; boxes are ~11px tall.
 */
export function placeThresholdLabel(
  label: string,
  baseline: number,
  left: number,
  right: number,
  taken: readonly LabelBox[],
  o: { charW?: number } = {},
): { x: number; anchor: 'start' | 'end' } {
  const w = label.length * (o.charW ?? 6.2)
  const box = (x0: number): LabelBox => ({ x0, x1: x0 + w, y0: baseline - 10, y1: baseline + 2 })
  const atRight = box(right - 2 - w)
  if (!taken.some((t) => overlaps(atRight, t))) return { x: right - 2, anchor: 'end' }
  return { x: left + 4, anchor: 'start' }
}

/* ---------------- tooltip text ---------------- */

/**
 * A reading for the tooltip. Money over $10,000 reads in whole dollars (a
 * net-worth line), under it in cents (a share price); `dollars` decides once
 * per chart so rows never mix. pct is a micro-fraction, index is index-micro.
 */
export function fmtValue(v: number, unit: AxisUnit, dollars: boolean): string {
  const n = Math.round(v)
  if (unit === 'pct') return `${n > 0 ? '+' : ''}${formatPercentMicro(n, 1)}`
  if (unit === 'index') return formatPercentMicro(n, 1).replace('%', '')
  return dollars ? formatDollars(n) : formatCents(n)
}

/** Whether a chart's money reads in whole dollars: any visible value of $10,000 or more. */
export function wantsDollars(values: Iterable<number | null>): boolean {
  for (const v of values) if (v !== null && Math.abs(v) >= 1_000_000) return true
  return false
}

/** "as of Aug 31" — with the year when it differs from the crosshair's ("as of Dec 31, 2025"). */
export function asOfText(t: number, ref: number): string {
  const d = new Date(t)
  const sameYear = d.getUTCFullYear() === new Date(ref).getUTCFullYear()
  return `as of ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}${sameYear ? '' : `, ${d.getUTCFullYear()}`}`
}

/** True when every date is a month ('YYYY-MM') — the chart then places ticks on month-end points. */
export function allMonthly(dates: Iterable<string>): boolean {
  let any = false
  for (const t of dates) {
    if (!/^\d{4}-\d{2}$/.test(t)) return false
    any = true
  }
  return any
}

/* ---------------- carried readings ---------------- */

/** A parsed series: ascending times, values (null breaks the line), estimated flags and each point's own date string. */
export type SeriesCols = { ts: number[]; vs: (number | null)[]; est: boolean[]; src: string[] }
/** `carry`: the index of a reading repeated from an earlier one, and that earlier reading's time. */
export type Carried = SeriesCols & { carry?: { k: number; from: number } }

/**
 * A series whose last reading stands until the next one (a valuation, a
 * loan balance) held flat to `t` — its date string `src` — so the line
 * reaches it rather than stopping at the last recorded fact. Unchanged when
 * the series is empty, already reaches `t`, or ends in a break.
 */
export function carryForward(P: SeriesCols, t: number, src: string): Carried {
  const n = P.ts.length
  const v = n > 0 ? P.vs[n - 1] : null
  if (n === 0 || v === null || v === undefined || !(P.ts[n - 1]! < t)) return P
  return { ts: [...P.ts, t], vs: [...P.vs, v], est: [...P.est, P.est[n - 1]!], src: [...P.src, src], carry: { k: n, from: P.ts[n - 1]! } }
}

/* ---------------- trade rug ---------------- */

/** A rug tick on the plot's floor `yb`: ▲ and ▼ both sit inside the plot, 7px tall. */
export function rugPath(x: number, yb: number, shape: 'up' | 'down'): string {
  return shape === 'up' ? `M${x.toFixed(1)} ${yb - 8}l4 7h-8Z` : `M${x.toFixed(1)} ${yb - 1}l4 -7h-8Z`
}

/**
 * The whole rug as one path: a ▲ or ▼ once per pixel column, however many
 * trades land there. A weekly habit over ten years is thousands of trades;
 * one element per trade made every hover re-render thousands of nodes (F34).
 */
export function rugPathData(ticks: Iterable<{ x: number; shape: 'up' | 'down' }>, yb: number): string {
  const seen = new Set<string>()
  let d = ''
  for (const tk of ticks) {
    const key = `${Math.round(tk.x)}${tk.shape === 'up' ? '+' : '-'}`
    if (seen.has(key)) continue
    seen.add(key)
    d += rugPath(tk.x, yb, tk.shape)
  }
  return d
}

/** How many rug notes one tooltip lists before summing up the rest. */
export const RUG_NOTES_MAX = 5

/**
 * One date's tooltip notes with its rug entries capped: markers and point
 * marks all stay, then the first `max` rug notes, then "+N more" — a busy
 * month no longer grows a tooltip taller than the chart (F34).
 */
export function capRugNotes<N extends { glyph: string; label: string; rug?: boolean }>(notes: readonly N[], max: number = RUG_NOTES_MAX): { glyph: string; label: string }[] {
  const rugs = notes.filter((n) => n.rug)
  if (rugs.length <= max) return [...notes]
  return [...notes.filter((n) => !n.rug), ...rugs.slice(0, max), { glyph: '', label: `+${rugs.length - max} more` }]
}
