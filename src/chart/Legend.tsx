import type { ReactNode } from 'react'
import './chart.css'

export type LegendItem = {
  id: string
  label: ReactNode
  color: string
  /** Swatch shape: a filled square (area, bars), a line, a dashed line, or a tint (a band — pass the tint as `color`). */
  mark?: 'box' | 'line' | 'dash' | 'band'
  hidden?: boolean
  /** Shown but not toggleable, even when the legend is (the price line under its moving averages). */
  fixed?: boolean
}

/**
 * The mockup legend (`.legend` — swatch + name, wrapping). CLAUDE.md: every
 * chart with two or more series has one, so it renders nothing below `min`
 * (default 2) items. With `onToggle` the items are buttons that show and hide
 * their series (aria-pressed); a `fixed` item stays a plain label.
 */
export function Legend({
  items,
  onToggle,
  className,
  min = 2,
  'aria-label': ariaLabel = 'Legend',
}: {
  items: LegendItem[]
  onToggle?: (id: string, hidden: boolean) => void
  className?: string
  min?: number
  'aria-label'?: string
}) {
  if (items.length < min) return null
  return (
    <div className={`legend ch-legend${className ? ` ${className}` : ''}`} role="group" aria-label={ariaLabel}>
      {items.map((it) => {
        const sw = <Swatch color={it.color} mark={it.mark} />
        if (!onToggle || it.fixed)
          return (
            <span className="li" key={it.id}>
              {sw}
              {it.label}
            </span>
          )
        return (
          <button
            type="button"
            key={it.id}
            className={`li ch-li${it.hidden ? ' off' : ''}`}
            aria-pressed={!it.hidden}
            onClick={() => onToggle(it.id, !it.hidden)}
          >
            {sw}
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

export function Swatch({ color, mark = 'box' }: { color: string; mark?: LegendItem['mark'] }) {
  if (mark === 'line') return <span className="sw ln" style={{ background: color }} />
  if (mark === 'dash') return <span className="sw ln ch-sw-dash" style={{ color }} />
  return <span className="sw" style={{ background: color }} />
}
