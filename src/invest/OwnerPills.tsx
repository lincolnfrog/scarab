import { formatDollars } from '../../shared/money'
import { Segmented } from '../ui/Segmented'
import type { OwnerGroup, OwnerKey } from './ownerFilter'
import './invest.css'

/**
 * Household / each person / Joint, each with its subtotal — narrows the
 * Investments screen to one owner's accounts. Renders nothing when there is
 * nothing to split (ownerGroups returns no groups).
 */
export default function OwnerPills({ groups, value, onChange }: { groups: readonly OwnerGroup[]; value: OwnerKey; onChange: (k: OwnerKey) => void }) {
  if (groups.length === 0) return null
  return (
    <div className="inv-owners">
      <Segmented
        aria-label="Whose accounts"
        value={value}
        onChange={onChange}
        options={groups.map((g) => ({
          value: g.key,
          label: (
            <span className="inv-ownpill">
              <span>{g.label}</span>
              <span className="inv-ownpill-v">{formatDollars(g.cents)}</span>
              <span className="ui-sr">
                , {g.accounts} account{g.accounts === 1 ? '' : 's'}
              </span>
            </span>
          ),
        }))}
      />
    </div>
  )
}
