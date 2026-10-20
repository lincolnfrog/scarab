import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inlineStyleHashes, readBuildInfo } from './build-info'

const SCRIPT = join(process.cwd(), 'scripts/build-manifest.mjs')
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

let dirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'scarab-build-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

/** A fake dist/: an index.html and two hashed assets. */
function fakeDist(dir: string) {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><style>\n  html { background: #000; }\n</style></head><body></body></html>\n')
  writeFileSync(join(dir, 'assets/index-abc.js'), 'console.log(1)\n')
  writeFileSync(join(dir, 'assets/index-def.css'), 'html{color:red}\n')
}

const COMMIT = 'a'.repeat(40)
const run = (dir: string, env: Record<string, string>) =>
  execFileSync(process.execPath, [SCRIPT, dir], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' })

describe('scripts/build-manifest.mjs', () => {
  it('lists every file under dist with its sha256, sorted, never itself, with the provenance it was given', () => {
    const dir = scratch()
    fakeDist(dir)
    run(dir, { SCARAB_COMMIT: COMMIT, SCARAB_TAG: 'v1.2.3', SCARAB_REPO: 'https://github.com/o/r' })
    const m = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as { repo: string; commit: string; tag: string; assets: Record<string, string> }
    expect(m.repo).toBe('https://github.com/o/r')
    expect(m.commit).toBe(COMMIT)
    expect(m.tag).toBe('v1.2.3')
    expect(Object.keys(m.assets)).toEqual(['assets/index-abc.js', 'assets/index-def.css', 'index.html'])
    expect(m.assets['assets/index-abc.js']).toBe(sha256('console.log(1)\n'))
    expect(m.assets['index.html']).toBe(sha256(readFileSync(join(dir, 'index.html'), 'utf8')))
    // Written again over the first manifest: identical, and build.json never lists itself.
    const first = readFileSync(join(dir, 'build.json'), 'utf8')
    run(dir, { SCARAB_COMMIT: COMMIT, SCARAB_TAG: 'v1.2.3', SCARAB_REPO: 'https://github.com/o/r' })
    expect(readFileSync(join(dir, 'build.json'), 'utf8')).toBe(first)
    expect(first.endsWith('\n')).toBe(true)
  })

  it('an empty variable means none — no git fallback, so a build in a context without .git is reproducible', () => {
    const dir = scratch()
    fakeDist(dir)
    run(dir, { SCARAB_COMMIT: '', SCARAB_TAG: '', SCARAB_REPO: '' })
    const m = JSON.parse(readFileSync(join(dir, 'build.json'), 'utf8')) as { repo: null; commit: null; tag: null }
    expect(m).toMatchObject({ repo: null, commit: null, tag: null })
  })

  it('refuses a commit that is not a full sha, and a dist without index.html', () => {
    const dir = scratch()
    fakeDist(dir)
    expect(() => run(dir, { SCARAB_COMMIT: 'abc1234', SCARAB_TAG: '', SCARAB_REPO: '' })).toThrow(/full 40-hex commit/)
    const empty = scratch()
    expect(() => run(empty, { SCARAB_COMMIT: COMMIT, SCARAB_TAG: '', SCARAB_REPO: '' })).toThrow(/no index\.html/)
  })
})

describe('readBuildInfo', () => {
  it('reads the manifest the build wrote, and falls back to the environment, and to null', () => {
    const dir = scratch()
    writeFileSync(join(dir, 'build.json'), JSON.stringify({ repo: 'https://github.com/o/r', commit: COMMIT, tag: null, assets: {} }))
    expect(readBuildInfo(dir, {})).toEqual({ repo: 'https://github.com/o/r', commit: COMMIT, tag: null })
    const none = scratch()
    expect(readBuildInfo(none, {})).toBeNull()
    expect(readBuildInfo(none, { SCARAB_COMMIT: COMMIT })).toEqual({ repo: null, commit: COMMIT, tag: null })
    expect(readBuildInfo(none, { SCARAB_COMMIT: '', SCARAB_TAG: '' })).toBeNull()
  })
})

describe('inlineStyleHashes', () => {
  it('hashes exactly the text between the tags, one per block, as a CSP source', () => {
    const css = '\n      html { background: #0a0d12; }\n    '
    const html = `<head><style>${css}</style><style media="print">a{}</style></head>`
    const expected = `'sha256-${createHash('sha256').update(css).digest('base64')}'`
    expect(inlineStyleHashes(html)).toEqual([expected, `'sha256-${createHash('sha256').update('a{}').digest('base64')}'`])
    expect(inlineStyleHashes('<p>no styles</p>')).toEqual([])
  })

  it('matches the shipped index.html, whose boot block is the only inline style', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf8')
    expect(inlineStyleHashes(html)).toHaveLength(1)
    expect(html).not.toMatch(/ style="/) // style attributes would need 'unsafe-inline'; the boot splash uses classes
  })
})
