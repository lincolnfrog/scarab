import type { CSSProperties } from 'react'
import './ui.css'

/**
 * A placeholder block for a first load — the shape of what is coming, with a
 * slow shimmer (static under reduced motion). Revisits don't need one: kept-
 * alive screens show their last data while they refresh.
 */
export function Skeleton(p: { h?: number | string; w?: number | string; radius?: number; className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={p.className ? `ui-skel ${p.className}` : 'ui-skel'}
      style={{ height: p.h ?? 14, width: p.w ?? '100%', borderRadius: p.radius, ...p.style }}
    />
  )
}
