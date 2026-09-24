import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Popover } from './Popover'
import './ui.css'

export type MenuItem = { label: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string } | 'sep'

/**
 * A row's overflow menu: a ⋯ button (or a custom trigger label) opening a
 * list of actions. Keyboard: Enter / Space / ↓ open on the first item, ↑ on
 * the last; arrows, Home and End move; Esc or Tab closes back to the button.
 * Selecting closes first, then runs the action — so a confirm() it opens
 * returns focus to the menu button.
 */
export function Menu(p: { items: MenuItem[]; label: string; trigger?: ReactNode; align?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false)
  const btn = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const startAtEnd = useRef(false)
  const menuId = useId()

  const items = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) btn.current?.focus()
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    if (list.length === 0) return
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    let to: number | undefined
    if (e.key === 'ArrowDown') to = (at + 1) % list.length
    else if (e.key === 'ArrowUp') to = (at - 1 + list.length) % list.length
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = list.length - 1
    else if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      close(true)
      return
    }
    if (to === undefined) return
    e.preventDefault()
    list[to]!.focus()
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={p.trigger ? 'btn mini' : 'ui-iconbtn'}
        aria-label={p.label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          startAtEnd.current = false
          setOpen((o) => !o)
        }}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault()
            startAtEnd.current = e.key === 'ArrowUp'
            setOpen(true)
          }
        }}
      >
        {p.trigger ?? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
            <circle cx="8" cy="8" r="1.4" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
          </svg>
        )}
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={btn} align={p.align ?? 'end'}>
        <div
          id={menuId}
          role="menu"
          aria-label={p.label}
          className="ui-menu"
          onKeyDown={onListKey}
          ref={(el) => {
            listRef.current = el
            // Opened with ↑: start on the last item (Popover otherwise focuses the first).
            if (el && startAtEnd.current) {
              startAtEnd.current = false
              items().at(-1)?.focus({ preventScroll: true })
            }
          }}
        >
          {p.items.map((it, i) =>
            it === 'sep' ? (
              <div key={`sep-${i}`} role="separator" className="ui-menu-sep" />
            ) : (
              <button
                key={i}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`ui-menu-item${it.danger ? ' danger' : ''}`}
                disabled={it.disabled}
                onClick={() => {
                  close(true)
                  it.onSelect()
                }}
              >
                {it.label}
                {it.hint && <span className="ui-menu-hint">{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      </Popover>
    </>
  )
}
