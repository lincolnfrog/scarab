/**
 * The front door's sample household never touches a vault.
 *
 * What runs: the same build and vault-only server as the egress proof
 * (e2e/harness.ts), headless Chromium, and every request the tab makes,
 * recorded by Playwright and by CDP.
 *
 * What it does: opens "Look around with a sample household" from the front
 * door, checks that it is badged as the sample, browses every screen the
 * sidebar lists, makes changes on the way (a bank account on Cash, a target
 * on Dream Home), sends the tab to the background — which uploads a vault
 * session's unsaved work at once — waits well past autosave's delay, looks at
 * Data & Vault, and leaves for the front door.
 *
 * What it asserts:
 *   a. the tab sent nothing but GETs: no PUT /api/vault, no write of any kind;
 *   b. every request was same-origin, and every API path is one the
 *      vault-only allowlist names (server/zk-routes.ts);
 *   c. no vault is stored, before, during or after — the server's vault
 *      tables never gain a row — and Data & Vault offers no way to make one;
 *   d. leaving asked nothing ("Leave site?") and landed on the front door's
 *      setup step;
 *   e. the sample's made-up data is in no request and in neither browser
 *      storage; no uncaught page error, no Content-Security-Policy violation.
 */
import { expect, test, type Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { rm } from 'node:fs/promises'
import { ZK_ROUTES } from '../server/zk-routes'
import { describe, fetchMode, openScreen, recordCdp, recordRequests, startServer, toastShown } from './harness'

/** Things only the sample household says (engine/sample.ts): none may leave the tab or land in its storage. */
const SAMPLE_ONLY = ['Larch Avenue', 'LARKSPUR SYSTEMS', 'Everyday Checking', 'LITTLE ACORNS']

/** Schemes that never reach a network: the favicon is a data: URI, downloads are blob: URLs. */
const LOCAL_SCHEMES = new Set(['data:', 'blob:', 'about:'])

/** The vault courier's tables (server/migrations.ts): what storing, sharing or keeping a vault writes. */
const VAULT_TABLES = ['vault_blobs', 'vault_history', 'household_members', 'vault_invites'] as const

/** Go somewhere in the app without reloading the page (a reload is a new tab's worth of state — the sample would be gone). */
const goInApp = (page: Page, hash: string) => page.evaluate((h) => (location.hash = h), hash)

test('a sample session makes no vault write — no write of any kind — and leaves no vault behind', async ({ browser }) => {
  const server = await startServer('sample')
  let phase = 'boot'
  const context = await browser.newContext({ baseURL: server.origin })
  const { recs, settle } = recordRequests(context, () => phase)
  const pageErrors: string[] = []
  const cspViolations: string[] = []
  const dialogs: string[] = []
  const page = await context.newPage()
  page.on('pageerror', (e) => pageErrors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text())
  })
  page.on('dialog', (d) => {
    dialogs.push(`${d.type()}: ${d.message()}`)
    void d.dismiss()
  })
  const cdpSeen = await recordCdp(await context.newCDPSession(page))

  try {
    /* ----- the front door, before any vault ----- */
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Set up your vault' })).toBeVisible()
    expect((await fetchMode(server.origin)).vault, 'no vault is stored to begin with').toBeNull()

    /* ----- open the sample: badged, on its Dashboard ----- */
    phase = 'open'
    await page.getByRole('button', { name: 'Look around with a sample household' }).click()
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.zk-banner')).toContainText('A made-up sample household — nothing you change is saved.')
    await expect(page.locator('button.ui-sync[data-state="sample"]')).toContainText('Sample household')
    await expect(page.locator('aside')).toContainText('Sample household · nothing is saved')
    await expect(page.getByText('Household net worth')).toBeVisible()
    await expect(page.locator('.topbar .where')).toContainText('Scarab sample')

    /* ----- browse every screen, and change things on the way ----- */
    phase = 'browse'
    const labels = (await page.locator('aside nav button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).filter(
      (l): l is string => !!l,
    )
    expect(labels.length, 'the sidebar lists the screens').toBeGreaterThanOrEqual(10)
    for (const label of labels) await openScreen(page, label)

    phase = 'edit'
    await openScreen(page, 'Cash & budget')
    await goInApp(page, '#/cash/import')
    await page.getByRole('button', { name: '+ account' }).click()
    await page.getByLabel('Account name').fill('A savings account of my own')
    await page.getByRole('button', { name: 'Add', exact: true }).click()
    await toastShown(page, 'Added A savings account of my own')
    await openScreen(page, 'Dream Home')
    await page.getByRole('link', { name: 'Target & fund setup' }).click()
    const target = page.getByLabel('Purchase price')
    await target.fill('1500000')
    await target.press('Tab')
    await toastShown(page, 'Target price set to $1,500,000.00')

    // What makes a vault session upload at once: the tab going into the background. Then well past autosave's delay.
    phase = 'background'
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(4_000)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect(page.locator('button.ui-sync[data-state="sample"]')).toBeVisible() // still the sample: nothing went saving or failed

    /* ----- Data & Vault: the sample, and no way to make it a vault ----- */
    phase = 'vault'
    await openScreen(page, 'Data & Vault')
    await expect(page.getByRole('heading', { name: 'The sample household' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Create vault/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /backup/i })).toHaveCount(0)

    const storage = await page.evaluate(() => ({ local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) }))

    /* ----- leave: back to the front door, asking nothing ----- */
    phase = 'leave'
    await page.locator('.zk-banner').getByRole('button', { name: 'Leave the sample' }).click()
    await expect(page.getByRole('heading', { name: 'Set up your vault' })).toBeVisible({ timeout: 30_000 })
    expect(new URL(page.url()).hash, 'nothing of the sample stays in the address bar').toBe('')

    const after = await fetchMode(server.origin)
    phase = 'done'
    await settle()
    await context.close()
    await server.stop()

    /* ----- the judgement ----- */
    expect(recs.length, 'requests were recorded').toBeGreaterThan(10)
    expect(cdpSeen.length, 'CDP recorded requests too').toBeGreaterThan(10)
    expect(pageErrors, 'no uncaught errors in the page').toEqual([])
    expect(cspViolations, 'the Content-Security-Policy refused nothing').toEqual([])
    expect(dialogs, 'leaving asked nothing').toEqual([])

    // (a) Nothing but GETs, from either witness.
    const writes = recs.filter((r) => !['GET', 'HEAD'].includes(r.method))
    expect(writes.map(describe), 'the sample sent no write of any kind — no PUT /api/vault').toEqual([])
    expect(cdpSeen.filter((r) => !['GET', 'HEAD'].includes(r.method)).map((r) => `${r.method} ${r.url}`), 'CDP saw no write either').toEqual([])

    // (b) Same origin, and only the vault-only routes.
    const offenders = [...recs.map((r) => ({ url: r.url, what: describe(r) })), ...cdpSeen.map((r) => ({ url: r.url, what: `${r.method} ${r.url} [CDP]` }))].filter(({ url }) => {
      const u = new URL(url)
      if (LOCAL_SCHEMES.has(u.protocol)) return false
      return u.origin !== server.origin || (u.pathname.startsWith('/api/') && !ZK_ROUTES.test(u.pathname))
    })
    expect(offenders.map((o) => o.what), 'every request was same-origin, and every API path a vault-only route').toEqual([])

    // (c) No vault, ever.
    expect(after.vault, 'no vault is stored after the sample').toBeNull()
    const db = new Database(server.dbPath)
    try {
      for (const t of VAULT_TABLES) expect((db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n, `server table ${t} is empty`).toBe(0)
    } finally {
      db.close()
    }

    // (e) The made-up data stayed in the tab.
    const leaks = recs.flatMap((r) => SAMPLE_ONLY.filter((s) => r.url.includes(s) || r.url.includes(encodeURIComponent(s)) || r.body?.includes(s)).map((s) => `${s} in ${describe(r)}`))
    expect(leaks, 'nothing of the sample’s was sent').toEqual([])
    for (const s of SAMPLE_ONLY) {
      expect(storage.local, `localStorage does not hold ${JSON.stringify(s)}`).not.toContain(s)
      expect(storage.session, `sessionStorage does not hold ${JSON.stringify(s)}`).not.toContain(s)
    }

    const apiPaths = new Set(recs.map((r) => new URL(r.url).pathname).filter((p) => p.startsWith('/api/')))
    console.log(`sample: ${recs.length} requests, all GET; API paths seen: ${[...apiPaths].sort().join(' ')}`)
  } catch (e) {
    if (server.log.length) console.log(`--- server log ---\n${server.log.join('')}`)
    throw e
  } finally {
    await context.close().catch(() => undefined)
    await server.stop()
    await rm(server.dir, { recursive: true, force: true })
  }
})
