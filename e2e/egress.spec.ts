/**
 * The runnable form of PRIVACY.md's claim: a zero-knowledge session never
 * sends plaintext off the tab.
 *
 * What runs: the built app (dist/, dist-server/) as the real vault-only server
 * (SCARAB_ZK_ONLY=1, a throwaway database, an ephemeral port), and headless
 * Chromium with a CDP virtual authenticator that answers passkey prompts with
 * PRF support. Every request the browser makes — URL, method, headers, body —
 * and every response is recorded, from two independent sources (Playwright's
 * request events and CDP's Network domain).
 *
 * What it does: creates a vault through the front door, enters distinctive
 * canary data on every screen that takes input (a cash account and an
 * imported transaction, an investment account and a trade, a property and
 * its valuation, the Dream Home target), lets autosave run, reloads, unlocks
 * with the passkey, browses every screen plus detail views, a holding's
 * drawer (whose chart asks for a hashed symbol bucket), the vault's history
 * and both backups, and opens the terms and privacy pages.
 *
 * What it asserts (the numbers match PRIVACY.md's "Runnable proof"):
 *   a. every request is same-origin, and its path is the shell, an asset, the
 *      manifest, an icon, or a route the vault-only allowlist names
 *      (server/zk-routes.ts ZK_ROUTES, imported — never copied);
 *   b. the only writes are PUT /api/vault, and no plaintext route was ever
 *      attempted (the server would refuse it; the tab must not even try);
 *   c. every PUT /api/vault body is a vault blob that opens with the recovery
 *      code to a snapshot holding the canaries, and no canary — nor the
 *      recovery code — appears in clear in any request, in localStorage or
 *      in sessionStorage;
 *   d. browsing alone (the reload-and-browse phase) uploads nothing and leaves
 *      the stored version where it was;
 *   e. the server's plaintext tables never gain a row, and the canaries are
 *      not in its database file.
 *
 * Deliberately one long test: the phases share one vault, one key and one
 * request log, and a failure names the offending request.
 */
import { expect, test, type BrowserContext, type CDPSession, type Page, type Request } from '@playwright/test'
import Database from 'better-sqlite3'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TABLES } from '../engine/snapshot'
import { openDb } from '../server/migrations'
import { ZK_ROUTES } from '../server/zk-routes'
import { decodeRecoveryCode, openPayload, parseVaultBlob } from '../shared/vault'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/* ---------- what the shell is allowed to ask for besides the API ---------- */

/**
 * Static paths the built client references (index.html, public/, the build manifest): the shell, its assets, the
 * web manifest and icons, /build.json — what the server serves, read by Data & Vault's Advanced card — and exactly
 * what the terms and privacy pages load when the scenario opens them (the page, its stylesheet, its font).
 */
const STATIC_OK = (path: string): boolean =>
  path === '/' ||
  path === '/index.html' ||
  path.startsWith('/assets/') ||
  path === '/manifest.webmanifest' ||
  path.startsWith('/icons/') ||
  path === '/build.json' ||
  LEGAL_PAGES.has(path) ||
  path === '/legal.css' ||
  path === '/fonts/marcellus.woff2'

/** The terms and privacy pages the front door and Advanced link to (public/*.html): opened in a new tab, like the links do. */
const LEGAL_PAGES = new Map([
  ['/terms.html', 'Terms'],
  ['/privacy.html', 'Privacy'],
])

/** Schemes that never reach a network: the favicon is a data: URI, downloads are blob: URLs. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/**
 * The screens, as the sidebar names them (src/router.ts SCREENS). The test
 * checks the sidebar shows exactly these, so a new screen fails here until it
 * is added — and then it is browsed and judged like the others.
 */
const SCREEN_LABELS = ['Dashboard', 'Checkup', 'Investments', 'Real estate', 'Cash & budget', 'Taxes', 'Dream Home', 'Future', 'Compare', 'Data & Vault'] as const

/** The tables serverHasData (server/api8.ts) checks: the ones that mean plaintext household data. */
const PLAINTEXT_TABLES = ['accounts', 'transactions', 'invest_accounts', 'trades', 'properties', 'rsu_vests'] as const

/* ---------- canaries ---------- */

/**
 * Distinctive strings that exist only in this run. Each carries a space or a
 * dot — characters outside base64 and base64url — so a search over raw
 * request bodies full of ciphertext can never match one by chance.
 */
function makeCanaries() {
  const nonce = randomBytes(4).toString('hex').toUpperCase() // 8 hex characters
  return {
    nonce,
    account: `Canary Checking ${nonce}.A`,
    merchant: `CANARY MERCHANT ${nonce}.B`,
    txAmountText: '1234.57', // typed as dollars; the snapshot stores -123457 cents
    txAmountCents: 123457,
    investAccount: `Canary Brokerage ${nonce}.C`,
    ticker: `CNRY.${nonce.slice(0, 6)}`, // ≤ 20 characters, no spaces (engine/invest.ts); the dot keeps it out of base64
    tradePriceText: '123.45',
    property: `Canary House ${nonce}.D`,
    propertyPriceText: '650000',
    valuationText: '987654.33',
    valuationCents: 98765433,
    goalPriceText: '2468013.57',
    goalPriceCents: 246801357,
  }
}
type Canaries = ReturnType<typeof makeCanaries>

/** The canaries as typed: what a leak in clear would look like in a request, in browser storage or in the server's database file. */
function typedForms(c: Canaries): string[] {
  return [c.account, c.merchant, c.txAmountText, c.investAccount, c.ticker, c.property, c.valuationText, c.goalPriceText]
}

/** The canaries as a snapshot stores them (shared/money.ts: amounts are integer cents): what the decrypted upload must hold. */
function storedForms(c: Canaries): string[] {
  return [c.account, c.merchant, String(-c.txAmountCents), c.investAccount, c.ticker, c.property, String(c.valuationCents), String(c.goalPriceCents)]
}

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

type Server = { origin: string; dbPath: string; dir: string; proc: ChildProcess; log: string[]; stop: () => Promise<void> }

/**
 * Start dist-server/index.js as scarab.one runs it — vault-only, serving
 * dist/ — on a free port with a fresh database in a temp directory. The
 * database is created and migrated here first so the price basket can be
 * marked "attempted today": GET /api/basket otherwise starts a crawl of the
 * whole US-listed universe (server/basket.ts), which has no place in a test.
 * NODE_ENV is not production, so every request is dev@localhost, the same
 * identity a developer's browser gets.
 */
async function startServer(): Promise<Server> {
  for (const f of ['dist/index.html', 'dist-server/index.js'])
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} is missing — the global setup should have built it (npm run build)`)
  const dir = await mkdtemp(join(tmpdir(), 'scarab-egress-'))
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

type ModeAnswer = { vault: { version: number; sha256: string } | null; zkOnly: boolean; serverHasData: boolean }
const fetchMode = async (origin: string): Promise<ModeAnswer> => (await fetch(`${origin}/api/mode`)).json() as Promise<ModeAnswer>

/* ---------- the request log ---------- */

type Rec = {
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
function recordRequests(context: BrowserContext, phase: () => string): { recs: Rec[]; settle: () => Promise<void> } {
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

const describe = (r: Rec) => `${r.method} ${r.url}${r.status !== null ? ` → ${r.status}` : r.failure ? ` (${r.failure})` : ''} [${r.phase}]`

/** CDP's own account of the page's requests: a second witness to Playwright's events. */
async function recordCdp(cdp: CDPSession): Promise<{ method: string; url: string }[]> {
  const out: { method: string; url: string }[] = []
  await cdp.send('Network.enable')
  cdp.on('Network.requestWillBeSent', (e) => out.push({ method: e.request.method, url: e.request.url }))
  return out
}

/* ---------- driving the app ---------- */

/** The sidebar's button for a screen (the phone tab bar has the same names, but it is display:none at this width). */
const navButton = (page: Page, label: string) => page.locator('aside nav').getByRole('button', { name: label, exact: true })

async function openScreen(page: Page, label: string): Promise<void> {
  await navButton(page, label).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText(label)
}

/** A toast with this text appeared (toasts are the app's confirmation of every write). */
const toastShown = (page: Page, text: string | RegExp) => expect(page.locator('.ui-toasts').getByText(text)).toBeVisible()

/** Wait for the sync chip to say the tab is saved, then for the stored version to stop moving. */
async function waitForAutosave(page: Page, origin: string): Promise<number> {
  await expect(page.locator('button.ui-sync[data-state="saved"]')).toBeVisible({ timeout: 30_000 })
  let last = (await fetchMode(origin)).vault?.version ?? 0
  let quietSince = Date.now()
  const deadline = Date.now() + 30_000
  while (Date.now() - quietSince < 3_000) {
    if (Date.now() > deadline) throw new Error('the stored vault version kept changing for 30s after the chip said saved')
    await new Promise((r) => setTimeout(r, 250))
    const now = (await fetchMode(origin)).vault?.version ?? 0
    if (now !== last) {
      last = now
      quietSince = Date.now()
    }
  }
  return last
}

/** Open the vault's `data` string with the recovery code and parse the snapshot it holds. */
async function openWithCode(data: string, code: string): Promise<{ json: string; version: number }> {
  const blob = parseVaultBlob(data)
  const plaintext = await openPayload(blob, await decodeRecoveryCode(code))
  return { json: new TextDecoder().decode(plaintext), version: blob.v === 3 ? blob.seq : 0 }
}

/* ---------- the test ---------- */

test('a zero-knowledge session sends only ciphertext, and only to PUT /api/vault', async ({ browser }) => {
  const C = makeCanaries()
  const server = await startServer()
  const baseline = countRows(server.dbPath)
  let phase = 'boot'
  const context = await browser.newContext({ baseURL: server.origin })
  const { recs, settle } = recordRequests(context, () => phase)
  const pageErrors: string[] = []
  // The Content-Security-Policy (server/app.ts) is part of the claim: a violation surfaces only as a console error,
  // so one anywhere in the session — a blocked inline style, a script or a fetch off this origin — fails the test here.
  const cspViolations: string[] = []
  const watch = (p: Page) => {
    p.on('pageerror', (e) => pageErrors.push(e.message))
    p.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text())
    })
  }
  const page = await context.newPage()
  watch(page)
  const cdp = await context.newCDPSession(page)
  const cdpSeen = await recordCdp(cdp)
  // A platform passkey with PRF, answering without a prompt — what a Mac's Touch ID or a phone does for a person.
  await cdp.send('WebAuthn.enable', { enableUI: false })
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
  })

  try {
    /* ----- phase 1: the front door creates a vault ----- */
    phase = 'create'
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Set up your vault' })).toBeVisible()
    await expect(page.getByText('This server is vault-only')).toBeVisible()
    // The device label is in the vault header, which the server stores in clear by design (PRIVACY.md) — not a canary.
    await page.getByLabel('Name this device').fill('Egress test device')
    await page.getByRole('button', { name: 'Create vault with a passkey' }).click()
    await expect(page.getByRole('heading', { name: 'Your vault is ready' })).toBeVisible({ timeout: 30_000 })
    const shownCode = (await page.locator('pre[aria-label="Recovery code"]').innerText()).trim()
    const code = shownCode.replace(/[^0-9A-Za-z]/g, '')
    expect(code, 'the recovery code has 54 characters').toHaveLength(54)
    await page.getByRole('checkbox', { name: 'I wrote it down' }).check()
    await page.getByRole('button', { name: /stored it/ }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible()
    const labels = await page.locator('aside nav button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
    expect(labels, 'the sidebar lists exactly the screens this test browses — add a new screen to SCREEN_LABELS').toEqual([...SCREEN_LABELS])

    /* ----- phase 2: canary data on every screen that takes input ----- */
    phase = 'enter'

    // Cash & budget: a bank account, and a statement import with one transaction.
    await openScreen(page, 'Cash & budget')
    // With no account yet the form is already open ("First: name the bank account…"); otherwise "+ account" opens it.
    const accountName = page.getByLabel('Account name')
    if (!(await accountName.isVisible())) await page.getByRole('button', { name: '+ account' }).click()
    await accountName.fill(C.account)
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await toastShown(page, `Added ${C.account}`)
    const posted = new Date(Date.now() - 86_400_000) // yesterday, in the Wells Fargo export's MM/DD/YYYY
    const mdy = `${String(posted.getMonth() + 1).padStart(2, '0')}/${String(posted.getDate()).padStart(2, '0')}/${posted.getFullYear()}`
    const csv = `"${mdy}","-${C.txAmountText}","*","","${C.merchant}"\n`
    await page.locator('input[type="file"][accept=".csv,.ofx,.qfx,.txt"]').setInputFiles({ name: 'canary.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })
    await toastShown(page, /canary\.csv → .*1 imported/)

    // Investments: a brokerage account, then a buy of a ticker no basket lists, at a hand-entered price.
    await openScreen(page, 'Investments')
    await page.getByRole('button', { name: '+ Add account' }).click()
    await page.getByRole('dialog', { name: 'Add an account' }).getByRole('button', { name: /^Brokerage/ }).click()
    const details = page.getByRole('dialog', { name: 'New Brokerage' })
    await details.getByLabel('Name', { exact: true }).fill(C.investAccount)
    await details.getByRole('button', { name: 'Add account' }).click()
    await expect(page.getByRole('dialog', { name: `${C.investAccount} is ready` })).toBeVisible()
    await page.getByRole('button', { name: /^Record a trade/ }).click()
    const trade = page.getByRole('dialog', { name: 'Record trade' })
    await trade.getByRole('combobox', { name: 'Symbol' }).fill(C.ticker)
    await trade.getByLabel('Shares').fill('7')
    await trade.getByRole('textbox', { name: 'Price per share' }).fill(C.tradePriceText) // the Enter radio group's label also says "price per share"
    await trade.getByRole('button', { name: 'Record', exact: true }).click()
    await toastShown(page, /^Recorded: buy 7/)
    // The holding has no quote (nothing in the basket lists it): price it by hand, as PRIVACY.md says a tab does.
    await page.getByRole('button', { name: 'Set price' }).first().click()
    const setPrice = page.getByRole('dialog', { name: `Set the ${C.ticker} price` })
    await setPrice.getByRole('textbox', { name: 'Price per share' }).fill('130.00')
    await setPrice.getByRole('button', { name: 'Save price' }).click()
    await toastShown(page, `${C.ticker} priced at $130.00`)

    // Real estate: a property, then its valuation.
    await openScreen(page, 'Real estate')
    await page.getByRole('button', { name: '+ Add property' }).first().click()
    const addProperty = page.getByRole('dialog', { name: 'Add property' })
    await addProperty.getByLabel('Name', { exact: true }).fill(C.property)
    await addProperty.getByLabel('Purchase price').fill(C.propertyPriceText)
    await addProperty.getByRole('button', { name: 'Add property' }).click()
    await expect(page.getByRole('heading', { name: C.property })).toBeVisible()
    await page.getByRole('button', { name: 'Update value' }).click()
    const valuation = page.getByRole('dialog', { name: `Update ${C.property}'s value` })
    await valuation.getByLabel('Estimated value').fill(C.valuationText)
    await valuation.getByRole('button', { name: 'Save value' }).click()
    await toastShown(page, `${C.property}: $987,654.33 as of`)

    // Dream Home: the target price, in the setup detail view (committed on blur).
    await openScreen(page, 'Dream Home')
    await page.getByRole('link', { name: 'Target & fund setup' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Target & fund setup')
    const target = page.getByLabel('Purchase price')
    await target.fill(C.goalPriceText)
    await target.press('Tab')
    await toastShown(page, 'Target price set to $2,468,013.57')

    // The rest of the screens, so a read that writes would show up as a save here rather than in the browse phase.
    for (const label of SCREEN_LABELS) await openScreen(page, label)

    /* ----- autosave ----- */
    phase = 'autosave'
    const savedVersion = await waitForAutosave(page, server.origin)
    expect(savedVersion, 'autosave stored at least the create and one later version').toBeGreaterThanOrEqual(2)

    /* ----- phase 3: reload, unlock with the passkey, browse everything ----- */
    phase = 'browse'
    const before = await fetchMode(server.origin)
    const putsBefore = recs.filter((r) => r.method === 'PUT').length
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Unlock your vault' })).toBeVisible()
    await page.getByRole('button', { name: 'Unlock with passkey' }).click()
    // The reload kept the fragment, so the shell reopens on the screen that was showing — whichever it was.
    await expect(page.locator('aside nav')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('button.ui-sync[data-state="saved"]')).toBeVisible()
    for (const label of SCREEN_LABELS) await openScreen(page, label)
    // The canaries came back from the ciphertext, decrypted in the tab.
    await openScreen(page, 'Cash & budget')
    // Screens visited stay mounted but hidden (App.tsx <Activity>): look only at what is showing.
    await expect(page.getByText(C.account).filter({ visible: true }).first()).toBeVisible()
    await page.getByRole('link', { name: 'Spending by category' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Spending & income')
    await openScreen(page, 'Investments')
    await expect(page.getByText(C.ticker).filter({ visible: true }).first()).toBeVisible()
    // The holding's drawer: its price chart asks the server for the hashed bucket the symbol falls in — a bucket
    // number on the vault-only allowlist, never the symbol (PRIVACY.md "Daily history"; the canary check below
    // would catch the ticker in a URL). This server has no daily files, so the answer is a 202 and the chart says so.
    await page.getByRole('button', { name: `${C.ticker}: open its chart, lots and trades` }).click()
    const drawer = page.getByRole('dialog', { name: C.ticker })
    await expect(drawer).toBeVisible()
    await expect(drawer.getByText(/This session never names what you hold/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toBeHidden()
    await openScreen(page, 'Real estate')
    await expect(page.getByRole('heading', { name: C.property })).toBeVisible()
    await page.getByRole('link', { name: /§121 exclusion/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('§121 exclusion')
    await openScreen(page, 'Dream Home')
    await page.getByRole('link', { name: 'Target & fund setup' }).click()
    await expect(page.getByLabel('Purchase price')).toHaveValue(/2,468,013\.57/)

    // Data & Vault: the history (an earlier version opened in the tab) and both backups (downloads, never uploads).
    await openScreen(page, 'Data & Vault')
    await page.getByRole('button', { name: /^Open v\d+$/ }).first().click()
    const preview = page.getByRole('dialog', { name: /^Vault v\d+$/ })
    await expect(preview).toBeVisible()
    await expect(preview.getByRole('rowheader', { name: 'Transactions' })).toBeVisible() // its rows were counted here, from the decrypted copy
    await preview.getByRole('button', { name: 'Close', exact: true }).last().click() // the footer's Close (the ✕ icon is named Close too)
    await expect(preview).toBeHidden()
    const [encrypted] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download encrypted backup' }).click()])
    const encryptedPath = join(server.dir, 'backup.scarab')
    await encrypted.saveAs(encryptedPath)
    await toastShown(page, /Encrypted backup of v\d+ downloaded/)
    const [plain] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download export (JSON)' }).click()])
    const plainPath = join(server.dir, 'export.json')
    await plain.saveAs(plainPath)

    /* ----- the terms and privacy pages: static files, opened in a new tab as the links open them ----- */
    // Same context, so their requests — the page, its stylesheet, its font — are judged with the rest and the policy
    // is held to them too (no script, no inline style: a violation on either page fails the test like one in the app).
    phase = 'pages'
    for (const [path, title] of LEGAL_PAGES) {
      const legal = await context.newPage()
      watch(legal)
      await legal.goto(path)
      await expect(legal.getByRole('heading', { level: 1 })).toHaveText(title)
      await expect(legal.locator('script'), `${path} ships no JavaScript`).toHaveCount(0)
      await legal.close()
    }

    const after = await fetchMode(server.origin)
    const storage = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }))
    phase = 'done'
    await settle()
    await context.close()
    await server.stop()

    /* ----- the judgement ----- */

    // Something was recorded at all, from both witnesses, and the session really did talk to the courier.
    expect(recs.length, 'requests were recorded').toBeGreaterThan(20)
    expect(cdpSeen.length, 'CDP recorded requests too').toBeGreaterThan(20)
    expect(pageErrors, 'no uncaught errors in the page').toEqual([])
    expect(cspViolations, 'the Content-Security-Policy refused nothing the app does').toEqual([])

    // (a) Same origin, and only the shell, its assets, the manifest, icons, or a vault-only route.
    const judgeUrl = (url: string): string | null => {
      const u = new URL(url)
      if (LOCAL_SCHEMES.has(u.protocol)) return null
      if (u.origin !== server.origin) return `off-origin: ${url}`
      if (STATIC_OK(u.pathname)) return null
      if (u.pathname.startsWith('/api/')) return ZK_ROUTES.test(u.pathname) ? null : `a plaintext route (not in server/zk-routes.ts): ${u.pathname}`
      return `an unexpected path: ${u.pathname}`
    }
    const offenders = recs.map((r) => ({ r, why: judgeUrl(r.url) })).filter((x) => x.why !== null)
    expect(
      offenders.map((x) => `${x.why} — ${describe(x.r)}`),
      'every request the tab made was same-origin and either static or a vault-only route',
    ).toEqual([])
    const cdpOffenders = cdpSeen.map((r) => ({ r, why: judgeUrl(r.url) })).filter((x) => x.why !== null)
    expect(
      cdpOffenders.map((x) => `${x.why} — ${x.r.method} ${x.r.url} [CDP]`),
      'CDP saw no request Playwright did not judge the same way',
    ).toEqual([])
    const refused = recs.filter((r) => r.url.includes('/api/') && r.status !== null && (r.status === 403 || r.status >= 500))
    expect(refused.map(describe), 'the server never had to refuse the tab (403) and never failed (5xx)').toEqual([])

    // (b) The only writes are PUT /api/vault.
    const writes = recs.filter((r) => !['GET', 'HEAD', 'OPTIONS'].includes(r.method))
    const otherWrites = writes.filter((r) => !(r.method === 'PUT' && new URL(r.url).pathname === '/api/vault'))
    expect(otherWrites.map(describe), 'the only write the tab ever sent was PUT /api/vault').toEqual([])
    const puts = writes.filter((r) => r.method === 'PUT')
    expect(puts.length, 'the session uploaded ciphertext').toBeGreaterThanOrEqual(2)

    // (c) Every upload is a vault blob the recovery code opens; the last one holds every canary; nothing is in clear anywhere.
    let lastOpened: { json: string; version: number } | null = null
    for (const put of puts) {
      expect(put.body, `the body of ${describe(put)} was recorded`).not.toBeNull()
      const body = JSON.parse(put.body!) as { data?: unknown; version?: unknown }
      expect(typeof body.data, `${describe(put)} carries the blob as a string`).toBe('string')
      expect(Number.isSafeInteger(body.version), `${describe(put)} names the version it replaces`).toBe(true)
      const opened = await openWithCode(body.data as string, code)
      expect(opened.version, `${describe(put)} is sealed for the version it creates`).toBe((body.version as number) + 1)
      const dump = JSON.parse(opened.json) as { scarab?: unknown; tables?: Record<string, unknown[]> }
      expect(dump.scarab, `${describe(put)} decrypts to a Scarab snapshot`).toBe(true)
      lastOpened = opened
    }
    const finalJson = lastOpened!.json
    for (const canary of storedForms(C)) expect(finalJson, `the last upload, decrypted, holds the canary ${JSON.stringify(canary)}`).toContain(canary)

    const inClear = [...typedForms(C), shownCode, code]
    const leaks: string[] = []
    for (const r of recs)
      for (const canary of inClear) {
        if (r.url.includes(canary) || r.url.includes(encodeURIComponent(canary))) leaks.push(`in the URL of ${describe(r)}: ${canary}`)
        for (const [k, v] of Object.entries(r.headers)) if (v.includes(canary)) leaks.push(`in header ${k} of ${describe(r)}: ${canary}`)
        if (r.body?.includes(canary)) leaks.push(`in the body of ${describe(r)}: ${canary}`)
      }
    expect(leaks, 'no canary and no recovery code appeared in clear in any request').toEqual([])
    for (const canary of inClear) {
      expect(storage.local, `localStorage does not hold ${JSON.stringify(canary)}`).not.toContain(canary)
      expect(storage.session, `sessionStorage does not hold ${JSON.stringify(canary)}`).not.toContain(canary)
    }
    // The backups never left the tab: the encrypted one opens with the code and holds the canaries, the plain one is plaintext on disk only.
    const backupFile = JSON.parse(await readFile(encryptedPath, 'utf8')) as { scarab: string; vault: unknown }
    expect(backupFile.scarab).toBe('backup')
    const backupOpened = await openWithCode(JSON.stringify(backupFile.vault), code)
    for (const canary of storedForms(C)) expect(backupOpened.json, `the encrypted backup holds ${JSON.stringify(canary)}`).toContain(canary)
    const plainExport = await readFile(plainPath, 'utf8')
    expect(plainExport).toContain(C.account)
    const exportLeaks = recs.filter((r) => r.body !== null && r.body.includes(C.merchant))
    expect(exportLeaks.map(describe), 'the plain export was downloaded, never uploaded').toEqual([])

    // (d) Browsing alone uploaded nothing and moved no version.
    expect(before.vault, 'a vault was stored before the browse phase').not.toBeNull()
    expect(after.vault?.version, 'the stored version did not move while browsing').toBe(before.vault!.version)
    expect(after.vault?.sha256, 'the stored blob did not change while browsing').toBe(before.vault!.sha256)
    const browsePuts = recs.filter((r) => r.method === 'PUT' && r.phase === 'browse')
    expect(browsePuts.map(describe), 'the reload-and-browse phase sent no upload').toEqual([])
    expect(recs.filter((r) => r.method === 'PUT').length, 'no upload slipped in after the browse phase began').toBe(putsBefore)

    // (e) The server's plaintext tables never gained a row; the canaries are not in its database file.
    const final = countRows(server.dbPath)
    for (const t of PLAINTEXT_TABLES) expect(final[t], `server table ${t} is empty`).toBe(0)
    expect(final, 'no household table on the server gained or lost a row').toEqual(baseline)
    const dbBytes = Buffer.concat(await Promise.all([server.dbPath, `${server.dbPath}-wal`].filter(existsSync).map((p) => readFile(p))))
    for (const canary of inClear) expect(dbBytes.includes(Buffer.from(canary)), `the server's database file does not contain ${JSON.stringify(canary)}`).toBe(false)
    expect(before.zkOnly && !before.serverHasData, 'the server ran vault-only and held no plaintext').toBe(true)

    const apiPaths = new Set(recs.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith('/api/')))
    console.log(
      `egress: ${recs.length} requests recorded, ${puts.length} uploads (PUT /api/vault), stored v${after.vault!.version}; ` +
        `API paths seen: ${[...apiPaths].sort().join(' ')}`,
    )
  } catch (e) {
    // The server's own log is the first thing to read when the scenario stops short.
    if (server.log.length) console.log(`--- server log ---\n${server.log.join('')}`)
    throw e
  } finally {
    await context.close().catch(() => undefined)
    await server.stop()
    await rm(server.dir, { recursive: true, force: true })
  }
})

/** Rows per snapshot table in the server's database (its own connection; the server is stopped or idle). */
function countRows(dbPath: string): Record<string, number> {
  const db = new Database(dbPath)
  try {
    const out: Record<string, number> = {}
    for (const t of TABLES) {
      // The basket's own app_meta keys are infrastructure the test itself seeds; everything else in app_meta is household data.
      const sql = t === 'app_meta' ? "SELECT count(*) AS n FROM app_meta WHERE key NOT LIKE 'basket:%'" : `SELECT count(*) AS n FROM ${t}`
      out[t] = (db.prepare(sql).get() as { n: number }).n
    }
    return out
  } finally {
    db.close()
  }
}
