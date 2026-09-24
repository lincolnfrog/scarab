import { useEffect, useRef, useState, type ReactNode } from 'react'
import { passkeySupport, passkeysWorkHere } from './passkey'
import { NetError } from './saveQueue'
import RecoveryCode from './RecoveryCode'
import { BackupAsVault } from './screens/vault/BackupAsVault'
import { confirmOpenOlder } from './screens/vault/confirmOlder'
import { confirmReplaceVault, type ReplaceTarget } from './screens/vault/confirmReplace'
import {
  acceptInvite,
  backupBehind,
  createVault,
  declineInvite,
  enterWithBackup,
  fetchMembers,
  fetchMode,
  fetchVaultKeys,
  leaveHousehold,
  MAX_BACKUP_BYTES,
  newVaultFromBackup,
  openBackup,
  parseBackup,
  pendingBackup,
  restoreBackupAsVault,
  RollbackRefused,
  setPendingBackup,
  startEmpty,
  takeLockNote,
  unlockVault,
  unlockWithRecoveryCode,
  type BackupKey,
  type Invite,
  type Mode,
  type OpenedSnapshot,
  type ParsedBackup,
  type Unlocked,
} from './session'
import { Button } from './ui/Button'
import { confirm } from './ui/dialogs'
import { Field, TextInput } from './ui/Field'
import { withViewTransition } from './ui/motion'
import { parseServerTime, relTime, useSyncStatus, whoLabel } from './ui/syncStatus'
import { toast } from './ui/Toast'
import { useAction } from './ui/useAction'
import './screens/vault/vault.css'

/**
 * scarab.one's front door. Shown only when the server holds no plaintext:
 * either a vault exists (one passkey tap unlocks it into this tab) or nothing
 * exists yet, in which case setting up IS creating the vault — name the
 * device, answer the passkey prompt, file the recovery code, and you're in.
 * Household installs with server-side data never see it.
 *
 * Creating a vault never overwrites one (the server refuses version 0 when a
 * vault exists). The household's owner can Start over, which deletes the
 * stored vault — after a typed confirmation that names it, and only once the
 * new passkey exists. A member never sees Start over: the vault isn't theirs.
 *
 * A backup file (.scarab) opens here too, with a passkey that was on the
 * vault or its recovery code. If that key also opens the stored vault, the
 * vault is unlocked with it and the backup is offered for restore inside the
 * session; if not, the vault is unlocked as usual and the backup waits; with
 * no vault stored, the backup can become the vault — same key, same passkeys —
 * unless this device saw the vault move on since the backup: then it leads
 * with a new vault from the backup's data, and says why.
 *
 * An invitation into someone's household waiting for this identity comes
 * first: nobody joins a household without saying yes here. Accepting ends
 * what this identity had (its own vault, after a typed confirmation, or its
 * membership elsewhere); with nothing to end, it still asks once, naming
 * whose household it is — they will read what you add. Nothing is focused
 * for you, and Decline is a full button beside Join; declining just drops
 * the invitation. Each household's invitation is answered on its own. A
 * member can leave from here too.
 */
type Step = 'invite' | 'door' | 'recover' | 'name' | 'code' | 'backup' | 'backup-new'

/** Where the door opens: an invitation waiting, else the stored vault, else setting one up. */
const firstStep = (m: Mode): Step => ((m.invites?.length ?? 0) > 0 ? 'invite' : m.vault ? 'door' : 'name')

/** "Waiting for your passkey…", with a gold ring that loops until the prompt is answered (still under reduced motion). */
function PasskeyWait({ children }: { children?: ReactNode }) {
  return (
    <div className="zk-door-wait" role="status">
      <svg className="zk-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle className="zk-ring-track" cx="18" cy="18" r="15" />
        <circle className="zk-ring-arc" cx="18" cy="18" r="15" pathLength="100" />
      </svg>
      <span>{children ?? 'Waiting for your passkey — answer the prompt on this device, or with your phone.'}</span>
    </div>
  )
}

/** "saved 2m ago by nicole@…" — who stored it, when the server kept that (amendment 2). */
const saved = (v: NonNullable<Mode['vault']>, identity: string | null) => {
  const t = parseServerTime(v.updated_at)
  const when = t === null ? `saved ${v.updated_at} UTC` : `saved ${relTime(t, Date.now())}`
  return v.updated_by ? `${when} by ${whoLabel(v.updated_by, identity)}` : when
}

export default function FrontDoor({ mode: booted, onEnter, onHousehold }: { mode: Mode; onEnter: () => void; onHousehold: () => void }) {
  const [support, setSupport] = useState<boolean | null>(null)
  /** What the server said at boot, refreshed here after an invitation is answered or the household is left. */
  const [mode, setMode] = useState<Mode>(booted)
  const [step, setStepNow] = useState<Step>(() => firstStep(booted))
  /** Go to a step — with whatever else changes for it, in the same update — as a crossfade (a view transition; instant under reduced motion). */
  const setStep = (next: Step, also?: () => void) =>
    withViewTransition(() => {
      also?.()
      setStepNow(next)
    })
  const [code, setCode] = useState('')
  const [label, setLabel] = useState('')
  const [recovery, setRecovery] = useState<{ code: string; version: number } | null>(null)
  /** The stored vault the owner confirmed deleting (Start over); null for a plain first vault. */
  const [replacing, setReplacing] = useState<ReplaceTarget | null>(null)
  /** Why the last session in this tab ended on its own (the vault was re-keyed), shown once. */
  const [lockNote] = useState(takeLockNote)
  /** Another tab of this browser already has a session open (BroadcastChannel, nothing leaves the browser). */
  const { otherTab, identity } = useSyncStatus()
  /** A backup file picked here: parsed, then opened (decrypted in this tab), then used. */
  const [backup, setBackup] = useState<ParsedBackup | null>(null)
  const [snap, setSnap] = useState<OpenedSnapshot | null>(null)
  const [backupCode, setBackupCode] = useState('')
  /** The backup is open and waits for the vault to be unlocked (a different key). */
  const [waiting4Vault, setWaiting4Vault] = useState(() => pendingBackup() !== null)
  const backupRef = useRef<HTMLInputElement>(null)
  const [backupHow, setBackupHow] = useState<BackupKey['kind'] | null>(null)
  /**
   * A member's own passkeys on the stored vault (by the identity each names — read from the unauthenticated header, only to
   * say that there are none yet). undefined: not checked; null: can't tell.
   */
  const [mine, setMine] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    passkeySupport().then((s) => setSupport(s === false ? false : true))
  }, [])

  /**
   * Open the vault. An older copy than this device last saw stops at a
   * dialog (Open anyway / Cancel); cancelling is the person's choice, not a
   * failure, so it gets a plain note rather than an error.
   */
  const open = async (fn: () => Promise<Unlocked>) => {
    try {
      const r = await fn()
      if (r.notice) toast.info(r.notice)
      onEnter()
    } catch (e) {
      if (!(e instanceof RollbackRefused)) throw e
      toast.info(e.message)
    }
  }
  const unlock = useAction(() => open(() => unlockVault({ confirmRollback: confirmOpenOlder })), {
    errorPrefix: 'Couldn’t unlock the vault',
  })
  const recover = useAction((typed: string) => open(() => unlockWithRecoveryCode(typed, { confirmRollback: confirmOpenOlder })), {
    errorPrefix: 'Couldn’t open the vault with that code',
  })
  /**
   * Mint the vault under this device's passkey, from an empty engine (deleting the confirmed one, if replacing). The engine
   * boots only once the checks and the passkey pass, so a refused or cancelled create leaves no session in this tab.
   */
  const create = useAction(
    async (name: string, replace: number | undefined) => {
      let r: Awaited<ReturnType<typeof createVault>>
      try {
        r = await createVault(name, { replace, empty: true })
      } catch (e) {
        // A vault was stored meanwhile (another tab or device): the error says "unlock it instead", so show its door.
        const now = replace === undefined ? await fetchMode().catch(() => null) : null
        if (now?.vault) setStep(firstStep(now), () => setMode(now))
        throw e
      }
      setStep('code', () => setRecovery({ code: r.recoveryCode, version: r.version }))
    },
    { errorPrefix: 'Couldn’t create the vault' },
  )
  const explore = useAction(
    async () => {
      await startEmpty()
      onEnter()
    },
    { errorPrefix: 'Couldn’t start a session' },
  )
  /** Owner only: name what would be deleted — as stored now, not as it was at page load — and ask for REPLACE. */
  const startOver = useAction(
    async () => {
      const [now, household] = await Promise.all([fetchMode(), fetchMembers()])
      if (now.household !== null) throw new Error(`This vault belongs to ${now.household}’s household — only they can replace it.`)
      if (!now.vault) {
        setStep('name', () => setReplacing(null)) // deleted meanwhile: nothing to replace
        return
      }
      const target: ReplaceTarget = { version: now.vault.version, updatedAt: now.vault.updated_at, members: household.members.map((m) => m.email) }
      if (!(await confirmReplaceVault(target))) return
      setStep('name', () => setReplacing(target))
    },
    { errorPrefix: 'Couldn’t check the stored vault' },
  )

  const pickBackup = useAction(
    async (file: File) => {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('That file is too large to be a Scarab backup.')
      const parsed = parseBackup(await file.text(), file.name)
      setStep('backup', () => {
        setBackup(parsed)
        setBackupCode('')
      })
    },
    { errorPrefix: 'Couldn’t open that file' },
  )
  /** Decrypt the backup, then: unlock the stored vault with the same key, wait for it, or offer it as the vault. */
  const openFile = useAction(
    async (how: BackupKey) => {
      if (!backup) return
      setBackupHow(how.kind)
      const opened = await openBackup(backup, how)
      let r: Awaited<ReturnType<typeof enterWithBackup>>
      try {
        r = await enterWithBackup(opened, { confirmRollback: confirmOpenOlder })
      } catch (e) {
        if (!(e instanceof RollbackRefused)) throw e
        toast.info(e.message)
        return
      }
      if (r.kind === 'unlocked') {
        if (r.unlocked.notice) toast.info(r.unlocked.notice)
        onEnter()
      } else if (r.kind === 'locked') {
        setStep('door', () => {
          setWaiting4Vault(true)
          setBackup(null)
        })
      } else {
        setStep('backup-new', () => setSnap(opened))
      }
    },
    { errorPrefix: 'Couldn’t open the backup' },
  )
  const restoreAsVault = useAction(
    async () => {
      if (!snap) return
      // This device saw the vault later than the backup: put it back as it was only after saying what comes back with it.
      const behind = backupBehind(snap)
      if (behind) {
        const ok = await confirm({
          title: 'Restore the backup as it was?',
          body: (
            <div className="zk-confirm">
              <p>
                The vault comes back with the key and passkey list it had at v{behind.sealedAs}: a passkey removed since opens it again
                {behind.rekeyed === null ? ', and so does an older recovery code, if the key was changed since' : ''}.
              </p>
              <p>
                This device’s memory of the vault starts over from the restored copy. Other devices that saw v{behind.seen.seq} are told it is an
                older copy.
              </p>
            </div>
          ),
          confirmLabel: 'Restore as it was',
          danger: true,
        })
        if (!ok) return
      }
      const r = await restoreBackupAsVault(snap, { overSeen: behind !== null })
      toast.success(`Vault restored from the backup as v${r.version} — its passkeys and recovery code open it as before`)
      onEnter()
    },
    { errorPrefix: 'Couldn’t restore the vault' },
  )
  /** A new vault — fresh key, this device's passkey, a new recovery code — holding the backup's data. */
  const startFromBackup = useAction(
    async (name: string) => {
      if (!snap) return
      const r = await newVaultFromBackup(snap, name)
      setStep('code', () => setRecovery({ code: r.recoveryCode, version: r.version }))
    },
    { errorPrefix: 'Couldn’t start a new vault' },
  )
  const forgetBackup = () => {
    setPendingBackup(null)
    setWaiting4Vault(false)
  }

  /* ---------- invitations, and leaving ---------- */

  /** Ask the server again (after an invitation is answered, or the household left), and open where that leads. */
  const reopen = async (after?: Step) => {
    const next = await fetchMode()
    setStep(after ?? (next.vault ? 'door' : 'name'), () => {
      setMode(next)
      setMine(undefined)
    })
    return next
  }

  /**
   * Say yes. Whatever this identity has ends first, after it is named: its
   * own vault (typed DELETE — for everyone it is shared with) or its
   * membership of another household.
   */
  const join = useAction(
    async (inv: Invite) => {
      const own = mode.vault && mode.household === null ? mode.vault : null
      const elsewhere = own ? null : mode.household
      if (own) {
        const others = (await fetchMembers().catch(() => null))?.members.map((x) => x.email) ?? []
        const ok = await confirm({
          title: `Join ${inv.household}’s household?`,
          body: (
            <div className="zk-confirm">
              <p>
                Joining <b>deletes your own vault</b> (v{own.version}, {saved(own, identity)}) for good
                {others.length > 0 ? <>, and {others.join(', ')} lose{others.length === 1 ? 's' : ''} it too</> : null}. Scarab can’t bring it
                back.
              </p>
              <p>To keep what’s in it, don’t join yet: unlock it, download an encrypted backup (Data &amp; Vault → Backups), then come back here.</p>
            </div>
          ),
          confirmLabel: 'Delete my vault and join',
          danger: true,
          typeToConfirm: 'DELETE',
        })
        if (!ok) return null
      } else if (elsewhere) {
        const ok = await confirm({
          title: `Leave ${elsewhere}’s household for ${inv.household}’s?`,
          body: `You stop getting ${elsewhere}’s vault right away (your passkeys stay on it until they re-key), and open ${inv.household}’s instead.`,
          confirmLabel: 'Switch households',
          danger: true,
        })
        if (!ok) return null
      } else {
        // Nothing of this identity's ends, but joining still means sharing: say with whom, once, before it happens.
        const ok = await confirm({
          title: `Join ${inv.household}’s household?`,
          body:
            inv.invited_by.toLowerCase() === inv.household.toLowerCase()
              ? 'They will be able to read what you add.'
              : `${inv.invited_by} sent the invitation. Everyone in the household will be able to read what you add.`,
          confirmLabel: 'Join',
        })
        if (!ok) return null
      }
      try {
        await acceptInvite(inv.household, { replaceOwn: !!(own || elsewhere), version: own?.version })
      } catch (e) {
        // What this identity has changed since the door opened (a vault created in another tab, say): show it as it is now.
        if (e instanceof NetError && e.status === 409 && typeof e.body?.code === 'string' && e.body.code !== 'no-vault') {
          await reopen('invite')
          throw new Error('What you have here changed since this page loaded — it is shown as it is now. Review it, then choose again.')
        }
        if (e instanceof NetError && (e.status === 404 || e.body?.code === 'no-vault')) await reopen()
        throw e
      }
      await reopen()
      return inv.household
    },
    { success: (h) => (h ? `You’re in ${h}’s household` : ''), errorPrefix: 'Couldn’t join the household' },
  )
  const decline = useAction(
    async (inv: Invite) => {
      await declineInvite(inv.household)
      await reopen()
      return inv.household
    },
    { success: (h) => `Declined ${h}’s invitation`, errorPrefix: 'Couldn’t decline the invitation' },
  )
  const leave = useAction(
    async () => {
      const owner = mode.household
      if (!owner) return null
      const ok = await confirm({
        title: `Leave ${owner}’s household?`,
        body: (
          <div className="zk-confirm">
            <p>The server stops giving you {owner}’s vault right away. Your passkeys stay on it until they re-key it — their Household card asks them to.</p>
            <p>Then you can set up a vault of your own, or accept another invitation.</p>
          </div>
        ),
        confirmLabel: 'Leave household',
        danger: true,
      })
      if (!ok) return null
      await leaveHousehold()
      await reopen()
      return owner
    },
    { success: (o) => (o ? `You left ${o}’s household` : ''), errorPrefix: 'Couldn’t leave the household' },
  )

  useEffect(() => {
    if (mode.household === null || !mode.vault || mine !== undefined) return
    let live = true
    const me = identity?.toLowerCase()
    fetchVaultKeys()
      .then((k) => {
        if (!live) return
        const named = (k?.keys ?? []).filter((w) => w.identity !== undefined)
        setMine(!me || named.length === 0 ? null : named.filter((w) => w.identity === me).length)
      })
      .catch(() => live && setMine(null))
    return () => {
      live = false
    }
  }, [mode, mine, identity])

  const busy =
    unlock.busy ||
    recover.busy ||
    create.busy ||
    explore.busy ||
    startOver.busy ||
    pickBackup.busy ||
    openFile.busy ||
    restoreAsVault.busy ||
    startFromBackup.busy ||
    join.busy ||
    decline.busy ||
    leave.busy
  const waiting = unlock.busy || create.busy || startFromBackup.busy || (openFile.busy && backupHow === 'passkey')
  const noPrf = support === false
  const back = () =>
    setStep(mode.vault ? 'door' : 'name', () => {
      setReplacing(null)
      setBackup(null)
      setSnap(null)
    })
  const invites = mode.invites ?? []
  /** What to show: the step, unless what it needs is gone (an invitation answered, a vault deleted). */
  const view: Step =
    step === 'invite' && invites.length === 0 ? (mode.vault ? 'door' : 'name') : (step === 'door' || step === 'recover') && !mode.vault ? 'name' : step
  const whoInvited = (inv: Invite) => (inv.invited_by.toLowerCase() === inv.household.toLowerCase() ? inv.household : `${inv.invited_by}, for ${inv.household}’s household,`)
  const invitedWhen = (inv: Invite) => {
    const t = parseServerTime(inv.invited_at)
    return t === null ? '' : ` ${relTime(t, Date.now())}`
  }
  const backupInput = (
    <input
      ref={backupRef}
      type="file"
      accept=".scarab,application/json"
      hidden
      onChange={(e) => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (f) void pickBackup.run(f)
      }}
    />
  )

  return (
    <div className="frontdoor">
      <div className="card zk-door" style={{ maxWidth: 520, width: '100%' }}>
        <div className="logo" style={{ marginBottom: 18 }}>
          <svg width="26" height="26" viewBox="0 0 44 44" fill="none" aria-hidden="true">
            <circle cx="22" cy="9" r="5" stroke="var(--gold)" strokeWidth="2.6" />
            <ellipse cx="22" cy="27" rx="10" ry="11" stroke="var(--gold)" strokeWidth="2.6" />
            <path d="M22 16v22" stroke="var(--gold)" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>SCARAB</span>
        </div>

        {lockNote && view !== 'code' && (
          <p className="sub2 zk-door-lock" role="status">
            {lockNote}
          </p>
        )}
        {waiting4Vault && pendingBackup() && (view === 'door' || view === 'recover') && (
          <p className="sub2 zk-door-lock" role="status">
            The backup is open, but it is sealed under a different key than the stored vault (from before a key rotation, or another vault). Unlock
            the vault below and the backup is offered for restore once you’re in.{' '}
            <button type="button" className="zk-link zk-link-inline" onClick={forgetBackup}>
              Forget the backup
            </button>
          </p>
        )}
        {otherTab && view !== 'code' && (
          <p className="sub2 muted zk-door-lock" role="status">
            Scarab is already open in another tab of this browser. Opening it here too gives this tab its own copy,
            which saves on its own — it’s simpler to go back to that tab.
          </p>
        )}

        {invites.length > 0 && view !== 'invite' && view !== 'code' && (
          <p className="sub2 zk-door-lock zk-door-invited" role="status">
            {invites.length === 1 ? `${invites[0]!.household} invited you into their household.` : `${invites.length} households invited you into theirs.`}{' '}
            <button type="button" className="zk-link zk-link-inline" disabled={busy} onClick={() => setStep('invite')}>
              {invites.length === 1 ? 'See the invitation' : 'See the invitations'}
            </button>
          </p>
        )}

        {view === 'invite' ? (
          <>
            <h2>You’re invited</h2>
            {invites.map((inv) => (
              <div key={inv.household} className="zk-invite">
                <p className="sub2">
                  <b className="inkstrong">{whoInvited(inv)}</b> invited you{invitedWhen(inv)} to share their vault. Joining means you open the same
                  vault they do, with a passkey of your own — nobody joins a household without saying yes here.
                </p>
                {mode.vault && mode.household === null ? (
                  <p className="sub2 zk-invite-warn">
                    You have a vault of your own (v{mode.vault.version}, {saved(mode.vault, identity)}). Joining deletes it, for good — download an
                    encrypted backup from it first if you want to keep what’s in it.
                  </p>
                ) : mode.household ? (
                  <p className="sub2 zk-invite-warn">You’re in {mode.household}’s household now. Joining this one takes you out of it.</p>
                ) : null}
                {/* No autoFocus: joining is a choice to make, never the default Enter. */}
                <div className="formrow" style={{ marginTop: 12 }}>
                  <Button
                    variant={mode.vault && mode.household === null ? 'danger' : 'gold'}
                    busy={join.busy}
                    disabled={busy && !join.busy}
                    onClick={() => void join.run(inv)}
                  >
                    Join {inv.household}’s household
                  </Button>
                  <Button busy={decline.busy} disabled={busy && !decline.busy} onClick={() => void decline.run(inv)}>
                    Decline
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={() => setStep(mode.vault ? 'door' : 'name')}>
                    Not now
                  </Button>
                </div>
              </div>
            ))}
            <p className="sub2 muted zk-door-note">
              Don’t know them? Decline — it tells them only that the invitation is gone. Once you’re in, your own passkey opens the vault (they add
              it from their screen while your phone is nearby, if they haven’t already), or its recovery code does, if they give it to you.
            </p>
          </>
        ) : view === 'code' && recovery ? (
          <>
            <h2>Your vault is ready</h2>
            <p className="sub2">
              Vault v{recovery.version} is stored, encrypted under your passkey. One more thing before you go in.
            </p>
            <div style={{ marginTop: 12 }}>
              <RecoveryCode code={recovery.code} title="Recovery code" onDone={onEnter} />
            </div>
          </>
        ) : view === 'backup' && backup ? (
          <>
            <h2>Open a backup</h2>
            <p className="sub2">
              <span className="num">{backup.name}</span> — sealed for v{backup.blob.seq}. It opens with a passkey that was on the vault when it was
              made, or with the recovery code from then. It is decrypted in this tab; nothing is uploaded.
            </p>
            {passkeysWorkHere(backup.blob.rpId) && backup.blob.keys.length > 0 && !noPrf ? (
              <div className="formrow" style={{ marginTop: 12 }}>
                <Button variant="gold" autoFocus busy={openFile.busy && backupHow === 'passkey'} disabled={busy && !openFile.busy} onClick={() => void openFile.run({ kind: 'passkey' })}>
                  Open with passkey
                </Button>
              </div>
            ) : (
              <p className="sub2 muted" style={{ marginTop: 10 }}>
                {passkeysWorkHere(backup.blob.rpId) ? 'Passkeys can’t open it in this browser — use its recovery code.' : `Its passkeys belong to ${backup.blob.rpId} — use its recovery code here.`}
              </p>
            )}
            <form
              onSubmit={(e) => {
                e.preventDefault()
                if (backupCode.trim() && !busy) void openFile.run({ kind: 'recovery', code: backupCode })
              }}
            >
              <div className="zk-door-field">
                <Field label="Or its recovery code" hint="Dashes and case don’t matter">
                  <TextInput
                    placeholder="XXXX-XXXX-XXXX-…"
                    spellCheck={false}
                    autoComplete="off"
                    style={{ fontFamily: 'var(--mono)' }}
                    value={backupCode}
                    onChange={(e) => setBackupCode(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              </div>
              <div className="formrow" style={{ marginTop: 12 }}>
                <Button type="submit" busy={openFile.busy && backupHow === 'recovery'} disabled={!backupCode.trim() || (busy && !openFile.busy)}>
                  Open
                </Button>
                <Button variant="ghost" disabled={busy} onClick={back}>
                  Back
                </Button>
              </div>
            </form>
            {waiting && <PasskeyWait />}
          </>
        ) : view === 'backup-new' && snap ? (
          <>
            <BackupAsVault
              snap={snap}
              behind={backupBehind(snap)}
              hadVault={mode.vault !== null}
              label={label}
              onLabel={setLabel}
              canCreate={!noPrf}
              busy={busy}
              restoring={restoreAsVault.busy}
              starting={startFromBackup.busy}
              onRestore={() => void restoreAsVault.run()}
              onStartNew={() => void startFromBackup.run(label.trim() || 'this device')}
              onBack={back}
            />
            {waiting && <PasskeyWait />}
          </>
        ) : view === 'name' ? (
          <>
            <h2>{replacing ? 'Start over with a new vault' : 'Set up your vault'}</h2>
            <p className="sub2">
              {replacing
                ? `Your new vault replaces v${replacing.version} the moment it is created: the stored one${
                    replacing.members.length > 0 ? ', and everyone’s access to it,' : ''
                  } is deleted then, for good. Until you create it, nothing changes. `
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
              onSubmit={(e) => {
                e.preventDefault()
                if (!busy && !noPrf) void create.run(label.trim() || 'this device', replacing?.version)
              }}
            >
              <div className="zk-door-field">
                <Field label="Name this device" hint="Shown in the vault’s passkey list">
                  <TextInput
                    autoFocus
                    placeholder="e.g. Max’s Mac"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    disabled={busy}
                  />
                </Field>
              </div>
              <div className="formrow" style={{ marginTop: 12 }}>
                <Button variant={replacing ? 'danger' : 'gold'} type="submit" busy={create.busy} disabled={noPrf || (busy && !create.busy)}>
                  {replacing ? `Create — and delete v${replacing.version}` : 'Create vault with a passkey'}
                </Button>
                {mode.vault && (
                  <Button variant="ghost" disabled={busy} onClick={back}>
                    Back
                  </Button>
                )}
              </div>
            </form>
            {waiting && <PasskeyWait />}
            {noPrf && (
              <div className="formrow" style={{ marginTop: 10 }}>
                <Button size="mini" variant="ghost" busy={explore.busy} disabled={busy && !explore.busy} onClick={() => void explore.run()}>
                  Explore without a vault (nothing can be saved)
                </Button>
              </div>
            )}
            {!mode.vault && !replacing && (
              <p className="sub2 muted zk-door-note">
                Have a backup file (.scarab)?{' '}
                <button type="button" className="zk-link zk-link-inline" disabled={busy} onClick={() => backupRef.current?.click()}>
                  Restore the vault from it…
                </button>
                {backupInput}
              </p>
            )}
            {!mode.vault && !replacing && invites.length === 0 && (
              <p className="sub2 muted zk-door-note">
                Joining a household? Ask them to invite you first{identity ? <> — as <span className="inkstrong">{identity}</span></> : null}; the
                invitation shows up here.
              </p>
            )}
          </>
        ) : (
          <>
            <h2>Unlock your vault</h2>
            <p className="sub2">
              Vault v{mode.vault!.version}, {saved(mode.vault!, identity)}
              {mode.household ? <> · shared with you by {mode.household}</> : null}. Your passkey decrypts it in this
              tab and nowhere else — the server holds only ciphertext.
            </p>
            {noPrf && (
              <p className="sub2 neg" style={{ marginTop: 10 }}>
                This browser cannot open Scarab: it needs passkeys with the PRF extension. Use Chrome or Safari on a
                recent Mac, iPhone, Android or Windows device. The recovery code still works here.
              </p>
            )}
            {mode.household !== null && mine === 0 && (
              <p className="sub2 zk-invite-warn">
                There’s no passkey for you on this vault yet. Ask {mode.household} to add one while your phone is near their screen (Data &amp;
                Vault → Household → your row → Add a passkey for them), or open it with the recovery code, if they gave it to you.
              </p>
            )}
            {view === 'door' ? (
              <div className="formrow" style={{ marginTop: 12 }}>
                <Button variant="gold" autoFocus busy={unlock.busy} disabled={noPrf || (busy && !unlock.busy)} onClick={() => void unlock.run()}>
                  Unlock with passkey
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => setStep('recover')}>
                  Use recovery code…
                </Button>
                {mode.household === null && (
                  <Button variant="ghost" busy={startOver.busy} disabled={busy && !startOver.busy} onClick={() => void startOver.run()}>
                    Start over…
                  </Button>
                )}
                <Button variant="ghost" busy={pickBackup.busy} disabled={busy && !pickBackup.busy} onClick={() => backupRef.current?.click()}>
                  Open a backup…
                </Button>
                {backupInput}
                {mode.household !== null && (
                  <Button variant="ghost" busy={leave.busy} disabled={busy && !leave.busy} onClick={() => void leave.run()}>
                    Leave the household…
                  </Button>
                )}
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (code.trim() && !busy) void recover.run(code)
                }}
              >
                <div className="zk-door-field">
                  <Field label="Recovery code" hint="13 groups of 4 and a last group of 2 (older codes: no last group) — dashes and case don’t matter">
                    <TextInput
                      autoFocus
                      placeholder="XXXX-XXXX-XXXX-…"
                      spellCheck={false}
                      autoComplete="off"
                      style={{ fontFamily: 'var(--mono)' }}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                </div>
                <div className="formrow" style={{ marginTop: 12 }}>
                  <Button variant="gold" type="submit" busy={recover.busy} disabled={!code.trim() || (busy && !recover.busy)}>
                    Unlock
                  </Button>
                  <Button variant="ghost" disabled={busy} onClick={back}>
                    Back
                  </Button>
                </div>
              </form>
            )}
            {waiting && <PasskeyWait />}
            <p className="sub2 muted zk-door-note">
              No passkey on this device? The prompt offers a QR code — scan it with the phone that has one, and the
              phone answers. Add this device afterwards from Data &amp; Vault.
            </p>
          </>
        )}

        {mode.zkOnly ? (
          <div className="sub2 topline muted">
            This server is vault-only: it accepts ciphertext and serves the daily price basket, nothing else.
          </div>
        ) : (
          <div className="sub2 topline">
            <span className="muted">Running your own instance for the household, with the server holding plaintext?</span>{' '}
            <Button size="mini" variant="ghost" onClick={onHousehold} disabled={busy}>
              Continue in household mode
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
