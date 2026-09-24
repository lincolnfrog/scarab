import { ackDigest, getDigest, inheritDigestMark } from '../../engine/digest'
import { createPaySource, deletePaySource, updatePaySource } from '../../engine/paychecks'
import { getRecurring } from '../../engine/recurring'
import {
  compareScenarios,
  createScenario,
  deleteScenario,
  listScenarios,
  priceScenarioDecision,
  updateScenario,
} from '../../engine/scenarios'
import * as svc from '../../engine/services'
import { simulate, type SimParams } from '../../engine/simulate'
import { dumpDb, loadDump, TABLES, type Dump } from '../../engine/snapshot'
import { getTax, putTaxSettings } from '../../engine/tax'
import { CURRENT_VERSION, readabilityError } from '../../engine/upgrades'
import { r, type LocalCtx, type LocalRoute } from './table'

/**
 * Cash, budget, property, goal, taxes, digest, scenarios and whole-database
 * export/import — the in-tab mirror of server/api.ts, the property and net
 * worth half of api2.ts, api3.ts, api4.ts's export/import, api5–7 and
 * app.ts's /me. Every handler calls the same engine function its server
 * route does, with the same arguments.
 */

/**
 * Who the digest high-water mark belongs to: the signed-in identity. Before
 * the tab knew it, every tab used 'local'; see inheritDigestMark.
 */
const LEGACY_DIGEST_OWNER = 'local'
const digestOwner = (c: LocalCtx) => c.identity ?? LEGACY_DIGEST_OWNER

export const CORE: LocalRoute[] = [
  r('GET', '/me', (c) => ({ email: c.identity ?? 'you · local tab' })),
  r('GET', '/health', () => svc.health()),

  /* ---------- cash ledger (api.ts) ---------- */
  r('GET', '/accounts', (c) => svc.listAccounts(c.db)),
  r('POST', '/accounts', (c) => svc.createAccount(c.db, c.body)),
  r('PATCH', '/accounts/:id', (c) => svc.anchorAccount(c.db, Number(c.params.id), c.body)),
  r('GET', '/categories', (c) => svc.listCategories(c.db)),
  r('POST', '/categories', (c) => svc.createCategory(c.db, c.body)),
  r('POST', '/imports', (c) => svc.runImport(c.db, c.body, c.identity ?? 'local')),
  r('GET', '/imports', (c) => svc.listImports(c.db)),
  r('GET', '/transactions', (c) =>
    svc.listTransactions(c.db, {
      q: c.query.get('q') ?? undefined,
      month: c.query.get('month') ?? undefined,
      categoryId: c.query.get('category_id') ?? undefined,
      accountId: c.query.get('account_id') ?? undefined,
      uncategorized: c.query.get('uncategorized') === '1',
      offset: c.query.get('offset') ?? undefined,
      limit: c.query.get('limit') ?? undefined,
    }),
  ),
  r('PATCH', '/transactions/:id', (c) => svc.patchTransaction(c.db, Number(c.params.id), c.body)),
  r('GET', '/cashflow/monthly', (c) => svc.cashflowMonthly(c.db, { months: c.query.get('months') })),
  r('GET', '/cashflow/categories', (c) => svc.cashflowCategories(c.db, c.query.get('month') ?? undefined)),
  r('GET', '/budget', (c) => svc.getBudget(c.db, c.query.get('month') ?? undefined)),
  r('PUT', '/budget', (c) => svc.putBudget(c.db, c.body)),

  /* ---------- property and net worth (api2.ts) ---------- */
  r('GET', '/properties', (c) => svc.listProperties(c.db)),
  r('POST', '/properties', (c) => svc.createProperty(c.db, c.body)),
  r('PUT', '/properties/:id/valuation', (c) => svc.putValuation(c.db, Number(c.params.id), c.body)),
  r('POST', '/liabilities', (c) => svc.createLiability(c.db, c.body)),
  r('PUT', '/liabilities/:id/balance', (c) => svc.putLiabilityBalance(c.db, Number(c.params.id), c.body)),
  r('GET', '/networth', (c) => svc.getNetworth(c.db, c.today)),
  r('GET', '/activity', (c) => svc.getActivity(c.db)),

  /* ---------- goal, loans, Monte Carlo (api3.ts) ---------- */
  r('GET', '/goal', (c) => svc.getGoal(c.db, c.today)),
  r('PUT', '/goal', (c) => svc.putGoal(c.db, c.body)),
  r('POST', '/loans', (c) => svc.createLoan(c.db, c.body)),
  r('DELETE', '/loans/:id', (c) => svc.deleteLoan(c.db, Number(c.params.id))),
  r(
    'POST',
    '/simulate',
    (c) => {
      const p = c.body as SimParams
      if (
        !Number.isSafeInteger(p.startYear) ||
        !Number.isSafeInteger(p.endYear) ||
        p.endYear <= p.startYear ||
        p.endYear - p.startYear > 60
      )
        svc.bad('startYear/endYear out of range')
      p.paths = Math.min(5000, Math.max(200, p.paths ?? 2000))
      return simulate(p)
    },
    'never', // pure computation over the request; writes nothing
  ),

  /* ---------- taxes and paychecks (api5.ts) ---------- */
  r('GET', '/tax', (c) => getTax(c.db, c.today)),
  r('PUT', '/tax/settings', (c) => putTaxSettings(c.db, c.body)),
  r('POST', '/paychecks', (c) => createPaySource(c.db, c.body)),
  r('PUT', '/paychecks/:id', (c) => updatePaySource(c.db, Number(c.params.id), c.body)),
  r('DELETE', '/paychecks/:id', (c) => deletePaySource(c.db, Number(c.params.id))),

  /* ---------- digest and recurring (api6.ts) ---------- */
  r('GET', '/digest', (c) => {
    // The inherited mark is derived state: GET never dirties, so it rides
    // along with the next real save (and is simply copied again until then).
    if (c.identity) inheritDigestMark(c.db, c.identity, LEGACY_DIGEST_OWNER)
    // The server adds a mortgage-rate fetch here; a tab has no such fetcher.
    return { ...getDigest(c.db, digestOwner(c), c.today), errors: [] as string[] }
  }),
  r('POST', '/digest/ack', (c) => ackDigest(c.db, digestOwner(c))),
  r('GET', '/recurring', (c) => getRecurring(c.db, c.today)),

  /* ---------- scenarios (api7.ts) ---------- */
  r('GET', '/scenarios', (c) => listScenarios(c.db, c.today)),
  r('POST', '/scenarios', (c) => createScenario(c.db, c.body, c.today)),
  r('PUT', '/scenarios/:id', (c) => updateScenario(c.db, Number(c.params.id), c.body, c.today)),
  r('DELETE', '/scenarios/:id', (c) => deleteScenario(c.db, Number(c.params.id))),
  // Read-like POSTs: they simulate against the ledger and store nothing.
  r('POST', '/scenarios/compare', (c) => compareScenarios(c.db, c.today, c.body), 'never'),
  r('POST', '/scenarios/price', (c) => priceScenarioDecision(c.db, c.today, c.body), 'never'),

  /* ---------- whole-database export / import (api4.ts) ---------- */
  r('GET', '/export', (c) => dumpDb(c.db)),
  {
    ...r('POST', '/import', (c) => {
      const b = c.body as Dump & { confirm?: string }
      if (!b?.scarab || !b.tables) svc.bad('not a Scarab export')
      const why = readabilityError(b.schemaVersion)
      if (why) svc.bad(why)
      if (b.confirm !== 'REPLACE') svc.bad('this REPLACES every row of data — resend with confirm: "REPLACE"')
      const loaded = loadDump(c.db, b)
      const counts = Object.fromEntries(
        TABLES.map((t) => [t, (c.db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]),
      )
      return { ok: true, restored: counts, schemaVersion: CURRENT_VERSION, loadedFrom: loaded.from, upgraded: loaded.upgraded }
    }),
    replacesData: true,
  },
]
