import { useEffect, useState, useSyncExternalStore } from 'react'
import { localDump, localMode } from '../../local'
import { pendingBackup, relationOf, restoreSnapshot, setPendingBackup, type OpenedSnapshot, type Restored } from '../../session'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { confirm } from '../../ui/dialogs'
import { relTime, shortDate, whoLabel } from '../../ui/syncStatus'
import { toast } from '../../ui/Toast'
import { useAction } from '../../ui/useAction'
import { compareCounts, countRows, deltaText, downloadFile, pinLabel, sameCounts, type CountRow } from './versions'
import './vault.css'

/**
 * Looking at an earlier version (from the server's history) or a backup file
 * before putting it back: what it holds, table by table, against this tab —
 * decrypted in the tab and loaded into a scratch database, never into the
 * tab's own. Restoring is never destructive: the version current now stays
 * in the history, kept from before the restore.
 *
 * Held outside React like the recovery-code sheet, so a preview opened from
 * a screen survives that screen remounting; the sync chip hosts it for the
 * whole session. A backup opened at the front door is offered here once the
 * session is open.
 */

let current: OpenedSnapshot | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const fn of listeners) fn()
}
/** Show a snapshot's preview (null closes it). */
export function showSnapshot(snap: OpenedSnapshot | null): void {
  current = snap
  emit()
}
const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
const snapshot = () => current

/** "1 kind of record differs", "3 kinds of record differ". */
const differ = (n: number) => (n === 1 ? '1 kind of record differs' : `${n} kinds of record differ`)

/** What to call it: "v41", "the backup". */
export const snapName = (s: OpenedSnapshot): string => (s.source.kind === 'history' ? `v${s.source.version}` : 'the backup')

/** Where it came from, in one line under the title. */
function originText(s: OpenedSnapshot, identity: string | null, now: number): string {
  const src = s.source
  if (src.kind === 'history') {
    const when = src.at !== null ? `saved ${relTime(src.at, now)}` : 'saved'
    const pin = pinLabel(src.pin)
    return `${when} by ${whoLabel(src.by, identity)}${pin ? ` · ${pin}` : ''}`
  }
  const taken = Date.parse(s.exportedAt)
  const rel = relationOf(s)
  const from = !rel ? `sealed for v${src.sealedAs}` : rel.sameVault ? `from this vault at v${src.sealedAs}` : 'from another vault'
  return `${src.name} · ${Number.isNaN(taken) ? 'taken' : `taken ${shortDate(taken)}`} · ${from}${rel?.sameVault && !rel.sameKey ? ', under an earlier key' : ''}`
}

/** Warnings and facts worth a line: a mismatched seal, an old schema, a file from elsewhere. */
function notes(s: OpenedSnapshot): { text: string; tone?: 'down' }[] {
  const out: { text: string; tone?: 'down' }[] = []
  const src = s.source
  if (src.kind === 'history' && src.sealedAs !== null && src.sealedAs !== src.version)
    out.push({
      text: `Its authenticated header says it was sealed as v${src.sealedAs}, not v${src.version}: the server’s history doesn’t match what was saved. Restore it only if you recognise it.`,
      tone: 'down',
    })
  if (src.kind === 'backup' && relationOf(s)?.sameVault === false)
    out.push({ text: 'This backup is from a different vault. Restoring puts its data in this one; this vault’s passkeys and recovery code stay as they are.' })
  if (s.unreadable) out.push({ text: `This version of Scarab can’t load it: ${s.unreadable}`, tone: 'down' })
  else if (s.upgraded.length) out.push({ text: `Written by an older Scarab (schema v${s.schemaVersion}); it is brought up to date as it loads.` })
  return out
}

/** The table: rows per kind of record, then against now. */
export function CountsTable({ rows, thenLabel, nowLabel }: { rows: CountRow[]; thenLabel: string; nowLabel: string | null }) {
  if (rows.length === 0) return <p className="sub2 muted zk-counts-empty">No records at all.</p>
  return (
    <table className="zk-counts">
      <thead>
        <tr>
          <th scope="col">Records</th>
          <th scope="col" className="r">
            {thenLabel}
          </th>
          {nowLabel !== null && (
            <>
              <th scope="col" className="r">
                {nowLabel}
              </th>
              <th scope="col" className="r">
                <span className="zk-sr">Change</span>
              </th>
            </>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.table} data-changed={r.delta !== null && r.delta !== 0 ? '' : undefined}>
            <th scope="row">{r.label}</th>
            <td className="r num">{r.then.toLocaleString('en-US')}</td>
            {nowLabel !== null && (
              <>
                <td className="r num">{r.now?.toLocaleString('en-US') ?? '—'}</td>
                <td className="r num zk-counts-delta">{deltaText(r.delta)}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Mounted once per session (by the sync chip). */
export function SnapshotPreviewHost() {
  const snap = useSyncExternalStore(subscribe, snapshot, snapshot)
  // A backup opened at the front door waits for the session: offer it once it is here.
  useEffect(() => {
    const offer = () => {
      const p = pendingBackup()
      if (p && !current && localMode.vault) showSnapshot(p)
    }
    offer()
    window.addEventListener('scarab-mode', offer)
    return () => window.removeEventListener('scarab-mode', offer)
  }, [])
  const close = () => {
    // Not now: the backup file is still on disk, and the Vault screen opens it again.
    if (current && pendingBackup() === current) setPendingBackup(null)
    showSnapshot(null)
  }
  return <SnapshotDialog snap={snap} onClose={close} />
}

function SnapshotDialog({ snap, onClose }: { snap: OpenedSnapshot | null; onClose: () => void }) {
  // Kept through the exit fade, so the dialog doesn't empty itself while closing.
  const [shown, setShown] = useState<OpenedSnapshot | null>(snap)
  const [nowCounts, setNowCounts] = useState<Record<string, number> | null | undefined>(undefined)
  useEffect(() => {
    if (snap) setShown(snap)
  }, [snap])
  useEffect(() => {
    if (!snap) return
    let live = true
    setNowCounts(undefined)
    ;(localMode.active ? localDump().then(countRows) : Promise.resolve(null))
      .then((c) => live && setNowCounts(c))
      .catch(() => live && setNowCounts(null))
    return () => {
      live = false
    }
  }, [snap])

  const restore = useAction(
    async (s: OpenedSnapshot): Promise<Restored | null> => {
      const v = localMode.vault?.version ?? null
      const dirty = localMode.dirty
      const next = v === null ? null : v + (dirty ? 2 : 1)
      const src = s.source
      const ok = await confirm({
        title: src.kind === 'history' ? `Restore v${src.version}?` : 'Restore this backup to the vault?',
        body: (
          <div className="zk-confirm">
            <p>
              Its data becomes the vault’s next version{next !== null ? <> (v{next})</> : null}.{' '}
              {v !== null ? (
                <>
                  The version you have now, <b>v{dirty ? v + 1 : v}</b>, stays in the vault’s history — kept from before this restore — so you can go back
                  to it.
                </>
              ) : null}
            </p>
            {dirty && <p>This tab’s unsaved changes are saved first, as a version of their own.</p>}
            <p>Only the data comes back: the passkeys, the household and the recovery code stay as they are now.</p>
            {src.kind === 'backup' && relationOf(s)?.sameVault === false && <p>It is from a different vault: its data replaces this vault’s.</p>}
          </div>
        ),
        confirmLabel: 'Restore',
      })
      return ok ? restoreSnapshot(s) : null
    },
    {
      errorPrefix: 'Couldn’t restore it',
      onDone: (r) => {
        if (!r) return
        if (r.skipped) toast.info('Nothing to restore: it holds exactly the data the vault holds now.')
        else toast.success(`Restored as v${r.version}${r.pinned !== null ? ` · v${r.pinned} is kept in the history` : ''}`)
        onClose()
      },
    },
  )

  const s = shown
  const now = Date.now()
  const rows = s?.counts ? compareCounts(s.counts, nowCounts ?? null) : []
  const hasSession = localMode.active && localMode.vault !== null
  const tabVersion = localMode.vault?.version ?? null
  const download = () => {
    if (!s) return
    const day = (Number.isNaN(Date.parse(s.exportedAt)) ? new Date() : new Date(s.exportedAt)).toISOString().slice(0, 10)
    const name = s.source.kind === 'history' ? `scarab-v${s.source.version}-${day}.json` : `scarab-backup-${day}.json`
    downloadFile(name, JSON.stringify(s.dump, null, 1))
    toast.success('Downloaded (plain JSON) — keep it as safe as the recovery code')
  }

  return (
    <Dialog
      open={snap !== null}
      onClose={onClose}
      width={520}
      dismissible={!restore.busy}
      title={s ? (s.source.kind === 'history' ? `Vault v${s.source.version}` : 'Backup file') : ''}
      subtitle={s ? originText(s, localMode.identity, now) : undefined}
      footer={
        s && (
          <div className="zk-preview-foot">
            <Button variant="ghost" disabled={restore.busy} onClick={onClose}>
              {s.source.kind === 'backup' && pendingBackup() === s ? 'Not now' : 'Close'}
            </Button>
            <Button variant="ghost" disabled={restore.busy} onClick={download} title="an unencrypted export of this version, saved to this device">
              Download (JSON)
            </Button>
            <Button variant="gold" busy={restore.busy} disabled={!hasSession || s.unreadable !== null} onClick={() => void restore.run(s)}>
              {s.source.kind === 'history' ? `Restore v${s.source.version}…` : 'Restore this backup to the vault…'}
            </Button>
          </div>
        )
      }
    >
      {s && (
        <div className="zk-preview">
          {notes(s).map((n, i) => (
            <p key={i} className="zk-preview-note" data-tone={n.tone}>
              {n.text}
            </p>
          ))}
          {s.counts && (
            <>
              <p className="zk-preview-sum" role="status">
                {nowCounts === undefined
                  ? 'Comparing with this tab…'
                  : nowCounts === null
                    ? `What ${snapName(s)} holds:`
                    : sameCounts(rows)
                      ? `The same number of records as this tab in every table${tabVersion !== null ? ` (v${tabVersion}${localMode.dirty ? ' and unsaved changes' : ''})` : ''} — the records themselves may still differ.`
                      : `${differ(rows.filter((r) => r.delta !== 0).length)} from this tab${tabVersion !== null ? ` (v${tabVersion}${localMode.dirty ? ' and unsaved changes' : ''})` : ''}.`}
              </p>
              <CountsTable rows={rows} thenLabel={s.source.kind === 'history' ? `v${s.source.version}` : 'Backup'} nowLabel={nowCounts ? 'Now' : null} />
            </>
          )}
          {!hasSession && <p className="sub2 muted">Open the vault to restore into it.</p>}
        </div>
      )}
    </Dialog>
  )
}
