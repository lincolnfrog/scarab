/**
 * Scarab Verify, end to end: the extension loaded unpacked into a real
 * Chromium, the built app served by dist-server/index.js as scarab.one runs
 * it (vault-only, a throwaway database, an ephemeral port), and the attested
 * manifest served from a second origin standing in for the GitHub release.
 *
 * On one server and one browser, in order:
 *   1. green — the untouched build: every file the page loaded is in the
 *      manifest with that hash, and the byte counts the page saw match;
 *   2. nothing green before the document has loaded: the shell alone is
 *      "checking", however its own hash looks;
 *   3. a tab that leaves the origin while a check is in flight is cleared,
 *      and the check writes nothing back;
 *   4. the repository the site names is not followed: the manifest still
 *      comes from the configured source, and the badge warns;
 *   5. a page of the server (/api/health) is nothing to check, not tampering;
 *   6. red — a script the release does not ship, referenced by the shell;
 *   7. red — one asset file tampered with on disk, caught by "Check again"
 *      on the running page and again on a fresh load;
 *   8. grey — build.json removed: nothing to check against, nothing claimed.
 *
 * The result is read where the popup reads it (chrome.storage.session, in
 * the extension's service worker), on the toolbar badge and its title, and
 * in the popup itself, opened as a page for that tab.
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
import { PINNED_REPO, type TabState } from '../src/verify'

/** The extension's API, inside the functions worker.evaluate runs in its service worker. */
declare const chrome: any

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const TAG = 'v0.0.0-test'
/** The release server answers under /slow after this long: a check that is still waiting on it is "in flight". */
const SLOW_MS = 1500

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

/**
 * The "GitHub release": another origin, answering the release-asset path for
 * TAG with the attested manifest, the same under /slow after SLOW_MS, and
 * nothing else.
 */
async function startReleaseServer(manifestText: string): Promise<{ origin: string; server: HttpServer }> {
  const server = createHttpServer((req, res) => {
    const slow = req.url?.startsWith('/slow/') ?? false
    const path = slow ? req.url!.slice('/slow'.length) : req.url
    const answer = () => {
      if (path === `/releases/download/${TAG}/build.json`) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(manifestText)
      } else {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('Not Found')
      }
    }
    if (slow) setTimeout(answer, SLOW_MS)
    else answer()
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
let servedManifestText: string

const popupUrl = (id: number) => `chrome-extension://${extensionId}/popup.html?tab=${id}`
const fastManifests = () => `${release.origin}/releases/download/{tag}/build.json`
const slowManifests = () => `${release.origin}/slow/releases/download/{tag}/build.json`

/** Settings as the options page would store them: this site, its repository, its manifests at the release server. */
async function configure(manifest: string): Promise<void> {
  await worker.evaluate(
    ([origin, repo, manifest]: [string, string, string]) => chrome.storage.local.set({ origins: [{ origin, repo, manifest }] }),
    [site.origin, PINNED_REPO, manifest] as [string, string, string],
  )
}

async function stateOf(id: number): Promise<TabState | undefined> {
  return worker.evaluate(async (id: number) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`], id) as Promise<TabState | undefined>
}
const badgeOf = (id: number): Promise<string> => worker.evaluate((id: number) => chrome.action.getBadgeText({ tabId: id }), id) as Promise<string>
const titleOf = (id: number): Promise<string> => worker.evaluate((id: number) => chrome.action.getTitle({ tabId: id }), id) as Promise<string>

/** The tab a page is: brought to the front, it is the active tab on the site. */
async function tabOf(p: Page): Promise<number> {
  await p.bringToFront()
  const id = (await worker.evaluate(async (origin: string) => (await chrome.tabs.query({ active: true, url: `${origin}/*` }))[0]?.id, site.origin)) as number | undefined
  if (id === undefined) throw new Error('the page is not a tab on the site')
  return id
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The check as it stands once it has settled: a verdict other than
 * "checking", for the document after `notDoc` (a reload) or checked after
 * `after` (a "Check again"), and unchanged for a second — the content script
 * reports in bursts as chunks arrive, and each report extends the check.
 */
async function settled(id: number, opts: { notDoc?: string; after?: number } = {}): Promise<TabState> {
  const deadline = Date.now() + 45_000
  let last: TabState | undefined
  let since = 0
  for (;;) {
    const s = await stateOf(id)
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
    await sleep(200)
  }
}

test.beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'scarab-verifier-'))
  // A copy of the build to serve and tamper with. Its build.json names the release the attested copy is served for.
  cpSync(join(ROOT, 'dist'), join(work, 'dist'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(work, 'dist', 'build.json'), 'utf8')) as { tag: string | null; commit: string; repo: string | null }
  manifest.tag = TAG
  manifest.repo = PINNED_REPO
  expectedCommit = manifest.commit
  servedManifestText = JSON.stringify(manifest, null, 2) + '\n'
  writeFileSync(join(work, 'dist', 'build.json'), servedManifestText)
  shellText = readFileSync(join(work, 'dist', 'index.html'), 'utf8')
  release = await startReleaseServer(servedManifestText)
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
  await configure(fastManifests())
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
  tabId = await tabOf(page)
  const s = await settled(tabId)
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('ok')
  expect(s.loaded).toBe(true)
  expect(s.release?.repo).toBe(PINNED_REPO)
  expect(s.release?.manifest?.tag).toBe(TAG)
  expect(s.release?.manifest?.commit).toBe(expectedCommit)
  expect(s.release?.manifestUrl).toBe(`${release.origin}/releases/download/${TAG}/build.json`)
  expect(s.notes).toEqual([])
  expect(s.warnings).toEqual([])

  // What the page loaded: the shell, its entry chunk and stylesheet, the web manifest, and the chunks of the screen that opened.
  const paths = s.files.map((f) => f.path)
  expect(paths).toContain('index.html')
  expect(paths.some((p) => /^assets\/index-[\w-]+\.js$/.test(p))).toBe(true)
  expect(paths.some((p) => /^assets\/[\w-]+\.css$/.test(p))).toBe(true)
  expect(paths).toContain('manifest.webmanifest')
  expect(s.files.length).toBeGreaterThanOrEqual(5)
  for (const f of s.files) expect(f.status, `${f.path}: ${f.note ?? ''}`).toBe('ok')
  expect(new Set(paths).size).toBe(paths.length)

  // The byte counts the page itself saw agree with the re-fetch — the (weak) narrowing of "the re-fetch is a second request".
  const shell = s.files.find((f) => f.path === 'index.html')!
  expect(shell.observedSize).toBeGreaterThan(0)
  expect(shell.observedSize).toBe(shell.fetchedSize)
  expect(s.files.filter((f) => f.observedSize !== null).length).toBeGreaterThanOrEqual(3)

  expect(await badgeOf(tabId)).toBe('✓')
  expect(await titleOf(tabId)).toContain(TAG)

  const popup = await context.newPage()
  await popup.goto(popupUrl(tabId))
  await expect(popup.locator('.lead')).toContainText('is the attested release')
  await expect(popup.locator('.facts')).toContainText(TAG)
  await expect(popup.locator('.facts')).toContainText(expectedCommit.slice(0, 7))
  await expect(popup.locator('.facts')).toContainText('lincolnfrog/scarab')
  // every link in the popup is on the configured repository or its manifest server, never an address from the site
  for (const href of await popup.locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))
    expect(href === '' || href.startsWith(`${PINNED_REPO}/`) || href === PINNED_REPO || href.startsWith(`${release.origin}/`) || href.endsWith('#'), href).toBe(true)
  await expect(popup.locator('table.files tbody tr').first()).toContainText('index.html')
  await expect(popup.locator('table.files tr.fail')).toHaveCount(0)
  await expect(popup.locator('table.files tbody tr:not(.detail)')).toHaveCount(s.files.length)
  await popup.close()

  // The settings page: scarab.one pinned and fixed, this site with its repository and its manifests' address.
  const options = await context.newPage()
  await options.goto(`chrome-extension://${extensionId}/options.html`)
  await expect(options.locator('#origins li')).toHaveCount(2)
  await expect(options.locator('#origins li').first()).toContainText('https://scarab.one')
  await expect(options.locator('#origins li').first()).toContainText(PINNED_REPO)
  await expect(options.locator('#origins li').first()).toContainText('built in, fixed')
  await expect(options.locator('#origins li').first().locator('button')).toHaveCount(0)
  await expect(options.locator('#origins li').nth(1)).toContainText(site.origin)
  await expect(options.locator('#origins li').nth(1)).toContainText(fastManifests())
  await expect(options.locator('#status')).toHaveText('')
  // scarab.one cannot be added with another source
  await options.locator('#origin').fill('https://scarab.one')
  await options.locator('#repo').fill('https://github.com/attacker/scarab')
  await options.locator('form#add button[type=submit]').click()
  await expect(options.locator('#status')).toContainText('fixed')
  await expect(options.locator('#origins li')).toHaveCount(2)
  await options.close()
})

test('nothing is green before the document has loaded', async () => {
  // The entry chunk reaches the page two seconds late; the extension's own fetch of it is not delayed.
  const p = await context.newPage()
  await p.route(/\/assets\/index-[\w-]+\.js$/, async (route) => {
    await sleep(2000)
    await route.continue()
  })
  await p.goto(`${site.origin}/`, { waitUntil: 'commit' })
  const id = await tabOf(p)
  let loaded = false
  const load = p.waitForLoadState('load').then(() => (loaded = true))
  const samples: string[] = []
  while (!loaded) {
    samples.push(await badgeOf(id))
    await sleep(50)
  }
  await load
  expect(samples, samples.join(' ')).not.toContain('✓')
  expect(samples, samples.join(' ')).toContain('…')
  const s = await settled(id)
  expect(s.verdict).toBe('ok')
  expect(s.loaded).toBe(true)
  expect(await badgeOf(id)).toBe('✓')
  await p.close()
})

test('a tab that leaves the origin mid-check is cleared, and the check writes nothing back', async () => {
  await configure(slowManifests())
  try {
    const p = await context.newPage()
    await p.goto(`${site.origin}/`)
    await p.waitForLoadState('load')
    const id = await tabOf(p)
    // the check is waiting on the slow manifest
    expect((await stateOf(id))?.verdict).toBe('checking')
    expect(await badgeOf(id)).toBe('…')
    await p.goto(`${release.origin}/`) // another origin (a 404 page there), well before the manifest arrives
    await sleep(SLOW_MS + 1000)
    expect(await badgeOf(id)).toBe('')
    expect(await stateOf(id)).toBeUndefined()
    expect(await titleOf(id)).toBe('Scarab Verify')
    await p.close()
  } finally {
    await configure(fastManifests())
  }
})

test('the repository the site names is not followed, and the badge warns', async () => {
  const before = await stateOf(tabId)
  writeFileSync(join(work, 'dist', 'build.json'), servedManifestText.replace(PINNED_REPO, 'https://github.com/attacker/scarab'))
  try {
    await page.reload()
    await page.waitForLoadState('load')
    const s = await settled(tabId, { notDoc: before?.docId })
    expect(s.verdict, JSON.stringify(s, null, 2)).toBe('ok') // the files are the configured release's: they decide
    expect(s.release?.served?.repo).toBe('https://github.com/attacker/scarab')
    expect(s.release?.repo).toBe(PINNED_REPO)
    expect(s.release?.manifestUrl).toBe(`${release.origin}/releases/download/${TAG}/build.json`)
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0]).toContain('attacker/scarab')
    expect(s.warnings[0]).toContain(PINNED_REPO)
    expect(await badgeOf(tabId)).toBe('✓')
    expect(await titleOf(tabId)).toContain('WARNING')
    expect(await titleOf(tabId)).toContain('attacker/scarab')
    const popup = await context.newPage()
    await popup.goto(popupUrl(tabId))
    await expect(popup.locator('.warning')).toContainText('attacker/scarab')
    await expect(popup.locator('.facts')).toContainText('lincolnfrog/scarab')
    for (const href of await popup.locator('a[href]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href))) expect(href).not.toContain('attacker')
    await popup.close()
  } finally {
    writeFileSync(join(work, 'dist', 'build.json'), servedManifestText)
  }
})

test('a page of the server, not of the app, is nothing to check', async () => {
  await page.goto(`${site.origin}/api/health`)
  await page.waitForLoadState('load')
  const s = await settled(tabId)
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('unverifiable')
  expect(s.reason).toContain('not a page of the app')
  expect(s.reason).toContain('/api/health')
  expect(s.files).toEqual([])
  expect(await badgeOf(tabId)).toBe('?')
  // and back to the app
  await page.goto(`${site.origin}/`)
  await page.waitForLoadState('load')
  const again = await settled(tabId, { notDoc: s.docId })
  expect(again.verdict).toBe('ok')
  expect(await badgeOf(tabId)).toBe('✓')
})

test('red: a script the release does not ship', async () => {
  const before = await stateOf(tabId)
  writeFileSync(join(work, 'dist', 'assets', 'extra-00000000.js'), 'console.log("not in the release")\n')
  writeFileSync(join(work, 'dist', 'index.html'), shellText.replace('</body>', '<script src="/assets/extra-00000000.js"></script></body>'))
  try {
    await page.reload()
    await page.waitForLoadState('load')
    const s = await settled(tabId, { notDoc: before?.docId })
    expect(s.verdict, JSON.stringify(s, null, 2)).toBe('fail')
    expect(s.files.find((f) => f.path === 'index.html')?.status).toBe('mismatch')
    expect(s.files.find((f) => f.path === 'assets/extra-00000000.js')?.status).toBe('not-in-manifest')
    expect(s.files.filter((f) => f.status !== 'ok').map((f) => f.path).sort()).toEqual(['assets/extra-00000000.js', 'index.html'])
    expect(await badgeOf(tabId)).toBe('✕')
  } finally {
    writeFileSync(join(work, 'dist', 'index.html'), shellText)
    rmSync(join(work, 'dist', 'assets', 'extra-00000000.js'))
  }
})

test('red: one asset file tampered with on disk', async () => {
  // Back on the untouched shell first.
  let before = await stateOf(tabId)
  await page.reload()
  await page.waitForLoadState('load')
  before = await settled(tabId, { notDoc: before?.docId })
  expect(before.verdict).toBe('ok')

  const entry = /src="\/(assets\/index-[\w-]+\.js)"/.exec(shellText)![1]!
  appendFileSync(join(work, 'dist', entry), '\n;/* tampered */\n')

  // "Check again" on the running page: the same list, every file fetched again.
  const popup = await context.newPage()
  await popup.goto(popupUrl(tabId))
  await popup.getByRole('button', { name: 'Check again' }).click()
  const s = await settled(tabId, { after: before.checkedAt ?? 0 })
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('fail')
  expect(s.files.find((f) => f.path === entry)?.status).toBe('mismatch')
  expect(s.files.filter((f) => f.status !== 'ok').map((f) => f.path)).toEqual([entry])
  expect(await badgeOf(tabId)).toBe('✕')
  await expect(popup.locator('.lead')).toContainText('NOT the attested release')
  await expect(popup.locator('table.files tr.fail').first()).toContainText('MISMATCH')
  await popup.close()

  // And on a fresh load of the page.
  await page.reload()
  await page.waitForLoadState('load')
  const again = await settled(tabId, { notDoc: s.docId })
  expect(again.verdict).toBe('fail')
  expect(again.files.find((f) => f.path === entry)?.status).toBe('mismatch')
  expect(await badgeOf(tabId)).toBe('✕')
})

test('grey: no build.json, nothing to check against', async () => {
  const before = await stateOf(tabId)
  rmSync(join(work, 'dist', 'build.json'))
  await page.reload()
  await page.waitForLoadState('load')
  const s = await settled(tabId, { notDoc: before?.docId })
  expect(s.verdict, JSON.stringify(s, null, 2)).toBe('unverifiable')
  expect(s.reason).toMatch(/build\.json/)
  expect(s.release?.manifest).toBeNull()
  expect(s.files.length).toBeGreaterThan(0)
  expect(s.files.every((f) => f.status === 'unchecked')).toBe(true)
  expect(await badgeOf(tabId)).toBe('?')

  const popup = await context.newPage()
  await popup.goto(popupUrl(tabId))
  await expect(popup.locator('.lead')).toContainText('Cannot verify')
  await expect(popup.locator('.reason')).toContainText('build.json')
  await popup.close()
})
