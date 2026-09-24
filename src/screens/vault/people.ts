import type { PasskeyWrap } from '../../../shared/vault'

/**
 * Who is in the household, and whose passkey is whose — pure, for the
 * household panel and its test.
 *
 * People come from the server: the owner is the household key (the identity
 * that created the vault), members are its household_members rows, and the
 * invited are invitations nobody has answered yet (vault_invites) — a passkey
 * may already be on the vault for them, opening it once they accept.
 * Passkeys come from the vault header and are tied to people by the
 * `identity` each wrapping names (authenticated with the header), keyed by
 * credential id — never by label, which is free text and renamable.
 *
 * Wrappings from before identities existed have none. For those only, a
 * label that is a member's email (how members' passkeys used to be labelled)
 * reads as theirs, and anything else as the owner's.
 */

export type MemberRow = { email: string; added_by: string; added_at: string }
export type InviteRow = { email: string; invited_by: string; invited_at: string }

/** How a passkey was tied to its person: the wrapping's own identity, or (older wrappings) its label or the owner default. */
export type Binding = 'identity' | 'label' | 'default'

export type PasskeyChip = {
  wrap: PasskeyWrap
  binding: Binding
  /** This device's own authenticator made or answered with it. */
  here: boolean
  /** The passkey this session was unlocked with. */
  unlockedThis: boolean
}

export type Person = {
  email: string
  /**
   * invited: asked in, hasn't answered (the server doesn't serve them the vault yet).
   * former: named by passkeys still on the vault, but no longer in the household (their re-key is owed).
   */
  role: 'owner' | 'member' | 'invited' | 'former'
  /** Who added them (a member) or invited them (invited), and when. */
  addedBy: string | null
  addedAt: string | null
  /** The signed-in identity. */
  me: boolean
  passkeys: PasskeyChip[]
}

const norm = (e: string) => e.trim().toLowerCase()

export function householdRows(o: {
  owner: string
  members: readonly MemberRow[]
  invites?: readonly InviteRow[]
  wraps: readonly PasskeyWrap[]
  identity: string | null
  here: ReadonlySet<string>
  unlockedWith?: string | null
}): Person[] {
  const owner = norm(o.owner)
  const me = o.identity ? norm(o.identity) : null
  const people = new Map<string, Person>()
  const person = (email: string, role: Person['role'], addedBy: string | null = null, addedAt: string | null = null): Person => {
    let p = people.get(email)
    if (!p) {
      p = { email, role, addedBy, addedAt, me: email === me, passkeys: [] }
      people.set(email, p)
    }
    return p
  }
  person(owner, 'owner')
  for (const m of o.members) {
    const email = norm(m.email)
    if (email !== owner) person(email, 'member', m.added_by, m.added_at)
  }
  // Legacy label matching (below) is for members only: labels predate invitations.
  const inHousehold = new Set(people.keys())
  for (const i of o.invites ?? []) {
    const email = norm(i.email)
    if (!people.has(email)) person(email, 'invited', i.invited_by, i.invited_at)
  }

  for (const wrap of o.wraps) {
    let email: string
    let binding: Binding
    if (wrap.identity !== undefined) {
      email = norm(wrap.identity)
      binding = 'identity'
    } else if (inHousehold.has(norm(wrap.label)) && norm(wrap.label) !== owner) {
      email = norm(wrap.label)
      binding = 'label'
    } else {
      email = owner
      binding = 'default'
    }
    const p = people.get(email) ?? person(email, 'former')
    p.passkeys.push({ wrap, binding, here: o.here.has(wrap.credentialId), unlockedThis: o.unlockedWith === wrap.credentialId })
  }

  const rank = { owner: 0, member: 1, invited: 2, former: 3 } as const
  const rows = [...people.values()]
  for (const p of rows) p.passkeys.sort((a, b) => (a.wrap.addedAt < b.wrap.addedAt ? -1 : a.wrap.addedAt > b.wrap.addedAt ? 1 : 0))
  // Owner, then members in the order they joined (the server's order), the invited (in the server's order), then former members by email.
  return rows.sort((a, b) => rank[a.role] - rank[b.role] || (a.role === 'former' ? a.email.localeCompare(b.email) : 0))
}

/** The credential ids of `email`'s passkeys, as the panel ties them (what a re-key must not let answer). */
export function passkeysOf(rows: readonly Person[], email: string): string[] {
  return rows.find((p) => p.email === norm(email))?.passkeys.map((c) => c.wrap.credentialId) ?? []
}

/** The person a passkey belongs to, by credential id. */
export function ownerOfPasskey(rows: readonly Person[], credentialId: string): Person | null {
  return rows.find((p) => p.passkeys.some((c) => c.wrap.credentialId === credentialId)) ?? null
}
