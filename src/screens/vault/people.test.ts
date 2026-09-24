import { describe, expect, it } from 'vitest'
import type { PasskeyWrap } from '../../../shared/vault'
import { householdRows, ownerOfPasskey, passkeysOf, type MemberRow } from './people'

const wrap = (id: string, label: string, identity?: string, addedAt = `2026-09-0${id.length % 9}T00:00:00Z`): PasskeyWrap => ({
  credentialId: id,
  label,
  addedAt,
  ...(identity !== undefined ? { identity } : {}),
  wrappedKey: { iv: '', ct: '' },
})
const nicole: MemberRow = { email: 'nicole@x.com', added_by: 'max@x.com', added_at: '2026-09-02 10:00:00' }
const base = { owner: 'max@x.com', members: [nicole], identity: 'max@x.com', here: new Set<string>() }
const shape = (rows: ReturnType<typeof householdRows>) =>
  rows.map((p) => [p.email, p.role, p.passkeys.map((c) => `${c.wrap.credentialId}:${c.binding}`)])

describe('the household panel: people and whose passkey is whose', () => {
  it('ties passkeys to people by the identity each wrapping names, never by label', () => {
    const rows = householdRows({
      ...base,
      wraps: [
        wrap('a', 'Max’s Mac', 'max@x.com'),
        wrap('b', 'nicole@x.com', 'max@x.com'), // labelled with her email, but it's Max's: identity wins
        wrap('c', 'Nicole’s iPhone', 'nicole@x.com'), // renamed: still hers
      ],
    })
    expect(shape(rows)).toEqual([
      ['max@x.com', 'owner', ['a:identity', 'b:identity']],
      ['nicole@x.com', 'member', ['c:identity']],
    ])
    expect(rows[1]).toMatchObject({ addedBy: 'max@x.com', addedAt: '2026-09-02 10:00:00', me: false })
    expect(rows[0]!.me).toBe(true)
  })

  it('the invited: their own row between members and former members, with whoever sent the invitation — and their passkey, if one was added', () => {
    const rows = householdRows({
      ...base,
      invites: [
        { email: 'Aaron@x.com', invited_by: 'nicole@x.com', invited_at: '2026-09-22 09:00:00' },
        { email: 'nicole@x.com', invited_by: 'max@x.com', invited_at: '2026-09-01 09:00:00' }, // a stale row for a member: she is a member
        { email: 'kid@x.com', invited_by: 'max@x.com', invited_at: '2026-09-23 09:00:00' },
      ],
      wraps: [
        wrap('a', 'Max’s Mac', 'max@x.com'),
        wrap('dd', 'Aaron’s phone', 'aaron@x.com'), // added before he answered
        wrap('ccc', 'aaron@x.com'), // a label that is an invitee's email binds nobody: labels predate invitations
        wrap('eeee', 'Zed’s', 'zed@x.com'),
      ],
    })
    expect(shape(rows)).toEqual([
      ['max@x.com', 'owner', ['a:identity', 'ccc:default']],
      ['nicole@x.com', 'member', []],
      ['aaron@x.com', 'invited', ['dd:identity']],
      ['kid@x.com', 'invited', []],
      ['zed@x.com', 'former', ['eeee:identity']],
    ])
    expect(rows[2]).toMatchObject({ addedBy: 'nicole@x.com', addedAt: '2026-09-22 09:00:00', me: false })
    expect(passkeysOf(rows, 'aaron@x.com')).toEqual(['dd'])
  })

  it('two passkeys with the same label are still two passkeys of two people (the old object-identity bug)', () => {
    const rows = householdRows({ ...base, wraps: [wrap('a', 'iPhone', 'max@x.com'), wrap('bb', 'iPhone', 'nicole@x.com')] })
    expect(passkeysOf(rows, 'max@x.com')).toEqual(['a'])
    expect(passkeysOf(rows, 'NICOLE@x.com')).toEqual(['bb'])
    expect(ownerOfPasskey(rows, 'bb')?.email).toBe('nicole@x.com')
    expect(ownerOfPasskey(rows, 'zz')).toBeNull()
  })

  it('wrappings from before identities: a member’s email as the label is theirs, anything else the owner’s', () => {
    const rows = householdRows({
      ...base,
      wraps: [wrap('a', 'Max’s Mac'), wrap('b', ' Nicole@X.com '), wrap('c', 'max@x.com'), wrap('d', 'someone@else.com')],
    })
    expect(shape(rows)).toEqual([
      ['max@x.com', 'owner', ['a:default', 'c:default', 'd:default']],
      ['nicole@x.com', 'member', ['b:label']],
    ])
  })

  it('passkeys naming someone no longer in the household show as a former member’s, not the owner’s', () => {
    const rows = householdRows({
      ...base,
      members: [],
      wraps: [wrap('a', 'Max’s Mac', 'max@x.com'), wrap('b', 'Her phone', 'nicole@x.com'), wrap('c', 'Tablet', 'aaron@x.com')],
    })
    expect(shape(rows)).toEqual([
      ['max@x.com', 'owner', ['a:identity']],
      ['aaron@x.com', 'former', ['c:identity']],
      ['nicole@x.com', 'former', ['b:identity']],
    ])
    // A legacy label that names a removed member reads as the owner's: nothing vouches for it any more.
    expect(shape(householdRows({ ...base, members: [], wraps: [wrap('b', 'nicole@x.com')] }))).toEqual([['max@x.com', 'owner', ['b:default']]])
  })

  it('everyone in the household has a row, with or without passkeys; members keep the server’s order', () => {
    const aaron: MemberRow = { email: 'Aaron@x.com', added_by: 'max@x.com', added_at: '2026-09-05 10:00:00' }
    const rows = householdRows({ ...base, members: [nicole, aaron], wraps: [wrap('a', 'Mac', 'max@x.com')] })
    expect(shape(rows)).toEqual([
      ['max@x.com', 'owner', ['a:identity']],
      ['nicole@x.com', 'member', []],
      ['aaron@x.com', 'member', []],
    ])
    // A member who is signed in sees themselves as "me"; the owner has no added-by.
    const hers = householdRows({ ...base, identity: 'Nicole@x.com', wraps: [] })
    expect(hers.map((p) => [p.email, p.me, p.addedBy])).toEqual([
      ['max@x.com', false, null],
      ['nicole@x.com', true, 'max@x.com'],
    ])
  })

  it('marks this device’s passkeys and the one that unlocked this session, by credential id; sorts each person’s by date', () => {
    const rows = householdRows({
      ...base,
      here: new Set(['b']),
      unlockedWith: 'c',
      wraps: [wrap('b', 'Later', 'max@x.com', '2026-09-09T00:00:00Z'), wrap('c', 'Earlier', 'max@x.com', '2026-09-01T00:00:00Z')],
    })
    expect(rows[0]!.passkeys.map((c) => [c.wrap.label, c.here, c.unlockedThis])).toEqual([
      ['Earlier', false, true],
      ['Later', true, false],
    ])
  })
})
