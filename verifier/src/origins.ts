/**
 * The configured origins (chrome.storage.local) and the content scripts that
 * go with them. scarab.one's content script is in the manifest; every other
 * origin the user adds is registered at run time (chrome.scripting), after
 * the user grants the extension that host. Shared by the worker (which
 * re-registers at startup) and the settings page (which adds and removes).
 */
import { DEFAULT_ORIGIN, withDefaults, type OriginSetting } from './verify.js'

const KEY = 'origins'
const SCRIPT_ID = (origin: string) => `scarab-verify:${origin}`

export async function loadOrigins(): Promise<OriginSetting[]> {
  const stored = await chrome.storage.local.get(KEY)
  return withDefaults(stored[KEY])
}

export async function saveOrigins(origins: OriginSetting[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: withDefaults(origins) })
  await syncContentScripts()
}

/** The match pattern for everything on an origin. */
export const matchPattern = (origin: string): string => `${origin}/*`

/**
 * Make the registered content scripts match the configured origins: one
 * script per origin other than scarab.one, none for an origin that is gone. A
 * registration the browser refuses (its host permission was revoked in
 * chrome://extensions) is reported, not fatal: the other origins still work.
 */
export async function syncContentScripts(): Promise<string[]> {
  const problems: string[] = []
  const want = (await loadOrigins()).filter((o) => o.origin !== DEFAULT_ORIGIN)
  const have = await chrome.scripting.getRegisteredContentScripts()
  const stale = have.filter((s) => s.id.startsWith('scarab-verify:') && !want.some((o) => SCRIPT_ID(o.origin) === s.id)).map((s) => s.id)
  if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale })
  for (const o of want) {
    if (have.some((s) => s.id === SCRIPT_ID(o.origin))) continue
    try {
      await chrome.scripting.registerContentScripts([
        { id: SCRIPT_ID(o.origin), matches: [matchPattern(o.origin)], js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true },
      ])
    } catch (e) {
      problems.push(`${o.origin}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return problems
}
