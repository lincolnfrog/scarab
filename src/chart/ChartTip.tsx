import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import './chart.css'

export type TipPoint = { x: number; y: number }
export type TipBox = { w: number; h: number }

/**
 * Where a tooltip of size `tip` goes for the point `at` inside a chart box
 * `box` (all in the chart's own pixels): to the right of the point, flipped
 * to the left when it would cross the right edge, and clamped inside only
 * when neither side fits (bug #41: tips were clamped, so they covered the
 * point). Vertically it sits `rise` above the point, kept inside the box.
 */
export function placeTip(at: TipPoint, tip: TipBox, box: TipBox, o: { gap?: number; pad?: number; rise?: number } = {}): { left: number; top: number; flipped: boolean } {
  const gap = o.gap ?? 14
  const pad = o.pad ?? 4
  const rise = o.rise ?? 40
  let left = at.x + gap
  let flipped = false
  if (left + tip.w > box.w - pad) {
    const leftSide = at.x - gap - tip.w
    if (leftSide >= pad) {
      left = leftSide
      flipped = true
    } else left = Math.max(pad, box.w - pad - tip.w)
  }
  let top = at.y - rise
  if (box.h > 0 && top + tip.h > box.h - pad) top = box.h - pad - tip.h
  if (top < pad) top = pad
  return { left, top, flipped }
}

/**
 * The shared chart tooltip, in the mockup's .tip skin. It measures itself
 * after every render and places with `placeTip`, so a wide tip flips to the
 * left of the crosshair instead of being clamped over it. Pass `at = null` to
 * hide: the last content stays mounted and fades out over 80ms (the fade is
 * CSS, so the reduced-motion kill-switch in styles.css turns it off).
 *
 * Render it inside the `.chart` box (position: relative) with that box's size.
 */
export function ChartTip({ at, box, children, rise }: { at: TipPoint | null; box: TipBox; children?: ReactNode; rise?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const last = useRef<{ at: TipPoint; children: ReactNode } | null>(null)
  if (at) last.current = { at, children }
  const [size, setSize] = useState<TipBox>({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const w = el.offsetWidth
    const h = el.offsetHeight
    if (w !== size.w || h !== size.h) setSize({ w, h })
  })
  const shown = last.current
  if (!shown) return null
  const pos = placeTip(shown.at, size, box, { rise })
  return (
    <div ref={ref} className={`tip ch-tip${at ? ' on' : ''}`} style={{ left: pos.left, top: pos.top }} aria-hidden="true">
      {shown.children}
    </div>
  )
}

/** One tooltip row: swatch, name, value — the mockup's `.tip .r`. */
export function TipRow({ color, name, value, valueColor, mark }: { color?: string; name: ReactNode; value: ReactNode; valueColor?: string; mark?: 'box' | 'line' | 'dash' }) {
  return (
    <div className="r">
      <span className={`sw${mark === 'line' ? ' ch-sw-ln' : mark === 'dash' ? ' ch-sw-ln ch-sw-dash' : ''}`} style={{ background: mark === 'dash' ? undefined : color ?? 'transparent', color }} />
      <span className="nm">{name}</span>
      <span className="vl" style={valueColor ? { color: valueColor } : undefined}>
        {value}
      </span>
    </div>
  )
}
