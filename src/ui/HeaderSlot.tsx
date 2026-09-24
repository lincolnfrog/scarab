import type { ReactNode, ReactPortal } from 'react'
import { createPortal } from 'react-dom'
import { useHeaderHost, useScreen } from './screen'

/**
 * A screen's contribution to the page header: a subtitle after the title and
 * actions on the right (the mockup's "+ Record trade", "Import CSV / OFX").
 * Render it anywhere in the screen, once:
 *
 *   <HeaderSlot sub="Schwab brokerage · Fidelity 401(k) ×2" actions={<Button variant="gold">+ Record trade</Button>} />
 *
 * The header lives in App, outside the screen, so this is a portal — and a
 * portal escapes <Activity>'s display:none. So it renders only while its
 * screen is showing, into a slot of that screen's own that App hides in the
 * same commit that hides the screen.
 */
export function HeaderSlot(p: { sub?: ReactNode; actions?: ReactNode }): ReactPortal | null {
  const { active } = useScreen()
  const host = useHeaderHost()
  if (!active || !host) return null
  return createPortal(
    <>
      {p.sub != null && <span className="sub">{p.sub}</span>}
      {p.actions != null && <div className="right">{p.actions}</div>}
    </>,
    host,
  )
}
