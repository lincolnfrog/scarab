import { useEffect, useState } from 'react'
import { todayLocal } from '../shared/dates'
import { exitLocalMode, localDump } from './local'
import { confirmKeepOverOlder, confirmOpenOlder } from './screens/vault/confirmOlder'
import { keepMine, refreshFromVault, RollbackRefused, SessionLocked } from './session'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import { confirm } from './ui/dialogs'
import { relTime, unsavedText, updatedText, useNow, useSyncStatus, whoLabel, type SyncStatus } from './ui/syncStatus'
import { toast } from './ui/Toast'
import { useAction } from './ui/useAction'
import './screens/vault/vault.css'

/**
 * The way out when this tab and the stored vault disagree: the other member
 * saved while this tab had unsaved work (or a save of this tab's was refused
 * because of it), or the stored vault went away or backwards. Opened from
 * the banner, the sync chip, or the Vault screen (openReview). The choices:
 *
 *   Take theirs — load the stored version here; this tab's unsaved changes
 *     are discarded (with a "Download mine first" link).
 *   Keep mine — save this tab's copy on top of theirs. Offered only when the
 *     server keeps replaced versions (vault history), so theirs isn't lost.
 *   Download mine — an unencrypted export of this tab, to keep or re-enter.
 *
 * "Decide later" leaves the banner up; nothing is ever a dead end.
 */

const REVIEW_EVENT = 'scarab-review'

/** Open the conflict sheet from anywhere (the sync chip hosts it). */
export function openReview(): void {
  window.dispatchEvent(new Event(REVIEW_EVENT))
}
export function onReview(fn: () => void): () => void {
  window.addEventListener(REVIEW_EVENT, fn)
  return () => window.removeEventListener(REVIEW_EVENT, fn)
}

/** Save this tab's data as a plain JSON export (the same shape as Data & Vault's full export). Nothing is uploaded. */
export async function downloadTabCopy(version: number | null): Promise<void> {
  const dump = await localDump()
  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 1)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `scarab-this-tab-${version !== null ? `v${version}-` : ''}${todayLocal()}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

type Situation = 'conflict' | 'newer' | 'older' | 'gone'

function situationOf(s: SyncStatus): Situation {
  if (s.attention?.kind === 'gone') return 'gone'
  if (s.autosave === 'conflict') return 'conflict'
  return s.attention?.kind ?? 'conflict'
}

const TITLE: Record<Situation, string> = {
  conflict: 'Your changes aren’t in the vault',
  newer: 'A newer version is in the vault',
  older: 'The server is serving an older copy',
  gone: 'The stored vault changed under this tab',
}

export function ConflictSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useSyncStatus()
  const now = useNow()
  const [downloaded, setDownloaded] = useState(false)
  useEffect(() => {
    if (!open) setDownloaded(false)
  }, [open])

  const situation = situationOf(s)
  const remote = s.remote
  // The server's version, when it isn't this tab's (an attention's version is the latest word).
  const theirs = s.attention?.version ?? (remote && remote.version !== s.version ? remote.version : null)
  const noVault = situation === 'gone' && theirs === null
  const who = remote && remote.version === theirs ? whoLabel(remote.by, s.identity) : null
  const when = remote && remote.version === theirs && remote.at !== null ? ` ${relTime(remote.at, now)}` : ''
  const unsaved = s.dirty ? unsavedText(s.pending).toLowerCase() : null
  const canKeep = s.dirty && (situation === 'conflict' || situation === 'newer') && remote?.keepsHistory === true && theirs !== null

  const take = useAction(
    async () => {
      try {
        return await refreshFromVault({ discard: true, confirmRollback: confirmOpenOlder })
      } catch (e) {
        if (e instanceof SessionLocked) return null // re-keyed: the page is going to the front door
        if (e instanceof RollbackRefused) {
          toast.info(e.message) // declined at the older-copy dialog: nothing changed
          return null
        }
        throw e
      }
    },
    {
      errorPrefix: 'Couldn’t load the stored version',
      onDone: (r) => {
        if (!r) return
        toast.success(updatedText(r, s.identity))
        if (r.notice) toast.info(r.notice)
        onClose()
      },
    },
  )
  const keep = useAction(
    async () => {
      const ok = await confirm({
        title: `Replace v${theirs} with this tab’s copy?`,
        body: `${who ? `${who === 'you' ? 'Your' : `${who}’s`} changes` : 'The changes'} in v${theirs} won’t be in the next version. v${theirs} stays in the vault’s history, where it can be restored.`,
        confirmLabel: 'Keep mine',
        danger: true,
      })
      if (!ok) return null
      try {
        // Their version is judged like an unlock: an older copy than this device saw asks once more (and keeps this tab's passkeys).
        return await keepMine({ confirmRollback: confirmKeepOverOlder })
      } catch (e) {
        if (e instanceof RollbackRefused) return null // declined at the older-copy dialog: nothing changed
        throw e
      }
    },
    {
      errorPrefix: 'Couldn’t save this tab’s copy',
      onDone: (r) => {
        if (!r) return
        toast.success(`Saved · vault v${r.version}`)
        onClose()
      },
    },
  )
  const download = useAction(() => downloadTabCopy(s.version), {
    errorPrefix: 'Couldn’t export this tab',
    onDone: () => setDownloaded(true),
  })
  const end = async () => {
    const ok = await confirm({
      title: 'End this session?',
      body: s.dirty ? `${unsavedText(s.pending)} in this tab will be lost. Download them first if you need them.` : 'Nothing in this tab is unsaved.',
      confirmLabel: 'End session',
      danger: s.dirty,
    })
    if (ok) exitLocalMode()
  }
  const busy = take.busy || keep.busy || download.busy

  const lead =
    situation === 'gone'
      ? noVault
        ? 'The server no longer gives you the vault this tab opened — it was deleted or is being replaced, or you are no longer in its household.'
        : theirs === s.version
          ? `The server’s v${theirs} is not the copy this tab loaded — the vault was replaced, or restored from a backup.`
          : `The server now holds v${theirs}, behind this tab’s v${s.version} — the vault was replaced, or restored from a backup.`
      : situation === 'older'
        ? `The server holds v${theirs}, but it is an older copy of the vault than this device has seen. Loading it asks you to confirm first.`
        : theirs === null
          ? 'The vault moved on since this tab loaded it.'
          : `${who ? (who === 'you' ? 'You' : who) : 'Someone'} saved v${theirs}${when}${who === 'you' ? ' (in another tab or on another device)' : ''}, after this tab loaded v${s.version}.`

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={520}
      dismissible={!busy}
      title={TITLE[situation]}
      footer={
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          Decide later
        </Button>
      }
    >
      <div className="zk-sheet">
        <p className="zk-sheet-lead">
          {lead}{' '}
          {unsaved ? (
            <>
              This tab has <b>{unsaved}</b> not in the vault yet, and only one copy can become the next version.
            </>
          ) : situation !== 'gone' ? (
            'Nothing in this tab is unsaved, so loading it loses nothing.'
          ) : null}
        </p>
        <ul className="zk-sheet-opts">
          {noVault ? (
            <li className="zk-sheet-opt">
              <div className="zk-sheet-opt-text">
                <b>End this session</b>
                <span>Back to the front door, which opens whatever the server holds next.</span>
              </div>
              <Button disabled={busy} onClick={() => void end()}>
                End session…
              </Button>
            </li>
          ) : (
            <li className="zk-sheet-opt">
              <div className="zk-sheet-opt-text">
                <b>{s.dirty ? 'Take theirs' : theirs !== null ? `Load v${theirs}` : 'Load the stored version'}</b>
                <span>
                  Loads {theirs !== null ? `v${theirs}` : 'the stored version'} into this tab.
                  {s.dirty ? ' This tab’s unsaved changes are discarded.' : ''}
                  {situation === 'older' ? ' You’ll be asked to confirm the older copy.' : ''}
                </span>
                {s.dirty && (
                  <button type="button" className="zk-link" disabled={busy} onClick={() => void download.run()}>
                    {downloaded ? 'Downloaded ✓ — download again' : 'Download mine first'}
                  </button>
                )}
              </div>
              <Button variant="gold" busy={take.busy} disabled={busy && !take.busy} onClick={() => void take.run()}>
                {s.dirty ? 'Take theirs' : 'Load it'}
              </Button>
            </li>
          )}
          {canKeep && (
            <li className="zk-sheet-opt">
              <div className="zk-sheet-opt-text">
                <b>Keep mine</b>
                <span>
                  Saves this tab’s copy as v{(theirs ?? 0) + 1}, on top of v{theirs}. v{theirs} stays in the vault’s history.
                </span>
              </div>
              <Button busy={keep.busy} disabled={busy && !keep.busy} onClick={() => void keep.run()}>
                Keep mine…
              </Button>
            </li>
          )}
          {s.dirty && (
            <li className="zk-sheet-opt">
              <div className="zk-sheet-opt-text">
                <b>Download mine (JSON)</b>
                <span>An unencrypted export of this tab — every row — to keep, or re-enter by hand. Nothing is uploaded.</span>
              </div>
              <Button busy={download.busy} disabled={busy && !download.busy} onClick={() => void download.run()}>
                {downloaded ? 'Downloaded ✓' : 'Download'}
              </Button>
            </li>
          )}
        </ul>
      </div>
    </Dialog>
  )
}
