#!/usr/bin/env node
// The asset manifest the trust chain attests: dist/build.json.
//
//   { repo, commit, tag, assets: { "<path under dist/>": "<sha256 hex>", … } }
//
// `npm run build` writes it last, so it describes exactly what the server
// serves (server/app.ts serves dist/ as-is, byte for byte). The release
// workflow (.github/workflows/release.yml) builds twice and fails if the two
// manifests differ, then attests this file and attaches it to the release;
// scripts/verify-served.sh hashes what scarab.one serves against it.
//
// Reproducible by construction: no timestamps, no absolute paths, sorted keys,
// LF line ends. Provenance comes from the environment when the build is driven
// by CI or the Dockerfile — SCARAB_COMMIT, SCARAB_TAG, SCARAB_REPO; a variable
// that is set but empty means "none", never a guess — and from git only for a
// developer's local build. The server never runs git: it reads this file.
//
//   node scripts/build-manifest.mjs [dist-dir]
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const dist = process.argv[2] ?? 'dist'
const MANIFEST = 'build.json'

/** `git …` in this checkout, or null when git or the repository is absent (the Docker build has neither). */
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

/** The environment's answer when it gives one (empty = none), else the fallback. */
const fromEnv = (name, fallback) => (name in process.env ? process.env[name] || null : fallback())

/** "git@github.com:owner/name.git" or "https://github.com/owner/name(.git)" → "https://github.com/owner/name". */
function repoUrl(remote) {
  if (!remote) return null
  const m = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote)
  return m ? `https://github.com/${m[1]}` : null
}

const commit = fromEnv('SCARAB_COMMIT', () => git('rev-parse', 'HEAD'))
if (commit !== null && !/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`build-manifest: SCARAB_COMMIT must be a full 40-hex commit, got ${JSON.stringify(commit)}`)
  process.exit(1)
}
const tag = fromEnv('SCARAB_TAG', () => git('describe', '--exact-match', '--tags'))
const repo = fromEnv('SCARAB_REPO', () => repoUrl(git('remote', 'get-url', 'origin')))

/** Every file under dir, as sorted posix paths relative to it. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

const assets = {}
for (const file of walk(dist).sort()) {
  const path = relative(dist, file).split(sep).join('/')
  if (path === MANIFEST) continue
  assets[path] = createHash('sha256').update(readFileSync(file)).digest('hex')
}
if (!('index.html' in assets)) {
  console.error(`build-manifest: no index.html under ${dist} — run vite build first`)
  process.exit(1)
}

const manifest = { repo, commit, tag, assets }
writeFileSync(join(dist, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
console.log(`${join(dist, MANIFEST)}: ${Object.keys(assets).length} files · commit ${commit ? commit.slice(0, 7) : 'unknown'}${tag ? ` · ${tag}` : ''}`)
