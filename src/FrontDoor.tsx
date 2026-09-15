import { useEffect, useState } from 'react'
import { passkeySupport } from './passkey'
import RecoveryCode from './RecoveryCode'
import { createVault, startEmpty, unlockVault, unlockWithRecoveryCode, type Mode } from './session'

/**
 * scarab.one's front door. Shown only when the server holds no plaintext:
 * either a vault exists (one passkey tap unlocks it into this tab) or nothing
 * exists yet, in which case setting up IS creating the vault — name the
 * device, answer the passkey prompt, file the recovery code, and you're in.
 * Household installs with server-side data never see it.
 */
type Step = 'door' | 'recover' | 'name' | 'code'

export default function FrontDoor({ mode, onEnter, onHousehold }: { mode: Mode; onEnter: () => void; onHousehold: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [support, setSupport] = useState<boolean | null>(null)
  const [step, setStep] = useState<Step>(mode.vault ? 'door' : 'name')
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; version: number } | null>(null)

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

  /** Boot an empty engine, then mint the vault under this device's passkey. Replaces any stored blob. */
  const create = () =>
    run(async () => {
      await startEmpty()
      const r = await createVault(label.trim() || 'this device')
      setRecovery({ code: r.recoveryCode, version: r.version })
      setStep('code')
    }, 'Waiting for your passkey…')

  const noPrf = support === false

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

        {step === 'code' && recovery ? (
          <>
            <h2>Your vault is ready</h2>
            <p className="sub2">
              Vault v{recovery.version} is stored, encrypted under your passkey. One more thing before you go in.
            </p>
            <div style={{ marginTop: 12 }}>
              <RecoveryCode code={recovery.code} title="Recovery code" onDone={onEnter} />
            </div>
          </>
        ) : step === 'name' ? (
          <>
            <h2>{mode.vault ? 'Start over with a new vault' : 'Set up your vault'}</h2>
            <p className="sub2">
              {mode.vault
                ? 'This replaces the stored vault the next time you save. '
                : 'Everything you import lives in this tab and is encrypted before upload — the server never receives plaintext. '}
              Your passkey — fingerprint or face, synced by Apple or Google across your devices — is the key.
            </p>
            {noPrf && (
              <p className="sub2 neg" style={{ marginTop: 10 }}>
                This browser cannot create a Scarab vault: it needs passkeys with the PRF extension. Use Chrome or
                Safari on a recent Mac, iPhone, Android or Windows device.
              </p>
            )}
            <form
              className="formrow"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault()
                if (!busy && !noPrf) void create()
              }}
            >
              <input
                autoFocus
                placeholder="name this device (e.g. Max's Mac)"
                style={{ width: 240 }}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={!!busy}
              />
              <button className="btn gold" type="submit" disabled={!!busy || noPrf}>
                {busy ?? 'Create vault with a passkey'}
              </button>
              {mode.vault && (
                <button className="btn ghosty" type="button" disabled={!!busy} onClick={() => setStep('door')}>
                  Back
                </button>
              )}
            </form>
            {noPrf && (
              <div className="formrow" style={{ marginTop: 10 }}>
                <button className="btn mini ghosty" disabled={!!busy} onClick={() => void run(async () => { await startEmpty(); onEnter() }, 'Starting…')}>
                  Explore without a vault (nothing can be saved)
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <h2>Unlock your vault</h2>
            <p className="sub2">
              Vault v{mode.vault!.version}, saved {mode.vault!.updated_at} UTC
              {mode.household ? <> · shared with you by {mode.household}</> : null}. Your passkey decrypts it in this
              tab and nowhere else — the server holds only ciphertext.
            </p>
            {noPrf && (
              <p className="sub2 neg" style={{ marginTop: 10 }}>
                This browser cannot open Scarab: it needs passkeys with the PRF extension. Use Chrome or Safari on a
                recent Mac, iPhone, Android or Windows device. The recovery code still works here.
              </p>
            )}
            {step === 'door' ? (
              <div className="formrow" style={{ marginTop: 12 }}>
                <button
                  className="btn gold"
                  autoFocus
                  disabled={!!busy || noPrf}
                  onClick={() => void run(async () => { await unlockVault(); onEnter() }, 'Waiting for your passkey…')}
                >
                  {busy ?? 'Unlock with passkey'}
                </button>
                <button className="btn ghosty" disabled={!!busy} onClick={() => setStep('recover')}>
                  Use recovery code…
                </button>
                <button
                  className="btn ghosty"
                  disabled={!!busy}
                  onClick={() => {
                    if (window.confirm('Start over with a new vault? The stored one stays until you save over it.')) setStep('name')
                  }}
                >
                  Start over
                </button>
              </div>
            ) : (
              <form
                className="formrow"
                style={{ marginTop: 12 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.trim()) void run(async () => { await unlockWithRecoveryCode(code); onEnter() }, 'Decrypting…')
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
                <button className="btn ghosty" type="button" disabled={!!busy} onClick={() => setStep('door')}>
                  Back
                </button>
              </form>
            )}
            <p className="sub2 muted" style={{ marginTop: 10 }}>
              No passkey on this device? The prompt offers a QR code — scan it with the phone that has one, and the
              phone answers. Add this device afterwards from Data &amp; Vault.
            </p>
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
