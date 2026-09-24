import { useLayoutEffect, useState } from 'react'

export type ChartSize = { width: number; height: number }

/**
 * The laid-out size of a chart's box, kept current by a ResizeObserver, so
 * every chart draws at its card's real width (bug #9: BigChart was fixed at
 * 1140px). Attach `ref` to the `.chart` element — a callback ref, so a box
 * that mounts late (after data loads) is still observed.
 *
 * A zero width is ignored: <Activity> hides a kept-alive screen with
 * display:none, and the chart should come back at its last size rather than
 * blank out and re-lay. Pair with `.chart { contain: inline-size }` (chart.css)
 * so the svg never props its card open while the window narrows.
 */
export function useChartSize<T extends HTMLElement = HTMLDivElement>(): ChartSize & { ref: (el: T | null) => void } {
  const [el, setEl] = useState<T | null>(null)
  const [size, setSize] = useState<ChartSize>({ width: 0, height: 0 })
  useLayoutEffect(() => {
    if (!el) return
    const read = () => {
      const width = Math.floor(el.clientWidth)
      const height = Math.floor(el.clientHeight)
      if (width > 0) setSize((s) => (s.width === width && s.height === height ? s : { width, height }))
    }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return { ref: setEl, width: size.width, height: size.height }
}
