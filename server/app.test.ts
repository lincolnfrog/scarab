import { beforeAll, describe, expect, it } from 'vitest'
import type { DbLike } from '../engine/db'

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

let db: DbLike
let mod: typeof import('./app')
beforeAll(async () => {
  mod = await import('./app')
  db = (await import('./db')).db as unknown as DbLike
})

const wipe = () => {
  for (const t of ['accounts', 'vault_blobs', 'household_members', 'app_meta', 'basket_quotes']) db.prepare(`DELETE FROM ${t}`).run()
}
const as = (email: string, init?: RequestInit): RequestInit => ({
  ...init,
  headers: { ...(init?.headers as Record<string, string>), 'x-goog-authenticated-user-email': `accounts.google.com:${email}` },
})
const json = (body: unknown, method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n

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

  it('a household member reads and writes the same blob; membership is the only new ZK route', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    expect((await app.request('/api/vault/members', as('a@x'))).status).toBe(200)
    await app.request('/api/vault', as('a@x', json({ data: '{"v":2}', version: 0 }, 'PUT')))
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404) // not a member yet

    // Bad adds: no email, self, someone who already owns a vault.
    expect((await app.request('/api/vault/members', as('a@x', json({})))).status).toBe(400)
    expect((await app.request('/api/vault/members', as('a@x', json({ email: 'A@x' })))).status).toBe(400)
    await app.request('/api/vault', as('c@x', json({ data: '{"v":2}', version: 0 }, 'PUT')))
    expect((await app.request('/api/vault/members', as('a@x', json({ email: 'c@x' })))).status).toBe(409)

    const add = await app.request('/api/vault/members', as('a@x', json({ email: ' B@x ' })))
    expect(add.status).toBe(200)
    expect(await add.json()).toMatchObject({ household: 'a@x', email: 'b@x' })
    expect((await app.request('/api/vault/members', as('a@x', json({ email: 'b@x' })))).status).toBe(400) // already

    // b now sees a's vault, in /mode and on the courier, and can save over it with the version check.
    const modeB = (await (await app.request('/api/mode', as('b@x'))).json()) as { vault: { version: number }; household: string }
    expect(modeB.vault.version).toBe(1)
    expect(modeB.household).toBe('a@x')
    const modeA = (await (await app.request('/api/mode', as('a@x'))).json()) as { household: string | null }
    expect(modeA.household).toBeNull()
    expect((await (await app.request('/api/vault', as('b@x'))).json()) as { version: number }).toMatchObject({ version: 1 })
    expect((await app.request('/api/vault', as('b@x', json({ data: '{"v":2,"by":"b"}', version: 0 }, 'PUT')))).status).toBe(409)
    expect((await app.request('/api/vault', as('b@x', json({ data: '{"v":2,"by":"b"}', version: 1 }, 'PUT')))).status).toBe(200)
    expect((await (await app.request('/api/vault', as('a@x'))).json()) as { data: string }).toMatchObject({ version: 2, data: '{"v":2,"by":"b"}' })
    expect(count('vault_blobs')).toBe(2) // a's household blob and c's own — never one per member

    // Either member sees the list; a member cannot be poached by another household.
    const list = (await (await app.request('/api/vault/members', as('b@x'))).json()) as { household: string; members: { email: string }[] }
    expect(list.household).toBe('a@x')
    expect(list.members.map((m) => m.email)).toEqual(['b@x'])
    expect((await app.request('/api/vault/members', as('c@x', json({ email: 'b@x' })))).status).toBe(409)

    // Removal detaches b, who is back to an empty front door.
    expect((await app.request('/api/vault/members/nobody%40x', as('a@x', { method: 'DELETE' }))).status).toBe(404)
    expect((await app.request('/api/vault/members/b%40x', as('a@x', { method: 'DELETE' }))).status).toBe(200)
    expect((await app.request('/api/vault', as('b@x'))).status).toBe(404)
  })

  it('a save keeps the blob it replaced: one step of ciphertext history, per household', async () => {
    wipe()
    const app = mod.createApp({ zkOnly: true })
    const prev = () =>
      db.prepare('SELECT version, data, prev_version, prev_data, prev_sha256 FROM vault_blobs WHERE owner_email = ?').get('a@x') as {
        version: number
        data: string
        prev_version: number | null
        prev_data: string | null
        prev_sha256: string | null
      }

    // First save: nothing to keep.
    expect((await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":1}', version: 0 }, 'PUT')))).status).toBe(200)
    expect(prev()).toMatchObject({ version: 1, data: '{"v":2,"n":1}', prev_version: null, prev_data: null })

    // Second and third: the outgoing blob moves to prev_*, and only the one before it.
    const second = (await (await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":2}', version: 1 }, 'PUT')))).json()) as { sha256: string }
    expect(prev()).toMatchObject({ version: 2, data: '{"v":2,"n":2}', prev_version: 1, prev_data: '{"v":2,"n":1}' })
    await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":3}', version: 2 }, 'PUT')))
    expect(prev()).toMatchObject({ version: 3, data: '{"v":2,"n":3}', prev_version: 2, prev_data: '{"v":2,"n":2}', prev_sha256: second.sha256 })

    // A rejected save (stale version) keeps history exactly as it was.
    expect((await app.request('/api/vault', as('a@x', json({ data: '{"v":2,"n":4}', version: 1 }, 'PUT')))).status).toBe(409)
    expect(prev()).toMatchObject({ version: 3, prev_version: 2, prev_data: '{"v":2,"n":2}' })

    // What GET serves is unchanged: the live blob only, never the previous one.
    const served = (await (await app.request('/api/vault', as('a@x'))).json()) as Record<string, unknown>
    expect(served).toMatchObject({ version: 3, data: '{"v":2,"n":3}' })
    expect(Object.keys(served).filter((k) => k.startsWith('prev'))).toEqual([])
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
