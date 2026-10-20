/**
 * Scarab Verify — the comparison, as pure functions: no chrome.*, no fetch, no
 * clock. The service worker (worker.ts) does the fetching and hashing and
 * hands the results here; verify.test.ts drives these with the repo's vitest.
 *
 * Two manifests meet here. The *served* one is what the site answers at
 * /build.json: the release it claims to be (tag, commit, repository). The
 * *attested* one is the build.json attached to that release on GitHub — a
 * different origin the site cannot influence — listing the sha256 of every
 * file the release serves (scripts/build-manifest.mjs). A page is the release
 * when every file it loaded is in the attested manifest with that hash.
 */

export type BuildInfo = { repo: string | null; commit: string | null; tag: string | null }
export type Manifest = BuildInfo & { assets: Record<string, string> }

/** Where a page's documents and files come from, with an optional address for the attested manifest. */
export type OriginSetting = {
  /** `https://host[:port]`, nothing after it. */
  origin: string
  /**
   * Where the attested manifest for a release is, with `{tag}` standing for the
   * release tag; null means the GitHub release of the repository the site names
   * (`<repo>/releases/download/<tag>/build.json`). For a self-hosted install
   * whose releases live elsewhere.
   */
  manifest: string | null
}

export const DEFAULT_ORIGIN = 'https://scarab.one'
export const SHELL = 'index.html'

const HEX64 = /^[0-9a-f]{64}$/
const GITHUB_REPO = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/

/* ---------- the two manifests ---------- */

/**
 * The attested manifest, strictly: an object whose `assets` map paths under
 * dist/ to sha256 hex, index.html among them. Anything else — an SPA shell
 * answered with a 200, a 404 page, a hash that isn't one — is null: a file
 * that fails to parse must never pass as "nothing to check".
 */
export function parseManifest(text: string): Manifest | null {
  const m = jsonObject(text)
  if (!m) return null
  const assets = m.assets
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return null
  const out: Record<string, string> = {}
  for (const [path, hash] of Object.entries(assets)) {
    if (!path || path.startsWith('/') || typeof hash !== 'string' || !HEX64.test(hash)) return null
    out[path] = hash
  }
  if (!(SHELL in out)) return null
  return { repo: str(m.repo), commit: str(m.commit), tag: str(m.tag), assets: out }
}

/**
 * What the site says it serves: /build.json's provenance fields. Lenient
 * about the rest (the hashes that matter are the attested copy's), strict
 * about being JSON: the server answers an unknown path with the shell and a
 * 200, and that is "no manifest", not a manifest.
 */
export function parseBuildInfo(text: string): BuildInfo | null {
  const m = jsonObject(text)
  return m ? { repo: str(m.repo), commit: str(m.commit), tag: str(m.tag) } : null
}

function jsonObject(text: string): Record<string, unknown> | null {
  if (!text.trimStart().startsWith('{')) return null
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * Where the attested manifest for the release the site names should be: the
 * origin's configured address with `{tag}` filled in, or by default the
 * GitHub release asset of the repository the site names. A site that names no
 * release (a build from source: `tag: null`) cannot be checked against one.
 */
export function manifestUrl(served: BuildInfo, template: string | null | undefined): { url: string } | { reason: string } {
  if (template) {
    if (template.includes('{tag}') && !served.tag) return { reason: NO_TAG }
    return { url: template.replaceAll('{tag}', encodeURIComponent(served.tag ?? '')) }
  }
  if (!served.repo || !GITHUB_REPO.test(served.repo))
    return {
      reason: `the site names ${served.repo ? `a repository that is not on GitHub (${served.repo})` : 'no repository'} — set a manifest address for this origin in the extension's settings`,
    }
  if (!served.tag) return { reason: NO_TAG }
  return { url: `${served.repo}/releases/download/${encodeURIComponent(served.tag)}/build.json` }
}
const NO_TAG = 'the site names no release (its build.json has no tag): a build from source, not a published release'

/* ---------- what the page loaded ---------- */

/**
 * Is this URL a file of the build, as far as the manifest is concerned? Same
 * origin, and neither the API (data, not code) nor /build.json (the manifest
 * itself, which the build writes last and never lists).
 */
export function isBuildResource(url: string, origin: string): boolean {
  const u = parseUrl(url)
  return u !== null && u.origin === origin && !u.pathname.startsWith('/api/') && u.pathname !== '/build.json'
}

/**
 * The manifest path a page URL stands for: the path under dist/, decoded, with
 * the root document as index.html. Null for a URL the manifest could never
 * list (another origin, a data: URL).
 */
export function assetPath(url: string, origin: string): string | null {
  const u = parseUrl(url)
  if (!u || u.origin !== origin) return null
  let path = u.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep it encoded: it will simply not be in the manifest
  }
  path = path.replace(/^\/+/, '')
  return path === '' ? SHELL : path
}

/** An http(s) URL, or null: a blob: URL carries the page's origin but is not a file the server serves. */
function parseUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : null
  } catch {
    return null
  }
}

/* ---------- what the worker keeps ---------- */

/** What a content script reports: this document and what it loaded, with the sizes the browser saw. */
export type Report = {
  type: 'observed'
  docId: string
  origin: string
  document: { url: string; size: number }
  resources: { url: string; size: number }[]
}

/** The release a document is checked against, resolved once per document. */
export type Release = {
  /** /build.json as the site serves it; null when it has none. */
  served: BuildInfo | null
  /** The attested manifest; null with `reason` when there is none to be had. */
  manifest: Manifest | null
  manifestUrl: string | null
  reason: string | null
}

/** Everything the popup shows for one tab (chrome.storage.session, key tab:<id>). */
export type TabState = {
  docId: string
  origin: string
  url: string
  release: Release | null
  /** Each URL's re-fetch, once per document. */
  fetched: Record<string, Fetched>
  files: FileResult[]
  verdict: Verdict
  reason: string | null
  notes: string[]
  checkedAt: number | null
}

/* ---------- judging ---------- */

export type FileStatus =
  | 'ok' // hash and size as attested
  | 'mismatch' // the re-fetch returned a file with another hash
  | 'shell' // the re-fetch returned index.html: the server has no such file (its SPA fallback answers a 200)
  | 'not-in-manifest' // the page loaded a file the release does not ship
  | 'size-differs' // the hash is right but the page received a different number of bytes than the re-fetch: two answers to one URL
  | 'unreachable' // the re-fetch failed (signed out, network); nothing proven either way
  | 'unchecked' // no manifest to check against

export type FileResult = {
  url: string
  path: string
  status: FileStatus
  /** Bytes the page received for this URL, per its resource timing; null when the browser did not say. */
  observedSize: number | null
  /** Bytes the re-fetch returned. */
  fetchedSize: number | null
  sha256: string | null
  /** The attested hash, when the manifest lists the path. */
  expected: string | null
  /** One line for the table when the status alone does not say enough. */
  note: string | null
}

/** One re-fetch of a URL: its hash and length, or why there is none. */
export type Fetched = { sha256: string; size: number } | { error: string }

/** The statuses that make the page not the release. */
export const FAILING: ReadonlySet<FileStatus> = new Set(['mismatch', 'shell', 'not-in-manifest', 'size-differs'])

/**
 * One file's verdict. The hash decides first; then, for a file whose hash is
 * right, the byte count the page observed must equal what the re-fetch
 * returned — the narrowing for "the re-fetch is a second request": a server
 * that answered the page and the verifier differently would have to do it in
 * the same number of bytes.
 */
export function judgeFile(args: { url: string; path: string; observedSize: number | null; fetched: Fetched; manifest: Manifest }): FileResult {
  const { url, path, manifest, fetched } = args
  const observedSize = args.observedSize && args.observedSize > 0 ? args.observedSize : null
  const expected = manifest.assets[path] ?? null
  const base: FileResult = { url, path, status: 'unchecked', observedSize, fetchedSize: null, sha256: null, expected, note: null }
  if ('error' in fetched) return { ...base, status: 'unreachable', note: fetched.error }
  const got: FileResult = { ...base, sha256: fetched.sha256, fetchedSize: fetched.size }
  const isShell = path !== SHELL && fetched.sha256 === manifest.assets[SHELL]
  if (expected === null)
    return { ...got, status: 'not-in-manifest', note: isShell ? 'the server has no such file either: it answered with the shell' : 'the release does not ship this file' }
  if (fetched.sha256 !== expected) {
    if (isShell) return { ...got, status: 'shell', note: 'the server answered with the shell: the file is missing' }
    return { ...got, status: 'mismatch', note: null }
  }
  if (observedSize !== null && observedSize !== fetched.size)
    return { ...got, status: 'size-differs', note: `the page received ${observedSize} bytes; the re-fetch returned ${fetched.size}` }
  return { ...got, status: 'ok', note: observedSize === null ? 'size not reported by the page' : null }
}

/** A file listed before there is anything to check it against. */
export function unchecked(url: string, path: string, observedSize: number | null): FileResult {
  return { url, path, status: 'unchecked', observedSize: observedSize && observedSize > 0 ? observedSize : null, fetchedSize: null, sha256: null, expected: null, note: null }
}

export type Verdict =
  | 'ok' // every file the page loaded is the release's
  | 'fail' // at least one is not
  | 'unverifiable' // no attested manifest, or a file could not be re-fetched: nothing proven
  | 'checking'

/**
 * The page's verdict from its files. Failure wins over everything (one wrong
 * file is a wrong page, whatever else could not be checked); without a
 * manifest, or with a file nobody could fetch, nothing is proven.
 */
export function verdict(files: FileResult[], hasManifest: boolean): Verdict {
  if (files.some((f) => FAILING.has(f.status))) return 'fail'
  if (!hasManifest) return 'unverifiable'
  if (files.some((f) => f.status === 'unreachable')) return 'unverifiable'
  if (files.length === 0 || files.some((f) => f.status === 'unchecked')) return 'checking'
  return 'ok'
}

/**
 * Where the served claim and the attested manifest disagree about provenance.
 * Informational: the files decide, as in scripts/verify-served.sh.
 */
export function releaseNotes(served: BuildInfo, attested: Manifest): string[] {
  const notes: string[] = []
  if (served.commit && attested.commit && served.commit !== attested.commit)
    notes.push(`the site says commit ${shortCommit(served.commit)}; the attested manifest is for ${shortCommit(attested.commit)} — the files decide`)
  if (served.tag && attested.tag && served.tag !== attested.tag) notes.push(`the site says release ${served.tag}; the attested manifest says ${attested.tag}`)
  return notes
}

export const shortCommit = (commit: string): string => commit.slice(0, 7)

/* ---------- settings ---------- */

/** `https://host[:port]` from whatever was typed, or null when it is not an http(s) address. */
export function normalizeOrigin(input: string): string | null {
  const u = parseUrl(input.trim())
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  return u.origin
}

/** The configured origins, scarab.one always among them (its content script is in the manifest, not registered at run time). */
export function withDefaults(stored: unknown): OriginSetting[] {
  const out: OriginSetting[] = [{ origin: DEFAULT_ORIGIN, manifest: null }]
  if (!Array.isArray(stored)) return out
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue
    const { origin, manifest } = item as Record<string, unknown>
    if (typeof origin !== 'string' || normalizeOrigin(origin) !== origin) continue
    const setting: OriginSetting = { origin, manifest: typeof manifest === 'string' && manifest !== '' ? manifest : null }
    const i = out.findIndex((o) => o.origin === origin)
    if (i >= 0) out[i] = setting
    else out.push(setting)
  }
  return out
}

/** The setting for the origin a URL belongs to, if it is one the user asked to check. */
export function settingFor(url: string, origins: OriginSetting[]): OriginSetting | null {
  const u = parseUrl(url)
  return (u && origins.find((o) => o.origin === u.origin)) ?? null
}

/** A sign-in redirect, a 404, a dropped connection: one line for the table. */
export function describeFetchFailure(r: { type: string; status: number; ok: boolean } | Error): string {
  if (r instanceof Error) return r.message || 'fetch failed'
  if (r.type === 'opaqueredirect') return 'redirected — signed out? (the proxy sends a sign-in page instead of the file)'
  return `HTTP ${r.status}`
}
