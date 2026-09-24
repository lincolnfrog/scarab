import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { FOCUSABLE } from './refs'
import './ui.css'

const GAP = 6 // px between anchor and popover
const EDGE = 8 // px kept clear of the viewport edge

/** Where a floating box goes: below the anchor (above if it doesn't fit), aligned to one edge, clamped to the viewport. */
export function placeBelow(a: DOMRect, w: number, h: number, align: 'start' | 'end'): { top: number; left: number; side: 'top' | 'bottom' } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const fitsBelow = a.bottom + GAP + h <= vh - EDGE
  const fitsAbove = a.top - GAP - h >= EDGE
  const side = !fitsBelow && fitsAbove ? 'top' : 'bottom'
  const top = side === 'bottom' ? a.bottom + GAP : a.top - GAP - h
  const left = align === 'end' ? a.right - w : a.left
  return { top, left: Math.max(EDGE, Math.min(left, vw - w - EDGE)), side }
}

/** The element a floating box should be portaled into: an open modal <dialog> around the anchor (the rest of the page is inert), else <body>. */
export function portalHost(anchor: HTMLElement | null): HTMLElement {
  return anchor?.closest('dialog') ?? document.body
}

/**
 * A floating panel under an anchor (the sync chip's status panel, a Set price
 * form). Controlled: the parent owns `open`. Closes on Esc (focus returns to
 * the anchor), on a pointer press outside the panel and anchor, and when
 * focus moves elsewhere. Focus moves into the panel on open; Tab past either
 * end returns to the anchor, and so does the parent closing it (a save or a
 * Cancel inside it) while focus is still in the panel.
 *
 * The panel is portaled (so no card's overflow clips it) and rendered only
 * while its effects are live — <Activity> hiding the screen unmounts it and
 * revealing the screen brings it back.
 */
export function Popover(p: {
  open: boolean
  onClose: () => void
  anchor: RefObject<HTMLElement | null>
  align?: 'start' | 'end'
  children: ReactNode
  /** Names the panel for assistive tech (and gives it role="dialog"). */
  'aria-label'?: string
  className?: string
}): JSX.Element | null {
  const { open, anchor, align = 'start' } = p
  const ref = useRef<HTMLDivElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: 'top' | 'bottom' } | null>(null)
  const onClose = useRef(p.onClose)
  useLayoutEffect(() => {
    onClose.current = p.onClose
  })

  useLayoutEffect(() => {
    if (!open) return
    setHost(portalHost(anchor.current))
    return () => {
      setHost(null)
      setPos(null)
      // Closed by the parent (a save, a Cancel) with focus inside: the panel is gone or about to go, and focus
      // with it — to <body>, the top of the page. Hand it back to the anchor, as Esc does. Focus that has
      // already moved on (a click elsewhere, the next field) is left where it is.
      const a = document.activeElement
      if (a === null || a === document.body || !!ref.current?.contains(a)) anchor.current?.focus({ preventScroll: true })
    }
  }, [open, anchor])

  // Place it before first paint, then keep it glued to the anchor through scrolls and resizes.
  useLayoutEffect(() => {
    if (!host) return
    const place = () => {
      const a = anchor.current
      const el = ref.current
      if (!a || !el) return
      setPos(placeBelow(a.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, align))
    }
    place()
    const el = ref.current
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true })
    let raf = 0
    const onMove = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(place)
    }
    // Content that changes size while open (a status line updating) re-places it too.
    const ro = new ResizeObserver(onMove)
    if (el) ro.observe(el)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [host, anchor, align])

  useEffect(() => {
    if (!host) return
    const inside = (t: EventTarget | null) => t instanceof Node && (!!ref.current?.contains(t) || !!anchor.current?.contains(t))
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) onClose.current()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Ours, not an enclosing dialog's: cancelling the keydown stops the dialog's close request.
      e.preventDefault()
      e.stopPropagation()
      onClose.current()
      anchor.current?.focus()
    }
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) onClose.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('focusin', onFocusIn)
    }
  }, [host, anchor])

  // Tab off either end goes back to the anchor rather than to the end of <body>, where the portal lives.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Tab' || !ref.current) return
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
    const first = items[0]
    const last = items[items.length - 1]
    const a = document.activeElement
    if (items.length === 0 || (e.shiftKey && a === first) || (!e.shiftKey && a === last)) {
      e.preventDefault()
      onClose.current()
      anchor.current?.focus()
    }
  }

  if (!open || !host) return null
  return createPortal(
    <div
      ref={ref}
      className={p.className ? `ui-pop ${p.className}` : 'ui-pop'}
      role={p['aria-label'] ? 'dialog' : undefined}
      aria-label={p['aria-label']}
      tabIndex={-1}
      data-side={pos?.side}
      // Off-screen (not hidden) until measured: a hidden element can't take focus.
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      onKeyDown={onKeyDown}
    >
      {p.children}
    </div>,
    host,
  )
}
