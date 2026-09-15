import type { DbLike } from '../engine/db'
import { ApiError } from '../engine/services'
import type { Dump } from '../engine/snapshot'
import type { VaultHeader } from '../shared/vault'

/**
 * Local mode: the entire app runs against a SQLite database living in this
 * tab. Every /api call the screens make is dispatched to engine/services
 * instead of the network. The server's only remaining jobs are serving the
 * static bundle and couriering encrypted vault blobs (which pass through).
 *
 * State is per-tab and in-memory — leaving is a page reload; durable saves go
 * through the encrypted vault.
 */

/**
 * What an unlocked vault leaves behind in the tab: the raw data key and the
 * header it was wrapped with, so "save" reseals under the same key (the filed
 * recovery key keeps working) and the passphrase is never asked for twice.
 * Memory only — never persisted, gone on reload.
 */
export type VaultSession = { rawDataKey: Uint8Array; header: VaultHeader; version: number }

type LocalState = {
  db: (DbLike & { export(): Uint8Array }) | null
  vault: VaultSession | null
  dirty: boolean
  /** Monotonic count of writes this session. A save records it at dump time to know whether later writes slipped in. */
  writes: number
}
const state: LocalState = { db: null, vault: null, dirty: false, writes: 0 }

function markDirty() {
  state.writes++
  if (!state.dirty) {
    state.dirty = true
    window.dispatchEvent(new Event('scarab-mode'))
  }
}

export const localMode = {
  get active() {
    return state.db !== null
  },
  /** Writes since the last vault save (or since entering). */
  get dirty() {
    return state.dirty
  },
  get vault() {
    return state.vault
  },
  get writes() {
    return state.writes
  },
  setVault(v: VaultSession | null) {
    state.vault = v
    window.dispatchEvent(new Event('scarab-mode'))
  },
  /**
   * A save landed. `writesAtDump` is what `writes` read when the payload was
   * dumped; if more writes arrived while the upload was in flight the tab
   * stays dirty (and says so), so the next save picks them up.
   */
  markSaved(version: number, writesAtDump: number = state.writes) {
    state.dirty = writesAtDump !== state.writes
    if (state.vault) state.vault.version = version
    window.dispatchEvent(new Event('scarab-mode'))
  },
}

/**
 * Boot the in-tab engine. With a dump, the tab starts as that snapshot; with
 * null it starts from an empty, freshly migrated database — a session that
 * begins with no plaintext anywhere but this tab.
 */
export async function enterLocalMode(dump: Dump | null, vault: VaultSession | null = null): Promise<void> {
  const [{ openBrowserDb }, { migrate }, { loadDump }, wasmUrl] = await Promise.all([
    import('../engine/sqljs-db'),
    import('../engine/migrations'),
    import('../engine/snapshot'),
    import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
  ])
  const db = await openBrowserDb({ wasmUrl })
  migrate(db)
  if (dump) loadDump(db, dump)
  state.db = db
  state.vault = vault
  state.dirty = dump === null // an empty start has nothing saved yet
  state.writes = 0
  window.dispatchEvent(new Event('scarab-mode'))
}

/** Replace the tab's data in place — no reload, the session (and its key) survives. */
export async function loadLocalDump(dump: Dump): Promise<void> {
  if (!state.db) throw new Error('local mode is not active')
  const { loadDump } = await import('../engine/snapshot')
  loadDump(state.db, dump)
  state.dirty = false // caller decides: an unlock marks it saved, a file load marks it dirty
  markDirty()
}

export function exitLocalMode(): void {
  state.db = null
  state.vault = null
  state.dirty = false
  window.location.reload()
}

// Leaving the page discards the tab's database; warn if there's unsaved work.
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (state.db && state.dirty) {
      e.preventDefault()
      e.returnValue = ''
    }
  })

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
  if (method !== 'GET' && !(method === 'POST' && seg[0] === 'scenarios' && (seg[1] === 'compare' || seg[1] === 'price')))
    markDirty()

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
      case 'POST /prices/*': {
        // The one price path that touches the network: the shared daily
        // basket, identical for everyone. Which symbols matter is decided here.
        const r = await fetch('/api/basket')
        if (!r.ok) throw new Error(`price basket: ${r.status} ${r.statusText}`)
        return svc.applyBasket(db, (await r.json()) as Parameters<typeof svc.applyBasket>[1])
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
      case 'GET /digest': {
        const dg = await import('../engine/digest')
        return { ...dg.getDigest(db, 'local', todayIso()), errors: [] }
      }
      case 'POST /digest/*': {
        const dg = await import('../engine/digest')
        return dg.ackDigest(db, 'local')
      }
      case 'GET /recurring': {
        const rc = await import('../engine/recurring')
        return rc.getRecurring(db, todayIso())
      }
      case 'GET /tax': {
        const tax = await import('../engine/tax')
        return tax.getTax(db, todayIso())
      }
      case 'PUT /tax/*': {
        const tax = await import('../engine/tax')
        return tax.putTaxSettings(db, b)
      }
      case 'POST /paychecks': {
        const pc = await import('../engine/paychecks')
        return pc.createPaySource(db, b)
      }
      case 'PUT /paychecks/*': {
        const pc = await import('../engine/paychecks')
        return pc.updatePaySource(db, Number(seg[1]), b)
      }
      case 'DELETE /paychecks/*': {
        const pc = await import('../engine/paychecks')
        return pc.deletePaySource(db, Number(seg[1]))
      }
      case 'GET /scenarios': {
        const sc = await import('../engine/scenarios')
        return sc.listScenarios(db, todayIso())
      }
      case 'POST /scenarios':
      case 'POST /scenarios/*': {
        const sc = await import('../engine/scenarios')
        if (seg[1] === 'compare') return sc.compareScenarios(db, todayIso(), b)
        if (seg[1] === 'price') return sc.priceScenarioDecision(db, todayIso(), b)
        return sc.createScenario(db, b, todayIso())
      }
      case 'PUT /scenarios/*': {
        const sc = await import('../engine/scenarios')
        return sc.updateScenario(db, Number(seg[1]), b, todayIso())
      }
      case 'DELETE /scenarios/*': {
        const sc = await import('../engine/scenarios')
        return sc.deleteScenario(db, Number(seg[1]))
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
