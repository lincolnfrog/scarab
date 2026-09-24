import type { DbLike } from '../engine/db'
import { ApiError } from '../engine/errors'
import type { Dump } from '../engine/snapshot'
import type { BrowserDb } from '../engine/sqljs-db'
import { todayLocal } from '../shared/dates'
import type { VaultHeader } from '../shared/vault'
import { isNetworkOnly, loadRoutes } from './local/routes'
import { matchRoute, policyOf, type LocalCtx } from './local/table'

/**
 * Local mode: the entire app runs against a SQLite database living in this
 * tab. Every /api call the screens make is dispatched to the in-tab route
 * table (src/local/) instead of the network — the same paths and payloads,
 * answered by the same engine functions the server calls. The server's only
 * remaining jobs are serving the static bundle and couriering encrypted vault
 * blobs (which pass through).
 *
 * State is per-tab and in-memory — leaving is a page reload; durable saves go
 * through the encrypted vault.
 *
 * Events, all on `window`:
 *   'scarab-mode'     a state transition — entered, turned dirty, saved, vault or identity changed
 *   'scarab-write'    every write that changed the database, once it is applied (autosave debounces on it)
 *   'scarab-data'     the tab's data was replaced in place; dataEpoch moved (screens re-read)
 *   'scarab-revision' anything in the database changed, unsaved work or not; dataRevision moved
 */

/**
 * What an unlocked vault leaves behind in the tab: the raw data key and the
 * header it was wrapped with, so "save" reseals under the same key (the filed
 * recovery key keeps working) and the passphrase is never asked for twice.
 * Memory only — never persisted, gone on reload.
 */
export type VaultSession = { rawDataKey: Uint8Array; header: VaultHeader; version: number }

/**
 * What loading a snapshot did: the version it was written at, and which
 * tier-C upgrades this engine had to replay to read it (see
 * engine/upgrades.ts).
 */
export type SnapshotLoad = { from: number; upgraded: number[] }

type LocalState = {
  db: BrowserDb | null
  vault: VaultSession | null
  dirty: boolean
  /** Monotonic count of writes this session. A save records it at dump time to know whether later writes slipped in. */
  writes: number
  /** The IAP identity this tab was opened by; survives entering and leaving a session. */
  identity: string | null
  /** Bumped whenever the tab's data is replaced in place, so screens keyed on it remount. */
  dataEpoch: number
  /**
   * Bumped whenever the database changed at all: every dispatch that moved its
   * change counter, whatever the route's dirty policy, and every new or
   * replaced database. Never reset, so it names one state of the data for the
   * life of the page.
   */
  dataRevision: number
}
const state: LocalState = { db: null, vault: null, dirty: false, writes: 0, identity: null, dataEpoch: 0, dataRevision: 0 }

const announce = (event: 'scarab-mode' | 'scarab-write' | 'scarab-data' | 'scarab-revision') => window.dispatchEvent(new Event(event))

/** A write landed in the tab's database. Called after it is applied, never before. */
function markDirty() {
  state.writes++
  const wasDirty = state.dirty
  state.dirty = true
  if (!wasDirty) announce('scarab-mode')
  announce('scarab-write')
}

/** The tab's data was swapped wholesale: anything read before is stale. */
function markDataReplaced() {
  state.dataEpoch++
  announce('scarab-data')
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
  /** Who is signed in (IAP), as the in-tab engine attributes digests and imports; null until App learns it. */
  get identity() {
    return state.identity
  },
  /** Increments on every in-place data replacement (loadLocalDump, POST /import). Key screens on it. */
  get dataEpoch() {
    return state.dataEpoch
  },
  /**
   * Increments whenever anything in the tab's database changes, including
   * writes that leave no unsaved work (a price refresh storing quotes, a read
   * that seeds a default). A cache of results computed from the data keys on
   * it: the same revision means the same data.
   */
  get dataRevision() {
    return state.dataRevision
  },
  setVault(v: VaultSession | null) {
    state.vault = v
    announce('scarab-mode')
  },
  /** App calls this with /api/me's email before the front door enters a session. */
  setIdentity(email: string | null) {
    const next = email?.trim() || null
    if (next === state.identity) return
    state.identity = next
    announce('scarab-mode')
  },
  /**
   * A save landed. `writesAtDump` is what `writes` read when the payload was
   * dumped; if more writes arrived while the upload was in flight the tab
   * stays dirty (and says so), so the next save picks them up.
   */
  markSaved(version: number, writesAtDump: number = state.writes) {
    state.dirty = writesAtDump !== state.writes
    if (state.vault) state.vault.version = version
    announce('scarab-mode')
  },
}

/**
 * Boot the in-tab engine. With a dump, the tab starts as that snapshot; with
 * null it starts from an empty, freshly migrated database — a session that
 * begins with no plaintext anywhere but this tab.
 */
export async function enterLocalMode(
  dump: Dump | null,
  vault: VaultSession | null = null,
): Promise<SnapshotLoad | null> {
  const [{ openBrowserDb }, { migrate }, { loadDump }, wasmUrl] = await Promise.all([
    import('../engine/sqljs-db'),
    import('../engine/migrations'),
    import('../engine/snapshot'),
    import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
  ])
  const db = await openBrowserDb({ wasmUrl })
  migrate(db)
  const loaded = dump ? loadDump(db, dump) : null
  // Entering again replaces the tab's database (an unlock after a Create vault
  // that failed once the engine was up): free the old one, or sql.js keeps it.
  const prev = state.db
  state.db = db
  state.vault = vault
  // An empty start has nothing saved yet; so does a snapshot this engine had to
  // upgrade on the way in — the stored copy is still the older one until a save
  // reseals it at the current version.
  state.dirty = dump === null || (loaded !== null && loaded.upgraded.length > 0)
  state.writes = 0
  state.dataRevision++
  if (prev && prev !== db) {
    try {
      prev.close()
    } catch (e) {
      console.error('local mode: closing the replaced database failed', e)
    }
  }
  announce('scarab-mode')
  announce('scarab-revision')
  return loaded
}

/** Replace the tab's data in place — no reload, the session (and its key) survives. */
export async function loadLocalDump(dump: Dump): Promise<SnapshotLoad> {
  if (!state.db) throw new Error('local mode is not active')
  const { loadDump } = await import('../engine/snapshot')
  const loaded = loadDump(state.db, dump)
  state.dataRevision++
  markDataReplaced()
  state.dirty = false // caller decides: an unlock marks it saved, a file load leaves it dirty
  markDirty()
  announce('scarab-revision')
  return loaded
}

export function exitLocalMode(): void {
  state.db = null
  state.vault = null
  state.dirty = false
  window.location.reload()
}

const HOUSEHOLD_CHOICE_KEY = 'scarab:chose-household'

/**
 * The front door's "Continue in household mode" while a session is already
 * booted behind it (a Create vault that failed after starting the engine, or
 * one that just made a vault). Household mode means the server's data, but a
 * live session answers every /api call from this tab — so end it (the page
 * reloads) and have the next load go straight to household mode.
 */
export function exitToHousehold(): void {
  try {
    sessionStorage.setItem(HOUSEHOLD_CHOICE_KEY, '1')
  } catch {
    /* the reload shows the front door again; the choice is one click away there */
  }
  exitLocalMode()
}

let householdChoice: boolean | undefined
/** Whether this page load follows exitToHousehold. Read once per load (and cleared), so a later reload asks again. */
export function takeHouseholdChoice(): boolean {
  if (householdChoice === undefined) {
    try {
      householdChoice = sessionStorage.getItem(HOUSEHOLD_CHOICE_KEY) === '1'
      sessionStorage.removeItem(HOUSEHOLD_CHOICE_KEY)
    } catch {
      householdChoice = false
    }
  }
  return householdChoice
}

// Leaving the page discards the tab's database; warn if there's unsaved work.
if (typeof window !== 'undefined')
  window.addEventListener('beforeunload', (e) => {
    if (state.db && state.dirty) {
      e.preventDefault()
      e.returnValue = ''
    }
  })

/**
 * Rows changed on this connection since it opened, counting every INSERT,
 * UPDATE and DELETE. Prepared per call: sql.js frees every statement on
 * export(), so a cached one could go stale.
 */
const totalChanges = (db: DbLike) => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  typeof (v as PromiseLike<unknown> | null)?.then === 'function'

/**
 * Answer one /api call from the tab's database. Mirrors the server: same
 * route table shape, same engine calls, and an engine ApiError becomes a
 * plain Error carrying its message, as a failed fetch does in api.ts.
 *
 * A call dirties the tab only when its route's policy is 'auto' and the
 * database's change counter moved across the handler: a write that failed
 * validation or changed nothing leaves the tab clean, and the write is
 * counted only after it is applied, so a save that dumps mid-call can't claim
 * it. (A handler that throws after partly writing counts as a change: better
 * one extra save than a lost edit.) Sync handlers — all but the network-backed
 * price refresh — run and settle in one uninterrupted turn.
 *
 * Whatever the policy, a call that moved the counter bumps dataRevision
 * (before the other announcements, so their listeners read the new value): a
 * 'never' price refresh stores quotes that change what the screens compute
 * without being unsaved work. A refresh that runs the history import through
 * a nested call bumps it once for each, and one that awaited while another
 * call wrote bumps it for that write too: an extra bump, never a missed one.
 */
export async function localDispatch(method: string, rawUrl: string, body?: unknown): Promise<unknown> {
  if (!state.db) throw new Error('local mode is not active')
  const url = new URL(rawUrl, 'http://local')
  if (!/^\/api(?:\/|$)/.test(url.pathname)) throw new Error(`local mode answers /api paths only, not ${url.pathname}`)
  const path = url.pathname.slice('/api'.length) || '/'
  const verb = method.toUpperCase()
  const hit = matchRoute(await loadRoutes(), verb, path)
  if (!hit)
    throw new Error(
      isNetworkOnly(path)
        ? `${verb} /api${path} is served by the network, never by the in-tab engine`
        : `local mode has no handler for ${verb} ${path}`,
    )
  const db = state.db
  if (!db) throw new Error('local mode is not active') // the session ended while the routes loaded

  const ctx: LocalCtx = {
    db,
    params: hit.params,
    query: url.searchParams,
    body: body ?? {},
    today: todayLocal(),
    identity: state.identity,
  }
  const watch = policyOf(hit.route) === 'auto'
  const before = totalChanges(db)
  let succeeded = false
  try {
    const out = hit.route.handler(ctx)
    const result = isThenable(out) ? await out : out
    succeeded = true
    return result
  } catch (e) {
    if (e instanceof ApiError) throw new Error(e.message)
    throw e
  } finally {
    // Only if this is still the database the call ran against: a session that
    // ended (or restarted) mid-call has nothing left to dirty.
    if (state.db === db && totalChanges(db) !== before) {
      state.dataRevision++
      if (watch) {
        markDirty()
        if (succeeded && hit.route.replacesData) markDataReplaced()
      }
      announce('scarab-revision')
    }
  }
}

/** The current local database as a snapshot (for vault saves). */
export async function localDump(): Promise<Dump> {
  if (!state.db) throw new Error('local mode is not active')
  const { dumpDb } = await import('../engine/snapshot')
  return dumpDb(state.db)
}
