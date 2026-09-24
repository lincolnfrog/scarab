import type { Dump } from '../engine/snapshot'
import type { VaultBlob, VaultHeader } from '../shared/vault'
import type { VaultSession } from './local'

/**
 * The vault sync pipeline, free of the browser so it can be tested with fakes.
 *
 * Saving, in two pieces:
 *
 *   createSaveQueue — saves run one at a time, and each one reads the session
 *     (key, header, version) when it RUNS, not when it was requested. A change
 *     to the header or the key is a function applied at that moment
 *     (`update`), so an autosave queued behind "add passkey" seals the new
 *     wrapping, and one queued behind a rotation seals under the new key —
 *     neither can put back what it replaced. A dump whose tables equal the
 *     last sealed ones uploads nothing. A save whose response was lost is
 *     recognised when the next one hits a version conflict carrying our own
 *     hash, and adopted instead of reported as a conflict with ourselves —
 *     or at once, when the caller asks the courier what it holds (`settle`).
 *
 *   createAutosave — when to save: 1.5s after the last write, at once when
 *     the tab is hidden, and after a failure that might heal (offline, 5xx) on
 *     a backoff of 2s → 5s → 15s → 60s, or immediately when the browser comes
 *     back online or the tab regains focus. A version conflict (409) or an
 *     oversized vault (413) is sticky: retrying either helps nobody, so it
 *     waits for the person (a manual save, or unlocking again).
 *
 * Following the other member's saves:
 *
 *   decideOnPoll — what a tab does when the server's version isn't its own:
 *     follow along (a clean tab), or ask the person (unsaved work, or a
 *     server that went backwards).
 *
 *   createWatcher — when to ask the server: every 45s while the tab is
 *     visible and holds a vault, at once on focus, never while hidden.
 *
 *   createTabPresence — "Scarab is open in another tab": a ping on a
 *     BroadcastChannel, so a second session in the same browser knows it
 *     isn't the first. Nothing leaves the browser.
 *
 * src/session.ts wires them to the real tab (localMode, fetch, WebCrypto).
 */

/** Why the server's history should keep a replaced version longer (server/api4.ts HISTORY_PINS). */
export type HistoryPin = 'pre-upgrade' | 'pre-restore'

export type SaveResult = {
  version: number
  /** SHA-256 (hex) of the stored ciphertext as the server computed it. */
  sha256: string
  /** Plaintext bytes that were sealed. */
  bytes: number
  /** Nothing changed since the last save: no upload happened, and `version` is the one already stored. */
  skipped: boolean
}

/* ---------- failures ---------- */

/** A failed HTTP exchange. `status` is null when no response arrived at all (offline, DNS, CORS, reset). */
export class NetError extends Error {
  readonly status: number | null
  readonly body: Record<string, unknown> | null
  constructor(message: string, status: number | null, body: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'NetError'
    this.status = status
    this.body = body
  }
}

export type FailureKind = 'conflict' | 'toolarge' | 'transient' | 'fatal'

/**
 * What a failed save means for trying again. Only errors that carry an HTTP
 * outcome are classified: anything else (a bug, a refused update) is fatal.
 */
export function failureKind(e: unknown): FailureKind {
  if (!(e instanceof NetError)) return 'fatal'
  if (e.status === null) return 'transient'
  if (e.status === 409) return 'conflict'
  if (e.status === 413) return 'toolarge'
  if (e.status >= 500 || e.status === 408 || e.status === 429) return 'transient'
  return 'fatal'
}

/* ---------- the queue ---------- */

export type SaveQueueDeps = {
  /** The tab's vault session right now (localMode.vault). */
  session: () => VaultSession | null
  /** The tab's monotonic write counter (localMode.writes). */
  writes: () => number
  /** Snapshot the tab's database. */
  dump: () => Promise<Dump>
  /**
   * Encrypt `plaintext` under the session's key with its header, to be stored
   * as courier version `seq` — always the version the upload expects + 1, so
   * the sealed header says which version it was made for (vault format v3).
   */
  seal: (s: VaultSession, plaintext: Uint8Array, seq: number) => Promise<VaultBlob>
  /**
   * PUT /api/vault. Throws a NetError on failure; a 409's body carries
   * serverVersion and serverSha256. `baseSha256`, when the tab knows it, is
   * the SHA-256 of the stored version the upload is based on: the server
   * refuses (409) if what it holds at `version` isn't that blob — a vault
   * deleted and created again, or restored, at the same version number.
   */
  put: (body: { data: string; version: number; baseSha256?: string; purgeHistory?: true; pin?: HistoryPin }) => Promise<{ version: number; sha256: string }>
  /**
   * The pin, if any, that the stored version an upload replaces should carry
   * in the server's history (vault history keeps pinned versions longer).
   * Asked on every attempt with the session the upload is based on, so a pin
   * follows that one version: the copy a snapshot upgrade is about to
   * rewrite, or the version a restore is about to put something else over.
   */
  pin?: (base: VaultSession) => HistoryPin | undefined
  /** SHA-256 hex of bytes, or of a string's UTF-8 (the same digest the server takes of `data`). */
  sha256: (data: string | Uint8Array) => Promise<string>
  /**
   * A save landed: make `s` the tab's session and mark the tab saved as of
   * the dump. `stored` is what the courier now holds: the seq it was sealed
   * for, the SHA-256 of its data as this tab computed it, and its length.
   */
  commit: (s: VaultSession, writesAtDump: number, stored: { seq: number; sha256: string; size: number }) => void
  /** Nothing needed uploading: mark the tab saved as of the dump, at the version it already has. */
  markSaved: (version: number, writesAtDump: number) => void
}

export type SaveOptions = {
  /** Upload even when the tables are unchanged. */
  force?: boolean
  /** Create: the session to save when the tab has none yet (version 0 — the server refuses if a vault exists). */
  seed?: VaultSession
  /**
   * Save on top of this session instead of the tab's: its version is the one
   * the upload expects and its header is what gets sealed ("keep mine": this
   * tab's data over the version another member saved). It must hold the
   * tab's own key — a vault re-keyed meanwhile is refused, never resealed
   * under the old key. Always uploads.
   */
  rebase?: VaultSession
  /** With `rebase`: the SHA-256 of the stored version it is on top of (sent as the upload's baseSha256). */
  baseSha256?: string
  /** Requested by autosave (only changes how failures are reported to the autosave controller). */
  auto?: boolean
  /**
   * The upload asks the server to drop every earlier version it keeps (vault
   * history and the previous blob) — a re-key: what is kept is sealed under
   * the key being retired. Sent with every attempt of this save.
   */
  purgeHistory?: boolean
}

export type SaveJobInfo = { auto: boolean; update: boolean; seed: boolean }

export type SaveEvents = {
  start?: (job: SaveJobInfo) => void
  success?: (r: SaveResult, job: SaveJobInfo) => void
  failure?: (e: unknown, job: SaveJobInfo) => void
}

export type SaveQueue = {
  /**
   * Queue a save. `update` runs when the save does, on the session as it is
   * then, and the result is what gets sealed and — only if the upload
   * succeeds — becomes the session. It may throw to refuse (nothing is
   * uploaded). Keep it idempotent: after adopting a lost upload the job runs
   * once more from the top.
   */
  save: (update?: (s: VaultSession) => VaultSession, o?: SaveOptions) => Promise<SaveResult>
  /** Saves queued or running. */
  inFlight: () => number
  /**
   * The tab now holds exactly `dump`, which is what the vault stores at
   * `s.version` (an unlock). Records it as the last sealed state so a save
   * before any real edit uploads nothing, and forgets any lost upload from
   * before. Runs in queue order.
   */
  loaded: (s: VaultSession, dump: Dump, stored: { sha256: string; bytes: number }) => Promise<void>
  /**
   * The vault stores, at `version`, a blob whose data hashes to `sha256` —
   * an unlock that can't serve as the no-op baseline (it must be resealed
   * anyway), or a refresh. Uploads based on that version then say so
   * (baseSha256). Forgets any lost upload from before. Runs in queue order.
   */
  known: (version: number, sha256: string) => Promise<void>
  /** What the courier holds as far as this tab knows (its version and the SHA-256 of its data), or null. */
  storedAs: () => { version: number; sha256: string } | null
  /**
   * Did an upload whose answer never came land after all? Only while one is
   * outstanding, `probe` asks the courier what it holds now (its version,
   * and the SHA-256 of its data as this tab computes it). If that is
   * byte-for-byte one of those uploads, one version on, it is adopted as a
   * 409 carrying it would adopt it — committed as of its own dump. Runs in
   * queue order. The adopted save, or null (nothing outstanding, or the
   * courier holds something else — which proves nothing: a request still on
   * its way may land later, so those uploads stay outstanding).
   */
  settle: (probe: () => Promise<{ version: number; sha256: string } | null>) => Promise<SaveResult | null>
  /**
   * Run `fn` in queue order, with no save running alongside it — for
   * replacing the tab's data with the stored vault, which must not interleave
   * with an upload of the data it replaces.
   */
  exclusive: <T>(fn: () => Promise<T>) => Promise<T>
}

const utf8 = new TextEncoder()

/**
 * A dump as a save seals it, serialized once (a household's dump runs to
 * megabytes). `plaintext` is its JSON as UTF-8 — what gets sealed. `key` is
 * what the no-op check hashes: the schema version and the tables, not
 * `exportedAt` (which changes on every dump) — a view into those same bytes,
 * not a copy. The fields outside the key go first, so the key is one run at
 * the end: `"schemaVersion":…,"tables":{…}}`.
 */
export function encodeDump(dump: Dump): { plaintext: Uint8Array; key: Uint8Array } {
  const { schemaVersion, tables, ...rest } = dump
  const text = JSON.stringify({ ...rest, schemaVersion, tables })
  const plaintext = utf8.encode(text)
  // What precedes the key: `rest` as JSON with its closing brace turned into a comma ("{" alone when empty).
  const head = JSON.stringify(rest)
  const lead = head === '{}' ? '{' : `${head.slice(0, -1)},`
  // (Never otherwise for a real dump. If it were, the whole plaintext is the key: a no-op save uploads, nothing worse.)
  const at = text.startsWith(lead) && text.startsWith('"schemaVersion":', lead.length) ? utf8.encode(lead).length : 0
  return { plaintext, key: plaintext.subarray(at) }
}

/** Unanswered uploads remembered for adoption (a long offline stretch retries many times). */
const MAX_UNKNOWN = 16

type Sealed = { key: Uint8Array; header: VaultHeader; version: number; hash: string; sha256: string; bytes: number }
/** An upload: `version` is the one it expected (it was sealed as version + 1); `size` is its data's length. */
type Sent = { session: VaultSession; version: number; sha256: string; hash: string; writesAtDump: number; bytes: number; size: number }

export function createSaveQueue(deps: SaveQueueDeps, events: SaveEvents = {}): SaveQueue {
  let chain: Promise<unknown> = Promise.resolve()
  let queued = 0
  /** The state the vault holds, as far as this tab knows: what it last sealed, or what it unlocked. */
  let sealed: Sealed | null = null
  /** Uploads whose outcome never arrived (no response, or a 5xx) since the server last answered. Any may have landed. */
  let unknown: Sent[] = []
  /** What the courier holds as far as this tab knows: the version and the SHA-256 of its data. */
  let courier: { version: number; sha256: string } | null = null

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    queued++
    const run = chain.then(fn, fn)
    chain = run.catch(() => undefined)
    return run.finally(() => {
      queued--
    })
  }

  /** Is the session exactly the one `sealed` describes (same key, same header object, same version)? */
  const isSealed = (s: VaultSession) =>
    sealed !== null && sealed.key === s.rawDataKey && sealed.header === s.header && sealed.version === s.version

  /**
   * The courier holds, at `serverVersion`, a blob whose data hashes to
   * `serverSha256` (a 409's body, or a probe): if that is byte-for-byte our
   * unanswered upload, one version on, that upload landed and only the
   * response was lost. Adopt it — its session at the server's version, saved
   * as of its own dump.
   */
  function adoptLost(serverVersion: unknown, serverSha256: unknown): Sent | null {
    const lost = unknown.find((u) => u.sha256 === serverSha256 && u.version + 1 === serverVersion)
    if (!lost) return null
    const s: VaultSession = { ...lost.session, version: lost.version + 1 }
    deps.commit(s, lost.writesAtDump, { seq: lost.version + 1, sha256: lost.sha256, size: lost.size })
    sealed = { key: s.rawDataKey, header: s.header, version: s.version, hash: lost.hash, sha256: lost.sha256, bytes: lost.bytes }
    courier = { version: s.version, sha256: lost.sha256 }
    unknown = []
    return lost
  }

  async function job(update: ((s: VaultSession) => VaultSession) | undefined, o: SaveOptions): Promise<SaveResult> {
    for (let round = 0; ; round++) {
      const current = deps.session()
      if (o.seed && current) throw new Error('this session already has a vault')
      if (o.rebase && (!current || o.rebase.rawDataKey !== current.rawDataKey))
        throw new Error('the vault was re-keyed meanwhile — nothing was saved')
      // After adopting a lost upload the tab's session is already past the rebase target: go on from it.
      const base = (round === 0 ? o.rebase : undefined) ?? current ?? o.seed
      if (!base) throw new Error('no vault yet — create one first')
      const next = update ? update(base) : base

      // Count writes BEFORE dumping: one that lands while the dump is taken is
      // in the payload but not in this count, so the tab stays dirty and the
      // next save covers it — never the reverse.
      const writesAtDump = deps.writes()
      const { plaintext, key } = encodeDump(await deps.dump())
      const hash = await deps.sha256(key)
      if (!update && !o.force && !o.seed && !o.rebase && isSealed(base) && sealed!.hash === hash) {
        deps.markSaved(base.version, writesAtDump)
        return { version: base.version, sha256: sealed!.sha256, bytes: sealed!.bytes, skipped: true }
      }

      const blob = await deps.seal(next, plaintext, base.version + 1)
      const data = JSON.stringify(blob)
      const sent: Sent = {
        session: next,
        version: base.version,
        sha256: await deps.sha256(data),
        hash,
        writesAtDump,
        bytes: plaintext.length,
        size: data.length,
      }
      // Which stored blob this is on top of, when known: the server refuses it
      // over a vault replaced at the same version number (never overwrites it).
      const baseSha256 = round === 0 && o.rebase ? o.baseSha256 : courier?.version === base.version ? courier.sha256 : undefined
      // A pin rides only on an upload that replaces something the server keeps (not a create, not a purge).
      const pin = base.version > 0 && !o.purgeHistory ? deps.pin?.(base) : undefined
      let r: { version: number; sha256: string }
      try {
        r = await deps.put({
          data,
          version: base.version,
          ...(baseSha256 ? { baseSha256 } : {}),
          ...(o.purgeHistory ? { purgeHistory: true as const } : {}),
          ...(pin ? { pin } : {}),
        })
      } catch (e) {
        const kind = failureKind(e)
        const b = e instanceof NetError ? e.body : null
        if (kind === 'conflict' && round === 0 && b && adoptLost(b.serverVersion, b.serverSha256)) continue // go again, on top of the adopted version
        // Only a transient failure leaves an upload that may yet turn out to
        // have landed; any definitive answer settles every earlier one too.
        unknown = kind === 'transient' ? [...unknown.slice(-(MAX_UNKNOWN - 1)), sent] : []
        throw e
      }
      unknown = []
      const saved: VaultSession = { ...next, version: r.version }
      // The tab moved to another session while this one uploaded (an unlock):
      // the upload stands, but it must not overwrite what the tab holds now.
      // (The courier stores an upload as expected + 1, the seq it was sealed for.)
      if (deps.session() === current) {
        deps.commit(saved, writesAtDump, { seq: base.version + 1, sha256: sent.sha256, size: sent.size })
        sealed = { key: saved.rawDataKey, header: saved.header, version: r.version, hash, sha256: r.sha256, bytes: sent.bytes }
        courier = { version: r.version, sha256: r.sha256 }
      }
      return { version: r.version, sha256: r.sha256, bytes: sent.bytes, skipped: false }
    }
  }

  return {
    save(update, o = {}) {
      const info: SaveJobInfo = { auto: o.auto === true, update: update !== undefined, seed: o.seed !== undefined }
      return enqueue(async () => {
        events.start?.(info)
        try {
          const r = await job(update, o)
          events.success?.(r, info)
          return r
        } catch (e) {
          events.failure?.(e, info)
          throw e
        }
      })
    },
    inFlight: () => queued,
    loaded(s, dump, stored) {
      return enqueue(async () => {
        unknown = []
        const hash = await deps.sha256(encodeDump(dump).key)
        sealed ={ key: s.rawDataKey, header: s.header, version: s.version, hash, ...stored }
        courier = { version: s.version, sha256: stored.sha256 }
      })
    },
    known(version, sha256) {
      return enqueue(async () => {
        unknown = []
        courier = { version, sha256 }
      })
    },
    storedAs: () => courier && { ...courier },
    settle(probe) {
      return enqueue(async () => {
        if (unknown.length === 0) return null
        const now = await probe()
        const lost = now ? adoptLost(now.version, now.sha256) : null
        return lost && { version: lost.version + 1, sha256: lost.sha256, bytes: lost.bytes, skipped: false }
      })
    },
    exclusive: (fn) => enqueue(fn),
  }
}

/* ---------- following the other member's saves ---------- */

/** The server's timestamps: SQLite datetime('now') ('2026-09-23 14:02:11', UTC) or ISO-8601. Epoch ms, or null. */
export function parseServerTime(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s.trim())
  if (!m) return null
  if (m[7] && m[7] !== 'Z') {
    const t = Date.parse(s.trim().replace(' ', 'T'))
    return Number.isNaN(t) ? null : t
  }
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0))
  return Number.isNaN(t) ? null : t
}

/**
 * `none` — nothing to do (in step, or a save of ours is running: its outcome settles it).
 * `refresh` — the server moved on and this tab has no unsaved work: load it.
 * `banner` — the server moved on over unsaved work here, or went backwards
 *   (deleted, replaced, restored): the person decides (the conflict sheet).
 */
export type PollDecision = 'none' | 'refresh' | 'banner'

/**
 * What a tab does about the stored vault's version (null: none stored). Pure.
 * `replaced`: the server's blob at this tab's own version isn't the one this
 * tab knows (deleted and created again, or restored, at the same number).
 */
export function decideOnPoll(p: {
  serverVersion: number | null
  sessionVersion: number | null
  dirty: boolean
  inFlight: number
  replaced?: boolean
}): PollDecision {
  if (p.sessionVersion === null) return 'none' // no vault in this tab: nothing to follow
  if (p.inFlight > 0) return 'none'
  if (p.serverVersion === p.sessionVersion) return p.replaced ? 'banner' : 'none'
  if (p.serverVersion !== null && p.serverVersion > p.sessionVersion && !p.dirty) return 'refresh'
  return 'banner'
}

/** How often a visible tab asks the server whether the vault moved on. */
export const POLL_MS = 45_000
/** Focus and visibility checks closer together than this are skipped (alt-tabbing back and forth). */
export const POLL_MIN_GAP_MS = 5_000

export type WatcherDeps = {
  /** A session holding a vault: something to follow. */
  active: () => boolean
  /** The tab is in view. */
  visible: () => boolean
  /** One check against the server. Its failures are its own business (a rejection is swallowed). */
  poll: () => Promise<unknown>
  now?: () => number
}

export type Watcher = {
  /** Session state changed: start the rhythm (or let it lapse). */
  onMode: () => void
  /** Focus, or the tab came back into view: check now — unless a check just ran — then every 45s. */
  wake: () => void
  /** The tab was hidden: no checks until it is visible again. */
  sleep: () => void
  /** Check as soon as possible, whatever the gap (e.g. right after a version conflict). */
  kick: () => void
}

export function createWatcher(deps: WatcherDeps, o: { intervalMs?: number; minGapMs?: number } = {}): Watcher {
  const every = o.intervalMs ?? POLL_MS
  const gap = o.minGapMs ?? POLL_MIN_GAP_MS
  const now = deps.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  /** A kick arrived during a check: run once more after it. */
  let again = false
  let last = -Infinity

  const can = () => deps.active() && deps.visible()
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = (ms: number) => {
    disarm()
    timer = setTimeout(() => void run(), ms)
  }

  async function run(): Promise<void> {
    timer = null
    if (!can()) return
    running = true
    last = now()
    try {
      await deps.poll()
    } catch {
      /* the poll reports its own failures; the rhythm goes on */
    } finally {
      running = false
    }
    if (again) {
      again = false
      return run()
    }
    if (can() && !timer) arm(every)
  }

  return {
    onMode() {
      if (!can()) return disarm()
      if (!timer && !running) arm(every)
    },
    wake() {
      if (!can() || running) return
      if (now() - last < gap) {
        if (!timer) arm(every)
        return
      }
      disarm()
      void run()
    },
    sleep: disarm,
    kick() {
      if (!can()) return
      if (running) {
        again = true
        return
      }
      disarm()
      void run()
    },
  }
}

/* ---------- other tabs of the same browser ---------- */

export type PresenceMessage = { t: 'hello'; id: string; active: boolean } | { t: 'here'; id: string } | { t: 'bye'; id: string }

/** The part of a BroadcastChannel presence uses. */
export type PresenceChannel = {
  postMessage: (m: PresenceMessage) => void
  onmessage: ((e: { data: unknown }) => void) | null
}

export type TabPresence = {
  /** Other tabs of this browser that were already in a session when this one arrived, or entered its own. */
  readonly ahead: number
  /** Say this tab is here — at load (`active` false) and on entering a session (true). Tabs already in a session answer. */
  announce: (active: boolean) => void
  /** This tab is going away (pagehide). */
  leave: () => void
}

/**
 * Which tab came second. A tab in a session answers every hello; a tab that
 * hears an answer (or hears another tab enter a session while it hasn't) knows
 * a session was open before it. The first tab isn't told — the second one,
 * where a new session would be the duplicate, is. Messages carry a random
 * tab id and nothing else.
 */
export function createTabPresence(
  ch: PresenceChannel,
  deps: { id: string; active: () => boolean; changed: () => void },
): TabPresence {
  const ahead = new Set<string>()
  const update = (fn: () => void) => {
    const before = ahead.size
    fn()
    if (ahead.size !== before) deps.changed()
  }
  ch.onmessage = (e) => {
    const m = e.data as Partial<PresenceMessage> | null
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id === deps.id) return
    const id = m.id
    if (m.t === 'hello') {
      if (deps.active()) ch.postMessage({ t: 'here', id: deps.id }) // this tab was here first
      else if (m.active === true) update(() => ahead.add(id)) // it entered a session; this one hasn't yet
    } else if (m.t === 'here') update(() => ahead.add(id))
    else if (m.t === 'bye') update(() => ahead.delete(id))
  }
  return {
    get ahead() {
      return ahead.size
    },
    announce: (active) => ch.postMessage({ t: 'hello', id: deps.id, active }),
    leave: () => ch.postMessage({ t: 'bye', id: deps.id }),
  }
}

/* ---------- autosave ---------- */

export type AutosaveStatus =
  | 'idle'
  | 'saving'
  | 'retrying' // offline or a server hiccup: trying again on a backoff, and at once on online/focus
  | 'conflict' // 409: the vault moved on without this tab — sticky
  | 'toolarge' // 413: the vault is over the server's cap — sticky
  | 'error' // anything else the server refused — sticky

export type AutosaveState = {
  status: AutosaveStatus
  error: string | null
  /** The last save that actually uploaded (not a skipped no-op). */
  lastSavedAt: Date | null
  /** Epoch ms of the next automatic retry while `retrying`. */
  retryAt: number | null
}

export const AUTOSAVE_DELAY_MS = 1500
/** Waits before retry 1, 2, 3, 4+ after a transient failure. */
export const RETRY_BACKOFF_MS = [2_000, 5_000, 15_000, 60_000] as const

export type AutosaveDeps = {
  /** A session with a vault and unsaved writes: something to save and somewhere to put it. */
  pending: () => boolean
  /** Run one save (queue.save with auto: true). Failures arrive through `failed`, not as a result. */
  save: () => Promise<unknown>
  /** Saves queued or running, of any kind. */
  inFlight: () => number
  /** The state changed (the tab re-renders the chip). */
  announce: () => void
}

export type Autosave = {
  readonly state: AutosaveState
  /** A write landed ('scarab-write'): restart the debounce. */
  onWrite: () => void
  /** Any state change ('scarab-mode'): make sure a dirty tab has a save coming. */
  onMode: () => void
  /** The tab is being hidden: save now rather than risk the tab being closed. */
  flush: () => void
  /** Online again, or focus: a pending retry runs now. */
  wake: () => void
  /** Queue events, for every save (manual and updater saves too). */
  started: (job: SaveJobInfo) => void
  succeeded: (r: SaveResult, job: SaveJobInfo) => void
  failed: (e: unknown, job: SaveJobInfo) => void
  /** A new session or a fresh unlock: forget failures and timers. */
  reset: () => void
}

export function createAutosave(deps: AutosaveDeps): Autosave {
  const state: AutosaveState = { status: 'idle', error: null, lastSavedAt: null, retryAt: null }
  let timer: ReturnType<typeof setTimeout> | null = null
  /** Consecutive transient failures: picks the next backoff step. */
  let failures = 0
  /** What the running save found, restored if its failure turns out not to be autosave's business. */
  let before: Pick<AutosaveState, 'status' | 'error' | 'retryAt'> = { status: 'idle', error: null, retryAt: null }

  const sticky = () => state.status === 'conflict' || state.status === 'toolarge' || state.status === 'error'
  const set = (status: AutosaveStatus, error: string | null) => {
    state.status = status
    state.error = error
    if (status !== 'retrying') state.retryAt = null
    deps.announce()
  }
  const disarm = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  const arm = (ms: number) => {
    disarm()
    timer = setTimeout(() => void fire(), ms)
  }
  const backoff = () => RETRY_BACKOFF_MS[Math.min(Math.max(failures, 1), RETRY_BACKOFF_MS.length) - 1]!

  async function fire() {
    timer = null
    if (sticky()) return
    if (!deps.pending()) {
      if (state.status === 'retrying') set('idle', null) // nothing left to retry (a refused header change on a clean tab)
      return
    }
    // One at a time: whatever is uploading now finishes first; look again after.
    if (deps.inFlight() > 0) return arm(AUTOSAVE_DELAY_MS)
    await deps.save().catch(() => undefined) // reported through `failed`
  }

  const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

  return {
    state,
    onWrite() {
      if (sticky()) return
      if (state.status === 'retrying') {
        if (!timer) arm(backoff()) // offline: a write doesn't hurry the backoff, but it never goes unscheduled
        return
      }
      arm(AUTOSAVE_DELAY_MS)
    },
    onMode() {
      if (sticky() || state.status === 'retrying' || timer) return
      if (deps.pending()) arm(AUTOSAVE_DELAY_MS)
    },
    flush() {
      if (sticky() || !deps.pending() || deps.inFlight() > 0) return
      disarm()
      void fire()
    },
    wake() {
      if (state.status !== 'retrying') return
      disarm()
      void fire()
    },
    started(job) {
      if (job.seed) return // creating a vault: there is no session for autosave to describe yet
      before = { status: state.status, error: state.error, retryAt: state.retryAt }
      set('saving', state.error)
    },
    succeeded(r) {
      if (!r.skipped) state.lastSavedAt = new Date()
      failures = 0
      disarm()
      set('idle', null)
      // Writes that arrived during the upload left the tab dirty: go again.
      if (deps.pending()) arm(AUTOSAVE_DELAY_MS)
    },
    failed(e, job) {
      if (job.seed) return // a failed create leaves no session; its caller reports it
      if (!(e instanceof NetError) && !job.auto) {
        set(before.status, before.error) // a refused update ("cannot remove the only passkey"): its caller reports it
        state.retryAt = before.retryAt
        return
      }
      const kind = failureKind(e)
      if (kind === 'transient') {
        failures++
        const wait = backoff()
        set('retrying', message(e))
        state.retryAt = Date.now() + wait
        arm(wait)
        return
      }
      disarm()
      set(kind === 'conflict' ? 'conflict' : kind === 'toolarge' ? 'toolarge' : 'error', message(e))
    },
    reset() {
      disarm()
      failures = 0
      state.lastSavedAt = null
      set('idle', null)
    },
  }
}

/* ---------- idle auto-lock ---------- */

/** The per-device choices, in minutes of no input; null is never. */
export const IDLE_LOCK_CHOICES = [15, 60, 240, null] as const
export type IdleMinutes = (typeof IDLE_LOCK_CHOICES)[number]
/** How often a session checks whether it has been idle long enough (a hidden tab's timers fire about once a minute anyway). */
export const IDLE_CHECK_MS = 30_000
/** After a lock was held back (the save before it failed), how long before it tries again while still idle. */
export const IDLE_RETRY_MS = 60_000

export const isIdleMinutes = (v: unknown): v is IdleMinutes => (IDLE_LOCK_CHOICES as readonly unknown[]).includes(v)

export type IdleLockDeps = {
  /** A session with a vault is open, so locking means something. */
  active: () => boolean
  /** The setting, read on every check. */
  minutes: () => IdleMinutes
  /** Save anything unsaved, then end the session. Throws — and locks nothing — when that save fails. */
  lock: (minutes: number) => Promise<void>
  /** The lock was held back because the save before it failed: the person must hear why (a banner). */
  blocked: (e: unknown, minutes: number) => void
  now?: () => number
}

export type IdleCheck = 'off' | 'idle' | 'locked' | 'blocked'

export type IdleLock = {
  /** The person did something (a key, the pointer, a scroll): the idle clock starts over. */
  activity(): void
  /** Lock if the session has been idle for the setting's minutes. One lock attempt at a time. */
  check(): Promise<IdleCheck>
  /** A session just began (an unlock, a new vault): the idle clock starts now, and nothing held back carries over. */
  reset(): void
}

/**
 * Idle auto-lock: after the chosen minutes without input, save and end the
 * session (the next visit takes a passkey or the recovery code). It never
 * locks over unsaved work — the save comes first, and if it fails nothing is
 * locked: `blocked` says why, and it tries again a minute later if still
 * idle. A session that has just started counts from its start, not from
 * whenever the tab last saw input.
 */
export function createIdleLock(deps: IdleLockDeps): IdleLock {
  const now = deps.now ?? (() => Date.now()) // read the clock each time (a replaced Date — tests, a clock change — is seen)
  let last = now()
  let wasActive = false
  let retryAt = 0
  let running: Promise<IdleCheck> | null = null

  return {
    activity() {
      last = now()
    },
    reset() {
      last = now()
      retryAt = 0
    },
    check() {
      if (running) return running
      if (!deps.active()) {
        wasActive = false
        return Promise.resolve('off')
      }
      if (!wasActive) {
        wasActive = true
        last = now() // the session just began: the clock starts here
        retryAt = 0
      }
      const m = deps.minutes()
      if (m === null) return Promise.resolve('off')
      const t = now()
      if (t - last < m * 60_000 || t < retryAt) return Promise.resolve('idle')
      running = (async (): Promise<IdleCheck> => {
        try {
          await deps.lock(m)
          return 'locked'
        } catch (e) {
          retryAt = now() + IDLE_RETRY_MS
          deps.blocked(e, m)
          return 'blocked'
        } finally {
          running = null
        }
      })()
      return running
    },
  }
}
