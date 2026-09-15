import { useEffect, useState } from 'react'
import { passkeySupport } from './passkey'
import { startEmpty, unlockVault, unlockWithRecoveryCode, type Mode } from './session'

/**
 * scarab.one's front door. Shown only when the server holds no plaintext:
 * either a vault exists (one passkey tap unlocks it into this tab) or nothing
 * exists yet (start empty). Household installs with server-side data never
 * see it.
 */
export default function FrontDoor({ mode, onHousehold }: { mode: Mode; onHousehold: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [support, setSupport] = useState<boolean | null>(null)
  const [recovering, setRecovering] = useState(false)
  const [code, setCode] = useState('')

  useEffect(() => {
    passkeySupport().then((s) => setSupport(s === false ? false : true))
  }, [])

  const run = async (fn: () => Promise<unknown>, label: string) => {
    setErr(null)
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="frontdoor">
      <div className="card" style={{ maxWidth: 520, width: '100%' }}>
        <div className="logo" style={{ marginBottom: 18 }}>
          <svg width="26" height="26" viewBox="0 0 44 44" fill="none" aria-hidden="true">
            <circle cx="22" cy="9" r="5" stroke="var(--gold)" strokeWidth="2.6" />
            <ellipse cx="22" cy="27" rx="10" ry="11" stroke="var(--gold)" strokeWidth="2.6" />
            <path d="M22 16v22" stroke="var(--gold)" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>SCARAB</span>
        </div>
        {mode.vault ? (
          <>
            <h2>Unlock your vault</h2>
            <p className="sub2">
              Vault v{mode.vault.version}, saved {mode.vault.updated_at} UTC
              {mode.household ? <> · shared with you by {mode.household}</> : null}. Your passkey decrypts it in this
              tab and nowhere else — the server holds only ciphertext.
            </p>
            {support === false && (
              <p className="sub2 neg" style={{ marginTop: 10 }}>
                This browser cannot open Scarab: it needs passkeys with the PRF extension. Use Chrome or Safari on a
                recent Mac, iPhone, Android or Windows device. The recovery code still works here.
              </p>
            )}
            {!recovering ? (
              <div className="formrow" style={{ marginTop: 12 }}>
                <button
                  className="btn gold"
                  autoFocus
                  disabled={!!busy || support === false}
                  onClick={() => void run(unlockVault, 'Waiting for your passkey…')}
                >
                  {busy ?? 'Unlock with passkey'}
                </button>
                <button className="btn ghosty" disabled={!!busy} onClick={() => setRecovering(true)}>
                  Use recovery code…
                </button>
                <button
                  className="btn ghosty"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm('Start an empty session? The stored vault stays until you save over it.'))
                      void run(startEmpty, 'Starting…')
                  }}
                >
                  Start empty instead
                </button>
              </div>
            ) : (
              <form
                className="formrow"
                style={{ marginTop: 12 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.trim()) void run(() => unlockWithRecoveryCode(code), 'Decrypting…')
                }}
              >
                <input
                  autoFocus
                  placeholder="XXXX-XXXX-XXXX-… (13 groups)"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ width: 300, fontFamily: 'var(--mono)' }}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={!!busy}
                />
                <button className="btn gold" type="submit" disabled={!!busy || !code.trim()}>
                  {busy ?? 'Unlock'}
                </button>
                <button className="btn ghosty" type="button" disabled={!!busy} onClick={() => setRecovering(false)}>
                  Back
                </button>
              </form>
            )}
            <p className="sub2 muted" style={{ marginTop: 10 }}>
              No passkey on this device? The prompt offers a QR code — scan it with the phone that has one, and the
              phone answers. Add this device afterwards from Data &amp; Vault.
            </p>
          </>
        ) : (
          <>
            <h2>Nothing here yet</h2>
            <p className="sub2">
              Start a zero-knowledge session: everything you import lives in this tab, and saving encrypts it under a
              passkey before upload. The server never receives plaintext.
            </p>
            {support === false && (
              <p className="sub2 neg" style={{ marginTop: 10 }}>
                This browser cannot create a Scarab vault: it needs passkeys with the PRF extension. Use Chrome or
                Safari on a recent Mac, iPhone, Android or Windows device.
              </p>
            )}
            <div className="formrow" style={{ marginTop: 12 }}>
              <button className="btn gold" disabled={!!busy} onClick={() => void run(startEmpty, 'Starting…')}>
                {busy ?? 'Start empty in this tab'}
              </button>
            </div>
          </>
        )}
        {err && <div className="sub2 neg" style={{ marginTop: 10 }}>{err}</div>}
        {mode.zkOnly ? (
          <div className="sub2 topline muted">
            This server is vault-only: it accepts ciphertext and serves the daily price basket, nothing else.
          </div>
        ) : (
          <div className="sub2 topline">
            <span className="muted">Running your own instance for the household, with the server holding plaintext?</span>{' '}
            <button className="btn mini ghosty" onClick={onHousehold} disabled={!!busy}>
              Continue in household mode
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
