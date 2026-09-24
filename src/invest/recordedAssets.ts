import { useCallback, useEffect, useState } from 'react'
import type { AssetRow } from '../../shared/invest-api'
import { get } from '../api'

/**
 * Every symbol the household has recorded, with its kind (GET
 * /api/invest/assets) — for the symbol box, which locks a recorded symbol's
 * kind. Fetched when the form mounts and again on `reload()` (after a trade
 * adds a symbol). Empty until it answers; a failure leaves it empty (the
 * engine still refuses the wrong kind, with a message).
 */
export function useRecordedAssets(): { assets: readonly AssetRow[]; reload: () => void } {
  const [assets, setAssets] = useState<readonly AssetRow[]>([])
  const [n, setN] = useState(0)
  useEffect(() => {
    let live = true
    get<AssetRow[]>('/api/invest/assets')
      .then((a) => live && setAssets(a))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [n])
  const reload = useCallback(() => setN((x) => x + 1), [])
  return { assets, reload }
}
