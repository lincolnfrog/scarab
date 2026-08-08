import { useCallback, useEffect, useRef, useState } from 'react'
import { b64decode, b64encode, createVault, openVault, sha256Hex, type VaultBlob } from '../../shared/vault'
import { get, post, put } from '../api'
import type { Dump } from '../../engine/snapshot'
import { enterLocalMode, exitLocalMode, localMode } from '../local'

type VaultInfo = { version: number; sha256: string; size: number; data: string; updated_at: string }

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
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [engineResult, setEngineResult] = useState<string[] | null>(null)
  const restoreFileRef = useRef<HTMLInputElement>(null)
  const recoveryFileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(
    () =>
      get<VaultInfo>('/api/vault')
        .then(setInfo)
        .catch(() => setInfo(null)),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  async function backupEncrypted() {
    setMsg(null)
    if (pass.length < 8) return setMsg('Passphrase needs at least 8 characters.')
    if (pass !== pass2) return setMsg('Passphrases do not match.')
    setBusy('Encrypting in your browser…')
    try {
      const dump = await get<object>('/api/export')
      const plaintext = new TextEncoder().encode(JSON.stringify(dump))
      const { blob, recoveryKeyB64 } = await createVault(pass, plaintext)
      const data = JSON.stringify(blob)
      setBusy('Uploading ciphertext…')
      const r = await put<{ ok: true; version: number; sha256: string }>('/api/vault', {
        data,
        version: info?.version ?? 0,
      })
      download(
        `scarab-recovery-key-${today()}.json`,
        JSON.stringify(
          {
            note: 'Scarab vault recovery key. This OR your passphrase decrypts the vault. Zero-knowledge means no reset — keep this somewhere real.',
            created: new Date().toISOString(),
            vaultVersion: r.version,
            recoveryKeyB64,
          },
          null,
          2,
        ),
      )
      setMsg(
        `Encrypted backup v${r.version} stored (${(plaintext.length / 1024).toFixed(0)} KB plaintext → ciphertext sha ${r.sha256.slice(0, 12)}…). Recovery key downloaded — file it with the passports.`,
      )
      setPass('')
      setPass2('')
      load()
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  async function restoreEncrypted(secret: { passphrase: string } | { recoveryKeyB64: string }) {
    setMsg(null)
    if (!info) return setMsg('No vault stored yet.')
    if (
      !window.confirm(
        `Decrypt vault v${info.version} (saved ${info.updated_at} UTC) and REPLACE all current data with it?`,
      )
    )
      return
    setBusy('Decrypting…')
    try {
      const blob = JSON.parse(info.data) as VaultBlob
      const plaintext = await openVault(blob, secret)
      setBusy('Restoring…')
      const dump = JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>
      await post('/api/import', { ...dump, confirm: 'REPLACE' })
      setMsg('Vault restored. Reloading…')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    } finally {
      setBusy(null)
    }
  }

  async function exportPlain() {
    const dump = await get<object>('/api/export')
    download(`scarab-export-${today()}.json`, JSON.stringify(dump, null, 1))
  }

  async function restorePlain(file: File) {
    setMsg(null)
    try {
      const dump = JSON.parse(await file.text()) as Record<string, unknown>
      if (!window.confirm('REPLACE all current data with this export file?')) return
      await post('/api/import', { ...dump, confirm: 'REPLACE' })
      setMsg('Restored from file. Reloading…')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function runLocalEngine() {
    setEngineResult(['Loading WASM SQLite + engine…'])
    try {
      const t0 = performance.now()
      // The entire engine — schema, migrations, net-worth derivation — loaded
      // into this tab. sql.js WASM fetches lazily so normal visits never pay.
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
      lines.push(`Database rebuilt in this browser tab: ${txCount} transactions, schema v${dump.schemaVersion} (${(performance.now() - t1).toFixed(0)}ms)`)
      setEngineResult([...lines])

      const t2 = performance.now()
      const today = new Date().toISOString().slice(0, 10)
      const local = netWorthSeries(db, today)
      const server = await get<{ series: { month: string; total: number }[] }>('/api/networth')
      const localLast = local[local.length - 1]
      const serverLast = server.series[server.series.length - 1]
      const match =
        local.length === server.series.length &&
        local.every((p, i) => p.total === server.series[i]!.total && p.month === server.series[i]!.month)
      lines.push(
        `Net worth computed locally in ${(performance.now() - t2).toFixed(0)}ms: ${local.length} months, latest $${((localLast?.total ?? 0) / 100).toLocaleString('en-US')}`,
      )
      lines.push(
        match
          ? `✓ PARITY: every one of ${local.length} months matches the server's computation exactly.`
          : `✗ MISMATCH: local ${localLast?.total} vs server ${serverLast?.total} — report this!`,
      )
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
          Backups are encrypted <b className="inkstrong">in this browser tab</b> before anything is uploaded —
          the server stores ciphertext it cannot read. Your passphrase (or the downloaded recovery key)
          decrypts; there is <b className="inkstrong">no reset</b>. This is the scarab.one zero-knowledge
          architecture running in embryo: same format, same guarantee, spelled out in{' '}
          <span className="num">PRIVACY.md</span>.
        </p>
      </div>

      <div className="card c7">
        <div className="h4row">
          <h2>Encrypted vault</h2>
          <div className="right muted">
            {info
              ? `v${info.version} · ${(info.size / 1024).toFixed(0)} KB · ${info.updated_at} UTC · sha ${info.sha256.slice(0, 10)}…`
              : 'nothing stored yet'}
          </div>
        </div>
        <div className="formrow">
          <input
            type="password"
            placeholder="vault passphrase (8+ chars)"
            style={{ width: 220 }}
            value={pass}
            onChange={(e) => setPass(e.target.value)}
          />
          <input
            type="password"
            placeholder="repeat it"
            style={{ width: 160 }}
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
          />
          <button className="btn gold" disabled={!!busy || !pass} onClick={backupEncrypted}>
            {busy ?? 'Encrypt & store backup'}
          </button>
        </div>
        {info && (
          <div className="formrow" style={{ marginTop: 10 }}>
            <button
              className="btn"
              disabled={!!busy || !pass}
              onClick={() => restoreEncrypted({ passphrase: pass })}
              title="uses the passphrase typed above"
            >
              Restore from vault (passphrase)
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
                  restoreEncrypted({ recoveryKeyB64: kit.recoveryKeyB64 })
                } catch (err) {
                  setMsg(`${err instanceof Error ? err.message : err}`)
                } finally {
                  if (recoveryFileRef.current) recoveryFileRef.current.value = ''
                }
              }}
            />
            <button className="btn ghosty" disabled={!!busy} onClick={() => recoveryFileRef.current?.click()}>
              Restore with recovery key…
            </button>
            <button className="btn ghosty" disabled={!!busy} onClick={verifyBlob} title="hash the stored ciphertext locally and compare to the server's claim">
              Verify integrity
            </button>
          </div>
        )}
        <p className="sub2" style={{ marginTop: 10 }}>
          Every backup mints a fresh recovery key and downloads it. The passphrase is the durable secret;
          recovery keys are per-backup spares.
        </p>
        {msg && <div className="sub2 importmsg">{msg}</div>}
      </div>

      <div className="card c12">
        <div className="h4row">
          <h2>Local engine (scarab.one preview)</h2>
          <div className="right muted">the browser is the machine — the server becomes a ciphertext courier</div>
        </div>
        <div className="formrow">
          <button className="btn" onClick={runLocalEngine}>
            Rebuild my database in this tab &amp; verify parity
          </button>
          {!localMode.active ? (
            <button
              className="btn gold"
              onClick={async () => {
                setEngineResult(['Entering local mode…'])
                try {
                  const dump = await get<Dump>('/api/export')
                  await enterLocalMode(dump)
                  setEngineResult([
                    '✓ Local mode ON — every screen now runs on the in-tab engine.',
                    'Changes stay in this tab; use “Encrypt & store backup” above to save them to the vault.',
                  ])
                } catch (e) {
                  setEngineResult([`Failed: ${e instanceof Error ? e.message : e}`])
                }
              }}
            >
              Enter local mode
            </button>
          ) : (
            <button className="btn" onClick={() => exitLocalMode()}>
              Exit local mode (reloads, discards unsaved local changes)
            </button>
          )}
        </div>
        {engineResult && (
          <div className="sub2" style={{ marginTop: 10, fontFamily: 'var(--mono)', fontSize: 12 }}>
            {engineResult.map((l, i) => (
              <div key={i} className={l.startsWith('✓') ? 'pos' : l.startsWith('✗') ? 'neg' : ''}>{l}</div>
            ))}
          </div>
        )}
        <p className="sub2" style={{ marginTop: 10, maxWidth: '78ch' }}>
          This loads SQLite (compiled to WebAssembly) plus Scarab's entire engine into the page, rebuilds your
          full database from an export, and recomputes the net-worth history locally — then checks it against
          the server month by month. Identical engine, two runtimes: the foundation of the zero-knowledge mode,
          where this tab is the only place your data ever exists in plaintext.
        </p>
      </div>

      <div className="card c5">
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
            Restore from export file…
          </button>
        </div>
        <p className="sub2" style={{ marginTop: 10 }}>
          Everything — every transaction, trade, price, rule, and setting — in one readable file. Works as a
          local backup, a migration path, and an audit: open it and see exactly what Scarab knows.
        </p>
      </div>
    </div>
  )
}
