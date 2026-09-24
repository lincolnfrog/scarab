import type { Context, MiddlewareHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { ApiError } from '../engine/errors'

/**
 * The server's error contract: every /api failure is JSON `{ error }` with a
 * status that says whose fault it was — 4xx for the request, 500 for the
 * server. The client's req() (src/api.ts) shows `error` as written, the way
 * a tab's local dispatcher shows the same engine message.
 */

/**
 * Request bodies are JSON, parsed once before any handler runs. Every route
 * that takes a body reads it with `c.req.json()` outside handle(), so a body
 * that isn't JSON used to throw a SyntaxError there, and the body `null` a
 * TypeError on the handler's first field — both an opaque 500.
 *
 *   not JSON                          → 400, no handler runs
 *   JSON, but not an object or array  → 400 (null, a number, a string)
 *   an object or an array             → c.req.json() resolves to it
 *   empty                             → c.req.json() rejects with a 400
 *                                       ApiError: a route whose body is
 *                                       optional catches it
 *                                       (`.catch(() => ({}))`); anywhere
 *                                       else app.onError answers 400
 *
 * Runs after bodyLimits, so an oversized body is refused before it is read.
 * A route that ever needs a raw (non-JSON) body must be exempted here.
 */
export const jsonBodies: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return next()
  const text = c.req.raw.body ? await c.req.text() : ''
  if (text.trim() === '') {
    c.req.json = <T>() => Promise.reject<T>(new ApiError(400, 'request body required: a JSON object'))
    return next()
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return c.json({ error: 'request body is not valid JSON' }, 400)
  }
  if (typeof value !== 'object' || value === null) return c.json({ error: 'request body must be a JSON object or array' }, 400)
  // Handlers get this parse, not a second one (a whole-database restore is tens of MB).
  c.req.json = <T>() => Promise.resolve(value as T)
  return next()
}

/**
 * app.onError: what a handler threw, as the contract's JSON. An ApiError
 * thrown outside handle() keeps its status; anything else is the server's
 * own failure — logged, and answered 500 without its internals.
 */
export function onError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  if (err instanceof HTTPException) return err.getResponse()
  console.error(`${c.req.method} ${c.req.path} failed:`, err)
  return c.json({ error: 'internal server error — see the server log' }, 500)
}

/**
 * Why a whole-database restore was refused, when the fault is the file's; null
 * when it is the server's. loadDump (engine/snapshot.ts) refuses a snapshot it
 * can't read — not an export, a version it can't upgrade, an unknown column, a
 * malformed row or value — with a plain Error, before its first write; a row
 * the schema itself rejects (a missing NOT NULL column, a failed CHECK) comes
 * back from SQLite as a constraint error, and the transaction rolls back. Both
 * leave the data untouched and are the file's problem: 400, with the message a
 * tab restoring the same file shows.
 */
export function restoreRefusal(e: unknown): string | null {
  if (!(e instanceof Error) || e instanceof ApiError) return null
  if (Object.getPrototypeOf(e) === Error.prototype) return e.message
  const code = (e as { code?: unknown }).code
  if (e.name === 'SqliteError' && typeof code === 'string' && (code.startsWith('SQLITE_CONSTRAINT') || code === 'SQLITE_MISMATCH'))
    return `the snapshot's rows don't fit this database: ${e.message}`
  return null
}
