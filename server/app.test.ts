import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

let db: DbLike
let mod: typeof import('./app')
let api4: typeof import('./api4')
beforeAll(async () => {
  mod = await import('./app')
  api4 = await import('./api4')
  db = (await import('./db')).db as unknown as DbLike
})

const wipe = () => {
  for (const t of ['accounts', 'vault_blobs', 'vault_history', 'vault_invites', 'household_members', 'app_meta', 'basket_quotes'])
    db.prepare(`DELETE FROM ${t}`).run()
}
const as = (email: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers as Record<string, string>), 'x-goog-authenticated-user-email': `accounts.google.com:${email}` },
})
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n
/** `member` joins `owner`'s household the only way there is: an invitation, then their own acceptance. */
async function join(app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }, owner: string, member: string) {
  expect((await app.request('/api/vault/members', as(owner, json({ email: member })))).status).toBe(200)
  expect((await app.request('/api/vault/invites/accept', as(member, json({ household: owner })))).status).toBe(200)
}

describe('zero-knowledge-only server', () => {
  it('answers only the courier, basket, identity and mode routes; refuses every plaintext route', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const allowed = ['/api/me', '/api/health', '/api/mode', '/api/basket/status']
    for (const p of allowed) expect((await app.request(p)).status, p).toBe(200)
    expect((await app.request('/api/vault')).status).toBe(404) // no blob yet, but the route answers
    const mode = (await (await app.request('/api/mode')).json()) as { zkOnly: boolean; serverHasData: boolean }
    expect(mode).toMatchObject({ zkOnly: true, serverHasData: false })

    const put = await app.request('/api/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data: '{"v":1}', version: 0 }),
    })
    expect(put.status).toBe(200)

    for (const [method, p, body] of [
      ['GET', '/api/accounts', undefined],
      ['POST', '/api/accounts', '{"name":"Checking","kind":"checking"}'],
      ['GET', '/api/export', undefined],
      ['POST', '/api/import', '{}'],
      ['GET', '/api/transactions', undefined],
      ['POST', '/api/prices/refresh', '{}'],
      ['GET', '/api/basket/../export', undefined],
    ] as const) {
      const r = await app.request(p, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body })
      expect(r.status, `${method} ${p}`).toBe(403)
    }
    expect(count('accounts')).toBe(0)
  })

  it('a household member reads and writes the same blob — once invited, and only after accepting', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    expect((await app.request('/api/vault/members', as('a@x'))).status).toBe(200)
    await app.request('/api/vault', as('a@x', json({ data: '{"v":2}', version: 0 }, 'PUT')))
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404) // not a member yet

    // Bad invitations: no email, self. (Everything else reads the same — see the uniform-answer test.)
    expect((await app.request('/api/vault/members', as('a@x', json({})))).status).toBe(400)
    expect((await app.request('/api/vault/members', as('a@x', json({ email: 'A@x' })))).status).toBe(400)

    const add = await app.request('/api/vault/members', as('a@x', json({ email: ' B@x ' })))
    expect(add.status).toBe(200)
    expect(await add.json()).toEqual({ ok: true })
    // An invitation is not a membership: b is still nobody's member, and a sees it as waiting.
    expect(count('household_members')).toBe(0)
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404)
    const waiting = (await (await app.request('/api/vault/members', as('a@x'))).json()) as { members: unknown[]; invites: { email: string; invited_by: string }[] }
    expect(waiting.members).toEqual([])
    expect(waiting.invites).toMatchObject([{ email: 'b@x', invited_by: 'a@x' }])
    const modeB0 = (await (await app.request('/api/mode', as('b@x'))).json()) as { household: string | null; vault: unknown; invites: unknown[] }
    expect(modeB0).toMatchObject({ household: null, vault: null, invites: [{ household: 'a@x', invited_by: 'a@x' }] })

    // b says yes, on their own.
    expect((await app.request('/api/vault/invites/accept', as('b@x', json({ household: 'a@x' })))).status).toBe(200)
    expect(count('household_members')).toBe(1)
    expect(count('vault_invites')).toBe(0)
    // Inviting someone already in this household changes nothing — and reads the same.
    const again = await app.request('/api/vault/members', as('a@x', json({ email: 'b@x' })))
    expect(await again.json()).toEqual({ ok: true })
    expect(count('vault_invites')).toBe(0)

    // b now sees a's vault, in /mode and on the courier, and can save over it with the version check.
    const modeB = (await (await app.request('/api/mode', as('b@x'))).json()) as { vault: { version: number }; household: string; invites: unknown[] }
    expect(modeB.vault.version).toBe(1)
    expect(modeB.household).toBe('a@x')
    expect(modeB.invites).toEqual([])
    const modeA = (await (await app.request('/api/mode', as('a@x'))).json()) as { household: string | null }
    expect(modeA.household).toBeNull()
    expect((await (await app.request('/api/vault', as('b@x'))).json()) as { version: number }).toMatchObject({ version: 1 })
    expect((await app.request('/api/vault', as('b@x', json({ data: '{"v":2,"by":"b"}', version: 0 }, 'PUT')))).status).toBe(409)
    expect((await app.request('/api/vault', as('b@x', json({ data: '{"v":2,"by":"b"}', version: 1 }, 'PUT')))).status).toBe(200)
    expect((await (await app.request('/api/vault', as('a@x'))).json()) as { data: string }).toMatchObject({ version: 2, data: '{"v":2,"by":"b"}' })
    expect(count('vault_blobs')).toBe(1) // a's household blob — never one per member

    // Either member sees the list; another household's invitation doesn't move b anywhere.
    const list = (await (await app.request('/api/vault/members', as('b@x'))).json()) as { household: string; members: { email: string }[] }
    expect(list.household).toBe('a@x')
    expect(list.members.map((m) => m.email)).toEqual(['b@x'])
    await app.request('/api/vault', as('c@x', json({ data: '{"v":2}', version: 0 }, 'PUT')))
    expect((await app.request('/api/vault/members', as('c@x', json({ email: 'b@x' })))).status).toBe(200)
    expect(((await (await app.request('/api/mode', as('b@x'))).json()) as { household: string }).household).toBe('a@x')

    // Removal detaches b, who is back to an empty front door (with c's invitation still waiting).
    expect((await app.request('/api/vault/members/nobody%40x', as('a@x', { method: 'DELETE' }))).status).toBe(404)
    expect((await app.request('/api/vault/members/b%40x', as('a@x', { method: 'DELETE' }))).status).toBe(200)
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404)
  })

  it('a save moves the blob it replaced into the household’s history — as stored, who stored it, and its pin', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const put = (body: Record<string, unknown>, who = 'a@x') => app.request('/api/vault', as(who, json(body, 'PUT')))
    const history = () =>
      db.prepare('SELECT version, sha256, size, data, updated_by, pin FROM vault_history WHERE owner_email = ? ORDER BY version').all('a@x') as {
        version: number
        sha256: string
        size: number
        data: string
        updated_by: string | null
        pin: string | null
      }[]
    const prevCols = () =>
      db.prepare('SELECT prev_version, prev_data FROM vault_blobs WHERE owner_email = ?').get('a@x') as { prev_version: number | null; prev_data: string | null }

    // First save: nothing to keep.
    const first = (await (await put({ data: '{"v":3,"n":1}', version: 0 })).json()) as { sha256: string }
    expect(history()).toEqual([])

    // Second, by a member, pinned: v1 goes to history byte for byte, still attributed to a@x.
    await join(app, 'a@x', 'b@x')
    expect((await put({ data: '{"v":3,"n":2}', version: 1, pin: 'pre-upgrade' }, 'b@x')).status).toBe(200)
    expect(history()).toEqual([{ version: 1, sha256: first.sha256, size: 13, data: '{"v":3,"n":1}', updated_by: 'a@x', pin: 'pre-upgrade' }])
    await put({ data: '{"v":3,"n":3}', version: 2 })
    expect(history().map((h) => [h.version, h.updated_by, h.pin])).toEqual([
      [1, 'a@x', 'pre-upgrade'],
      [2, 'b@x', null],
    ])
    // The one-step prev_* columns are superseded: never written, so no blob is stored twice.
    expect(prevCols()).toEqual({ prev_version: null, prev_data: null })

    // Refused saves change nothing: a stale version, an unknown pin, a malformed one.
    expect((await put({ data: '{"v":3,"n":4}', version: 1 })).status).toBe(409)
    expect((await put({ data: '{"v":3,"n":4}', version: 3, pin: 'forever' })).status).toBe(400)
    expect((await put({ data: '{"v":3,"n":4}', version: 3, pin: 7 })).status).toBe(400)
    expect(history().map((h) => h.version)).toEqual([1, 2])
    // pin: null is the same as none; a pin on a create has nothing to pin.
    expect((await put({ data: '{"v":3,"n":4}', version: 3, pin: null })).status).toBe(200)
    expect((await put({ data: '{"v":3}', version: 0, pin: 'pre-restore' }, 'z@x')).status).toBe(200)
    expect(count('vault_history')).toBe(3)

    // A one-step previous blob left by a save from before vault_history existed joins the history once.
    db.prepare("UPDATE vault_blobs SET prev_version = 0, prev_sha256 = 'old', prev_size = 3, prev_data = 'old', prev_updated_at = '2026-01-01 00:00:00' WHERE owner_email = 'a@x'").run()
    await put({ data: '{"v":3,"n":5}', version: 4 })
    expect(history().map((h) => h.version)).toEqual([0, 1, 2, 3, 4])
    expect(prevCols()).toEqual({ prev_version: null, prev_data: null })

    // What GET /vault serves is unchanged: the live blob only — and it says history is kept.
    const served = (await (await app.request('/api/vault', as('a@x'))).json()) as Record<string, unknown>
    expect(served).toMatchObject({ version: 5, data: '{"v":3,"n":5}', keepsHistory: true })
    expect(Object.keys(served).filter((k) => k.startsWith('prev'))).toEqual([])
  })

  it('GET /vault/history and /vault/history/:version: the household’s own versions only, metadata then one blob', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true }) // both are on the vault-only allowlist
    const put = (body: Record<string, unknown>, who = 'a@x') => app.request('/api/vault', as(who, json(body, 'PUT')))
    await put({ data: '{"v":3,"n":1}', version: 0 })
    await put({ data: '{"v":3,"n":2}', version: 1, pin: 'pre-restore' })
    await put({ data: '{"v":3,"n":3}', version: 2 })
    await put({ data: '{"v":3,"z":1}', version: 0 }, 'z@x')
    await put({ data: '{"v":3,"z":2}', version: 1 }, 'z@x')
    await join(app, 'a@x', 'b@x')
    type List = { entries: Record<string, unknown>[]; bytes: number; policy: { keepLast: number; dailyDays: number; maxPins: number; byteCap: number } }
    const list = async (who: string) => (await (await app.request('/api/vault/history', as(who))).json()) as List

    // Newest first; metadata only — never the blobs.
    const a = await list('a@x')
    expect(a.entries.map((e) => [e.version, e.pin, e.updated_by])).toEqual([
      [2, null, 'a@x'],
      [1, 'pre-restore', 'a@x'],
    ])
    expect(a.entries.every((e) => !('data' in e))).toBe(true)
    expect(Object.keys(a.entries[0]!).sort()).toEqual(['pin', 'sha256', 'size', 'updated_at', 'updated_by', 'version'])
    expect(a.bytes).toBe(26)
    expect(a.policy).toEqual({ keepLast: 20, dailyDays: 30, maxPins: 8, byteCap: 64 * 1024 * 1024 })
    // A member sees the household's; another household sees only its own; a stranger sees none.
    expect((await list('b@x')).entries.map((e) => e.version)).toEqual([2, 1])
    expect((await list('z@x')).entries.map((e) => e.version)).toEqual([1])
    expect(await list('nobody@x')).toMatchObject({ entries: [], bytes: 0 })

    // One version: the blob as it was stored.
    const got = await app.request('/api/vault/history/1', as('b@x'))
    expect(got.status).toBe(200)
    expect(await got.json()).toMatchObject({ version: 1, data: '{"v":3,"n":1}', pin: 'pre-restore', updated_by: 'a@x' })
    // Not in this household's history (the live version, another household's, a stranger), or not a number.
    expect((await app.request('/api/vault/history/3', as('a@x'))).status).toBe(404)
    expect((await app.request('/api/vault/history/2', as('z@x'))).status).toBe(404) // z has a v1 only; a's v2 is a's
    expect((await app.request('/api/vault/history/1', as('nobody@x'))).status).toBe(404)
    expect(await (await app.request('/api/vault/history/1', as('z@x'))).json()).toMatchObject({ data: '{"v":3,"z":1}' })
    const household = mod.createApp({ zkOnly: false })
    expect((await household.request('/api/vault/history/abc', as('a@x'))).status).toBe(400)
    expect((await household.request('/api/vault/history/1.5', as('a@x'))).status).toBe(400)
    // On the vault-only server a non-number never reaches the handler.
    expect((await app.request('/api/vault/history/abc', as('a@x'))).status).toBe(403)
    expect((await app.request('/api/vault/history/1/data', as('a@x'))).status).toBe(403)

    // A removed member is back to nothing.
    await app.request('/api/vault/members/b%40x', as('a@x', { method: 'DELETE' }))
    expect((await list('b@x')).entries).toEqual([])
    expect((await app.request('/api/vault/history/1', as('b@x'))).status).toBe(404)
  })

  it('history is pruned on every save: the last 20, the last per day for 30 days, the newest 8 pins, under the byte cap', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    let v = 0
    const save = async (pin?: string) => {
      expect((await app.request('/api/vault', as('a@x', json({ data: `{"v":3,"n":${v}}`, version: v, ...(pin ? { pin } : {}) }, 'PUT')))).status).toBe(200)
      v++
    }
    const kept = () => (db.prepare("SELECT version FROM vault_history WHERE owner_email = 'a@x' ORDER BY version").all() as { version: number }[]).map((r) => r.version)
    // Stored on earlier days: a version's age is when it was stored, which it carries into history.
    const age = (version: number, days: number) =>
      db.prepare("UPDATE vault_history SET updated_at = datetime('now', ?) WHERE owner_email = 'a@x' AND version = ?").run(`-${days} days`, version)

    for (let i = 0; i < 6; i++) await save(i === 2 ? 'pre-upgrade' : undefined) // v1 created; v1..v5 in history, v2 pinned (the blob the third save replaced)
    age(1, 45) // older than 30 days, unpinned
    age(2, 45) // older than 30 days, pinned
    age(3, 10) // the only version of its day
    age(4, 3)
    age(5, 3) // v5 is that day's last
    for (let i = 0; i < 25; i++) await save() // 25 more replaced versions, all of today
    const k = kept()
    // The last 20 replaced (v11..v30), plus: v2 (pinned), v3 (its day), v5 (its day's last) — not v1 (45 days, unpinned) nor v4.
    expect(k).toEqual([2, 3, 5, ...Array.from({ length: 20 }, (_, i) => i + 11)])
  })
})

describe('historyToDrop (the retention policy, pure)', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  const day = (d: number, h = 12) => new Date(now - d * 86_400_000 + (h - 12) * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)
  const policy = { keepLast: 3, dailyDays: 30, maxPins: 2, byteCap: 1000 }
  const row = (version: number, updated_at: string, o: { size?: number; pin?: string | null } = {}) => ({ version, updated_at, size: o.size ?? 10, pin: o.pin ?? null })

  it('keeps the last N, then the last of each day inside the window — by stored time, never by version order alone', () => {
    const rows = [row(1, day(40)), row(2, day(20, 9)), row(3, day(20, 18)), row(4, day(5)), row(5, day(1)), row(6, day(0)), row(7, day(0))]
    // last 3: 5,6,7 · days: v7 (today), v5 (day 1), v4 (day 5), v3 (day 20's last) · v2 is day 20's earlier one · v1 is past 30 days
    expect(api4.historyToDrop(rows, now, policy).sort()).toEqual([1, 2])
    expect(api4.historyToDrop([], now, policy)).toEqual([])
    // Unreadable times never count as a day to keep (they may still be among the last N).
    expect(api4.historyToDrop([row(1, 'garbage'), row(2, day(0)), row(3, day(0)), row(4, day(0))], now, policy)).toEqual([1])
    // ISO timestamps with a zone read the same as SQLite's.
    expect(api4.historyToDrop([row(1, '2026-09-10T08:00:00Z'), row(2, day(0)), row(3, day(0)), row(4, day(0))], now, policy)).toEqual([])
  })

  it('keeps the newest pins however old; older pins than maxPins are just versions', () => {
    const rows = [row(1, day(90), { pin: 'pre-upgrade' }), row(2, day(80), { pin: 'pre-restore' }), row(3, day(70), { pin: 'pre-restore' }), ...[4, 5, 6].map((v) => row(v, day(0)))]
    expect(api4.historyToDrop(rows, now, policy)).toEqual([1])
  })

  it('over the byte cap: oldest first, unpinned before pinned, and the newest is always kept', () => {
    const big = (version: number, pin: string | null = null) => row(version, day(0, 8 + version), { size: 400, pin })
    // All five are today (each its own hour), so the last 3 + today's last + a pin: 1 (pinned), 3, 4, 5 kept → 1600 > 1000.
    const rows = [big(1, 'pre-upgrade'), big(2), big(3), big(4), big(5)]
    expect(api4.historyToDrop(rows, now, policy).sort()).toEqual([2, 3, 4]) // 3 and 4 (unpinned, oldest first) go; then 1600-800 = 800 fits
    // Pins go too when unpinned ones aren't enough; never the newest.
    const huge = [row(1, day(0, 9), { size: 900, pin: 'pre-restore' }), row(2, day(0, 10), { size: 900 })]
    expect(api4.historyToDrop(huge, now, policy)).toEqual([1])
    expect(api4.historyToDrop([row(1, day(0), { size: 5000 })], now, policy)).toEqual([])
  })
})

describe('zero-knowledge-only server, continued', () => {
  it('the vault-only allowlist has exactly the two history patterns', () => {
    expect(mod.ZK_ROUTES.test('/api/vault/history')).toBe(true)
    expect(mod.ZK_ROUTES.test('/api/vault/history/42')).toBe(true)
    for (const p of ['/api/vault/history/', '/api/vault/history/x', '/api/vault/history/4/2', '/api/vault/historyx', '/api/vault/history?x=1'])
      expect(mod.ZK_ROUTES.test(p), p).toBe(false)
  })

  it('records who saved each version — the caller, not the household key — and says so on /vault and /mode', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const saved = async (who: string) => {
      const v = (await (await app.request('/api/vault', as(who))).json()) as { version: number; updated_by: string | null; updated_at: string; sha256: string }
      const m = (await (await app.request('/api/mode', as(who))).json()) as { vault: Record<string, unknown> }
      // The poll's whole answer about the vault: version, when, who, and the ciphertext's hash — never the blob.
      expect(m.vault).toEqual({ version: v.version, updated_by: v.updated_by, updated_at: v.updated_at, sha256: v.sha256, keepsHistory: true })
      return [v.version, v.updated_by]
    }
    await app.request('/api/vault', as('a@x', json({ data: '{"v":3,"n":1}', version: 0 }, 'PUT')))
    await join(app, 'a@x', 'b@x')
    expect(await saved('a@x')).toEqual([1, 'a@x'])
    expect(await saved('b@x')).toEqual([1, 'a@x']) // the member sees the same answer

    await app.request('/api/vault', as('b@x', json({ data: '{"v":3,"n":2}', version: 1 }, 'PUT')))
    expect(await saved('a@x')).toEqual([2, 'b@x'])
    expect(db.prepare('SELECT owner_email, updated_by FROM vault_blobs').all()).toEqual([{ owner_email: 'a@x', updated_by: 'b@x' }])

    // A refused save changes nothing, and a version stored before the column existed reads as unknown.
    expect((await app.request('/api/vault', as('a@x', json({ data: '{"v":3,"n":3}', version: 1 }, 'PUT')))).status).toBe(409)
    expect(await saved('a@x')).toEqual([2, 'b@x'])
    db.prepare('UPDATE vault_blobs SET updated_by = NULL').run()
    expect(await saved('b@x')).toEqual([2, null])
  })

  it('household mode still serves everything', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: false })
    expect((await app.request('/api/accounts')).status).toBe(200)
    const mode = (await (await app.request('/api/mode')).json()) as { zkOnly: boolean }
    expect(mode.zkOnly).toBe(false)
  })

  it('refuses to boot ZK-only over plaintext unless told to purge; the purge keeps ciphertext and basket', () => {
    wipe()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    db.prepare("INSERT INTO vault_blobs (owner_email, version, sha256, size, data) VALUES ('a@b', 2, 'x', 1, '{}')").run()
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:built_at', 't')").run()
    db.prepare("INSERT INTO basket_quotes (symbol, kind, cents, priced_on) VALUES ('SPY', 'stock', 1, 'd')").run()
    expect(() => mod.prepareDatabase(db, { zkOnly: true, purge: false })).toThrow(/SCARAB_PURGE_PLAINTEXT/)
    expect(count('accounts')).toBe(1)
    const log = mod.prepareDatabase(db, { zkOnly: true, purge: true })
    expect(log.join('\n')).toMatch(/purged plaintext/)
    expect(count('accounts')).toBe(0)
    expect(count('vault_blobs')).toBe(1)
    expect(count('basket_quotes')).toBe(1)
    expect(count('app_meta')).toBe(1)
    // Idempotent: a clean ZK-only boot has nothing to purge and doesn't need the flag.
    expect(() => mod.prepareDatabase(db, { zkOnly: true, purge: false })).not.toThrow()
  })
})

describe('vault creation and deletion', () => {
  it('creating (version 0) never overwrites a vault: the 409 names the stored version and hash', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const first = await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":1}', version: 0 }, 'PUT')))
    expect(first.status).toBe(200)
    const { sha256 } = (await first.json()) as { sha256: string }

    const again = await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":2}', version: 0 }, 'PUT')))
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ serverVersion: 1, serverSha256: sha256 })
    expect((await (await app.request('/api/vault', as('a@x'))).json()) as { data: string }).toMatchObject({ version: 1, data: '{"v":2,"n":1}' })

    // With no vault stored, the 409 for a non-zero version says so (no hash to offer).
    const stale = await app.request('/api/vault', as('z@x', json({ data: '{}', version: 3 }, 'PUT')))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ serverVersion: 0, serverSha256: null })
  })

  it('an upload naming the blob it replaces is refused over a vault replaced at the same version', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const put = (body: Record<string, unknown>, who = 'a@x') => app.request('/api/vault', as(who, json(body, 'PUT')))
    const old = (await (await put({ data: '{"v":3,"n":"old"}', version: 0 })).json()) as { sha256: string }

    // The owner deletes it and creates a new one: v1 again, a different blob.
    expect((await app.request('/api/vault', as('a@x', json({ confirm: 'DELETE' }, 'DELETE')))).status).toBe(200)
    const fresh = (await (await put({ data: '{"v":3,"n":"new"}', version: 0 })).json()) as { version: number; sha256: string }
    expect(fresh.version).toBe(1)

    // A tab of the old vault, still at v1, saves: refused, and the new vault is untouched.
    const stale = await put({ data: '{"v":3,"n":"stale tab"}', version: 1, baseSha256: old.sha256 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ serverVersion: 1, serverSha256: fresh.sha256, error: expect.stringMatching(/replaced/) })
    expect((await (await app.request('/api/vault', as('a@x'))).json()) as { data: string }).toMatchObject({ version: 1, data: '{"v":3,"n":"new"}' })

    // Naming the right blob saves; so does naming none (older clients); a malformed hash is refused.
    expect((await put({ data: '{"v":3,"n":2}', version: 1, baseSha256: fresh.sha256 })).status).toBe(200)
    expect((await put({ data: '{"v":3,"n":3}', version: 2 })).status).toBe(200)
    expect((await put({ data: '{"v":3,"n":4}', version: 3, baseSha256: 'not-a-hash' })).status).toBe(400)
    expect((await put({ data: '{"v":3,"n":4}', version: 3, baseSha256: 42 })).status).toBe(400)
    // A create names nothing to replace; a hash sent with it doesn't matter when nothing is stored.
    expect((await put({ data: '{"v":3}', version: 0, baseSha256: old.sha256 }, 'z@x')).status).toBe(200)
  })

  it('DELETE /api/vault: the owner purges blob, history, members and invites; a member is refused', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true }) // the 'vault' pattern already covers DELETE
    await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":1}', version: 0 }, 'PUT')))
    await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":2}', version: 1 }, 'PUT')))
    await join(app, 'a@x', 'b@x')
    expect(count('vault_history')).toBe(1) // v1, replaced by the second save
    db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('c@x', 'a@x', 'a@x')").run()
    await app.request('/api/vault', as('d@x', json({ data: '{"v":2,"by":"d"}', version: 0 }, 'PUT'))) // someone else's vault
    const del = (email: string, body?: unknown) =>
      app.request('/api/vault', as(email, body === undefined ? { method: 'DELETE' } : json(body, 'DELETE')))

    // A member can't delete the household's vault — not even with the right words.
    const byMember = await del('b@x', { confirm: 'DELETE', version: 2 })
    expect(byMember.status).toBe(403)
    expect(count('vault_blobs')).toBe(2)
    expect(count('household_members')).toBe(1)

    // The owner must say so, and about the version they saw.
    expect((await del('a@x')).status).toBe(400)
    expect((await del('a@x', { confirm: 'yes' })).status).toBe(400)
    const staleConfirm = await del('a@x', { confirm: 'DELETE', version: 1 })
    expect(staleConfirm.status).toBe(409)
    expect(await staleConfirm.json()).toMatchObject({ serverVersion: 2 })
    expect(count('vault_blobs')).toBe(2)

    const ok = await del('a@x', { confirm: 'DELETE', version: 2 })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true, deleted: { blob: 1, history: 1, members: 1, invites: 1 } })
    expect((await app.request('/api/vault', as('a@x'))).status).toBe(404)
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404) // no longer routed to a's household
    expect(((await (await app.request('/api/mode', as('b@x'))).json()) as { household: string | null }).household).toBeNull()
    expect(count('vault_history') + count('vault_invites') + count('household_members')).toBe(0)
    expect((await (await app.request('/api/vault', as('d@x'))).json()) as { data: string }).toMatchObject({ data: '{"v":2,"by":"d"}' })

    // Nothing left: 404. And the owner can create afresh, at version 0.
    expect((await del('a@x', { confirm: 'DELETE' })).status).toBe(404)
    const fresh = await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":"new"}', version: 0 }, 'PUT')))
    expect(fresh.status).toBe(200)
    expect(await fresh.json()).toMatchObject({ version: 1 })
  })
})

describe('members and re-keying (Z7)', () => {
  it('DELETE /vault/members/:email: only the owner removes someone; a member may remove only themselves', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true }) // 'vault/members/[^/]+' is already a ZK route
    await app.request('/api/vault', as('a@x', json({ data: '{"v":3}', version: 0 }, 'PUT')))
    for (const m of ['b@x', 'c@x']) await join(app, 'a@x', m)
    await app.request('/api/vault', as('z@x', json({ data: '{"v":3,"by":"z"}', version: 0 }, 'PUT'))) // another household's owner
    const del = (who: string, email: string) => app.request(`/api/vault/members/${encodeURIComponent(email)}`, as(who, { method: 'DELETE' }))
    const members = () => (db.prepare('SELECT email FROM household_members ORDER BY email').all() as { email: string }[]).map((r) => r.email)

    // A member can't remove another member, nor the owner (who has no row anyway).
    const poach = await del('b@x', 'c@x')
    expect(poach.status).toBe(403)
    expect(((await poach.json()) as { error: string }).error).toMatch(/only the household’s owner/)
    expect((await del('b@x', 'a@x')).status).toBe(403)
    // Someone outside the household reaches nothing: their own household has no such member.
    expect((await del('z@x', 'c@x')).status).toBe(404)
    expect(members()).toEqual(['b@x', 'c@x'])

    // The owner removes c (any case, any encoding of the address); c is back to an empty front door.
    expect((await del('a@x', 'C@X')).status).toBe(200)
    expect(members()).toEqual(['b@x'])
    expect((await app.request('/api/vault', as('c@x'))).status).toBe(404)
    expect((await del('a@x', 'c@x')).status).toBe(404) // already gone

    // A member leaves on their own.
    expect((await del('b@x', 'b@x')).status).toBe(200)
    expect(members()).toEqual([])
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404)
    // The owner can't remove themselves: there is no row (deleting the vault is DELETE /api/vault).
    expect((await del('a@x', 'a@x')).status).toBe(404)
  })

  it('PUT with purgeHistory drops every earlier version the server keeps — history and the previous blob — for this household only', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const put = (who: string, body: Record<string, unknown>) => app.request('/api/vault', as(who, json(body, 'PUT')))
    await put('a@x', { data: '{"v":3,"n":1}', version: 0 })
    await put('a@x', { data: '{"v":3,"n":2}', version: 1 })
    await put('z@x', { data: '{"v":3,"z":1}', version: 0 })
    await put('z@x', { data: '{"v":3,"z":2}', version: 1 })
    const prevOf = (o: string) =>
      db.prepare('SELECT version, prev_version, prev_data, prev_sha256, prev_size, prev_updated_at FROM vault_blobs WHERE owner_email = ?').get(o) as Record<
        string,
        unknown
      >
    const versionsOf = (o: string) =>
      (db.prepare('SELECT version FROM vault_history WHERE owner_email = ? ORDER BY version').all(o) as { version: number }[]).map((r) => r.version)

    // Malformed flag: refused, nothing changes.
    expect((await put('a@x', { data: '{"v":3,"n":3}', version: 2, purgeHistory: 'yes' })).status).toBe(400)
    // A refused save (stale version) never purges.
    expect((await put('a@x', { data: '{"v":3,"n":3}', version: 1, purgeHistory: true })).status).toBe(409)
    expect(versionsOf('a@x')).toEqual([1])
    // An ordinary save keeps history.
    expect((await put('a@x', { data: '{"v":3,"n":3}', version: 2, purgeHistory: false })).status).toBe(200)
    expect(versionsOf('a@x')).toEqual([1, 2])
    // A one-step previous blob from before vault_history existed is under the old key too.
    db.prepare("UPDATE vault_blobs SET prev_version = 0, prev_sha256 = 's', prev_size = 1, prev_data = '{}', prev_updated_at = 'then' WHERE owner_email = 'a@x'").run()

    // A member's re-key purges too: the outgoing blob is not kept either — pinned or not.
    await join(app, 'a@x', 'b@x')
    const rekey = await put('b@x', { data: '{"v":3,"n":"rekeyed"}', version: 3, purgeHistory: true, pin: 'pre-restore' })
    expect(rekey.status).toBe(200)
    expect(await rekey.json()).toMatchObject({ ok: true, version: 4 })
    expect(versionsOf('a@x')).toEqual([])
    expect(prevOf('a@x')).toEqual({ version: 4, prev_version: null, prev_data: null, prev_sha256: null, prev_size: null, prev_updated_at: null })
    expect((await (await app.request('/api/vault', as('a@x'))).json()) as Record<string, unknown>).toMatchObject({
      version: 4,
      data: '{"v":3,"n":"rekeyed"}',
      updated_by: 'b@x',
    })
    expect(((await (await app.request('/api/vault/history', as('b@x'))).json()) as { entries: unknown[] }).entries).toEqual([])
    // Another household's history is untouched.
    expect(versionsOf('z@x')).toEqual([1])
    // The next ordinary save starts keeping history again.
    await put('a@x', { data: '{"v":3,"n":5}', version: 4 })
    expect(versionsOf('a@x')).toEqual([4])
    expect(await (await app.request('/api/vault/history/4', as('a@x'))).json()).toMatchObject({ data: '{"v":3,"n":"rekeyed"}', updated_by: 'b@x' })
  })
})

describe('consent-based invitations (Z9)', () => {
  type Mode = { vault: { version: number } | null; household: string | null; invites: { household: string; invited_by: string; invited_at: string }[] }
  const setup = async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const put = (who: string, body: Record<string, unknown>) => app.request('/api/vault', as(who, json(body, 'PUT')))
    const invite = (who: string, email: string) => app.request('/api/vault/members', as(who, json({ email })))
    const accept = (who: string, body: Record<string, unknown>) => app.request('/api/vault/invites/accept', as(who, json(body)))
    const decline = (who: string, household: string) => app.request(`/api/vault/invites/${encodeURIComponent(household)}`, as(who, { method: 'DELETE' }))
    const mode = async (who: string) => (await (await app.request('/api/mode', as(who))).json()) as Mode
    const householdOf = (who: string) => api4.householdOf(db, who)
    return { app, put, invite, accept, decline, mode, householdOf }
  }

  it('an invitation gets one answer — same status, same bytes — whoever it names', async () => {
    const { put, invite, accept } = await setup()
    await put('a@x', { data: '{"v":3,"a":1}', version: 0 })
    await put('owner@x', { data: '{"v":3,"o":1}', version: 0 }) // owns a vault of their own
    await put('h@x', { data: '{"v":3,"h":1}', version: 0 })
    await invite('h@x', 'member@x')
    expect((await accept('member@x', { household: 'h@x' })).status).toBe(200)
    expect(api4.householdOf(db, 'member@x')).toBe('h@x') // in another household
    const answers: { status: number; body: string }[] = []
    for (const email of ['stranger@x', 'owner@x', 'member@x', 'STRANGER@x ']) {
      const r = await invite('a@x', email)
      answers.push({ status: r.status, body: await r.text() })
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1)
    expect(answers[0]).toEqual({ status: 200, body: '{"ok":true}' })
    // Nobody moved: the owner still owns, the member is still where they were, the stranger is nobody's.
    expect(api4.householdOf(db, 'owner@x')).toBe('owner@x')
    expect(api4.householdOf(db, 'member@x')).toBe('h@x')
    expect(api4.householdOf(db, 'stranger@x')).toBe('stranger@x')
    // The only refusals are about the caller: themselves, or no vault to share.
    expect((await invite('a@x', 'a@x')).status).toBe(400)
    expect((await invite('novault@x', 'stranger@x')).status).toBe(409)
    expect((await invite('a@x', 'not-an-email')).status).toBe(400)
  })

  it('squatting is impossible: an invitation moves nobody, and only the invitee can accept it', async () => {
    const { app, put, invite, accept, mode, householdOf } = await setup()
    await put('evil@x', { data: '{"v":3,"evil":1}', version: 0 })
    expect((await invite('evil@x', 'victim@x')).status).toBe(200)
    // The victim still resolves to themselves: no vault served, and they create their own at version 0.
    expect(householdOf('victim@x')).toBe('victim@x')
    expect((await app.request('/api/vault', as('victim@x'))).status).toBe(404)
    expect((await put('victim@x', { data: '{"v":3,"mine":1}', version: 0 })).status).toBe(200)
    expect(count('vault_blobs')).toBe(2)
    // The inviter can't see or reach the victim's vault, and has no member.
    const evil = (await (await app.request('/api/vault/members', as('evil@x'))).json()) as { members: unknown[]; invites: { email: string }[] }
    expect(evil.members).toEqual([])
    expect(evil.invites.map((i) => i.email)).toEqual(['victim@x'])
    expect(((await (await app.request('/api/vault', as('evil@x'))).json()) as { data: string }).data).toBe('{"v":3,"evil":1}')
    // Nobody accepts for someone else: accepting is always the caller's own (a third party has no invitation).
    expect((await accept('evil@x', { household: 'evil@x' })).status).toBe(404)
    expect((await accept('bystander@x', { household: 'evil@x' })).status).toBe(404)
    expect(householdOf('victim@x')).toBe('victim@x')
    // The victim sees who invited them; nobody else sees it.
    expect((await mode('victim@x')).invites).toMatchObject([{ household: 'evil@x', invited_by: 'evil@x' }])
    expect((await mode('bystander@x')).invites).toEqual([])
    expect((await mode('evil@x')).invites).toEqual([])
    // Accepting by accident without saying the vault goes is refused, and changes nothing.
    const careless = await accept('victim@x', { household: 'evil@x' })
    expect(careless.status).toBe(409)
    expect(await careless.json()).toMatchObject({ code: 'own-vault', version: 1 })
    expect(householdOf('victim@x')).toBe('victim@x')
    expect(count('vault_blobs')).toBe(2)
  })

  it('accepting: the named household only; own vault or other household only when replaced on purpose; version-checked', async () => {
    const { app, put, invite, accept, mode, householdOf } = await setup()
    await put('a@x', { data: '{"v":3,"a":1}', version: 0 })
    await put('n@x', { data: '{"v":3,"n":1}', version: 0 })
    await put('n@x', { data: '{"v":3,"n":2}', version: 1 }) // n's own vault is at v2, with one kept version
    await invite('n@x', 'kid@x') // …and an invitation of n's own out
    await invite('a@x', 'n@x')

    // Wrong household, bad body: refused.
    expect((await accept('n@x', { household: 'z@x' })).status).toBe(404)
    expect((await accept('n@x', {})).status).toBe(400)
    expect((await accept('n@x', { household: 'a@x', replaceOwn: 'yes' })).status).toBe(400)
    // A confirmation for another version than n's own vault is at: nothing changes.
    const stale = await accept('n@x', { household: 'a@x', replaceOwn: true, version: 1 })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'own-vault', version: 2 })
    expect(householdOf('n@x')).toBe('n@x')

    // Accepted: n's own vault, its history and its invitations go; n is a's member, added by who invited them.
    expect((await accept('n@x', { household: 'A@x', replaceOwn: true, version: 2 })).status).toBe(200)
    expect(householdOf('n@x')).toBe('a@x')
    expect(db.prepare("SELECT owner_email FROM vault_blobs ORDER BY owner_email").all()).toEqual([{ owner_email: 'a@x' }])
    expect(db.prepare("SELECT count(*) AS n FROM vault_history WHERE owner_email = 'n@x'").get()).toEqual({ n: 0 })
    expect((await mode('kid@x')).invites).toEqual([])
    expect(db.prepare('SELECT email, household, added_by FROM household_members').all()).toEqual([{ email: 'n@x', household: 'a@x', added_by: 'a@x' }])
    expect(await mode('n@x')).toMatchObject({ household: 'a@x', vault: { version: 1 }, invites: [] })
    // Accepting again is harmless.
    expect((await accept('n@x', { household: 'a@x' })).status).toBe(404) // the invitation is used up

    // Moving households needs saying so too.
    await put('b@x', { data: '{"v":3,"b":1}', version: 0 })
    await invite('b@x', 'n@x')
    const move = await accept('n@x', { household: 'b@x' })
    expect(move.status).toBe(409)
    expect(await move.json()).toMatchObject({ code: 'other-household', household: 'a@x' })
    expect(householdOf('n@x')).toBe('a@x')
    expect((await accept('n@x', { household: 'b@x', replaceOwn: true })).status).toBe(200)
    expect(householdOf('n@x')).toBe('b@x')
    expect(((await (await app.request('/api/vault/members', as('a@x'))).json()) as { members: unknown[] }).members).toEqual([])

    // An invitation from a household whose vault is gone is void.
    db.prepare("INSERT INTO vault_invites (email, household, invited_by) VALUES ('late@x', 'ghost@x', 'ghost@x')").run()
    const ghost = await accept('late@x', { household: 'ghost@x' })
    expect(ghost.status).toBe(409)
    expect(await ghost.json()).toMatchObject({ code: 'no-vault' })
    expect((await mode('late@x')).invites).toEqual([])
    expect(householdOf('late@x')).toBe('late@x')
  })

  it('declining and withdrawing', async () => {
    const { app, put, invite, accept, decline, mode, householdOf } = await setup()
    await put('a@x', { data: '{"v":3}', version: 0 })
    await put('b@x', { data: '{"v":3}', version: 0 })
    await join(app, 'a@x', 'm@x') // a member of a's
    const pending = async (who: string) => ((await (await app.request('/api/vault/members', as(who))).json()) as { invites: { email: string }[] }).invites.map((i) => i.email)
    const withdraw = (who: string, email: string) => app.request(`/api/vault/members/${encodeURIComponent(email)}?pending=1`, as(who, { method: 'DELETE' }))

    // Decline: gone; the same answer whether or not one was waiting.
    await invite('a@x', 'x@x')
    expect((await decline('x@x', 'a@x')).status).toBe(200)
    expect((await mode('x@x')).invites).toEqual([])
    expect(await pending('a@x')).toEqual([])
    expect((await decline('x@x', 'a@x')).status).toBe(200)
    expect(householdOf('x@x')).toBe('x@x')

    // Withdraw: the owner any of the household's; a member only the ones they sent — and never a membership.
    await invite('a@x', 'y@x')
    await invite('m@x', 'z@x')
    expect(await pending('m@x')).toEqual(['y@x', 'z@x']) // a member sees the household's invitations too
    expect((await withdraw('m@x', 'y@x')).status).toBe(403)
    expect((await withdraw('m@x', 'z@x')).status).toBe(200)
    expect((await withdraw('a@x', 'y@x')).status).toBe(200)
    expect(await pending('a@x')).toEqual([])
    expect((await withdraw('a@x', 'm@x')).status).toBe(404) // m accepted long ago: a membership is never withdrawn this way
    expect(householdOf('m@x')).toBe('a@x')
    expect((await withdraw('b@x', 'y@x')).status).toBe(404) // another household reaches nothing
    // Withdrawing an invitation to someone in another household leaves that membership alone.
    await join(app, 'b@x', 'bm@x')
    await invite('a@x', 'bm@x')
    expect((await withdraw('a@x', 'bm@x')).status).toBe(200)
    expect(householdOf('bm@x')).toBe('b@x')

    // A withdrawn invitation can't be accepted, even under the name the invitee was shown.
    await invite('a@x', 'q@x')
    expect((await withdraw('a@x', 'q@x')).status).toBe(200)
    expect((await accept('q@x', { household: 'a@x' })).status).toBe(404)
    await invite('b@x', 'q@x')
    expect((await accept('q@x', { household: 'b@x' })).status).toBe(200)
    expect(householdOf('q@x')).toBe('b@x')

    // Leaving: a member takes themselves out.
    expect((await app.request('/api/vault/members/q%40x', as('q@x', { method: 'DELETE' }))).status).toBe(200)
    expect(householdOf('q@x')).toBe('q@x')
    expect((await app.request('/api/vault', as('q@x'))).status).toBe(404)
  })

  it('two households inviting one person: each invitation waits on its own; accepting one leaves the other to answer', async () => {
    const { app, put, invite, accept, decline, mode, householdOf } = await setup()
    await put('a@x', { data: '{"v":3,"a":1}', version: 0 })
    await put('b@x', { data: '{"v":3,"b":1}', version: 0 })
    const members = async (who: string) => await (await app.request('/api/vault/members', as(who))).text()
    const pending = async (who: string) => ((JSON.parse(await members(who)) as { invites: { email: string; invited_by: string }[] }).invites)

    const first = await invite('a@x', 'q@x')
    const aSees = await members('a@x')
    // b's invitation gets the same answer a's did, displaces nothing, and a can't tell it was sent.
    const second = await invite('b@x', 'q@x')
    expect({ status: second.status, body: await second.text() }).toEqual({ status: first.status, body: await first.text() })
    expect(await members('a@x')).toBe(aSees)
    expect(await pending('a@x')).toMatchObject([{ email: 'q@x', invited_by: 'a@x' }])
    expect(await pending('b@x')).toMatchObject([{ email: 'q@x', invited_by: 'b@x' }])
    // Nor can a later one from a take b's place: inviting again re-stamps a's own.
    expect((await invite('a@x', 'Q@x')).status).toBe(200)
    expect(count('vault_invites')).toBe(2)
    expect(await pending('b@x')).toMatchObject([{ email: 'q@x', invited_by: 'b@x' }])
    // The invitee sees both, oldest first, with who sent each.
    expect((await mode('q@x')).invites.map((i) => [i.household, i.invited_by])).toEqual([
      ['b@x', 'b@x'],
      ['a@x', 'a@x'],
    ])

    // Accepting a's uses up a's invitation only; b's still waits, in b's list and at q's front door.
    expect((await accept('q@x', { household: 'a@x' })).status).toBe(200)
    expect(householdOf('q@x')).toBe('a@x')
    expect(await mode('q@x')).toMatchObject({ household: 'a@x', invites: [{ household: 'b@x', invited_by: 'b@x' }] })
    expect(await pending('a@x')).toEqual([])
    expect(await pending('b@x')).toMatchObject([{ email: 'q@x' }])
    // Declining it is clean: b's invitation goes, q stays in a's household, and nothing else moves.
    expect((await decline('q@x', 'b@x')).status).toBe(200)
    expect((await mode('q@x')).invites).toEqual([])
    expect(await pending('b@x')).toEqual([])
    expect(householdOf('q@x')).toBe('a@x')
    expect(db.prepare('SELECT email, household FROM household_members').all()).toEqual([{ email: 'q@x', household: 'a@x' }])
    expect(count('vault_blobs')).toBe(2)
  })

  it('the vault-only server answers accept and decline — and nothing deeper', async () => {
    const { app, put, invite, accept, decline } = await setup()
    expect(mod.ZK_ROUTES.test('/api/vault/invites/accept')).toBe(true)
    expect(mod.ZK_ROUTES.test('/api/vault/invites/a%40x')).toBe(true)
    for (const p of ['/api/vault/invites', '/api/vault/invites/', '/api/vault/invites/a@x/more', '/api/vault/invitesx'])
      expect(mod.ZK_ROUTES.test(p), p).toBe(false)
    await put('a@x', { data: '{"v":3}', version: 0 })
    await invite('a@x', 'b@x')
    expect((await app.request('/api/vault/invites/a%40x/more', as('b@x', { method: 'DELETE' }))).status).toBe(403)
    expect((await decline('b@x', 'nobody@x')).status).toBe(200)
    expect((await accept('b@x', { household: 'a@x' })).status).toBe(200)
  })

  it('letter case: an owner or member whose identity arrives in another case still invites, accepts, declines and resolves', async () => {
    const { app, put, invite, accept, decline, mode } = await setup()
    // The household key is the owner's identity as IAP reported it; the invitee names it however the front door shows it.
    await put('Max@X.com', { data: '{"v":3,"m":1}', version: 0 })
    expect((await invite('Max@X.com', 'Nicole@X.com')).status).toBe(200)
    expect((await mode('nicole@x.com')).invites.map((i) => i.household)).toEqual(['Max@X.com'])
    expect((await accept('NICOLE@x.com', { household: 'max@x.com' })).status).toBe(200)
    // She resolves to the vault as stored, whatever case her identity arrives in, and reads and saves it.
    for (const who of ['nicole@x.com', 'Nicole@X.com']) {
      expect(api4.householdOf(db, who)).toBe('Max@X.com')
      expect((await mode(who)).household).toBe('Max@X.com')
      expect((await app.request('/api/vault', as(who))).status).toBe(200)
    }
    expect((await put('Nicole@X.com', { data: '{"v":3,"n":1}', version: 1 })).status).toBe(200)
    // The owner's view: she is a member; the owner can take her out, and she can leave in any case.
    expect(((await (await app.request('/api/vault/members', as('Max@X.com'))).json()) as { members: { email: string }[] }).members.map((m) => m.email)).toEqual(['nicole@x.com'])
    expect((await app.request('/api/vault/members/NICOLE%40X.COM', as('Nicole@X.com', { method: 'DELETE' }))).status).toBe(200)
    expect(api4.householdOf(db, 'nicole@x.com')).toBe('nicole@x.com')
    // Declining matches the household in any case too.
    await invite('Max@X.com', 'wes@x.com')
    expect((await decline('wes@x.com', 'MAX@x.com')).status).toBe(200)
    expect((await mode('wes@x.com')).invites).toEqual([])
  })
})

describe('request body limits', () => {
  const big = (bytes: number) => JSON.stringify({ data: 'x'.repeat(bytes), version: 0 })

  it('vault-only server: 15MB for PUT /api/vault, 64KB for everything else', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const put = (body: string) => app.request('/api/vault', as('a@x', { method: 'PUT', headers: { 'content-type': 'application/json' }, body }))
    const over = await put(big(15 * 1024 * 1024))
    expect(over.status).toBe(413)
    expect(await over.json()).toEqual({ error: 'request body too large' })
    expect(count('vault_blobs')).toBe(0)
    expect((await put(big(1024 * 1024))).status).toBe(200) // a real-sized blob passes

    const member = (body: string) =>
      app.request('/api/vault/members', as('a@x', { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
    expect((await member(JSON.stringify({ email: 'b@x', pad: 'x'.repeat(65 * 1024) }))).status).toBe(413)
    expect((await member(JSON.stringify({ email: 'b@x', pad: 'x'.repeat(60 * 1024) }))).status).toBe(200)
  })

  it('household server: 20MB for every route but a restore, which gets 64MB', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: false })
    const post = (p: string, body: string) => app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
    expect((await post('/api/imports', big(20 * 1024 * 1024))).status).toBe(413)
    expect((await post('/api/accounts', big(20 * 1024 * 1024))).status).toBe(413)
    expect((await post('/api/import', big(20 * 1024 * 1024))).status).toBe(400) // past the cap check; refused as not an export
    const over = await post('/api/import', big(64 * 1024 * 1024))
    expect(over.status).toBe(413)
    expect(await over.json()).toEqual({ error: 'request body too large' })
  })

  it('restores a household export bigger than 20MB (a long daily price history)', { timeout: 30_000 }, async () => {
    wipe()
    const { dumpDb } = await import('../engine/snapshot')
    // 40 holdings × 9,500 trading days = 380k prices_daily rows: 22 MB of compact JSON, as Backups sends it.
    const assets = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, symbol: `S${i}`, name: null, kind: 'stock' }))
    const days = Array.from({ length: 9_500 }, (_, d) => new Date(Date.UTC(1990, 0, 1 + d)).toISOString().slice(0, 10))
    const prices_daily = assets.flatMap((a) => days.map((priced_on, d) => ({ asset_id: a.id, priced_on, close_cents: 10_000 + d })))
    const dump = dumpDb(db)
    const init = json({ ...dump, tables: { ...dump.tables, assets, prices_daily }, confirm: 'REPLACE' })
    expect((init.body as string).length).toBeGreaterThan(api4.BODY_LIMITS.household)
    const r = await mod.createApp({ zkOnly: false }).request('/api/import', init)
    expect(r.status).toBe(200)
    expect(((await r.json()) as { restored: Record<string, number> }).restored).toMatchObject({ assets: 40, prices_daily: 380_000 })
    expect(count('prices_daily')).toBe(380_000)
    for (const t of ['prices_daily', 'assets']) db.prepare(`DELETE FROM ${t}`).run()
  })
})

describe('error contract: every failure is JSON { error }, 400 when it is the request’s fault', () => {
  const send = (app: ReturnType<typeof mod.createApp>, method: string, p: string, body?: string) =>
    app.request(p, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body })

  it('a body that is not JSON, or is JSON null or a bare value, is a 400 before any handler runs', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: false })
    for (const p of ['/api/accounts', '/api/trades/preview', '/api/trades/opening', '/api/prices/manual', '/api/import']) {
      const broken = await send(app, 'POST', p, '{not json')
      expect(broken.status, p).toBe(400)
      expect(await broken.json(), p).toEqual({ error: 'request body is not valid JSON' })
      for (const bare of ['null', '5', '"text"', 'true']) {
        const r = await send(app, 'POST', p, bare)
        expect(r.status, `${p} ${bare}`).toBe(400)
        expect(await r.json()).toEqual({ error: 'request body must be a JSON object or array' })
      }
    }
    const patched = await send(app, 'PATCH', '/api/trades/1', 'null')
    expect(patched.status).toBe(400)
    expect(count('accounts')).toBe(0)
  })

  it('an empty body is a 400 where the route needs one, and still fine where it is optional', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: false })
    const empty = await send(app, 'POST', '/api/accounts', '')
    expect(empty.status).toBe(400)
    expect(await empty.json()).toEqual({ error: 'request body required: a JSON object' })
    expect((await send(app, 'POST', '/api/accounts')).status).toBe(400) // no body at all
    // Optional bodies: acknowledging the digest takes none; members reads `{}` and says what is missing.
    expect((await send(app, 'POST', '/api/digest/ack')).status).toBe(200)
    const zk = mod.createApp({ zkOnly: true })
    const member = await zk.request('/api/vault/members', as('a@x', { method: 'POST' }))
    expect(member.status).toBe(400)
    expect(((await member.json()) as { error: string }).error).toMatch(/email/)
    // An array is a body too (Compare's saved views are sent as one).
    expect((await send(app, 'PUT', '/api/series/views', '[]')).status).toBe(200)
    // Valid bodies still reach their handlers.
    const made = await send(app, 'POST', '/api/accounts', JSON.stringify({ name: 'Checking', kind: 'checking' }))
    expect(made.status).toBe(200)
    expect(count('accounts')).toBe(1)
  })

  it('a restore the snapshot itself makes impossible is a 400 with the reason, and changes nothing', async () => {
    wipe()
    db.prepare("INSERT INTO accounts (name, kind) VALUES ('Checking', 'checking')").run()
    const { schemaVersion } = await import('./db')
    const app = mod.createApp({ zkOnly: false })
    const restore = (tables: Record<string, unknown>) =>
      app.request('/api/import', json({ scarab: true, schemaVersion, exportedAt: 'x', tables, confirm: 'REPLACE' }))
    for (const [tables, error] of [
      [{ accounts: [{ bogus_col: 1 }] }, 'snapshot has an unknown column: accounts.bogus_col'],
      [{ accounts: [5] }, 'snapshot has a malformed row in accounts'],
      [{ accounts: 'rows' }, 'snapshot table accounts is not a list of rows'],
      [{ accounts: [{ id: 1, name: { nested: true }, kind: 'checking' }] }, 'snapshot has a malformed value in accounts.name'],
    ] as const) {
      const r = await restore(tables)
      expect(r.status, error).toBe(400)
      expect(r.headers.get('content-type')).toMatch(/json/)
      expect(await r.json()).toEqual({ error })
    }
    // A row the schema rejects (no name: NOT NULL) rolls back; SQLite says which column.
    const bad = await restore({ accounts: [{ id: 1, kind: 'checking' }] })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/don't fit this database: NOT NULL constraint failed: accounts\.name/)
    expect(count('accounts')).toBe(1)
  })
})

describe('basket rebuild throttle', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
  const setMeta = (key: string, value: string) =>
    db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)

  it('joins a running build, then refuses another inside 15 minutes with 429 and builtAt', async () => {
    wipe()
    // Every upstream answers 503: a build finishes at once, with errors, and counts its requests.
    const upstream = vi.fn(async () => new Response('down', { status: 503 }))
    vi.stubGlobal('fetch', upstream)
    const app = mod.createApp({ zkOnly: true }) // the only rebuild path on a vault-only server
    const rebuild = () => app.request('/api/basket/rebuild', { method: 'POST' })

    const [a, b] = await Promise.all([rebuild(), rebuild()])
    expect([a.status, b.status]).toEqual([200, 200])
    const perBuild = upstream.mock.calls.length
    expect(perBuild).toBeGreaterThan(0)
    expect(await b.json()).toEqual(await a.json()) // the second caller got the same build, not its own

    const refused = await rebuild()
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(14 * 60)
    expect(await refused.json()).toMatchObject({ builtAt: null })
    expect(upstream.mock.calls.length).toBe(perBuild)

    // A successful build 5 minutes ago counts too, whenever the last request was.
    setMeta('basket:rebuild_requested_at', at(20 * 60_000))
    setMeta('basket:built_at', at(5 * 60_000))
    const recent = await rebuild()
    expect(recent.status).toBe(429)
    const builtAt = (db.prepare("SELECT value FROM app_meta WHERE key = 'basket:built_at'").get() as { value: string }).value
    expect(((await recent.json()) as { builtAt: string }).builtAt).toBe(builtAt)

    // Past the window: it builds again (today's scheduled build already ran, so this one is forced).
    setMeta('basket:built_at', at(16 * 60_000))
    expect((await rebuild()).status).toBe(200)
    expect(upstream.mock.calls.length).toBe(2 * perBuild)
  })

  it('a rebuild while the daily build runs joins it — never a second build, even inside the window', async () => {
    wipe()
    const down = async () => new Response('down', { status: 503 })
    // How many upstream requests one build makes against this upstream.
    const solo = vi.fn(down)
    await (await import('./basket')).buildBasket(db, solo)
    const perBuild = solo.mock.calls.length
    expect(perBuild).toBeGreaterThan(0)

    wipe()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const upstream = vi.fn(async () => {
      await gate // the daily build stalls on its first requests until released
      return down()
    })
    vi.stubGlobal('fetch', upstream)
    const app = mod.createApp({ zkOnly: true })
    // A rebuild was asked for a minute ago: a new one would be refused with 429.
    const asked = at(60_000)
    setMeta('basket:rebuild_requested_at', asked)

    const daily = app.request('/api/basket') // first boot: this starts today's build and waits for it
    await vi.waitFor(() => expect(upstream).toHaveBeenCalled())
    const inFlight = upstream.mock.calls.length
    const rebuild = app.request('/api/basket/rebuild', { method: 'POST' })
    await new Promise((r) => setTimeout(r, 10))
    expect(upstream.mock.calls.length).toBe(inFlight) // joined: no second build's requests
    release()
    const [d, r] = await Promise.all([daily, rebuild])
    expect([d.status, r.status]).toEqual([200, 200])
    expect(await r.json()).toMatchObject({ stocks: 0, crypto: 0, universe: 0 })
    expect(upstream.mock.calls.length).toBe(perBuild) // one build in all
    // Joining isn't a rebuild request of its own: the window still runs from the earlier one.
    const meta = db.prepare("SELECT value FROM app_meta WHERE key = 'basket:rebuild_requested_at'").get() as { value: string }
    expect(meta.value).toBe(asked)
  })
})


describe('API misses', () => {
  it('answer JSON 404 — an unknown path or an unhandled method never gets the SPA shell', async () => {
    wipe()
    for (const zkOnly of [false, true]) {
      const app = mod.createApp({ zkOnly })
      // A listed vault-only path with a method it doesn't take, and (household) a path nothing serves.
      const misses: [string, RequestInit][] = [['/api/vault/invites/accept', as('a@x')]]
      if (!zkOnly) misses.push(['/api/no-such-thing', as('a@x')])
      for (const [path, init] of misses) {
        const r = await app.request(path, init)
        expect(r.status, path).toBe(404)
        expect(r.headers.get('content-type') ?? '', path).toContain('application/json')
        expect(((await r.json()) as { error: string }).error, path).toMatch(/no such endpoint/)
      }
    }
  })
})
