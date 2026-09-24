import { useLayoutEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../ui/motion'
import { COUNT_MS, countUpAt } from './countUp'
import './chart.css'

/**
 * A hero figure that counts up from $0 the first time it appears (plan §C11),
 * landing with the chart's reveal. Only the first reveal: a later value (a
 * quiet refetch on a keep-alive revisit) shows at once, and so does
 * everything under prefers-reduced-motion or in a hidden tab.
 *
 * The final figure is always in the DOM — it reserves the width, so nothing
 * beside the number shifts while it counts, and it is what a screen reader
 * reads; the counting digits are aria-hidden.
 */
export function CountUp({ value, format, className }: { value: number; format: (v: number) => string; className?: string }) {
  const [shown, setShown] = useState<number | null>(() => (prefersReducedMotion() ? null : 0))
  const played = useRef(false)
  const target = useRef(value)
  target.current = value

  useLayoutEffect(() => {
    if (played.current) return
    played.current = true
    if (prefersReducedMotion() || document.visibilityState === 'hidden') {
      setShown(null)
      return
    }
    const start = performance.now()
    let raf = 0
    let done = false
    const tick = (now: number) => {
      const k = (now - start) / COUNT_MS
      if (k >= 1) {
        done = true
        setShown(null)
        return
      }
      setShown(countUpAt(0, target.current, Math.max(0, k)))
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      // Interrupted (StrictMode's rehearsal, the screen hidden mid-count): count again on the next reveal.
      if (!done) played.current = false
    }
  }, [])

  const text = format(value)
  return (
    <span className={`ch-count${className ? ` ${className}` : ''}`}>
      <span className="ch-count-size" aria-hidden="true">
        {text}
      </span>
      <span aria-hidden="true">{shown === null ? text : format(shown)}</span>
      <span className="ui-sr">{text}</span>
    </span>
  )
}
