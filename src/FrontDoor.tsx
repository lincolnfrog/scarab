import { useRef, useState } from 'react'
import { b64decode } from '../shared/vault'
import { startEmpty, unlockVault, type Mode } from './session'

/**
 * scarab.one's front door. Shown only when the server holds no plaintext:
 * either a vault exists (unlock it into this tab) or nothing exists yet
 * (start empty). Household installs with server-side data never see it.
 */
export default function FrontDoor({ mode, onHousehold }: { mode: Mode; onHousehold: () => void }) {
  const [pass, setPass] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

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
              Vault v{mode.vault.version}, saved {mode.vault.updated_at} UTC. It is decrypted in this tab and
              nowhere else — the server holds only ciphertext.
            </p>
            <form
              className="formrow"
              style={{ marginTop: 12 }}
              onSubmit={(e) => {
                e.preventDefault()
                if (pass) void run(() => unlockVault({ passphrase: pass }), 'Decrypting…')
              }}
            >
              <input
                type="password"
                autoFocus
                placeholder="passphrase"
                style={{ width: 260 }}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                disabled={!!busy}
              />
              <button className="btn gold" type="submit" disabled={!!busy || !pass}>
                {busy ?? 'Unlock'}
              </button>
            </form>
            <div className="formrow" style={{ marginTop: 10 }}>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
                style={{ display: 'none' }}
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  await run(async () => {
                    const kit = JSON.parse(await f.text()) as { recoveryKeyB64?: string }
                    if (!kit.recoveryKeyB64) throw new Error('not a Scarab recovery-key file')
                    b64decode(kit.recoveryKeyB64)
                    await unlockVault({ recoveryKeyB64: kit.recoveryKeyB64 })
                  }, 'Decrypting…')
                  if (fileRef.current) fileRef.current.value = ''
                }}
              />
              <button className="btn ghosty" disabled={!!busy} onClick={() => fileRef.current?.click()}>
                Use recovery key…
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
          </>
        ) : (
          <>
            <h2>Nothing here yet</h2>
            <p className="sub2">
              Start a zero-knowledge session: everything you import lives in this tab, and saving encrypts it
              before upload. The server never receives plaintext.
            </p>
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
