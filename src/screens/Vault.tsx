import { useCallback, useEffect, useRef, useState } from 'react'
import { b64decode, sha256Hex } from '../../shared/vault'
import { get, post } from '../api'
import type { Dump } from '../../engine/snapshot'
import { enterLocalMode, exitLocalMode, loadLocalDump, localMode } from '../local'
import { fetchVaultInfo, saveVault, startEmpty, unlockVault, type VaultInfo } from '../session'

function download(filename: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const today = () => new Date().toISOString().slice(0, 10)

function recoveryKit(recoveryKeyB64: string, vaultVersion: number) {
  download(
    `scarab-recovery-key-${today()}.json`,
    JSON.stringify(
      {
        note: 'Scarab vault recovery key. This OR your passphrase decrypts the vault. Zero-knowledge means no reset — keep this somewhere real.',
        created: new Date().toISOString(),
        vaultVersion,
        recoveryKeyB64,
      },
      null,
      2,
    ),
  )
}

export default function Vault() {
  const [info, setInfo] = useState<VaultInfo | null>(null)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [rotating, setRotating] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [engineResult, setEngineResult] = useState<string[] | null>(null)
  const [basket, setBasket] = useState<{ builtAt: string | null; count: number; errors: string[]; building: boolean } | null>(null)
  const [, bump] = useState(0)
  const restoreFileRef = useRef<HTMLInputElement>(null)
  const recoveryFileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    fetchVaultInfo().then(setInfo).catch(() => setInfo(null))
    fetch('/api/basket/status').then((r) => (r.ok ? r.json() : null)).then(setBasket).catch(() => setBasket(null))
  }, [])
  useEffect(() => {
    load()
    const rerender = () => bump((n) => n + 1)
    window.addEventListener('scarab-mode', rerender)
    return () => window.removeEventListener('scarab-mode', rerender)
  }, [load])

  const local = localMode.active
  const session = localMode.vault
  const fail = (e: unknown) => setMsg(`${e instanceof Error ? e.message : e}`)

  /* ---------- save ---------- */

  async function save(rotate: boolean) {
    setMsg(null)
    const needsPass = rotate || !session
    if (needsPass) {
      if (pass.length < 8) return setMsg('Passphrase needs at least 8 characters.')
      if (pass !== pass2) return setMsg('Passphrases do not match.')
    }
    setBusy('Encrypting in this tab…')
    try {
      const r = await saveVault({ passphrase: needsPass ? pass : undefined, rotate })
      if (r.recoveryKeyB64) recoveryKit(r.recoveryKeyB64, r.version)
      setMsg(
        `Vault v${r.version} stored (${(r.bytes / 1024).toFixed(0)} KB plaintext → ciphertext sha ${r.sha256.slice(0, 12)}…).` +
          (r.recoveryKeyB64 ? ' Recovery key downloaded — file it with the passports.' : ' Same key as before; your filed recovery key still works.'),
      )
      setPass('')
      setPass2('')
      setRotating(false)
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  /** Household mode: encrypt the server's data into the vault (the pre-ZK backup path). */
  async function backupFromServer() {
    setMsg(null)
    if (pass.length < 8) return setMsg('Passphrase needs at least 8 characters.')
    if (pass !== pass2) return setMsg('Passphrases do not match.')
    setBusy('Encrypting in this tab…')
    try {
      const dump = await get<Dump>('/api/export')
      // Reuse the session machinery by booting a throwaway local session? No —
      // household mode must keep running on the server. Seal directly instead.
      const { createVault } = await import('../../shared/vault')
      const plaintext = new TextEncoder().encode(JSON.stringify(dump))
      const { blob, recoveryKeyB64 } = await createVault(pass, plaintext)
      const r = await fetch('/api/vault', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ data: JSON.stringify(blob), version: info?.version ?? 0 }),
      })
      if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { error?: string } | null)?.error ?? `${r.status}`)
      const j = (await r.json()) as { version: number; sha256: string }
      recoveryKit(recoveryKeyB64, j.version)
      setMsg(`Encrypted backup v${j.version} stored (${(plaintext.length / 1024).toFixed(0)} KB → sha ${j.sha256.slice(0, 12)}…). Recovery key downloaded.`)
      setPass('')
      setPass2('')
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  /* ---------- unlock ---------- */

  async function unlock(secret: { passphrase: string } | { recoveryKeyB64: string }) {
    setMsg(null)
    if (!info) return setMsg('No vault stored yet.')
    if (local && localMode.dirty && !window.confirm('Replace this tab’s unsaved data with the vault contents?')) return
    setBusy('Decrypting in this tab…')
    try {
      const r = await unlockVault(secret)
      setMsg(`Vault v${r.version} unlocked into this tab. The server never saw the plaintext.`)
      setPass('')
      setPass2('')
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  /** Household mode only: decrypt and load into the server database. */
  async function restoreToServer() {
    setMsg(null)
    if (!info) return setMsg('No vault stored yet.')
    if (!window.confirm(`Decrypt vault v${info.version} and REPLACE the server's data with it? (This puts plaintext on the server — household mode.)`)) return
    setBusy('Decrypting…')
    try {
      const { openVault } = await import('../../shared/vault')
      const plaintext = await openVault(JSON.parse(info.data), { passphrase: pass })
      const dump = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
      await post('/api/import', { ...dump, confirm: 'REPLACE' })
      setMsg('Vault restored to the server. Reloading…')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  /* ---------- plain export ---------- */

  async function exportPlain() {
    const dump = await get<object>('/api/export')
    download(`scarab-export-${today()}.json`, JSON.stringify(dump, null, 1))
  }

  async function restorePlain(file: File) {
    setMsg(null)
    try {
      const dump = JSON.parse(await file.text()) as Dump
      if (local) {
        if (!window.confirm('Replace this tab’s data with the export file?')) return
        await loadLocalDump(dump)
        setMsg('Loaded into this tab. Save to the vault to keep it.')
      } else {
        if (!window.confirm('REPLACE all server data with this export file?')) return
        await post('/api/import', { ...dump, confirm: 'REPLACE' })
        setMsg('Restored from file. Reloading…')
        setTimeout(() => window.location.reload(), 800)
      }
    } catch (e) {
      fail(e)
    } finally {
      if (restoreFileRef.current) restoreFileRef.current.value = ''
    }
  }

  /* ---------- parity check ---------- */

  async function runParity() {
    setEngineResult(['Loading WASM SQLite + engine…'])
    try {
      const t0 = performance.now()
      const [{ openBrowserDb }, { migrate }, { loadDump }, { netWorthSeries }, wasmUrl] = await Promise.all([
        import('../../engine/sqljs-db'),
        import('../../engine/migrations'),
        import('../../engine/snapshot'),
        import('../../engine/networth'),
        import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
      ])
      const lines = [`Engine + WASM loaded in ${(performance.now() - t0).toFixed(0)}ms`]
      setEngineResult([...lines])
      const t1 = performance.now()
      const dump = await get<Dump>('/api/export')
      const db = await openBrowserDb({ wasmUrl })
      migrate(db)
      loadDump(db, dump)
      const txCount = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
      lines.push(`Database rebuilt in a scratch engine: ${txCount} transactions, schema v${dump.schemaVersion} (${(performance.now() - t1).toFixed(0)}ms)`)
      const t2 = performance.now()
      const localSeries = netWorthSeries(db, today())
      const ref = await get<{ series: { month: string; total: number }[] }>('/api/networth')
      const match =
        localSeries.length === ref.series.length &&
        localSeries.every((p, i) => p.total === ref.series[i]!.total && p.month === ref.series[i]!.month)
      lines.push(`Net worth recomputed in ${(performance.now() - t2).toFixed(0)}ms: ${localSeries.length} months`)
      lines.push(match ? `✓ PARITY: all ${localSeries.length} months match exactly.` : `✗ MISMATCH — report this!`)
      db.close()
      setEngineResult([...lines])
    } catch (e) {
      setEngineResult([`Failed: ${e instanceof Error ? e.message : e}`])
    }
  }

  async function verifyBlob() {
    if (!info) return
    const sha = await sha256Hex(new TextEncoder().encode(info.data))
    setMsg(
      sha === info.sha256
        ? `Verified: stored ciphertext hashes to ${sha.slice(0, 16)}… exactly as the server claims.`
        : `MISMATCH: server says ${info.sha256.slice(0, 16)}…, actual is ${sha.slice(0, 16)}…`,
    )
  }

  const passInputs = (
    <>
      <input type="password" placeholder="vault passphrase (8+ chars)" style={{ width: 220 }} value={pass} onChange={(e) => setPass(e.target.value)} />
      <input type="password" placeholder="repeat it" style={{ width: 160 }} value={pass2} onChange={(e) => setPass2(e.target.value)} />
    </>
  )

  return (
    <div className="grid12">
      <div className="card c12">
        <h2>How this works</h2>
        <p>
          A <b className="inkstrong">zero-knowledge session</b> runs Scarab entirely in this browser tab: the
          vault is decrypted here, every screen computes here, and saving encrypts here before anything is
          uploaded. The server stores ciphertext it cannot read and couriers a daily price basket that is the
          same for everyone. Your passphrase (or the filed recovery key) decrypts; there is{' '}
          <b className="inkstrong">no reset</b>. Details and honest limits in <span className="num">PRIVACY.md</span>.
        </p>
      </div>

      {/* ---------- session ---------- */}
      <div className="card c5">
        <div className="h4row">
          <h2>Session</h2>
          <div className="right muted">{local ? 'zero-knowledge · this tab' : 'household · server-side data'}</div>
        </div>
        {local ? (
          <>
            <p className="sub2">
              {session
                ? `Unlocked from vault v${session.version} — the key stays in memory until you close the tab.`
                : 'Started without a vault — set a passphrase below to save.'}{' '}
              {localMode.dirty ? <b className="neg">Unsaved changes.</b> : <span className="pos">Everything saved.</span>}
            </p>
            <div className="formrow" style={{ marginTop: 8 }}>
              <button className="btn ghosty" onClick={() => exitLocalMode()}>
                End session {localMode.dirty ? '(discards unsaved changes)' : ''}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="sub2">Every screen is reading the server's database. Start a session to move to zero-knowledge.</p>
            <div className="formrow" style={{ marginTop: 8 }}>
              <button className="btn gold" disabled={!!busy} onClick={() => startEmpty().catch(fail)}>
                Start empty in this tab
              </button>
              <button
                className="btn"
                disabled={!!busy}
                onClick={async () => {
                  try {
                    await enterLocalMode(await get<Dump>('/api/export'))
                    setMsg('Server data copied into this tab. Save to the vault to keep changes.')
                  } catch (e) {
                    fail(e)
                  }
                }}
                title="copy the server's current data into an in-tab session"
              >
                Start from server data
              </button>
            </div>
          </>
        )}
        <div className="sub2 topline">
          <b className="inkstrong">Price basket</b>{' '}
          {basket
            ? basket.count > 0
              ? `${basket.count.toLocaleString('en-US')} symbols · built ${basket.builtAt?.replace('T', ' ').slice(0, 16)} UTC`
              : basket.building
                ? 'building…'
                : 'not built yet'
            : '—'}
          {basket && basket.errors.length > 0 && (
            <div className="neg" style={{ marginTop: 4 }}>{basket.errors.slice(0, 3).join(' · ')}{basket.errors.length > 3 ? ` · +${basket.errors.length - 3} more` : ''}</div>
          )}
          <div className="muted" style={{ marginTop: 4 }}>
            Every listed US stock and ETF plus the top 500 crypto assets, quoted once a day and served whole — a session picks
            its own symbols out locally, so the server never learns what you hold.
          </div>
        </div>
        <div className="formrow" style={{ marginTop: 10 }}>
          <button
            className="btn mini ghosty"
            disabled={!!busy}
            onClick={async () => {
              setBusy('Building basket…')
              try {
                const r = await fetch('/api/basket/rebuild', { method: 'POST' })
                const j = (await r.json()) as { stocks: number; crypto: number; universe: number; errors: string[]; ms: number }
                setMsg(`Basket: ${j.stocks} stocks of ${j.universe} listed, ${j.crypto} crypto, ${(j.ms / 1000).toFixed(1)}s${j.errors.length ? ` — ${j.errors.length} error(s), see above` : ''}.`)
                load()
              } catch (e) {
                fail(e)
              } finally {
                setBusy(null)
              }
            }}
          >
            Rebuild basket now
          </button>
          <button className="btn mini ghosty" onClick={runParity} title="rebuild the database in a scratch engine and check net worth month by month">
            Run engine parity check
          </button>
        </div>
        {engineResult && (
          <div className="sub2" style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 12 }}>
            {engineResult.map((l, i) => (
              <div key={i} className={l.startsWith('✓') ? 'pos' : l.startsWith('✗') ? 'neg' : ''}>{l}</div>
            ))}
          </div>
        )}
      </div>

      {/* ---------- vault ---------- */}
      <div className="card c7">
        <div className="h4row">
          <h2>Encrypted vault</h2>
          <div className="right muted">
            {info
              ? `v${info.version} · ${(info.size / 1024).toFixed(0)} KB · ${info.updated_at} UTC · sha ${info.sha256.slice(0, 10)}…`
              : 'nothing stored yet'}
          </div>
        </div>

        {local && session && !rotating ? (
          <div className="formrow">
            <button className="btn gold" disabled={!!busy} onClick={() => save(false)}>
              {busy ?? (localMode.dirty ? 'Save to vault' : 'Save to vault (no changes)')}
            </button>
            <button className="btn ghosty" disabled={!!busy} onClick={() => setRotating(true)}>
              Rotate passphrase & recovery key…
            </button>
          </div>
        ) : local ? (
          <div className="formrow">
            {passInputs}
            <button className="btn gold" disabled={!!busy || !pass} onClick={() => save(rotating)}>
              {busy ?? (rotating ? 'Rotate & save' : info ? 'Save to vault (replaces stored)' : 'Create vault & save')}
            </button>
            {rotating && (
              <button className="btn ghosty" onClick={() => setRotating(false)}>
                Cancel
              </button>
            )}
          </div>
        ) : (
          <div className="formrow">
            {passInputs}
            <button className="btn gold" disabled={!!busy || !pass} onClick={backupFromServer}>
              {busy ?? 'Encrypt server data & store'}
            </button>
          </div>
        )}

        {info && (
          <div className="formrow" style={{ marginTop: 10 }}>
            {local && session && !rotating && (
              <input type="password" placeholder="passphrase to unlock" style={{ width: 200 }} value={pass} onChange={(e) => setPass(e.target.value)} />
            )}
            <button className="btn" disabled={!!busy || !pass} onClick={() => unlock({ passphrase: pass })} title="decrypt in this tab and run on it — the server never sees plaintext">
              Unlock into this tab
            </button>
            <input
              ref={recoveryFileRef}
              type="file"
              accept=".json"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const f = e.target.files?.[0]
                if (!f) return
                try {
                  const kit = JSON.parse(await f.text()) as { recoveryKeyB64?: string }
                  if (!kit.recoveryKeyB64) throw new Error('not a Scarab recovery-key file')
                  b64decode(kit.recoveryKeyB64)
                  unlock({ recoveryKeyB64: kit.recoveryKeyB64 })
                } catch (err) {
                  fail(err)
                } finally {
                  if (recoveryFileRef.current) recoveryFileRef.current.value = ''
                }
              }}
            />
            <button className="btn ghosty" disabled={!!busy} onClick={() => recoveryFileRef.current?.click()}>
              Unlock with recovery key…
            </button>
            <button className="btn ghosty" disabled={!!busy} onClick={verifyBlob} title="hash the stored ciphertext locally and compare to the server's claim">
              Verify integrity
            </button>
            {!local && (
              <button className="btn mini ghosty" disabled={!!busy || !pass} onClick={restoreToServer} title="household mode: decrypt and load into the server database">
                Restore to server…
              </button>
            )}
          </div>
        )}
        <p className="sub2" style={{ marginTop: 10 }}>
          Saving from an unlocked session reseals under the same key — no new recovery key each time. Rotating
          mints a fresh key and downloads a new recovery file; the old one stops working.
        </p>
        {msg && <div className="sub2 importmsg">{msg}</div>}
      </div>

      {/* ---------- plain export ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Plain export</h2>
          <div className="right muted">your data is yours — no crypto required</div>
        </div>
        <div className="formrow">
          <button className="btn" onClick={exportPlain}>
            Download full export (JSON)
          </button>
          <input
            ref={restoreFileRef}
            type="file"
            accept=".json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && restorePlain(e.target.files[0])}
          />
          <button className="btn ghosty" onClick={() => restoreFileRef.current?.click()}>
            {local ? 'Load export file into this tab…' : 'Restore from export file…'}
          </button>
        </div>
        <p className="sub2" style={{ marginTop: 10 }}>
          Everything — every transaction, trade, price, rule, and setting — in one readable file. Works as a
          local backup, a migration path, and an audit: open it and see exactly what Scarab knows.
          {local && ' In a session the file loads into this tab only.'}
        </p>
      </div>
    </div>
  )
}
