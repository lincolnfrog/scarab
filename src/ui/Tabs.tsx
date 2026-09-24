import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import './ui.css'

/** The id Tabs gives the tab for `value` — for the caller's panel: `aria-labelledby={tabId(prefix, value)}`. */
export const tabId = (idPrefix: string, value: string) => `${idPrefix}-tab-${value}`

/**
 * Underline tabs for switching panels inside one surface (the account
 * drawer's Positions · Activity · Grants · Settings). The caller renders the
 * active panel. Arrow keys move between tabs and select as they go; one tab
 * stop for the whole strip.
 */
export function Tabs<T extends string>(p: {
  value: T
  tabs: { value: T; label: ReactNode; badge?: ReactNode }[]
  onChange: (v: T) => void
  'aria-label': string
  /** Stable prefix for the tab ids (see tabId); defaults to a generated one. */
  idPrefix?: string
}) {
  const generated = useId()
  const prefix = p.idPrefix ?? generated
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const selected = Math.max(0, p.tabs.findIndex((t) => t.value === p.value))

  const onKeyDown = (e: KeyboardEvent) => {
    const n = p.tabs.length
    if (n === 0) return
    const at = Math.max(0, refs.current.findIndex((el) => el === document.activeElement))
    let to: number | undefined
    if (e.key === 'ArrowRight') to = (at + 1) % n
    else if (e.key === 'ArrowLeft') to = (at - 1 + n) % n
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = n - 1
    if (to === undefined) return
    e.preventDefault()
    refs.current[to]?.focus()
    const t = p.tabs[to]!
    if (t.value !== p.value) p.onChange(t.value)
  }

  return (
    <div role="tablist" aria-label={p['aria-label']} className="ui-tabs" onKeyDown={onKeyDown}>
      {p.tabs.map((t, i) => (
        <button
          key={t.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          id={tabId(prefix, t.value)}
          type="button"
          role="tab"
          className="ui-tab"
          aria-selected={i === selected}
          tabIndex={i === selected ? 0 : -1}
          onClick={() => t.value !== p.value && p.onChange(t.value)}
        >
          {t.label}
          {t.badge != null && <span className="ui-tab-badge">{t.badge}</span>}
        </button>
      ))}
    </div>
  )
}
