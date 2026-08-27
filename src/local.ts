import type { DbLike } from '../engine/db'
import { ApiError } from '../engine/services'
import type { Dump } from '../engine/snapshot'

/**
 * Local mode: the entire app runs against a SQLite database living in this
 * tab. Every /api call the screens make is dispatched to engine/services
 * instead of the network. The server's only remaining jobs are serving the
 * static bundle and couriering encrypted vault blobs (which pass through).
 *
 * State is per-tab and in-memory — leaving is a page reload; durable saves go
 * through the encrypted vault.
 */

type LocalState = { db: (DbLike & { export(): Uint8Array }) | null }
const state: LocalState = { db: null }

export const localMode = {
  get active() {
    return state.db !== null
  },
}

export async function enterLocalMode(dump: Dump): Promise<void> {
  const [{ openBrowserDb }, { migrate }, { loadDump }, wasmUrl] = await Promise.all([
    import('../engine/sqljs-db'),
    import('../engine/migrations'),
    import('../engine/snapshot'),
    import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
  ])
  const db = await openBrowserDb({ wasmUrl })
  migrate(db)
  loadDump(db, dump)
  state.db = db
  window.dispatchEvent(new Event('scarab-mode'))
}

export function exitLocalMode(): void {
  state.db = null
  window.location.reload()
}

const todayIso = () => new Date().toISOString().slice(0, 10)

export async function localDispatch(method: string, rawUrl: string, body?: unknown): Promise<unknown> {
  const db = state.db
  if (!db) throw new Error('local mode is not active')
  const url = new URL(rawUrl, 'http://local')
  const path = url.pathname.replace(/^\/api/, '')
  const q = url.searchParams
  const svc = await import('../engine/services')
  const snapshot = await import('../engine/snapshot')
  const b = (body ?? {}) as never
  const seg = path.split('/').filter(Boolean)
  const key = `${method} /${seg[0] ?? ''}${seg.length > 1 ? '/*' : ''}`

  try {
    switch (key) {
      case 'GET /me':
        return { email: 'you · local tab' }
      case 'GET /health':
        return svc.health()
      case 'GET /accounts':
        return svc.listAccounts(db)
      case 'POST /accounts':
        return svc.createAccount(db, b)
      case 'PATCH /accounts/*':
        return svc.anchorAccount(db, Number(seg[1]), b)
      case 'GET /categories':
        return svc.listCategories(db)
      case 'POST /categories':
        return svc.createCategory(db, b)
      case 'POST /imports':
        return svc.runImport(db, b, 'local')
      case 'GET /imports':
        return svc.listImports(db)
      case 'GET /transactions':
        return svc.listTransactions(db, {
          q: q.get('q') ?? undefined,
          month: q.get('month') ?? undefined,
          categoryId: q.get('category_id') ?? undefined,
          accountId: q.get('account_id') ?? undefined,
          uncategorized: q.get('uncategorized') === '1',
        })
      case 'PATCH /transactions/*':
        return svc.patchTransaction(db, Number(seg[1]), b)
      case 'GET /cashflow/*':
        return seg[1] === 'monthly' ? svc.cashflowMonthly(db) : svc.cashflowCategories(db, q.get('month') ?? undefined)
      case 'GET /budget':
        return svc.getBudget(db, q.get('month') ?? undefined)
      case 'PUT /budget':
        return svc.putBudget(db, b)
      case 'GET /invest/*':
        return svc.listInvestAccounts(db)
      case 'POST /invest/*':
        return svc.createInvestAccount(db, b)
      case 'PUT /invest/*':
        return svc.putBalanceSnapshot(db, b)
      case 'POST /trades':
        return svc.createTrade(db, b)
      case 'GET /trades':
        return svc.listTrades(db)
      case 'GET /portfolio':
        return svc.getPortfolio(db, todayIso())
      case 'POST /prices/*':
        return {
          updated: 0,
          backfilled: 0,
          errors: ['price refresh is network-bound — exit local mode to refresh, prices here are as of your snapshot'],
        }
      case 'GET /properties':
        return svc.listProperties(db)
      case 'POST /properties':
        return svc.createProperty(db, b)
      case 'PUT /properties/*':
        return svc.putValuation(db, Number(seg[1]), b)
      case 'POST /liabilities':
        return svc.createLiability(db, b)
      case 'PUT /liabilities/*':
        return svc.putLiabilityBalance(db, Number(seg[1]), b)
      case 'GET /networth':
        return svc.getNetworth(db, todayIso())
      case 'GET /activity':
        return svc.getActivity(db)
      case 'GET /unvested':
        return svc.getUnvested(db)
      case 'PUT /unvested':
        return svc.putUnvested(db, b, todayIso())
      case 'POST /unvested/*':
        return svc.vestUnvested(db, b, todayIso())
      case 'GET /charts/*':
        return svc.getChartData(db, seg[1]!, [])
      case 'GET /goal':
        return svc.getGoal(db)
      case 'PUT /goal':
        return svc.putGoal(db, b)
      case 'POST /loans':
        return svc.createLoan(db, b)
      case 'DELETE /loans/*':
        return svc.deleteLoan(db, Number(seg[1]))
      case 'GET /tax': {
        const tax = await import('../engine/tax')
        return tax.getTax(db, todayIso())
      }
      case 'PUT /tax/*': {
        const tax = await import('../engine/tax')
        return tax.putTaxSettings(db, b)
      }
      case 'POST /simulate': {
        const { simulate } = await import('../engine/simulate')
        const p = b as import('../engine/simulate').SimParams
        p.paths = Math.min(5000, Math.max(200, p.paths ?? 2000))
        return simulate(p)
      }
      case 'GET /export':
        return snapshot.dumpDb(db)
      case 'POST /import': {
        snapshot.loadDump(db, b as import('../engine/snapshot').Dump)
        return { ok: true, restored: 'local' }
      }
      default:
        throw new Error(`local mode has no handler for ${method} ${path}`)
    }
  } catch (e) {
    if (e instanceof ApiError) throw new Error(e.message)
    throw e
  }
}

/** The current local database as a snapshot (for vault saves). */
export async function localDump(): Promise<Dump> {
  if (!state.db) throw new Error('local mode is not active')
  const { dumpDb } = await import('../engine/snapshot')
  return dumpDb(state.db)
}
