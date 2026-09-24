import { useState } from 'react'
import type { PasskeyWrap } from '../../../shared/vault'
import { localMode } from '../../local'
import { passkeysWorkHere } from '../../passkey'
import {
  addedWhileInvited,
  addHouseholdMember,
  addMember,
  addPasskey,
  cancelInvite,
  fetchMembers,
  follow,
  keysOfStored,
  leaveHousehold,
  removeFromHousehold,
  removePasskey,
  renamePasskey,
  thisDevicePasskeys,
  type Member,
  type PendingInvite,
  type VaultInfo,
} from '../../session'
import { Button } from '../../ui/Button'
import { confirm, prompt } from '../../ui/dialogs'
import { Field, TextInput } from '../../ui/Field'
import { Menu, type MenuItem } from '../../ui/Menu'
import { initialsFor, shortDate } from '../../ui/syncStatus'
import { Tooltip } from '../../ui/Tooltip'
import { useAction } from '../../ui/useAction'
import { showRecoveryCode } from './codeSheet'
import { householdRows, passkeysOf, type PasskeyChip, type Person } from './people'
import './vault.css'

const when = (iso: string | null) => {
  if (!iso) return ''
  const t = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(t) ? iso.slice(0, 10) : shortDate(t)
}

/**
 * The Household card: one row per person — the owner (who created the vault),
 * each member, and anyone invited who hasn't answered — with their passkeys
 * as chips. Passkeys are tied to people by the identity each wrapping names,
 * never by label; "this device" marks the ones this browser's own
 * authenticator holds.
 *
 * Nobody is added without saying yes: inviting records an invitation that
 * they accept on their own device (the front door offers it). Their passkey
 * can go on the vault before (they're here, with their phone) or after.
 * Taking someone out is real: the server stops serving them, the vault is
 * re-keyed without them and the server drops every earlier version — then a
 * new recovery code. A member can leave on their own.
 */
export function HouseholdCard(p: {
  info: VaultInfo | null | undefined
  members: { household: string; members: Member[]; invites?: PendingInvite[] } | null
  /** What the server holds couldn't be fetched (null: it could). */
  loadError?: string | null
  reload: () => void
}) {
  const session = localMode.vault
  const identity = localMode.identity
  const [email, setEmail] = useState('')

  // The session's header once unlocked (authenticated, current); otherwise what the server lists (unauthenticated).
  let wraps: PasskeyWrap[] = []
  try {
    wraps = session ? session.header.keys : p.info ? keysOfStored(p.info) : []
  } catch {
    wraps = [] // a header this page can't read: the Advanced card says so
  }
  const owner = p.members?.household ?? follow.household?.owner ?? identity ?? ''
  const rows = owner
    ? householdRows({
        owner,
        members: p.members?.members ?? [],
        invites: p.members?.invites ?? [],
        wraps,
        identity,
        here: thisDevicePasskeys(),
        unlockedWith: follow.unlockedWith?.kind === 'passkey' ? follow.unlockedWith.credentialId : null,
      })
    : []
  const me = identity?.toLowerCase() ?? null
  const iAmOwner = !!me && me === owner.toLowerCase()
  /** Changes need the key (a session) and passkeys usable on this page. */
  const canManage = !!session && passkeysWorkHere(session.header.rpId)
  const lastOnVault = wraps.length <= 1

  /* ---------- actions ---------- */

  const addMine = useAction(
    async () => {
      const v = await prompt<{ label: string }>({
        title: 'Add a passkey',
        body: 'Your browser asks where to make it: this device, or a phone or security key through its QR prompt.',
        fields: [{ key: 'label', kind: 'text', label: 'Name it', maxLength: 64, hint: 'e.g. Max’s iPhone' }],
        submitLabel: 'Continue to the passkey prompt',
      })
      if (!v) return null
      return addPasskey(v.label)
    },
    { success: (w) => (w ? `Passkey “${w.label}” added — it unlocks the vault from now on` : ''), errorPrefix: 'Couldn’t add the passkey' },
  )

  /**
   * Invite someone: an invitation they accept on their own device. Their
   * passkey goes on the vault now (they're here: their phone answers the QR
   * prompt) or later, from their row.
   */
  const invite = useAction(
    async (typed: string): Promise<string | null> => {
      const who = typed.trim().toLowerCase()
      const already = rows.find((r) => r.email === who)
      if (already?.role === 'owner' || already?.me) throw new Error('That identity already opens this vault.')
      if (already?.role === 'member') throw new Error(`${who} is already in the household — add a passkey for them from their row.`)
      const v = await prompt<{ when: string; label: string }>({
        title: `Invite ${who}`,
        body: (
          <div className="zk-confirm">
            <p>
              They join only by accepting, signed in as <b>{who}</b> on their own device: Scarab’s front door shows them the invitation, and who
              sent it. Until then the server doesn’t give them the vault.
            </p>
            <p className="muted">Inviting tells you nothing about them — the server answers the same for any email.</p>
          </div>
        ),
        fields: [
          {
            key: 'when',
            kind: 'select',
            label: 'Their passkey',
            initial: 'now',
            options: [
              { value: 'now', label: 'Add it now — they’re here, with their phone' },
              { value: 'later', label: 'Later — after they accept' },
            ],
          },
          { key: 'label', kind: 'text', label: 'Their device', required: false, maxLength: 64, hint: 'For a passkey now — e.g. Nicole’s iPhone' },
        ],
        submitLabel: 'Invite',
      })
      if (!v) return null
      if (v.when === 'later') {
        // Ask the server, not this panel: they may have declined (or accepted) since the rows were loaded, and an
        // invitation the panel still shows but the server dropped must be sent again, never reported as standing.
        const now = await fetchMembers()
        if (now.members.some((m) => m.email.toLowerCase() === who)) throw new Error(`${who} is already in the household — add a passkey for them from their row.`)
        const stands = now.invites.some((i) => i.email.toLowerCase() === who)
        if (!stands) await addMember(who) // (already invited: the invitation stands as it is)
        setEmail('')
        return stands ? `${who} is already invited — once they accept, add their passkey from their row` : `Invited ${who} — once they accept on their own device, add their passkey from their row`
      }
      const r = await addHouseholdMember(who, v.label)
      setEmail('')
      return `Invited ${who} — their passkey “${r.wrap.label}” is on the vault and opens it once they accept`
    },
    { success: (m) => m ?? '', errorPrefix: 'Couldn’t invite them', onDone: p.reload },
  )

  const addFor = useAction(
    async (person: Person) => {
      const v = await prompt<{ label: string }>({
        title: `Add a passkey for ${person.email}`,
        body: 'Hand them the QR prompt: their phone makes the passkey, in their own Apple or Google account.',
        fields: [{ key: 'label', kind: 'text', label: 'Their device', maxLength: 64, hint: 'e.g. Nicole’s iPhone' }],
        submitLabel: 'Continue to the passkey prompt',
      })
      if (!v) return null
      return addHouseholdMember(person.email, v.label)
    },
    {
      success: (r) =>
        !r ? '' : `Passkey “${r.wrap.label}” added for ${r.wrap.identity ?? 'them'}${r.pending ? ' — it opens the vault once they accept' : ''}`,
      errorPrefix: 'Couldn’t add the passkey',
      onDone: p.reload,
    },
  )

  /**
   * Withdraw an unanswered invitation, and take the passkeys added for them since it was sent off the vault (no
   * re-key: the server never gave them the vault). Older ones of theirs stay, as "no longer in the household".
   */
  const withdraw = useAction(
    async (person: Person) => {
      const fresh = person.passkeys.filter((c) => person.addedAt !== null && addedWhileInvited(c.wrap.addedAt, person.addedAt)) // as cancelInvite judges it
      const older = person.passkeys.length - fresh.length
      const ok = await confirm({
        title: `Withdraw the invitation to ${person.email}?`,
        body: (
          <div className="zk-confirm">
            <p>They can’t accept it any more; you can invite them again later.</p>
            {fresh.length > 0 && (
              <p>
                {fresh.length === 1 ? `Their passkey “${fresh[0]!.wrap.label}” comes` : `The ${fresh.length} passkeys added for them come`} off the vault too.
                No re-key is needed: the server gives the vault only to members, and they never accepted.
              </p>
            )}
            {older > 0 && (
              <p>
                {older === 1 ? 'One passkey of theirs is' : `${older} passkeys of theirs are`} older than this invitation — from when they were in the
                household, perhaps — so {older === 1 ? 'it stays' : 'they stay'}, under “no longer in the household”, until you re-key without them.
              </p>
            )}
          </div>
        ),
        confirmLabel: 'Withdraw invitation',
        danger: true,
      })
      if (!ok) return null
      const r = await cancelInvite(person.email)
      return { email: person.email, ...r }
    },
    {
      success: (r) =>
        !r
          ? ''
          : `Invitation to ${r.email} withdrawn${r.removed ? ` · ${r.removed === 1 ? 'their passkey is' : `${r.removed} passkeys are`} off the vault` : ''}${r.kept ? ' · re-key to lock out their older passkeys' : ''}`,
      errorPrefix: 'Couldn’t withdraw the invitation',
      onDone: p.reload,
    },
  )

  /** A member leaves on their own: the server stops serving them the vault; the session ends. */
  const leave = useAction(
    async () => {
      const ok = await confirm({
        title: `Leave ${owner}’s household?`,
        body: (
          <div className="zk-confirm">
            <ol className="zk-steps">
              <li>The server stops giving you this vault, right away.</li>
              <li>Anything unsaved in this tab is saved to it first; then this session ends.</li>
              <li>Your passkeys stay on the vault until {owner} re-keys it — their Household card asks them to.</li>
              <li>Then you can set up a vault of your own, or accept another invitation.</li>
            </ol>
          </div>
        ),
        confirmLabel: 'Leave household',
        danger: true,
      })
      if (ok) await leaveHousehold()
    },
    { errorPrefix: 'Couldn’t leave the household' },
  )

  const rename = useAction(
    async (c: PasskeyChip, person: Person) => {
      const v = await prompt<{ label: string }>({
        title: 'Rename passkey',
        body: 'The name is part of the vault’s authenticated header, so renaming saves a new version.',
        fields: [{ key: 'label', kind: 'text', label: 'Name', initial: c.wrap.label, maxLength: 64 }],
        submitLabel: 'Rename',
      })
      if (!v || v.label === c.wrap.label) return null
      // A wrapping from before identities gets bound to whoever the panel shows it under, so the new name can't lose that.
      await renamePasskey(c.wrap.credentialId, v.label, c.binding === 'identity' || person.role === 'former' ? null : person.email)
      return v.label
    },
    { success: (l) => (l ? `Renamed to “${l}”` : ''), errorPrefix: 'Couldn’t rename the passkey' },
  )

  const drop = useAction(
    async (c: PasskeyChip, person: Person) => {
      const mine = person.me
      const theirLast = person.passkeys.length === 1
      const ok = await confirm({
        title: `Remove the passkey “${c.wrap.label}”?`,
        body: (
          <div className="zk-confirm">
            <p>It stops unlocking the vault. The recovery code and the other passkeys keep working.</p>
            {theirLast && mine && <p>It’s your only passkey: after this, you get in with the recovery code or a passkey you add.</p>}
            {theirLast && !mine && person.role === 'member' && (
              <p>
                It’s <b>{person.email}</b>’s only passkey, so they won’t be able to unlock until they get a new one. They stay in the household —
                to take away their access, use <b>Remove from household</b>, which re-keys the vault.
              </p>
            )}
            <p className="muted">
              The vault key stays the same. If the device was lost or someone else has it, rotate the key too (Advanced) — whoever holds the
              passkey and an old copy of the vault could still open that copy.
            </p>
          </div>
        ),
        confirmLabel: 'Remove passkey',
        danger: true,
      })
      if (!ok) return null
      await removePasskey(c.wrap.credentialId)
      return c.wrap.label
    },
    { success: (l) => (l ? `Passkey “${l}” removed` : ''), errorPrefix: 'Couldn’t remove the passkey' },
  )

  const remove = useAction(
    async (person: Person) => {
      const theirs = passkeysOf(rows, person.email)
      const others = wraps.filter((w) => !theirs.includes(w.credentialId))
      const ok = await confirm({
        title: person.role === 'former' ? `Lock ${person.email} out of the key?` : `Remove ${person.email} from the household?`,
        body: (
          <div className="zk-confirm">
            <ol className="zk-steps">
              {person.role !== 'former' && <li>The server stops giving them the vault, right away.</li>}
              <li>
                The vault is re-keyed without them: their passkeys stop working.{' '}
                {others.length > 1 ? (
                  <>
                    Of the other {others.length} (
                    {others
                      .slice(0, 4)
                      .map((w) => `“${w.label}”`)
                      .join(', ')}
                    {others.length > 4 ? ', …' : ''}), only the one you confirm with keeps working — add the rest again afterwards.
                  </>
                ) : (
                  'You confirm with your passkey, which keeps working.'
                )}
              </li>
              <li>Earlier versions the server keeps are deleted: they are sealed under the key they know.</li>
              <li>You get a new recovery code; the current one stops working.</li>
            </ol>
          </div>
        ),
        confirmLabel: person.role === 'former' ? 'Re-key now' : 'Remove and re-key',
        danger: true,
      })
      if (!ok) return null
      const r = await removeFromHousehold(person.email, theirs)
      showRecoveryCode({
        code: r.recoveryCode,
        title: 'New recovery code',
        subtitle: `${person.email} is out and the vault is re-keyed (v${r.version}); only “${r.kept}” unlocks it now. The old recovery code no longer works.`,
        required: true,
      })
      return r
    },
    { errorPrefix: 'The removal didn’t finish', onDone: p.reload },
  )

  const busy = addMine.busy || invite.busy || addFor.busy || withdraw.busy || leave.busy || rename.busy || drop.busy || remove.busy

  /* ---------- render ---------- */

  const noVault = p.info === null && !session
  const owed = follow.rotationOwed
  const owedRow = owed ? rows.find((r) => r.email === owed) : undefined
  const initials = initialsFor(rows.map((r) => r.email))
  const people = rows.filter((r) => r.role === 'owner' || r.role === 'member').length
  const invitedCount = rows.filter((r) => r.role === 'invited').length

  return (
    <section className="card c7 zk-card" aria-labelledby="zk-household-h">
      <div className="h4row">
        <h2 id="zk-household-h">Household</h2>
        <div className="right muted">
          {p.info === undefined && !session
            ? ''
            : noVault
            ? 'no vault yet'
            : `${people} ${people === 1 ? 'person' : 'people'}${invitedCount ? ` · ${invitedCount} invited` : ''} · ${wraps.length} passkey${wraps.length === 1 ? '' : 's'}${session ? '' : ' · as the server lists them'}`}
        </div>
      </div>

      {p.info === undefined && !session ? (
        <p className="sub2">
          {p.loadError ? `Couldn’t reach the server (${p.loadError}) — the household shows once it answers.` : 'Checking what the server holds…'}
        </p>
      ) : noVault ? (
        <p className="sub2">Create a vault first. Then invite the other person here: once they accept, their own passkey opens the same vault, and they are your recovery too.</p>
      ) : (
        <>
          {owed && (
            <div className="zk-callout" data-tone="down" role="status">
              <span>
                <b>{owed}</b> is out of the household, but the vault hasn’t been re-keyed yet. Until it is, the key they know still opens every new
                save.
              </span>
              {canManage && (
                <Button
                  size="mini"
                  variant="danger"
                  busy={remove.busy}
                  disabled={busy && !remove.busy}
                  onClick={() => void remove.run(owedRow ?? { email: owed, role: 'former', addedBy: null, addedAt: null, me: false, passkeys: [] })}
                >
                  Re-key now…
                </Button>
              )}
            </div>
          )}

          <ul className="zk-people">
            {rows.map((person, i) => {
              const canEditHis = canManage && (iAmOwner || person.me)
              const personMenu: MenuItem[] =
                canManage && iAmOwner && person.role === 'member'
                  ? [
                      { label: 'Add a passkey for them…', onSelect: () => void addFor.run(person) },
                      'sep',
                      { label: 'Remove from household…', danger: true, onSelect: () => void remove.run(person) },
                    ]
                  : canManage && person.role === 'invited' && (iAmOwner || person.addedBy?.toLowerCase() === me)
                    ? [
                        { label: 'Add their passkey…', onSelect: () => void addFor.run(person) },
                        'sep',
                        { label: 'Withdraw invitation…', danger: true, onSelect: () => void withdraw.run(person) },
                      ]
                    : []
              return (
                <li key={person.email} className="zk-person" data-role={person.role}>
                  <span
                    className="zk-av"
                    data-tone={person.role === 'former' ? 'x' : person.role === 'invited' ? 'i' : i % 2 === 0 ? 'm' : 'n'}
                    data-me={person.me ? '' : undefined}
                    aria-hidden="true"
                  >
                    {initials[i]}
                  </span>
                  <div className="zk-person-main">
                    <div className="zk-person-head">
                      <span className="zk-person-email">{person.email}</span>
                      {person.me && <span className="zk-you">you</span>}
                      <span className="zk-role">
                        {person.role === 'owner'
                          ? 'owner'
                          : person.role === 'member'
                            ? `member${person.addedBy ? ` · added by ${person.addedBy.toLowerCase() === me ? 'you' : person.addedBy}` : ''}${person.addedAt ? ` · ${when(person.addedAt)}` : ''}`
                            : person.role === 'invited'
                              ? `invited${person.addedBy ? ` by ${person.addedBy.toLowerCase() === me ? 'you' : person.addedBy}` : ''}${person.addedAt ? ` · ${when(person.addedAt)}` : ''} · hasn’t accepted yet`
                              : 'no longer in the household'}
                      </span>
                    </div>
                    <ul className="zk-chips" aria-label={`${person.email}’s passkeys`}>
                      {person.passkeys.map((c) => (
                        <li key={c.wrap.credentialId} className="zk-pk" data-here={c.here ? '' : undefined}>
                          <span className="zk-pk-label">{c.wrap.label}</span>
                          <span className="zk-pk-date">{when(c.wrap.addedAt)}</span>
                          {c.here && (
                            <Tooltip content="This browser’s own passkey store made it or has answered with it">
                              <span className="zk-pk-badge">this device</span>
                            </Tooltip>
                          )}
                          {c.unlockedThis && !c.here && <span className="zk-pk-badge" data-tone="quiet">opened this session</span>}
                          {canEditHis && person.role !== 'former' && (
                            <Menu
                              label={`Passkey “${c.wrap.label}”`}
                              items={[
                                { label: 'Rename…', onSelect: () => void rename.run(c, person) },
                                {
                                  label: 'Remove…',
                                  danger: true,
                                  disabled: lastOnVault,
                                  hint: lastOnVault ? 'the only one' : undefined,
                                  onSelect: () => void drop.run(c, person),
                                },
                              ]}
                            />
                          )}
                        </li>
                      ))}
                      {person.passkeys.length === 0 && (
                        <li className="zk-pk-none">
                          {person.role === 'owner'
                            ? 'no passkey — opens with the recovery code'
                            : person.role === 'invited'
                              ? 'no passkey yet — add one when they’re with you'
                              : 'no passkey yet — only the recovery code opens it for them'}
                        </li>
                      )}
                    </ul>
                    {person.role === 'former' && (
                      <p className="sub2 neg zk-former">
                        These passkeys still open the vault.
                        {canManage && iAmOwner && !owed && (
                          <>
                            {' '}
                            <button type="button" className="zk-link" disabled={busy} onClick={() => void remove.run(person)}>
                              Re-key without them…
                            </button>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="zk-person-actions">
                    {person.me && canManage && (
                      <Button size="mini" variant="ghost" busy={addMine.busy} disabled={busy && !addMine.busy} onClick={() => void addMine.run()}>
                        + Passkey
                      </Button>
                    )}
                    {person.me && person.role === 'member' && localMode.active && (
                      <Button size="mini" variant="ghost" busy={leave.busy} disabled={busy && !leave.busy} onClick={() => void leave.run()}>
                        Leave…
                      </Button>
                    )}
                    {personMenu.length > 0 && <Menu label={`${person.email}: household actions`} items={personMenu} />}
                  </div>
                </li>
              )
            })}
          </ul>

          {canManage && (
            <form
              className="zk-addmember"
              onSubmit={(e) => {
                e.preventDefault()
                if (email.trim()) void invite.run(email)
              }}
            >
              <Field label="Invite someone" hint="The Google account they sign in with">
                <TextInput type="email" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
              </Field>
              <Button type="submit" busy={invite.busy} disabled={(busy && !invite.busy) || !email.trim()}>
                Invite…
              </Button>
            </form>
          )}
          {canManage ? (
            <p className="sub2 muted zk-foot">
              Inviting someone: the server keeps an invitation for their email, and they accept it signed in on their own device. Their passkey is made
              by their phone answering this tab’s QR prompt — it lives in their own Apple or Google account, and this tab wraps the vault key for it.
              From then on they unlock with a fingerprint.
            </p>
          ) : session ? (
            <p className="sub2 muted zk-foot">This vault’s passkeys belong to {session.header.rpId} — manage them there.</p>
          ) : (
            <p className="sub2 muted zk-foot">Unlock the vault to manage passkeys and people.</p>
          )}
        </>
      )}
    </section>
  )
}
