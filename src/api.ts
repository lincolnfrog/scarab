import { localDispatch, localMode } from './local'

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  // In local mode everything except the vault (the encrypted-blob courier)
  // is answered by the in-tab engine. Same paths, same payloads, no network.
  if (localMode.active && url.startsWith('/api') && !url.startsWith('/api/vault')) {
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
