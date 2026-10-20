/**
 * Scarab Verify, end to end: the extension loaded unpacked into a real
 * Chromium, the built app served by dist-server/index.js as scarab.one runs
 * it (vault-only, a throwaway database, an ephemeral port), and the attested
 * manifest served from a second origin standing in for the GitHub release.
 *
 * Four verdicts, in order, on one server and one browser:
 *   1. green — the untouched build: every file the page loaded is in the
 *      manifest with that hash, and the byte counts the page saw match;
 *   2. red — a script the release does not ship, referenced by the shell:
 *      the shell mismatches and the script is "not in release";
 *   3. red — one asset file tampered with on disk, caught by "Check again"
 *      on the running page and again on a fresh load;
 *   4. grey — build.json removed: nothing to check against, nothing claimed.
 *
 * The result is read where the popup reads it (chrome.storage.session, in
 * the extension's service worker), on the toolbar badge, and in the popup
 * itself, opened as a page for that tab.
 */
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../../server/migrations'
import type { TabState } from '../src/verify'

/** The extension's API, inside the functions worker.evaluate runs in its service worker. */
declare const chrome: any

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TAG = 'v0.0.0-test'

test.describe.configure({ mode: 'serial' })

/* ---------- the servers ---------- */

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

type Site = { origin: string; proc: ChildProcess; log: string[]; stop: () => Promise<void> }

/**
 * dist-server/index.js as scarab.one runs it, serving the copy of dist/ under
 * `work` (its cwd), with a fresh database whose price basket is marked as
 * attempted today so GET /api/basket does not start a crawl (as the egress
 * proof does, e2e/egress.spec.ts).
 */
async function startSite(work: string): Promise<Site> {
  for (const f of ['dist/index.html', 'dist-server/index.js'])
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing — the global setup should have built it (npm run build)`)
  const dbPath = join(work, 'scarab.db')
  const db = openDb(dbPath)
  db.prepare("INSERT INTO app_meta (key, value) VALUES ('basket:attempted_on', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    new Date().toISOString().slice(0, 10),
  )
  db.close()
  const port = await freePort()
  const origin = `http://localhost:${port}`
  const log: string[] = []
  const proc = spawn(process.execPath, [join(ROOT, 'dist-server/index.js')], {
    cwd: work,
    env: { ...process.env, NODE_ENV: 'test', SCARAB_ZK_ONLY: '1', DB_PATH: dbPath, PORT: String(port), HISTORY_SEED: join(work, 'no-seed') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  proc.stdout!.on('data', (d: Buffer) => log.push(d.toString()))
  proc.stderr!.on('data', (d: Buffer) => log.push(d.toString()))
  const exited = new Promise<number | null>((resolve) => proc.on('exit', resolve))
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) break
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
  return { origin, proc, log, stop }
}

/** The "GitHub release": another origin, answering the release-asset path for TAG with the attested manifest and nothing else. */
async function startReleaseServer(manifestText: string): Promise<{ origin: string; server: HttpServer }> {
  const server = createHttpServer((req, res) => {
    if (req.url === `/releases/download/${TAG}/build.json`) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(manifestText)
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not Found')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

/* ---------- the browser ---------- */

let work: string
let site: Site
let release: { origin: string; server: HttpServer }
let context: BrowserContext
let worker: Worker
let extensionId: string
let page: Page
let tabId: number
let expectedCommit: string
let shellText: string

const popupUrl = () => `chrome-extension://${extensionId}/popup.html?tab=${tabId}`

async function tabState(): Promise<TabState | undefined> {
  return worker.evaluate(async (id: number) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], tabId) as Promise<TabState | undefined>
}
const badge = (): Promise<string> => worker.evaluate((id: number) => chrome.action.getBadgeText({ tabId: id }), tabId) as Promise<string>

/**
 * The check as it stands once it has settled: a verdict other than
 * "checking", for the document after `notDoc` (a reload) or checked after
 * `after` (a "Check again"), and unchanged for a second — the content script
 * reports in bursts as chunks arrive, and each report extends the check.
 */
async function settled(opts: { notDoc?: string; after?: number } = {}): Promise<TabState> {
  const deadline = Date.now() + 45_000
  let last: TabState | undefined
  let since = 0
  for (;;) {
    const s = await tabState()
    const current = s && s.verdict !== 'checking' && (opts.notDoc === undefined || s.docId !== opts.notDoc) && (opts.after === undefined || (s.checkedAt ?? 0) > opts.after)
    if (current) {
      if (last && s.checkedAt === last.checkedAt && s.files.length === last.files.length) {
        if (Date.now() - since > 1_000) return s
      } else {
        last = s
        since = Date.now()
      }
    }
    if (Date.now() > deadline) throw new Error(`the check did not settle:\n${JSON.stringify(s, null, 2)}\nserver log:\n${site.log.join('')}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'scarab-verifier-'))
  // A copy of the build to serve and tamper with. Its build.json names the release the attested copy is served for.
  cpSync(join(ROOT, 'dist'), join(work, 'dist'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(work, 'dist', 'build.json'), 'utf8')) as { tag: string | null; commit: string }
  manifest.tag = TAG
  expectedCommit = manifest.commit
  const manifestText = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(join(work, 'dist', 'build.json'), manifestText)
  shellText = readFileSync(join(work, 'dist', 'index.html'), 'utf8')
  release = await startReleaseServer(manifestText)
  site = await startSite(work)

  // The extension, granted this test's origins: a copy whose manifest adds localhost (a match pattern without a port matches every port).
  const ext = join(work, 'ext')
  cpSync(join(ROOT, 'verifier', 'dist'), ext, { recursive: true })
  const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8')) as { host_permissions: string[]; content_scripts: { matches: string[] }[] }
  m.host_permissions.push('http://localhost/*', 'http://127.0.0.1/*')
  m.content_scripts[0]!.matches.push('http://localhost/*')
  writeFileSync(join(ext, 'manifest.json'), JSON.stringify(m, null, 2))
  context = await chromium.launchPersistentContext(join(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  })
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  extensionId = new URL(worker.url()).host
  // Settings as the options page would store them: this site, its manifests at the release server.
  await worker.evaluate(
    ([origin, manifest]: [string, string]) => chrome.storage.local.set({ origins: [{ origin, manifest }] }),
    [site.origin, `${release.origin}/releases/download/{tag}/build.json`] as [string, string],
  )
})

test.afterAll(async () => {
  await context?.close()
  await site?.stop()
  release?.server.close()
  if (work) rmSync(work, { recursive: true, force: true })
})

/* ---------- the verdicts ---------- */

test('green: the untouched build is the attested release', async () => {
  page = await context.newPage()
  await page.goto(`${site.origin}/`)
  await page.waitForLoadState('load')
  tabId = (await worker.evaluate(async (origin: string) => (await chrome.tabs.query({ url: `${origin}/*` }))[0].id, site.origin)) as number
  const s = await settled()
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('ok')
  expect(s.release?.manifest?.tag).toBe(TAG)
  expect(s.release?.manifest?.commit).toBe(expectedCommit)
  expect(s.release?.manifestUrl).toBe(`${release.origin}/releases/download/${TAG}/build.json`)
  expect(s.notes).toEqual([])

  // What the page loaded: the shell, its entry chunk and stylesheet, the web manifest, and the chunks of the screen that opened.
  const paths = s.files.map((f) => f.path)
  expect(paths).toContain('index.html')
  expect(paths.some((p) => /^assets\/index-[\w-]+\.js$/.test(p))).toBe(true)
  expect(paths.some((p) => /^assets\/[\w-]+\.css$/.test(p))).toBe(true)
  expect(paths).toContain('manifest.webmanifest')
  expect(s.files.length).toBeGreaterThanOrEqual(5)
  for (const f of s.files) expect(f.status, `${f.path}: ${f.note ?? ''}`).toBe('ok')
  expect(new Set(paths).size).toBe(paths.length)

  // The byte counts the page itself saw agree with the re-fetch — the narrowing of "the re-fetch is a second request".
  const shell = s.files.find((f) => f.path === 'index.html')!
  expect(shell.observedSize).toBeGreaterThan(0)
  expect(shell.observedSize).toBe(shell.fetchedSize)
  expect(s.files.filter((f) => f.observedSize !== null).length).toBeGreaterThanOrEqual(3)

  expect(await badge()).toBe('✓')

  const popup = await context.newPage()
  await popup.goto(popupUrl())
  await expect(popup.locator('.lead')).toContainText('is the attested release')
  await expect(popup.locator('.facts')).toContainText(TAG)
  await expect(popup.locator('.facts')).toContainText(expectedCommit.slice(0, 7))
  await expect(popup.locator('table.files tbody tr').first()).toContainText('index.html')
  await expect(popup.locator('table.files tr.fail')).toHaveCount(0)
  await expect(popup.locator('table.files tbody tr:not(.detail)')).toHaveCount(s.files.length)
  await popup.close()

  // The settings page lists the built-in origin and this one, with where its manifests are.
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(options.locator('#origins li')).toHaveCount(2)
  await expect(options.locator('#origins')).toContainText('https://scarab.one')
  await expect(options.locator('#origins')).toContainText('built in')
  await expect(options.locator('#origins')).toContainText(site.origin)
  await expect(options.locator('#origins')).toContainText(`${release.origin}/releases/download/{tag}/build.json`)
  await expect(options.locator('#status')).toHaveText('')
  await options.close()
})

test('red: a script the release does not ship', async () => {
  const before = await tabState()
  writeFileSync(join(work, 'dist', 'assets', 'extra-00000000.js'), 'console.log("not in the release")\n')
  writeFileSync(join(work, 'dist', 'index.html'), shellText.replace('</body>', '<script src="/assets/extra-00000000.js"></script></body>'))
  try {
    await page.reload()
    await page.waitForLoadState('load')
    const s = await settled({ notDoc: before?.docId })
    expect(s.verdict, JSON.stringify(s, null, 2)).toBe('fail')
    expect(s.files.find((f) => f.path === 'index.html')?.status).toBe('mismatch')
    expect(s.files.find((f) => f.path === 'assets/extra-00000000.js')?.status).toBe('not-in-manifest')
    expect(s.files.filter((f) => f.status !== 'ok').map((f) => f.path).sort()).toEqual(['assets/extra-00000000.js', 'index.html'])
    expect(await badge()).toBe('✕')
  } finally {
    writeFileSync(join(work, 'dist', 'index.html'), shellText)
    rmSync(join(work, 'dist', 'assets', 'extra-00000000.js'))
  }
})

test('red: one asset file tampered with on disk', async () => {
  // Back on the untouched shell first.
  let before = await tabState()
  await page.reload()
  await page.waitForLoadState('load')
  before = await settled({ notDoc: before?.docId })
  expect(before.verdict).toBe('ok')

  const entry = /src="\/(assets\/index-[\w-]+\.js)"/.exec(shellText)![1]!
  appendFileSync(join(work, 'dist', entry), '\n;/* tampered */\n')

  // "Check again" on the running page: the same list, every file fetched again.
  const popup = await context.newPage()
  await popup.goto(popupUrl())
  await popup.getByRole('button', { name: 'Check again' }).click()
  const s = await settled({ after: before.checkedAt ?? 0 })
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('fail')
  expect(s.files.find((f) => f.path === entry)?.status).toBe('mismatch')
  expect(s.files.filter((f) => f.status !== 'ok').map((f) => f.path)).toEqual([entry])
  expect(await badge()).toBe('✕')
  await expect(popup.locator('.lead')).toContainText('NOT the attested release')
  await expect(popup.locator('table.files tr.fail').first()).toContainText('MISMATCH')
  await popup.close()

  // And on a fresh load of the page.
  await page.reload()
  await page.waitForLoadState('load')
  const again = await settled({ notDoc: s.docId })
  expect(again.verdict).toBe('fail')
  expect(again.files.find((f) => f.path === entry)?.status).toBe('mismatch')
  expect(await badge()).toBe('✕')
})

test('grey: no build.json, nothing to check against', async () => {
  const before = await tabState()
  rmSync(join(work, 'dist', 'build.json'))
  await page.reload()
  await page.waitForLoadState('load')
  const s = await settled({ notDoc: before?.docId })
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('unverifiable')
  expect(s.reason).toMatch(/build\.json/)
  expect(s.release?.manifest).toBeNull()
  expect(s.files.length).toBeGreaterThan(0)
  expect(s.files.every((f) => f.status === 'unchecked')).toBe(true)
  expect(await badge()).toBe('?')

  const popup = await context.newPage()
  await popup.goto(popupUrl())
  await expect(popup.locator('.lead')).toContainText('Cannot verify')
  await expect(popup.locator('.reason')).toContainText('build.json')
  await popup.close()
})
