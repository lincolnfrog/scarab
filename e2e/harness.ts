import { expect, type BrowserContext, type CDPSession, type Page, type Request } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../server/migrations'

/**
 * What the browser checks in e2e/ share: the real vault-only server on a free
 * port with a throwaway database, a log of every request a browser context
 * makes (with CDP's own account as a second witness), and the few moves that
 * drive the shell. Each *.spec.ts states its own claims and judges them.
 */

export const ROOT = fileURLToPath(new URL('..', import.meta.url))

/* ---------- the server ---------- */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.unref()
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo
      s.close(() => resolve(port))
    })
  })
}

export type Server = { origin: string; dbPath: string; dir: string; proc: ChildProcess; log: string[]; stop: () => Promise<void> }

/**
 * Start dist-server/index.js as scarab.one runs it — vault-only, serving
 * dist/ — on a free port with a fresh database in a temp directory. The
 * database is created and migrated here first so the price basket can be
 * marked "attempted today": GET /api/basket otherwise starts a crawl of the
 * whole US-listed universe (server/basket.ts), which has no place in a test.
 * NODE_ENV is not production, so every request is dev@localhost, the same
 * identity a developer's browser gets.
 */
export async function startServer(label = 'egress'): Promise<Server> {
  for (const f of ['dist/index.html', 'dist-server/index.js'])
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing — the global setup should have built it (npm run build)`)
  const dir = await mkdtemp(join(tmpdir(), `scarab-${label}-`))
  const dbPath = join(dir, 'scarab.db')
  const db = openDb(dbPath)
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:attempted_on', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    new Date().toISOString().slice(0, 10),
  )
  db.close()
  const port = await freePort()
  // localhost, not 127.0.0.1: WebAuthn needs a domain for the RP ID (src/passkey.ts rpIdFor), and an IP address is refused.
  const origin = `http://localhost:${port}`
  const log: string[] = []
  const proc = spawn(process.execPath, ['dist-server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'test', SCARAB_ZK_ONLY: '1', DB_PATH: dbPath, PORT: String(port), HISTORY_SEED: join(dir, 'no-seed') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout!.on('data', (d: Buffer) => log.push(d.toString()))
  proc.stderr!.on('data', (d: Buffer) => log.push(d.toString()))
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve))
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const r = await fetch(`${origin}/api/health`)
      if (r.ok) break
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) throw new Error(`the server exited with ${proc.exitCode}:\n${log.join('')}`)
    if (Date.now() > deadline) throw new Error(`the server did not answer /api/health within 30s:\n${log.join('')}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  const stop = async () => {
    if (proc.exitCode === null) {
      proc.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
  }
  return { origin, dbPath, dir, proc, log, stop }
}

export type ModeAnswer = { vault: { version: number; sha256: string } | null; zkOnly: boolean; serverHasData: boolean }
export const fetchMode = async (origin: string): Promise<ModeAnswer> => (await fetch(`${origin}/api/mode`)).json() as Promise<ModeAnswer>

/* ---------- the request log ---------- */

export type Rec = {
  phase: string
  method: string
  url: string
  resourceType: string
  headers: Record<string, string>
  body: string | null
  status: number | null
  failure: string | null
}

/** Record everything every page in the context asks for, with the phase of the scenario it happened in. */
export function recordRequests(context: BrowserContext, phase: () => string): { recs: Rec[]; settle: () => Promise<void> } {
  const recs: Rec[] = []
  const pending: Promise<unknown>[] = []
  const byRequest = new Map<Request, Rec>()
  context.on('request', (req) => {
    const rec: Rec = { phase: phase(), method: req.method(), url: req.url(), resourceType: req.resourceType(), headers: {}, body: req.postData(), status: null, failure: null }
    recs.push(rec)
    byRequest.set(req, rec)
    pending.push(
      req.allHeaders().then(
        (h) => (rec.headers = h),
        () => undefined, // a request torn down before its headers could be read: the URL and body are still judged
      ),
    )
  })
  context.on('response', (res) => {
    const rec = byRequest.get(res.request())
    if (rec) rec.status = res.status()
  })
  context.on('requestfailed', (req) => {
    const rec = byRequest.get(req)
    if (rec) rec.failure = req.failure()?.errorText ?? 'failed'
  })
  return { recs, settle: () => Promise.all(pending).then(() => undefined) }
}

export const describe = (r: Rec) => `${r.method} ${r.url}${r.status !== null ? ` → ${r.status}` : r.failure ? ` (${r.failure})` : ''} [${r.phase}]`

/** CDP's own account of the page's requests: a second witness to Playwright's events. */
export async function recordCdp(cdp: CDPSession): Promise<{ method: string; url: string }[]> {
  const out: { method: string; url: string }[] = []
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', (e) => out.push({ method: e.request.method, url: e.request.url }))
  return out
}

/* ---------- driving the app ---------- */

/** The sidebar's button for a screen (the phone tab bar has the same names, but it is display:none at this width). */
export const navButton = (page: Page, label: string) => page.locator('aside nav').getByRole('button', { name: label, exact: true })

export async function openScreen(page: Page, label: string): Promise<void> {
  await navButton(page, label).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(label)
}

/** A toast with this text appeared (toasts are the app's confirmation of every write). */
export const toastShown = (page: Page, text: string | RegExp) => expect(page.locator('.ui-toasts').getByText(text)).toBeVisible()
