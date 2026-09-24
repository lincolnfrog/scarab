import { useEffect, useState, type CSSProperties } from 'react'
import { growIndex, growMs } from './barsModel'

/**
 * True while a chart's marks should play their first-reveal grow (the
 * `.ch-grow` class in chart.css, plan §C9): from the first render that has
 * `n` marks at a real width until the staggered animation is over. Then it
 * stays false for good, so data refreshes and keep-alive revisits (which
 * restart CSS animations on anything that was display:none) never replay it.
 * The animation itself is CSS, so the reduced-motion kill-switch removes it.
 */
export function useGrow(ready: boolean, n: number): boolean {
  const [done, setDone] = useState(false)
  const on = ready && n > 0 && !done
  useEffect(() => {
    if (!on) return
    const id = window.setTimeout(() => setDone(true), growMs(n))
    return () => window.clearTimeout(id)
  }, [on, n])
  return on
}

/** The inline style that staggers mark `i` (`--i`, read by `.ch-grow` in chart.css). */
export const growStyle = (i: number): CSSProperties => ({ '--i': growIndex(i) }) as CSSProperties
