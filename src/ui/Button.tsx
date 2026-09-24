import { useCallback, useLayoutEffect, useRef, type ButtonHTMLAttributes, type MouseEvent, type Ref } from 'react'
import { assignRef } from './refs'
import './ui.css'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'gold' | 'ghost' | 'danger'
  size?: 'md' | 'mini'
  /** An action is running: a spinner covers the label and clicks are ignored, without the button changing size. */
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}

const VARIANT = { default: '', gold: ' gold', ghost: ' ghosty', danger: ' danger' } as const

/**
 * The app's `.btn`, with a busy state. `type` defaults to "button" so a
 * button inside a form never submits it by accident — pass type="submit" for
 * the one that should.
 *
 * While busy the button stays focusable (aria-disabled, not disabled, so a
 * keyboard user's focus isn't dropped mid-save) and its width is held at what
 * it measured before, even if the caller swaps the label.
 */
export function Button({ variant = 'default', size = 'md', busy = false, className, children, type, onClick, ref, style, ...rest }: ButtonProps) {
  const el = useRef<HTMLButtonElement | null>(null)
  const idleWidth = useRef<number | null>(null)
  const setRef = useCallback(
    (node: HTMLButtonElement | null) => {
      el.current = node
      assignRef(ref, node)
    },
    [ref],
  )
  // Measure only when idle and only when what could change the width changes
  // (a string label, or the busy flag) — not on every render of every button.
  const label = typeof children === 'string' || typeof children === 'number' ? children : null
  useLayoutEffect(() => {
    if (!busy && el.current) idleWidth.current = el.current.offsetWidth
  }, [busy, label])

  const cls = `btn${VARIANT[variant]}${size === 'mini' ? ' mini' : ''}${busy ? ' ui-busy' : ''}${className ? ` ${className}` : ''}`
  return (
    <button
      {...rest}
      ref={setRef}
      type={type ?? 'button'}
      className={cls}
      aria-busy={busy || undefined}
      aria-disabled={busy || rest['aria-disabled'] || undefined}
      style={busy && idleWidth.current ? { ...style, minWidth: idleWidth.current } : style}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (busy) {
          e.preventDefault() // also keeps a busy submit button from resubmitting its form
          return
        }
        onClick?.(e)
      }}
    >
      <span className="ui-btn-label">{children}</span>
      {busy && (
        <span className="ui-btn-spin" aria-hidden="true">
          <span className="ui-spinner" />
        </span>
      )}
    </button>
  )
}
