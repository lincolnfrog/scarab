/**
 * Scarab Verify — the service worker: the part that checks.
 *
 * For each report from a tab's content script (content.ts) it fetches the
 * site's /build.json (as the page: credentials included, no cache) to learn
 * which release the site claims to serve, fetches that release's attested
 * manifest from GitHub — another origin, one the site cannot answer for —
 * then re-fetches every URL the page loaded, hashes the bytes with SubtleCrypto
 * and compares (verify.ts). The result goes on the toolbar badge and into
 * chrome.storage.session for the popup.
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
  judgeFile,
  manifestUrl,
  parseBuildInfo,
  parseManifest,
  releaseNotes,
  settingFor,
  shortCommit,
  unchecked,
  verdict,
  type BuildInfo,
  type Fetched,
  type FileResult,
  type Release,
  type Report,
  type TabState,
  type Verdict,
} from './verify.js'

const key = (tabId: number) => `tab:${tabId}`

/* ---------- messages ---------- */

const queues = new Map<number, Promise<void>>()

/** One check at a time per tab: reports arrive in bursts, and each must see the previous one's fetches. */
function enqueue(tabId: number, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(tabId) ?? Promise.resolve()).then(job).catch((e: unknown) => console.error('scarab-verify:', e))
  queues.set(tabId, next)
  return next
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const m = message as { type?: unknown; tabId?: unknown }
  if (m?.type === 'observed' && sender.tab?.id !== undefined) {
    const tabId = sender.tab.id
    const report = message as Report
    if (sender.url && !sender.url.startsWith(`${report.origin}/`)) return // a report can only be about the page that sent it
    void enqueue(tabId, () => onReport(tabId, report))
    return
  }
  if (m?.type === 'recheck' && typeof m.tabId === 'number') {
    const tabId = m.tabId
    void enqueue(tabId, () => recheck(tabId)).then(() => reply(true))
    return true // the reply comes later
  }
})

// Leaving a configured origin clears the badge; a configured origin's new document replaces its own state (docId).
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'loading') return
  void loadOrigins().then(async (origins) => {
    if (tab.url && settingFor(tab.url, origins)) return
    await chrome.storage.session.remove(key(tabId))
    await chrome.action.setBadgeText({ tabId, text: '' })
    await chrome.action.setTitle({ tabId, title: 'Scarab Verify' })
  })
})
chrome.tabs.onRemoved.addListener((tabId) => {
  queues.delete(tabId)
  void chrome.storage.session.remove(key(tabId))
})

// Self-hosted origins: their content scripts are registered, not in the manifest. Re-sync whenever the worker starts.
chrome.runtime.onInstalled.addListener(() => void syncContentScripts())
chrome.runtime.onStartup.addListener(() => void syncContentScripts())

/* ---------- the check ---------- */

async function onReport(tabId: number, report: Report): Promise<void> {
  const origins = await loadOrigins()
  const setting = settingFor(report.origin + '/', origins)
  if (!setting || setting.origin !== report.origin) return // not an origin the user asked to check
  let state = (await load(tabId)) ?? null
  if (!state || state.docId !== report.docId) {
    state = { docId: report.docId, origin: report.origin, url: report.document.url, release: null, fetched: {}, files: [], verdict: 'checking', reason: null, notes: [], checkedAt: null }
    await save(tabId, state)
    await showBadge(tabId, state)
  }
  state.url = report.document.url
  if (!state.release) {
    state.release = await resolveRelease(report.origin, setting.manifest)
    await save(tabId, state)
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
  const origins = await loadOrigins()
  const setting = settingFor(report.origin + '/', origins)
  if (!setting) return
  const state: TabState = { docId: report.docId, origin: report.origin, url: report.document.url, release: null, fetched: {}, files: [], verdict: 'checking', reason: null, notes: [], checkedAt: null }
  await save(tabId, state)
  await showBadge(tabId, state)
  state.release = await resolveRelease(report.origin, setting.manifest)
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
      fetched = await fetchAndHash(r.url)
      state.fetched[r.url] = fetched
    }
    files.push(judgeFile({ url: r.url, path, observedSize: r.size, fetched, manifest }))
  }
  state.files = files
  state.verdict = verdict(files, manifest !== null)
  state.reason = manifest ? null : (state.release?.reason ?? 'no manifest')
  state.notes = state.release?.served && manifest ? releaseNotes(state.release.served, manifest) : []
  state.checkedAt = Date.now()
  await save(tabId, state)
  await showBadge(tabId, state)
}

/** The site's claim and the release's attested manifest. */
async function resolveRelease(origin: string, template: string | null): Promise<Release> {
  const none = (reason: string, served: BuildInfo | null = null): Release => ({ served, manifest: null, manifestUrl: null, reason })
  // The site's own file: as the page, and a redirect is the proxy's sign-in bounce, not a manifest to read.
  const claim = await fetchText(`${origin}/build.json`, 'include', 'manual')
  if ('error' in claim) return none(`no /build.json (${claim.error}): this server was built before the trust chain, or from source`)
  const served = parseBuildInfo(claim.text)
  if (!served) return none('no /build.json: the server answered with something that is not a manifest (a build from before the trust chain, or from source)')
  const where = manifestUrl(served, template)
  if ('reason' in where) return none(where.reason, served)
  // The attested copy: no cookies to GitHub; a self-hosted address on the site's own origin needs the page's session.
  const attested = await fetchText(where.url, new URL(where.url).origin === origin ? 'include' : 'omit', 'follow')
  if ('error' in attested) return { served, manifest: null, manifestUrl: where.url, reason: `no attested manifest at ${where.url} (${attested.error}): the release has none attached, or the address is wrong` }
  const manifest = parseManifest(attested.text)
  if (!manifest) return { served, manifest: null, manifestUrl: where.url, reason: `${where.url} is not a build manifest` }
  return { served, manifest, manifestUrl: where.url, reason: null }
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
async function save(tabId: number, state: TabState): Promise<void> {
  await chrome.storage.session.set({ [key(tabId)]: state })
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
  const release = state.release?.manifest ? `${state.release.manifest.tag ?? 'untagged'}${state.release.manifest.commit ? ` (${shortCommit(state.release.manifest.commit)})` : ''}` : null
  const title =
    state.verdict === 'ok'
      ? `Scarab Verify: ${release} — ${state.files.length} files verified`
      : state.verdict === 'fail'
        ? `Scarab Verify: NOT the attested release${release ? ` ${release}` : ''} — ${state.files.filter((f) => f.status !== 'ok').length} of ${state.files.length} files differ`
        : state.verdict === 'unverifiable'
          ? `Scarab Verify: cannot verify — ${state.reason ?? 'no manifest'}`
          : 'Scarab Verify: checking…'
  try {
    await chrome.action.setBadgeText({ tabId, text: b.text })
    await chrome.action.setBadgeBackgroundColor({ tabId, color: b.color })
    await chrome.action.setBadgeTextColor({ tabId, color: b.ink })
    await chrome.action.setTitle({ tabId, title })
  } catch {
    // the tab closed while we were checking
  }
}
