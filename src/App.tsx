import {
  Activity,
  memo,
  Suspense,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
  type UIEvent,
} from 'react'
import { exitToHousehold, localMode, takeHouseholdChoice } from './local'
import { lastRoute, navigate, parseHash, SCREENS, useRoute, type ScreenId } from './router'
import type { Mode } from './session'
import { Button } from './ui/Button'
import { CommandPalette, PaletteHint } from './ui/CommandPalette'
import { confirm, DialogHost } from './ui/dialogs'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { announce } from './ui/LiveRegion'
import { ScreenProvider } from './ui/screen'
import { SidebarStatus } from './ui/SidebarStatus'
import { Skeleton } from './ui/Skeleton'
import { SyncChip } from './ui/SyncChip'
import { ToastHost } from './ui/Toast'

/** Each screen's nav icon (24×24 stroke paths). Labels and order live in router.ts SCREENS. */
const ICONS: Record<ScreenId, string> = {
  dash: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  invest: 'M3 17l5-6 4 3 6-8M14 6h4v4',
  re: 'M3 11l9-7 9 7M5 10v10h14V10',
  cash: 'M7 10l-4 4 4 4M3 14h13M17 4l4 4-4 4M21 8H8',
  goal: 'M5 21V4M5 4h13l-3 4 3 4H5',
  tax: 'M19 5L5 19M6.5 4.5a2 2 0 100 4 2 2 0 000-4zM17.5 15.5a2 2 0 100 4 2 2 0 000-4z',
  future:
    'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2',
  compare: 'M3 17l5-6 4 3 9-8M3 9l5 4 4-1 9 6',
  vault: 'M12 3l7 4v5c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V7z M9 12l2 2 4-4',
}

/**
 * Where each screen's code lives. Screens are split out of the entry bundle:
 * the shell paints first, the screen being opened loads alongside the boot
 * questions, and the rest load in the background once the shell is up — so a
 * later visit (or a deploy that replaced the files meanwhile) never waits on
 * the network.
 */
const SCREEN_CODE: Record<ScreenId, () => Promise<{ default: ComponentType }>> = {
  dash: () => import('./screens/Dashboard'),
  invest: () => import('./screens/Invest'),
  re: () => import('./screens/RealEstate'),
  cash: () => import('./screens/Cash'),
  goal: () => import('./screens/Goal'),
  tax: () => import('./screens/Taxes'),
  future: () => import('./screens/Future'),
  compare: () => import('./screens/Compare'),
  vault: () => import('./screens/Vault'),
}

/**
 * Load a module once and share the promise — for use(), which needs the same
 * promise on every render. A failed load is forgotten, so the error card's
 * Retry (a remount) asks the network again.
 */
function loader<T>(load: () => Promise<{ default: T }>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => {
    if (!p) {
      const mine = load().then((m) => m.default)
      p = mine
      // Settled promises carry their result where use() reads it synchronously (React's thenable fields), so
      // a remount of code already loaded — every screen, on a data swap — renders at once, never a fallback.
      mine.then(
        (value) => Object.assign(mine, { status: 'fulfilled', value }),
        (reason: unknown) => {
          Object.assign(mine, { status: 'rejected', reason })
          if (p === mine) p = null
        },
      )
    }
    return p
  }
}
const screenCode = Object.fromEntries(SCREENS.map((s) => [s.id, loader(SCREEN_CODE[s.id])])) as Record<ScreenId, () => Promise<ComponentType>>
const frontDoorCode = loader(() => import('./FrontDoor'))

/** Fetch every screen's code while the tab is idle, after the first screen has painted. */
function preloadScreens(): () => void {
  const run = () => {
    for (const s of SCREENS) void screenCode[s.id]().catch(() => {}) // a failure resurfaces (with Retry) if that screen is opened
  }
  if (typeof requestIdleCallback === 'function') {
    const h = requestIdleCallback(run, { timeout: 5000 })
    return () => cancelIdleCallback(h)
  }
  const t = setTimeout(run, 1500)
  return () => clearTimeout(t)
}

function LazyScreen({ id }: { id: ScreenId }) {
  const Screen = use(screenCode[id]())
  return <Screen />
}

function LazyFrontDoor(p: { mode: Mode; onEnter: () => void; onHousehold: () => void }) {
  const FrontDoor = use(frontDoorCode())
  return <FrontDoor {...p} />
}

const LABEL = Object.fromEntries(SCREENS.map((s) => [s.id, s.label])) as Record<ScreenId, string>

type Me = { email: string }
type Boot = { phase: 'loading' } | { phase: 'failed'; reason: string } | { phase: 'ready'; me: Me | null; mode: Mode }

/** How long the first question (/api/mode) may take before the page says it can't reach the server. */
const BOOT_TIMEOUT_MS = 10_000

function isMode(v: unknown): v is Mode {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  const vault = m.vault as Record<string, unknown> | null | undefined
  return (
    typeof m.serverHasData === 'boolean' &&
    typeof m.zkOnly === 'boolean' &&
    (m.household === null || typeof m.household === 'string') &&
    (vault === null || (typeof vault === 'object' && typeof vault?.version === 'number' && typeof vault.updated_at === 'string'))
  )
}

/**
 * The two questions every visit starts with: who is this (IAP), and what kind
 * of server is it — household (plaintext) or vault-only. Raw fetches, not
 * api.ts: these are always the network's answers.
 */
async function loadBoot(signal: AbortSignal): Promise<{ me: Me | null; mode: Mode }> {
  const me = fetch('/api/me', { signal })
    .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
    .then((b) => (b && typeof (b as Me).email === 'string' ? { email: (b as Me).email } : null))
    .catch(() => null)
  let r: Response
  try {
    r = await fetch('/api/mode', { signal })
  } catch (e) {
    if (signal.aborted) throw e
    throw new Error('The request didn’t go through — this device may be offline, or the server is down.')
  }
  if (!r.ok) throw new Error(`The server answered ${r.status}${r.statusText ? ` ${r.statusText}` : ''}.`)
  const mode: unknown = await r.json().catch(() => null)
  if (!isMode(mode)) throw new Error('The server’s answer isn’t one this version of Scarab understands.')
  return { me: await me, mode }
}

export default function App() {
  const [boot, setBoot] = useState<Boot>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // The front door owns the tab until a session is unlocked, created, or the
  // household escape hatch is taken — even while a session is already booting
  // behind it (creating a vault starts the engine once its checks and passkey
  // pass, before the upload that can still fail).
  const [entered, setEntered] = useState(false)
  // Also true on the load right after the hatch had to end a session to honour it (see chooseHousehold).
  const [choseHousehold, setChoseHousehold] = useState(takeHouseholdChoice)

  // The screen being opened loads alongside the boot questions rather than after them.
  useEffect(() => {
    void screenCode[parseHash(location.hash).screen]().catch(() => {}) // a failure resurfaces (with Retry) when it renders
  }, [])

  useEffect(() => {
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, BOOT_TIMEOUT_MS)
    loadBoot(ac.signal)
      .then(
        (r) => {
          // Before the front door can enter a session: the in-tab engine attributes digests and imports to it.
          localMode.setIdentity(r.me?.email ?? null)
          setBoot({ phase: 'ready', ...r })
        },
        (e: unknown) => {
          if (ac.signal.aborted && !timedOut) return // superseded (unmount, StrictMode's second mount)
          setBoot({
            phase: 'failed',
            reason: timedOut ? `No answer within ${BOOT_TIMEOUT_MS / 1000} seconds.` : e instanceof Error ? e.message : String(e),
          })
        },
      )
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      ac.abort()
    }
  }, [attempt])

  const retry = useCallback(() => {
    setBoot({ phase: 'loading' })
    setAttempt((n) => n + 1)
  }, [])

  /**
   * The front door's household escape hatch. A session may already be running
   * behind the door — Create vault starts the engine after its checks and
   * passkey, and a create that fails after that leaves it up (clean) — and
   * while one is, every /api call is answered from this tab. Household mode
   * means the server's data, so the session ends first (a reload that lands
   * in household mode).
   */
  const chooseHousehold = useCallback(async () => {
    if (!localMode.active) return setChoseHousehold(true)
    if (
      localMode.vault &&
      !(await confirm({
        title: 'Switch to household mode?',
        body: 'This ends the vault session in this tab. The vault stays stored — unlock it from the front door any time. If the recovery code is showing, file it first: it isn’t shown again.',
        confirmLabel: 'Switch to household mode',
      }))
    )
      return
    exitToHousehold()
  }, [])

  let body: ReactNode
  if (boot.phase === 'loading') body = <Splash />
  // Never a household fallback: guessing wrong would send plaintext to a server that must only see ciphertext.
  else if (boot.phase === 'failed') body = <Unreachable reason={boot.reason} onRetry={retry} />
  else {
    const { mode } = boot
    // The front door appears only when the server holds no plaintext; a vault-only server never runs household mode.
    const household = !mode.zkOnly && (mode.serverHasData || choseHousehold)
    body =
      household || entered ? (
        <Shell me={boot.me} />
      ) : (
        <Suspense fallback={<Splash />}>
          <LazyFrontDoor mode={mode} onEnter={() => setEntered(true)} onHousehold={() => void chooseHousehold()} />
        </Suspense>
      )
  }

  return (
    <>
      <ErrorBoundary label="Scarab">{body}</ErrorBoundary>
      <DialogHost />
      <CommandPalette />
      <ToastHost />
    </>
  )
}

/* ---------- the shell: sidebar, topbar, and every screen visited so far ---------- */

// Which data universe the screens are reading: household or this tab's session, and which load of it.
// Any change remounts every screen (a session started, a vault was unlocked or replaced in place).
const subscribeData = (l: () => void) => {
  window.addEventListener('scarab-mode', l)
  window.addEventListener('scarab-data', l)
  return () => {
    window.removeEventListener('scarab-mode', l)
    window.removeEventListener('scarab-data', l)
  }
}
const dataKey = () => `${localMode.active ? 's' : 'h'}${localMode.dataEpoch}`

function Shell({ me }: { me: Me | null }) {
  const route = useRoute()
  const active = route.screen
  const label = LABEL[active]
  const data = useSyncExternalStore(subscribeData, dataKey, dataKey)

  // Screens mount on first visit and then stay mounted (hidden) for the life of the tab.
  const [visited, setVisited] = useState<readonly ScreenId[]>(() => [active])
  if (!visited.includes(active)) setVisited([...visited, active])
  const shown = useMemo(() => SCREENS.filter((s) => visited.includes(s.id)), [visited])

  // Once the shell is up, the other screens' code comes down in the background.
  useEffect(preloadScreens, [])

  // Each screen's own slot in the header, for HeaderSlot portals.
  const [hosts, setHosts] = useState<Partial<Record<ScreenId, HTMLElement>>>({})
  const hostRef = useMemo(() => {
    const cache = new Map<ScreenId, (el: HTMLDivElement | null) => void>()
    return (id: ScreenId) => {
      let f = cache.get(id)
      if (!f) {
        f = (el) => setHosts((h) => (h[id] === (el ?? undefined) ? h : { ...h, [id]: el ?? undefined }))
        cache.set(id, f)
      }
      return f
    }
  }, [])

  // Scroll position per screen: recorded as it scrolls, restored when the screen comes back.
  // (A section anchor in the route scrolls afterwards and wins — see useAnchor.)
  const scroller = useRef<HTMLElement>(null)
  const scrollTops = useRef(new Map<ScreenId, number>())
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = scrollTops.current.get(active) ?? 0
  }, [active])
  const onScroll = (e: UIEvent<HTMLElement>) => scrollTops.current.set(active, e.currentTarget.scrollTop)

  // After a navigation (not the first screen of the visit): focus the new heading and say where we are.
  const h1 = useRef<HTMLHeadingElement>(null)
  const lastShown = useRef<ScreenId | null>(null)
  useEffect(() => {
    document.title = `${label} · Scarab`
    const prev = lastShown.current
    lastShown.current = active
    if (prev === null || prev === active) return
    h1.current?.focus({ preventScroll: true })
    announce(label)
  }, [active, label])

  // The gold indicator slides between nav items; it appears without sliding the first time.
  const nav = useRef<HTMLElement>(null)
  const [ind, setInd] = useState<{ top: number; height: number } | null>(null)
  const [indReady, setIndReady] = useState(false)
  useLayoutEffect(() => {
    const el = nav.current
    if (!el) return
    const measure = () => {
      const b = el.querySelector<HTMLElement>('button[aria-current="page"]')
      if (b) setInd((p) => (p && p.top === b.offsetTop && p.height === b.offsetHeight ? p : { top: b.offsetTop, height: b.offsetHeight }))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [active])
  useEffect(() => {
    if (!ind || indReady) return
    const raf = requestAnimationFrame(() => setIndReady(true))
    return () => cancelAnimationFrame(raf)
  }, [ind, indReady])

  return (
    <div className="app">
      <a
        className="skiplink"
        href="#main"
        onClick={(e) => {
          e.preventDefault() // a real "#main" would read as a route
          h1.current?.focus()
        }}
      >
        Skip to content
      </a>
      <aside className="side">
        <div className="logo">
          <ScarabMark size={26} />
          <span>SCARAB</span>
        </div>
        <nav ref={nav} className={ind ? 'nav has-ind' : 'nav'} aria-label="Screens">
          {ind && (
            <span
              className={indReady ? 'nav-ind ready' : 'nav-ind'}
              style={{ transform: `translateY(${ind.top}px)`, height: ind.height }}
              aria-hidden="true"
            />
          )}
          {SCREENS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={s.id === active ? 'on' : undefined}
              aria-current={s.id === active ? 'page' : undefined}
              // Back to where that screen was left: its filters (params) are part of what it's showing.
              onClick={() => navigate({ screen: s.id, params: lastRoute(s.id)?.params })}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={ICONS[s.id]} />
              </svg>
              {s.label}
            </button>
          ))}
        </nav>
        <SidebarStatus />
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="where">
            Scarab {data.startsWith('s') ? 'session' : 'household'} · <b>{label}</b>
          </span>
          <PaletteHint />
          <SyncChip />
          <span className="who">
            {me ? (
              <>
                signed in as <b>{me.email}</b>
                {me.email !== 'dev@localhost' && ' · via IAP'}
              </>
            ) : (
              'not signed in'
            )}
          </span>
        </div>

        <main id="main" className="screens" ref={scroller} onScroll={onScroll}>
          <div className="shead">
            <h1 ref={h1} tabIndex={-1}>
              {label}
            </h1>
            {shown.map((s) => (
              <div key={s.id} className="shead-slot" hidden={s.id !== active} ref={hostRef(s.id)} />
            ))}
          </div>
          {shown.map((s) => (
            <ScreenSlot key={s.id} id={s.id} label={s.label} active={s.id === active} data={data} headerHost={hosts[s.id] ?? null} />
          ))}
        </main>
      </div>
    </div>
  )
}

/**
 * One screen, kept alive. <Activity> hides it (display:none, effects torn
 * down, state kept) instead of unmounting it; revealing it re-runs its
 * effects, so it refetches quietly behind what it already shows. The error
 * boundary is keyed on the data universe: new data remounts the screen from
 * scratch, and clears a crash. On a first visit whose code hasn't arrived
 * yet, a placeholder stands in; code that fails to load is a crash like any
 * other (Retry loads it again).
 */
const ScreenSlot = memo(function ScreenSlot(p: { id: ScreenId; label: string; active: boolean; data: string; headerHost: HTMLElement | null }) {
  // The same element across reveals, so only what reads useScreen() re-renders when the screen shows or hides.
  const content = useMemo(
    () => (
      <ErrorBoundary key={p.data} label={p.label}>
        <Suspense fallback={<ScreenLoading label={p.label} />}>
          <LazyScreen id={p.id} />
        </Suspense>
      </ErrorBoundary>
    ),
    [p.data, p.label, p.id],
  )
  return (
    <Activity mode={p.active ? 'visible' : 'hidden'} name={p.id}>
      <ScreenProvider id={p.id} active={p.active} headerHost={p.headerHost}>
        {content}
      </ScreenProvider>
    </Activity>
  )
})

/** A screen whose code is still on its way: the shape of a card grid, quietly shimmering. */
function ScreenLoading({ label }: { label: string }) {
  return (
    <div className="grid12 screen-loading" role="status" aria-label={`Loading ${label}`}>
      {['c12', 'c7', 'c5'].map((c) => (
        <div key={c} className={`card ${c}`}>
          <Skeleton h={11} w={120} />
          <Skeleton h={28} w="45%" />
          <Skeleton h={90} />
        </div>
      ))}
    </div>
  )
}

/* ---------- before the shell ---------- */

function ScarabMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 44 44" fill="none" aria-hidden="true">
      <circle cx="22" cy="9" r="5" stroke="var(--gold)" strokeWidth="2.6" />
      <ellipse cx="22" cy="27" rx="10" ry="11" stroke="var(--gold)" strokeWidth="2.6" />
      <path d="M22 16v22" stroke="var(--gold)" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  )
}

/**
 * index.html's splash, re-rendered by React while the boot questions are out.
 * Its fade-in is delayed so a fast load never shows it; the negative delay
 * picks the animation up where the static copy left off instead of restarting it.
 */
function Splash() {
  return (
    <div className="boot-splash" role="status" aria-label="Loading Scarab" style={{ animationDelay: `${Math.round(250 - performance.now())}ms` }}>
      <ScarabMark size={44} />
    </div>
  )
}

function Unreachable({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  const retryRef = useRef<HTMLButtonElement>(null)
  useEffect(() => retryRef.current?.focus(), [])
  // Coming back online is a retry nobody should have to click.
  useEffect(() => {
    window.addEventListener('online', onRetry)
    return () => window.removeEventListener('online', onRetry)
  }, [onRetry])
  return (
    <div className="frontdoor">
      <div className="card bootfail" role="alert">
        <div className="logo">
          <ScarabMark size={26} />
          <span>SCARAB</span>
        </div>
        <h2>Can’t reach Scarab</h2>
        <p>
          Every visit starts by asking the server what kind it is — one that keeps the household’s data, or one that
          only stores an encrypted vault. It didn’t answer, and Scarab won’t guess: guessing wrong could send your data
          to a server that should never see it.
        </p>
        <div className="bootfail-why">{reason}</div>
        <div className="formrow">
          <Button ref={retryRef} variant="gold" onClick={onRetry}>
            Retry
          </Button>
          <span className="muted">Still failing? Reload the page — your sign-in may have expired.</span>
        </div>
      </div>
    </div>
  )
}
