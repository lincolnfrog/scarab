import type { ReactNode } from 'react'
import { Link } from '../router'
import './ui.css'

/**
 * What a card or screen shows when there is nothing yet — a title that says
 * what's missing, a line on what to do, and the one action that fixes it.
 * `ghost` is the mockup's dashed add-card, where the whole card is the
 * action: title "+ Add property" alone reproduces the mockup; a distinct
 * action.label is shown as the card's last line.
 *
 * `action.to` is an in-app hash link ('#/invest?d=add-account'), rendered as a
 * router <Link>: a plain click navigates in place (with the screen
 * transition), and the link can still be copied or opened in a new tab.
 */
export function EmptyState(p: { title: string; body?: ReactNode; action?: { label: string; onClick?: () => void; to?: string }; ghost?: boolean }) {
  const { action } = p
  if (p.ghost) {
    const inner = (
      <>
        <span className="ui-empty-title">{p.title}</span>
        {p.body != null && <span className="ui-empty-body">{p.body}</span>}
        {action && action.label !== p.title && <span className="ui-empty-cta">{action.label}</span>}
      </>
    )
    if (action?.to)
      return (
        <Link className="ui-empty ui-empty--ghost" to={action.to} onClick={action.onClick}>
          {inner}
        </Link>
      )
    if (action?.onClick)
      return (
        <button type="button" className="ui-empty ui-empty--ghost" onClick={action.onClick}>
          {inner}
        </button>
      )
    return <div className="ui-empty ui-empty--ghost">{inner}</div>
  }
  return (
    <div className="ui-empty">
      <div className="ui-empty-title">{p.title}</div>
      {p.body != null && <div className="ui-empty-body">{p.body}</div>}
      {action?.to ? (
        <Link className="btn gold" to={action.to} onClick={action.onClick}>
          {action.label}
        </Link>
      ) : action?.onClick ? (
        <button type="button" className="btn gold" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  )
}
