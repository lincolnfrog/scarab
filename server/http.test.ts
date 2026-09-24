import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../engine/errors'
import { onError, restoreRefusal } from './http'

describe('onError: what a handler throws, as JSON { error }', () => {
  afterEach(() => vi.restoreAllMocks())
  const app = new Hono()
  app.onError(onError)
  app.get('/api-error', () => {
    throw new ApiError(404, 'no such thing')
  })
  app.get('/bug', () => {
    throw new TypeError("Cannot read properties of null (reading 'secret_column')")
  })
  app.get('/http', () => {
    throw new HTTPException(418, { res: new Response('teapot', { status: 418 }) })
  })

  it('keeps an ApiError’s status and message', async () => {
    const r = await app.request('/api-error')
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: 'no such thing' })
  })

  it('answers the server’s own failure 500, as JSON, without its internals — and logs it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = await app.request('/bug')
    expect(r.status).toBe(500)
    expect(r.headers.get('content-type')).toMatch(/json/)
    const body = (await r.json()) as { error: string }
    expect(body.error).toBe('internal server error — see the server log')
    expect(body.error).not.toMatch(/secret_column/)
    expect(log).toHaveBeenCalledOnce()
  })

  it('lets an HTTPException answer with its own response', async () => {
    const r = await app.request('/http')
    expect(r.status).toBe(418)
    expect(await r.text()).toBe('teapot')
  })
})

describe('restoreRefusal: the file’s fault, or the server’s', () => {
  it('passes loadDump’s own refusals (plain Errors) through as written', () => {
    expect(restoreRefusal(new Error('snapshot has an unknown column: accounts.bogus_col'))).toBe('snapshot has an unknown column: accounts.bogus_col')
  })

  it('names a row the schema rejects', () => {
    const db = new Database(':memory:')
    db.exec("CREATE TABLE t (name TEXT NOT NULL, kind TEXT CHECK (kind IN ('a')))")
    const thrown = (sql: string) => {
      try {
        db.exec(sql)
      } catch (e) {
        return e
      }
      throw new Error('expected a throw')
    }
    expect(restoreRefusal(thrown('INSERT INTO t (kind) VALUES (NULL)'))).toBe(
      "the snapshot's rows don't fit this database: NOT NULL constraint failed: t.name",
    )
    expect(restoreRefusal(thrown("INSERT INTO t (name, kind) VALUES ('x', 'b')"))).toMatch(/^the snapshot's rows don't fit this database: CHECK constraint failed/)
    // Other SQLite failures are the server's (a syntax error here stands in for a full disk or a locked file).
    expect(restoreRefusal(thrown('INSERT INTO nowhere VALUES (1)'))).toBeNull()
  })

  it('leaves bugs and ApiErrors to app.onError', () => {
    expect(restoreRefusal(new TypeError('x is undefined'))).toBeNull()
    expect(restoreRefusal(new ApiError(400, 'bad'))).toBeNull()
    expect(restoreRefusal('a string')).toBeNull()
  })
})
