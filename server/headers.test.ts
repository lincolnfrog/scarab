import { beforeAll, describe, expect, it } from 'vitest'

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

let mod: typeof import('./app')
beforeAll(async () => {
  mod = await import('./app')
})

const COMMIT = 'b'.repeat(40)

/**
 * Every response carries the security headers (server/app.ts): the policy that
 * keeps a served bundle from loading or sending anything off this origin, and
 * what /api/health says about the build it is serving.
 */
describe('security headers', () => {
  it('sets a Content-Security-Policy of this origin only, with the inline boot style by hash and wasm allowed', async () => {
    const app = mod.createApp({ zkOnly: true, inlineStyleHashes: ["'sha256-abc='"] })
    const r = await app.request('/api/health')
    expect(r.status).toBe(200)
    const csp = r.headers.get('content-security-policy')!
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).toContain("style-src 'self' 'sha256-abc='")
    expect(csp).toContain("img-src 'self' data:")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toContain('nonce-')
    expect(r.headers.get('referrer-policy')).toBe('no-referrer')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('x-frame-options')).toBe('DENY')
    expect(r.headers.get('permissions-policy')).toContain('camera=()')
    expect(r.headers.get('permissions-policy')).not.toContain('publickey-credentials')
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age=\d+/)
  })

  it('on every response: a refused route, an unauthenticated one, an API miss', async () => {
    for (const [zkOnly, path, status] of [
      [true, '/api/accounts', 403],
      [true, '/api/me', 200],
      [false, '/api/nothing-here', 404],
    ] as const) {
      const app = mod.createApp({ zkOnly })
      const r = await app.request(path)
      expect(r.status, path).toBe(status)
      expect(r.headers.get('content-security-policy'), path).toContain("default-src 'self'")
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff')
    }
    process.env.NODE_ENV = 'production'
    try {
      const r = await mod.createApp({ zkOnly: true }).request('/api/me')
      expect(r.status).toBe(401)
      expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    } finally {
      process.env.NODE_ENV = 'test'
    }
  })

  it("style-src is 'self' alone when there is no built index.html to hash", async () => {
    const r = await mod.createApp({ zkOnly: false }).request('/api/health')
    expect(r.headers.get('content-security-policy')).toContain("style-src 'self';")
  })
})

describe('/api/health build', () => {
  it('reports the build it was given, in both modes, and null without one', async () => {
    const build = { repo: 'https://github.com/o/r', commit: COMMIT, tag: 'v1.0.0' }
    for (const zkOnly of [true, false]) {
      const r = await mod.createApp({ zkOnly, build }).request('/api/health')
      expect(await r.json()).toMatchObject({ ok: true, build })
    }
    const r = await mod.createApp({ zkOnly: true }).request('/api/health')
    expect(((await r.json()) as { build: unknown }).build).toBeNull()
  })
})
