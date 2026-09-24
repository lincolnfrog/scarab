import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DUR, prefersReducedMotion } from './motion'
import './ui.css'

/**
 * Toasts: the receipt for every save and the report of every failure.
 * Bottom-right stack, newest nearest the corner. Success and info dismiss
 * themselves (4s / 6s, paused while the pointer is over the stack, focus is
 * inside it, or the tab is hidden); errors stay until dismissed.
 *
 *   toast.success('Saved v43')
 *   toast.error("Couldn't record the trade", { detail: e.message, action: { label: 'Retry', onClick: retry } })
 *
 * The same message raised again while it is still showing refreshes that
 * toast instead of stacking a copy.
 */

export type ToastAction = { label: string; onClick: () => void }
type Kind = 'success' | 'info' | 'error'
type Item = { id: string; kind: Kind; text: string; detail?: string; action?: ToastAction; leaving: boolean; bump: number }

const LIFETIME_MS: Record<Kind, number | null> = { success: 4000, info: 6000, error: null }
const MAX_SHOWN = 4

let items: readonly Item[] = []
let seq = 0
const listeners = new Set<() => void>()

function set(next: readonly Item[]) {
  items = next
  for (const l of listeners) l()
}

function push(kind: Kind, text: string, o: { action?: ToastAction; detail?: string } = {}): string {
  const same = items.find((t) => !t.leaving && t.kind === kind && t.text === text && t.detail === o.detail)
  if (same) {
    // Refresh in place: move it to the newest slot and restart its timer.
    set([...items.filter((t) => t !== same), { ...same, action: o.action, bump: same.bump + 1 }])
    return same.id
  }
  const id = `t${++seq}`
  let next = [...items, { id, kind, text, detail: o.detail, action: o.action, leaving: false, bump: 0 }]
  // Over the cap: the oldest self-dismissing toast goes first; errors are kept.
  while (next.filter((t) => !t.leaving).length > MAX_SHOWN) {
    const victim = next.find((t) => !t.leaving && t.kind !== 'error') ?? next.find((t) => !t.leaving)!
    next = next.filter((t) => t !== victim)
  }
  set(next)
  return id
}

function dismiss(id: string): void {
  const t = items.find((x) => x.id === id)
  if (!t || t.leaving) return
  set(items.map((x) => (x.id === id ? { ...x, leaving: true } : x)))
  setTimeout(() => set(items.filter((x) => x.id !== id)), prefersReducedMotion() ? 0 : DUR[2])
}

export const toast = {
  success: (text: string, o?: { action?: ToastAction }): string => push('success', text, o),
  info: (text: string, o?: { action?: ToastAction }): string => push('info', text, o),
  error: (text: string, o?: { action?: ToastAction; detail?: string }): string => push('error', text, o),
  dismiss,
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => items

/** The toast stack. Mount exactly once, outside any screen. */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot)
  const [hovered, setHovered] = useState(false)
  const [focusWithin, setFocusWithin] = useState(false)
  const hidden = useSyncExternalStore(subscribeVisibility, () => document.visibilityState === 'hidden', () => false)
  const paused = hovered || focusWithin || hidden
  const ref = useRef<HTMLElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  // Removing a toast (its ✕, its action, the cap) sends neither half of the pause's all-clear: the browser fires
  // focusout during React's commit, which React drops, and pointerleave waits for the pointer's next move. After
  // every change to the stack, read both from the document instead — or one click leaves the stack paused for good.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setFocusWithin(el.contains(document.activeElement))
    const p = pointer.current
    if (p) setHovered(el.contains(document.elementFromPoint(p.x, p.y)))
  }, [list])
  return (
    <section
      ref={ref}
      className="ui-toasts"
      aria-label="Notifications"
      aria-live="polite"
      aria-relevant="additions text"
      onPointerEnter={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY }
        setHovered(true)
      }}
      onPointerMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY }
      }}
      onPointerLeave={() => {
        pointer.current = null
        setHovered(false)
      }}
      onFocus={() => setFocusWithin(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusWithin(false)
      }}
    >
      {list.map((t) => (
        <ToastView key={t.id} t={t} paused={paused} />
      ))}
    </section>
  )
}

function subscribeVisibility(l: () => void) {
  document.addEventListener('visibilitychange', l)
  return () => document.removeEventListener('visibilitychange', l)
}

const ICON: Record<Kind, string> = { success: '✓', info: 'i', error: '!' }

function ToastView({ t, paused }: { t: Item; paused: boolean }) {
  const life = LIFETIME_MS[t.kind]
  // Remaining lifetime survives pauses; a refresh (bump) restarts it.
  const remaining = useRef(life ?? 0)
  const seenBump = useRef(t.bump)
  useEffect(() => {
    if (seenBump.current !== t.bump) {
      seenBump.current = t.bump
      remaining.current = life ?? 0
    }
    if (life === null || paused || t.leaving) return
    const started = Date.now()
    const timer = setTimeout(() => dismiss(t.id), remaining.current)
    return () => {
      clearTimeout(timer)
      remaining.current = Math.max(800, remaining.current - (Date.now() - started))
    }
  }, [life, paused, t.leaving, t.id, t.bump])

  return (
    <div className={`ui-toast ui-toast--${t.kind}${t.leaving ? ' leaving' : ''}`}>
      <span className="ui-toast-icon" aria-hidden="true">
        {ICON[t.kind]}
      </span>
      <div className="ui-toast-body">
        <div>{t.text}</div>
        {t.detail && <div className="ui-toast-detail">{t.detail}</div>}
      </div>
      {t.action && (
        <button
          type="button"
          className="ui-toast-action"
          onClick={() => {
            dismiss(t.id)
            t.action!.onClick()
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" className="ui-iconbtn" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
        <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
