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
  for (const t of ['accounts', 'vault_blobs', 'app_meta', 'basket_quotes']) db.prepare(`DELETE FROM ${t}`).run()
}
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
