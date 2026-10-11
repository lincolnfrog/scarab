import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { formatCents, formatPercentMicro } from '../../shared/money'
import type { ScenarioParams, ScenarioRun, TaxContext } from '../../engine/scenarios'
import type { SimEvent, WithdrawalOrder } from '../../engine/simulate'
import { del, post, put, serverWriteCount } from '../api'
import FutureFan from '../cards/FutureFan'
import { scenarioSlots, slotColor } from '../chart/palette'
import { localMode } from '../local'
import { Link } from '../router'
import { Button } from '../ui/Button'
import { useDeepAction } from '../ui/CommandPalette'
import { DetailView, DrillCard, DrillMore, MiniRows, Stats, useDetail, type StatItem } from '../ui/Drill'
import { confirm, prompt } from '../ui/dialogs'
import { Field, MoneyInput, PercentInput, Select, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import { fmtShort } from '../viz'
import { assumptionSummary, compareKey, createFlushable, createLatest, dataVersionOf, editGeneration, parseThreshold, saveStatus } from './future-sync'
import './screens.css'
import './future-overview.css'

/**
 * Future — the decision engine. Named scenarios (knob-sets) run side by side
 * against today's ledger; one is the baseline the rest are measured against.
 * The headline is the crossing date: the earliest retirement year the plan
 * clears the odds threshold.
 */

type Params = ScenarioParams
type Run = ScenarioRun
type Compare = {
  balance: { cash: number; brokerage: number; retirement: number; crypto: number; property: number; liabilities: number; total: number } | null
  home: { priceCents: number; cashOutCents: number; rateMicro: number; termMonths: number; loanName: string | null } | null
  draw: Draw
  thresholdPct: number
  /** Future v3: the buckets, savings split, filing and people the tax model ran with. */
  tax: TaxContext
  /** The oldest birth year in the household: the age axis. */
  birthYear: number | null
  runs: Run[]
}
type Price = {
  successBeforePct: number
  successAfterPct: number
  medianEndBeforeCents: number
  medianEndAfterCents: number
  futureValueCents: number
  atYear: number
}

/**
 * The knobs as the inputs hold them: money in integer cents and rates in
 * integer micro, exactly what the inputs emit — never a float re-parsed on
 * save. Null is a field left empty (or not yet readable): it keeps the saved
 * value rather than sending 0. Years stay text until they parse.
 */
type Knobs = {
  meanReturnMicro: number | null
  volMicro: number | null
  propertyGrowthMicro: number | null
  saveBeforeBuyCents: number | null
  saveAfterBuyCents: number | null
  buyEnabled: boolean
  buyYear: string
  retireYear: string
  retireSpendCents: number | null
  endYear: string
  // Future v3 (copilot §4c)
  taxModel: boolean
  withdrawalOrder: WithdrawalOrder
  fillBracketMicro: number
  hsaAsRoth: boolean
  advisorFeeMicro: number | null
  convOn: boolean
  convFrom: string
  convTo: string
  convMode: 'amount' | 'fill'
  convAmountCents: number | null
  convFillMicro: number
  /** One row per person in the household (and any saved under another name). */
  ss: { name: string; fraBenefitCents: number | null; claimAge: number }[]
}

/** The federal bracket rates a "fill the bracket" knob can name (the top one has no top). */
const BRACKETS: { micro: number; label: string }[] = [100_000, 120_000, 220_000, 240_000, 320_000, 350_000].map((m) => ({ micro: m, label: `${m / 10_000}%` }))
const ORDER_LABEL: Record<WithdrawalOrder, string> = {
  'taxable-first': 'taxable, then traditional, then Roth',
  'pro-rata': 'from every bucket in proportion',
  'fill-bracket': 'traditional up to a bracket, then taxable, then Roth',
}

function toKnobs(p: Params, people: readonly { name: string }[] = []): Knobs {
  const c = p.conversion
  const names = [...people.map((x) => x.name)]
  for (const x of p.socialSecurity) if (!names.some((n) => n.toLowerCase() === x.name.toLowerCase())) names.push(x.name)
  const yr = Number(new Date().getFullYear())
  return {
    meanReturnMicro: p.meanReturnMicro,
    volMicro: p.volMicro,
    propertyGrowthMicro: p.propertyGrowthMicro,
    saveBeforeBuyCents: p.saveBeforeBuyCents,
    saveAfterBuyCents: p.saveAfterBuyCents,
    buyEnabled: p.buyEnabled,
    buyYear: String(p.buyYear),
    retireYear: String(p.retireYear),
    retireSpendCents: p.retireSpendCents,
    endYear: String(p.endYear),
    taxModel: p.taxModel,
    withdrawalOrder: p.withdrawalOrder,
    fillBracketMicro: p.fillBracketMicro,
    hsaAsRoth: p.hsaAsRoth,
    advisorFeeMicro: p.advisorFeeMicro,
    convOn: c !== null,
    convFrom: String(c?.fromYear ?? p.retireYear + 1),
    convTo: String(c?.toYear ?? Math.max(p.retireYear + 1, yr) + 9),
    convMode: c?.fillBracketMicro != null ? 'fill' : 'amount',
    convAmountCents: c?.amountCents ?? 5_000_000,
    convFillMicro: c?.fillBracketMicro ?? 220_000,
    ss: names.map((name) => {
      const x = p.socialSecurity.find((e) => e.name.toLowerCase() === name.toLowerCase())
      return { name, fraBenefitCents: x?.fraBenefitCents ?? null, claimAge: x?.claimAge ?? 67 }
    }),
  }
}
function fromKnobs(k: Knobs, prev: Params): Omit<Params, 'events'> {
  const yr = (s: string, fallback: number) => {
    const n = Number(s)
    return Number.isInteger(n) && n > 1900 && n < 2300 ? n : fallback
  }
  const { events: _events, ...rest } = prev
  return {
    ...rest,
    meanReturnMicro: k.meanReturnMicro ?? prev.meanReturnMicro,
    volMicro: Math.max(0, k.volMicro ?? prev.volMicro),
    propertyGrowthMicro: k.propertyGrowthMicro ?? prev.propertyGrowthMicro,
    saveBeforeBuyCents: Math.max(0, k.saveBeforeBuyCents ?? prev.saveBeforeBuyCents),
    saveAfterBuyCents: Math.max(0, k.saveAfterBuyCents ?? prev.saveAfterBuyCents),
    buyEnabled: k.buyEnabled,
    buyYear: yr(k.buyYear, prev.buyYear),
    retireYear: yr(k.retireYear, prev.retireYear),
    retireSpendCents: Math.max(0, k.retireSpendCents ?? prev.retireSpendCents),
    endYear: yr(k.endYear, prev.endYear),
    taxModel: k.taxModel,
    withdrawalOrder: k.withdrawalOrder,
    fillBracketMicro: k.fillBracketMicro,
    hsaAsRoth: k.hsaAsRoth,
    advisorFeeMicro: Math.min(50_000, Math.max(0, k.advisorFeeMicro ?? prev.advisorFeeMicro)),
    conversion: (() => {
      if (!k.convOn) return null
      const from = yr(k.convFrom, NaN)
      const to = yr(k.convTo, NaN)
      // Years still being typed, or an amount left empty: keep what was saved rather than send half a conversion.
      if (!Number.isInteger(from) || !Number.isInteger(to) || to < from) return prev.conversion
      if (k.convMode === 'amount') return k.convAmountCents ? { fromYear: from, toYear: to, amountCents: k.convAmountCents, fillBracketMicro: null } : prev.conversion
      return { fromYear: from, toYear: to, amountCents: null, fillBracketMicro: k.convFillMicro }
    })(),
    socialSecurity: k.ss.filter((x) => (x.fraBenefitCents ?? 0) > 0).map((x) => ({ name: x.name, fraBenefitCents: x.fraBenefitCents!, claimAge: x.claimAge })),
  }
}

/** "Price a decision": a one-off (or yearly) outlay, in cents. */
type Decision = { label: string; amountCents: number | null; year: string; until: string }

type Draw = 'lognormal' | 'historical'
const DRAWS: { value: Draw; label: string }[] = [
  { value: 'lognormal', label: 'Lognormal' },
  { value: 'historical', label: 'Historical sequences' },
]
const THRESHOLD_DEFAULT = 90
const KNOB_DEBOUNCE_MS = 500
const THRESHOLD_DEBOUNCE_MS = 400

/**
 * The ledger version a compare result was computed at. Exact in a tab session: localMode.dataRevision moves on
 * every change to the tab's database — writes, data swaps, and a price refresh too, which stores quotes the
 * simulations read (holdings at their latest price) without leaving unsaved work. On the household server, this
 * tab's own writes (api.ts serverWriteCount, a price refresh included): the other member's land unseen until
 * something here writes or the page reloads.
 */
const dataVersion = (): string =>
  dataVersionOf(
    localMode.active
      ? { session: true, revision: localMode.dataRevision }
      : { session: false, serverWrites: serverWriteCount() },
  )

/** A knob save: the knobs over the scenario's newest params, or null when that changes nothing. */
const knobParams = (k: Knobs) => (cur: Params): Params | null => {
  const next = { ...cur, ...fromKnobs(k, cur) }
  return JSON.stringify(next) === JSON.stringify(cur) ? null : next
}

const signed = (n: number, unit = '') => (n > 0 ? `+${n}${unit}` : n < 0 ? `${n}${unit}` : `±0${unit}`)
const signedMoney = (c: number) => (c === 0 ? '±0' : (c > 0 ? '+' : '−') + fmtShort(Math.abs(c)))
const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted')
const HEADER_SUB = '2,000 simulated futures, in today’s dollars'

/**
 * The detail views behind the overview: the knobs (and the scenario's own controls), the selected scenario's full
 * result, the side-by-side table ('#/future/compare', the ⌘K palette's "Compare scenarios"), decisions and events,
 * and how to read it all.
 */
const DETAILS = ['assumptions', 'results', 'compare', 'events', 'guide'] as const
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export default function Future() {
  const detail = useDetail(DETAILS)
  const [cmp, setCmp] = useState<Compare | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [draw, setDraw] = useState<Draw>('lognormal')
  /** The odds threshold as typed, and the committed number the simulations run with (never '' or a partial). */
  const [thresholdText, setThresholdText] = useState(String(THRESHOLD_DEFAULT))
  const [thresholdPct, setThresholdPct] = useState(THRESHOLD_DEFAULT)
  const thresholdId = useId()
  const [knobs, setKnobsState] = useState<Knobs | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [decision, setDecision] = useState<Decision>({ label: '', amountCents: 8_000_000, year: '', until: '' })
  /** A priced decision, tagged with the scenario it was priced against so a late reply can't show under another. */
  const [priced, setPriced] = useState<{ scenarioId: number; price: Price } | null>(null)

  // Bookkeeping that lives across renders without causing them (see future-sync.ts).
  const [edits] = useState(editGeneration)
  const [latest] = useState(createLatest)
  const [knobDebounce] = useState(() => createFlushable(KNOB_DEBOUNCE_MS))
  const [thresholdDebounce] = useState(() => createFlushable(THRESHOLD_DEBOUNCE_MS))
  const editSnap = useSyncExternalStore(edits.subscribe, edits.snapshot)
  /** The knobs as last set (state lags a render behind; edits build on this). */
  const knobsRef = useRef<Knobs | null>(null)
  /** Which scenario the knobs on screen belong to. */
  const knobsFor = useRef<number | null>(null)
  /** Newest params the server holds per scenario: the latest compare, then each save as it lands. Saves build on these. */
  const known = useRef(new Map<number, Params>())
  /** Saves go out one at a time, in order. */
  const saveChain = useRef<Promise<unknown>>(Promise.resolve())
  /** What the result on screen (or on its way) was computed from; see compareKey. */
  const cacheKey = useRef<string | null>(null)
  /** The draw|threshold of the compare on its way, if any. */
  const inflight = useRef<string | null>(null)
  const hasData = useRef(false)

  const setKnobs = (k: Knobs | null) => {
    knobsRef.current = k
    setKnobsState(k)
  }

  /** Re-run every scenario. `prefer` selects that one once the results include it (a scenario just created). */
  const compare = useCallback(
    async (prefer?: number) => {
      const tag = latest.next()
      cacheKey.current = compareKey(draw, thresholdPct, dataVersion())
      inflight.current = `${draw}|${thresholdPct}`
      setBusy(true)
      try {
        const r = await post<Compare>('/api/scenarios/compare', { draw, thresholdPct })
        if (!latest.isCurrent(tag)) return // a newer compare is on its way; this reply is stale
        known.current = new Map(r.runs.map((x) => [x.id, x.params]))
        hasData.current = true
        setCmp(r)
        setErr(null)
        const has = (id: number | null | undefined): id is number => id != null && r.runs.some((x) => x.id === id)
        setSelected((s) => (has(prefer) ? prefer : has(s) ? s : ((r.runs.find((x) => x.isBaseline) ?? r.runs[0])?.id ?? null)))
      } catch (e) {
        if (!latest.isCurrent(tag)) return
        cacheKey.current = null // nothing cached: the next reveal tries again
        // Before the first result the page shows the failure in place; after it, a toast (the last result stays up).
        if (hasData.current) toast.error("Couldn't re-run the scenarios", { detail: errText(e) })
        else setErr(errText(e))
      } finally {
        if (latest.isCurrent(tag)) {
          setBusy(false)
          inflight.current = null
        }
      }
    },
    [draw, thresholdPct, latest],
  )

  // Keep-alive: revealing the screen runs this again. When nothing the simulations read has changed, the result on
  // screen stands — exact in a tab session (its data revision); on the household server, as far as this tab can
  // tell (its own writes, a price refresh included — the other member's aren't seen). A compare for the same inputs
  // already on its way is left to land rather than superseded (StrictMode's double effect, a reveal mid-run); saves
  // call compare() directly, since a run started before them is stale.
  useEffect(() => {
    if (inflight.current === `${draw}|${thresholdPct}`) return
    const key = compareKey(draw, thresholdPct, dataVersion())
    if (key !== null && key === cacheKey.current) return
    void compare()
  }, [compare, draw, thresholdPct])

  const run = cmp?.runs.find((r) => r.id === selected) ?? null
  const base = cmp?.runs.find((r) => r.isBaseline) ?? cmp?.runs[0] ?? null

  // A scenario's knobs fill the form when it's selected, and again with each new result — unless an edit to it is
  // still waiting on a save, which a result computed before that save must not revert.
  useEffect(() => {
    if (!run) return
    if (knobsFor.current === run.id && edits.dirty) return
    knobsFor.current = run.id
    setKnobs(toKnobs(run.params, cmp?.tax.people))
  }, [run, edits, cmp])

  // Every write goes through useAction: failures toast, and the scenarios re-run after a save lands.
  const saveParams = useAction(
    async (id: number, params: Params, receipt: string, gen: number) => {
      await put(`/api/scenarios/${id}`, { params })
      return { id, params, receipt, gen }
    },
    {
      success: (r) => r.receipt, // autosaves pass none: the "saved" marker is their receipt
      errorPrefix: "Couldn't save the scenario",
      onDone: (r) => {
        known.current.set(r.id, r.params)
        if (r.gen) edits.ack(r.gen)
        void compare()
      },
    },
  )
  const sendSave = saveParams.run

  /**
   * Queue a save of scenario `id`. `build` runs when its turn comes, on the newest params known for it, so a knob
   * save can't drop an event added just before it and saves land in the order they were made. Returns null when
   * there was nothing to change, or the save failed (useAction has toasted).
   */
  const enqueueSave = useCallback(
    (id: number, build: (base: Params) => Params | null, receipt = '', gen = 0) => {
      const job = saveChain.current.then(async () => {
        const cur = known.current.get(id)
        const params = cur ? build(cur) : null
        if (!params) {
          if (gen) edits.ack(gen) // nothing to change (a blank or partial field), or the scenario is gone
          return null
        }
        const r = await sendSave(id, params, receipt, gen)
        if (r === undefined && gen) edits.fail(gen)
        return r ?? null
      })
      saveChain.current = job
      return job
    },
    [edits, sendSave],
  )

  /** Resolves once every save queued so far has settled. */
  const afterSaves = () => saveChain.current.then(() => undefined)

  const editKnob = (patch: Partial<Knobs>) => {
    const id = knobsFor.current
    const cur = knobsRef.current
    if (id === null || !cur) return
    const next = { ...cur, ...patch }
    setKnobs(next)
    const gen = edits.edit()
    // The save is bound to this scenario now, so a flush after switching still lands where the edit was made.
    knobDebounce.schedule(() => void enqueueSave(id, knobParams(next), '', gen))
  }

  // Keep-alive: leaving the screen hides it and runs every cleanup. A knob edit or threshold still waiting on its
  // debounce is committed then, not dropped.
  useEffect(
    () => () => {
      knobDebounce.flush()
      thresholdDebounce.flush()
    },
    [knobDebounce, thresholdDebounce],
  )

  /** Set the waiting knob edit aside after saving it: the form moves on to another scenario. */
  const leaveEdits = () => {
    knobDebounce.flush()
    edits.discard()
  }
  const selectRun = (id: number) => {
    leaveEdits() // the edit belongs to the scenario being left, and is saved there
    setSelected(id)
  }

  /* ---- the odds threshold: commits on a 400ms pause, blur or Enter; never '' or a partial number ---- */
  const typeThreshold = (text: string) => {
    setThresholdText(text)
    thresholdDebounce.schedule(() => {
      const t = parseThreshold(text)
      if (t !== null) setThresholdPct(t)
    })
  }
  const settleThreshold = () => {
    thresholdDebounce.cancel()
    const t = parseThreshold(thresholdText)
    if (t !== null) setThresholdPct(t)
    setThresholdText(String(t ?? thresholdPct)) // unreadable text goes back to the threshold in use
  }
  const thresholdBad = parseThreshold(thresholdText) === null

  const createScenario = useAction(
    async (name: string, cloneFromId?: number) => {
      const s = await post<{ id: number }>('/api/scenarios', { name, cloneFromId })
      return { id: s.id, name, cloned: cloneFromId !== undefined }
    },
    {
      success: (r) => (r.cloned ? `Duplicated as “${r.name}”` : `Created “${r.name}”`),
      errorPrefix: "Couldn't create the scenario",
      onDone: (r) => void compare(r.id), // selected when the results arrive, so the page never blanks waiting for them
    },
  )
  const renameScenario = useAction(
    async (id: number, name: string) => {
      await put(`/api/scenarios/${id}`, { name })
      return name
    },
    { success: (name) => `Renamed to “${name}”`, errorPrefix: "Couldn't rename the scenario", onDone: () => void compare() },
  )
  const setBaseline = useAction(
    async (r: Run) => {
      await put(`/api/scenarios/${r.id}`, { isBaseline: true })
      return r.name
    },
    { success: (name) => `“${name}” is the baseline now`, errorPrefix: "Couldn't change the baseline", onDone: () => void compare() },
  )
  const deleteScenario = useAction(
    async (r: Run, next: number | null) => {
      await del(`/api/scenarios/${r.id}`)
      return { name: r.name, next }
    },
    {
      success: (x) => `Deleted “${x.name}”`,
      errorPrefix: "Couldn't delete the scenario",
      onDone: (x) => {
        setSelected(x.next) // a scenario still on screen, so the page doesn't blank while the re-run comes back
        void compare()
      },
    },
  )
  const priceDecision = useAction(
    async (b: { scenarioId: number; event: SimEvent; draw: string }) => ({
      scenarioId: b.scenarioId,
      price: await post<Price>('/api/scenarios/price', b),
    }),
    { errorPrefix: "Couldn't price the decision", onDone: setPriced },
  )

  const addScenario = async (cloneFrom?: Run) => {
    const v = await prompt<{ name: string }>({
      title: cloneFrom ? `Duplicate “${cloneFrom.name}”` : 'New scenario',
      body: cloneFrom ? 'Same knobs and events, under a new name.' : 'Starts from the baseline’s knobs.',
      fields: [{ key: 'name', kind: 'text', label: 'Name', initial: cloneFrom ? `${cloneFrom.name} (copy)` : 'Retire at 60', maxLength: 60 }],
      submitLabel: cloneFrom ? 'Duplicate' : 'Create',
    })
    if (!v) return
    leaveEdits() // saved first, so a duplicate copies them
    void afterSaves().then(() => createScenario.run(v.name, cloneFrom?.id))
  }
  // '#/future?d=new-scenario' (the ⌘K palette): "+ Scenario" on arrival, once the first run has answered.
  useDeepAction(
    'future',
    {
      'new-scenario': () => {
        if (cmp && !cmp.balance) toast.info('Nothing to project yet — the simulation starts from your balance sheet')
        else void addScenario()
      },
    },
    cmp !== null || err !== null,
  )

  const rename = async () => {
    if (!run) return
    const v = await prompt<{ name: string }>({
      title: 'Rename scenario',
      fields: [{ key: 'name', kind: 'text', label: 'Name', initial: run.name, maxLength: 60 }],
      submitLabel: 'Rename',
    })
    if (v && v.name !== run.name) void renameScenario.run(run.id, v.name)
  }
  const makeBaseline = () => {
    if (run) void setBaseline.run(run)
  }
  const remove = async () => {
    if (!run || !cmp || cmp.runs.length <= 1) return
    const ok = await confirm({
      title: `Delete “${run.name}”?`,
      body: `Its knobs${run.params.events.length ? ` and ${run.params.events.length} event${run.params.events.length === 1 ? '' : 's'}` : ''} go with it.`,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (!ok) return
    // An unsaved edit to a scenario being deleted has nowhere to go.
    knobDebounce.cancel()
    edits.discard()
    const others = cmp.runs.filter((x) => x.id !== run.id)
    const next = (others.find((x) => x.isBaseline) ?? others[0])?.id ?? null
    void deleteScenario.run(run, next)
  }

  const decisionEvent = (): SimEvent | null => {
    if (!run) return null
    const amount = decision.amountCents
    const year = Number(decision.year) || run.params.buyYear
    if (!amount || !Number.isInteger(year)) return null
    const until = Number(decision.until)
    const ev: SimEvent = { year, amountCents: -Math.abs(amount) }
    if (Number.isInteger(until) && until > year) ev.untilYear = until
    if (decision.label.trim()) ev.label = decision.label.trim()
    return ev
  }
  const priceIt = () => {
    const ev = decisionEvent()
    if (!run) return
    if (!ev) return toast.error('Enter what it costs and the year it happens')
    void priceDecision.run({ scenarioId: run.id, event: ev, draw })
  }
  const commitDecision = async () => {
    const ev = decisionEvent()
    if (!run || !ev) return
    knobDebounce.flush() // a knob edit made first goes out first
    const done = await enqueueSave(run.id, (b) => ({ ...b, events: [...b.events, ev] }), `Added ${ev.label ?? 'the decision'} to ${run.name}`)
    if (done) setPriced(null)
  }
  const removeEvent = (ev: SimEvent) => {
    if (!run) return
    knobDebounce.flush()
    const key = JSON.stringify(ev)
    void enqueueSave(
      run.id,
      (b) => {
        const i = b.events.findIndex((e) => JSON.stringify(e) === key)
        return i < 0 ? null : { ...b, events: b.events.filter((_, j) => j !== i) }
      },
      `Removed ${ev.label ?? 'the event'} from ${run.name}`,
    )
  }

  if (cmp && !cmp.balance)
    return (
      <div className="card wide">
        <HeaderSlot sub={HEADER_SUB} />
        <h2>Nothing to project yet</h2>
        <p>The simulation starts from your real balance sheet — import accounts and add holdings first.</p>
      </div>
    )
  if (!cmp || !run || !knobs || !base)
    return err ? (
      <div className="card wide" role="alert">
        <HeaderSlot sub={HEADER_SUB} />
        <h2>Couldn't run the scenarios</h2>
        <p className="sub2">{err}</p>
        <Button onClick={() => void compare()}>Retry</Button>
      </div>
    ) : (
      <div className="grid12" aria-busy="true">
        <HeaderSlot sub={HEADER_SUB} />
        <div className="card c12"><Skeleton h={18} w={140} /><Skeleton h={30} style={{ marginTop: 12 }} /></div>
        <div className="card c12"><Skeleton h={18} w={220} /><Skeleton h={56} style={{ marginTop: 12 }} /></div>
        <div className="card c9"><Skeleton h={260} /></div>
        <div className="card c3"><Skeleton h={260} /></div>
      </div>
    )

  const price = priced && priced.scenarioId === run.id ? priced.price : null
  const status = saveStatus(editSnap)

  // Colour follows the scenario, not its place in the list — the same map FutureFan draws with.
  const slots = scenarioSlots(cmp.runs, base.id)
  const colorOf = (id: number) => slotColor(slots.get(id) ?? null)
  const color = colorOf(run.id)
  const endYear = run.result.years[run.result.years.length - 1]

  type MicroKey = 'meanReturnMicro' | 'volMicro' | 'propertyGrowthMicro'
  type CentsKey = 'saveBeforeBuyCents' | 'saveAfterBuyCents' | 'retireSpendCents'
  type YearKey = 'buyYear' | 'retireYear' | 'endYear'
  const rateKnob = (key: MicroKey, label: string, o: { negative?: boolean; hint?: string } = {}) => (
    <div className="scr-f rate" key={key}>
      <Field label={label} hint={o.hint}>
        <PercentInput valueMicro={knobs[key]} allowNegative={o.negative} onChange={(m) => editKnob({ [key]: m })} />
      </Field>
    </div>
  )
  const moneyKnob = (key: CentsKey, label: string) => (
    <div className="scr-f" key={key}>
      <Field label={label}>
        <MoneyInput value={knobs[key]} onChange={(c) => editKnob({ [key]: c })} />
      </Field>
    </div>
  )
  const yearKnob = (key: YearKey, label: string) => (
    <div className="scr-f xs" key={key}>
      <Field label={label}>
        <TextInput inputMode="numeric" maxLength={4} value={knobs[key]} onChange={(e) => editKnob({ [key]: e.target.value })} />
      </Field>
    </div>
  )

  const buys = run.params.buyEnabled && !!cmp.home // no loan options → the engine models no purchase
  const summary = assumptionSummary(run.params, !!cmp.home)

  // "+ Scenario" stays in the header of every view; its prompt is a dialog, so '?d=new-scenario' works on any of them.
  const header = (
    <HeaderSlot
      sub={HEADER_SUB}
      actions={<Button variant="gold" busy={createScenario.busy} onClick={() => void addScenario()}>+ Scenario</Button>}
    />
  )

  /** Which scenario the page is about: the one control the overview keeps. */
  const chips = cmp.runs.map((r) => (
    <button
      key={r.id}
      className={`chipbtn${r.id === run.id ? ' on' : ''}`}
      aria-pressed={r.id === run.id}
      onClick={() => r.id !== run.id && selectRun(r.id)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
    >
      <span className="sw" style={{ background: colorOf(r.id), width: 9, height: 9, borderRadius: 2, display: 'inline-block' }} />
      {r.name}
      {r.isBaseline && <span className="tag">baseline</span>}
    </button>
  ))
  const picker = (
    <div className="card c12 fo-picker">
      <div className="formrow" role="group" aria-label="Scenario" style={{ alignItems: 'center', gap: 8 }}>
        {chips}
        {busy && <span className="sub2 fo-running">running…</span>}
      </div>
    </div>
  )

  /* ---------- scenario rail: the picker plus the selected scenario's own controls ---------- */
  const rail = (
      <div className="card c12">
        <div className="h4row">
          <h2>Scenarios</h2>
          <div className="right muted">
            real (inflation-adjusted) dollars · 2,000 paths · today's balance sheet {fmtShort(cmp.balance!.total)}
            {busy && <span className="muted"> · running…</span>}
          </div>
        </div>
        <div className="formrow" style={{ alignItems: 'center', gap: 8 }}>
          {chips}
          <Button size="mini" variant="ghost" onClick={() => void addScenario(run)}>Duplicate</Button>
          <Button size="mini" variant="ghost" busy={renameScenario.busy} onClick={() => void rename()}>Rename</Button>
          {!run.isBaseline && <Button size="mini" variant="ghost" busy={setBaseline.busy} onClick={makeBaseline}>Set as baseline</Button>}
          {cmp.runs.length > 1 && <Button size="mini" variant="ghost" busy={deleteScenario.busy} onClick={() => void remove()}>Delete</Button>}
          <span className="scr-railopts">
            <span className="sub2">Returns</span>
            <Segmented size="sm" aria-label="How returns are drawn" value={draw} options={DRAWS} onChange={setDraw} />
            <span className="addform">
              <label className="sub2" htmlFor={thresholdId}>Crossing at</label>
              <Tooltip content="A whole percent from 50 to 99">
                <TextInput
                  id={thresholdId}
                  className="scr-threshold"
                  inputMode="numeric"
                  maxLength={3}
                  value={thresholdText}
                  aria-invalid={thresholdBad || undefined}
                  onChange={(e) => typeThreshold(e.target.value)}
                  onBlur={settleThreshold}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') settleThreshold()
                  }}
                />
              </Tooltip>
              <span className="sub2">% odds</span>
            </span>
          </span>
        </div>
      </div>
  )

  /* ---------- assumptions for the selected scenario ---------- */
  const assumptionsCard = (
      <div className="card c12">
        <div className="h4row">
          <h2>
            Assumptions · <span style={{ color }}>{run.name}</span>
          </h2>
          <div className="right muted">
            <span aria-live="polite">{status === 'failed' ? 'not saved — edit again to retry' : status === 'saving' ? 'saving…' : 'saved'}</span>
          </div>
        </div>
        <div className="scr-fields">
          {rateKnob('meanReturnMicro', 'Real return', { negative: true })}
          {rateKnob('volMicro', 'Volatility')}
          {rateKnob('propertyGrowthMicro', 'Property growth', { negative: true })}
          {moneyKnob('saveBeforeBuyCents', 'Save / yr now')}
          {moneyKnob('saveAfterBuyCents', 'Save / yr after buying')}
        </div>
        <div className="scr-fields" style={{ marginTop: 12 }}>
          <label className="scr-check">
            <input type="checkbox" checked={knobs.buyEnabled} onChange={(e) => editKnob({ buyEnabled: e.target.checked })} />
            Buy the dream home ({cmp.home ? fmtShort(cmp.home.priceCents) : '—'}
            {cmp.home?.loanName ? `, ${cmp.home.loanName}` : <>, terms from the <Link className="scr-link" to={{ screen: 'goal', rest: ['loans'] }}>Dream Home loan options</Link></>})
          </label>
          {knobs.buyEnabled && yearKnob('buyYear', 'Buy in')}
          {yearKnob('retireYear', 'Retire in')}
          {moneyKnob('retireSpendCents', 'Spend / yr retired')}
          {yearKnob('endYear', 'Project to')}
        </div>
      </div>
  )

  /* ---------- taxes & income (Future v3) ---------- */
  const taxCard = (
      <div className="card c12">
        <div className="h4row">
          <h2>
            Taxes &amp; income · <span style={{ color }}>{run.name}</span>
          </h2>
          <div className="right">
            <label className="scr-check" style={{ marginTop: 0 }}>
              <input type="checkbox" checked={knobs.taxModel} onChange={(e) => editKnob({ taxModel: e.target.checked })} />
              Model taxes and account types
            </label>
          </div>
        </div>
        {knobs.taxModel ? (
          <>
            <div className="scr-fields">
              <div className="scr-f lg">
                <Field label="Withdrawals" hint={ORDER_LABEL[knobs.withdrawalOrder]}>
                  <Select value={knobs.withdrawalOrder} onChange={(e) => editKnob({ withdrawalOrder: e.target.value as WithdrawalOrder })}>
                    <option value="taxable-first">Taxable first</option>
                    <option value="pro-rata">Pro rata</option>
                    <option value="fill-bracket">Fill a bracket</option>
                  </Select>
                </Field>
              </div>
              {knobs.withdrawalOrder === 'fill-bracket' && (
                <div className="scr-f xs">
                  <Field label="Up to">
                    <Select value={knobs.fillBracketMicro} onChange={(e) => editKnob({ fillBracketMicro: Number(e.target.value) })}>
                      {BRACKETS.map((b) => <option key={b.micro} value={b.micro}>{b.label}</option>)}
                    </Select>
                  </Field>
                </div>
              )}
              <div className="scr-f">
                <Field label="HSA counts as" hint={knobs.hsaAsRoth ? 'spent tax-free on care' : 'taxed when drawn'}>
                  <Select value={knobs.hsaAsRoth ? 'roth' : 'traditional'} onChange={(e) => editKnob({ hsaAsRoth: e.target.value === 'roth' })}>
                    <option value="roth">Roth</option>
                    <option value="traditional">Traditional</option>
                  </Select>
                </Field>
              </div>
              <div className="scr-f rate">
                <Field label="Advisor fee" hint="the alternative, priced">
                  <PercentInput valueMicro={knobs.advisorFeeMicro} onChange={(m) => editKnob({ advisorFeeMicro: m })} />
                </Field>
              </div>
            </div>
            <div className="scr-fields" style={{ marginTop: 12 }}>
              <label className="scr-check">
                <input type="checkbox" checked={knobs.convOn} onChange={(e) => editKnob({ convOn: e.target.checked })} />
                Roth conversions
              </label>
              {knobs.convOn && (
                <>
                  <div className="scr-f xs">
                    <Field label="From">
                      <TextInput inputMode="numeric" maxLength={4} value={knobs.convFrom} onChange={(e) => editKnob({ convFrom: e.target.value })} />
                    </Field>
                  </div>
                  <div className="scr-f xs">
                    <Field label="Through">
                      <TextInput inputMode="numeric" maxLength={4} value={knobs.convTo} onChange={(e) => editKnob({ convTo: e.target.value })} />
                    </Field>
                  </div>
                  <div className="scr-f">
                    <Field label="Each year">
                      <Select value={knobs.convMode} onChange={(e) => editKnob({ convMode: e.target.value as 'amount' | 'fill' })}>
                        <option value="amount">a fixed amount</option>
                        <option value="fill">fill a bracket</option>
                      </Select>
                    </Field>
                  </div>
                  {knobs.convMode === 'amount' ? (
                    <div className="scr-f">
                      <Field label="Convert / yr">
                        <MoneyInput value={knobs.convAmountCents} onChange={(c) => editKnob({ convAmountCents: c })} />
                      </Field>
                    </div>
                  ) : (
                    <div className="scr-f xs">
                      <Field label="Up to">
                        <Select value={knobs.convFillMicro} onChange={(e) => editKnob({ convFillMicro: Number(e.target.value) })}>
                          {BRACKETS.map((b) => <option key={b.micro} value={b.micro}>{b.label}</option>)}
                        </Select>
                      </Field>
                    </div>
                  )}
                </>
              )}
            </div>
            {knobs.ss.length > 0 && (
              <div className="scr-fields" style={{ marginTop: 12 }}>
                {knobs.ss.map((x, i) => {
                  const born = cmp.tax.people.find((p) => p.name.toLowerCase() === x.name.toLowerCase())?.birthYear ?? null
                  const setSs = (patch: Partial<Knobs['ss'][number]>) => editKnob({ ss: knobs.ss.map((y, j) => (j === i ? { ...y, ...patch } : y)) })
                  return (
                    <div key={x.name} className="scr-fields" style={{ gap: '12px 16px' }}>
                      <div className="scr-f">
                        <Field label={`${x.name}: Social Security`} hint={born === null ? 'needs a birth year (Taxes)' : 'a year at full retirement age, from the SSA statement'}>
                          <MoneyInput value={x.fraBenefitCents} placeholder="0.00" onChange={(c) => setSs({ fraBenefitCents: c })} />
                        </Field>
                      </div>
                      <div className="scr-f xs">
                        <Field label="Claims at" hint={born !== null ? `in ${born + x.claimAge}` : undefined}>
                          <Select value={x.claimAge} onChange={(e) => setSs({ claimAge: Number(e.target.value) })}>
                            {[62, 63, 64, 65, 66, 67, 68, 69, 70].map((a) => <option key={a} value={a}>{a}</option>)}
                          </Select>
                        </Field>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            <div className="sub2 topline">
              Today: taxable <b className="inkstrong">{fmtShort(cmp.tax.buckets.taxableCents)}</b>
              {cmp.tax.buckets.taxableCents > 0 && <> (basis {fmtShort(cmp.tax.buckets.taxableBasisCents)})</>} · traditional{' '}
              <b className="inkstrong">{fmtShort(cmp.tax.buckets.traditionalCents)}</b> · Roth <b className="inkstrong">{fmtShort(cmp.tax.buckets.rothCents)}</b>
              {cmp.tax.buckets.hsaCents > 0 && <> · HSA {fmtShort(cmp.tax.buckets.hsaCents)}</>}
              {' '}· saving a year {fmtShort(cmp.tax.saves.traditionalCents)} pre-tax and {fmtShort(cmp.tax.saves.rothCents)} Roth from the{' '}
              <Link className="scr-link" to={{ screen: 'tax', rest: ['contributions'] }}>paychecks</Link>, the rest to taxable
              {cmp.birthYear === null && <> · <span className="neg">no birth year set, so no RMDs, Social Security or ages</span></>}
              {cmp.tax.buckets.unknownBasis.length > 0 && <> · basis unknown for {cmp.tax.buckets.unknownBasis.join(', ')} (taken at value)</>}
            </div>
          </>
        ) : (
          <p className="sub2">
            Off: one liquid bucket, no tax on anything drawn — the Future v2 model. On: taxable, traditional and Roth buckets
            from your account types, every year's withdrawals taxed, with RMDs, Social Security and conversions.
          </p>
        )}
      </div>
  )

  /* ---------- overlay chart + odds ---------- */
  const fan = <FutureFan runs={cmp.runs} selectedId={run.id} baselineId={base.id} params={run.params} buys={buys} thresholdPct={cmp.thresholdPct} />
  const resultCard = (
      <div className="card c3">
        <h2>{run.name}</h2>
        <div className="scr-odds">
          <div>
            <div className="muted">Crossing date · ≥{cmp.thresholdPct}% odds</div>
            <div className="heronum" style={{ fontSize: 36, color }}>
              {run.crossingYear ?? '—'}
              {run.crossingYear && cmp.birthYear !== null && <span className="sub2" style={{ marginLeft: 8 }}>age {run.crossingYear - cmp.birthYear}</span>}
            </div>
            <div className="sub2">
              {run.crossingYear
                ? `earliest retirement year the plan still clears ${cmp.thresholdPct}%`
                : `no year before ${endYear} clears ${cmp.thresholdPct}%`}
              {run.delta?.crossingYears != null && run.delta.crossingYears !== 0 && (
                <>
                  {' '}
                  · <b className={cls(-run.delta.crossingYears)}>{signed(run.delta.crossingYears, ' yr')}</b> vs {base.name}
                </>
              )}
            </div>
          </div>
          <div>
            <div className="muted">Plan succeeds¹</div>
            <div className="v" style={{ fontSize: 24, fontWeight: 650 }}>
              {run.result.successPct}%
              {run.delta && <span className={`sub2 ${cls(run.delta.successPct)}`} style={{ marginLeft: 8 }}>{signed(run.delta.successPct, 'pp')}</span>}
            </div>
          </div>
          <div>
            <div className="muted">Median at {endYear}</div>
            <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
              {fmtShort(run.result.medianEndCents)}
              {run.delta && <span className={`sub2 ${cls(run.delta.medianEndCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.medianEndCents)}</span>}
            </div>
          </div>
          <div>
            <div className="muted">10th percentile</div>
            <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
              {fmtShort(run.result.p10EndCents)}
              {run.delta && <span className={`sub2 ${cls(run.delta.p10EndCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.p10EndCents)}</span>}
            </div>
          </div>
          {run.result.medianLifetimeTaxCents != null && (
            <div>
              <div className="muted">
                <Tooltip content="Median over paths of the tax paid on withdrawals, conversions, RMDs and Social Security, on top of working-year wages">
                  <span className="scr-tipped">Lifetime tax</span>
                </Tooltip>
              </div>
              <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
                {fmtShort(run.result.medianLifetimeTaxCents)}
                {run.delta?.lifetimeTaxCents != null && <span className={`sub2 ${cls(-run.delta.lifetimeTaxCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.lifetimeTaxCents)}</span>}
              </div>
            </div>
          )}
          {run.result.medianEndAfterTaxCents != null && (
            <div>
              <div className="muted">
                <Tooltip content="The median end less the tax an heir would pay drawing the traditional bucket over ten years; taxable steps up, Roth is free">
                  <span className="scr-tipped">After tax at {endYear}</span>
                </Tooltip>
              </div>
              <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
                {fmtShort(run.result.medianEndAfterTaxCents)}
                {run.delta?.medianEndAfterTaxCents != null && <span className={`sub2 ${cls(run.delta.medianEndAfterTaxCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.medianEndAfterTaxCents)}</span>}
              </div>
            </div>
          )}
          {run.advisor && (
            <div className="sub2">
              With a {formatPercentMicro(run.advisor.feeMicro, 1)} advisor fee: median {fmtShort(run.advisor.medianEndCents)} — <b className="inkstrong">{fmtShort(run.advisor.costCents)}</b> less by {endYear}
            </div>
          )}
          <div className="sub2 topline">
            ¹ {buys ? `buy the house in ${run.params.buyYear} and ` : ''}spend{' '}
            {formatCents(run.params.retireSpendCents)}/yr from {run.params.retireYear} without the liquid portfolio running out
            before {endYear}.
          </div>
        </div>
      </div>
  )

  /* ---------- side by side ---------- */
  const compareCard = (
      <div className="card c12">
        <div className="h4row">
          <h2>Side by side</h2>
          <div className="right muted">deltas vs {base.name} · {draw === 'historical' ? 'historical sequences' : 'lognormal draws'}</div>
        </div>
        <div className="ui-tablewrap ui-pin1">
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="r">Crossing (≥{cmp.thresholdPct}%)</th>
              <th className="r">Plan succeeds</th>
              <th className="r">Median at end</th>
              <th className="r">10th pct</th>
              <th className="r">Lifetime tax</th>
              <th className="r">After tax</th>
              <th className="r">Advisor costs</th>
              <th>Retire</th>
              <th>Home</th>
              <th>Save/yr</th>
              <th>Spend/yr</th>
              <th>Events</th>
            </tr>
          </thead>
          <tbody>
            {cmp.runs.map((r) => (
              <tr key={r.id} className={r.id === run.id ? 'selrow' : undefined} onClick={() => r.id !== run.id && selectRun(r.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="sw" style={{ background: colorOf(r.id), width: 9, height: 9, borderRadius: 2, display: 'inline-block', marginRight: 8 }} />
                  {r.name} {r.isBaseline && <span className="tag">baseline</span>}
                </td>
                <td className="r num">
                  {r.crossingYear ?? '—'}
                  {r.delta?.crossingYears != null && r.delta.crossingYears !== 0 && (
                    <span className={`sub2 ${cls(-r.delta.crossingYears)}`} style={{ marginLeft: 6 }}>{signed(r.delta.crossingYears)}</span>
                  )}
                </td>
                <td className="r num">
                  {r.result.successPct}%
                  {r.delta && <span className={`sub2 ${cls(r.delta.successPct)}`} style={{ marginLeft: 6 }}>{signed(r.delta.successPct, 'pp')}</span>}
                </td>
                <td className="r num">
                  {fmtShort(r.result.medianEndCents)}
                  {r.delta && <span className={`sub2 ${cls(r.delta.medianEndCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.medianEndCents)}</span>}
                </td>
                <td className="r num">
                  {fmtShort(r.result.p10EndCents)}
                  {r.delta && <span className={`sub2 ${cls(r.delta.p10EndCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.p10EndCents)}</span>}
                </td>
                <td className="r num">
                  {r.result.medianLifetimeTaxCents != null ? fmtShort(r.result.medianLifetimeTaxCents) : '—'}
                  {r.delta?.lifetimeTaxCents != null && <span className={`sub2 ${cls(-r.delta.lifetimeTaxCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.lifetimeTaxCents)}</span>}
                </td>
                <td className="r num">
                  {r.result.medianEndAfterTaxCents != null ? fmtShort(r.result.medianEndAfterTaxCents) : '—'}
                  {r.delta?.medianEndAfterTaxCents != null && <span className={`sub2 ${cls(r.delta.medianEndAfterTaxCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.medianEndAfterTaxCents)}</span>}
                </td>
                <td className="r num">{r.advisor ? `${fmtShort(r.advisor.costCents)} @ ${formatPercentMicro(r.advisor.feeMicro, 1)}` : '—'}</td>
                <td className="num">{r.params.retireYear}{cmp.birthYear !== null && <span className="sub2"> · age {r.params.retireYear - cmp.birthYear}</span>}</td>
                <td className="num">{r.params.buyEnabled && cmp.home ? `buy ${r.params.buyYear}` : 'no purchase'}</td>
                <td className="num">
                  {fmtShort(r.params.saveBeforeBuyCents)}
                  {r.params.buyEnabled && cmp.home && ` → ${fmtShort(r.params.saveAfterBuyCents)}`}
                </td>
                <td className="num">{fmtShort(r.params.retireSpendCents)}</td>
                <td className="sub2">{r.params.events.length ? r.params.events.map((e) => e.label ?? `${fmtShort(e.amountCents)} ${e.year}`).join(' · ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
  )

  /* ---------- price a decision ---------- */
  const priceCard = (
      <div className="card c6">
        <div className="h4row">
          <h2>Price a decision</h2>
          <div className="right muted">against {run.name}</div>
        </div>
        <form
          className="scr-fields"
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            priceIt()
          }}
        >
          <div className="scr-f grow">
            <Field label="What">
              <TextInput placeholder="Kitchen remodel" maxLength={60} value={decision.label} onChange={(e) => setDecision((d) => ({ ...d, label: e.target.value }))} />
            </Field>
          </div>
          <div className="scr-f sm">
            <Field label="Costs">
              <MoneyInput value={decision.amountCents} onChange={(c) => setDecision((d) => ({ ...d, amountCents: c }))} />
            </Field>
          </div>
          <div className="scr-f xs">
            <Field label="In">
              <TextInput inputMode="numeric" maxLength={4} placeholder={String(run.params.buyYear)} value={decision.year} onChange={(e) => setDecision((d) => ({ ...d, year: e.target.value }))} />
            </Field>
          </div>
          <div className="scr-f xs">
            <Field label="Yearly until">
              <TextInput inputMode="numeric" maxLength={4} placeholder="—" value={decision.until} onChange={(e) => setDecision((d) => ({ ...d, until: e.target.value }))} />
            </Field>
          </div>
          <Button type="submit" size="mini" busy={priceDecision.busy} style={{ marginTop: 24 }}>Price it</Button>
        </form>
        {price && (
          <div className="topline">
            <div style={{ fontSize: 15 }}>
              <b className="inkstrong">{formatCents(Math.abs(decision.amountCents ?? 0))}</b>
              {decision.until && Number(decision.until) > (Number(decision.year) || run.params.buyYear) ? ' a year' : ''} in{' '}
              {decision.year || run.params.buyYear} is <b className="inkstrong">{fmtShort(Math.abs(price.futureValueCents))}</b> at{' '}
              {price.atYear}
              {' · '}odds <b className="inkstrong">{price.successBeforePct}%</b> →{' '}
              <b className={cls(price.successAfterPct - price.successBeforePct)}>{price.successAfterPct}%</b>
              {' · '}median at {endYear}{' '}
              <b className={cls(price.medianEndAfterCents - price.medianEndBeforeCents)}>{signedMoney(price.medianEndAfterCents - price.medianEndBeforeCents)}</b>
            </div>
            <div className="sub2" style={{ marginTop: 6 }}>
              Future value compounds the outlay at the scenario's real return to {price.atYear} — what the money would have been if left invested. The odds and median deltas come from re-running the simulation with the event in it.
            </div>
            <div style={{ marginTop: 10 }}>
              <Button size="mini" variant="gold" busy={saveParams.busy} onClick={() => void commitDecision()}>Add to {run.name}</Button>
            </div>
          </div>
        )}
      </div>
  )
  const eventsCard = (
      <div className="card c6">
        <div className="h4row">
          <h2>Events in {run.name}</h2>
          <div className="right muted">dated cash flows against the liquid portfolio</div>
        </div>
        {run.params.events.length === 0 ? (
          <p className="sub2">None yet. Price a decision and add it, or use one to model a sabbatical, an inheritance, a mortgage payoff, tuition.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Event</th><th>When</th><th className="r">Amount</th><th /></tr>
            </thead>
            <tbody>
              {run.params.events.map((e, i) => (
                <tr key={i}>
                  <td>{e.label ?? <span className="muted">untitled</span>}</td>
                  <td className="num">{e.untilYear ? `${e.year}–${e.untilYear}, yearly` : e.year}</td>
                  <td className={`r num ${e.amountCents < 0 ? 'neg' : 'pos'}`}>{formatCents(e.amountCents, { sign: true })}</td>
                  <td className="r"><Button size="mini" variant="ghost" onClick={() => removeEvent(e)}>Remove</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
  )

  const guideCard = (
      <div className="card c12">
        <h2>How to read this</h2>
        <p>
          Each scenario is a set of assumptions run over the same balance sheet — 2,000 futures, in real dollars, with the
          same random seed so two scenarios differ only where their knobs differ. <b className="inkstrong">Lognormal</b>{' '}
          draws each year's return independently from your return and volatility. <b className="inkstrong">Historical
          sequences</b> instead replay ten-year runs of actual US stock real returns since 1928, re-centred to your return and
          volatility — same expected return, real order of events, so a 1966 or 2000 start can happen. Property grows
          deterministically, the down payment leaves the portfolio in the purchase year, the new mortgage amortizes, events
          land in their years, and saving switches to spending at retirement. The crossing date is the earliest retirement
          year at which the plan still clears the odds threshold with everything else held fixed. A flashlight, not a promise
          — revisit the assumptions yearly.
        </p>
        <p style={{ marginTop: 8 }}>
          With <b className="inkstrong">taxes modeled</b>, the liquid portfolio is three buckets read from your account types:
          taxable (bank accounts and brokerage, with their cost basis), traditional (401(k), 403(b), IRA) and Roth. Savings
          go in as your paychecks split them. In retirement each year's spending — and the tax it causes — is drawn in the
          order you pick: traditional money is ordinary income, a taxable sale realizes gain in proportion to the bucket's
          basis, Roth is free. Required minimum distributions start at 73 or 75 by birth year, whether or not the spending
          needs them; Social Security arrives from the claiming age, adjusted for claiming early or late, with up to 85% of
          it taxable. Brackets are this year's, held constant: the simulation is in today's dollars and the brackets are
          indexed. Lifetime tax and the after-tax end make a conversion's trade visible: tax now against tax later. Left
          out: the 10% early-withdrawal penalty, state rules for retirement income, IRMAA, the senior deduction, and each
          spouse's own RMD schedule (the oldest birth year sets it for the whole traditional bucket).
        </p>
      </div>
  )

  if (detail === 'assumptions')
    return (
      <DetailView title="Assumptions">
        {header}
        {rail}
        {assumptionsCard}
        {taxCard}
      </DetailView>
    )
  if (detail === 'results')
    return (
      <DetailView title="Results in depth">
        {header}
        {picker}
        {fan}
        {resultCard}
      </DetailView>
    )
  if (detail === 'compare')
    return (
      <DetailView title="Side by side">
        {header}
        {compareCard}
      </DetailView>
    )
  if (detail === 'events')
    return (
      <DetailView title="Events & decisions">
        {header}
        {picker}
        {priceCard}
        {eventsCard}
      </DetailView>
    )
  if (detail === 'guide')
    return (
      <DetailView title="How to read this">
        {header}
        {guideCard}
      </DetailView>
    )

  /* ---------- the overview: which scenario, its answer, and the ways down ---------- */
  const vsBase = (text: string) => `${text} vs ${base.name}`
  const stats: StatItem[] = [
    {
      label: 'Plan succeeds',
      value: `${run.result.successPct}%`,
      note: run.delta && run.delta.successPct !== 0 ? vsBase(signed(run.delta.successPct, 'pp')) : undefined,
    },
    {
      label: `Median at ${endYear}`,
      value: fmtShort(run.result.medianEndCents),
      note: run.delta && run.delta.medianEndCents !== 0 ? vsBase(signedMoney(run.delta.medianEndCents)) : undefined,
    },
    { label: '10th percentile', value: fmtShort(run.result.p10EndCents) },
  ]
  const events = run.params.events.length
  const others = cmp.runs.length - 1

  return (
    <div className="grid12">
      {header}
      {picker}
      {fan}
      <div className="card c3 fo-answer">
        <div className="h4row">
          <h2>{run.name}</h2>
          <div className="right">
            <DrillMore to="results">In depth</DrillMore>
          </div>
        </div>
        <div className="muted">Crossing date · ≥{cmp.thresholdPct}% odds</div>
        <div className="heronum fo-crossing" style={{ color }}>
          {run.crossingYear ?? '—'}
          {run.crossingYear && cmp.birthYear !== null && <span className="sub2">age {run.crossingYear - cmp.birthYear}</span>}
        </div>
        <div className="sub2">
          {run.crossingYear
            ? `The earliest retirement year the plan still clears ${cmp.thresholdPct}%`
            : `No year before ${endYear} clears ${cmp.thresholdPct}%`}
          {run.delta?.crossingYears != null && run.delta.crossingYears !== 0 && ` · ${vsBase(signed(run.delta.crossingYears, ' yr'))}`}
        </div>
        <Stats items={stats} />
      </div>

      <DrillCard to="assumptions" span="c3" title="Assumptions" value={summary.value} note={summary.note} />
      <DrillCard
        to="compare"
        span="c3"
        title="Side by side"
        value={`${cmp.runs.length} scenario${cmp.runs.length === 1 ? '' : 's'}`}
        note={others === 0 ? 'Add a scenario to measure it against this one' : `Crossing year, each measured against ${base.name}`}
      >
        {others > 0 && (
          <MiniRows
            rows={cmp.runs.slice(0, 4).map((r) => ({
              key: r.id,
              label: (
                <>
                  <span className="fo-sw" style={{ background: colorOf(r.id) }} aria-hidden="true" />
                  {r.name}
                </>
              ),
              value: r.crossingYear ?? '—',
            }))}
          />
        )}
      </DrillCard>
      <DrillCard
        to="events"
        span="c3"
        title="Events & decisions"
        value={events === 0 ? 'No events' : `${events} event${events === 1 ? '' : 's'}`}
        note={events === 0 ? `Price a one-off cost against ${run.name}, then add it` : `Dated cash flows in ${run.name}; price another`}
      />
      <DrillCard to="guide" span="c3" title="How to read this" note="What the bands, the crossing date and the tax model mean, and what they leave out" />
    </div>
  )
}
