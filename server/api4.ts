import { createHash } from 'node:crypto'
import { Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { DbLike } from '../engine/db'
import { dumpDb, loadDump, TABLES, type Dump } from '../engine/snapshot'
import { readabilityError } from '../engine/upgrades'
import { db, schemaVersion } from './db'
import { restoreRefusal } from './http'

/**
 * The vault layer: opaque ciphertext storage plus whole-database
 * export/import. The server never sees vault keys — blobs are encrypted
 * client-side (shared/vault.ts) before they arrive.
 *
 * One blob per household. A blob is keyed by the identity that created it;
 * household_members maps other identities onto it, so a partner fetches and
 * saves the same ciphertext. Nobody becomes a member without saying so: a
 * household invites (vault_invites), and the invitee accepts on their own
 * device.
 */
export const api4 = new Hono<{ Variables: { userEmail: string } }>()

const MAX_BLOB_BYTES = 10 * 1024 * 1024

/* ---------- request body caps ---------- */

const KB = 1024
const MB = 1024 * KB
export const BODY_LIMITS = {
  /** Vault-only server, PUT /api/vault: the base64 blob (≤ 14MB for a 10MB payload) plus its JSON envelope. */
  zkVault: 15 * MB,
  /** Vault-only server, everything else: member emails and empty POSTs. */
  zk: 64 * KB,
  /** Household server, everything but a restore: whole statements (POST /api/imports) are the largest. */
  household: 20 * MB,
  /**
   * Household server, POST /api/import: the whole database, as GET /api/export wrote it. It grows with the
   * household — mostly prices_daily, every charted holding's full daily history at ~60 bytes a row — so it
   * must never be what refuses a household its own backup. Cloud Run's HTTP/1 front end already refuses
   * request bodies over 32 MiB before they reach the container; this is twice that — a guard against a
   * runaway body on the 512 MiB instance, not a size a real dump is meant to meet.
   */
  householdRestore: 64 * MB,
} as const

/**
 * Caps every /api request body before a handler reads it (413 past the cap).
 * On a vault-only server nothing but the vault blob is ever large, so
 * everything else gets a small cap.
 */
export function bodyLimits(opts: { zkOnly: boolean }): MiddlewareHandler {
  const onError: Parameters<typeof bodyLimit>[0]['onError'] = (c) => c.json({ error: 'request body too large' }, 413)
  const vault = bodyLimit({ maxSize: BODY_LIMITS.zkVault, onError })
  const small = bodyLimit({ maxSize: BODY_LIMITS.zk, onError })
  const household = bodyLimit({ maxSize: BODY_LIMITS.household, onError })
  const restore = bodyLimit({ maxSize: BODY_LIMITS.householdRestore, onError })
  return (c, next) => {
    if (!opts.zkOnly) return (c.req.method === 'POST' && c.req.path === '/api/import' ? restore : household)(c, next)
    return (c.req.method === 'PUT' && c.req.path === '/api/vault' ? vault : small)(c, next)
  }
}

/**
 * The vault_blobs key this identity reads and writes: its own, unless it was added to someone's household.
 * Membership rows store the member's email lowercased (POST /vault/members and accept normalise it), so the
 * lookup is too — an identity IAP reports in another letter case is still the member it is.
 */
export function householdOf(d: DbLike, email: string): string {
  const m = d.prepare('SELECT household FROM household_members WHERE email = ?').get(email.toLowerCase()) as { household: string } | undefined
  return m?.household ?? email
}

/* ---------- version history: which replaced blobs the courier keeps ---------- */

/**
 * Why a replaced version is kept past the ordinary rules. A save names it for
 * the blob it replaces: the copy a tier-C snapshot upgrade is about to
 * rewrite, or the version a restore is about to put something else over.
 */
export const HISTORY_PINS = ['pre-upgrade', 'pre-restore'] as const
export type HistoryPin = (typeof HISTORY_PINS)[number]
const isPin = (p: unknown): p is HistoryPin => typeof p === 'string' && (HISTORY_PINS as readonly string[]).includes(p)

export type HistoryPolicy = { keepLast: number; dailyDays: number; maxPins: number; byteCap: number }

/**
 * What a household's history keeps: the last 20 replaced versions, the last
 * one of each day for 30 days, and the 8 newest pinned ones — and never more
 * than 64 MB of ciphertext in all. Over the cap the oldest go first, unpinned
 * before pinned; the most recent is always kept.
 */
export const HISTORY_POLICY: HistoryPolicy = { keepLast: 20, dailyDays: 30, maxPins: 8, byteCap: 64 * MB }

export type HistoryMeta = { version: number; size: number; updated_at: string; pin: string | null }

/** SQLite's datetime('now') ('2026-09-23 14:02:11', UTC) or ISO-8601 → epoch ms; null when unreadable. */
function utcMs(s: string): number | null {
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`)
  return Number.isNaN(t) ? null : t
}

/** The versions of a household's history that the policy drops, given `now` (epoch ms). Pure. */
export function historyToDrop(rows: readonly HistoryMeta[], now: number, policy: HistoryPolicy = HISTORY_POLICY): number[] {
  const newestFirst = [...rows].sort((a, b) => b.version - a.version)
  const keep = new Set<number>(newestFirst.slice(0, policy.keepLast).map((r) => r.version))
  const since = now - policy.dailyDays * 86_400_000
  const days = new Set<string>()
  for (const r of newestFirst) {
    const t = utcMs(r.updated_at)
    if (t === null || t < since) continue
    const day = new Date(t).toISOString().slice(0, 10)
    if (days.has(day)) continue // an earlier version of a day already represented
    days.add(day)
    keep.add(r.version)
  }
  const pinned = new Set(newestFirst.filter((r) => r.pin !== null).slice(0, policy.maxPins).map((r) => r.version))
  for (const v of pinned) keep.add(v)
  let bytes = newestFirst.reduce((n, r) => n + (keep.has(r.version) ? r.size : 0), 0)
  if (bytes > policy.byteCap) {
    const newest = newestFirst[0]?.version
    const evictable = newestFirst
      .filter((r) => keep.has(r.version) && r.version !== newest)
      .sort((a, b) => Number(pinned.has(a.version)) - Number(pinned.has(b.version)) || a.version - b.version)
    for (const r of evictable) {
      if (bytes <= policy.byteCap) break
      keep.delete(r.version)
      bytes -= r.size
    }
  }
  return newestFirst.filter((r) => !keep.has(r.version)).map((r) => r.version)
}

/** Apply the policy to one household's history (inside the save's transaction). */
function pruneHistory(household: string): void {
  const rows = db.prepare('SELECT version, size, updated_at, pin FROM vault_history WHERE owner_email = ?').all(household) as HistoryMeta[]
  const drop = db.prepare('DELETE FROM vault_history WHERE owner_email = ? AND version = ?')
  for (const v of historyToDrop(rows, Date.now())) drop.run(household, v)
}

/* ---------- encrypted vault blobs ---------- */

/**
 * The stored blob. `updated_by` is the identity that uploaded this version
 * (IAP's, recorded by PUT; null for versions stored before it was kept) — a
 * household member's tab shows "saved by …" from it. `keepsHistory`:
 * replaced versions are kept (GET /vault/history), so a tab may offer "keep
 * mine" over another member's version.
 */
api4.get('/vault', (c) => {
  const row = db
    .prepare('SELECT version, sha256, size, data, updated_at, updated_by FROM vault_blobs WHERE owner_email = ?')
    .get(householdOf(db as unknown as DbLike, c.get('userEmail'))) as
    | { version: number; sha256: string; size: number; data: string; updated_at: string; updated_by: string | null }
    | undefined
  if (!row) return c.json({ error: 'no vault yet' }, 404)
  return c.json({ ...row, keepsHistory: true })
})

/**
 * Store the next version. The blob it replaces moves into vault_history
 * (still ciphertext), kept by HISTORY_POLICY; `pin` ('pre-upgrade' |
 * 'pre-restore') marks that outgoing blob as one to keep longer.
 *
 * `purgeHistory: true` (a re-key: rotation, or a member removed) instead
 * drops every earlier version the server keeps for this household, because
 * they are sealed under the key being retired, which whoever is losing
 * access still holds. The outgoing blob is not kept either (a pin is moot).
 * Any identity that may save may ask: each already holds the key, and can
 * re-key the vault anyway.
 */
api4.put('/vault', async (c) => {
  const b = await c.req.json<{ data?: string; version?: number; baseSha256?: unknown; purgeHistory?: unknown; pin?: unknown }>()
  if (typeof b.data !== 'string' || !Number.isSafeInteger(b.version))
    return c.json({ error: 'data (string) and version (current version, 0 to create) required' }, 400)
  if (b.baseSha256 !== undefined && (typeof b.baseSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.baseSha256)))
    return c.json({ error: 'baseSha256, when sent, is the hex SHA-256 of the stored version this replaces' }, 400)
  if (b.purgeHistory !== undefined && typeof b.purgeHistory !== 'boolean')
    return c.json({ error: 'purgeHistory, when sent, is true or false' }, 400)
  if (b.pin !== undefined && b.pin !== null && !isPin(b.pin))
    return c.json({ error: `pin, when sent, is one of ${HISTORY_PINS.join(', ')}` }, 400)
  if (b.data.length > MAX_BLOB_BYTES * 1.4) return c.json({ error: 'vault blob exceeds 10MB' }, 413)
  const email = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const current = db.prepare('SELECT version, sha256 FROM vault_blobs WHERE owner_email = ?').get(email) as
    | { version: number; sha256: string }
    | undefined
  // Version 0 means "create": refused whenever a vault exists, so creating can never overwrite one.
  // baseSha256 names the blob the upload replaces: a vault deleted and created again (or restored)
  // at the same version number is a different blob, and is never overwritten by a tab of the old one.
  // serverSha256 lets a client whose last upload got no response recognise that it did land.
  const replaced = current !== undefined && typeof b.baseSha256 === 'string' && b.baseSha256 !== current.sha256
  if ((current?.version ?? 0) !== b.version || replaced)
    return c.json(
      {
        error:
          (current?.version ?? 0) !== b.version
            ? `version conflict: server has ${current?.version ?? 0}, you sent ${b.version}`
            : `version conflict: the stored v${b.version} is not the one this upload replaces (the vault was replaced)`,
        serverVersion: current?.version ?? 0,
        serverSha256: current?.sha256 ?? null,
      },
      409,
    )
  const sha = createHash('sha256').update(b.data).digest('hex')
  // updated_by is the caller — not the household key — so a member's save
  // reads as theirs. The server already knows it (IAP); storing it lets the
  // other member's tab say who saved (migration 20).
  const { data, version } = { data: b.data, version: b.version as number }
  const pin = isPin(b.pin) ? b.pin : null
  db.transaction(() => {
    if (b.purgeHistory === true) {
      db.prepare('DELETE FROM vault_history WHERE owner_email = ?').run(email)
    } else if (current) {
      // A one-step previous blob left by a save from before vault_history
      // existed (migration 17's prev_*) joins the history once…
      db.prepare(
        `INSERT OR IGNORE INTO vault_history (owner_email, version, sha256, size, data, updated_at)
         SELECT owner_email, prev_version, prev_sha256, prev_size, prev_data, prev_updated_at
         FROM vault_blobs WHERE owner_email = ? AND prev_data IS NOT NULL AND prev_version IS NOT NULL`,
      ).run(email)
      // …and the blob being replaced moves into it, as stored (and who stored it), with its pin.
      db.prepare(
        `INSERT OR REPLACE INTO vault_history (owner_email, version, sha256, size, data, updated_at, updated_by, pin)
         SELECT owner_email, version, sha256, size, data, updated_at, updated_by, ? FROM vault_blobs WHERE owner_email = ?`,
      ).run(pin, email)
    }
    // prev_* is superseded by vault_history: cleared, so no blob is stored twice.
    db.prepare(
      `INSERT INTO vault_blobs (owner_email, version, sha256, size, data, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT (owner_email) DO UPDATE SET
         version = excluded.version, sha256 = excluded.sha256, size = excluded.size,
         data = excluded.data, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
         prev_version = NULL, prev_sha256 = NULL, prev_size = NULL, prev_data = NULL, prev_updated_at = NULL`,
    ).run(email, version + 1, sha, data.length, data, c.get('userEmail'))
    if (b.purgeHistory !== true) pruneHistory(email)
  })()
  return c.json({ ok: true, version: b.version + 1, sha256: sha })
})

/**
 * The versions this household's history keeps (newest first): metadata only
 * — version, the ciphertext's hash and size, when and by whom it was stored,
 * and its pin. What the server already knew when each was saved; nothing it
 * can read. `bytes` is their total size, `policy` what is kept.
 */
api4.get('/vault/history', (c) => {
  const household = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const entries = db
    .prepare('SELECT version, sha256, size, updated_at, updated_by, pin FROM vault_history WHERE owner_email = ? ORDER BY version DESC')
    .all(household) as { version: number; sha256: string; size: number; updated_at: string; updated_by: string | null; pin: string | null }[]
  return c.json({ entries, bytes: entries.reduce((n, e) => n + e.size, 0), policy: HISTORY_POLICY })
})

/** One kept version's blob, for the household's tab to open with its key (preview, restore). */
api4.get('/vault/history/:version', (c) => {
  const raw = c.req.param('version')
  const version = /^[0-9]{1,15}$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(version)) return c.json({ error: 'version must be a whole number' }, 400)
  const row = db
    .prepare('SELECT version, sha256, size, data, updated_at, updated_by, pin FROM vault_history WHERE owner_email = ? AND version = ?')
    .get(householdOf(db as unknown as DbLike, c.get('userEmail')), version)
  if (!row) return c.json({ error: `v${version} is not in this vault’s history` }, 404)
  return c.json(row)
})

/**
 * Delete this household's vault: the blob, its history, its members and its
 * invites — everything the courier keeps for it, all ciphertext or routing.
 * Only the household's own key may (the identity that created it; a member
 * has a household_members row and gets 403 — a member leaves instead). The
 * body must say `{confirm: 'DELETE'}`; with `version`, the delete is refused
 * (409) unless that is still the stored version, so a confirmation given for
 * v42 can't delete a v43 someone saved since.
 */
api4.delete('/vault', async (c) => {
  const me = c.get('userEmail')
  if (householdOf(db as unknown as DbLike, me) !== me)
    return c.json({ error: 'only the household’s owner can delete its vault; a member can leave the household instead' }, 403)
  const b = (await c.req.json().catch(() => ({}))) as { confirm?: unknown; version?: unknown }
  if (b.confirm !== 'DELETE')
    return c.json({ error: 'this deletes the vault for everyone who shares it — resend with confirm: "DELETE"' }, 400)
  const current = db.prepare('SELECT version FROM vault_blobs WHERE owner_email = ?').get(me) as { version: number } | undefined
  if (b.version !== undefined && (current?.version ?? 0) !== b.version)
    return c.json({ error: `the vault is at v${current?.version ?? 0}, not v${String(b.version)} — nothing was deleted`, serverVersion: current?.version ?? 0 }, 409)
  const deleted = db.transaction(() => ({
    blob: db.prepare('DELETE FROM vault_blobs WHERE owner_email = ?').run(me).changes,
    history: db.prepare('DELETE FROM vault_history WHERE owner_email = ?').run(me).changes,
    members: db.prepare('DELETE FROM household_members WHERE household = ?').run(me).changes,
    invites: db.prepare('DELETE FROM vault_invites WHERE household = ?').run(me).changes,
  }))()
  if (Object.values(deleted).every((n) => n === 0)) return c.json({ error: 'no vault to delete' }, 404)
  return c.json({ ok: true, deleted })
})

/* ---------- household members, by invitation ---------- */

export type Member = { email: string; added_by: string; added_at: string }
/** An invitation this household sent that is waiting on the invitee's say-so. */
export type PendingInvite = { email: string; invited_by: string; invited_at: string }
/** An invitation waiting for the caller: whose household, who sent it, when. */
export type Invite = { household: string; invited_by: string; invited_at: string }

const normalizeEmail = (e: unknown) => (typeof e === 'string' ? e.trim().toLowerCase() : '')

/** The invitations waiting for this identity — their own, never anyone else's (for /api/mode). */
export function invitesFor(d: DbLike, email: string): Invite[] {
  return d
    .prepare('SELECT household, invited_by, invited_at FROM vault_invites WHERE email = ? ORDER BY invited_at, household')
    .all(email.toLowerCase()) as Invite[]
}

/**
 * Everyone who unlocks this vault — the identity that created it plus every
 * member row pointing at it — and the invitations it has out that nobody has
 * answered yet (the household's own; nothing about anyone else's).
 */
api4.get('/vault/members', (c) => {
  const household = householdOf(db as unknown as DbLike, c.get('userEmail'))
  const members = db
    .prepare('SELECT email, added_by, added_at FROM household_members WHERE household = ? ORDER BY added_at')
    .all(household) as Member[]
  const invites = db
    .prepare('SELECT email, invited_by, invited_at FROM vault_invites WHERE household = ? ORDER BY invited_at, email')
    .all(household) as PendingInvite[]
  return c.json({ household, members, invites })
})

/** The one answer an invitation gets, whoever it names (see POST /vault/members). */
const INVITED = { ok: true } as const

/**
 * Invite an identity into this household. Nobody is added: the server records
 * an invitation, and only the invitee accepting it on their own device
 * (POST /vault/invites/accept) makes them a member — householdOf ignores
 * invitations. The answer is always `200 {ok: true}`: an unknown email, one
 * that owns a vault, one in another household and one already in this
 * household all read the same, so this can't be used to learn who uses
 * Scarab. (Bad input and the caller's own situation — inviting yourself, or a
 * household with no vault to share — are the only refusals; they are about
 * the caller.)
 *
 * Each household's invitation waits on its own (migration 21: one per
 * email and household): another household inviting the same person neither
 * replaces it nor shows in this household's list, and the invitee sees every
 * one, with who sent each. Inviting again just re-stamps this household's.
 */
api4.post('/vault/members', async (c) => {
  const me = c.get('userEmail')
  const household = householdOf(db as unknown as DbLike, me)
  const email = normalizeEmail(((await c.req.json().catch(() => ({}))) as { email?: unknown }).email)
  if (!email.includes('@') || email.length > 254) return c.json({ error: 'email required — the Google account they sign in with' }, 400)
  if (email === me.toLowerCase() || email === household.toLowerCase()) return c.json({ error: 'that identity already unlocks this vault' }, 400)
  if (!db.prepare('SELECT 1 FROM vault_blobs WHERE owner_email = ?').get(household))
    return c.json({ error: 'there is no vault to share yet — create it first' }, 409)
  const member = db.prepare('SELECT household FROM household_members WHERE email = ?').get(email) as { household: string } | undefined
  if (member?.household !== household)
    // Stamped to the millisecond (SQLite's own format, UTC): a household's tab tells the passkeys it added while
    // someone was only invited from older ones of theirs by comparing with this (session.addedWhileInvited).
    db.prepare(
      `INSERT INTO vault_invites (email, household, invited_by, invited_at) VALUES (?, ?, ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
       ON CONFLICT (email, household) DO UPDATE SET invited_by = excluded.invited_by, invited_at = excluded.invited_at`,
    ).run(email, household, me)
  return c.json(INVITED)
})

/**
 * Remove a member: only the household's owner (the identity that created the
 * vault) may remove someone, and a member may remove themselves (leave).
 * This only cuts them off from the ciphertext; they still know the key, so
 * the client re-keys the vault right after (rotation, with purgeHistory).
 *
 * `?pending=1` withdraws a waiting invitation instead, and never touches a
 * membership (someone who accepted meanwhile stays in — taking them out is a
 * re-key, which the client decides on). The owner may withdraw any of the
 * household's invitations; a member only the ones they sent.
 */
api4.delete('/vault/members/:email', (c) => {
  const me = c.get('userEmail')
  const household = householdOf(db as unknown as DbLike, me)
  const email = normalizeEmail(c.req.param('email'))
  if (c.req.query('pending') === '1') {
    const inv = db.prepare('SELECT invited_by FROM vault_invites WHERE email = ? AND household = ?').get(email, household) as
      | { invited_by: string }
      | undefined
    if (!inv) return c.json({ error: `no invitation for ${email} from this household is waiting` }, 404)
    if (me !== household && inv.invited_by !== me)
      return c.json({ error: 'only the household’s owner, or whoever sent it, can withdraw an invitation' }, 403)
    db.prepare('DELETE FROM vault_invites WHERE email = ? AND household = ?').run(email, household)
    return c.json({ ok: true })
  }
  if (me !== household && email !== me.toLowerCase())
    return c.json({ error: 'only the household’s owner can remove a member; you can remove only yourself' }, 403)
  const r = db.prepare('DELETE FROM household_members WHERE email = ? AND household = ?').run(email, household)
  if (r.changes === 0) return c.json({ error: `${email} is not a member of this household` }, 404)
  return c.json({ ok: true })
})

/**
 * Accept an invitation: the caller joins `household`, which must be one of
 * the households with an invitation waiting for them (so one withdrawn after
 * it was shown can't be accepted anyway). Joining ends whatever the caller
 * had: their own vault — deleted with its history, members and invitations,
 * as DELETE /api/vault would — or their membership of another household.
 * Either needs `replaceOwn: true`, and `version`, when sent, must still be
 * their vault's version (a confirmation given for v4 can't delete a v5).
 * Without it the answer is 409 with `code` 'own-vault' or 'other-household' —
 * the caller's own situation, nothing about anyone else. Only the invitation
 * accepted is used up: another household's stays waiting for its own answer
 * (the front door still offers it, to decline or to switch to later).
 */
api4.post('/vault/invites/accept', async (c) => {
  const me = c.get('userEmail')
  const self = me.toLowerCase()
  const b = (await c.req.json().catch(() => ({}))) as { household?: unknown; replaceOwn?: unknown; version?: unknown }
  const named = normalizeEmail(b.household)
  if (!named) return c.json({ error: 'household (the email of the vault’s owner) required' }, 400)
  if (b.replaceOwn !== undefined && typeof b.replaceOwn !== 'boolean') return c.json({ error: 'replaceOwn, when sent, is true or false' }, 400)
  if (b.version !== undefined && !Number.isSafeInteger(b.version)) return c.json({ error: 'version, when sent, is your vault’s version' }, 400)
  // The household key is stored as the owner's identity was reported (vault_blobs.owner_email); match it in any case,
  // then use it exactly as stored, so the membership points at that vault.
  const invite = db.prepare('SELECT household, invited_by FROM vault_invites WHERE email = ? AND lower(household) = ?').get(self, named) as
    | { household: string; invited_by: string }
    | undefined
  if (!invite) return c.json({ error: `no invitation from ${named} is waiting for you` }, 404)
  const household = invite.household
  if (!db.prepare('SELECT 1 FROM vault_blobs WHERE owner_email = ?').get(household)) {
    db.prepare('DELETE FROM vault_invites WHERE email = ? AND household = ?').run(self, household)
    return c.json({ error: `${household} no longer has a vault to share — the invitation is void`, code: 'no-vault' }, 409)
  }
  const current = db.prepare('SELECT household FROM household_members WHERE email = ?').get(self) as { household: string } | undefined
  if (current?.household === household) {
    db.prepare('DELETE FROM vault_invites WHERE email = ? AND household = ?').run(self, household)
    return c.json({ ok: true, household })
  }
  const own = db.prepare('SELECT version FROM vault_blobs WHERE owner_email = ?').get(me) as { version: number } | undefined
  if (own && b.replaceOwn !== true)
    return c.json({ error: `joining deletes your own vault (v${own.version}) — resend with replaceOwn: true`, code: 'own-vault', version: own.version }, 409)
  if (current && b.replaceOwn !== true)
    return c.json({ error: `joining takes you out of ${current.household}’s household — resend with replaceOwn: true`, code: 'other-household', household: current.household }, 409)
  if (own && b.version !== undefined && own.version !== b.version)
    return c.json({ error: `your vault is at v${own.version}, not v${String(b.version)} — nothing changed`, code: 'own-vault', version: own.version }, 409)
  db.transaction(() => {
    // Whatever the caller was the household key of goes, as DELETE /api/vault would take it.
    db.prepare('DELETE FROM vault_blobs WHERE owner_email = ?').run(me)
    db.prepare('DELETE FROM vault_history WHERE owner_email = ?').run(me)
    db.prepare('DELETE FROM household_members WHERE household = ?').run(me)
    db.prepare('DELETE FROM vault_invites WHERE household = ?').run(me)
    // …and any other household they were in. Then they are in this one, by the invitation they accepted.
    db.prepare('DELETE FROM household_members WHERE email = ?').run(self)
    db.prepare('INSERT INTO household_members (email, household, added_by) VALUES (?, ?, ?)').run(self, household, invite.invited_by)
    db.prepare('DELETE FROM vault_invites WHERE email = ? AND household = ?').run(self, household)
  })()
  return c.json({ ok: true, household })
})

/** Decline an invitation from `household`: it is gone. The same answer whether or not one was waiting (it is the caller's own). */
api4.delete('/vault/invites/:household', (c) => {
  db.prepare('DELETE FROM vault_invites WHERE email = ? AND lower(household) = ?').run(c.get('userEmail').toLowerCase(), normalizeEmail(c.req.param('household')))
  return c.json({ ok: true })
})

/* ---------- whole-database export / import ---------- */

api4.get('/export', (c) => c.json(dumpDb(db as unknown as DbLike)))

api4.post('/import', async (c) => {
  const b = (await c.req.json()) as Dump & { confirm?: string }
  if (!b.scarab || !b.tables) return c.json({ error: 'not a Scarab export' }, 400)
  const why = readabilityError(b.schemaVersion)
  if (why) return c.json({ error: why }, 400)
  if (b.confirm !== 'REPLACE')
    return c.json({ error: 'this REPLACES every row of data — resend with confirm: "REPLACE"' }, 400)
  let loaded: ReturnType<typeof loadDump>
  try {
    loaded = loadDump(db as unknown as DbLike, b)
  } catch (e) {
    // A file loadDump can't take is the file's fault, and nothing was written: say why, as a tab would.
    const refusal = restoreRefusal(e)
    if (refusal === null) throw e
    return c.json({ error: refusal }, 400)
  }
  const counts = Object.fromEntries(
    TABLES.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
  )
  return c.json({ ok: true, restored: counts, schemaVersion, loadedFrom: loaded.from, upgraded: loaded.upgraded })
})
