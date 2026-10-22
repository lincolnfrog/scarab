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

/**
 * An origin to check and where its attested manifests come from. The source
 * is never read from the site: a server that could name its own trust anchor
 * (a fork whose release lists the hashes of the bundle it serves) would make
 * the check worthless. For scarab.one it is fixed in this file; for a
 * self-hosted site the user types it when adding the origin.
 */
export type OriginSetting = {
  /** `https://host[:port]`, nothing after it. */
  origin: string
  /** The GitHub repository whose releases carry build.json: `https://github.com/owner/name`. */
  repo: string | null
  /**
   * Instead of (or as well as) the repository: where the attested manifest
   * is, with `{tag}` standing for the release tag — for releases that are
   * not on GitHub. Takes precedence over `repo` for the address.
   */
  manifest: string | null
}

export const DEFAULT_ORIGIN = 'https://scarab.one'
/** The trust anchor for scarab.one: this repository's releases. Not a setting. */
export const PINNED_REPO = 'https://github.com/lincolnfrog/scarab'
export const BUILT_IN: OriginSetting = Object.freeze({ origin: DEFAULT_ORIGIN, repo: PINNED_REPO, manifest: null })
export const SHELL = 'index.html'

const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/
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
 * Where the attested manifest for the release the site names is: the origin's
 * configured address with `{tag}` filled in, or the release asset of its
 * configured repository. The only thing taken from the site is the tag —
 * which release to compare with — and the popup shows it. A site that names
 * no release (a build from source: `tag: null`) cannot be checked against one.
 */
export function manifestUrl(served: BuildInfo, setting: OriginSetting): { url: string } | { reason: string } {
  if (setting.manifest) {
    if (setting.manifest.includes('{tag}') && !served.tag) return { reason: NO_TAG }
    return { url: setting.manifest.replaceAll('{tag}', encodeURIComponent(served.tag ?? '')) }
  }
  if (!setting.repo) return { reason: `no manifest source for ${setting.origin}: set its repository or a manifest address in the extension's settings` }
  if (!served.tag) return { reason: NO_TAG }
  return { url: `${setting.repo}/releases/download/${encodeURIComponent(served.tag)}/build.json` }
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
/**
 * Is this document the app's shell? The app lives at `/` (hash routes); a
 * top-level visit to `/api/health` or `/build.json` on the same origin is a
 * page of the server, not of the app, and the manifest says nothing about it.
 */
export function isAppDocument(url: string, origin: string): boolean {
  return assetPath(url, origin) === SHELL
}

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
  /** The document's load event has fired: the shell's own references are all in. */
  loaded: boolean
}

/** The release a document is checked against, resolved once per document. */
export type Release = {
  /** The configured repository (pinned for scarab.one): the trust anchor, and where the popup's links go. */
  repo: string | null
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
  /** A report made after the document's load event has been judged: before that, the verdict is "checking" however the files look. */
  loaded: boolean
  verdict: Verdict
  reason: string | null
  /** Provenance the site and the attestation disagree about: the files decide, the popup says. */
  notes: string[]
  /** What should not happen on an honest server: the site naming another repository than the one it is checked against. */
  warnings: string[]
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
 * manifest nothing is proven; and nothing is green before the document has
 * loaded — the first reports carry the shell alone, and a check that said ✓
 * on those would be vouching for chunks it had not seen.
 */
export function verdict(files: FileResult[], hasManifest: boolean, loaded: boolean): Verdict {
  if (files.some((f) => FAILING.has(f.status))) return 'fail'
  if (!hasManifest) return 'unverifiable'
  if (!loaded) return 'checking'
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

/**
 * The site naming a repository other than the one it is checked against. The
 * files still decide — they are compared with the configured repository's
 * release, whatever the site says — but an honest server has no reason to
 * say this, so it goes on the badge and in the popup.
 */
export function releaseWarnings(served: BuildInfo, setting: OriginSetting): string[] {
  if (served.repo && setting.repo && served.repo !== setting.repo)
    return [`the site says it was built from ${served.repo}; this extension checks it against ${setting.repo}, and will not follow the site's choice`]
  return []
}

export const shortCommit = (commit: string): string => commit.slice(0, 7)
export const isCommit = (s: string | null): s is string => s !== null && HEX40.test(s)

/* ---------- settings ---------- */

/** `https://host[:port]` from whatever was typed, or null when it is not an http(s) address. */
export function normalizeOrigin(input: string): string | null {
  const u = parseUrl(input.trim())
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null
  return u.origin
}

/** `https://github.com/owner/name` from whatever was typed (a trailing slash or .git dropped), or null. */
export function normalizeRepo(input: string): string | null {
  const u = parseUrl(input.trim())
  if (!u || u.protocol !== 'https:' || u.host !== 'github.com') return null
  const repo = `https://github.com${u.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`
  return GITHUB_REPO.test(repo) ? repo : null
}

/**
 * The configured origins: scarab.one first, as BUILT_IN and nothing else —
 * a stored entry for it is ignored, so no setting can move its trust anchor —
 * then every well-formed stored origin that has a source (a repository, a
 * manifest address, or both).
 */
export function withDefaults(stored: unknown): OriginSetting[] {
  const out: OriginSetting[] = [BUILT_IN]
  if (!Array.isArray(stored)) return out
  for (const item of stored) {
    if (!item || typeof item !== 'object') continue
    const { origin, repo, manifest } = item as Record<string, unknown>
    if (typeof origin !== 'string' || normalizeOrigin(origin) !== origin || origin === DEFAULT_ORIGIN) continue
    const setting: OriginSetting = {
      origin,
      repo: typeof repo === 'string' && normalizeRepo(repo) === repo ? repo : null,
      manifest: typeof manifest === 'string' && manifest !== '' ? manifest : null,
    }
    if (!setting.repo && !setting.manifest) continue
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
