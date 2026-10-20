import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuildInfo } from '../engine/services'

/**
 * What this server was built from, for /api/health and the Data & Vault
 * screen: the provenance fields of dist/build.json, the manifest the build
 * writes last (scripts/build-manifest.mjs) and the release workflow attests.
 * A server never runs git; it reads the file, or — for a container started
 * without a build, as the tests do — the SCARAB_COMMIT / SCARAB_TAG /
 * SCARAB_REPO environment. Null when neither says.
 */
export function readBuildInfo(dist: string, env: NodeJS.ProcessEnv = process.env): BuildInfo | null {
  const file = join(dist, 'build.json')
  if (existsSync(file)) {
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as Partial<BuildInfo>
      return { repo: str(m.repo), commit: str(m.commit), tag: str(m.tag) }
    } catch {
      // unreadable manifest: fall through to the environment
    }
  }
  const info = { repo: str(env.SCARAB_REPO), commit: str(env.SCARAB_COMMIT), tag: str(env.SCARAB_TAG) }
  return info.commit || info.tag || info.repo ? info : null
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/**
 * The CSP source expressions for a page's inline <style> blocks: one
 * 'sha256-…' per block, over exactly the text between the tags. index.html
 * paints the page colour and the boot splash before the bundle arrives
 * (`<style>` there, by design), and the policy in server/app.ts allows those
 * blocks by hash rather than 'unsafe-inline' — so the HTML stays a static,
 * verifiable file (no per-request nonce) and no other inline style runs.
 */
export function inlineStyleHashes(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi))
    out.push(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`)
  return out
}

/** The hashes for dist/index.html, or none when there is no build to serve. */
export function readInlineStyleHashes(dist: string): string[] {
  const file = join(dist, 'index.html')
  return existsSync(file) ? inlineStyleHashes(readFileSync(file, 'utf8')) : []
}
