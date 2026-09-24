import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode, type RefCallback } from 'react'
import { lastRoute, RouteScope, useRoute, useSectionVisit, type Route, type ScreenId } from '../router'
import { prefersReducedMotion } from './motion'
import './ui.css'

/**
 * Every screen App has shown stays mounted (React <Activity>): switching away
 * hides it, keeps its state, and tears down its effects; switching back runs
 * them again. These hooks tell a component which screen it lives on and
 * whether that screen is the one showing — for the things <Activity> can't
 * hide on its own (portals) and the things only the showing screen may do
 * (scroll to a section, write the URL).
 */

type ScreenCtx = { id: ScreenId; active: boolean; headerHost: HTMLElement | null }
const ScreenContext = createContext<ScreenCtx | null>(null)

/** App wraps each screen in one. `headerHost` is that screen's slot in the page header (see HeaderSlot). */
export function ScreenProvider(p: { id: ScreenId; active: boolean; headerHost: HTMLElement | null; children: ReactNode }) {
  const { id, active, headerHost } = p
  const value = useMemo(() => ({ id, active, headerHost }), [id, active, headerHost])
  return (
    <RouteScope.Provider value={id}>
      <ScreenContext.Provider value={value}>{p.children}</ScreenContext.Provider>
    </RouteScope.Provider>
  )
}

function useScreenContext(): ScreenCtx {
  const c = useContext(ScreenContext)
  if (!c) throw new Error('useScreen() is only available inside a screen (App’s ScreenProvider)')
  return c
}

/** Which screen this component is on, and whether that screen is showing. */
export function useScreen(): { id: ScreenId; active: boolean } {
  const { id, active } = useScreenContext()
  return useMemo(() => ({ id, active }), [id, active])
}

/** This screen's header slot element, or null before App has rendered it. For HeaderSlot. */
export function useHeaderHost(): HTMLElement | null {
  return useScreenContext().headerHost
}

const blank = (id: ScreenId): Route => ({ screen: id, rest: [], params: {}, state: {} })

/**
 * The route as this screen sees it: live while the screen is showing, and
 * frozen at what it was when the screen was left while it's hidden. Read a
 * screen's own params through this rather than useRoute, or a hidden screen
 * sees another screen's query and resets its filters.
 */
export function useScreenRoute(): Route {
  const { id } = useScreenContext()
  const route = useRoute()
  return route.screen === id ? route : (lastRoute(id) ?? blank(id))
}

/** The DOM id a section anchor gets: unique across screens, since every visited screen stays in the document. */
export const anchorId = (screen: ScreenId, section: string) => `${screen}-${section}`

const PULSE_MS = 1000

/**
 * Make an element a section that a URL can point at: '#/tax/paychecks'
 * scrolls the Taxes screen to the element given useAnchor('paychecks'), and
 * pulses a gold outline on it for a second. Fires when the screen is revealed
 * on that route, when the route moves to the section while it's showing, and
 * when a link or command points at the section the URL already shows; an
 * element that renders later (after its data loads) is scrolled to then.
 * It overrides the screen's remembered scroll position.
 *
 * Sets the element's id (anchorId) — don't pass an id of your own.
 */
export function useAnchor(section: string): RefCallback<HTMLElement> {
  const { id, active } = useScreenContext()
  const route = useRoute()
  const [node, setNode] = useState<HTMLElement | null>(null)
  const ref = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        el.id = anchorId(id, section)
        el.classList.add('ui-anchor')
      }
      setNode(el)
    },
    [id, section],
  )
  const targeted = active && route.screen === id && route.rest[0] === section
  // Bumps on every navigation to a section — the one already in the URL included, which moves no route.
  const visit = useSectionVisit()
  useEffect(() => {
    if (!targeted || !node) return
    node.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    node.classList.remove('ui-anchor-pulse')
    void node.offsetWidth // restart the animation if it was mid-pulse
    node.classList.add('ui-anchor-pulse')
    const t = setTimeout(() => node.classList.remove('ui-anchor-pulse'), PULSE_MS)
    return () => {
      clearTimeout(t)
      node.classList.remove('ui-anchor-pulse')
    }
  }, [targeted, node, visit])
  return ref
}
