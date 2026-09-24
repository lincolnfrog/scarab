import { renderToStaticMarkup } from 'react-dom/server'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { PasskeyWrap, VaultHeader } from '../../../shared/vault'

/**
 * Node has no DOM here, so the Data & Vault cards are rendered to static
 * markup: enough to prove each state renders and says the right things.
 * Interaction (menus, dialogs, passkey prompts) is checked in the browser.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})
const store = new Map<string, string>()
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hostname: 'localhost', reload: () => {} } }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
})
vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const text = (html: string) =>
  html
    .replace(/<wbr\/?>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

const wrap = (id: string, label: string, identity?: string): PasskeyWrap => ({
  credentialId: id,
  label,
  addedAt: '2026-09-20T12:00:00.000Z',
  ...(identity ? { identity } : {}),
  wrappedKey: { iv: '', ct: '' },
})
const header = (keys: PasskeyWrap[]): VaultHeader => ({ v: 3, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA', rpId: 'localhost', prfSalt: 'c2FsdA==', enc: 'gzip+pad', keys })
const members = {
  household: 'max@x.com',
  members: [{ email: 'nicole@x.com', added_by: 'max@x.com', added_at: '2026-09-02 10:00:00' }],
}

let local: typeof import('../../local')
let ui: {
  HouseholdCard: typeof import('./Household').HouseholdCard
  SessionCard: typeof import('./Session').SessionCard
  RecoveryCard: typeof import('./Recovery').RecoveryCard
  AdvancedCard: typeof import('./Advanced').AdvancedCard
  BackupsCard: typeof import('./Backups').BackupsCard
}

beforeAll(async () => {
  local = await import('../../local')
  ui = {
    HouseholdCard: (await import('./Household')).HouseholdCard,
    SessionCard: (await import('./Session')).SessionCard,
    RecoveryCard: (await import('./Recovery')).RecoveryCard,
    AdvancedCard: (await import('./Advanced')).AdvancedCard,
    BackupsCard: (await import('./Backups')).BackupsCard,
  }
  local.localMode.setIdentity('max@x.com')
})

describe('Data & Vault cards', () => {
  it('household mode: the session card points to Advanced; the household reads what the server lists; no management', () => {
    const h = text(renderToStaticMarkup(<ui.SessionCard info={null} household={null} reload={() => {}} openAdvanced={() => {}} />))
    expect(h).toMatch(/household · server data/)
    expect(h).toMatch(/Start a session from Advanced to move into a vault\./)
    expect(h).not.toMatch(/Unlock with passkey/) // nothing stored
    const none = text(renderToStaticMarkup(<ui.HouseholdCard info={null} members={null} reload={() => {}} />))
    expect(none).toMatch(/no vault yet/)
    expect(none).toMatch(/Create a vault first/)
    const adv = text(
      renderToStaticMarkup(<ui.AdvancedCard open info={null} members={null} refetching={false} basket={{ builtAt: null, count: 0, errors: [], building: false }} onToggle={() => {}} reload={() => {}} />),
    )
    expect(adv).toMatch(/Start a zero-knowledge session/)
    expect(adv).toMatch(/Start empty in this tab/)
    expect(adv).not.toMatch(/Rotate key/)
    expect(text(renderToStaticMarkup(<ui.RecoveryCard />))).toMatch(/Unlock the vault to see the code/)
    expect(text(renderToStaticMarkup(<ui.BackupsCard />))).toMatch(/Restore from an export…/)
  })

  it('in a session: people with their passkeys by identity, this device marked, the owner’s actions, and the add form', async () => {
    await local.enterLocalMode(null)
    store.set('scarab:device-creds', JSON.stringify(['mac']))
    local.localMode.setVault({
      rawDataKey: new Uint8Array(32),
      header: header([
        wrap('mac', 'Max’s Mac', 'max@x.com'),
        wrap('phone', 'Nicole’s iPhone', 'nicole@x.com'),
        wrap('old', 'nicole@x.com'), // from before identities
        wrap('gone', 'Aaron’s tablet', 'aaron@x.com'), // no longer in the household
      ]),
      version: 7,
    })
    local.localMode.markSaved(7)
    const html = renderToStaticMarkup(<ui.HouseholdCard info={null} members={members} reload={() => {}} />)
    const t = text(html)
    expect(t).toMatch(/2 people · 4 passkeys/)
    expect(t).toMatch(/max@x\.com you owner Max’s Mac Sep 20 this device/)
    expect(t).toMatch(/nicole@x\.com member · added by you · Sep 2 Nicole’s iPhone Sep 20 nicole@x\.com Sep 20/)
    expect(t).toMatch(/aaron@x\.com no longer in the household Aaron’s tablet .* These passkeys still open the vault\. Re-key without them…/)
    expect(html.match(/this device/g)).toHaveLength(1)
    expect(html).toContain('aria-label="nicole@x.com: household actions"')
    expect(html).toContain('aria-label="Passkey “Nicole’s iPhone”"')
    expect(t).toMatch(/\+ Passkey/)
    expect(t).toMatch(/Invite someone .* Invite…/)
    expect(t).not.toMatch(/Leave…/) // the owner doesn't leave; Start over is theirs

    // Someone invited who hasn't answered: their own row, with who invited them and the passkey added for them.
    const waiting = renderToStaticMarkup(
      <ui.HouseholdCard
        info={null}
        members={{ ...members, invites: [{ email: 'aaron@x.com', invited_by: 'max@x.com', invited_at: '2026-09-22 09:00:00' }] }}
        reload={() => {}}
      />,
    )
    expect(text(waiting)).toMatch(/2 people · 1 invited · 4 passkeys/)
    expect(text(waiting)).toMatch(/aaron@x\.com invited by you · Sep 22 · hasn’t accepted yet Aaron’s tablet/)
    expect(waiting).toContain('aria-label="aaron@x.com: household actions"')
    expect(waiting).toMatch(/data-role="invited"/)

    const s = text(renderToStaticMarkup(<ui.SessionCard info={null} household={null} reload={() => {}} openAdvanced={() => {}} />))
    expect(s).toMatch(/Vault v7 is open in this tab/)
    expect(s).toMatch(/Everything is saved\./)
    expect(s).toMatch(/Save now Lock End session…/)
    const r = text(renderToStaticMarkup(<ui.RecoveryCard />))
    expect(r).toMatch(/Show recovery code…/)
    expect(r).toMatch(/Test your written-down recovery code/)
  })

  it('a member sees the household but can manage only their own passkeys; nobody can remove the owner', () => {
    local.localMode.setIdentity('nicole@x.com')
    const html = renderToStaticMarkup(<ui.HouseholdCard info={null} members={members} reload={() => {}} />)
    expect(text(html)).toMatch(/nicole@x\.com you member .* Leave…/) // she can leave on her own
    expect(html).not.toContain('household actions') // removing people is the owner's
    expect(html).not.toContain('aria-label="Passkey “Max’s Mac”"') // the owner's passkeys aren't hers to edit
    expect(html).toContain('aria-label="Passkey “Nicole’s iPhone”"')
    expect(html).not.toContain('Re-key without them') // only the owner finishes a removal
    local.localMode.setIdentity('max@x.com')
  })

  it('Rotate key is the owner’s: a member is told whose it is, and nobody is offered it while the household is unknown', () => {
    const adv = (m: typeof members | null) =>
      text(
        renderToStaticMarkup(
          <ui.AdvancedCard open info={null} members={m && { ...m, invites: [] }} refetching={false} basket={null} onToggle={() => {}} reload={() => {}} />,
        ),
      )
    expect(adv(members)).toMatch(/Rotate key…/)
    expect(adv(members)).not.toMatch(/can re-key/)
    local.localMode.setIdentity('nicole@x.com') // a re-key keeps only the passkey that answers: hers would lock Max out of his
    expect(adv(members)).not.toMatch(/Rotate key/)
    expect(adv(members)).toMatch(/Only max@x\.com can re-key this vault — ask them to if a recovery code or a device may be in the wrong hands\./)
    local.localMode.setIdentity('Max@X.com') // IAP's letter case doesn't make the owner a stranger
    expect(adv(members)).toMatch(/Rotate key…/)
    local.localMode.setIdentity('max@x.com')
    expect(adv(null)).not.toMatch(/Rotate key|can re-key/) // who owns it isn't known: neither
  })

  it('what the device still owes: an unfinished removal and a new recovery code', async () => {
    const session = await import('../../session')
    // As the session sets them when it opens a vault this device owes something (session.members.test covers that).
    const followState = session.follow as { rotationOwed: string | null; recoveryOwed: boolean }
    Object.assign(followState, { rotationOwed: 'aaron@x.com', recoveryOwed: true })
    const h = text(renderToStaticMarkup(<ui.HouseholdCard info={null} members={members} reload={() => {}} />))
    expect(h).toMatch(/aaron@x\.com is out of the household, but the vault hasn’t been re-keyed yet\. .* Re-key now…/)
    const r = text(renderToStaticMarkup(<ui.RecoveryCard />))
    expect(r).toMatch(/Store the new recovery code\. The vault’s key was set on this device — a rotation, a removal, or creating the vault/)
    expect(r).toMatch(/Show the new recovery code…/)
    Object.assign(followState, { rotationOwed: null, recoveryOwed: false })
  })

  it('a backup opened with no vault stored: restored as it was — unless this device saw the vault move on since, which it says by version', async () => {
    const { BackupAsVault } = await import('./BackupAsVault')
    const snap = {
      source: { kind: 'backup', name: 'b.scarab', sealedAs: 35, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA', via: { kind: 'recovery' } },
      dump: { scarab: true, schemaVersion: 20, exportedAt: '', tables: {} },
      exportedAt: '',
      schemaVersion: 20,
      counts: { accounts: 3 },
      unreadable: null,
      upgraded: [],
    } as unknown as import('../../session').OpenedSnapshot
    const seen = { seq: 42, sha256: 'a'.repeat(64), at: '2026-09-20T12:00:00Z', creds: [] }
    const render = (behind: import('../../session').BackupBehind | null) => {
      const html = renderToStaticMarkup(
        <BackupAsVault
          snap={snap}
          behind={behind}
          hadVault
          label=""
          onLabel={() => {}}
          canCreate
          busy={false}
          restoring={false}
          starting={false}
          onRestore={() => {}}
          onStartNew={() => {}}
          onBack={() => {}}
        />,
      )
      return { t: text(html), buttons: [...html.matchAll(/<button[^>]*><span[^>]*>([^<]*)</g)].map((m) => m[1]) }
    }
    const plain = render(null)
    expect(plain.t).toMatch(/No vault is stored here any more\. Restoring makes this backup the vault, sealed with the same key/)
    expect(plain.buttons).toEqual(['Restore the vault from this backup', 'Back'])

    const newer = render({ seen, sealedAs: 35, rekeyed: false })
    expect(newer.t).toMatch(/This device saw this vault at v42 \(.+\), later than this backup \(v35\)\. Restored as it was/)
    expect(newer.t).toMatch(/a passkey removed since included\. A server that says the vault is gone may also be holding it back/)
    expect(newer.buttons).toEqual(['Start a new vault from this backup', 'Restore it as it was…', 'Back'])

    const rekeyed = render({ seen, sealedAs: 35, rekeyed: true })
    expect(rekeyed.t).toMatch(/later than this backup \(v35\), and it was re-keyed since\./)
    expect(rekeyed.t).toMatch(/the recovery code retired since/)
    expect(rekeyed.buttons).toEqual(['Start a new vault from this backup', 'Back']) // never as it was: the retired key would come back

    const unknown = render({ seen, sealedAs: 35, rekeyed: null })
    expect(unknown.t).toMatch(/if the key was changed since \(this device can’t tell\)/)
  })

  it('history: this tab first, then each kept version with who, when, size and why it is kept; the backups card offers the .scarab file', async () => {
    const { HistoryList } = await import('./History')
    const now = Date.parse('2026-09-23T12:00:00Z')
    const h = {
      entries: [
        { version: 12, sha256: 'a', size: 45_000, updated_at: '2026-09-23 11:30:00', updated_by: 'nicole@x.com', pin: null },
        { version: 11, sha256: 'b', size: 44_000, updated_at: '2026-09-21 09:00:00', updated_by: 'max@x.com', pin: 'pre-restore' },
        ...Array.from({ length: 10 }, (_, i) => ({ version: 10 - i, sha256: 'c', size: 1_300_000, updated_at: '2026-09-01 09:00:00', updated_by: null, pin: null })),
      ],
      bytes: 13_089_000,
      policy: { keepLast: 20, dailyDays: 30, maxPins: 8, byteCap: 64 * 1024 * 1024 },
    }
    const html = renderToStaticMarkup(<HistoryList h={h} version={13} dirty identity="max@x.com" now={now} all={false} opening={null} onOpen={() => {}} />)
    // (Each time also carries its full date, the tooltip's text, which is always in the markup for screen readers.)
    const t = text(html).replace(/ [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M/g, '')
    expect(t).toMatch(/v13 now — this tab, with unsaved changes/)
    expect(t).toMatch(/v12 30m ago nicole@x\.com 44 KB Open…/)
    expect(t).toMatch(/v11 2d ago you 43 KB kept from before a restore Open…/)
    expect(t).toMatch(/v10 Sep 1 someone 1\.2 MB Open…/)
    expect(html.match(/Open…/g)).toHaveLength(8) // the first eight until "Show all"
    expect(html).toContain('aria-label="Open v12"')
    const every = renderToStaticMarkup(<HistoryList h={h} version={13} dirty={false} identity="max@x.com" now={now} all opening={11} onOpen={() => {}} />)
    expect(every.match(/Open…/g)).toHaveLength(12)
    expect(text(every)).toMatch(/v13 now — this tab v12/)
    // While one version opens, the others wait.
    expect(every.match(/<button disabled=""[^>]*aria-label="Open v/g)).toHaveLength(11)

    // The Backups card, in a session with a vault: the encrypted file, made and opened here.
    const b = text(renderToStaticMarkup(<ui.BackupsCard />))
    expect(b).toMatch(/Encrypted backup A \.scarab file of this tab, sealed like a vault version/)
    expect(b).toMatch(/Download encrypted backup Open a backup…/)
  })

  it('the preview: what a version holds, its warnings, and the restore — never destructive', async () => {
    const { SnapshotPreviewHost, showSnapshot } = await import('./Preview')
    const snap = {
      source: { kind: 'history' as const, version: 41, at: Date.now() - 3 * 3600_000, by: 'nicole@x.com', pin: 'pre-upgrade', sealedAs: 40 },
      dump: { scarab: true as const, schemaVersion: 19, exportedAt: '2026-09-20T10:00:00Z', tables: {} },
      exportedAt: '2026-09-20T10:00:00Z',
      schemaVersion: 19,
      counts: { accounts: 2, transactions: 140, trades: 0 },
      unreadable: null,
      upgraded: [20],
    }
    showSnapshot(snap)
    const t = text(renderToStaticMarkup(<SnapshotPreviewHost />))
    expect(t).toMatch(/Vault v41 saved 3h ago by nicole@x\.com · kept from before an upgrade/)
    expect(t).toMatch(/sealed as v40, not v41: the server’s history doesn’t match what was saved/)
    expect(t).toMatch(/Written by an older Scarab \(schema v19\); it is brought up to date as it loads\./)
    expect(t).toMatch(/Records v41 Cash accounts 2 Transactions 140/)
    expect(t).not.toMatch(/Trades/) // no rows on either side
    expect(t).toMatch(/Close Download \(JSON\) Restore v41…/)

    showSnapshot({ ...snap, source: { kind: 'backup', name: 'scarab-backup-2026-09-20-v12.scarab', sealedAs: 12, vaultId: 'X', via: { kind: 'session' } }, counts: null, unreadable: 'export is v99, newer than this engine (v20) — update Scarab first' })
    const u = renderToStaticMarkup(<SnapshotPreviewHost />)
    expect(text(u)).toMatch(/Backup file scarab-backup-2026-09-20-v12\.scarab · taken Sep 20 · sealed for v12/)
    expect(text(u)).toMatch(/This version of Scarab can’t load it: export is v99/)
    expect(u).toMatch(/<button disabled=""[^>]*class="btn gold"[^>]*><span[^>]*>Restore this backup to the vault…/) // nothing to restore
    showSnapshot(null)
  })

  it('the front door’s recovery code waits for Copy, Print or “I wrote it down” too', async () => {
    const RecoveryCode = (await import('../../RecoveryCode')).default
    const html = renderToStaticMarkup(<RecoveryCode code="ABCD-EFGH" title="Recovery code" onDone={() => {}} />)
    expect(text(html)).toMatch(/I wrote it down/)
    expect(html).toMatch(/<button disabled=""[^>]*class="btn gold"[^>]*><span[^>]*>I’ve stored it/)
    expect(text(html)).toMatch(/Copy it, print it, or tick “I wrote it down” first\./)
    expect(text(html)).toMatch(/Print Copy I’ve stored it/)
  })

  it('the recovery-code sheet: a required new code waits for Copy, Print or “I wrote it down”', async () => {
    const { RecoveryCodeSheet } = await import('../../RecoveryCode')
    const req = renderToStaticMarkup(<RecoveryCodeSheet code="ABCD-EFGH" title="New recovery code" required onDone={() => {}} />)
    const t = text(req)
    expect(t).toMatch(/New recovery code/)
    expect(t).toMatch(/ABCD-EFGH/)
    expect(t).toMatch(/I wrote it down/)
    expect(req).toMatch(/<button disabled=""[^>]*><span[^>]*>I’ve stored it/)
    expect(req).toMatch(/aria-label="Close" disabled=""/) // and it can't be dismissed
    const plain = renderToStaticMarkup(<RecoveryCodeSheet code="ABCD-EFGH" title="Recovery code" required={false} onDone={() => {}} />)
    expect(text(plain)).not.toMatch(/I wrote it down/)
    expect(plain).toMatch(/<button type="button" class="btn gold"><span[^>]*>Done</)
  })
})

describe('the front door', () => {
  type Mode = import('../../session').Mode
  const door = async (mode: Mode) => {
    const FrontDoor = (await import('../../FrontDoor')).default
    const html = renderToStaticMarkup(<FrontDoor mode={mode} onEnter={() => {}} onHousehold={() => {}} />)
    return { html, t: text(html) }
  }
  const vault = { version: 3, updated_at: '2026-09-20 10:00:00', updated_by: 'nicole@x.com', sha256: 'a', keepsHistory: true }
  const invite = { household: 'max@x.com', invited_by: 'max@x.com', invited_at: '2026-09-22 09:00:00' }
  const base: Mode = { vault: null, household: null, serverHasData: false, zkOnly: true, invites: [] }

  it('an invitation waiting comes first: who sent it, and Join, Decline or Not now — nobody joins without saying yes', async () => {
    local.localMode.setIdentity('nicole@x.com')
    const { html, t } = await door({ ...base, invites: [invite] })
    expect(html).toMatch(/<div class="card zk-door"/)
    expect(t).toMatch(/You’re invited max@x\.com invited you .* to share their vault\./)
    expect(t).toMatch(/nobody joins a household without saying yes here/)
    expect(t).toMatch(/Join max@x\.com’s household Decline Not now/)
    expect(t).not.toMatch(/deletes it/) // nothing of hers to lose
    // Sent by a member of the household: says both.
    const byMember = await door({ ...base, invites: [{ ...invite, invited_by: 'aaron@x.com' }] })
    expect(byMember.t).toMatch(/aaron@x\.com, for max@x\.com’s household, invited you/)
  })

  it('accepting ends what she has — her own vault (and says so, in red), or her membership elsewhere', async () => {
    const own = await door({ ...base, vault, invites: [invite] })
    expect(own.t).toMatch(/You have a vault of your own \(v3, saved .* by you\)\. Joining deletes it, for good/)
    expect(own.html).toMatch(/class="btn danger"[^>]*><span[^>]*>Join max@x\.com’s household/)
    const elsewhere = await door({ ...base, vault, household: 'zed@x.com', invites: [invite] })
    expect(elsewhere.t).toMatch(/You’re in zed@x\.com’s household now\. Joining this one takes you out of it\./)
  })

  it('no vault and no invitation: set one up — or ask to be invited first', async () => {
    local.localMode.setIdentity('nicole@x.com')
    const { t } = await door(base)
    expect(t).toMatch(/Set up your vault/)
    expect(t).toMatch(/Joining a household\? Ask them to invite you first — as nicole@x\.com ?; the invitation shows up here\./)
    const invited = await door({ ...base, invites: [invite] })
    expect(invited.t).not.toMatch(/Ask them to invite you first/)
  })

  it('a member at the door: unlock, or leave the household; the owner gets Start over instead', async () => {
    const member = await door({ ...base, vault, household: 'max@x.com' })
    expect(member.t).toMatch(/Unlock your vault Vault v3, saved .* · shared with you by max@x\.com/)
    expect(member.t).toMatch(/Leave the household…/)
    expect(member.t).not.toMatch(/Start over/)
    local.localMode.setIdentity('max@x.com')
    const owner = await door({ ...base, vault })
    expect(owner.t).toMatch(/Start over…/)
    expect(owner.t).not.toMatch(/Leave the household/)
  })
})
