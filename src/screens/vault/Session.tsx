import { useState } from 'react'
import { CURRENT_VERSION } from '../../../engine/upgrades'
import { openReview } from '../../ConflictSheet'
import { exitLocalMode, localMode } from '../../local'
import {
  autosave,
  createVault,
  fetchMembers,
  fetchMode,
  follow,
  idleLockMinutes,
  lockVault,
  RollbackRefused,
  saveVault,
  setIdleLockMinutes,
  unlockVault,
  unlockWithRecoveryCode,
  type Unlocked,
  type VaultInfo,
} from '../../session'
import { Button } from '../../ui/Button'
import { confirm } from '../../ui/dialogs'
import { Field, TextInput } from '../../ui/Field'
import { Segmented } from '../../ui/Segmented'
import { toast } from '../../ui/Toast'
import { useAction } from '../../ui/useAction'
import { showRecoveryCode } from './codeSheet'
import { confirmOpenOlder } from './confirmOlder'
import { confirmReplaceVault } from './confirmReplace'
import './vault.css'

/**
 * The Session card: what this tab is running on, whether it is saved, and the
 * ways in and out — unlock, create, save, lock, end.
 */
export function SessionCard(p: {
  info: VaultInfo | null | undefined
  /** Whose vault the stored one is: this identity's own (null), another household's (their email), or unknown yet. */
  household: string | null | undefined
  reload: () => void
  openAdvanced: () => void
}) {
  const local = localMode.active
  const session = localMode.vault
  const [label, setLabel] = useState('')
  const [recovering, setRecovering] = useState(false)
  const [code, setCode] = useState('')

  /* ---------- unlock ---------- */

  /** Open the stored vault in this tab. Declining the older-copy dialog is a choice, not a failure. */
  const open = async (fn: () => Promise<Unlocked>) => {
    if (
      local &&
      localMode.dirty &&
      !(await confirm({
        title: 'Replace this tab’s unsaved data?',
        body: 'Unlocking loads the vault’s contents into this tab. What you have here that isn’t saved will be lost.',
        confirmLabel: 'Unlock and replace',
        danger: true,
      }))
    )
      return
    let r: Unlocked
    try {
      r = await fn()
    } catch (e) {
      if (!(e instanceof RollbackRefused)) throw e
      toast.info(e.message)
      return
    }
    // The screens remount on unlock, so everything worth saying goes in toasts.
    if (r.notice) toast.info(r.notice)
    toast.success(`Vault v${r.version} unlocked in this tab`)
    if (r.loaded.upgraded.length)
      toast.info(
        `This snapshot was written by an older Scarab (schema v${r.loaded.from}) and was brought up to v${CURRENT_VERSION} as it loaded — it saves that way on its own.`,
      )
  }
  const unlock = useAction(() => open(() => unlockVault({ confirmRollback: confirmOpenOlder })), { errorPrefix: 'Couldn’t unlock the vault' })
  const recover = useAction((typed: string) => open(() => unlockWithRecoveryCode(typed, { confirmRollback: confirmOpenOlder })), {
    errorPrefix: 'Couldn’t open the vault with that code',
  })

  /* ---------- create ---------- */

  /**
   * Create a vault for this session. Creating never overwrites a stored vault;
   * the household's owner may replace it after the typed confirmation, which
   * names what goes (the delete runs only once the new passkey exists).
   */
  const create = useAction(
    async () => {
      let replace: number | undefined
      const now = await fetchMode()
      if (now.vault) {
        if (now.household !== null) throw new Error(`A vault is already stored for ${now.household}’s household — unlock it instead.`)
        const m = await fetchMembers()
        const target = { version: now.vault.version, updatedAt: now.vault.updated_at, members: m.members.map((x) => x.email) }
        if (!(await confirmReplaceVault(target))) return
        replace = target.version
      }
      const r = await createVault(label.trim() || 'this device', { replace })
      setLabel('')
      showRecoveryCode({
        code: r.recoveryCode,
        title: 'Your recovery code',
        subtitle: `Vault v${r.version} is created. This code is the only way in without a passkey.`,
        required: true,
      })
    },
    { errorPrefix: 'Couldn’t create the vault', onDone: p.reload },
  )

  /* ---------- save / lock / end ---------- */

  const save = useAction(saveVault, {
    success: (r) => (r.skipped ? `Already saved · vault v${r.version}` : `Saved · vault v${r.version}`),
    errorPrefix: 'Couldn’t save',
    onDone: p.reload,
  })
  const lock = useAction(lockVault, { errorPrefix: 'Didn’t lock — the save before it failed' })
  const endSession = async () => {
    const dirty = localMode.dirty
    const ok = await confirm({
      title: 'End this session?',
      body: !session
        ? 'This session has no vault, so everything in this tab will be lost.'
        : dirty
          ? 'Unsaved changes in this tab will be lost. Lock saves them first.'
          : 'Everything is saved. Opening the vault again takes your passkey or the recovery code.',
      confirmLabel: 'End session',
      danger: dirty || !session,
    })
    if (ok) exitLocalMode()
  }

  const busy = unlock.busy || recover.busy || create.busy || save.busy || lock.busy
  const info = p.info
  const via = follow.unlockedWith

  return (
    <section className="card c5 zk-card" aria-labelledby="zk-session-h">
      <div className="h4row">
        <h2 id="zk-session-h">Session</h2>
        <div className="right muted">{local ? 'zero-knowledge · this tab' : 'household · server data'}</div>
      </div>

      {local ? (
        <>
          <p className="zk-lead">
            {session ? (
              <>
                Vault <b>v{session.version}</b> is open in this tab. The key stays in memory until the tab closes; every change is saved on its own.
              </>
            ) : (
              'This session started without a vault.'
            )}
          </p>
          <SaveState />
          {session && via && (
            <p className="sub2 zk-via">Unlocked with {via.kind === 'recovery' ? 'the recovery code' : `“${via.label || 'a passkey'}”`}.</p>
          )}
          {session && (
            <div className="formrow zk-actions">
              <Button variant={localMode.dirty ? 'gold' : 'default'} busy={save.busy} disabled={busy && !save.busy} onClick={() => void save.run()}>
                Save now
              </Button>
              <Button variant="ghost" busy={lock.busy} disabled={busy && !lock.busy} onClick={() => void lock.run()}>
                Lock
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void endSession()}>
                End session…
              </Button>
            </div>
          )}
          {session && <IdleSetting />}
          {!session && (
            <>
              {info && p.household !== null ? (
                <p className="sub2">
                  {p.household
                    ? `A vault is stored for ${p.household}’s household. Unlock it below to work in it; only they can replace it.`
                    : 'Checking who owns the stored vault…'}
                </p>
              ) : info === undefined ? null : (
                <form
                  className="zk-create"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void create.run()
                  }}
                >
                  <Field label="Name this device" hint="The passkey’s label — e.g. Max’s MacBook">
                    <TextInput value={label} maxLength={64} onChange={(e) => setLabel(e.target.value)} disabled={busy} />
                  </Field>
                  <Button type="submit" variant={info ? 'danger' : 'gold'} busy={create.busy} disabled={busy && !create.busy}>
                    {info ? `Replace stored v${info.version} with a new vault…` : 'Create vault with a passkey'}
                  </Button>
                </form>
              )}
              <div className="formrow zk-actions">
                <Button variant="ghost" disabled={busy} onClick={() => void endSession()}>
                  End session…
                </Button>
              </div>
            </>
          )}
        </>
      ) : (
        <>
          <p className="zk-lead">Every screen reads the server’s database. A zero-knowledge session runs everything in this tab instead.</p>
          <p className="sub2">
            {info ? 'Unlock the vault below, or ' : ''}
            <button type="button" className="zk-link zk-link-inline" onClick={p.openAdvanced}>
              {info ? 'start a session from Advanced' : 'Start a session from Advanced'}
            </button>
            {info ? '.' : ' to move into a vault.'}
          </p>
        </>
      )}

      {info && !session && (
        <div className="zk-unlock">
          {!recovering ? (
            <div className="formrow">
              <Button
                variant="gold"
                busy={unlock.busy}
                disabled={busy && !unlock.busy}
                onClick={() => void unlock.run()}
                title="decrypt in this tab and run on it — the server never sees plaintext"
              >
                Unlock with passkey
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setRecovering(true)}>
                Use recovery code…
              </Button>
            </div>
          ) : (
            <form
              className="zk-recover"
              onSubmit={(e) => {
                e.preventDefault()
                // On success the screens remount (the code goes with them); on failure it stays, to fix a typo.
                if (code.trim()) void recover.run(code)
              }}
            >
              <Field label="Recovery code" hint="13 groups of four, then two — spaces, dashes and case don’t matter">
                <TextInput
                  autoFocus
                  className="zk-code-input"
                  placeholder="XXXX-XXXX-…"
                  spellCheck={false}
                  autoComplete="off"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  disabled={busy}
                />
              </Field>
              <div className="formrow">
                <Button type="submit" busy={recover.busy} disabled={(busy && !recover.busy) || !code.trim()}>
                  Unlock
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setRecovering(false)}>
                  Back
                </Button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  )
}

const IDLE_OPTIONS = [
  { value: '15', label: '15 min' },
  { value: '60', label: '1 hour' },
  { value: '240', label: '4 hours' },
  { value: 'never', label: 'Never' },
] as const
type IdleValue = (typeof IDLE_OPTIONS)[number]['value']

/**
 * Idle auto-lock, per device: after this long without input the session saves
 * and locks. It never locks over changes it couldn't save (a banner says so).
 */
function IdleSetting() {
  const m = idleLockMinutes()
  const value: IdleValue = m === null ? 'never' : (String(m) as IdleValue)
  return (
    <div className="zk-idle">
      <div className="zk-idle-row">
        <span className="zk-idle-label">Lock when idle</span>
        <Segmented<IdleValue>
          size="sm"
          aria-label="Lock when idle"
          value={value}
          options={IDLE_OPTIONS.map((o) => ({ ...o }))}
          onChange={(v) => {
            setIdleLockMinutes(v === 'never' ? null : (Number(v) as 15 | 60 | 240))
            toast.success(v === 'never' ? 'This device won’t lock the session on its own' : `This device locks the session after ${IDLE_OPTIONS.find((o) => o.value === v)!.label} without activity`)
          }}
        />
      </div>
      <p className="sub2 muted zk-idle-note">On this device only. It saves first, and never locks over changes it couldn’t save.</p>
    </div>
  )
}

/** One line on whether this tab's work is in the vault, and what to do if it isn't. */
function SaveState() {
  const session = localMode.vault
  if (!session) return <p className="zk-state" data-tone="down">Nothing in this tab is saved until you create a vault.</p>
  if (autosave.status === 'conflict' || follow.attention?.kind === 'gone')
    return (
      <p className="zk-state" data-tone="down">
        {follow.attention?.kind === 'gone' ? 'The stored vault changed under this tab.' : 'Another device saved first, so this tab’s changes aren’t in the vault.'}{' '}
        <Button size="mini" onClick={openReview}>
          Review…
        </Button>
      </p>
    )
  if (follow.attention)
    return (
      <p className="zk-state">
        A newer version (v{follow.attention.version}) is in the vault.{' '}
        <Button size="mini" variant="gold" onClick={openReview}>
          Review…
        </Button>
      </p>
    )
  if (autosave.status === 'toolarge')
    return <p className="zk-state" data-tone="down">The vault is over the server’s size limit, so it can’t be saved ({autosave.error}).</p>
  if (autosave.status === 'error') return <p className="zk-state" data-tone="down">Autosave failed: {autosave.error}. Save now retries.</p>
  if (autosave.status === 'retrying') return <p className="zk-state">Can’t reach the server — retrying on its own. Your changes are safe in this tab.</p>
  if (autosave.status === 'saving') return <p className="zk-state">Saving…</p>
  if (localMode.dirty) return <p className="zk-state">Unsaved changes — saving shortly.</p>
  return <p className="zk-state" data-tone="ok">Everything is saved.</p>
}
