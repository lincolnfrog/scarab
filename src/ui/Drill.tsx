import { useLayoutEffect, type ReactNode } from 'react'
import { Link, type RouteTarget } from '../router'
import { useCrumb, useScreen, useScreenRoute } from './screen'
import './ui.css'

/**
 * Overview → detail. Every screen opens on a short overview: a hero figure
 * and a handful of summary cards, each answering one question in one number.
 * The tables, settings and analysis behind a card live one level down, in a
 * detail view with a URL of its own — '#/tax/realized', '#/cash/transactions'
 * — so Back returns to the overview, a finding can link straight to its
 * evidence, and the overview never grows when a detail does.
 *
 *   const detail = useDetail(['realized', 'settings'] as const)
 *   if (detail === 'realized') return <DetailView title="Realized gains">…</DetailView>
 *   return <div className="grid12">… <DrillCard to="realized" title="Realized gains" value="+$60,276" /> …</div>
 *
 * The screen keeps loading its data in one place; only what it renders
 * changes. App swaps the page heading for a crumb ("Taxes › Realized gains")
 * and keeps a scroll position per view.
 */

/** The detail this screen's URL points at ('#/tax/realized' → 'realized'), or null on the overview. */
export function useDetail<T extends string>(ids: readonly T[]): T | null {
  const s = useScreenRoute().rest[0]
  return s !== undefined && (ids as readonly string[]).includes(s) ? (s as T) : null
}

/**
 * A detail view's frame: names itself in the page heading (the screen's name
 * there becomes the way back) and lays its children out on the card grid —
 * pass cards with the usual c-spans, or `plain` to lay out yourself.
 */
export function DetailView(p: { title: string; lead?: ReactNode; plain?: boolean; children: ReactNode }) {
  const setCrumb = useCrumb()
  useLayoutEffect(() => {
    setCrumb(p.title)
    return () => setCrumb(null)
  }, [setCrumb, p.title])
  return (
    <div className="ui-detail">
      {p.lead != null && <p className="ui-detail-lead">{p.lead}</p>}
      {p.plain ? p.children : <div className="grid12">{p.children}</div>}
    </div>
  )
}

const Chevron = () => (
  <svg className="ui-drill-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
)

/** A detail id on this screen ('realized'), or a full target elsewhere. */
type DrillTo = string | RouteTarget

function useDrillTarget(to: DrillTo): RouteTarget {
  const { id } = useScreen()
  return typeof to === 'string' ? { screen: id, rest: [to] } : to
}

/**
 * One summary card on an overview: a title, one headline figure, a line of
 * context, and optionally a small preview (a few rows, a bar, a sparkline).
 * The whole card is the link to its detail view — the title is the anchor and
 * its hit area covers the card. A control inside the preview that must stay
 * clickable takes the class `ui-drill-live`.
 */
export function DrillCard(p: {
  to: DrillTo
  title: ReactNode
  /** Grid span class: 'c3' | 'c4' | 'c6' | 'c8' | 'c12'. */
  span?: string
  value?: ReactNode
  /** Colours the figure as a gain or a loss — only for gains and losses. */
  tone?: 'pos' | 'neg'
  note?: ReactNode
  /** A count or status beside the title ("3 new"). */
  badge?: ReactNode
  state?: Record<string, unknown>
  children?: ReactNode
}) {
  const to = useDrillTarget(p.to)
  return (
    <div className={`card ui-drill ${p.span ?? 'c4'}`}>
      <h2>
        <Link to={to} state={p.state} className="ui-drill-link">
          {p.title}
        </Link>
        {p.badge != null && <span className="ui-drill-badge">{p.badge}</span>}
        <Chevron />
      </h2>
      {p.value != null && <div className={`ui-drill-v${p.tone ? ` ${p.tone}` : ''}`}>{p.value}</div>}
      {p.note != null && <div className="ui-drill-note">{p.note}</div>}
      {p.children != null && <div className="ui-drill-body">{p.children}</div>}
    </div>
  )
}

/** "All 34 →": the way from a card that stays on the overview into its full view. Sits in the card header's `.right`. */
export function DrillMore(p: { to: DrillTo; children: ReactNode; state?: Record<string, unknown> }) {
  const to = useDrillTarget(p.to)
  return (
    <Link to={to} state={p.state} className="ui-drill-more">
      {p.children}
      <Chevron />
    </Link>
  )
}

export type StatItem = { label: ReactNode; value: ReactNode; note?: ReactNode; tone?: 'pos' | 'neg' }

/** A row of key figures inside a card: label over value over a quiet note. Three or four, not eight. */
export function Stats({ items }: { items: readonly StatItem[] }) {
  return (
    <dl className="ui-stats">
      {items.map((s, i) => (
        <div key={i} className="ui-stat">
          <dt>{s.label}</dt>
          <dd className={s.tone}>{s.value}</dd>
          {s.note != null && <dd className="ui-stat-note">{s.note}</dd>}
        </div>
      ))}
    </dl>
  )
}

export type MiniRow = { key?: string | number; label: ReactNode; sub?: ReactNode; value: ReactNode; tone?: 'pos' | 'neg' }

/** A card's preview list: a few label/value rows — the top of a table, not the table. */
export function MiniRows({ rows }: { rows: readonly MiniRow[] }) {
  return (
    <ul className="ui-minirows">
      {rows.map((r, i) => (
        <li key={r.key ?? i}>
          <span className="ui-minirow-l">
            {r.label}
            {r.sub != null && <small>{r.sub}</small>}
          </span>
          <span className={`ui-minirow-v${r.tone ? ` ${r.tone}` : ''}`}>{r.value}</span>
        </li>
      ))}
    </ul>
  )
}
