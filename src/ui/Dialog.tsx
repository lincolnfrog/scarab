import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { DUR, useReducedMotion } from './motion'
import { FOCUSABLE } from './refs'
import './ui.css'

export type DialogProps = {
  open: boolean
  onClose: () => void
  variant?: 'modal' | 'drawer'
  /** px; modal 440, drawer 520. Always capped to the viewport. */
  width?: number
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  /**
   * What takes focus on open. Default: a src/ui input given `autoFocus` (it
   * carries data-autofocus — React's own autoFocus fires before showModal and
   * is lost), else the first focusable control in the body, then the footer.
   */
  initialFocus?: RefObject<HTMLElement | null>
  /** false while busy: Esc, the backdrop and the ✕ do nothing. */
  dismissible?: boolean
}

/**
 * A modal on the native <dialog> + showModal(): the browser supplies the top
 * layer, the ::backdrop, the focus trap and inertness of the page behind.
 * This component adds what it doesn't — controlled open/close, a dismissal
 * policy, initial focus, focus return, and an exit animation (the content
 * stays mounted until the fade-out ends, then unmounts).
 *
 * Every way the dialog stops being shown goes through one cleanup that calls
 * close(): `open` turning false, unmounting, and <Activity> hiding the screen
 * it lives on (a modal left open inside a display:none tree would leave the
 * whole page inert and invisible). Reappearing re-opens it.
 */
export function Dialog(p: DialogProps) {
  const { open, variant = 'modal', dismissible = true } = p
  const reduced = useReducedMotion()
  const ref = useRef<HTMLDialogElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const subId = useId()

  // Stay rendered through the exit transition after `open` turns false.
  const [exiting, setExiting] = useState(false)
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    setExiting(!open)
  }
  useEffect(() => {
    if (!exiting) return
    const t = setTimeout(() => setExiting(false), reduced ? 0 : (variant === 'drawer' ? DUR[3] : DUR[2]) + 40)
    return () => clearTimeout(t)
  }, [exiting, reduced, variant])

  // Handlers read the latest props without re-running the open effect.
  const latest = useRef({ onClose: p.onClose, dismissible, open, initialFocus: p.initialFocus })
  useLayoutEffect(() => {
    latest.current = { onClose: p.onClose, dismissible, open, initialFocus: p.initialFocus }
  })
  // close() calls we make ourselves; the (async) 'close' event consumes one each.
  const ourCloses = useRef(0)
  const downOutside = useRef(false)

  useLayoutEffect(() => {
    const dlg = ref.current
    if (!open || !dlg) return
    const opener = document.activeElement instanceof HTMLElement && !dlg.contains(document.activeElement) ? document.activeElement : null
    if (!dlg.open && dlg.isConnected) dlg.showModal()
    const target =
      latest.current.initialFocus?.current ??
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]') ??
      bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      footRef.current?.querySelector<HTMLElement>(FOCUSABLE) ??
      panelRef.current
    target?.focus()
    return () => {
      if (dlg.open) {
        ourCloses.current++
        dlg.close()
      }
      // Browsers restore focus on close; make sure it lands on the opener, not <body>.
      const a = document.activeElement
      if (opener?.isConnected && (!a || a === document.body || dlg.contains(a))) opener.focus()
    }
  }, [open])

  if (!open && !exiting) return null

  const isOutside = (e: { clientX: number; clientY: number; target: EventTarget }) => {
    const dlg = ref.current
    if (!dlg || e.target !== dlg) return false
    const r = dlg.getBoundingClientRect()
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom
  }

  return (
    <dialog
      ref={ref}
      className={`ui-dialog ui-dialog--${variant}`}
      style={p.width ? ({ '--ui-dialog-w': `${p.width}px` } as CSSProperties) : undefined}
      aria-labelledby={titleId}
      aria-describedby={p.subtitle ? subId : undefined}
      onCancel={(e) => {
        // React dispatches a <dialog>'s cancel and close up the component tree,
        // so a Dialog opened from inside this one (a drawer's sub-dialog) would
        // reach these handlers too, and closing it would close us. Only our own count.
        if (e.target !== e.currentTarget) return
        // Esc. We decide; the parent's `open` is the truth.
        e.preventDefault()
        if (latest.current.dismissible) latest.current.onClose()
      }}
      onClose={(e) => {
        if (e.target !== e.currentTarget) return
        if (ourCloses.current > 0) {
          ourCloses.current--
          return
        }
        // The browser closed it on its own (a repeated Esc can skip a cancelled
        // 'cancel'). Report it, or re-open while dismissal is blocked.
        if (!latest.current.open) return
        if (latest.current.dismissible) latest.current.onClose()
        else if (ref.current?.isConnected) ref.current.showModal()
      }}
      onPointerDown={(e: PointerEvent<HTMLDialogElement>) => {
        downOutside.current = isOutside(e)
      }}
      onClick={(e: MouseEvent<HTMLDialogElement>) => {
        // A backdrop click — one that also started on the backdrop, so a text
        // selection dragged out of an input doesn't dismiss.
        if (downOutside.current && isOutside(e) && latest.current.dismissible) latest.current.onClose()
        downOutside.current = false
      }}
    >
      <div className="ui-dialog-panel" ref={panelRef} tabIndex={-1}>
        <div className="ui-dialog-head">
          <div>
            <h2 className="ui-dialog-title" id={titleId}>
              {p.title}
            </h2>
            {p.subtitle && (
              <div className="ui-dialog-sub" id={subId}>
                {p.subtitle}
              </div>
            )}
          </div>
          <button type="button" className="ui-iconbtn" aria-label="Close" disabled={!dismissible} onClick={() => p.onClose()}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="ui-dialog-body" ref={bodyRef}>
          {p.children}
        </div>
        {p.footer && (
          <div className="ui-dialog-foot" ref={footRef}>
            {p.footer}
          </div>
        )}
      </div>
    </dialog>
  )
}

/** A Dialog that slides in from the right edge, full height — for record sheets and detail panels. */
export function Drawer(p: Omit<DialogProps, 'variant'>) {
  return <Dialog {...p} variant="drawer" />
}
