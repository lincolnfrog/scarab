import { useState, type FocusEvent, type KeyboardEvent } from 'react'
import { navStep } from './barsModel'

/**
 * Hover + keyboard for a bar chart's marks, the bar-chart twin of
 * TimeChart's stepping: the chart is one tab stop (the global gold focus
 * ring), ←/→ (or ↑/↓) move the highlight, Home/End jump, Enter or Space
 * activates the highlighted mark when the chart has an action, Esc clears.
 * Focusing from the keyboard highlights `start()` straight away. Each step is
 * read out through `live` (render it in an aria-live region).
 *
 * The pointer uses the same highlight through `setHover`, so hovering and
 * stepping never disagree about which mark the tooltip describes.
 */
export function useBarNav(o: { n: number; start: () => number; describe: (i: number) => string; onActivate?: (i: number) => void }) {
  const [hover, setHover] = useState<number | null>(null)
  const [live, setLive] = useState('')
  const cur = hover !== null && hover < o.n ? hover : null

  const move = (i: number | null) => {
    setHover(i)
    setLive(i === null ? '' : o.describe(i))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.metaKey || e.ctrlKey) return
    if ((e.key === 'Enter' || e.key === ' ') && o.onActivate && cur !== null) {
      e.preventDefault()
      o.onActivate(cur)
      return
    }
    if (e.key === 'Escape') {
      if (cur === null) return
      e.preventDefault()
      move(null)
      return
    }
    const next = navStep(e.key, cur, o.n, o.start())
    if (next === undefined) return
    e.preventDefault()
    move(next)
  }
  const onFocus = (e: FocusEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && cur === null && o.n > 0 && e.currentTarget.matches(':focus-visible')) move(o.start())
  }
  return {
    hover: cur,
    setHover,
    live,
    focusProps: { tabIndex: o.n > 0 ? 0 : -1, onKeyDown, onFocus, onBlur: () => setHover(null) },
  }
}
