import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import './ui.css'

/**
 * A small exclusive choice (Buy / Sell, Value / Rebased / % change) as the
 * mockup's pill group: the active option on --card-hi, never gold. A radio
 * group to assistive tech — one tab stop, arrow keys move the selection.
 */
export function Segmented<T extends string>(p: {
  value: T
  options: { value: T; label: ReactNode; disabled?: boolean; title?: string }[]
  onChange: (v: T) => void
  size?: 'sm' | 'md'
  'aria-label': string
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const enabled = p.options.flatMap((o, i) => (o.disabled ? [] : [i]))
  const selected = p.options.findIndex((o) => o.value === p.value && !o.disabled)
  // The one tab stop: the selected option, or the first enabled one when nothing valid is selected.
  const tabStop = selected >= 0 ? selected : (enabled[0] ?? -1)

  const onKeyDown = (e: KeyboardEvent) => {
    if (enabled.length === 0) return
    const at = enabled.indexOf(refs.current.findIndex((el) => el === document.activeElement))
    let to: number | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = enabled[(at + 1) % enabled.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = enabled[(at - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') to = enabled[0]
    else if (e.key === 'End') to = enabled[enabled.length - 1]
    if (to === undefined) return
    e.preventDefault()
    refs.current[to]?.focus()
    const o = p.options[to]!
    if (o.value !== p.value) p.onChange(o.value)
  }

  return (
    <div role="radiogroup" aria-label={p['aria-label']} className={`ui-seg${p.size === 'md' ? ' ui-seg--md' : ''}`} onKeyDown={onKeyDown}>
      {p.options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={o.value === p.value}
          tabIndex={i === tabStop ? 0 : -1}
          disabled={o.disabled}
          title={o.title}
          onClick={() => o.value !== p.value && p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
