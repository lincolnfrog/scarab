import { useRef, useState } from 'react'
import type { Dump } from '../../../engine/snapshot'
import { CURRENT_VERSION } from '../../../engine/upgrades'
import { get, post } from '../../api'
import { loadLocalDump, localMode } from '../../local'
import { passkeysWorkHere } from '../../passkey'
import { BackupNeedsKey, makeBackup, MAX_BACKUP_BYTES, openBackup, parseBackup, type BackupKey, type ParsedBackup } from '../../session'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { confirm } from '../../ui/dialogs'
import { Field, TextInput } from '../../ui/Field'
import { toast } from '../../ui/Toast'
import { useAction } from '../../ui/useAction'
import { showSnapshot } from './Preview'
import { downloadFile } from './versions'
import './vault.css'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The Backups card: the plain export — every row in one readable JSON file,
 * no crypto required — and loading one back (into this tab in a session, over
 * the server's data in household mode). In a session with a vault, also the
 * encrypted backup: a .scarab file sealed like a vault version, which only
 * the vault's passkeys and recovery code open, and which goes back into the
 * vault only through an explicit restore.
 */
export function BackupsCard() {
  const local = localMode.active
  const session = localMode.vault
  const fileRef = useRef<HTMLInputElement>(null)
  const backupRef = useRef<HTMLInputElement>(null)
  /** A backup sealed under another key than the session's, waiting for a passkey or its recovery code. */
  const [locked, setLocked] = useState<ParsedBackup | null>(null)
  const [code, setCode] = useState('')

  const exportPlain = useAction(
    async () => {
      const dump = await get<object>('/api/export')
      downloadFile(`scarab-export-${today()}.json`, JSON.stringify(dump, null, 1))
    },
    { errorPrefix: 'Couldn’t export' },
  )

  const restore = useAction(
    async (file: File) => {
      const dump = JSON.parse(await file.text()) as Dump
      if (local) {
        const ok = await confirm({
          title: 'Replace this tab’s data with the export file?',
          body: session ? 'It is then saved over the stored vault, as a new version.' : 'Nothing is saved until you create a vault.',
          confirmLabel: 'Replace',
          danger: true,
        })
        if (!ok) return
        const loaded = await loadLocalDump(dump) // the screens remount: say it in toasts
        toast.success(session ? 'Loaded into this tab; saving to the vault' : 'Loaded into this tab — create a vault to keep it')
        if (loaded.upgraded.length) toast.info(`The file was schema v${loaded.from}; it was brought up to v${CURRENT_VERSION} as it loaded.`)
      } else {
        const ok = await confirm({
          title: 'Replace all server data with this export file?',
          body: 'Every row the server holds is replaced by the file’s contents.',
          confirmLabel: 'Replace server data',
          danger: true,
          typeToConfirm: 'REPLACE',
        })
        if (!ok) return
        await post('/api/import', { ...dump, confirm: 'REPLACE' })
        toast.success('Restored from file — reloading')
        setTimeout(() => window.location.reload(), 800)
      }
    },
    { errorPrefix: 'Couldn’t load that file' },
  )

  const makeEncrypted = useAction(
    async () => {
      const b = await makeBackup()
      downloadFile(b.name, b.text)
      return b
    },
    {
      success: (b) => `Encrypted backup of v${b.version}${b.unsaved ? ' and this tab’s unsaved changes' : ''} downloaded`,
      errorPrefix: 'Couldn’t make the backup',
    },
  )

  /** Open a backup file: with this session's key when it is sealed under it (no prompt), else ask for a passkey or its code. */
  const openFile = useAction(
    async (file: File) => {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('That file is too large to be a Scarab backup.')
      const parsed = parseBackup(await file.text(), file.name)
      try {
        showSnapshot(await openBackup(parsed, { kind: 'session' }))
      } catch (e) {
        if (!(e instanceof BackupNeedsKey)) throw e
        setCode('')
        setLocked(parsed)
      }
    },
    { errorPrefix: 'Couldn’t open that backup' },
  )
  const unlockFile = useAction(
    async (how: BackupKey) => {
      if (!locked) return
      const snap = await openBackup(locked, how)
      setLocked(null)
      showSnapshot(snap)
    },
    { errorPrefix: 'Couldn’t open the backup' },
  )

  const passkeyCan = !!locked && passkeysWorkHere(locked.blob.rpId) && locked.blob.keys.length > 0

  return (
    <>
      <section className="card c6 zk-card" aria-labelledby="zk-backups-h">
        <div className="h4row">
          <h2 id="zk-backups-h">Backups</h2>
          <div className="right muted">your data is yours</div>
        </div>
        <p className="zk-lead">
          Everything — every transaction, trade, price, rule and setting — in one readable file. A local backup, a way to move, and an audit: open it
          and see exactly what Scarab knows.{local && ' In a session the file comes from, and loads into, this tab only.'}
        </p>
        <div className="formrow zk-actions">
          <Button busy={exportPlain.busy} onClick={() => void exportPlain.run()}>
            Download export (JSON)
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void restore.run(f)
            }}
          />
          <Button variant="ghost" busy={restore.busy} onClick={() => fileRef.current?.click()}>
            {local ? 'Load an export into this tab…' : 'Restore from an export…'}
          </Button>
        </div>
        <p className="sub2 muted zk-foot">The file is plaintext: keep it somewhere as safe as the recovery code.</p>

        {session && (
          <div className="zk-backup-enc">
            <h3 className="zk-h3">Encrypted backup</h3>
            <p className="zk-lead">
              A <span className="num">.scarab</span> file of this tab, sealed like a vault version: only the vault’s passkeys and its recovery code open it
              (the ones it has today — a backup keeps its key through later rotations). Nothing is uploaded to make one. Putting one back is an explicit
              restore, and the version it replaces stays in the history.
            </p>
            <div className="formrow zk-actions">
              <Button busy={makeEncrypted.busy} onClick={() => void makeEncrypted.run()}>
                Download encrypted backup
              </Button>
              <input
                ref={backupRef}
                type="file"
                accept=".scarab,application/json"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (f) void openFile.run(f)
                }}
              />
              <Button variant="ghost" busy={openFile.busy} onClick={() => backupRef.current?.click()}>
                Open a backup…
              </Button>
            </div>
          </div>
        )}
      </section>

      {/* Outside the card: its heading styles must not reach the dialog's title. */}
      <Dialog
        open={locked !== null}
        onClose={() => setLocked(null)}
        dismissible={!unlockFile.busy}
        title="Open this backup"
        subtitle={locked?.name}
        footer={
          <Button variant="ghost" disabled={unlockFile.busy} onClick={() => setLocked(null)}>
            Cancel
          </Button>
        }
      >
        <div className="zk-confirm">
          <p>It is sealed under a different key than this session’s — from before a key rotation, or from another vault. A passkey that was on the vault when it was made opens it, or its recovery code.</p>
          {passkeyCan && (
            <div className="formrow">
              <Button variant="gold" busy={unlockFile.busy} onClick={() => void unlockFile.run({ kind: 'passkey' })}>
                Open with a passkey
              </Button>
            </div>
          )}
          <form
            className="zk-recover"
            onSubmit={(e) => {
              e.preventDefault()
              if (code.trim() && !unlockFile.busy) void unlockFile.run({ kind: 'recovery', code })
            }}
          >
            <Field label={passkeyCan ? 'Or its recovery code' : 'Its recovery code'} hint="The code from when the backup was made — dashes and case don’t matter">
              <TextInput
                className="zk-code-input"
                placeholder="XXXX-XXXX-XXXX-…"
                spellCheck={false}
                autoComplete="off"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={unlockFile.busy}
              />
            </Field>
            <div className="formrow">
              <Button type="submit" busy={unlockFile.busy} disabled={!code.trim()}>
                Open
              </Button>
            </div>
          </form>
        </div>
      </Dialog>
    </>
  )
}
