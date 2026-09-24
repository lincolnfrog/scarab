import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatCents, formatDollars } from '../../shared/money'
import { commonStart, diff } from '../../shared/series'
import {
  MAX_SERIES_IDS,
  type ChartView,
  type Series,
  type SeriesCatalogResponse,
  type SeriesMeta,
  type SeriesResponse,
} from '../../shared/series-api'
import { get, put } from '../api'
import { TipRow } from '../chart/ChartTip'
import {
  arrivalAction,
  effectiveMode,
  indexedEnds,
  isMode,
  MODE_LABEL,
  modeAvailability,
  MODES,
  newViewId,
  ROUTE_SAFE_VIEW_ID,
  sameSelection,
  seriesLabel,
  seriesStats,
  setLabel,
  spanText,
  suggestName,
  viewSelection,
  viewWindow,
  warningsFor,
  warningText,
  type CompareMode,
  type SeriesStat,
} from '../chart/compareModel'
import { fmtIndex, fmtPctMicro, monthLong } from '../chart/format'
import { Swatch } from '../chart/Legend'
import { pinSlots, signColor, slotColor, type Slot } from '../chart/palette'
import { PerformanceDialog } from '../chart/PerformanceDialog'
import { parseT } from '../chart/scale'
import { SeriesPicker } from '../chart/SeriesPicker'
import { TimeChart, type TSeries } from '../chart/TimeChart'
import { wantsDollars } from '../chart/timeModel'
import { todayLocal } from '../../shared/dates'
import { navigate, setParams, useRouteState, type Route } from '../router'
import { Button } from '../ui/Button'
import { confirm, prompt } from '../ui/dialogs'
import { EmptyState } from '../ui/EmptyState'
import { HeaderSlot } from '../ui/HeaderSlot'
import { Menu, type MenuItem } from '../ui/Menu'
import { useScreen, useScreenRoute } from '../ui/screen'
import { Segmented } from '../ui/Segmented'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import '../chart/chart.css'

type Win = { from?: string; to?: string }
type ViewInput = Pick<ChartView, 'id' | 'name' | 'ids' | 'mode' | 'from' | 'to'>
type CatalogLoad = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; entries: SeriesMeta[] }

/* Colours pinned to series ids for the tab's session: a series keeps its colour while it stays picked
   (legend toggles never repaint), and one removed and added back gets its old colour when that slot is free. */
let pinned = new Map<string, Slot>()
const remembered = new Map<string, Slot>()
function slotsFor(ids: string[]): Map<string, Slot> {
  pinned = pinSlots(ids, pinned, { release: true, remember: remembered })
  for (const [id, s] of pinned) remembered.set(id, s)
  return pinned
}

/** Route state is structured-cloned history data: take only well-formed ids, deduped, at most six. */
function cleanIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && /^[a-z]+:[A-Za-z0-9^.+:-]+$/.test(x)))].slice(0, MAX_SERIES_IDS)
}
function cleanWin(v: unknown): Win {
  if (typeof v !== 'object' || v === null) return {}
  const r = v as Record<string, unknown>
  const m = (x: unknown) => (typeof x === 'string' && /^\d{4}-\d{2}$/.test(x) ? x : undefined)
  const from = m(r.from)
  const to = m(r.to)
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) }
}
const stripView = (v: ChartView): ViewInput => ({
  id: v.id,
  name: v.name,
  ids: v.ids,
  mode: v.mode,
  ...(v.from ? { from: v.from } : {}),
  ...(v.to ? { to: v.to } : {}),
})

/** Money reads in whole dollars from $10,000, with cents below (a share price keeps its cents). */
const money = (c: number, sign = false, dollars = Math.abs(c) >= 10_000_00) => (dollars ? formatDollars(c, { sign }) : formatCents(c, { sign }))

/**
 * Compare (plan §C7): overlay up to six of anything Scarab tracks — net worth
 * and its parts, accounts, holdings, prices, benchmarks, property, cash flow,
 * the goal fund — on one chart with one axis. Modes: Value (one unit only),
 * Rebased = 100, % change, and A − B for two dollar series; a selection that
 * mixes units is shown rebased, with a one-line hint. Below the chart, each
 * series' start, end and change over what's in view, plus CAGR and max
 * drawdown once that spans a year. Performance (amendment 4) overlays
 * time-weighted returns against a benchmark.
 *
 * The selection lives in route state (never the URL: series ids name
 * holdings); a saved view is addressed as #/compare?v=<viewId>.
 */
export default function Compare() {
  const { active } = useScreen()
  const route = useScreenRoute()
  const vParam = route.params.v ?? null
  const today = todayLocal()

  const [rawIds, setIds] = useRouteState<string[]>('ids', [])
  const [rawMode, setMode] = useRouteState<CompareMode>('mode', 'value')
  const [rawWin, setWin] = useRouteState<Win>('win', {})
  const ids = useMemo(() => cleanIds(rawIds), [rawIds])
  const idsKey = ids.join(',')
  const want: CompareMode = isMode(rawMode) ? rawMode : 'value'
  const win = useMemo(() => cleanWin(rawWin), [rawWin])

  const [hidden, setHidden] = useState<string[]>([])
  const [chartWin, setChartWin] = useState<{ t0: number; t1: number } | null>(null)
  const [catalog, setCatalog] = useState<CatalogLoad>({ state: 'loading' })
  const [data, setData] = useState<{ key: string; res: SeriesResponse } | null>(null)
  const [loadErr, setLoadErr] = useState<{ key: string; message: string } | null>(null)
  const [views, setViews] = useState<ChartView[] | null>(null)
  const [perfOpen, setPerfOpen] = useState(false)

  /* ---------- loads (each re-runs on a keep-alive reveal: a quiet refresh) ---------- */
  // One request of each at a time: an effect that runs again while its last read is still out (StrictMode's
  // rehearsal, a quick reveal) waits for that one. In a tab the catalog reads the whole market history.
  const catalogBusy = useRef(false)
  const loadCatalog = useCallback(() => {
    if (catalogBusy.current) return
    catalogBusy.current = true
    get<SeriesCatalogResponse>('/api/series/catalog')
      .then((r) => setCatalog({ state: 'ok', entries: r.entries }))
      .catch((e: unknown) =>
        setCatalog((c) =>
          c.state === 'ok'
            ? c
            : {
                state: 'error',
                message: e instanceof Error ? e.message : String(e),
              },
        ),
      )
      .finally(() => (catalogBusy.current = false))
  }, [])
  useEffect(loadCatalog, [loadCatalog])

  const viewsBusy = useRef(false)
  useEffect(() => {
    if (viewsBusy.current) return
    viewsBusy.current = true
    get<ChartView[]>('/api/series/views')
      .then(setViews)
      .catch(() => setViews((v) => v ?? []))
      .finally(() => (viewsBusy.current = false))
  }, [])

  const fetchKey = `${idsKey}|${win.from ?? ''}|${win.to ?? ''}`
  const seq = useRef(0)
  const loadSeries = useCallback(() => {
    if (!idsKey) return
    const n = ++seq.current
    const qs = new URLSearchParams({ ids: idsKey }) // form-encodes '+' in set ids as %2B
    if (win.from) qs.set('from', win.from)
    if (win.to) qs.set('to', win.to)
    get<SeriesResponse>(`/api/series?${qs}`)
      .then((res) => {
        if (n !== seq.current) return
        setData({ key: fetchKey, res })
        setLoadErr(null)
      })
      .catch(
        (e: unknown) =>
          n === seq.current &&
          setLoadErr({
            key: fetchKey,
            message: e instanceof Error ? e.message : String(e),
          }),
      )
  }, [fetchKey, idsKey, win.from, win.to])
  useEffect(loadSeries, [loadSeries])

  /* ---------- a saved view arriving by its address ---------- */
  const applied = useRef<Route | null>(null)
  /** The saved view the selection on screen came from (applied, opened or saved here), for as long as this screen lives. */
  const fromView = useRef<string | null>(null)
  useEffect(() => {
    if (!active || applied.current === route) return
    const act = arrivalAction({ entryHasSelection: Object.hasOwn(route.state, 'ids'), v: vParam, fromView: fromView.current, viewsLoaded: !!views })
    if (act === 'wait') return // a fresh arrival at #/compare?v=…: apply it once the list is here
    applied.current = route
    if (act === 'keep') {
      if (vParam) fromView.current = vParam
      return
    }
    if (act === 'stamp') {
      // Keep-alive: the nav must never throw away what is on screen; a reload of this entry keeps it too.
      if (ids.length > 0) {
        setIds(ids)
        setMode(want)
        setWin(win)
      }
      return
    }
    const v = views!.find((x) => x.id === vParam)
    if (!v) {
      toast.info('That saved view no longer exists.')
      setParams({ v: null })
      return
    }
    fromView.current = vParam
    setIds(v.ids)
    setMode(v.mode)
    setWin(cleanWin(v))
  }, [active, vParam, views, route, ids, want, win, setIds, setMode, setWin])

  /* ---------- derived ---------- */
  const entries = catalog.state === 'ok' ? catalog.entries : null
  const metaOf = useMemo(() => new Map((entries ?? []).map((e) => [e.id, e])), [entries])
  const got = useMemo(() => new Map<string, Series>((data?.res.series ?? []).map((s) => [s.id, s])), [data])
  const slots = useMemo(() => slotsFor(idsKey ? idsKey.split(',') : []), [idsKey])
  const units = ids.flatMap((id) => {
    const u = got.get(id)?.unit ?? metaOf.get(id)?.unit
    return u ? [u] : []
  })
  const eff = effectiveMode(want, units)
  const avail = modeAvailability(units)
  const labelOf = useCallback(
    (id: string) => got.get(id)?.label ?? metaOf.get(id)?.label ?? setLabel(id, (x) => metaOf.get(x)?.label) ?? id,
    [got, metaOf],
  )
  const warnings = data?.res.warnings ?? []
  const pending = ids.length > 0 && data?.key !== fetchKey && loadErr?.key !== fetchKey
  const hiddenNow = hidden.filter((id) => ids.includes(id))
  const drawnIds = ids.filter((id) => got.has(id))
  const pair = eff.mode === 'diff' && drawnIds.length === 2 ? [got.get(drawnIds[0]!)!, got.get(drawnIds[1]!)!] : null

  const chartSeries = useMemo((): TSeries[] => {
    if (eff.mode === 'diff') {
      if (!pair) return []
      const [a, b] = pair
      return [
        {
          id: 'diff',
          label: `${a!.label} − ${b!.label}`,
          color: 'var(--ink)',
          points: diff(a!.points, b!.points),
        },
      ]
    }
    // Rebased and % change: every line starts where the last of them begins, so all share one anchor.
    const start =
      eff.mode === 'value' ? null : commonStart(drawnIds.filter((id) => !hiddenNow.includes(id)).map((id) => got.get(id)!.points))
    return drawnIds.map((id) => {
      const s = got.get(id)!
      return {
        id,
        label: seriesLabel(s.label, id, eff.mode),
        slot: slots.get(id),
        hidden: hiddenNow.includes(id),
        points: start ? s.points.filter((p) => p.t >= start) : s.points,
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the inputs' identities below
  }, [eff.mode, got, drawnIds.join(','), hiddenNow.join(','), slots, pair?.[0], pair?.[1]])

  const tooltipExtra = useMemo(() => {
    if (!pair) return undefined
    const [a, b] = pair
    const dollars = wantsDollars([...a!.points, ...b!.points].map((p) => p.v))
    const at = (s: Series, t: string) => {
      let v: number | null = null
      for (const p of s.points) if (p.t <= t) v = p.v
      return v
    }
    return (t: string) => (
      <>
        <TipRow color={slotColor(slots.get(a!.id) ?? null)} mark="line" name={`A · ${a!.label}`} value={fmtMaybe(at(a!, t), dollars)} />
        <TipRow color={slotColor(slots.get(b!.id) ?? null)} mark="line" name={`B · ${b!.label}`} value={fmtMaybe(at(b!, t), dollars)} />
      </>
    )
  }, [pair, slots])

  // What's in view, for the stats row.
  const stats: SeriesStat[] = useMemo(() => {
    if (eff.mode === 'diff') {
      const s = chartSeries[0]
      return s
        ? [
            seriesStats(
              {
                id: s.id,
                label: s.label,
                unit: 'cents',
                kind: 'level',
                points: s.points,
              },
              chartWin,
              today,
              { growth: false },
            ),
          ]
        : []
    }
    return drawnIds
      .filter((id) => !hiddenNow.includes(id))
      .map((id) => {
        const s = got.get(id)!
        return seriesStats({ ...s, label: seriesLabel(s.label, id, eff.mode) }, chartWin, today)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eff.mode, chartSeries, chartWin, today, got, drawnIds.join(','), hiddenNow.join(',')])

  /* ---------- editing the selection ---------- */
  const setSelection = (next: string[]) => setIds(cleanIds(next))
  const toggleId = (id: string) => setSelection(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])
  const toggleHidden = (id: string) => {
    if (hiddenNow.includes(id)) setHidden(hiddenNow.filter((x) => x !== id))
    else if (drawnIds.filter((x) => !hiddenNow.includes(x)).length > 1) setHidden([...hiddenNow, id]) // never hide the last line
  }
  /** A fresh selection (a preset or quick start): a new, unsaved view. */
  const startFresh = (next: string[], mode: CompareMode) => {
    setHidden([])
    if (vParam) navigate({ screen: 'compare' }, { state: { ids: next, mode, win: {} } })
    else {
      setSelection(next)
      setMode(mode)
      setWin({})
    }
  }

  /* ---------- saved views ---------- */
  const currentView = vParam && views ? (views.find((v) => v.id === vParam) ?? null) : null
  const selection = { ids, mode: eff.mode, ...win }
  const edited = currentView ? !sameSelection(viewSelection(currentView), selection) : false
  const saveViews = useAction(
    async (next: ViewInput[], msg: string) => ({
      list: await put<ChartView[]>('/api/series/views', next),
      msg,
    }),
    {
      success: (r) => r.msg,
      errorPrefix: 'Couldn’t save the view',
      onDone: (r) => setViews(r.list),
    },
  )
  const span = useMemo(() => {
    let t0 = Infinity
    let t1 = -Infinity
    for (const s of chartSeries)
      for (const p of s.points) {
        const t = parseT(p.t, today)
        if (p.v !== null && Number.isFinite(t)) {
          t0 = Math.min(t0, t)
          t1 = Math.max(t1, t)
        }
      }
    return t0 <= t1 ? { t0, t1 } : null
  }, [chartSeries, today])

  const openView = (v: ChartView) => {
    const state = { ids: v.ids, mode: v.mode, win: cleanWin(v) }
    setHidden([])
    if (ROUTE_SAFE_VIEW_ID.test(v.id)) navigate({ screen: 'compare', params: { v: v.id } }, { state })
    else {
      // Saved elsewhere under an id the address can't carry: open it without one.
      navigate({ screen: 'compare' }, { state })
    }
  }
  const saveAs = async () => {
    const r = await prompt<{ name: string }>({
      title: 'Save this view',
      body: 'Saved views are shared with everyone in the household.',
      fields: [
        {
          key: 'name',
          kind: 'text',
          label: 'Name',
          initial: suggestName(ids, labelOf),
          maxLength: 80,
        },
      ],
      submitLabel: 'Save view',
    })
    if (!r) return
    const w = viewWindow(chartWin, span, win)
    const view: ViewInput = {
      id: newViewId(),
      name: r.name,
      ids,
      mode: eff.mode,
      ...w,
    }
    const done = await saveViews.run([...(views ?? []).map(stripView), view], `Saved “${r.name}”`)
    if (done) navigate({ screen: 'compare', params: { v: view.id } }, { state: { ids, mode: eff.mode, win: w } })
  }
  const saveChanges = async () => {
    if (!currentView || !views) return
    const w = viewWindow(chartWin, span, win)
    const next = views.map((v) =>
      v.id === currentView.id ? { ...stripView(v), ids, mode: eff.mode, from: w.from, to: w.to } : stripView(v),
    )
    const done = await saveViews.run(next, `Updated “${currentView.name}”`)
    if (done) setWin(w)
  }
  const rename = async () => {
    if (!currentView || !views) return
    const r = await prompt<{ name: string }>({
      title: 'Rename view',
      fields: [
        {
          key: 'name',
          kind: 'text',
          label: 'Name',
          initial: currentView.name,
          maxLength: 80,
        },
      ],
      submitLabel: 'Rename',
    })
    if (!r || r.name === currentView.name) return
    await saveViews.run(
      views.map((v) => (v.id === currentView.id ? { ...stripView(v), name: r.name } : stripView(v))),
      `Renamed to “${r.name}”`,
    )
  }
  const remove = async () => {
    if (!currentView || !views) return
    const ok = await confirm({
      title: `Delete “${currentView.name}”?`,
      body: 'The view is removed for everyone in the household. The series themselves are untouched.',
      confirmLabel: 'Delete view',
      danger: true,
    })
    if (!ok) return
    const done = await saveViews.run(views.filter((v) => v.id !== currentView.id).map(stripView), `Deleted “${currentView.name}”`)
    if (done) setParams({ v: null })
  }

  const menuItems: MenuItem[] = [
    ...(views && views.length
      ? views.map((v): MenuItem => ({
          label: v.id === vParam ? `✓ ${v.name}` : v.name,
          hint: `${v.ids.length} series · ${MODE_LABEL[v.mode]}`,
          onSelect: () => openView(v),
        }))
      : [
          {
            label: views ? 'No saved views yet' : 'Loading…',
            onSelect: () => {},
            disabled: true,
          },
        ]),
    ...(currentView
      ? ([
          'sep',
          ...(edited
            ? [
                {
                  label: `Save changes to “${currentView.name}”`,
                  onSelect: () => void saveChanges(),
                },
              ]
            : []),
          { label: 'Rename…', onSelect: () => void rename() },
          { label: 'Delete…', danger: true, onSelect: () => void remove() },
        ] as MenuItem[])
      : []),
  ]

  /* ---------- render ---------- */
  const header = (
    <HeaderSlot
      sub={
        currentView ? (
          <>
            {currentView.name}
            {edited && <span className="ch-cmp-edited"> · edited</span>}
          </>
        ) : (
          'Overlay anything Scarab tracks on one chart'
        )
      }
      actions={
        <>
          <Button onClick={() => setPerfOpen(true)}>Performance…</Button>
          <Menu label="Saved views" trigger="Views" items={menuItems} align="end" />
          <Button busy={saveViews.busy} disabled={ids.length === 0} onClick={() => void saveAs()}>
            Save view…
          </Button>
        </>
      }
    />
  )
  const perf = (
    <PerformanceDialog
      open={perfOpen}
      onClose={() => setPerfOpen(false)}
      catalog={entries}
      onApply={(next) => startFresh(next, 'rebased')}
    />
  )

  const picker = (
    <SeriesPicker
      catalog={entries}
      error={catalog.state === 'error' ? catalog.message : null}
      onRetry={loadCatalog}
      selected={ids}
      slots={slots}
      onToggle={toggleId}
    />
  )

  // The current selection failed to load (an older reply may still be in `data`): say so rather than show stale lines.
  const fetchFailed = loadErr?.key === fetchKey
  const perId = ids.map((id) => ({ id, ws: warningsFor(id, warnings) }))
  const loose = warnings.filter((w) => !ids.some((id) => warningsFor(id, [w]).length))

  /** A quick start is disabled, saying why, when the catalog says its series have nothing to draw yet. */
  const quickState = (want: string[]) => {
    const off = want.map((id) => metaOf.get(id)).find((m) => m && !m.available)
    return off ? { disabled: true, title: off.reason } : {}
  }

  // The mode picker shares the chart's header row with the range presets.
  const modesNode = (
    <div className="ch-cmp-modes">
      <Segmented<CompareMode>
        aria-label="Show as"
        value={eff.mode}
        onChange={setMode}
        options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m], disabled: !avail[m].ok, title: avail[m].why }))}
      />
    </div>
  )

  // One tree for both states, so the picker stays open while the first series goes in.
  return (
    <>
      {header}
      {perf}
      <div className="grid12">
        <div className="card c12 ch-cmp">
          <div className="ch-cmp-bar">
            {ids.length > 0 && (
              <ul className="ch-chips" aria-label="Series in the chart">
                {ids.map((id, i) => {
                  const slot = slots.get(id) ?? null
                  const off = hiddenNow.includes(id)
                  const ws = warningsFor(id, warnings)
                  const label = seriesLabel(labelOf(id), id, eff.mode)
                  const badge = eff.mode === 'diff' ? (i === 0 ? 'A' : i === 1 ? 'B' : null) : null
                  return (
                    <li key={id} className={`ch-chip${off ? ' off' : ''}${ws.length ? ' warn' : ''}`}>
                      <button
                        type="button"
                        className="ch-chip-t"
                        aria-pressed={eff.mode === 'diff' ? undefined : !off}
                        disabled={eff.mode === 'diff'}
                        title={
                          ws.length ? ws.map((w) => warningText(id, w)).join(' ') : eff.mode === 'diff' ? label : `${off ? 'Show' : 'Hide'} ${label}`
                        }
                        onClick={() => toggleHidden(id)}
                      >
                        <Swatch color={slotColor(slot)} mark="line" />
                        {badge && <b className="ch-chip-ab">{badge}</b>}
                        <span className="ch-chip-l">{label}</span>
                        {ws.length > 0 && (
                          <span className="ch-chip-warn" aria-label="has a note">
                            !
                          </span>
                        )}
                      </button>
                      <button type="button" className="ch-chip-x" aria-label={`Remove ${label}`} onClick={() => toggleId(id)}>
                        ×
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {picker}
            {eff.mode === 'diff' && ids.length === 2 && (
              <Button size="mini" variant="ghost" onClick={() => setSelection([ids[1]!, ids[0]!])} title="Swap A and B">
                ⇄ Swap
              </Button>
            )}
            {ids.length > 0 && fetchFailed && modesNode}
          </div>

          {ids.length === 0 ? (
            <EmptyState
              title="Pick something to compare"
              body={
                <>
                  <p>
                    Net worth and its parts, an account, a holding, the house, the goal fund or a market benchmark — up to six at once, as
                    values, rebased to 100, or % change.
                  </p>
                  <div className="ch-cmp-quick">
                    <Button size="mini" {...quickState(['nw:total'])} onClick={() => startFresh(['nw:total'], 'value')}>
                      Net worth
                    </Button>
                    <Button
                      size="mini"
                      {...quickState(['inv:all:value', 'inv:all:cost'])}
                      onClick={() => startFresh(['inv:all:value', 'inv:all:cost'], 'value')}
                    >
                      Portfolio vs. cost basis
                    </Button>
                    <Button size="mini" onClick={() => setPerfOpen(true)}>
                      Performance vs. a benchmark…
                    </Button>
                  </div>
                </>
              }
            />
          ) : (
            <>
              {eff.hint && <p className="ch-note ch-cmp-hint">{eff.hint}</p>}
              {(win.from || win.to) && (
                <p className="ch-note ch-cmp-win">
                  Showing {win.from ? monthLong(win.from) : 'the start'} – {win.to ? monthLong(win.to) : 'now'}, as saved.{' '}
                  <Button size="mini" variant="ghost" onClick={() => setWin({})}>
                    Show all
                  </Button>
                </p>
              )}
              {fetchFailed ? (
                <div className="ch-empty">
                  <p className="ch-hint">Couldn’t load these series: {loadErr!.message}</p>
                  <Button size="mini" onClick={loadSeries}>
                    Retry
                  </Button>
                </div>
              ) : (
                <TimeChart
                  ariaLabel={`Compare: ${chartSeries.map((x) => x.label).join(', ') || 'loading'}`}
                  height={300}
                  series={chartSeries}
                  unit="cents"
                  transform={eff.mode === 'rebased' ? 'rebased' : eff.mode === 'pct' ? 'pct' : 'value'}
                  legend="none"
                  actions={modesNode}
                  onWindow={setChartWin}
                  pending={pending}
                  tooltipExtra={tooltipExtra}
                />
              )}
              {(perId.some((x) => x.ws.length) || loose.length > 0) && (
                <ul className="ch-cmp-warn">
                  {perId.flatMap((x) => x.ws.map((w, k) => <li key={`${x.id}${k}`}>{`${labelOf(x.id)}: ${warningText(x.id, w)}`}</li>))}
                  {loose.map((w, k) => (
                    <li key={`l${k}`}>{w}</li>
                  ))}
                </ul>
              )}
              {stats.length > 0 && !fetchFailed && <StatsTable stats={stats} slots={slots} diffMode={eff.mode === 'diff'} pending={pending} />}
            </>
          )}
        </div>
      </div>
    </>
  )
}

const fmtMaybe = (v: number | null, dollars: boolean) => (v === null ? '—' : money(v, false, dollars))

function cell(v: number, unit: SeriesStat['unit'], base: number | null, dollars: boolean): string {
  if (unit === 'index_micro') {
    const r = base !== null ? indexedEnds(base, v) : null
    return r ? fmtIndex(r.end) : '—'
  }
  return money(v, false, dollars)
}

/**
 * Start, end and change of each series over what the chart shows; CAGR and
 * max drawdown once that spans 12 months (a shorter window would overstate
 * them). An index (a return, a benchmark) reads on a 100 base at its start.
 */
function StatsTable({
  stats,
  slots,
  diffMode,
  pending,
}: {
  stats: SeriesStat[]
  slots: ReadonlyMap<string, Slot>
  diffMode: boolean
  pending: boolean
}) {
  const anyFlow = stats.some((s) => s.kind === 'flow')
  const short = stats.every((s) => s.months < 12)
  return (
    <div className={`ch-cmp-stats${pending ? ' is-pending' : ''}`} aria-busy={pending || undefined}>
      <table>
        <caption className="ui-sr">Start, end and change of each series in view</caption>
        <thead>
          <tr>
            <th>Series</th>
            <th className="r">Start</th>
            <th className="r">End</th>
            <th className="r">Change</th>
            {!diffMode && <th className="r">CAGR</th>}
            {!diffMode && <th className="r">Max drawdown</th>}
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => {
            const color = s.id === 'diff' ? 'var(--ink)' : slotColor(slots.get(s.id) ?? null)
            // One format per row: whole dollars when any of its figures reaches $10,000.
            const d = [s.start?.v, s.end?.v, s.change, s.total].some((v) => typeof v === 'number' && Math.abs(v) >= 10_000_00)
            const base = s.unit === 'index_micro' && s.start ? s.start.v : null
            let change: ReactNode = '—'
            if (s.kind === 'flow' && s.total !== null)
              change = (
                <>
                  {money(s.total, false, d)} total
                  {s.average !== null && <small>{money(s.average, false, d)}/mo</small>}
                </>
              )
            else if (s.change !== null) {
              const c = s.change
              change = (
                // A difference moving isn't a gain or a loss: neutral ink.
                <span style={diffMode ? undefined : { color: signColor(c) }}>
                  {s.unit === 'index_micro' ? (s.changeMicro !== null ? fmtPctMicro(s.changeMicro, { sign: true }) : '—') : money(c, true, d)}
                  {s.unit !== 'index_micro' && s.changeMicro !== null && !diffMode && <small>{fmtPctMicro(s.changeMicro, { sign: true })}</small>}
                </span>
              )
            }
            return (
              <tr key={s.id}>
                <td>
                  <span className="ch-cmp-sname">
                    <Swatch color={color} mark="line" />
                    {s.label}
                  </span>
                </td>
                <td className="r num">
                  {s.start ? (
                    <>
                      {s.unit === 'index_micro' ? '100.0' : money(s.start.v, false, d)}
                      <small>{monthLong(s.start.t)}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="r num">
                  {s.end ? (
                    <>
                      {cell(s.end.v, s.unit, base, d)}
                      <small>{s.months > 0 ? `${monthLong(s.end.t)} · ${spanText(s.months)}` : monthLong(s.end.t)}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="r num">{change}</td>
                {!diffMode && (
                  <td className="r num" title={s.cagrMicro === null && s.kind !== 'flow' ? 'Needs at least 12 months in view' : undefined}>
                    {s.cagrMicro !== null ? `${fmtPctMicro(s.cagrMicro, { sign: true })}/yr` : '—'}
                  </td>
                )}
                {!diffMode && (
                  <td className="r num" title={s.drawdown === null && s.kind !== 'flow' ? 'Needs at least 12 months in view' : undefined}>
                    {s.drawdown ? (
                      s.drawdown.micro === 0 ? (
                        'none'
                      ) : (
                        <>
                          −{fmtPctMicro(s.drawdown.micro)}
                          <small>
                            {monthLong(s.drawdown.peakT)} → {monthLong(s.drawdown.troughT)}
                          </small>
                        </>
                      )
                    ) : (
                      '—'
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
      {!diffMode && short && !anyFlow && <p className="ch-note">CAGR and max drawdown appear once at least 12 months are in view.</p>}
    </div>
  )
}
