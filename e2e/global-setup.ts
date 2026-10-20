import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The egress test runs against the built app — dist/ served by
 * dist-server/index.js, exactly what a deploy ships — so build first.
 * EGRESS_SKIP_BUILD=1 reuses an existing build while iterating locally.
 */
export default function globalSetup(): void {
  if (process.env.EGRESS_SKIP_BUILD === '1' && existsSync(`${ROOT}dist/index.html`) && existsSync(`${ROOT}dist-server/index.js`)) {
    console.log('egress: EGRESS_SKIP_BUILD=1 — using the existing build')
    return
  }
  console.log('egress: building the client and the server (npm run build)…')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
}
