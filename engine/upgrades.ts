import type { DbLike } from './db'
import { migrations } from './migrations'
import type { Dump } from './snapshot'

/**
 * Reading a snapshot that an older engine wrote.
 *
 * The vault snapshot IS the database in a zero-knowledge deployment — there is
 * no server-side copy to fall back on — so "this engine can't read your
 * snapshot" means your data is unreachable until the engine can. That makes it
 * worth separating the two things `migrations.length` used to conflate: how
 * many commits have touched the schema, and whether a reader can still
 * understand older data.
 *
 * Every change to the app falls in one of three tiers:
 *
 *   A — UX only. No schema, nothing stored. Nothing here to do.
 *   B — additive schema: a new table, or a column with a DEFAULT. An older
 *       snapshot loads as-is; `loadDump` inserts only the columns the dump
 *       carries and SQLite fills the rest in. Nothing here to do either.
 *   C — the data itself changes shape: a column is renamed, dropped, or moves
 *       tables; rows get rewritten or rolled up; a new column's correct value
 *       cannot be defaulted. THIS is the tier that costs compatibility, and
 *       the only one that needs an entry below.
 *
 * A tier-C entry is keyed by the migration it belongs to and has up to two
 * halves, because there are two moments a loaded snapshot can be touched:
 *
 *   before — reshape the DUMP, as JSON, ahead of the insert. For anything the
 *            current schema would refuse to insert: a renamed or dropped
 *            column, a table that split. Written against the dump shape of
 *            the version just before it, so entries chain (v15 → 16 → 17 …)
 *            and, like a migration, never need editing once shipped.
 *   after  — repair ROWS once they sit in the current schema. For the
 *            one-time UPDATE half of a migration that `migrate()` already ran,
 *            against an empty database, before the snapshot arrived. Written
 *            against the CURRENT schema, so unlike `before` it is living code:
 *            a later migration that touches the same tables may need it
 *            edited. `engine/snapshot-compat.test.ts` is what notices.
 *
 * `loadDump` runs every `before` newer than the dump in ascending order, then
 * inserts, then every `after` in ascending order — all of the row work inside
 * one transaction.
 *
 * Rules for both halves:
 *   - Idempotent. They may run against data that already satisfies them.
 *   - `after` never calls `db.transaction()`: it already runs inside one, and
 *     the sql.js seam issues a bare BEGIN that SQLite refuses to nest.
 *   - Plain SQL over the DbLike seam, like the rest of engine/.
 *
 * What an entry looks like, for the day one is needed (this one was migration
 * 16, which made employee stock plans opt-in and grandfathered accounts that
 * already carried unvested shares):
 *
 *   16: {
 *     after: (db) => {
 *       db.prepare(`UPDATE invest_accounts SET stock_plan = 1 WHERE id IN (
 *         SELECT invest_account_id FROM unvested_positions
 *         UNION SELECT invest_account_id FROM pay_sources WHERE invest_account_id IS NOT NULL)`).run()
 *     },
 *   },
 *
 * ---
 *
 * NOT IN PRODUCTION YET. Until Scarab is, there are no vaults worth carrying
 * forward, so the registry stays empty and the floor sits at the current
 * version: an older snapshot is refused rather than upgraded, and the machinery
 * is proven by `engine/snapshot-compat.test.ts` against synthetic entries. The
 * day we call it production: freeze a fixture of that version (see
 * engine/fixtures/README.md), lower `minReadable` to it, and start adding
 * entries for every tier-C migration from then on.
 */
export type Upgrade = {
  before?: (dump: Dump) => Dump
  after?: (db: DbLike) => void
}

/**
 * The compatibility contract: the oldest snapshot version this engine reads,
 * and the upgrades that carry anything from there to the current version.
 * `minReadable` must equal the oldest fixture checked in under
 * engine/fixtures/ (the test enforces it) — lowering it is a promise, and the
 * fixture is the proof. Raise it only to drop support on purpose.
 */
export type Compat = { minReadable: number; upgrades: Record<number, Upgrade> }

/** The engine's own version — what `dumpDb` stamps on everything it writes. */
export const CURRENT_VERSION = migrations.length

/** The shipped contract. Empty until production; see the note above. */
export const SNAPSHOT_COMPAT: Compat = { minReadable: CURRENT_VERSION, upgrades: {} }

export const MIN_READABLE_VERSION = SNAPSHOT_COMPAT.minReadable

/** Upgrades to apply to a snapshot written at `fromVersion`, oldest first. */
export function upgradesFor(fromVersion: number, compat: Compat = SNAPSHOT_COMPAT): { version: number; upgrade: Upgrade }[] {
  return Object.keys(compat.upgrades)
    .map(Number)
    .filter((v) => v > fromVersion && v <= CURRENT_VERSION)
    .sort((a, b) => a - b)
    .map((v) => ({ version: v, upgrade: compat.upgrades[v]! }))
}

/**
 * Why a snapshot can't be read, or null if it can. Older-but-supported is
 * fine; older-than-supported and newer-than-this-engine are not.
 */
export function readabilityError(schemaVersion: number, compat: Compat = SNAPSHOT_COMPAT): string | null {
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) return 'export has no usable schema version'
  if (schemaVersion > CURRENT_VERSION)
    return `export is v${schemaVersion}, newer than this engine (v${CURRENT_VERSION}) — update Scarab first`
  if (schemaVersion < compat.minReadable)
    return `export is v${schemaVersion}; this engine reads v${compat.minReadable} and newer`
  return null
}
