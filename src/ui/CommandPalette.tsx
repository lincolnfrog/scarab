import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import { lastRoute, navigate, parseHash, SCREENS, setParams, type Route, type RouteTarget, type ScreenId } from '../router'
import { Dialog } from './Dialog'
import { EmptyState } from './EmptyState'
import { TextInput } from './Field'
import { useScreen, useScreenRoute } from './screen'
import { toast } from './Toast'
import '../screens/screens.css'

/**
 * ⌘K / Ctrl-K: jump to any screen, section or action from the keyboard.
 *
 * Every entry is a destination in the hash router, so the palette never
 * reaches into a screen. A screen goes back to where it was left (its
 * filters), a section is a useAnchor path ('#/tax/paychecks'), and an action
 * is a deep link the target screen runs on arrival — '#/future?d=new-scenario'
 * — through useDeepAction below, which then drops the `d`. The same links work
 * from anywhere (an EmptyState, a Dashboard tile), not only from here.
 *
 * Mounted once in App, outside every screen. It opens only while the app shell
 * is up (not over the front door or the boot card) and never on top of
 * another modal.
 */

/* ---------- deep actions: '?d=<action>' on a screen ---------- */

/**
 * The actions each screen runs when it shows with `?d=<action>`. A screen
 * listed here handles exactly these through useDeepAction; the values are
 * enums, so they're safe in a URL.
 */
export const DEEP_ACTIONS = {
  cash: ['import', 'add-account'],
  re: ['add-property'],
  tax: ['add-paycheck'],
  future: ['new-scenario'],
} as const satisfies Partial<Record<ScreenId, readonly string[]>>

export type DeepScreen = keyof typeof DEEP_ACTIONS
export type DeepAction<S extends DeepScreen> = (typeof DEEP_ACTIONS)[S][number]

/**
 * Run a screen's handler once when it shows with `?d=<action>`, then drop the
 * `d` (replacing the history entry, so Back doesn't run it again). Call it at
 * the top level of the screen, before any early return. `ready` holds the
 * action until what it needs has loaded (the file input rendered, the form's
 * data in); it runs as soon as `ready` turns true while the screen shows.
 */
export function useDeepAction<S extends DeepScreen>(screen: S, handlers: { [K in DeepAction<S>]: () => void }, ready = true): void {
  const { id, active } = useScreen()
  const route = useScreenRoute()
  const d = route.params.d
  const latest = useRef(handlers)
  useLayoutEffect(() => {
    latest.current = handlers
  })
  // One run per arrival: StrictMode's second effect pass and re-renders see the same route object.
  const handled = useRef<Route | null>(null)
  useEffect(() => {
    if (!active || !ready || d === undefined || handled.current === route) return
    if (id !== screen) {
      console.error(`useDeepAction('${screen}') called on the ${id} screen`)
      return
    }
    if (!(DEEP_ACTIONS[screen] as readonly string[]).includes(d)) return // not ours to run (or a stale link): leave it
    handled.current = route
    setParams({ d: null })
    latest.current[d as DeepAction<S>]()
  }, [active, ready, d, route, id, screen])
}

/* ---------- the commands ---------- */

type Base = { id: string; label: string; /** More words the filter matches; not shown. */ keywords?: string }
export type Command =
  | (Base & { kind: 'screen'; screen: ScreenId })
  | (Base & { kind: 'section'; screen: ScreenId; rest: string[]; params?: Record<string, string> })
  | (Base & {
      kind: 'action'
      screen: ScreenId
      action: string
      rest?: string[]
      /** Land on just `?d=<action>`: the screen's other params belong to the action itself (Investments' acct/lot), not to filters worth keeping. */
      fresh?: boolean
    })

const LABEL = Object.fromEntries(SCREENS.map((s) => [s.id, s.label])) as Record<ScreenId, string>

const SCREEN_WORDS: Record<ScreenId, string> = {
  dash: 'home overview net worth summary',
  invest: 'portfolio brokerage stocks holdings lots trades crypto retirement 401k',
  re: 'house home property mortgage equity valuation',
  cash: 'bank transactions spending budget checking savings categories',
  goal: 'dream home down payment fund loan buy house',
  tax: 'taxes withholding paycheck irs refund owe safe harbor',
  future: 'scenarios monte carlo retirement projection simulate odds',
  compare: 'chart overlay performance benchmark series rebased',
  vault: 'backup export import encrypt passkey session save recovery',
}

/** An action on one of the DEEP_ACTIONS screens; the action name is checked against that list. */
const act = <S extends DeepScreen>(screen: S, action: DeepAction<S>, label: string, keywords: string, rest?: string[]): Command => ({
  id: `${screen}:${action}`,
  kind: 'action',
  screen,
  action,
  label,
  keywords,
  rest,
})
const section = (screen: ScreenId, rest: string[], label: string, keywords: string, params?: Record<string, string>): Command => ({
  id: `${screen}/${rest.join('/')}${params ? `?${new URLSearchParams(params)}` : ''}`,
  kind: 'section',
  screen,
  rest,
  params,
  label,
  keywords,
})

/**
 * Investments' own deep links (plan B7, B8, B11). The Investments screen
 * handles `d` itself, so each is offered only once it works there: flip
 * `live` when '#/invest?d=…' does what the label says. All three are live
 * (Invest.tsx): the record-trade sheet, the guided add and the balance
 * check-in are each open exactly while the address has their `d`, with
 * `acct`/`lot` naming what a sheet opened on — which is why these land fresh
 * rather than on the params Investments was left with.
 */
export const INVEST_LINKS: readonly { action: string; label: string; keywords: string; live: boolean }[] = [
  { action: 'trade', label: 'Record a trade…', keywords: 'buy sell stock shares lot', live: true },
  { action: 'add-account', label: 'Add an investment account…', keywords: 'brokerage retirement 401k ira new', live: true },
  { action: 'checkin', label: 'Balance check-in…', keywords: 'update balances statement 401k', live: true },
]

/** Everything the palette offers, in the order an empty query lists it (grouped by kind). */
export const COMMANDS: readonly Command[] = [
  ...SCREENS.map((s): Command => ({ id: s.id, kind: 'screen', screen: s.id, label: s.label, keywords: SCREEN_WORDS[s.id] })),

  act('cash', 'import', 'Import bank statement (CSV / OFX)…', 'upload file download qfx transactions', ['import']),
  act('cash', 'add-account', 'Add a bank account…', 'checking savings new', ['import']),
  act('tax', 'add-paycheck', 'Add a paycheck…', 'payroll stub withholding w2 wages'),
  act('re', 'add-property', 'Add a property…', 'house home new'),
  act('future', 'new-scenario', 'New scenario…', 'create what if'),
  ...INVEST_LINKS.filter((l) => l.live).map(
    (l): Command => ({ id: `invest:${l.action}`, kind: 'action', screen: 'invest', action: l.action, label: l.label, keywords: l.keywords, fresh: true }),
  ),

  section('cash', ['transactions'], 'Uncategorized transactions', 'categorize to do todo inbox', { cat: 'uncat' }),
  section('cash', ['budget'], 'Budget', 'plan monthly limits spending'),
  section('tax', ['paychecks'], 'Paychecks', 'payroll withholding stubs wages'),
  section('tax', ['settings'], 'Tax settings', 'filing status state dependents income'),
  section('goal', ['loans'], 'Loan options', 'mortgage rate points term'),
  section('goal', ['rental'], 'Rental scenario', 'rent out move 121 landlord'),
  section('future', ['compare'], 'Compare scenarios side by side', 'odds table deltas'),
]

const GROUPS: readonly { kind: Command['kind']; title: string }[] = [
  { kind: 'screen', title: 'Screens' },
  { kind: 'action', title: 'Actions' },
  { kind: 'section', title: 'Sections' },
]

const withoutD = (params: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined => {
  if (!params || !('d' in params)) return params
  const { d: _drop, ...rest } = params
  return rest
}

/**
 * Where a command lands. A screen comes back with the filters it was left
 * with, as the nav does; an action keeps them and adds its `d` (a `fresh` one
 * lands on its `d` alone); a section is exactly its path.
 */
export function commandTarget(cmd: Command, last: (s: ScreenId) => Route | null = lastRoute): RouteTarget {
  if (cmd.kind === 'screen') return { screen: cmd.screen, params: withoutD(last(cmd.screen)?.params) }
  if (cmd.kind === 'section') return { screen: cmd.screen, rest: cmd.rest, params: cmd.params }
  const kept = cmd.fresh ? undefined : withoutD(last(cmd.screen)?.params)
  return { screen: cmd.screen, rest: cmd.rest, params: { ...kept, d: cmd.action } }
}

/* ---------- the filter ---------- */

export type Match = { score: number; /** indices into the label, for highlighting */ hits: number[] }

const isAlnum = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c)
const isWordStart = (t: string, i: number) => isAlnum(t[i]) && !isAlnum(t[i - 1])
const range = (from: number, n: number) => Array.from({ length: n }, (_, k) => from + k)

/** Letters in order from word start `start`: runs and word starts score up, gaps cost. */
function subsequenceFrom(tok: string, t: string, start: number): Match | null {
  const hits = [start]
  let score = 6
  for (let k = 1; k < tok.length; k++) {
    const c = tok[k]!
    const prev = hits[hits.length - 1]!
    let i: number
    if (t[prev + 1] === c) i = prev + 1
    else {
      i = -1
      for (let j = t.indexOf(c, prev + 1); j >= 0; j = t.indexOf(c, j + 1))
        if (isWordStart(t, j)) {
          i = j
          break
        }
      if (i < 0) i = t.indexOf(c, prev + 1)
      if (i < 0) return null
    }
    score += i === prev + 1 ? 8 : isWordStart(t, i) ? 6 : 1
    score -= Math.min(i - prev - 1, 10)
    hits.push(i)
  }
  return { score, hits }
}

/**
 * One lower-cased query token against one lower-cased text, or null.
 * `scatter` allows letters in order across words; off for the keyword list,
 * where it would string "trade" together from "transactions … budget".
 */
function matchToken(tok: string, t: string, scatter = true): Match | null {
  // Contiguous: at a word start beats mid-word, earlier beats later.
  let mid = -1
  for (let i = t.indexOf(tok); i >= 0; i = t.indexOf(tok, i + 1)) {
    if (isWordStart(t, i)) return { score: 100 + tok.length * 10 + (i === 0 ? 40 : 0) - Math.min(i, 30), hits: range(i, tok.length) }
    if (mid < 0) mid = i
  }
  if (mid >= 0 && tok.length >= 2) return { score: 40 + tok.length * 10 - Math.min(mid, 30), hits: range(mid, tok.length) }
  // Letters in order ("nsc" → New SCenario, "ab" → Add a Bank…). The first must start a word, which keeps
  // letters scattered through a long label from matching.
  if (!scatter || tok.length < 2) return null
  let best: Match | null = null
  for (let i = t.indexOf(tok[0]!); i >= 0; i = t.indexOf(tok[0]!, i + 1)) {
    if (!isWordStart(t, i)) continue
    const m = subsequenceFrom(tok, t, i)
    if (m && (!best || m.score > best.score)) best = m
  }
  return best && { score: 20 + best.score, hits: best.hits }
}

/**
 * Score a command against the query: every space-separated word must match
 * its label (full weight, highlighted) or its keywords and screen name (half
 * weight). Null when some word matches nothing.
 */
export function matchCommand(query: string, cmd: Command): Match | null {
  const q = query.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!q) return { score: 0, hits: [] }
  const label = cmd.label.toLowerCase()
  const extra = `${cmd.keywords ?? ''} ${LABEL[cmd.screen]}`.toLowerCase()
  let score = label.startsWith(q) ? 60 : 0
  const hits = new Set<number>()
  for (const tok of q.split(' ')) {
    const inLabel = matchToken(tok, label)
    const inExtra = matchToken(tok, extra, false)
    const extraScore = inExtra ? Math.floor(inExtra.score / 2) : -1
    if (inLabel && inLabel.score >= extraScore) {
      score += inLabel.score
      for (const h of inLabel.hits) hits.add(h)
    } else if (inExtra) score += extraScore
    else return null
  }
  return { score, hits: [...hits].sort((a, b) => a - b) }
}

export type Ranked = { cmd: Command; hits: number[] }

/** The query's results, best first (ties keep COMMANDS order). An empty query lists everything, grouped by kind. */
export function rankCommands(query: string, cmds: readonly Command[] = COMMANDS): Ranked[] {
  if (!query.trim()) return GROUPS.flatMap((g) => cmds.filter((c) => c.kind === g.kind).map((cmd) => ({ cmd, hits: [] })))
  return cmds
    .map((cmd, i) => ({ cmd, i, m: matchCommand(query, cmd) }))
    .filter((x): x is { cmd: Command; i: number; m: Match } => x.m !== null)
    .sort((a, b) => b.m.score - a.m.score || a.i - b.i)
    .map(({ cmd, m }) => ({ cmd, hits: m.hits }))
}

/* ---------- the shortcut ---------- */

/** ⌘K on a Mac, Ctrl-K elsewhere. Ctrl-K on a Mac stays the text fields' kill-line. */
export function isPaletteShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  mac: boolean,
): boolean {
  const key = e.key.toLowerCase()
  // A Latin layout reports the letter; a non-Latin one (Cyrillic, Greek…) only the physical key.
  const isK = key === 'k' || (!/^[a-z]$/.test(key) && e.code === 'KeyK')
  if (!isK || e.altKey || e.shiftKey) return false
  return mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}

const IS_MAC =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent)

const OPEN_EVENT = 'scarab-command-palette'

/** Open the palette from a button (the same as pressing the shortcut). */
export function openCommandPalette(): void {
  window.dispatchEvent(new Event(OPEN_EVENT))
}

/**
 * The topbar's quiet way in, for people who don't know the shortcut:
 * "Search ⌘K" (Ctrl K off a Mac). Ink and hairlines only — gold is for
 * calls to action, and this is a hint.
 */
export function PaletteHint() {
  return (
    <button
      type="button"
      className="ui-cmdk-hint"
      onClick={openCommandPalette}
      aria-keyshortcuts={IS_MAC ? 'Meta+K' : 'Control+K'}
      title="Jump to a screen or an action"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      Search
      <kbd className="ui-kbd">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  )
}

/* ---------- the list ---------- */

function Highlighted({ text, hits }: { text: string; hits: readonly number[] }) {
  if (!hits.length) return <>{text}</>
  const on = new Set(hits)
  const out: ReactNode[] = []
  for (let i = 0; i < text.length; ) {
    const hit = on.has(i)
    let j = i
    while (j < text.length && on.has(j) === hit) j++
    out.push(hit ? <mark key={i}>{text.slice(i, j)}</mark> : text.slice(i, j))
    i = j
  }
  return <>{out}</>
}

/**
 * The listbox: grouped by kind for an empty query, one ranked list otherwise.
 * Focus stays in the search field; the active option is its
 * aria-activedescendant.
 */
export function PaletteList(p: {
  results: readonly Ranked[]
  grouped: boolean
  active: number
  here: ScreenId | null
  listId: string
  optionId: (i: number) => string
  onPick: (i: number) => void
  onHover: (i: number) => void
}) {
  const option = (r: Ranked, i: number) => {
    const { cmd } = r
    const hint = cmd.kind === 'screen' ? (cmd.screen === p.here ? 'You’re here' : null) : LABEL[cmd.screen]
    return (
      <div
        key={cmd.id}
        id={p.optionId(i)}
        role="option"
        aria-selected={i === p.active}
        className="scr-cmdk-opt"
        // Keep focus (and the caret) in the search field.
        onMouseDown={(e) => e.preventDefault()}
        // Move, not enter: a list scrolling under a still pointer mustn't steal the keyboard's place.
        onMouseMove={() => i !== p.active && p.onHover(i)}
        onClick={() => p.onPick(i)}
      >
        <span className="scr-cmdk-label">
          <Highlighted text={cmd.label} hits={r.hits} />
        </span>
        {hint && <span className="scr-cmdk-hint">{hint}</span>}
      </div>
    )
  }
  if (!p.grouped)
    return (
      <div id={p.listId} role="listbox" aria-label="Results" className="scr-cmdk-list">
        {p.results.map(option)}
      </div>
    )
  let i = 0
  return (
    <div id={p.listId} role="listbox" aria-label="Screens and actions" className="scr-cmdk-list">
      {GROUPS.map((g) => {
        const rows = p.results.filter((r) => r.cmd.kind === g.kind)
        if (!rows.length) return null
        const headId = `${p.listId}-${g.kind}`
        return (
          <div key={g.kind} role="group" aria-labelledby={headId} className="scr-cmdk-group">
            <div id={headId} role="presentation" className="scr-cmdk-head">
              {g.title}
            </div>
            {rows.map((r) => option(r, i++))}
          </div>
        )
      })}
    </div>
  )
}

/* ---------- the palette ---------- */

/** The app shell (sidebar, screens) is showing — not the front door, the boot splash or the "can't reach" card. */
const shellIsUp = () => document.getElementById('main')?.classList.contains('screens') === true

/**
 * The palette sits outside every screen's ErrorBoundary (App mounts it at the
 * root, beside DialogHost), so a crash in it would otherwise take the whole
 * app down. It steps aside instead: the shortcut stops working until a reload,
 * and a toast says so. (main.tsx's onCaughtError logs it.)
 */
class Contained extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    toast.error(`The ${IS_MAC ? '⌘K' : 'Ctrl-K'} palette hit a problem and is off until you reload`, {
      detail: e instanceof Error ? e.message : String(e),
    })
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** ⌘K / Ctrl-K, mounted once in App right after <DialogHost/>. */
export function CommandPalette() {
  return (
    <Contained>
      <Palette />
    </Contained>
  )
}

function Palette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [here, setHere] = useState<ScreenId | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const openRef = useRef(false)
  useLayoutEffect(() => {
    openRef.current = open
  }, [open])
  const uid = useId()
  const listId = `${uid}-list`
  const optionId = useCallback((i: number) => `${uid}-opt-${i}`, [uid])

  const results = useMemo(() => rankCommands(query), [query])
  const grouped = !query.trim()
  const current = Math.min(active, results.length - 1)

  // The shortcut, from anywhere in the page (capture: before a screen's own key handling).
  useEffect(() => {
    const otherModalOpen = () =>
      Array.from(document.querySelectorAll('dialog')).some((d) => d.open && d.matches(':modal') && !d.contains(rootRef.current))
    const show = () => {
      if (!shellIsUp() || otherModalOpen()) return false
      setQuery('')
      setActive(0)
      setHere(parseHash(location.hash).screen)
      setOpen(true)
      return true
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e, IS_MAC) || e.isComposing) return
      if (openRef.current) {
        e.preventDefault()
        setOpen(false)
      } else if (!e.repeat && show()) e.preventDefault()
    }
    const onOpen = () => {
      if (!openRef.current) show()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener(OPEN_EVENT, onOpen)
    }
  }, [])

  // Keep the active option in view as the keyboard moves it.
  useEffect(() => {
    if (open && current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
  }, [open, current, optionId, results])

  const pick = (i: number) => {
    const r = results[i]
    if (!r) return
    setOpen(false)
    const target = commandTarget(r.cmd)
    // An action on the screen already showing replaces the entry: its `d` is dropped on arrival, and Back
    // shouldn't step through a copy of where you already were.
    navigate(target, { replace: r.cmd.kind === 'action' && target.screen === parseHash(location.hash).screen })
  }

  const move = (delta: number) => {
    const n = results.length
    if (!n) return
    setActive((current + delta + n) % n)
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    const ctrlOnly = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (e.key === 'ArrowDown' || (ctrlOnly && e.key === 'n')) move(1)
    else if (e.key === 'ArrowUp' || (ctrlOnly && e.key === 'p')) move(-1)
    else if (e.key === 'PageDown') setActive(Math.min(current + 5, results.length - 1))
    else if (e.key === 'PageUp') setActive(Math.max(current - 5, 0))
    else if (e.key === 'Enter' && !e.nativeEvent.isComposing) pick(current)
    else if (e.key === 'Escape' && query) {
      // First Esc clears the search; the next one closes (the dialog's own cancel).
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
      setActive(0)
    } else return
    if (e.key !== 'Escape') e.preventDefault()
  }

  const mod = IS_MAC ? '⌘' : 'Ctrl'
  return (
    <Dialog
      open={open}
      onClose={() => setOpen(false)}
      width={560}
      title="Where to?"
      footer={
        <>
          <span className="scr-cmdk-keys ui-foot-start">
            <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> {query ? 'clear' : 'close'}</span>
          </span>
          <span className="scr-cmdk-keys">
            <span><kbd>{mod}</kbd><kbd>K</kbd> anywhere</span>
          </span>
        </>
      }
    >
      <div className="scr-cmdk" ref={rootRef}>
        <TextInput
          autoFocus
          className="scr-cmdk-input"
          role="combobox"
          aria-label="Search screens and actions"
          aria-expanded={results.length > 0}
          aria-controls={results.length ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          placeholder="Search screens and actions"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={onKeyDown}
        />
        {results.length ? (
          <PaletteList
            results={results}
            grouped={grouped}
            active={current}
            here={here}
            listId={listId}
            optionId={optionId}
            onPick={pick}
            onHover={setActive}
          />
        ) : (
          <EmptyState title="No matches" body={<>Try a screen — “taxes”, “cash” — or an action like “import”.</>} />
        )}
        <div className="ui-sr" role="status">
          {grouped ? '' : `${results.length} result${results.length === 1 ? '' : 's'}`}
        </div>
      </div>
    </Dialog>
  )
}
