import { useEffect, useState } from 'react'
import { get } from '../api'
import { shortDate, sidebarText, useNow, useSyncStatus } from './syncStatus'
import '../screens/vault/vault.css'
import './ui.css'

/** How often the sidebar re-asks when the price basket was built (it changes once a day). */
const BASKET_RECHECK_MS = 30 * 60_000

/**
 * When the shared price basket was last built — what a session's prices are
 * as of. Asked on entering a session and when the tab comes back into view,
 * at most every 30 minutes. The same request for everyone (network-only).
 */
function useBasketBuiltAt(active: boolean): number | null {
  const [builtAt, setBuiltAt] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    let alive = true
    let last = -Infinity
    const load = () => {
      if (Date.now() - last < BASKET_RECHECK_MS) return
      last = Date.now()
      get<{ builtAt: string | null }>('/api/basket/status')
        .then((b) => {
          const t = b.builtAt ? Date.parse(b.builtAt) : NaN
          if (alive) setBuiltAt(Number.isNaN(t) ? null : t)
        })
        .catch(() => undefined) // cosmetic: no line
    }
    load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active])
  return active ? builtAt : null
}

/** The sidebar footer: where the data lives and, in a session, how current the vault and its prices are. */
export function SidebarStatus() {
  const s = useSyncStatus()
  const now = useNow()
  const pricesAt = useBasketBuiltAt(s.state !== 'off')
  return (
    <div className="foot">
      <div className="ui-sidestat zk-sidestat" data-state={s.state}>
        <span className="ui-sync-dot" aria-hidden="true" />
        {sidebarText(s, now)}
      </div>
      {pricesAt !== null && <div className="zk-side-prices">Prices as of {shortDate(pricesAt)}</div>}
    </div>
  )
}
