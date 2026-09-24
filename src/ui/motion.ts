import { useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'

/**
 * Motion in Scarab is CSS-first: the tokens live on :root in styles.css
 * (--ease-out, --ease-io, --dur-1…4) and the reduced-motion kill-switch there
 * turns every transition and animation off. This module is the JS side of the
 * same contract — for timing a DOM removal to an exit transition, and for the
 * View Transitions API, which the CSS kill-switch cannot veto on its own.
 */

/** Milliseconds matching the --dur-* tokens in styles.css. Keep them in step. */
export const DUR = { 1: 90, 2: 180, 3: 280, 4: 600 } as const

const QUERY = '(prefers-reduced-motion: reduce)'

function mediaQuery(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : null
}

/** The current preference, read on demand (no subscription) — for event handlers and timers. */
export function prefersReducedMotion(): boolean {
  return mediaQuery()?.matches ?? false
}

function subscribe(onChange: () => void): () => void {
  const mq = mediaQuery()
  if (!mq) return () => undefined
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

/** True when the person asked the OS for less motion. Re-renders if they change it while the tab is open. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false)
}

type ViewTransitionLike = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> }
type DocumentWithVT = Document & { startViewTransition?: (update: () => void) => ViewTransitionLike }

/**
 * Run a state update as a view transition when the browser supports one and
 * motion is allowed; otherwise just run it. The update is flushed
 * synchronously inside the transition callback so React commits the new DOM
 * before the browser takes the "after" snapshot.
 *
 * The update always runs exactly once. A transition the browser skips (hidden
 * tab, superseded by the next navigation) still applies the update, so the
 * resulting promise rejections are expected and swallowed; a throw from the
 * update itself is logged rather than lost.
 */
export function withViewTransition(update: () => void): void {
  const doc = typeof document !== 'undefined' ? (document as DocumentWithVT) : null
  if (!doc?.startViewTransition || prefersReducedMotion() || doc.visibilityState === 'hidden') {
    update()
    return
  }
  const t = doc.startViewTransition(() => flushSync(update))
  t.ready.catch(() => undefined)
  t.finished.catch(() => undefined)
  t.updateCallbackDone.catch((e: unknown) => console.error('view transition update failed:', e))
}
