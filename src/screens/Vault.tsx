import { useCallback, useEffect, useRef, useState } from 'react'
import { sha256Hex, type PasskeyWrap } from '../../shared/vault'
import { autosave } from '../session'
import { get, post } from '../api'
import type { Dump } from '../../engine/snapshot'
import { CURRENT_VERSION } from '../../engine/upgrades'
import { enterLocalMode, exitLocalMode, loadLocalDump, localMode } from '../local'
import RecoveryCode from '../RecoveryCode'
import {
  addMember,
  addPasskey,
  createVault,
  fetchMembers,
  fetchVaultInfo,
  fetchVaultKeys,
  recoveryCodeOfSession,
  removeMember,
  removePasskey,
  rotateVault,
  saveVault,
  startEmpty,
  unlockVault,
  unlockWithRecoveryCode,
  type Member,
  type Unlocked,
  type VaultInfo,
} from '../session'

function download(filename: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

const today = () => new Date().toISOString().slice(0, 10)

export default function Vault() {
  const [info, setInfo] = useState<VaultInfo | null>(null)
  const [keys, setKeys] = useState<PasskeyWrap[]>([])
  const [members, setMembers] = useState<{ household: string; members: Member[] } | null>(null)
  const [label, setLabel] = useState('')
  const [memberEmail, setMemberEmail] = useState('')
  const [code, setCode] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [shown, setShown] = useState<{ code: string; title: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [engineResult, setEngineResult] = useState<string[] | null>(null)
  const [basket, setBasket] = useState<{ builtAt: string | null; count: number; errors: string[]; building: boolean } | null>(null)
  const [, bump] = useState(0)
  const restoreFileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => {
    fetchVaultInfo().then(setInfo).catch(() => setInfo(null))
    fetchVaultKeys().then((k) => setKeys(k?.keys ?? [])).catch(() => setKeys([]))
    fetchMembers().then(setMembers).catch(() => setMembers(null))
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

  /* ---------- save / create / passkeys ---------- */

  async function act(label: string, fn: () => Promise<string | void>) {
    setMsg(null)
    setBusy(label)
    try {
      const m = await fn()
      if (m) setMsg(m)
      load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const save = () =>
    act('Encrypting in this tab…', async () => {
      const r = await saveVault()
      return `Vault v${r.version} stored (${(r.bytes / 1024).toFixed(0)} KB plaintext → ciphertext sha ${r.sha256.slice(0, 12)}…). Same key as before; every passkey and the recovery code still work.`
    })

  const create = () =>
    act('Waiting for your passkey…', async () => {
      const r = await createVault(label.trim() || 'this device')
      setShown({ code: r.recoveryCode, title: `Vault v${r.version} created — your recovery code` })
      setLabel('')
    })

  const addDevice = () =>
    act('Waiting for the new passkey…', async () => {
      const w = await addPasskey(label.trim() || 'another device')
      setLabel('')
      return `Passkey "${w.label}" added and the vault saved. It can unlock from now on.`
    })

  /** A household member: their phone answers the QR prompt, their passkey lands in the header, then the server learns whose it is. */
  const addHousehold = () =>
    act('Waiting for their passkey…', async () => {
      const email = memberEmail.trim().toLowerCase()
      if (!email.includes('@')) throw new Error('Enter the Google account email they sign in with.')
      await addPasskey(email)
      await addMember(email)
      setMemberEmail('')
      return `${email} can now unlock this vault with their own passkey.`
    })

  const drop = (w: PasskeyWrap) =>
    act('Saving…', async () => {
      if (!window.confirm(`Remove the passkey "${w.label}"? It will no longer unlock the vault.`)) return
      await removePasskey(w.credentialId)
      const m = members?.members.find((x) => x.email === w.label)
      if (m && !keys.some((k) => k !== w && k.label === w.label)) await removeMember(m.email)
      return `Passkey "${w.label}" removed.`
    })

  const rotate = () =>
    act('Waiting for your passkey…', async () => {
      if (
        !window.confirm(
          'Rotate the vault key? The passkey you answer with stays; every other passkey and the old recovery code stop working and must be added again.',
        )
      )
        return
      const r = await rotateVault()
      setShown({ code: r.recoveryCode, title: `Vault v${r.version} re-keyed — new recovery code` })
      return `Re-keyed. Kept "${r.kept}"; add other devices and members again.`
    })

  /* ---------- unlock ---------- */

  const unlock = (fn: () => Promise<Unlocked>) =>
    act('Decrypting in this tab…', async () => {
      if (!info) throw new Error('No vault stored yet.')
      if (local && localMode.dirty && !window.confirm('Replace this tab’s unsaved data with the vault contents?')) return
      const r = await fn()
      setCode('')
      setRecovering(false)
      return (
        `Vault v${r.version} unlocked into this tab. The server never saw the plaintext.` +
        // The stored copy is still the older snapshot; the tab is left dirty on
        // purpose so a save reseals it at the current schema.
        (r.loaded.upgraded.length
          ? ` This snapshot was written by an older Scarab (schema v${r.loaded.from}) and was brought up to v${CURRENT_VERSION} as it loaded — save to keep it that way.`
          : '')
      )
    })

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
        if (!window.confirm(session ? 'Replace this tab’s data with the export file? It will be saved over the stored vault.' : 'Replace this tab’s data with the export file?')) return
        const loaded = await loadLocalDump(dump)
        const note = loaded.upgraded.length ? ` The file was schema v${loaded.from}; it was brought up to v${CURRENT_VERSION} as it loaded.` : ''
        setMsg((session ? 'Loaded into this tab; saving to the vault.' : 'Loaded into this tab. Create a vault to keep it.') + note)
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
      const loaded = loadDump(db, dump)
      const txCount = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
      const upgraded = loaded.upgraded.length ? ` → v${CURRENT_VERSION} (upgraded ${loaded.upgraded.join(', ')})` : ''
      lines.push(`Database rebuilt in a scratch engine: ${txCount} transactions, schema v${loaded.from}${upgraded} (${(performance.now() - t1).toFixed(0)}ms)`)
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

  return (
    <div className="grid12">
      <div className="card c12">
        <h2>How this works</h2>
        <p>
          A <b className="inkstrong">zero-knowledge session</b> runs Scarab entirely in this browser tab: the
          vault is decrypted here, every screen computes here, and saving encrypts here before anything is
          uploaded. The server stores ciphertext it cannot read and couriers a daily price basket that is the
          same for everyone. A passkey — fingerprint or face, synced by Apple or Google across your devices —
          decrypts; the printed recovery code is the only other way in, and there is{' '}
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
                ? `Vault v${session.version} — the key stays in memory until you close the tab, and every change is saved on its own.`
                : 'Started without a vault — create one below to save.'}{' '}
              {autosave.status === 'error' ? (
                <b className="neg">
                  Autosave failed: {autosave.error}.{' '}
                  {/version conflict/.test(autosave.error ?? '')
                    ? 'Another device saved first — export this tab’s data if you need it, then unlock again to load theirs.'
                    : 'Save to vault below to retry.'}
                </b>
              ) : autosave.status === 'saving' ? (
                <span className="muted">Saving…</span>
              ) : localMode.dirty ? (
                <b className="neg">{session ? 'Unsaved changes — saving shortly.' : 'Unsaved changes.'}</b>
              ) : (
                <span className="pos">Everything saved.</span>
              )}
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

        {shown && <RecoveryCode code={shown.code} title={shown.title} onDone={() => setShown(null)} />}

        {local && session ? (
          <div className="formrow">
            <button className="btn gold" disabled={!!busy} onClick={save}>
              {busy ?? (localMode.dirty ? 'Save to vault' : 'Save to vault (no changes)')}
            </button>
            <button className="btn ghosty" disabled={!!busy} onClick={rotate}>
              Rotate key…
            </button>
            <button
              className="btn ghosty"
              disabled={!!busy}
              onClick={() => {
                if (window.confirm('Show the recovery code? Anyone who sees it can open the vault.'))
                  setShown({ code: recoveryCodeOfSession(), title: 'Recovery code' })
              }}
            >
              Show recovery code
            </button>
          </div>
        ) : local ? (
          <div className="formrow">
            <input placeholder="name this device (e.g. Max's Mac)" style={{ width: 220 }} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!!busy} />
            <button className="btn gold" disabled={!!busy} onClick={create}>
              {busy ?? (info ? 'Create vault & save (replaces stored)' : 'Create vault with a passkey')}
            </button>
          </div>
        ) : (
          <p className="sub2">
            Household mode keeps plaintext on the server. To move into the vault, start a session from server data
            (left), then create the vault with a passkey here.
          </p>
        )}

        {info && (!local || !session) && (
          <div className="formrow" style={{ marginTop: 10 }}>
            {!recovering ? (
              <>
                <button className="btn" disabled={!!busy} onClick={() => unlock(unlockVault)} title="decrypt in this tab and run on it — the server never sees plaintext">
                  Unlock with passkey
                </button>
                <button className="btn ghosty" disabled={!!busy} onClick={() => setRecovering(true)}>
                  Use recovery code…
                </button>
              </>
            ) : (
              <>
                <input
                  autoFocus
                  placeholder="XXXX-XXXX-… (13 groups)"
                  spellCheck={false}
                  autoComplete="off"
                  style={{ width: 280, fontFamily: 'var(--mono)' }}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={!!busy}
                />
                <button className="btn" disabled={!!busy || !code.trim()} onClick={() => unlock(() => unlockWithRecoveryCode(code))}>
                  Unlock
                </button>
                <button className="btn ghosty" disabled={!!busy} onClick={() => setRecovering(false)}>
                  Back
                </button>
              </>
            )}
          </div>
        )}
        {info && (
          <div className="formrow" style={{ marginTop: 10 }}>
            <button className="btn mini ghosty" disabled={!!busy} onClick={verifyBlob} title="hash the stored ciphertext locally and compare to the server's claim">
              Verify integrity
            </button>
          </div>
        )}

        {/* ---------- passkeys & household ---------- */}
        {(session ? session.header.keys : keys).length > 0 && (
          <div className="topline">
            <div className="h4row">
              <b className="inkstrong">Passkeys</b>
              <div className="right muted">
                {members?.household && members.household !== 'dev@localhost' && members.members.length > 0
                  ? `household of ${members.household}`
                  : 'each one unlocks the same vault'}
              </div>
            </div>
            <table style={{ marginTop: 6 }}>
              <tbody>
                {(session ? session.header.keys : keys).map((w) => {
                  const m = members?.members.find((x) => x.email === w.label)
                  return (
                    <tr key={w.credentialId}>
                      <td>{w.label}</td>
                      <td className="muted">{m ? `household member · added by ${m.added_by}` : 'device'}</td>
                      <td className="muted num" style={{ whiteSpace: 'nowrap' }}>{w.addedAt.slice(0, 10)}</td>
                      <td className="right">
                        {session && (
                          <button className="btn mini ghosty" disabled={!!busy || session.header.keys.length === 1} onClick={() => drop(w)}>
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {session && (
              <>
                <div className="formrow" style={{ marginTop: 10 }}>
                  <input placeholder="name this device" style={{ width: 180 }} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!!busy} />
                  <button className="btn" disabled={!!busy} onClick={addDevice} title="register a passkey on this device, or on a phone via the QR prompt">
                    Add passkey
                  </button>
                  <input placeholder="partner's Google email" style={{ width: 200 }} value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)} disabled={!!busy} />
                  <button className="btn" disabled={!!busy || !memberEmail.trim()} onClick={addHousehold} title="they scan the QR prompt with their phone; their passkey joins the vault">
                    Add household member
                  </button>
                </div>
                <p className="sub2 muted" style={{ marginTop: 8 }}>
                  Adding a member: enter the Google account they sign in with, then hand them the QR prompt — their phone
                  creates the passkey, in their own Apple or Google account, and this tab wraps the vault key for it.
                  They unlock with a fingerprint from then on, and they are your recovery too.
                </p>
              </>
            )}
          </div>
        )}

        <p className="sub2" style={{ marginTop: 10 }}>
          Saving reseals under the same key — passkeys and the recovery code keep working. Rotating mints a fresh key
          and recovery code; every passkey but the one you answer with drops off.
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
