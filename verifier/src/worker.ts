/**
 * Scarab Verify — the service worker: the part that checks.
 *
 * For each report from a tab's content script (content.ts) it fetches the
 * site's /build.json (as the page: credentials included, no cache) to learn
 * which release the site claims to serve, fetches that release's attested
 * manifest from the origin's configured source — the pinned repository's
 * GitHub release for scarab.one; never an address the site names — then
 * re-fetches every URL the page loaded, hashes the bytes with SubtleCrypto
 * and compares (verify.ts). The result goes on the toolbar badge and into
 * chrome.storage.session for the popup.
 *
 * Everything about one tab runs on that tab's queue, clears included, so a
 * check still in flight when the tab leaves the origin cannot write its
 * result back over the cleared badge; and before it saves, a check confirms
 * the tab still shows the document it was checking.
 *
 * Requests are kept to what the check needs: each URL is fetched once per
 * document (a screen opened later adds only its own chunks), and "Check
 * again" starts over. The operator's server sees these re-fetches with the
 * same cookies as the page's own requests — the README says so.
 */
import { loadOrigins, syncContentScripts } from './origins.js'
import {
  assetPath,
  describeFetchFailure,
  isAppDocument,
  judgeFile,
  manifestUrl,
  parseBuildInfo,
  parseManifest,
  releaseNotes,
  releaseWarnings,
  settingFor,
  shortCommit,
  unchecked,
  verdict,
  type BuildInfo,
  type Fetched,
  type FileResult,
  type OriginSetting,
  type Release,
  type Report,
  type TabState,
  type Verdict,
} from './verify.js'

const key = (tabId: number) => `tab:${tabId}`

/* ---------- one queue per tab ---------- */

const queues = new Map<number, Promise<void>>()
/** The document each tab last reported, or null once it left the origin: a check for any other document is stale. */
const latest = new Map<number, string | null>()

function enqueue(tabId: number, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(job).catch((e: unknown) => console.error('scarab-verify:', e))
  queues.set(tabId, next)
  return next
}

/** Is this check about a document the tab no longer shows? Cheap, from memory; `commit` asks the tab itself as well. */
const stale = (tabId: number, docId: string): boolean => latest.has(tabId) && latest.get(tabId) !== docId

/* ---------- messages and tab events ---------- */

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const m = message as { type?: unknown; tabId?: unknown }
  if (m?.type === 'observed' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id
    const report = message as Report
    if (sender.url && !sender.url.startsWith(`${report.origin}/`)) return // a report can only be about the page that sent it
    latest.set(tabId, report.docId)
    void enqueue(tabId, () => onReport(tabId, report))
    return
  }
  if (m?.type === 'recheck' && typeof m.tabId === 'number') {
    const tabId = m.tabId
    void enqueue(tabId, () => recheck(tabId)).then(() => reply(true))
    return true // the reply comes later
  }
})

// A tab that navigates to anything but a page of a configured app is cleared — on its queue, after any check in
// flight — or, for a page of the server on a configured origin (/api/health, /build.json), marked as nothing to check.
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'loading' && change.url === undefined) return
  void (async () => {
    const url = tab.url
    const setting = url ? settingFor(url, await loadOrigins()) : null
    if (url && setting && isAppDocument(url, setting.origin)) return
    latest.set(tabId, null)
    await enqueue(tabId, () => (url && setting ? commit(tabId, notAPage(setting.origin, url)).then(() => undefined) : clear(tabId)))
  })()
})
chrome.tabs.onRemoved.addListener((tabId) => {
  latest.delete(tabId)
  queues.delete(tabId)
  void chrome.storage.session.remove(key(tabId))
})

// Self-hosted origins: their content scripts are registered, not in the manifest. Re-sync whenever the worker starts.
chrome.runtime.onInstalled.addListener(() => void syncContentScripts())
chrome.runtime.onStartup.addListener(() => void syncContentScripts())

/* ---------- the check ---------- */

function fresh(report: Report): TabState {
  return {
    docId: report.docId,
    origin: report.origin,
    url: report.document.url,
    release: null,
    fetched: {},
    files: [],
    loaded: false,
    verdict: 'checking',
    reason: null,
    notes: [],
    warnings: [],
    checkedAt: null,
  }
}

/** /api/health, /build.json: the server's, not the app's — nothing the manifest could vouch for, and nothing to accuse. */
function notAPage(origin: string, url: string): TabState {
  return {
    ...fresh({ type: 'observed', docId: 'not-a-page', origin, document: { url, size: 0 }, resources: [], loaded: true }),
    loaded: true,
    verdict: 'unverifiable',
    reason: `not a page of the app (${new URL(url).pathname}): nothing to check`,
    checkedAt: Date.now(),
  }
}

async function onReport(tabId: number, report: Report): Promise<void> {
  const setting = settingFor(`${report.origin}/`, await loadOrigins())
  if (!setting) return // not an origin the user asked to check
  if (stale(tabId, report.docId)) return
  let state = (await load(tabId)) ?? null
  if (!state || state.docId !== report.docId) {
    if (!isAppDocument(report.document.url, report.origin)) {
      await commit(tabId, notAPage(report.origin, report.document.url))
      return
    }
    state = fresh(report)
    if (!(await commit(tabId, state))) return
  }
  state.url = report.document.url
  if (!state.release) {
    state.release = await resolveRelease(report.origin, setting)
    state.warnings = state.release.served ? releaseWarnings(state.release.served, setting) : []
    if (!(await commit(tabId, state))) return
  }
  await judge(tabId, state, report)
}

/** The popup's button: a fresh list from the page, every file fetched again. */
async function recheck(tabId: number): Promise<void> {
  let report: Report
  try {
    report = (await chrome.tabs.sendMessage(tabId, { type: 'report' })) as Report
  } catch {
    return // no content script in that tab: not a configured origin, or not loaded yet
  }
  if (!report || report.type !== 'observed') return
  if (!isAppDocument(report.document.url, report.origin)) return
  const setting = settingFor(`${report.origin}/`, await loadOrigins())
  if (!setting) return
  latest.set(tabId, report.docId)
  const state = fresh(report)
  if (!(await commit(tabId, state))) return
  state.release = await resolveRelease(report.origin, setting)
  state.warnings = state.release.served ? releaseWarnings(state.release.served, setting) : []
  await judge(tabId, state, report)
}

/** Fetch what this report lists and the previous ones did not, judge every file, store and show. */
async function judge(tabId: number, state: TabState, report: Report): Promise<void> {
  const manifest = state.release?.manifest ?? null
  const files: FileResult[] = []
  for (const r of [report.document, ...report.resources]) {
    const path = assetPath(r.url, report.origin)
    if (!path) continue
    if (!manifest) {
      files.push(unchecked(r.url, path, r.size))
      continue
    }
    let fetched = state.fetched[r.url]
    if (!fetched) {
      if (stale(tabId, state.docId)) return // the tab moved on: no more requests on its behalf
      fetched = await fetchAndHash(r.url)
      state.fetched[r.url] = fetched
    }
    files.push(judgeFile({ url: r.url, path, observedSize: r.size, fetched, manifest }))
  }
  state.files = files
  state.loaded = state.loaded || report.loaded
  state.verdict = verdict(files, manifest !== null, state.loaded)
  state.reason = manifest ? null : (state.release?.reason ?? 'no manifest')
  state.notes = state.release?.served && manifest ? releaseNotes(state.release.served, manifest) : []
  state.checkedAt = Date.now()
  await commit(tabId, state)
}

/** The site's claim and the release's attested manifest, from the configured source. */
async function resolveRelease(origin: string, setting: OriginSetting): Promise<Release> {
  const none = (reason: string, served: BuildInfo | null = null): Release => ({ repo: setting.repo, served, manifest: null, manifestUrl: null, reason })
  // The site's own file: as the page, and a redirect is the proxy's sign-in bounce, not a manifest to read.
  const claim = await fetchText(`${origin}/build.json`, 'include', 'manual')
  if ('error' in claim) return none(`no /build.json (${claim.error}): this server was built before the trust chain, or from source`)
  const served = parseBuildInfo(claim.text)
  if (!served) return none('no /build.json: the server answered with something that is not a manifest (a build from before the trust chain, or from source)')
  const where = manifestUrl(served, setting)
  if ('reason' in where) return none(where.reason, served)
  // The attested copy: no cookies to GitHub; a configured address on the site's own origin needs the page's session.
  const attested = await fetchText(where.url, new URL(where.url).origin === origin ? 'include' : 'omit', 'follow')
  if ('error' in attested)
    return { ...none(`no attested manifest at ${where.url} (${attested.error}): the release has none attached, or the address is wrong`, served), manifestUrl: where.url }
  const manifest = parseManifest(attested.text)
  if (!manifest) return { ...none(`${where.url} is not a build manifest`, served), manifestUrl: where.url }
  return { repo: setting.repo, served, manifest, manifestUrl: where.url, reason: null }
}

/** As the page would: with its cookies, never from a cache, and a redirect (a sign-in bounce) is a failure, not a page to hash. */
const asPage = (credentials: RequestCredentials): RequestInit => ({ credentials, cache: 'no-store', redirect: 'manual' })

async function fetchText(url: string, credentials: RequestCredentials, redirect: RequestRedirect): Promise<{ text: string } | { error: string }> {
  try {
    const r = await fetch(url, { ...asPage(credentials), redirect })
    if (r.type === 'opaqueredirect' || !r.ok) return { error: describeFetchFailure(r) }
    return { text: await r.text() }
  } catch (e) {
    return { error: describeFetchFailure(e instanceof Error ? e : new Error(String(e))) }
  }
}

async function fetchAndHash(url: string): Promise<Fetched> {
  try {
    const r = await fetch(url, asPage('include'))
    if (r.type === 'opaqueredirect' || !r.ok) return { error: describeFetchFailure(r) }
    const bytes = await r.arrayBuffer()
    return { sha256: hex(await crypto.subtle.digest('SHA-256', bytes)), size: bytes.byteLength }
  } catch (e) {
    return { error: describeFetchFailure(e instanceof Error ? e : new Error(String(e))) }
  }
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/* ---------- state and badge ---------- */

async function load(tabId: number): Promise<TabState | undefined> {
  return (await chrome.storage.session.get(key(tabId)))[key(tabId)] as TabState | undefined
}

/**
 * Store and show, unless the tab has moved on: a later document reported, the
 * tab left the origin or the app, or the tab is gone. Then nothing is written
 * — the clear that the navigation queued stands — and false comes back.
 */
async function commit(tabId: number, state: TabState): Promise<boolean> {
  if (state.docId !== 'not-a-page' && stale(tabId, state.docId)) return false
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.get(tabId)
  } catch {
    return false // closed
  }
  if (!tab.url || new URL(tab.url).origin !== state.origin || !isAppDocument(tab.url, state.origin) !== !isAppDocument(state.url, state.origin)) return false
  await chrome.storage.session.set({ [key(tabId)]: state })
  await showBadge(tabId, state)
  return true
}

async function clear(tabId: number): Promise<void> {
  await chrome.storage.session.remove(key(tabId))
  try {
    await chrome.action.setBadgeText({ tabId, text: '' })
    await chrome.action.setTitle({ tabId, title: 'Scarab Verify' })
  } catch {
    // the tab closed
  }
}

/** Badge colours are the app's status tokens (CLAUDE.md): up for verified, down for not, ink-3 for unknown. */
const BADGE: Record<Verdict, { text: string; color: string; ink: string }> = {
  ok: { text: '✓', color: '#34c77b', ink: '#0a0d12' },
  fail: { text: '✕', color: '#e5605c', ink: '#ffffff' },
  unverifiable: { text: '?', color: '#828893', ink: '#ffffff' },
  checking: { text: '…', color: '#828893', ink: '#ffffff' },
}

async function showBadge(tabId: number, state: TabState): Promise<void> {
  const b = BADGE[state.verdict]
  const m = state.release?.manifest
  const release = m ? `${m.tag ?? 'untagged'}${m.commit ? ` (${shortCommit(m.commit)})` : ''}` : null
  let title =
    state.verdict === 'ok'
      ? `Scarab Verify: ${release} — ${state.files.length} files verified`
      : state.verdict === 'fail'
        ? `Scarab Verify: NOT the attested release${release ? ` ${release}` : ''} — ${state.files.filter((f) => f.status !== 'ok').length} of ${state.files.length} files differ`
        : state.verdict === 'unverifiable'
          ? `Scarab Verify: cannot verify — ${state.reason ?? 'no manifest'}`
          : 'Scarab Verify: checking…'
  for (const w of state.warnings) title += `\nWARNING: ${w}`
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color })
    await chrome.action.setBadgeTextColor({ tabId, color: b.ink })
    await chrome.action.setTitle({ tabId, title })
  } catch {
    // the tab closed while we were checking
  }
}
