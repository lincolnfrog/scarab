import { confirm } from '../../ui/dialogs'
import { parseServerTime, relTime } from '../../ui/syncStatus'
import './vault.css'

/** The stored vault as the person is about to be asked to delete it. */
export type ReplaceTarget = {
  version: number
  /** The courier's updated_at (SQLite UTC). */
  updatedAt: string
  /** Everyone else who unlocks it (household_members), who loses it too. */
  members: string[]
}

const names = (xs: string[]) => (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/**
 * The one confirmation before a stored vault is deleted to make room for a
 * new one (front door "Start over", or creating a vault from a session). It
 * says exactly what goes — the version, when it was saved, who else loses it —
 * and needs REPLACE typed. The delete itself happens later, only after the new
 * passkey exists, and only if the vault is still this version.
 */
export function confirmReplaceVault(t: ReplaceTarget): Promise<boolean> {
  const at = parseServerTime(t.updatedAt)
  return confirm({
    title: `Delete vault v${t.version} and start over?`,
    body: (
      <div className="zk-replace">
        <p>
          Creating a new vault deletes the stored one — <b>v{t.version}</b>
          {at !== null ? `, last saved ${relTime(at, Date.now())}` : ''} — for good, with its version history. Nothing
          in it can be recovered afterwards, by you or by the server.
        </p>
        {t.members.length > 0 ? (
          <p>
            It is shared: <b>{names(t.members)}</b> will lose it too. Their passkeys, yours and the recovery code will open
            nothing.
          </p>
        ) : (
          <p>Its passkeys and its recovery code will open nothing.</p>
        )}
        <p>The delete happens only once your new passkey is set up. Until then nothing changes.</p>
      </div>
    ),
    confirmLabel: 'Delete and start over',
    danger: true,
    typeToConfirm: 'REPLACE',
  })
}
