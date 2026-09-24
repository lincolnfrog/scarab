import { localDispatch, localMode } from './local'
import { isNetworkOnly } from './local/routes'

/**
 * In local mode every /api call is answered by the in-tab engine — same
 * paths, same payloads, no network — except the network-only ones
 * (src/local/routes.ts NETWORK_ONLY: the encrypted-vault courier, the shared
 * price basket, the mode probe), which always go to the server.
 */
function answeredInTab(url: string): boolean {
  if (!localMode.active || !url.startsWith('/api')) return false
  return !isNetworkOnly(new URL(url, 'http://local').pathname.slice('/api'.length))
}

/**
 * POSTs that compute over the request and write nothing — the same routes the
 * tab's table marks 'never' (src/local/dispatch.test.ts keeps the two in
 * step). POST /prices/refresh is 'never' there only because a quote can ride
 * along with the next save; on the server it rewrites prices, so it counts.
 */
export const READ_LIKE_WRITES: ReadonlySet<string> = new Set(['/scenarios/compare', '/scenarios/price', '/simulate', '/trades/preview'])

let serverWrites = 0

/**
 * Household mode's data-change signal, the counterpart of localMode.writes in
 * a tab session: how many writes this tab has landed on the household server.
 * Each one also fires 'scarab-server-write' on window (detail: the new count).
 * It sees this tab's own writes only — the other member's, and anything the
 * server does by itself, still change the ledger unseen.
 */
export const serverWriteCount = (): number => serverWrites

function noteServerWrite(url: string, method: string): void {
  if (method === 'GET' || localMode.active || !url.startsWith('/api')) return
  if (READ_LIKE_WRITES.has(new URL(url, 'http://local').pathname.slice('/api'.length))) return
  serverWrites++
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('scarab-server-write', { detail: serverWrites }))
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  if (answeredInTab(url)) {
    return localDispatch(init?.method ?? 'GET', url, init?.body ? JSON.parse(init.body as string) : undefined) as Promise<T>
  }
  const r = await fetch(url, {
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    ...init,
  })
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `${r.status} ${r.statusText}`)
  }
  noteServerWrite(url, (init?.method ?? 'GET').toUpperCase())
  return r.json() as Promise<T>
}

export const get = <T>(url: string) => req<T>(url)
export const post = <T>(url: string, body: unknown) =>
  req<T>(url, { method: 'POST', body: JSON.stringify(body) })
export const patch = <T>(url: string, body: unknown) =>
  req<T>(url, { method: 'PATCH', body: JSON.stringify(body) })
export const put = <T>(url: string, body: unknown) =>
  req<T>(url, { method: 'PUT', body: JSON.stringify(body) })
export const del = <T>(url: string) => req<T>(url, { method: 'DELETE' })
