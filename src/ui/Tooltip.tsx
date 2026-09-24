import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react'
import { createPortal } from 'react-dom'
import { portalHost } from './Popover'
import { assignRef } from './refs'
import './ui.css'

const GAP = 8
const EDGE = 8
const FOCUSABLE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary'])

type ChildProps = {
  ref?: Ref<HTMLElement>
  tabIndex?: number
  'aria-describedby'?: string
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: FocusEvent<HTMLElement>) => void
}

/**
 * A short explanation on hover or keyboard focus, in the chart tooltip's
 * .tip skin. Replaces `title=` (which never shows on focus and can't be
 * styled). The child must be a DOM element, or a component that forwards
 * `ref` and these event props; a non-focusable child (a ⚠ glyph) is made
 * focusable so keyboard users can reach the text. Esc hides it.
 *
 * The text is also always present, hidden, as the child's description — so
 * a screen reader hears it on focus without waiting for the delay.
 */
export function Tooltip(p: { content: ReactNode; children: ReactElement; delay?: number; placement?: 'top' | 'bottom' }) {
  const { delay = 250, placement = 'top' } = p
  const id = useId()
  const anchor = useRef<HTMLElement | null>(null)
  const tip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const show = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setHost(portalHost(anchor.current)), delay)
  }
  const hide = () => {
    clearTimeout(timer.current)
    setHost(null)
    setPos(null)
  }
  // Unmounting — or <Activity> hiding the screen — takes the tip down with it.
  useLayoutEffect(
    () => () => {
      clearTimeout(timer.current)
      setHost(null)
      setPos(null)
    },
    [],
  )

  useLayoutEffect(() => {
    const a = anchor.current
    const el = tip.current
    if (!host || !a || !el) return
    const r = a.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const fitsTop = r.top - GAP - h >= EDGE
    const fitsBottom = r.bottom + GAP + h <= window.innerHeight - EDGE
    const top = (placement === 'top' ? fitsTop || !fitsBottom : !fitsBottom && fitsTop) ? r.top - GAP - h : r.bottom + GAP
    const left = Math.max(EDGE, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - EDGE))
    setPos({ top, left })
  }, [host, placement])

  useEffect(() => {
    if (!host) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide()
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [host])

  const child = p.children as ReactElement<ChildProps>
  const cp = child.props
  const childRef = cp.ref
  const setAnchor = useCallback(
    (node: HTMLElement | null) => {
      anchor.current = node
      assignRef(childRef, node)
    },
    [childRef],
  )
  const nativeFocusable = typeof child.type === 'string' && FOCUSABLE_TAGS.has(child.type)
  const trigger = cloneElement(child, {
    ref: setAnchor,
    tabIndex: cp.tabIndex ?? (nativeFocusable || typeof child.type !== 'string' ? undefined : 0),
    'aria-describedby': cp['aria-describedby'] ? `${cp['aria-describedby']} ${id}` : id,
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      cp.onPointerEnter?.(e)
      if (e.pointerType !== 'touch') show()
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      cp.onPointerLeave?.(e)
      hide()
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      cp.onFocus?.(e)
      show()
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      cp.onBlur?.(e)
      hide()
    },
  })

  return (
    <>
      {trigger}
      <span id={id} hidden>
        {p.content}
      </span>
      {host &&
        createPortal(
          <div
            ref={tip}
            className="tip ui-tip"
            aria-hidden="true"
            style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
          >
            {p.content}
          </div>,
          host,
        )}
    </>
  )
}
