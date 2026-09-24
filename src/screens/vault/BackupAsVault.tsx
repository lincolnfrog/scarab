import type { BackupBehind, OpenedSnapshot } from '../../session'
import { Button } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import { relTime } from '../../ui/syncStatus'
import { CountsTable } from './Preview'
import { compareCounts } from './versions'
import './vault.css'

const ago = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : ` (${relTime(t, Date.now())})`
}

/**
 * The front door's step for a backup opened with no vault stored: it can
 * become the vault, as it was sealed. Unless this device saw the vault move
 * on since the backup (session.ts backupBehind) — then the step says so by
 * version, and leads with a new vault from the backup's data (a fresh key,
 * a passkey on this device, a new recovery code). Restoring it as it was is
 * then a second, danger choice — never offered for a backup from before a
 * re-key, since it would bring the retired key back.
 */
export function BackupAsVault(p: {
  snap: OpenedSnapshot
  behind: BackupBehind | null
  /** A vault was stored when the door opened (so it is gone "any more"). */
  hadVault: boolean
  label: string
  onLabel: (v: string) => void
  /** This browser can make passkeys (the new-vault route registers one). */
  canCreate: boolean
  busy: boolean
  restoring: boolean
  starting: boolean
  onRestore: () => void
  onStartNew: () => void
  onBack: () => void
}) {
  const { snap, behind } = p
  const unreadable = snap.unreadable !== null
  const counts = unreadable ? (
    <p className="sub2 neg" style={{ marginTop: 10 }}>
      This version of Scarab can’t load it: {snap.unreadable}
    </p>
  ) : (
    snap.counts && (
      <div className="zk-door-counts">
        <CountsTable rows={compareCounts(snap.counts, null)} thenLabel="In the backup" nowLabel={null} />
      </div>
    )
  )

  if (!behind)
    return (
      <>
        <h2>Restore your vault from this backup</h2>
        <p className="sub2">
          No vault is stored here{p.hadVault ? ' any more' : ''}. Restoring makes this backup the vault, sealed with the same key — every passkey
          that was on it and its recovery code open it as before. Nothing else is uploaded.
        </p>
        {counts}
        <div className="formrow" style={{ marginTop: 12 }}>
          <Button variant="gold" busy={p.restoring} disabled={unreadable || (p.busy && !p.restoring)} onClick={p.onRestore}>
            Restore the vault from this backup
          </Button>
          <Button variant="ghost" disabled={p.busy} onClick={p.onBack}>
            Back
          </Button>
        </div>
      </>
    )

  const { seen, sealedAs, rekeyed } = behind
  return (
    <>
      <h2>Start again from this backup</h2>
      <p className="sub2">No vault is stored here{p.hadVault ? ' any more' : ''}.</p>
      <div className="zk-callout zk-door-behind" data-tone="down" role="alert">
        <span>
          <b>
            This device saw this vault at v{seen.seq}
            {ago(seen.at)}, later than this backup (v{sealedAs}){rekeyed ? ', and it was re-keyed since' : ''}.
          </b>{' '}
          Restored as it was, the vault would open again with the key and passkeys the backup was sealed with
          {rekeyed
            ? ' — the recovery code retired since, and any passkey the re-key dropped, included.'
            : rekeyed === null
              ? ' — a passkey removed since included, and an older recovery code if the key was changed since (this device can’t tell).'
              : ' — a passkey removed since included.'}{' '}
          A server that says the vault is gone may also be holding it back.
        </span>
      </div>
      <p className="sub2">
        A new vault from it keeps the data and leaves the rest behind: a fresh key, a passkey on this device, and a new recovery code. Add your
        other devices and your household again afterwards.
      </p>
      {counts}
      {p.canCreate ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!p.busy && !unreadable) p.onStartNew()
          }}
        >
          <div className="zk-door-field">
            <Field label="Name this device" hint="Shown in the new vault’s passkey list">
              <TextInput placeholder="e.g. Max’s Mac" value={p.label} onChange={(e) => p.onLabel(e.target.value)} disabled={p.busy} />
            </Field>
          </div>
          <div className="formrow" style={{ marginTop: 12 }}>
            <Button variant="gold" type="submit" busy={p.starting} disabled={unreadable || (p.busy && !p.starting)}>
              Start a new vault from this backup
            </Button>
            {rekeyed !== true && (
              <Button variant="ghost" busy={p.restoring} disabled={unreadable || (p.busy && !p.restoring)} onClick={p.onRestore}>
                Restore it as it was…
              </Button>
            )}
            <Button variant="ghost" disabled={p.busy} onClick={p.onBack}>
              Back
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="sub2 neg" style={{ marginTop: 10 }}>
            This browser can’t make the passkey a new vault needs (passkeys with the PRF extension). Use Chrome or Safari on a recent Mac,
            iPhone, Android or Windows device.
          </p>
          <div className="formrow" style={{ marginTop: 12 }}>
            {rekeyed !== true && (
              <Button variant="ghost" busy={p.restoring} disabled={unreadable || (p.busy && !p.restoring)} onClick={p.onRestore}>
                Restore it as it was…
              </Button>
            )}
            <Button variant="ghost" disabled={p.busy} onClick={p.onBack}>
              Back
            </Button>
          </div>
        </>
      )}
    </>
  )
}
