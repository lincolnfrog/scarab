import { beforeAll, describe, expect, it } from 'vitest'
import { isNetworkOnly, loadRoutes, NETWORK_ONLY } from './routes'

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

/**
 * The server and the tab must answer the same API. Every server /api route is
 * either mirrored in the in-tab table or deliberately network-only (the vault
 * courier, the price basket, the mode probe); every in-tab route exists on the
 * server. Param names are compared as shapes ('/x/:id' ≡ '/x/:accountId') —
 * what matters is which requests reach which handler.
 */

const shape = (path: string) => path.replace(/\/:[^/]+/g, '/:')
const key = (method: string, path: string) => `${method} ${shape(path)}`

let server: Set<string>
let local: string[]
beforeAll(async () => {
  const { createApp } = await import('../../server/app')
  server = new Set(
    createApp({ zkOnly: false })
      .routes.filter((rt) => rt.method !== 'ALL' && rt.path.startsWith('/api/')) // skip middleware and the SPA fallback
      .map((rt) => key(rt.method, rt.path.slice('/api'.length))),
  )
  local = (await loadRoutes()).map((rt) => key(rt.method, rt.path))
})

const pathOf = (k: string) => k.slice(k.indexOf(' ') + 1)

describe('local route table vs server routes', () => {
  it('reads a non-trivial server table', () => {
    expect(server.size).toBeGreaterThan(50)
    expect(server).toContain('GET /invest/accounts')
    expect(server).toContain('PUT /vault')
  })

  it('declares each route once', () => {
    expect(local.filter((k, i) => local.indexOf(k) !== i)).toEqual([])
  })

  it('has no in-tab route the server lacks', () => {
    expect(local.filter((k) => !server.has(k))).toEqual([])
  })

  it('mirrors every server route that is not network-only', () => {
    const mirrored = new Set(local)
    expect([...server].filter((k) => !mirrored.has(k) && !isNetworkOnly(pathOf(k)))).toEqual([])
  })

  it('never answers a network-only path in the tab', () => {
    expect(local.filter((k) => isNetworkOnly(pathOf(k)))).toEqual([])
  })

  it('lists only network-only prefixes the server actually serves', () => {
    for (const p of NETWORK_ONLY) expect([...server].some((k) => isNetworkOnly(pathOf(k)) && pathOf(k).startsWith(p)), p).toBe(true)
  })

  it('matches network-only prefixes per segment', () => {
    expect(isNetworkOnly('/vault')).toBe(true)
    expect(isNetworkOnly('/vault/members/:')).toBe(true)
    expect(isNetworkOnly('/basket/status')).toBe(true)
    expect(isNetworkOnly('/mode')).toBe(true)
    expect(isNetworkOnly('/vaults')).toBe(false)
    expect(isNetworkOnly('/modes/x')).toBe(false)
    expect(isNetworkOnly('/me')).toBe(false)
  })
})
