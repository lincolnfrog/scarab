import { describe, expect, it } from 'vitest'
import {
  BUILT_IN,
  PINNED_REPO,
  assetPath,
  describeFetchFailure,
  isAppDocument,
  isBuildResource,
  judgeFile,
  manifestUrl,
  normalizeOrigin,
  normalizeRepo,
  parseBuildInfo,
  parseManifest,
  releaseNotes,
  releaseWarnings,
  settingFor,
  unchecked,
  verdict,
  withDefaults,
  type FileResult,
  type Manifest,
  type OriginSetting,
} from './verify'

const ORIGIN = 'https://scarab.one'
const h = (c: string) => c.repeat(64)
const COMMIT = 'a'.repeat(40)

const manifest: Manifest = {
  repo: 'https://github.com/lincolnfrog/scarab',
  commit: COMMIT,
  tag: 'v0.1.0',
  assets: {
    'index.html': h('1'),
    'assets/index-F8Zq7wxi.js': h('2'),
    'assets/index-DcDcj1Qm.css': h('3'),
    'assets/sql-wasm-CZ6DqAhB.wasm': h('4'),
    'manifest.webmanifest': h('5'),
    'icons/icon-192.png': h('6'),
  },
}
const text = JSON.stringify(manifest)

describe('parseManifest (the attested build.json)', () => {
  it('reads the provenance and every asset hash', () => {
    expect(parseManifest(text)).toEqual(manifest)
  })
  it('treats missing provenance as null, not as a string', () => {
    const m = parseManifest(JSON.stringify({ assets: manifest.assets, tag: '', commit: null }))
    expect(m).toEqual({ repo: null, commit: null, tag: null, assets: manifest.assets })
  })
  it('refuses the SPA shell answered with a 200, a 404 page, an array and malformed JSON', () => {
    expect(parseManifest('<!doctype html><html></html>')).toBeNull()
    expect(parseManifest('Not Found')).toBeNull()
    expect(parseManifest('[]')).toBeNull()
    expect(parseManifest('{"assets": ')).toBeNull()
    expect(parseManifest('')).toBeNull()
  })
  it('refuses a manifest with a bad hash, an absolute path, or no index.html', () => {
    expect(parseManifest(JSON.stringify({ assets: { 'index.html': 'abc' } }))).toBeNull()
    expect(parseManifest(JSON.stringify({ assets: { 'index.html': h('1'), '/assets/x.js': h('2') } }))).toBeNull()
    expect(parseManifest(JSON.stringify({ assets: { 'assets/x.js': h('2') } }))).toBeNull()
    expect(parseManifest(JSON.stringify({ assets: [] }))).toBeNull()
    expect(parseManifest(JSON.stringify({ assets: { 'index.html': h('A') } }))).toBeNull() // upper-case hex is not what the build writes
  })
})

describe('parseBuildInfo (what the site says it serves)', () => {
  it('reads tag, commit and repository, null when absent', () => {
    expect(parseBuildInfo(text)).toEqual({ repo: manifest.repo, commit: COMMIT, tag: 'v0.1.0' })
    expect(parseBuildInfo('{"commit": "abc"}')).toEqual({ repo: null, commit: 'abc', tag: null })
    expect(parseBuildInfo('{}')).toEqual({ repo: null, commit: null, tag: null })
  })
  it('is null for the shell (an unknown path comes back as index.html with a 200)', () => {
    expect(parseBuildInfo('<!doctype html>')).toBeNull()
    expect(parseBuildInfo('null')).toBeNull()
  })
})

describe('manifestUrl (where the attested copy is: the setting says, never the site)', () => {
  const served = { repo: PINNED_REPO, commit: COMMIT, tag: 'v0.1.0' }
  const PINNED_URL = 'https://github.com/lincolnfrog/scarab/releases/download/v0.1.0/build.json'
  it('is the configured repository\'s release asset for the tag the site names', () => {
    expect(manifestUrl(served, BUILT_IN)).toEqual({ url: PINNED_URL })
    expect(manifestUrl(served, { origin: 'https://my.example', repo: 'https://github.com/me/scarab', manifest: null })).toEqual({
      url: 'https://github.com/me/scarab/releases/download/v0.1.0/build.json',
    })
  })
  it('does not follow the repository the site names: a fork whose release lists a poisoned bundle is not a trust anchor', () => {
    expect(manifestUrl({ ...served, repo: 'https://github.com/attacker/scarab' }, BUILT_IN)).toEqual({ url: PINNED_URL })
    expect(manifestUrl({ ...served, repo: 'https://evil.example/x' }, BUILT_IN)).toEqual({ url: PINNED_URL })
    expect(manifestUrl({ ...served, repo: null }, BUILT_IN)).toEqual({ url: PINNED_URL })
  })
  it('fills {tag} into a configured address, encoded; the address wins over the repository', () => {
    const at = (manifest: string, repo: string | null = null): OriginSetting => ({ origin: 'https://my.example', repo, manifest })
    expect(manifestUrl({ ...served, tag: 'v1/rc 1' }, at('https://releases.example/{tag}/build.json'))).toEqual({ url: 'https://releases.example/v1%2Frc%201/build.json' })
    expect(manifestUrl(served, at('https://releases.example/build.json'))).toEqual({ url: 'https://releases.example/build.json' })
    expect(manifestUrl(served, at('https://releases.example/{tag}/build.json', 'https://github.com/me/scarab'))).toEqual({ url: 'https://releases.example/v0.1.0/build.json' })
  })
  it('cannot name a release when the site does not', () => {
    const r = manifestUrl({ ...served, tag: null }, BUILT_IN)
    expect('reason' in r && r.reason).toMatch(/no release/)
    const t = manifestUrl({ ...served, tag: null }, { origin: 'https://my.example', repo: null, manifest: 'https://releases.example/{tag}/build.json' })
    expect('reason' in t && t.reason).toMatch(/no release/)
  })
  it('needs a source for a self-hosted origin', () => {
    const r = manifestUrl(served, { origin: 'https://my.example', repo: null, manifest: null })
    expect('reason' in r && r.reason).toMatch(/settings/)
  })
})

describe('releaseWarnings (the site naming another repository)', () => {
  it('warns when the site says it was built elsewhere than the configured repository', () => {
    const w = releaseWarnings({ repo: 'https://github.com/attacker/scarab', commit: COMMIT, tag: 'v0.1.0' }, BUILT_IN)
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('attacker/scarab')
    expect(w[0]).toContain(PINNED_REPO)
  })
  it('says nothing when they agree, when the site names none, or when the origin is checked by address only', () => {
    expect(releaseWarnings({ repo: PINNED_REPO, commit: COMMIT, tag: 'v0.1.0' }, BUILT_IN)).toEqual([])
    expect(releaseWarnings({ repo: null, commit: COMMIT, tag: 'v0.1.0' }, BUILT_IN)).toEqual([])
    expect(releaseWarnings({ repo: 'https://github.com/attacker/scarab', commit: COMMIT, tag: 'v0.1.0' }, { origin: 'https://my.example', repo: null, manifest: 'https://m.example/{tag}' })).toEqual([])
  })
})

describe('isBuildResource / assetPath (URL → path under dist/)', () => {
  it('maps the root document and /index.html to index.html', () => {
    expect(assetPath('https://scarab.one/', ORIGIN)).toBe('index.html')
    expect(assetPath('https://scarab.one', ORIGIN)).toBe('index.html')
    expect(assetPath('https://scarab.one/?x=1', ORIGIN)).toBe('index.html')
    expect(assetPath('https://scarab.one/index.html', ORIGIN)).toBe('index.html')
  })
  it('maps hashed assets, the web manifest and icons to their paths', () => {
    expect(assetPath('https://scarab.one/assets/index-F8Zq7wxi.js', ORIGIN)).toBe('assets/index-F8Zq7wxi.js')
    expect(assetPath('https://scarab.one/assets/sql-wasm-CZ6DqAhB.wasm', ORIGIN)).toBe('assets/sql-wasm-CZ6DqAhB.wasm')
    expect(assetPath('https://scarab.one/manifest.webmanifest', ORIGIN)).toBe('manifest.webmanifest')
    expect(assetPath('https://scarab.one/icons/icon-192.png', ORIGIN)).toBe('icons/icon-192.png')
    expect(assetPath('https://scarab.one/assets/a%20b.js', ORIGIN)).toBe('assets/a b.js')
  })
  it('ignores the fragment and keeps an SPA route distinct from the shell', () => {
    expect(assetPath('https://scarab.one/#/invest', ORIGIN)).toBe('index.html')
    expect(assetPath('https://scarab.one/somewhere', ORIGIN)).toBe('somewhere') // not in the manifest: the server's fallback shell is "missing", not the shell
  })
  it('knows the app\'s own page from a page of the server', () => {
    expect(isAppDocument('https://scarab.one/', ORIGIN)).toBe(true)
    expect(isAppDocument('https://scarab.one/#/invest', ORIGIN)).toBe(true)
    expect(isAppDocument('https://scarab.one/index.html', ORIGIN)).toBe(true)
    expect(isAppDocument('https://scarab.one/api/health', ORIGIN)).toBe(false)
    expect(isAppDocument('https://scarab.one/build.json', ORIGIN)).toBe(false)
    expect(isAppDocument('https://scarab.one/icons/icon-192.png', ORIGIN)).toBe(false)
    expect(isAppDocument('https://evil.example/', ORIGIN)).toBe(false)
  })
  it('is null off the origin', () => {
    expect(assetPath('https://evil.example/assets/x.js', ORIGIN)).toBeNull()
    expect(assetPath('http://scarab.one/', ORIGIN)).toBeNull()
    expect(assetPath('data:text/javascript,1', ORIGIN)).toBeNull()
    expect(assetPath('not a url', ORIGIN)).toBeNull()
  })
  it('counts files of the build and not the API, the manifest, or other origins', () => {
    expect(isBuildResource('https://scarab.one/assets/x.js', ORIGIN)).toBe(true)
    expect(isBuildResource('https://scarab.one/', ORIGIN)).toBe(true)
    expect(isBuildResource('https://scarab.one/api/vault', ORIGIN)).toBe(false)
    expect(isBuildResource('https://scarab.one/api/basket/history', ORIGIN)).toBe(false)
    expect(isBuildResource('https://scarab.one/build.json', ORIGIN)).toBe(false)
    expect(isBuildResource('https://evil.example/x.js', ORIGIN)).toBe(false)
    expect(isBuildResource('blob:https://scarab.one/abc', ORIGIN)).toBe(false)
  })
})

describe('judgeFile', () => {
  const js = 'https://scarab.one/assets/index-F8Zq7wxi.js'
  it('ok when the hash matches and the page saw the same number of bytes', () => {
    const r = judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 1000, fetched: { sha256: h('2'), size: 1000 }, manifest })
    expect(r.status).toBe('ok')
    expect(r.note).toBeNull()
    expect(r.expected).toBe(h('2'))
  })
  it('ok, with a note, when the page did not report a size', () => {
    expect(judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 0, fetched: { sha256: h('2'), size: 1000 }, manifest })).toMatchObject({ status: 'ok', observedSize: null, note: expect.stringMatching(/size/) })
    expect(judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: null, fetched: { sha256: h('2'), size: 1000 }, manifest }).status).toBe('ok')
  })
  it('mismatch when the bytes hash to something else', () => {
    expect(judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 1000, fetched: { sha256: h('f'), size: 1000 }, manifest }).status).toBe('mismatch')
  })
  it('size-differs when the hash is right but the page received another number of bytes: two answers to one URL', () => {
    const r = judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 999, fetched: { sha256: h('2'), size: 1000 }, manifest })
    expect(r.status).toBe('size-differs')
    expect(r.note).toContain('999')
    expect(r.note).toContain('1000')
  })
  it('not-in-manifest for a file the release does not ship, naming the shell when the server has no such file either', () => {
    const extra = 'https://scarab.one/assets/evil-123.js'
    expect(judgeFile({ url: extra, path: 'assets/evil-123.js', observedSize: 10, fetched: { sha256: h('e'), size: 10 }, manifest })).toMatchObject({ status: 'not-in-manifest', expected: null })
    expect(judgeFile({ url: extra, path: 'assets/evil-123.js', observedSize: 10, fetched: { sha256: h('1'), size: 10 }, manifest })).toMatchObject({ status: 'not-in-manifest', note: expect.stringMatching(/shell/) })
  })
  it('shell when a listed file is missing and the SPA fallback answered with index.html', () => {
    const r = judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 1000, fetched: { sha256: h('1'), size: 700 }, manifest })
    expect(r.status).toBe('shell')
  })
  it('the document itself is judged as index.html, and the shell is never "missing"', () => {
    expect(judgeFile({ url: 'https://scarab.one/', path: 'index.html', observedSize: 700, fetched: { sha256: h('1'), size: 700 }, manifest }).status).toBe('ok')
    expect(judgeFile({ url: 'https://scarab.one/', path: 'index.html', observedSize: 700, fetched: { sha256: h('9'), size: 700 }, manifest }).status).toBe('mismatch')
  })
  it('unreachable when the re-fetch failed, with the reason', () => {
    const r = judgeFile({ url: js, path: 'assets/index-F8Zq7wxi.js', observedSize: 1000, fetched: { error: 'HTTP 404' }, manifest })
    expect(r).toMatchObject({ status: 'unreachable', note: 'HTTP 404', sha256: null, fetchedSize: null })
  })
})

describe('verdict', () => {
  const ok = (path: string): FileResult => ({ url: `${ORIGIN}/${path}`, path, status: 'ok', observedSize: 1, fetchedSize: 1, sha256: h('1'), expected: h('1'), note: null })
  const as = (status: FileResult['status'], path = 'assets/x.js'): FileResult => ({ ...ok(path), status })
  it('ok only when every file is, and the document has loaded', () => {
    expect(verdict([ok('index.html'), ok('assets/a.js')], true, true)).toBe('ok')
  })
  it('is still checking before the document has loaded, however the files look: the shell alone proves nothing about its chunks', () => {
    expect(verdict([ok('index.html')], true, false)).toBe('checking')
    expect(verdict([ok('index.html'), ok('assets/a.js'), ok('assets/b.css')], true, false)).toBe('checking')
    expect(verdict([ok('index.html'), as('unreachable')], true, false)).toBe('checking')
  })
  it('fails on any failing file, loaded or not, even when others could not be checked', () => {
    expect(verdict([ok('index.html'), as('mismatch')], true, true)).toBe('fail')
    expect(verdict([ok('index.html'), as('mismatch')], true, false)).toBe('fail')
    expect(verdict([ok('index.html'), as('not-in-manifest')], true, true)).toBe('fail')
    expect(verdict([ok('index.html'), as('shell')], true, true)).toBe('fail')
    expect(verdict([ok('index.html'), as('size-differs'), as('unreachable', 'assets/y.js')], true, true)).toBe('fail')
  })
  it('is unverifiable without a manifest, or when a file could not be re-fetched', () => {
    expect(verdict([unchecked(`${ORIGIN}/`, 'index.html', 700)], false, true)).toBe('unverifiable')
    expect(verdict([unchecked(`${ORIGIN}/`, 'index.html', 700)], false, false)).toBe('unverifiable')
    expect(verdict([], false, true)).toBe('unverifiable')
    expect(verdict([ok('index.html'), as('unreachable')], true, true)).toBe('unverifiable')
  })
  it('is still checking with nothing judged yet', () => {
    expect(verdict([], true, true)).toBe('checking')
    expect(verdict([ok('index.html'), as('unchecked')], true, true)).toBe('checking')
  })
})

describe('releaseNotes', () => {
  it('says nothing when the claim and the attestation agree', () => {
    expect(releaseNotes({ repo: manifest.repo, commit: COMMIT, tag: 'v0.1.0' }, manifest)).toEqual([])
    expect(releaseNotes({ repo: null, commit: null, tag: null }, manifest)).toEqual([])
  })
  it('notes a commit or tag that differs, and leaves the files to decide', () => {
    const notes = releaseNotes({ repo: null, commit: 'b'.repeat(40), tag: 'v0.0.9' }, manifest)
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('bbbbbbb')
    expect(notes[0]).toContain('aaaaaaa')
    expect(notes[1]).toContain('v0.0.9')
  })
})

describe('settings', () => {
  it('normalizes what was typed to an origin', () => {
    expect(normalizeOrigin(' https://scarab.example/some/path?x ')).toBe('https://scarab.example')
    expect(normalizeOrigin('http://localhost:8787')).toBe('http://localhost:8787')
    expect(normalizeOrigin('HTTPS://Scarab.Example:443/')).toBe('https://scarab.example')
    expect(normalizeOrigin('scarab.example')).toBeNull()
    expect(normalizeOrigin('ftp://x')).toBeNull()
    expect(normalizeOrigin('chrome://extensions')).toBeNull()
  })
  it('normalizes a GitHub repository, and nothing else', () => {
    expect(normalizeRepo('https://github.com/me/scarab')).toBe('https://github.com/me/scarab')
    expect(normalizeRepo(' https://github.com/me/scarab.git/ ')).toBe('https://github.com/me/scarab')
    expect(normalizeRepo('https://github.com/me/scarab/releases')).toBeNull()
    expect(normalizeRepo('https://github.com/me')).toBeNull()
    expect(normalizeRepo('http://github.com/me/scarab')).toBeNull()
    expect(normalizeRepo('https://gitea.example/me/scarab')).toBeNull()
    expect(normalizeRepo('me/scarab')).toBeNull()
  })
  it('always starts with scarab.one pinned to its repository, whatever is stored for it', () => {
    expect(withDefaults(undefined)).toEqual([BUILT_IN])
    expect(BUILT_IN).toEqual({ origin: 'https://scarab.one', repo: PINNED_REPO, manifest: null })
    // a stored entry for scarab.one cannot move its trust anchor: it is ignored, not merged
    expect(withDefaults([{ origin: 'https://scarab.one', repo: 'https://github.com/attacker/scarab', manifest: null }])).toEqual([BUILT_IN])
    expect(withDefaults([{ origin: 'https://scarab.one', repo: null, manifest: 'https://m.example/{tag}' }])).toEqual([BUILT_IN])
  })
  it('keeps well-formed stored origins that have a source, and drops the rest', () => {
    expect(
      withDefaults([
        { origin: 'https://my.example', repo: 'https://github.com/me/scarab', manifest: null },
        { origin: 'https://other.example', repo: null, manifest: 'https://other.example/releases/{tag}/build.json' },
        { origin: 'https://both.example', repo: 'https://github.com/me/scarab', manifest: 'https://m.example/{tag}' },
        { origin: 'https://none.example', repo: null, manifest: null }, // no source: nothing to check against
        { origin: 'https://bad.example', repo: 'https://gitea.example/me/scarab', manifest: null }, // not a GitHub repository
        { origin: 'nope', repo: 'https://github.com/me/scarab' },
        7,
        { origin: 'https://a.example/path', repo: 'https://github.com/me/scarab' },
      ]),
    ).toEqual([
      BUILT_IN,
      { origin: 'https://my.example', repo: 'https://github.com/me/scarab', manifest: null },
      { origin: 'https://other.example', repo: null, manifest: 'https://other.example/releases/{tag}/build.json' },
      { origin: 'https://both.example', repo: 'https://github.com/me/scarab', manifest: 'https://m.example/{tag}' },
    ])
  })
  it('finds the setting a page URL belongs to', () => {
    const origins = withDefaults([{ origin: 'http://localhost:8787', repo: 'https://github.com/me/scarab', manifest: null }])
    expect(settingFor('https://scarab.one/#/invest', origins)).toBe(BUILT_IN)
    expect(settingFor('http://localhost:8787/', origins)?.origin).toBe('http://localhost:8787')
    expect(settingFor('http://localhost:8788/', origins)).toBeNull()
    expect(settingFor('https://evil.example/', origins)).toBeNull()
    expect(settingFor('garbage', origins)).toBeNull()
  })
})

describe('describeFetchFailure', () => {
  it('names a sign-in redirect, a status, and an error', () => {
    expect(describeFetchFailure({ type: 'opaqueredirect', status: 0, ok: false })).toMatch(/signed out/)
    expect(describeFetchFailure({ type: 'basic', status: 404, ok: false })).toBe('HTTP 404')
    expect(describeFetchFailure(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
  })
})
