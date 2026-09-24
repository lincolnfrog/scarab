import { localMode } from '../../local'
import { follow, revealRecoveryCode } from '../../session'
import { Button } from '../../ui/Button'
import { useAction } from '../../ui/useAction'
import { showRecoveryCode } from './codeSheet'
import { RecoveryDrill } from './RecoveryDrill'
import './vault.css'

/**
 * The Recovery card: the printed code is the only way in without a passkey,
 * and there is no reset. Showing it takes a fresh passkey answer; testing a
 * written-down copy happens in the tab, against the key already here.
 */
export function RecoveryCard() {
  const session = localMode.vault
  const owed = follow.recoveryOwed

  const reveal = useAction(
    async () => {
      const code = await revealRecoveryCode()
      showRecoveryCode(
        owed
          ? { code, title: 'Your new recovery code', subtitle: 'The vault’s key was set on this device, so an older code doesn’t open it. Keep this one.', required: true }
          : { code, title: 'Recovery code', subtitle: 'Anyone who sees it can open the vault.', required: false },
      )
    },
    { errorPrefix: 'Couldn’t show the recovery code' },
  )

  return (
    <section className="card c6 zk-card" aria-labelledby="zk-recovery-h">
      <div className="h4row">
        <h2 id="zk-recovery-h">Recovery</h2>
        <div className="right muted">no reset exists</div>
      </div>
      {session ? (
        <>
          {owed && (
            <div className="zk-callout" data-tone="gold" role="status">
              <span>
                <b>Store the new recovery code.</b> The vault’s key was set on this device — a rotation, a removal, or creating the vault — and
                nobody has confirmed storing its code since. An older code doesn’t open it.
              </span>
            </div>
          )}
          <p className="zk-lead">
            The recovery code opens the vault on any device, without a passkey. Showing it asks for one of the vault’s passkeys first, so
            nobody at an unlocked tab can read it off the screen.
          </p>
          <div className="formrow zk-actions">
            <Button variant={owed ? 'gold' : 'default'} busy={reveal.busy} onClick={() => void reveal.run()}>
              {owed ? 'Show the new recovery code…' : 'Show recovery code…'}
            </Button>
          </div>
          <RecoveryDrill />
        </>
      ) : localMode.active ? (
        <p className="zk-lead">
          Creating the vault shows its recovery code once, to keep on paper: it opens the vault on any device without a passkey, and nobody can
          reset it — lose every passkey and the code, and the vault is gone.
        </p>
      ) : (
        <p className="zk-lead">
          The recovery code — printed when the vault was created — opens it on any device without a passkey. Lose every passkey and the code, and
          the vault is gone: zero-knowledge means nobody can reset it. Unlock the vault to see the code or test the copy you wrote down.
        </p>
      )}
    </section>
  )
}
