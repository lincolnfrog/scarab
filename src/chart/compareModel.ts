import { cagr, changeMicro, maxDrawdown, monthsApart, rebase } from '../../shared/series'
import { MAX_SERIES_IDS, type ChartView, type SeriesMeta, type SeriesPoint, type SeriesUnit } from '../../shared/series-api'
import { parseT } from './scale'

/**
 * Compare's pure rules (plan §C7): which modes a selection allows, the
 * labels and stats it shows, saved-view identity, and the Performance
 * preset's ids. The screen (src/screens/Compare.tsx) only wires these up.
 */

export type CompareMode = ChartView['mode']
export const MODES: readonly CompareMode[] = ['value', 'rebased', 'pct', 'diff']
export const MODE_LABEL: Record<CompareMode, string> = { value: 'Value', rebased: 'Rebased = 100', pct: '% change', diff: 'A − B' }
export const isMode = (s: unknown): s is CompareMode => typeof s === 'string' && (MODES as readonly string[]).includes(s)

export type ModeState = { ok: boolean; why?: string }

/**
 * Which modes the selected series' units allow:
 *   - Value: every series in one unit, and that unit an amount (cents, or a
 *     price per share) — an index's level means nothing across bases.
 *   - Rebased and % change: always (each line is measured from its own start).
 *   - A − B: exactly two series, both in cents.
 */
export function modeAvailability(units: readonly SeriesUnit[]): Record<CompareMode, ModeState> {
  const n = units.length
  const one = n > 0 && units.every((u) => u === units[0])
  const allIndex = n > 0 && units.every((u) => u === 'index_micro')
  const value: ModeState =
    n === 0
      ? { ok: false, why: 'Pick something to compare first' }
      : allIndex
        ? { ok: false, why: 'Returns and benchmarks are indexes with different starting points — compare them rebased' }
        : one && units[0] !== 'index_micro'
          ? { ok: true }
          : { ok: false, why: "These series are in different units, so they can't share a value axis" }
  const growth: ModeState = n === 0 ? { ok: false, why: 'Pick something to compare first' } : { ok: true }
  const diff: ModeState =
    n === 2 && units.every((u) => u === 'cents') ? { ok: true } : { ok: false, why: 'A − B needs exactly two dollar series' }
  return { value, rebased: growth, pct: growth, diff }
}

/**
 * The mode actually drawn. A mode the selection can't use falls back to
 * Rebased = 100 with a one-line hint (plan: "mixed units switch to Rebased");
 * the person's own pick is kept, so removing the odd series brings it back.
 */
export function effectiveMode(want: CompareMode, units: readonly SeriesUnit[]): { mode: CompareMode; hint: string | null } {
  const avail = modeAvailability(units)
  if (units.length === 0 || avail[want].ok) return { mode: want, hint: null }
  if (want === 'value')
    return {
      mode: 'rebased',
      hint: units.every((u) => u === 'index_micro')
        ? 'Returns and benchmarks are indexes, so they’re shown rebased to 100 at a common start.'
        : 'These series are in different units, so they’re shown rebased to 100 at a common start.',
    }
  return { mode: 'rebased', hint: 'A − B needs exactly two dollar series, so these are shown rebased to 100.' }
}

/**
 * Balance series grow with money put in, not just with returns: rebased,
 * their rise includes deposits (and a mortgage's paydown), so they say so.
 * Prices, benchmarks, time-weighted returns and a property's value don't.
 */
const BALANCE_RE = /^(nw:(total|cash|brokerage|retirement|crypto|equity)|inv:(all|\d+):(value|cost)|pos:\d+:(value|cost)|set:\d+(\+\d+)*:(value|cost)|cash:\d+|goal:fund|prop:\d+:equity)$/
export const includesDeposits = (id: string) => BALANCE_RE.test(id)

export function seriesLabel(label: string, id: string, mode: CompareMode): string {
  return (mode === 'rebased' || mode === 'pct') && includesDeposits(id) ? `${label} · includes deposits` : label
}

/* ---------------- stats row ---------------- */

export type SeriesStat = {
  id: string
  label: string
  unit: SeriesUnit
  kind: 'level' | 'flow'
  /** Points with a value inside the window. */
  n: number
  start: { t: string; v: number } | null
  end: { t: string; v: number } | null
  /** Calendar months from start to end. */
  months: number
  change: number | null
  changeMicro: number | null
  /** Only with ≥ 12 months, and only for a level series with growth (not a difference). */
  cagrMicro: number | null
  drawdown: { micro: number; peakT: string; troughT: string } | null
  /** Flows only: the window's sum and its monthly mean (integer cents, half away from zero). */
  total: number | null
  average: number | null
}

/** round(a / n) for integers, half away from zero. */
function divRound(a: number, n: number): number {
  const q = Math.trunc(a / n)
  const r = a - q * n
  return 2 * Math.abs(r) >= n ? q + Math.sign(a) : q
}

/**
 * Start, end and change of one series inside the chart's window (epoch-ms
 * bounds, inclusive; null = everything), plus CAGR and max drawdown once the
 * window spans at least 12 months (plan §C7). A flow (income, spending) gets
 * its total and monthly mean instead of growth figures. `growth: false` (a
 * difference A − B) keeps start/end/change only.
 */
export function seriesStats(
  s: { id: string; label: string; unit: SeriesUnit; kind: 'level' | 'flow'; points: readonly SeriesPoint[] },
  win: { t0: number; t1: number } | null,
  today: string,
  o: { growth?: boolean } = {},
): SeriesStat {
  const pts = s.points.filter((p): p is { t: string; v: number; est?: boolean } => {
    if (p.v === null || !Number.isSafeInteger(p.v)) return false
    if (!win) return true
    const t = parseT(p.t, today)
    return t >= win.t0 && t <= win.t1
  })
  const start = pts[0] ? { t: pts[0].t, v: pts[0].v } : null
  const end = pts.length ? { t: pts[pts.length - 1]!.t, v: pts[pts.length - 1]!.v } : null
  const months = start && end ? monthsApart(start.t, end.t) : 0
  const flow = s.kind === 'flow'
  const growth = o.growth !== false && !flow
  const total = flow ? pts.reduce((a, p) => a + p.v, 0) : null
  let drawdown: SeriesStat['drawdown'] = null
  if (growth && months >= 12) {
    const dd = maxDrawdown(pts.map((p) => p.v))
    if (dd) drawdown = { micro: dd.micro, peakT: pts[dd.peak]!.t, troughT: pts[dd.trough]!.t }
  }
  return {
    id: s.id,
    label: s.label,
    unit: s.unit,
    kind: s.kind,
    n: pts.length,
    start,
    end,
    months,
    change: start && end && !flow ? end.v - start.v : null,
    changeMicro: start && end && !flow ? changeMicro(end.v, start.v) : null,
    cagrMicro: growth && start && end ? cagr(start.v, end.v, months) : null,
    drawdown,
    total,
    average: flow && pts.length ? divRound(total!, pts.length) : null,
  }
}

/** An index series' start and end on a 100 base at the start (index-micro); null when the start isn't above zero. */
export function indexedEnds(start: number, end: number): { start: number; end: number } | null {
  const r = rebase([start, end], 0)
  return r ? { start: r[0]!, end: r[1]! } : null
}

/** '2 yr 3 mo' / '7 mo' / '1 yr'. */
export function spanText(months: number): string {
  if (months <= 0) return 'one month'
  const y = Math.floor(months / 12)
  const m = months % 12
  return [y ? `${y} yr` : '', m ? `${m} mo` : ''].filter(Boolean).join(' ')
}

/* ---------------- warnings ---------------- */

/** The series layer's warnings that concern one id ('<id>: …' or 'unknown series: <id>'). */
export function warningsFor(id: string, warnings: readonly string[]): string[] {
  return warnings.filter((w) => w.startsWith(`${id}:`) || w === `unknown series: ${id}`)
}

/** '<id>: reason' → 'reason'; 'unknown series: <id>' → a plain sentence. */
export function warningText(id: string, w: string): string {
  if (w === `unknown series: ${id}`) return 'No longer exists — the account, holding or property behind it was removed.'
  return w.startsWith(`${id}:`) ? w.slice(id.length + 1).trim() : w
}

/* ---------------- saved views ---------------- */

/**
 * View ids travel in the URL (#/compare?v=<id>), so a new one must pass the
 * router's privacy regex ([a-z0-9-]{1,24}) as well as the server's
 * ([A-Za-z0-9_-]{1,64}). A view saved elsewhere with another spelling still
 * opens from the menu; it just isn't put in the address.
 */
export const ROUTE_SAFE_VIEW_ID = /^[a-z0-9-]{1,24}$/i

export function newViewId(now: number = Date.now(), rand: () => number = Math.random): string {
  const r = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, '0')
  return `v${now.toString(36)}${r}`.slice(0, 24)
}

export type Selection = { ids: string[]; mode: CompareMode; from?: string; to?: string }

export const viewSelection = (v: Pick<ChartView, 'ids' | 'mode' | 'from' | 'to'>): Selection => ({
  ids: [...v.ids],
  mode: v.mode,
  ...(v.from ? { from: v.from } : {}),
  ...(v.to ? { to: v.to } : {}),
})

/** Same series in the same order (A − B cares), same mode, same window. */
export function sameSelection(a: Selection, b: Selection): boolean {
  return a.mode === b.mode && (a.from ?? '') === (b.from ?? '') && (a.to ?? '') === (b.to ?? '') && a.ids.length === b.ids.length && a.ids.every((id, i) => id === b.ids[i])
}

/**
 * A label for a set id the catalog doesn't list, from its members' holding
 * labels — 'VTI + VXUS · time-weighted return' — before the series itself
 * has loaded (the series layer labels it the same way). Null for other ids.
 */
export function setLabel(id: string, labelOf: (id: string) => string | undefined): string | null {
  const m = /^set:(\d+(?:\+\d+)*):(value|cost|twr)$/.exec(id)
  if (!m) return null
  const metric = m[2]!
  const names = m[1]!.split('+').map((n) => labelOf(`pos:${n}:${metric}`)?.replace(/ · .*$/, '') ?? `#${n}`)
  const what = metric === 'twr' ? 'time-weighted return' : metric === 'cost' ? 'cost basis' : 'value'
  return `${names.join(' + ')} · ${what}`
}

/** A default name from the series' labels: 'Net worth vs S&P 500 (SPY)'. At most 80 characters. */
export function suggestName(ids: readonly string[], labelOf: (id: string) => string): string {
  const name = ids.map(labelOf).join(' vs ')
  return name.length <= 80 ? name : `${name.slice(0, 79).trimEnd()}…`
}

/**
 * The window to save with a view, as months: the chart's visible window when
 * it is narrower than the data (a preset or a zoom), else the window the data
 * was fetched for, else none (the whole history). `chart`/`span` are epoch ms.
 */
export function viewWindow(
  chart: { t0: number; t1: number } | null,
  span: { t0: number; t1: number } | null,
  fetched: { from?: string; to?: string },
): { from?: string; to?: string } {
  const DAY = 86_400_000
  if (chart && span && (chart.t0 > span.t0 + DAY || chart.t1 < span.t1 - DAY)) {
    const m = (t: number) => new Date(t).toISOString().slice(0, 7)
    const from = chart.t0 > span.t0 + DAY ? m(chart.t0) : fetched.from
    const to = chart.t1 < span.t1 - DAY ? m(chart.t1) : fetched.to
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
  }
  return { ...(fetched.from ? { from: fetched.from } : {}), ...(fetched.to ? { to: fetched.to } : {}) }
}

/**
 * What Compare does when it shows on a history entry (kept alive, so it may
 * already hold a selection):
 *   'keep'  — the entry carries its own selection (a reload, Back/Forward,
 *             a view opened from the menu, the Dashboard's ⇄ Compare): use it.
 *   'stamp' — no selection on the entry (the nav, a plain link) and either no
 *             ?v= or the view the screen already shows: keep what is on
 *             screen, unsaved edits included, and write it onto the entry.
 *   'wait'  — a different ?v= arrived and the saved views are still loading.
 *   'apply' — a different ?v= arrived: open that saved view.
 * `fromView` is the saved view the on-screen selection came from, if any.
 */
export function arrivalAction(o: { entryHasSelection: boolean; v: string | null; fromView: string | null; viewsLoaded: boolean }): 'keep' | 'stamp' | 'wait' | 'apply' {
  if (o.entryHasSelection) return 'keep'
  if (!o.v || o.fromView === o.v) return 'stamp'
  return o.viewsLoaded ? 'apply' : 'wait'
}

/* ---------------- the Performance preset (amendment 4) ---------------- */

export type PerfOptions = { accounts: SeriesMeta[]; holdings: SeriesMeta[]; benchmarks: SeriesMeta[] }

/** What the preset can offer: account and holding time-weighted returns, and benchmarks, in catalog order. */
export function perfOptions(entries: readonly SeriesMeta[]): PerfOptions {
  return {
    accounts: entries.filter((e) => /^inv:(all|\d+):twr$/.test(e.id)),
    holdings: entries.filter((e) => /^pos:\d+:twr$/.test(e.id)),
    benchmarks: entries.filter((e) => /^bench:[^:]+$/.test(e.id)),
  }
}

/** The benchmark to start from: SPY, else VTI, else the first one with data; null when none has any. */
export function defaultBench(benchmarks: readonly SeriesMeta[]): string | null {
  const ok = benchmarks.filter((b) => b.available)
  return (ok.find((b) => b.id === 'bench:SPY') ?? ok.find((b) => b.id === 'bench:VTI') ?? ok[0])?.id ?? null
}

export type PerfPick = {
  /** inv:*:twr ids. */
  accounts: string[]
  /** pos:*:twr ids. */
  holdings: string[]
  /** Several holdings as one line: their combined time-weighted return (set:a+b:twr). */
  combine: boolean
  /** A bench:* id, or null for none. */
  bench: string | null
}

/** The preset's starting pick: the whole portfolio (or the first account, or holding, with a return) against SPY/VTI. */
export function perfDefaults(o: PerfOptions): PerfPick {
  const acct = o.accounts.find((a) => a.id === 'inv:all:twr' && a.available) ?? o.accounts.find((a) => a.available)
  const hold = acct ? undefined : o.holdings.find((h) => h.available)
  return { accounts: acct ? [acct.id] : [], holdings: hold ? [hold.id] : [], combine: false, bench: defaultBench(o.benchmarks) }
}

const assetOf = (id: string) => Number(/^pos:(\d+):twr$/.exec(id)?.[1])

/** The series ids a pick draws, benchmark last. Combined holdings become one set id, members in ascending id order. */
export function perfIds(p: PerfPick): string[] {
  const holdings =
    p.combine && p.holdings.length >= 2
      ? [
          `set:${[...new Set(p.holdings.map(assetOf))]
            .filter((n) => Number.isSafeInteger(n))
            .sort((a, b) => a - b)
            .join('+')}:twr`,
        ]
      : p.holdings
  const lines = [...new Set([...p.accounts, ...holdings])]
  return p.bench ? [...lines.slice(0, MAX_SERIES_IDS - 1), p.bench] : lines.slice(0, MAX_SERIES_IDS)
}

/** How many lines a pick draws before the benchmark — at most MAX_SERIES_IDS − 1 with one. */
export function perfLineCount(p: PerfPick): number {
  return p.accounts.length + (p.combine && p.holdings.length >= 2 ? 1 : p.holdings.length)
}
