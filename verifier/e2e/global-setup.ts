import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * The extension test runs against the built app — dist/ served by
 * dist-server/index.js, what a deploy ships — and the built extension. The
 * app build is reused when VERIFIER_SKIP_BUILD=1 (or EGRESS_SKIP_BUILD=1, the
 * egress proof's flag) and it exists; the extension is always rebuilt, which
 * takes a second.
 */
export default function globalSetup(): void {
  const skip = process.env.VERIFIER_SKIP_BUILD === '1' || process.env.EGRESS_SKIP_BUILD === '1'
  if (skip && existsSync(`${ROOT}dist/build.json`) && existsSync(`${ROOT}dist-server/index.js`)) {
    console.log('verifier: using the existing app build')
  } else {
    console.log('verifier: building the app (npm run build)…')
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
  }
  execSync('node verifier/build.mjs', { cwd: ROOT, stdio: 'inherit' })
}
