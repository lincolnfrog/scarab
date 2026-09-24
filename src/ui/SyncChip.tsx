import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ConflictSheet, onReview, openReview } from '../ConflictSheet'
import { exitLocalMode, localMode } from '../local'
import { navigate } from '../router'
import { confirmOpenOlder } from '../screens/vault/confirmOlder'
import { SnapshotPreviewHost } from '../screens/vault/Preview'
import { lockVault, onFollow, refreshFromVault, RollbackRefused, saveVault, SessionLocked, TabIsDirty, type Household } from '../session'
import { Button } from './Button'
import { confirm } from './dialogs'
import { Popover } from './Popover'
import { initialsFor, relTime, sizeText, unsavedText, updatedText, useNow, useSyncStatus, whoLabel, type SyncStatus } from './syncStatus'
import { toast } from './Toast'
import { Tooltip } from './Tooltip'
import { useAction } from './useAction'
import '../screens/vault/vault.css'
import './ui.css'

const LABEL: Record<Exclude<SyncStatus['state'], 'off'>, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  retrying: 'Offline — retrying',
  unsaved: 'Unsaved',
  novault: 'No vault',
  newer: 'Newer version available',
  conflict: 'Conflict — review',
  failed: 'Save failed',
}

function headline(s: SyncStatus): string {
  switch (s.state) {
    case 'saved':
      return 'Everything is saved'
    case 'saving':
      return 'Saving to the vault…'
    case 'retrying':
      return 'Can’t reach the server — retrying on its own'
    case 'unsaved':
      return `${unsavedText(s.pending)} — saving shortly`
    case 'novault':
      return 'No vault — nothing in this tab is saved'
    case 'newer':
      return s.attention?.version != null ? `v${s.attention.version} is newer than this tab’s v${s.version}` : 'A newer version is in the vault'
    case 'conflict':
      return s.attention?.kind === 'gone' ? 'The stored vault changed under this tab' : 'Your changes weren’t saved — review them'
    case 'failed':
      return 'Autosave failed'
    default:
      return ''
  }
}

const clock = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const needsReview = (s: SyncStatus) => s.state === 'newer' || s.state === 'conflict'

/**
 * The topbar's session status (zero-knowledge sessions only). A real button:
 * the dot and word say where the tab's work stands — saved, saving, offline
 * and retrying, a newer version from the other member (gold: it wants a
 * decision), a conflict. Clicking opens a panel: vault version and size, who
 * saved it and when, how this session was unlocked, who is signed in, Save
 * now, Review, Data & Vault, Lock (saves first) and End session (asks first).
 *
 * It also hosts, for the whole session: the household's avatars, the banner
 * under the topbar, the conflict sheet, the preview of an earlier version or
 * a backup (with its restore), and the toast when the tab follows the other
 * member's save on its own.
 */
export function SyncChip() {
  const s = useSyncStatus()
  const now = useNow()
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const save = useAction(saveVault, {
    success: (r) => (r.skipped ? `Already saved · vault v${r.version}` : `Saved · vault v${r.version}`),
    errorPrefix: "Couldn't save the vault",
  })
  const lock = useAction(lockVault, { errorPrefix: 'Didn’t lock: the unsaved changes couldn’t be saved' })
  const off = s.state === 'off'

  // The tab followed the other member's save on its own: say so.
  const identity = s.identity
  useEffect(
    () =>
      onFollow((e) => {
        if (e.kind === 'joined') {
          toast.info(`${e.emails.join(' and ')} accepted the invitation — ${e.emails.length === 1 ? 'they’re' : 'they’re all'} in the household now`)
          return
        }
        toast.info(updatedText(e, identity))
        if (e.notice) toast.info(e.notice)
      }),
    [identity],
  )
  useEffect(() => onReview(() => setSheet(true)), [])

  // The banner's home: right under the topbar, in the main column (App's layout; nothing else is added there).
  const [host, setHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (off) return
    const top = anchor.current?.closest('.topbar')
    const main = top?.parentElement
    if (!top || !main) return
    const el = document.createElement('div')
    el.className = 'zk-banner-host'
    main.insertBefore(el, top.nextSibling)
    setHost(el)
    return () => {
      el.remove()
      setHost(null)
    }
  }, [off])

  if (s.state === 'off') return null

  const label = s.state === 'saved' && s.savedAt !== null ? `Saved · ${relTime(s.savedAt, now)}` : LABEL[s.state]
  const review = () => {
    setOpen(false)
    anchor.current?.focus() // the sheet returns focus here, not to a popover that no longer exists
    openReview()
  }

  const endSession = async () => {
    setOpen(false)
    anchor.current?.focus() // the confirm dialog returns focus here, not to a popover that no longer exists
    const dirty = localMode.dirty
    const body = !localMode.vault
      ? 'This session has no vault, so everything in this tab will be lost.'
      : dirty
        ? `${unsavedText(s.pending)} will be lost. Lock instead to save them first.`
        : 'Everything is saved. Opening the vault again takes your passkey or the recovery code.'
    if (await confirm({ title: 'End this session?', body, confirmLabel: 'End session', danger: dirty || !localMode.vault }))
      exitLocalMode()
  }

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="ui-sync zk-sync"
        data-state={s.state}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Session status"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ui-sync-dot" aria-hidden="true" />
        {label}
      </button>
      {s.household && <Avatars household={s.household} identity={s.identity} />}
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" aria-label="Session status" className="ui-syncpop">
        <div className="ui-syncpop-head zk-syncpop-head" data-state={s.state}>
          <span className="ui-sync-dot" aria-hidden="true" />
          {headline(s)}
        </div>
        <dl className="ui-syncpop-kv">
          <dt>Vault</dt>
          <dd>
            {s.version !== null ? `v${s.version}` : 'none yet'}
            {s.storedBytes !== null && <span className="muted"> · {sizeText(s.storedBytes)}</span>}
          </dd>
          <dt>Last saved</dt>
          <dd>
            {s.savedAt !== null ? (
              <>
                {s.savedBy && <>by {whoLabel(s.savedBy, s.identity)} · </>}
                {relTime(s.savedAt, now)} <span className="muted">· {clock(s.savedAt)}</span>
              </>
            ) : s.version !== null ? (
              'before this session'
            ) : (
              'never'
            )}
          </dd>
          {s.unlockedWith && (
            <>
              <dt>Unlocked with</dt>
              <dd>{s.unlockedWith.kind === 'recovery' ? 'the recovery code' : `“${s.unlockedWith.label || 'a passkey'}”`}</dd>
            </>
          )}
          <dt>Signed in</dt>
          <dd>{s.identity ?? 'unknown'}</dd>
        </dl>
        {(s.state === 'failed' || s.state === 'retrying' || s.state === 'conflict') && s.error && <div className="ui-syncpop-err">{s.error}</div>}
        <div className="ui-syncpop-actions">
          {needsReview(s) && (
            <Button size="mini" variant="gold" onClick={review}>
              Review…
            </Button>
          )}
          {s.version !== null &&
            (() => {
              const canSave = s.dirty || s.state === 'failed' || s.state === 'retrying'
              return (
                // Gold only when there is something to save (and nothing to review first): a disabled gold button reads as a call to action.
                <Button size="mini" variant={canSave && !needsReview(s) ? 'gold' : 'default'} busy={save.busy} disabled={!canSave} onClick={() => void save.run()}>
                  Save now
                </Button>
              )
            })()}
          <Button
            size="mini"
            onClick={() => {
              setOpen(false)
              navigate({ screen: 'vault' })
            }}
          >
            Data &amp; Vault →
          </Button>
        </div>
        <div className="ui-syncpop-foot zk-syncpop-foot">
          {s.version !== null && (
            <Tooltip content={s.dirty ? 'Saves the unsaved changes first; locks only if that works' : 'Opening it again takes your passkey or the recovery code'}>
              <Button size="mini" busy={lock.busy} onClick={() => void lock.run()}>
                Lock
              </Button>
            </Tooltip>
          )}
          <Button size="mini" variant="ghost" onClick={() => void endSession()}>
            End session…
          </Button>
        </div>
      </Popover>
      {host && createPortal(<Banner s={s} />, host)}
      <ConflictSheet open={sheet} onClose={() => setSheet(false)} />
      <SnapshotPreviewHost />
    </>
  )
}

/**
 * The household (from the vault's member list plus its owner — never from
 * passkey labels), in the mockup's avatar style; the signed-in identity wears
 * the gold ring. Shown once a vault is shared.
 */
function Avatars({ household, identity }: { household: Household; identity: string | null }) {
  const people = [household.owner, ...household.members.filter((m) => m !== household.owner)]
  if (people.length < 2) return null
  const initials = initialsFor(people)
  const me = identity?.toLowerCase()
  return (
    <span className="zk-avatars" role="list" aria-label="Household">
      {people.map((email, i) => (
        <Tooltip key={email} content={`${email}${email.toLowerCase() === me ? ' (you)' : ''} · ${i === 0 ? 'owner' : 'member'}`}>
          <span role="listitem" className="zk-av" data-tone={i % 2 === 0 ? 'm' : 'n'} data-me={email.toLowerCase() === me ? '' : undefined}>
            {initials[i]}
          </span>
        </Tooltip>
      ))}
    </span>
  )
}

/**
 * One line under the topbar when something needs the person: a refused save,
 * the other member's newer version, a stored vault that changed under the
 * tab — or, quietly, that Scarab is also open in another tab.
 */
function Banner({ s }: { s: SyncStatus }) {
  const [otherTabSeen, setOtherTabSeen] = useState(false)
  useEffect(() => {
    if (!s.otherTab) setOtherTabSeen(false) // the other tab left; a new one is news again
  }, [s.otherTab])
  const load = useAction(
    async () => {
      try {
        return await refreshFromVault({ confirmRollback: confirmOpenOlder })
      } catch (e) {
        if (e instanceof SessionLocked) return null
        if (e instanceof RollbackRefused) {
          toast.info(e.message) // declined at the older-copy dialog: nothing changed
          return null
        }
        if (e instanceof TabIsDirty) {
          openReview() // edited meanwhile: the person chooses
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
      },
    },
  )

  const save = useAction(saveVault, {
    success: (r) => (r.skipped ? `Already saved · vault v${r.version}` : `Saved · vault v${r.version}`),
    errorPrefix: "Couldn't save the vault",
  })

  const who = s.remote && s.remote.version === s.attention?.version ? whoLabel(s.remote.by, s.identity) : null
  const Who = who === 'you' ? 'You' : (who ?? 'Someone')
  let tone: 'down' | 'gold' | 'ink'
  let text: string
  let action: { label: string; run: () => void; busy?: boolean }
  if (s.idleBlocked) {
    // The idle lock came due and didn't happen: say so first — the rest of the story (a conflict, offline) follows from the action.
    tone = 'down'
    text = s.idleBlocked
    action = s.state === 'conflict' || s.state === 'newer' ? { label: 'Review…', run: openReview } : { label: 'Save now', run: () => void save.run(), busy: save.busy }
  } else if (s.state === 'conflict') {
    tone = 'down'
    text =
      s.attention?.kind === 'gone'
        ? 'The stored vault changed under this tab — it was deleted, replaced or restored, or you are no longer in its household.'
        : `This tab’s changes couldn’t be saved: ${s.remote && s.version !== null && s.remote.version > s.version ? `${whoLabel(s.remote.by, s.identity)} saved v${s.remote.version} first` : 'the vault moved on first'}.`
    action = { label: 'Review…', run: openReview }
  } else if (s.state === 'newer') {
    tone = 'gold'
    const v = s.attention?.version
    text =
      s.attention?.kind === 'older'
        ? `The server is serving v${v}, an older copy of the vault than this device has seen.`
        : `${Who} saved v${v}${who === 'you' ? ' in another tab or on another device' : ''}${s.dirty ? ' while this tab had unsaved changes' : ''}.`
    action = s.dirty || s.attention?.kind === 'older' ? { label: 'Review…', run: openReview } : { label: `Load v${v}`, run: () => void load.run(), busy: load.busy }
  } else if (s.otherTab && !otherTabSeen) {
    tone = 'ink'
    text = 'Scarab is also open in another tab. Each tab holds its own copy and saves on its own — edit in one of them.'
    action = { label: 'Got it', run: () => setOtherTabSeen(true) }
  } else return null

  return (
    <div className="zk-banner" data-tone={tone} role="status">
      <span className="zk-banner-dot" aria-hidden="true" />
      <span className="zk-banner-text">{text}</span>
      <Button size="mini" variant={tone === 'gold' ? 'gold' : 'default'} busy={action.busy} onClick={action.run}>
        {action.label}
      </Button>
    </div>
  )
}
