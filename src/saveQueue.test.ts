import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import { dumpDb, loadDump, type Dump } from '../engine/snapshot'
import { seedHousehold } from '../engine/test/household'
import { onBothEngines } from '../engine/test/parity'
import { openDb } from '../server/migrations'
import type { PasskeyWrap, VaultBlob, VaultHeader } from '../shared/vault'
import type { VaultSession } from './local'
import {
  AUTOSAVE_DELAY_MS,
  createAutosave,
  createIdleLock,
  createSaveQueue,
  createTabPresence,
  createWatcher,
  decideOnPoll,
  encodeDump,
  failureKind,
  IDLE_RETRY_MS,
  isIdleMinutes,
  NetError,
  POLL_MIN_GAP_MS,
  POLL_MS,
  RETRY_BACKOFF_MS,
  type Autosave,
  type HistoryPin,
  type IdleMinutes,
  type PresenceChannel,
  type SaveQueue,
} from './saveQueue'

/* ---------- fakes: a tab, a courier, and a "cipher" that shows what it sealed ---------- */

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex')

/** Keys are 32-byte arrays; tests tell them apart by their first byte. */
const key = (n: number) => new Uint8Array(32).fill(n)
const wrap = (id: string): PasskeyWrap => ({ credentialId: id, label: id, addedAt: '2026-09-23T00:00:00Z', wrappedKey: { iv: '', ct: '' } })
const header = (...ids: string[]): VaultHeader => ({ v: 3, vaultId: 'AAAAAAAAAAAAAAAAAAAAAA', rpId: 'localhost', prfSalt: 'salt', enc: 'gzip+pad', keys: ids.map(wrap) })

/** What the fake cipher writes: which key sealed it, the header it carried, the version it was sealed for, and the plaintext rows. */
type Opened = { key: number; keys: string[]; seq: number | null; rows: unknown[] }
const open = (data: string): Opened => {
  const blob = JSON.parse(data) as VaultBlob
  const [k] = blob.payload.iv.split(':')
  const dump = JSON.parse(blob.payload.ct) as Dump
  return { key: Number(k), keys: blob.keys.map((w) => w.credentialId), seq: blob.v === 3 ? blob.seq : null, rows: dump.tables.t! }
}

/** The fake tab keeps plain values as its "rows". */
const tables = (rows: unknown[]) => ({ t: rows }) as unknown as Dump['tables']

type Gate = { wait: Promise<void>; release: () => void }
const gate = (): Gate => {
  let release = () => {}
  const wait = new Promise<void>((r) => (release = r))
  return { wait, release }
}

function world() {
  const tab = {
    vault: null as VaultSession | null,
    writes: 0,
    dirty: false,
    rows: [] as unknown[],
    /** Runs inside dump(), before the rows are read. */
    duringDump: null as (() => Promise<void> | void) | null,
    /** Runs right after a dump has read the rows (n = how many dumps so far, from 1). */
    afterDump: null as ((n: number) => void) | null,
    dumps: 0,
    /** What each commit said the courier now holds. */
    commits: [] as { version: number; seq: number; sha256: string; size: number }[],
    /** The pin the stored version an upload replaces should carry (session.ts: pre-upgrade, pre-restore). */
    pinFor: null as ((base: VaultSession) => HistoryPin | undefined) | null,
  }
  const server = {
    version: 0,
    data: null as string | null,
    sha: null as string | null,
    offline: false,
    /** The next PUT is applied, then its response is lost. */
    loseNext: false,
    /** Answer the next PUT with this status (413, 500 …) without storing it. */
    failNext: null as number | null,
    /** Held PUTs wait here. */
    hold: null as Gate | null,
    attempts: 0,
    concurrent: 0,
    maxConcurrent: 0,
    puts: [] as { version: number; opened: Opened; sha: string }[],
    /** The baseSha256 each PUT attempt named (null: none). */
    bases: [] as (string | null)[],
    /** Whether each PUT attempt asked for history to be purged. */
    purges: [] as boolean[],
    /** The pin each PUT attempt sent (null: none). */
    pins: [] as (string | null)[],
  }
  let nonce = 0

  const write = (row: unknown = tab.writes + 1, change = true) => {
    tab.writes++
    tab.dirty = true
    if (change) tab.rows.push(row)
  }
  /** Someone else saved: the server moves on without this tab. */
  const otherDeviceSaves = () => {
    server.version++
    server.data = `{"by":"other","n":${server.version}}`
    server.sha = sha(server.data)
  }
  /** The vault was deleted and created again (or restored) and has reached this version again: same number, another blob. */
  const replacedAtSameVersion = () => {
    server.data = `{"by":"replacement","n":${server.version}}`
    server.sha = sha(server.data)
  }

  const queue: SaveQueue & { events: string[] } = Object.assign(
    createSaveQueue(
      {
        session: () => tab.vault,
        writes: () => tab.writes,
        async dump() {
          await tab.duringDump?.()
          const d: Dump = { scarab: true, schemaVersion: 20, exportedAt: `t${nonce++}`, tables: tables([...tab.rows]) }
          tab.afterDump?.(++tab.dumps)
          return d
        },
        async seal(s, plaintext, seq) {
          await Promise.resolve()
          return {
            ...s.header,
            seq,
            payload: { iv: `${s.rawDataKey[0]}:${nonce++}`, ct: new TextDecoder().decode(plaintext) },
          }
        },
        pin: (base) => tab.pinFor?.(base),
        async put({ data, version, baseSha256, purgeHistory, pin }) {
          server.attempts++
          server.bases.push(baseSha256 ?? null)
          server.purges.push(purgeHistory === true)
          server.pins.push(pin ?? null)
          server.concurrent++
          server.maxConcurrent = Math.max(server.maxConcurrent, server.concurrent)
          try {
            if (server.hold) await server.hold.wait
            await Promise.resolve()
            if (server.offline) throw new NetError('Failed to fetch', null)
            if (server.failNext !== null) {
              const status = server.failNext
              server.failNext = null
              throw new NetError(`HTTP ${status}`, status)
            }
            // As the courier does: a stale version, or a blob other than the one the upload says it replaces.
            if (version !== server.version || (baseSha256 !== undefined && server.data !== null && baseSha256 !== server.sha))
              throw new NetError(`version conflict: server has ${server.version}, you sent ${version}`, 409, {
                serverVersion: server.version,
                serverSha256: server.sha,
              })
            server.version = version + 1
            server.data = data
            server.sha = sha(data)
            server.puts.push({ version: server.version, opened: open(data), sha: server.sha })
            if (server.loseNext) {
              server.loseNext = false
              throw new NetError('network connection was lost', null)
            }
            return { version: server.version, sha256: server.sha }
          } finally {
            server.concurrent--
          }
        },
        sha256: async (text) => sha(text),
        commit(s, writesAtDump, stored) {
          tab.vault = s
          tab.dirty = writesAtDump !== tab.writes
          tab.commits.push({ version: s.version, ...stored })
        },
        markSaved(version, writesAtDump) {
          if (tab.vault) tab.vault.version = version
          tab.dirty = writesAtDump !== tab.writes
        },
      },
      {
        start: (j) => {
          queue.events.push(j.auto ? 'start:auto' : 'start')
          auto?.started(j)
        },
        success: (r, j) => auto?.succeeded(r, j),
        failure: (e, j) => auto?.failed(e, j),
      },
    ),
    { events: [] as string[] },
  )

  let auto: Autosave | null = null
  const withAutosave = () => {
    auto = createAutosave({
      pending: () => tab.vault !== null && tab.dirty,
      save: () => queue.save(undefined, { auto: true }),
      inFlight: () => queue.inFlight(),
      announce: () => {},
    })
    return auto
  }

  /** A session unlocked at the server's current version, clean, with the server's rows. */
  const unlocked = (s: Omit<VaultSession, 'version'>, version = 1) => {
    server.version = version
    server.data = `{"seed":${version}}`
    server.sha = sha(server.data)
    tab.vault = { ...s, version }
    tab.dirty = false
  }

  return { tab, server, queue, write, otherDeviceSaves, replacedAtSameVersion, unlocked, withAutosave }
}

/* ---------- the queue ---------- */

describe('save queue', () => {
  it('seals the header as it is when the save runs: an autosave behind "add passkey" keeps the new wrapping', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')

    // "Add passkey" is uploading; an autosave is requested meanwhile (the old
    // pipeline captured the header at this moment, without the new wrapping).
    w.server.hold = gate()
    const add = w.queue.save((s) => ({ ...s, header: { ...s.header, keys: [...s.header.keys.filter((k) => k.credentialId !== 'phone'), wrap('phone')] } }))
    const held = w.server.hold
    await vi.waitFor(() => expect(w.server.attempts).toBe(1))
    w.write('b')
    const autosave = w.queue.save(undefined, { auto: true })
    w.server.hold = null
    held.release()
    await Promise.all([add, autosave])

    expect(w.server.puts.map((p) => p.opened.keys)).toEqual([
      ['mac', 'phone'],
      ['mac', 'phone'],
    ])
    expect(w.server.puts[1]!.opened.rows).toEqual(['a', 'b'])
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac', 'phone'])
    expect(w.tab.vault!.version).toBe(3)
    expect(w.tab.dirty).toBe(false)
  })

  it('a header change queued behind an in-flight autosave applies to what that autosave stored', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac', 'phone') })
    w.write('a')
    const dumpGate = gate()
    w.tab.duringDump = () => dumpGate.wait
    const autosave = w.queue.save(undefined, { auto: true })
    const remove = w.queue.save((s) => {
      if (!s.header.keys.some((k) => k.credentialId === 'phone')) throw new Error('that passkey is not on the vault')
      return { ...s, header: { ...s.header, keys: s.header.keys.filter((k) => k.credentialId !== 'phone') } }
    })
    await Promise.resolve()
    w.tab.duringDump = null
    dumpGate.release()
    await Promise.all([autosave, remove])
    expect(w.server.puts.map((p) => [p.version, p.opened.keys])).toEqual([
      [2, ['mac', 'phone']],
      [3, ['mac']],
    ])
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac'])
  })

  it('never reverts a rotation: a save queued behind it seals under the new key', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac', 'phone') })
    w.write('a')
    w.tab.afterDump = (n) => {
      if (n === 2) w.write('b') // lands while the rotation uploads
    }
    const before = w.queue.save(undefined, { auto: true }) // requested first, runs first, old key
    const rotate = w.queue.save((s) => ({ ...s, rawDataKey: key(2), header: header('mac') }))
    const after = w.queue.save(undefined, { auto: true })
    await Promise.all([before, rotate, after])

    expect(w.server.puts.map((p) => [p.opened.key, p.opened.keys])).toEqual([
      [1, ['mac', 'phone']],
      [2, ['mac']],
      [2, ['mac']],
    ])
    expect(w.tab.vault!.rawDataKey[0]).toBe(2)
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac'])
    expect(open(w.server.data!).rows).toEqual(['a', 'b'])
  })

  it('a rotation whose upload fails leaves the old key in place', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac', 'phone') })
    w.server.failNext = 500
    await expect(w.queue.save((s) => ({ ...s, rawDataKey: key(2), header: header('mac') }))).rejects.toThrow(/500/)
    expect(w.tab.vault!.rawDataKey[0]).toBe(1)
    expect(w.tab.vault!.header.keys).toHaveLength(2)
  })

  it('a write that lands during the dump keeps the tab dirty', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.tab.duringDump = () => {
      w.tab.duringDump = null
      w.write('b') // lands while the snapshot is being taken
    }
    const r = await w.queue.save()
    expect(r).toMatchObject({ version: 2, skipped: false })
    expect(w.tab.dirty).toBe(true) // counted after the dump began: not claimed by this save

    // It did make it into that payload, so the next save has nothing new to upload.
    const again = await w.queue.save()
    expect(again).toMatchObject({ version: 2, skipped: true })
    expect(w.tab.dirty).toBe(false)
    expect(w.server.puts).toHaveLength(1)
  })

  it('a write that lands during the upload keeps the tab dirty and goes up with the next save', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.hold = gate()
    const held = w.server.hold
    const first = w.queue.save()
    await vi.waitFor(() => expect(w.server.attempts).toBe(1))
    w.write('b')
    w.server.hold = null
    held.release()
    await first
    expect(w.tab.dirty).toBe(true)
    await w.queue.save()
    expect(w.server.puts.map((p) => p.opened.rows)).toEqual([['a'], ['a', 'b']])
    expect(w.tab.dirty).toBe(false)
  })

  it('uploads nothing when the tables are unchanged (a Goal blur that rewrote the same value)', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    expect(await w.queue.save()).toMatchObject({ version: 2, skipped: false })

    w.write('a', false) // an UPDATE that set the same value: the tab dirties, the data doesn't change
    expect(w.tab.dirty).toBe(true)
    const r = await w.queue.save()
    expect(r).toMatchObject({ version: 2, skipped: true })
    expect(r.sha256).toBe(w.server.sha)
    expect(w.tab.dirty).toBe(false)
    expect(w.server.attempts).toBe(1)

    // …unless forced, or the header changes, or the vault moved to another version.
    expect(await w.queue.save(undefined, { force: true })).toMatchObject({ version: 3, skipped: false })
    expect(await w.queue.save((s) => ({ ...s, header: { ...s.header, keys: [...s.header.keys] } }))).toMatchObject({ version: 4 })
    w.tab.vault!.version = 4 // same, via markSaved: still sealed
    expect(await w.queue.save()).toMatchObject({ skipped: true })
    w.otherDeviceSaves()
    w.tab.vault = { ...w.tab.vault!, version: 5 } // a refresh adopted their version: we never sealed it
    expect(await w.queue.save()).toMatchObject({ version: 6, skipped: false })
  })

  it('an unlock records what the vault holds, so browsing then saving uploads nothing', async () => {
    const w = world()
    w.tab.rows = ['x', 'y']
    const s: VaultSession = { rawDataKey: key(1), header: header('mac'), version: 7 }
    w.unlocked(s, 7)
    const loaded: Dump = { scarab: true, schemaVersion: 20, exportedAt: 'whenever', tables: tables(['x', 'y']) }
    await w.queue.loaded(w.tab.vault!, loaded, { sha256: w.server.sha!, bytes: 123 })
    w.write('y', false)
    expect(await w.queue.save()).toEqual({ version: 7, sha256: w.server.sha, bytes: 123, skipped: true })
    expect(w.server.attempts).toBe(0)

    // A different schema version is different data, even with identical rows.
    await w.queue.loaded(w.tab.vault!, { ...loaded, schemaVersion: 19 }, { sha256: w.server.sha!, bytes: 123 })
    expect(await w.queue.save()).toMatchObject({ version: 8, skipped: false })
  })

  it('the unlock baseline holds on both real engines: a loaded snapshot dumps back to identical tables', async () => {
    // session.ts records the decrypted dump as "sealed" on unlock; the no-op
    // check then compares it with a fresh dumpDb of the tab. That only works if
    // load → dump reproduces the tables exactly.
    const raw = openDb(':memory:')
    const src = raw as unknown as DbLike
    seedHousehold(src)
    const stored = dumpDb(src)
    raw.close()
    const keyOf = (d: Dump) => new TextDecoder().decode(encodeDump(d).key)
    const { server, browser } = await onBothEngines(
      () => {},
      (db) => {
        loadDump(db, stored)
        return keyOf(dumpDb(db))
      },
    )
    expect(keyOf(stored).length).toBeGreaterThan(2000) // not vacuous: a whole household
    expect(server).toBe(keyOf(stored))
    expect(browser).toBe(keyOf(stored))
  })

  it('turns each dump into JSON once: the no-op check hashes part of the very plaintext that gets sealed', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    let serialized = 0
    w.write({ toJSON: () => (serialized++, 'a') }) // a row that counts how often a dump is serialized
    expect(await w.queue.save()).toMatchObject({ version: 2, skipped: false })
    expect(serialized).toBe(1) // (twice before: once for the no-op check, again for the plaintext)
    expect(w.server.puts[0]!.opened.rows).toEqual(['a'])
    w.write('same', false)
    expect(await w.queue.save()).toMatchObject({ version: 2, skipped: true })
    expect(serialized).toBe(2)
  })

  it('the no-op key: the schema version and the tables, nothing else the dump carries — equal exactly when they were before', () => {
    const d: Dump = { scarab: true, schemaVersion: 21, exportedAt: '2026-09-23T10:00:00.000Z', tables: tables(['Café', { n: 1 }]) }
    const { plaintext, key: k } = encodeDump(d)
    const text = new TextDecoder().decode(plaintext)
    expect(JSON.parse(text)).toEqual(d) // what gets sealed is the dump
    expect(k.buffer).toBe(plaintext.buffer) // a view into it, not a copy
    expect(text.endsWith(new TextDecoder().decode(k))).toBe(true)
    expect(new TextDecoder().decode(k)).toBe('"schemaVersion":21,"tables":{"t":["Café",{"n":1}]}}')

    // Against what the check compared before (JSON of [schemaVersion, tables]): the same pairs match, the same differ.
    const before = (x: Dump) => JSON.stringify([x.schemaVersion, x.tables])
    const variants: Dump[] = [
      d,
      { ...d, exportedAt: 'später — non-ASCII shifts the byte offset' },
      { ...d, schemaVersion: 20 },
      { ...d, tables: tables(['Cafe', { n: 1 }]) },
      { ...d, tables: tables(['Café', { n: 2 }]) },
      { ...d, tables: tables(['Café', { n: 1 }, null]) },
      Object.assign({ extra: 'ignored, as before' }, d),
    ]
    for (const a of variants) for (const b of variants) expect(sha(encodeDump(a).key) === sha(encodeDump(b).key)).toBe(before(a) === before(b))
  })

  it('adopts an upload whose response was lost instead of reporting a conflict with itself', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.loseNext = true
    const lost = await w.queue.save().catch((e: unknown) => e)
    expect(failureKind(lost)).toBe('transient')
    expect(w.server.version).toBe(2) // it landed
    expect(w.tab.vault!.version).toBe(1) // the tab never heard
    expect(w.tab.dirty).toBe(true)

    // The retry meets a 409 carrying our own sha: adopt v2; nothing new to send.
    const r = await w.queue.save()
    expect(r).toMatchObject({ version: 2, skipped: true })
    expect(w.tab.vault!.version).toBe(2)
    expect(w.tab.dirty).toBe(false)
    expect(w.server.attempts).toBe(2)
  })

  it('after adopting a lost upload, writes made since it go up on top of it', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.loseNext = true
    await w.queue.save().catch(() => undefined)
    w.server.offline = true
    await w.queue.save().catch(() => undefined) // a retry that never reached the server
    w.server.offline = false
    w.write('b')
    const r = await w.queue.save()
    expect(r).toMatchObject({ version: 3, skipped: false })
    expect(w.server.puts.map((p) => [p.version, p.opened.rows])).toEqual([
      [2, ['a']],
      [3, ['a', 'b']],
    ])
    expect(w.tab.dirty).toBe(false)
  })

  it('a lost "add passkey" upload is adopted with its wrapping', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.server.loseNext = true
    await expect(w.queue.save((s) => ({ ...s, header: header('mac', 'phone') }))).rejects.toThrow(/lost/)
    expect(w.tab.vault!.header.keys).toHaveLength(1)
    w.write('a')
    await w.queue.save()
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac', 'phone'])
    expect(w.server.puts.map((p) => p.opened.keys)).toEqual([
      ['mac', 'phone'],
      ['mac', 'phone'],
    ])
  })

  it('a real conflict (another device saved) is not adopted and changes nothing', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.loseNext = true
    await w.queue.save().catch(() => undefined) // ours landed as v2 …
    w.otherDeviceSaves() // … and theirs as v3 on top of it
    const e = await w.queue.save().catch((x: unknown) => x)
    expect(failureKind(e)).toBe('conflict')
    expect(w.tab.vault!.version).toBe(1)
    expect(w.tab.dirty).toBe(true)
  })

  it('settle: a lost re-key is adopted as soon as the courier shows it — no later save, no conflict needed', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac', 'phone') })
    const probe = vi.fn(async () => ({ version: w.server.version, sha256: w.server.sha! }))
    expect(await w.queue.settle(probe)).toBeNull() // nothing outstanding: the courier isn't even asked
    expect(probe).not.toHaveBeenCalled()

    w.server.loseNext = true
    await expect(w.queue.save((s) => ({ ...s, rawDataKey: key(2), header: header('mac') }))).rejects.toThrow(/lost/)
    expect(w.tab.vault!.rawDataKey[0]).toBe(1) // the tab never heard
    const r = await w.queue.settle(probe)
    expect(r).toEqual({ version: 2, sha256: w.server.sha, bytes: expect.any(Number), skipped: false })
    expect(w.tab.vault).toMatchObject({ version: 2 })
    expect(w.tab.vault!.rawDataKey[0]).toBe(2)
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac'])
    expect(w.tab.commits.at(-1)).toMatchObject({ version: 2, seq: 2, sha256: w.server.sha })
    expect(w.queue.storedAs()).toEqual({ version: 2, sha256: w.server.sha })
    // Settled: the next save goes on top of it under the new key, with nothing to adopt.
    w.write('a')
    expect(await w.queue.save()).toMatchObject({ version: 3, skipped: false })
    expect(w.server.puts.map((p) => [p.version, p.opened.key])).toEqual([
      [2, 2],
      [3, 2],
    ])
  })

  it('settle: an upload that never arrived is not adopted, and stays outstanding (it may still land)', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.offline = true
    await expect(w.queue.save()).rejects.toThrow(/Failed to fetch/)
    w.server.offline = false
    expect(await w.queue.settle(async () => ({ version: w.server.version, sha256: w.server.sha! }))).toBeNull()
    expect(await w.queue.settle(async () => null)).toBeNull() // no vault stored at all
    expect(w.tab.vault!.version).toBe(1)
    expect(w.tab.dirty).toBe(true)
    // A probe that fails is the caller's to handle; the queue carries on.
    await expect(w.queue.settle(async () => Promise.reject(new NetError('Failed to fetch', null)))).rejects.toThrow(/Failed to fetch/)
    expect(await w.queue.save()).toMatchObject({ version: 2, skipped: false })
  })

  it('settle: a lost create is adopted, so the tab holds the vault it stored', async () => {
    const w = world()
    const seed: VaultSession = { rawDataKey: key(9), header: header('mac'), version: 0 }
    w.write('a')
    w.server.loseNext = true
    await expect(w.queue.save(undefined, { seed })).rejects.toThrow(/lost/)
    expect(w.tab.vault).toBeNull()
    expect(await w.queue.settle(async () => ({ version: w.server.version, sha256: w.server.sha! }))).toMatchObject({ version: 1, skipped: false })
    expect(w.tab.vault).toMatchObject({ version: 1, rawDataKey: seed.rawDataKey })
    expect(w.tab.dirty).toBe(false)
  })

  it('create seeds the session at version 0 and keeps it only if the server accepted it', async () => {
    const w = world()
    w.otherDeviceSaves() // a vault already exists
    const seed: VaultSession = { rawDataKey: key(9), header: header('mac'), version: 0 }
    w.write('a')
    const e = await w.queue.save(undefined, { seed }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(NetError)
    expect((e as NetError).status).toBe(409)
    expect(w.tab.vault).toBeNull()
    expect(w.server.data).toContain('other') // untouched

    w.server.version = 0
    w.server.data = w.server.sha = null
    expect(await w.queue.save(undefined, { seed })).toMatchObject({ version: 1, skipped: false })
    expect(w.tab.vault).toMatchObject({ version: 1, header: seed.header })
    expect(w.tab.vault!.rawDataKey).toBe(seed.rawDataKey)
    await expect(w.queue.save(undefined, { seed })).rejects.toThrow(/already has a vault/)
  })

  it('every upload is sealed for the version it will be stored as, and commits say what the courier holds', async () => {
    const w = world()
    const seed: VaultSession = { rawDataKey: key(1), header: header('mac'), version: 0 }
    w.write('a')
    await w.queue.save(undefined, { seed }) // create: sealed as 1
    w.write('b')
    await w.queue.save() // 2
    await w.queue.save((s) => ({ ...s, header: header('mac', 'phone') })) // an updater: 3
    await w.queue.save((s) => ({ ...s, rawDataKey: key(2), header: header('mac') })) // a rotation: 4
    // A lost upload (sealed as 5), then a write and a retry: the retry is sealed as 5 too, meets the
    // 409, adopts the lost 5, and goes again sealed as 6.
    w.write('c')
    w.server.loseNext = true
    await w.queue.save().catch(() => undefined)
    w.write('d')
    await w.queue.save()
    expect(w.server.puts.map((p) => [p.version, p.opened.seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ])
    // Every commit names the seq sealed and the sha of the data as the tab computed it — the same the server took.
    expect(w.tab.commits.map((c) => [c.version, c.seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ])
    // (the adopted 5 included: its sha is the lost upload's, not the refused retry's)
    expect(w.tab.commits.map((c) => c.sha256)).toEqual(w.server.puts.map((p) => p.sha))
  })

  it('a refused update uploads nothing; no session means no save', async () => {
    const w = world()
    await expect(w.queue.save()).rejects.toThrow(/no vault/)
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    await expect(
      w.queue.save(() => {
        throw new Error('cannot remove the only passkey on the vault')
      }),
    ).rejects.toThrow(/only passkey/)
    expect(w.server.attempts).toBe(0)
    expect(w.queue.inFlight()).toBe(0)
  })

  it('classifies failures: 409 and 413 sticky, offline and 5xx transient', () => {
    expect(failureKind(new NetError('x', 409))).toBe('conflict')
    expect(failureKind(new NetError('x', 413))).toBe('toolarge')
    expect(failureKind(new NetError('x', null))).toBe('transient')
    expect(failureKind(new NetError('x', 502))).toBe('transient')
    expect(failureKind(new NetError('x', 429))).toBe('transient')
    expect(failureKind(new NetError('x', 400))).toBe('fatal')
    expect(failureKind(new NetError('x', 403))).toBe('fatal')
    expect(failureKind(new Error('x'))).toBe('fatal')
  })
})

/* ---------- autosave ---------- */

describe('naming the blob an upload replaces (baseSha256)', () => {
  const dumpOf = (rows: unknown[]): Dump => ({ scarab: true, schemaVersion: 20, exportedAt: 'x', tables: tables(rows) })

  it('once the tab knows what the courier holds, every upload names it; a create names nothing', async () => {
    const w = world()
    const created = await w.queue.save(undefined, { seed: { rawDataKey: key(1), header: header('mac'), version: 0 } })
    expect(w.server.bases).toEqual([null]) // version 0: nothing to replace
    expect(w.queue.storedAs()).toEqual({ version: 1, sha256: created.sha256 })
    w.write('a')
    await w.queue.save()
    w.write('b')
    await w.queue.save((s) => ({ ...s, header: header('mac', 'phone') }))
    expect(w.server.bases).toEqual([null, created.sha256, w.server.puts[1]!.sha]) // each names the one before it
    expect(w.queue.storedAs()).toEqual({ version: 3, sha256: w.server.sha })
  })

  it('an unlock records it (with or without the no-op baseline); a tab that never learned it names nothing', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') }, 4)
    w.write('a')
    await w.queue.save()
    expect(w.server.bases).toEqual([null]) // nothing recorded: unknown, so no check (as before)

    const v = world()
    v.unlocked({ rawDataKey: key(1), header: header('mac') }, 4)
    await v.queue.known(4, v.server.sha!) // a v2 or upgraded unlock: no baseline, but the courier's blob is known
    expect(v.queue.storedAs()).toEqual({ version: 4, sha256: v.server.sha })
    v.write('a')
    const before = v.server.sha
    await v.queue.save()
    expect(v.server.bases).toEqual([before])

    const u = world()
    u.unlocked({ rawDataKey: key(1), header: header('mac') }, 4)
    await u.queue.loaded(u.tab.vault!, dumpOf([]), { sha256: u.server.sha!, bytes: 1 })
    u.write('a')
    const was = u.server.sha
    await u.queue.save()
    expect(u.server.bases).toEqual([was])
  })

  it('a vault replaced at the same version number is never overwritten by a tab of the old one', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') }, 3)
    await w.queue.loaded(w.tab.vault!, dumpOf([]), { sha256: w.server.sha!, bytes: 1 })
    w.replacedAtSameVersion()
    const theirs = w.server.data
    w.write('stale edit')
    const e = await w.queue.save().catch((x: unknown) => x)
    expect(failureKind(e)).toBe('conflict') // sticky: the person decides (the conflict sheet)
    expect(w.server.data).toBe(theirs)
    expect(w.server.puts).toEqual([])
    expect(w.tab.dirty).toBe(true)
    expect(w.tab.vault!.version).toBe(3)
  })

  it('a lost upload is still adopted, and the next upload names it', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    await w.queue.loaded(w.tab.vault!, dumpOf([]), { sha256: w.server.sha!, bytes: 1 })
    w.write('a')
    w.server.loseNext = true
    await w.queue.save().catch(() => undefined) // landed as v2; the response was lost
    const landed = w.server.sha
    w.write('b')
    expect(await w.queue.save()).toMatchObject({ version: 3, skipped: false }) // adopted v2, then went on top of it
    expect(w.server.bases.at(-1)).toBe(landed)
    expect(w.queue.storedAs()).toEqual({ version: 3, sha256: w.server.sha })
  })

  it('keep mine names the version it goes on top of', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    await w.queue.loaded(w.tab.vault!, dumpOf([]), { sha256: w.server.sha!, bytes: 1 })
    w.write('mine')
    w.otherDeviceSaves()
    const theirSha = w.server.sha!
    await expect(w.queue.save()).rejects.toMatchObject({ status: 409 })
    const r = await w.queue.save(undefined, { rebase: { ...w.tab.vault!, version: 2 }, baseSha256: theirSha })
    expect(r).toMatchObject({ version: 3 })
    expect(w.server.bases.at(-1)).toBe(theirSha)
    // …and is refused if theirs was replaced meanwhile.
    const v = world()
    v.unlocked({ rawDataKey: key(1), header: header('mac') })
    v.write('mine')
    v.otherDeviceSaves()
    const stale = v.server.sha!
    v.replacedAtSameVersion()
    await expect(v.queue.save(undefined, { rebase: { ...v.tab.vault!, version: 2 }, baseSha256: stale })).rejects.toMatchObject({ status: 409 })
  })
})

describe('purging history on a re-key', () => {
  it('the purge rides every attempt of that save — the re-run after adopting a lost upload included — and no other save', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('a') })
    w.write('r1')
    w.server.loseNext = true
    await expect(w.queue.save()).rejects.toThrow(/lost/) // it landed; only the response was lost
    // The re-key's first attempt meets the landed upload (409), adopts it, and goes again on top of it.
    const r = await w.queue.save((s) => ({ ...s, rawDataKey: key(2) }), { purgeHistory: true })
    expect(r).toMatchObject({ version: 3, skipped: false })
    expect(w.server.purges).toEqual([false, true, true])
    expect(w.tab.vault?.rawDataKey).toEqual(key(2))
    w.write('r2')
    await w.queue.save()
    expect(w.server.purges).toEqual([false, true, true, false])
  })

  it('a refused purge is not retried on its own, and an ordinary save never carries one', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('a') })
    w.otherDeviceSaves()
    await expect(w.queue.save((s) => ({ ...s, rawDataKey: key(2) }), { purgeHistory: true })).rejects.toThrow(/version conflict/)
    expect(w.server.purges).toEqual([true])
    expect(w.tab.vault?.rawDataKey).toEqual(key(1)) // the key only changes when the upload lands
    w.write('x')
    await expect(w.queue.save()).rejects.toThrow(/version conflict/) // the next save is its own: no purge rides along
    expect(w.server.purges).toEqual([true, false])
  })
})

describe('history pins', () => {
  /** As session.ts does: a pin tied to one vault version. */
  const pinAt = (version: number, pin: HistoryPin) => (base: VaultSession) => (base.version === version ? pin : undefined)

  it('a pin rides every attempt based on its version — retries and autosave included — and nothing based on another', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('a') }, 4)
    w.tab.pinFor = pinAt(4, 'pre-restore')
    w.write('restored')
    w.server.offline = true
    await expect(w.queue.save(undefined, { auto: true })).rejects.toThrow(/Failed to fetch/)
    w.server.offline = false
    await w.queue.save(undefined, { auto: true }) // the retry, as autosave sends it
    expect(w.server.pins).toEqual(['pre-restore', 'pre-restore'])
    w.write('next')
    await w.queue.save()
    expect(w.server.pins).toEqual(['pre-restore', 'pre-restore', null]) // based on v5 now: no pin
  })

  it('never on a create, never with a purge, and not on the re-run after adopting a lost upload', async () => {
    const w = world()
    w.tab.pinFor = () => 'pre-upgrade'
    await w.queue.save(undefined, { seed: { rawDataKey: key(1), header: header('a'), version: 0 } })
    expect(w.server.pins).toEqual([null]) // nothing is replaced by a create

    w.write('r')
    await w.queue.save((s) => ({ ...s, rawDataKey: key(2) }), { purgeHistory: true })
    expect(w.server.pins).toEqual([null, null]) // a purge keeps nothing to pin

    w.tab.pinFor = pinAt(2, 'pre-upgrade')
    w.write('r2')
    w.server.loseNext = true
    await expect(w.queue.save()).rejects.toThrow(/lost/) // based on v2: pinned; it landed, the response was lost
    w.write('r3')
    await w.queue.save() // meets its own landed upload (409, still based on v2: pinned), adopts it, re-runs on v3: no pin
    expect(w.server.pins).toEqual([null, null, 'pre-upgrade', 'pre-upgrade', null])
    expect(w.server.version).toBe(4)
  })
})

describe('autosave', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const setup = () => {
    const w = world()
    const auto = w.withAutosave()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    const write = (row?: unknown) => {
      w.write(row)
      auto.onWrite()
    }
    return { ...w, auto, write }
  }

  it('saves 1.5s after the last write, not the first', async () => {
    const w = setup()
    w.write('a')
    await vi.advanceTimersByTimeAsync(1000)
    w.write('b')
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.server.attempts).toBe(0)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS - 1000)
    expect(w.server.puts.map((p) => p.opened.rows)).toEqual([['a', 'b']])
    expect(w.auto.state).toMatchObject({ status: 'idle', error: null })
    expect(w.auto.state.lastSavedAt).not.toBeNull()
    expect(w.tab.dirty).toBe(false)
    expect(w.queue.events).toEqual(['start:auto'])
  })

  it('offline, then online: retries on a 2s → 5s → 15s → 60s backoff and saves by itself', async () => {
    const w = setup()
    w.server.offline = true
    w.write('a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(1)
    expect(w.auto.state.status).toBe('retrying')
    expect(w.auto.state.error).toMatch(/Failed to fetch/)

    const expectAttemptAfter = async (ms: number, n: number) => {
      await vi.advanceTimersByTimeAsync(ms - 1)
      expect(w.server.attempts, `before ${ms}ms`).toBe(n - 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(w.server.attempts, `at ${ms}ms`).toBe(n)
    }
    await expectAttemptAfter(RETRY_BACKOFF_MS[0], 2)
    await expectAttemptAfter(RETRY_BACKOFF_MS[1], 3)
    await expectAttemptAfter(RETRY_BACKOFF_MS[2], 4)
    await expectAttemptAfter(RETRY_BACKOFF_MS[3], 5)
    await expectAttemptAfter(RETRY_BACKOFF_MS[3], 6) // stays at the cap

    // A write while offline doesn't hurry the backoff.
    w.write('b')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(6)

    // Back online: the 'online' event retries at once.
    w.server.offline = false
    w.auto.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.server.attempts).toBe(7)
    expect(w.auto.state).toMatchObject({ status: 'idle', error: null, retryAt: null })
    expect(w.tab.dirty).toBe(false)
    expect(open(w.server.data!).rows).toEqual(['a', 'b'])

    // The backoff starts over after a success.
    w.server.failNext = 503
    w.write('c')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.auto.state.status).toBe('retrying')
    await expectAttemptAfter(RETRY_BACKOFF_MS[0], 9)
    expect(w.auto.state.status).toBe('idle')
  })

  it('a 409 stays sticky: no retries, no saves on later writes, until a manual save succeeds', async () => {
    const w = setup()
    w.otherDeviceSaves()
    w.write('a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.auto.state.status).toBe('conflict')
    expect(w.auto.state.error).toMatch(/version conflict/)
    const attempts = w.server.attempts

    w.write('b')
    w.auto.onMode()
    w.auto.wake()
    w.auto.flush()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(w.server.attempts).toBe(attempts)
    expect(w.auto.state.status).toBe('conflict')

    // The person resolves it (here: the tab takes the server's version) and saves by hand.
    w.tab.vault = { ...w.tab.vault!, version: w.server.version }
    await w.queue.save()
    expect(w.auto.state).toMatchObject({ status: 'idle', error: null })
    w.write('c')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(attempts + 2)
  })

  it('a 413 is sticky as toolarge; a fresh unlock clears it', async () => {
    const w = setup()
    w.server.failNext = 413
    w.write('a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.auto.state.status).toBe('toolarge')
    w.write('b')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.server.attempts).toBe(1)
    w.auto.reset()
    expect(w.auto.state).toMatchObject({ status: 'idle', error: null })
    w.write('c')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(2)
  })

  it('a hidden tab flushes at once', async () => {
    const w = setup()
    w.write('a')
    w.auto.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.server.puts).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(1) // the debounce found nothing left to do
  })

  it('never runs two uploads at once; writes during an upload go up right after it', async () => {
    const w = setup()
    w.server.hold = gate()
    const held = w.server.hold
    w.write('a')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.attempts).toBe(1)
    w.write('b')
    await vi.advanceTimersByTimeAsync(5 * AUTOSAVE_DELAY_MS) // the debounce keeps finding one in flight
    expect(w.server.attempts).toBe(1)
    w.server.hold = null
    held.release()
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.maxConcurrent).toBe(1)
    expect(w.server.puts.map((p) => p.opened.rows)).toEqual([['a'], ['a', 'b']])
    expect(w.tab.dirty).toBe(false)
  })

  it('onMode schedules a dirty session that no write announced (an upgraded snapshot after unlock)', async () => {
    const w = setup()
    w.tab.dirty = true
    w.tab.rows = ['upgraded']
    w.auto.onMode()
    w.auto.onMode() // doesn't push the save back
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS)
    expect(w.server.puts).toHaveLength(1)
  })

  it('a refused header change is its caller’s error, not autosave’s; a manual save shows as saving', async () => {
    const w = setup()
    const states: string[] = []
    const p = w.queue.save(() => {
      states.push(w.auto.state.status)
      throw new Error('cannot remove the only passkey on the vault')
    })
    await expect(p).rejects.toThrow()
    expect(states).toEqual(['saving'])
    expect(w.auto.state).toMatchObject({ status: 'idle', error: null })
  })
})

/* ---------- keep mine, and replacing the tab's data ---------- */

describe('rebase ("keep mine") and exclusive jobs', () => {
  it('keep mine seals this tab’s rows on top of the other device’s version, with its header, under the same key', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('mine')
    w.otherDeviceSaves() // v2
    await expect(w.queue.save()).rejects.toMatchObject({ status: 409 })
    const theirs = { rawDataKey: w.tab.vault!.rawDataKey, header: header('mac', 'phone'), version: 2 }
    const r = await w.queue.save(undefined, { rebase: theirs })
    expect(r).toMatchObject({ version: 3, skipped: false })
    expect(w.server.puts.at(-1)).toMatchObject({ version: 3, opened: { key: 1, keys: ['mac', 'phone'], seq: 3, rows: ['mine'] } })
    expect(w.tab.vault).toMatchObject({ version: 3 })
    expect(w.tab.vault!.header.keys.map((k) => k.credentialId)).toEqual(['mac', 'phone']) // their passkey stays
    expect(w.tab.dirty).toBe(false)
    expect(w.tab.commits.at(-1)).toEqual({ version: 3, seq: 3, sha256: w.server.sha, size: w.server.data!.length })
  })

  it('keep mine uploads even when the rows equal what was last sealed', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    await w.queue.loaded(w.tab.vault!, { scarab: true, schemaVersion: 20, exportedAt: 'x', tables: tables([]) }, { sha256: w.server.sha!, bytes: 1 })
    w.otherDeviceSaves()
    const r = await w.queue.save(undefined, { rebase: { ...w.tab.vault!, version: 2 } })
    expect(r).toMatchObject({ version: 3, skipped: false })
  })

  it('never reseals over a re-keyed vault under the old key', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('mine')
    w.otherDeviceSaves()
    await expect(w.queue.save(undefined, { rebase: { rawDataKey: key(2), header: header('mac'), version: 2 } })).rejects.toThrow(/re-keyed meanwhile/)
    expect(w.server.attempts).toBe(0)
    expect(w.tab.vault).toMatchObject({ version: 1 })
    w.tab.vault = null
    await expect(w.queue.save(undefined, { rebase: { rawDataKey: key(1), header: header('mac'), version: 2 } })).rejects.toThrow(/re-keyed meanwhile/)
  })

  it('an exclusive job (replacing the tab’s data) runs with no save alongside it, in queue order', async () => {
    const w = world()
    w.unlocked({ rawDataKey: key(1), header: header('mac') })
    w.write('a')
    w.server.hold = gate()
    const held = w.server.hold
    const first = w.queue.save(undefined, { auto: true })
    let during: unknown = null
    const ex = w.queue.exclusive(async () => {
      // The save requested before it has finished; the one requested after hasn't started.
      during = { running: w.server.concurrent, attempts: w.server.attempts, stored: w.server.puts.length }
      await Promise.resolve()
      return 7
    })
    const second = w.queue.save(undefined, { force: true })
    expect(w.queue.inFlight()).toBe(3)
    w.server.hold = null
    held.release()
    expect(await ex).toBe(7)
    await Promise.all([first, second])
    expect(during).toEqual({ running: 0, attempts: 1, stored: 1 })
    expect(w.server.attempts).toBe(2)
    expect(w.queue.inFlight()).toBe(0)
    // A failing one doesn't jam the queue.
    await expect(w.queue.exclusive(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    w.write('b')
    await expect(w.queue.save()).resolves.toMatchObject({ skipped: false })
  })
})

/* ---------- following the other member's saves ---------- */

describe('decideOnPoll', () => {
  const d = (serverVersion: number | null, sessionVersion: number | null, dirty = false, inFlight = 0) =>
    decideOnPoll({ serverVersion, sessionVersion, dirty, inFlight })

  it('follows a newer version into a tab with nothing unsaved', () => {
    expect(d(5, 4)).toBe('refresh')
    expect(d(12, 4)).toBe('refresh')
  })

  it('asks the person when the tab has unsaved work', () => {
    expect(d(5, 4, true)).toBe('banner')
  })

  it('never loads a server that went backwards or lost its vault on its own', () => {
    expect(d(3, 4)).toBe('banner')
    expect(d(null, 4)).toBe('banner')
    expect(d(3, 4, true)).toBe('banner')
    expect(d(null, 4, true)).toBe('banner')
  })

  it('asks the person when the server’s blob at this tab’s own version isn’t the one it knows (replaced)', () => {
    expect(decideOnPoll({ serverVersion: 4, sessionVersion: 4, dirty: false, inFlight: 0, replaced: true })).toBe('banner')
    expect(decideOnPoll({ serverVersion: 4, sessionVersion: 4, dirty: true, inFlight: 0, replaced: true })).toBe('banner')
    expect(decideOnPoll({ serverVersion: 4, sessionVersion: 4, dirty: false, inFlight: 1, replaced: true })).toBe('none') // our own save may be landing
    expect(decideOnPoll({ serverVersion: 4, sessionVersion: 4, dirty: false, inFlight: 0, replaced: false })).toBe('none')
  })

  it('does nothing in step, without a vault, or while a save of its own is running', () => {
    expect(d(4, 4)).toBe('none')
    expect(d(4, 4, true)).toBe('none')
    expect(d(5, null)).toBe('none')
    expect(d(null, null)).toBe('none')
    expect(d(5, 4, false, 1)).toBe('none')
    expect(d(5, 4, true, 2)).toBe('none')
    expect(d(null, 4, false, 1)).toBe('none')
  })
})

describe('watcher', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const st = { active: true, visible: true, polls: 0, hold: null as Gate | null, fail: false }
    const w = createWatcher({
      active: () => st.active,
      visible: () => st.visible,
      poll: async () => {
        st.polls++
        if (st.hold) await st.hold.wait
        if (st.fail) throw new Error('offline')
      },
    })
    return { st, w }
  }

  it('checks every 45s while the tab is visible and holds a vault', async () => {
    const { st, w } = setup()
    w.onMode()
    await vi.advanceTimersByTimeAsync(POLL_MS - 1)
    expect(st.polls).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(st.polls).toBe(1)
    w.onMode() // every scarab-mode event calls this: it doesn't restart the rhythm
    w.onMode()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(st.polls).toBe(4)
  })

  it('stops while hidden, and checks at once when the tab is back', async () => {
    const { st, w } = setup()
    w.onMode()
    st.visible = false
    w.sleep()
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(st.polls).toBe(0)
    st.visible = true
    w.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(1)
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(st.polls).toBe(2)
  })

  it('focus checks at once, but not twice within a few seconds', async () => {
    const { st, w } = setup()
    w.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    w.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(1)
    await vi.advanceTimersByTimeAsync(POLL_MIN_GAP_MS)
    w.wake()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(2)
  })

  it('has nothing to follow without a session holding a vault', async () => {
    const { st, w } = setup()
    st.active = false
    w.onMode()
    w.wake()
    w.kick()
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(st.polls).toBe(0)
    st.active = true
    w.onMode()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(st.polls).toBe(1)
    st.active = false // the session ended: the next tick finds nothing and lets the rhythm lapse
    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(st.polls).toBe(1)
  })

  it('one check at a time; a kick during one runs once more after it; a failure doesn’t stop the rhythm', async () => {
    const { st, w } = setup()
    st.hold = gate()
    const held = st.hold
    w.kick()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(1)
    w.kick()
    w.kick()
    w.wake()
    await vi.advanceTimersByTimeAsync(POLL_MS * 2) // still held: no second check alongside
    expect(st.polls).toBe(1)
    st.hold = null
    st.fail = true
    held.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(st.polls).toBe(2) // the kicks, folded into one
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(st.polls).toBe(3) // failing checks keep their rhythm
  })
})

describe('tab presence', () => {
  /** An in-memory BroadcastChannel: a message reaches every other channel, never its sender. */
  const bus = () => {
    const chans: PresenceChannel[] = []
    return (): PresenceChannel => {
      const ch: PresenceChannel = {
        onmessage: null,
        postMessage: (m) => {
          for (const o of chans) if (o !== ch) o.onmessage?.({ data: structuredClone(m) })
        },
      }
      chans.push(ch)
      return ch
    }
  }
  const tab = (make: () => PresenceChannel, id: string) => {
    const t = { active: false, changes: 0, ch: make() }
    const p = createTabPresence(t.ch, { id, active: () => t.active, changed: () => t.changes++ })
    return Object.assign(t, { p, enter: () => ((t.active = true), p.announce(true)) })
  }

  it('the second tab to open a session is told; the first is not', () => {
    const make = bus()
    const a = tab(make, 'a')
    a.p.announce(false) // loads: nobody else
    a.enter()
    expect(a.p.ahead).toBe(0)
    const b = tab(make, 'b')
    b.p.announce(false) // loads at the front door: a answers
    expect(b.p.ahead).toBe(1)
    b.enter()
    expect(b.p.ahead).toBe(1)
    expect(a.p.ahead).toBe(0)
    expect(a.changes).toBe(0)
  })

  it('a tab waiting at the front door learns when another enters a session', () => {
    const make = bus()
    const b = tab(make, 'b')
    b.p.announce(false)
    const a = tab(make, 'a')
    a.p.announce(false)
    expect(b.p.ahead).toBe(0) // two front doors: nothing to say
    a.enter()
    expect(b.p.ahead).toBe(1)
    expect(a.p.ahead).toBe(0)
  })

  it('a tab that leaves (pagehide) stops counting; junk and its own echoes are ignored', () => {
    const make = bus()
    const a = tab(make, 'a')
    a.enter()
    const b = tab(make, 'b')
    b.enter()
    expect(b.p.ahead).toBe(1)
    for (const data of [null, 'hello', 42, { t: 'here' }, { t: 'here', id: 7 }, { t: 'here', id: 'b' }, { t: 'bye', id: 'b' }])
      b.ch.onmessage?.({ data })
    expect(b.p.ahead).toBe(1)
    a.p.leave()
    expect(b.p.ahead).toBe(0)
    expect(b.changes).toBe(2)
  })
})

describe('idle auto-lock', () => {
  const MIN = 60_000
  /** A session and a clock: `dirty` means a save would be needed, `saveFails` that it would fail. */
  const setup = (minutes: IdleMinutes = 15) => {
    const st = { t: 1_000_000, active: true, minutes, dirty: false, saveFails: null as Error | null, locks: 0, saves: 0, blocked: [] as string[], hold: null as Promise<void> | null }
    const idle = createIdleLock({
      now: () => st.t,
      active: () => st.active,
      minutes: () => st.minutes,
      async lock() {
        // As session.lockVault: save first if anything is unsaved; a failed save throws and nothing locks.
        if (st.hold) await st.hold
        if (st.dirty) {
          st.saves++
          if (st.saveFails) throw st.saveFails
          st.dirty = false
        }
        st.locks++
        st.active = false
      },
      blocked: (e, m) => st.blocked.push(`${m}: ${(e as Error).message}`),
    })
    return { st, idle }
  }

  it('locks after the chosen minutes without input — not a moment before — and any input starts the clock over', async () => {
    const { st, idle } = setup(15)
    expect(await idle.check()).toBe('idle') // the session's start starts the clock
    st.t += 15 * MIN - 1
    expect(await idle.check()).toBe('idle')
    idle.activity() // a key, the pointer, a scroll
    st.t += 15 * MIN - 1
    expect(await idle.check()).toBe('idle')
    st.t += 1
    expect(await idle.check()).toBe('locked')
    expect(st.locks).toBe(1)
    expect(await idle.check()).toBe('off') // locked: nothing to do
  })

  it('never, or no session with a vault: never locks, however long', async () => {
    const never = setup(null)
    never.st.t += 1000 * MIN
    expect(await never.idle.check()).toBe('off')
    const none = setup(15)
    none.st.active = false
    none.st.t += 1000 * MIN
    expect(await none.idle.check()).toBe('off')
    expect(never.st.locks + none.st.locks).toBe(0)
  })

  it('a session that starts after a long wait at the front door counts from its start, not from the last input', async () => {
    const { st, idle } = setup(15)
    st.active = false
    expect(await idle.check()).toBe('off')
    st.t += 3 * 60 * MIN // hours at the front door
    st.active = true // unlocked
    expect(await idle.check()).toBe('idle')
    st.t += 14 * MIN
    expect(await idle.check()).toBe('idle')
    st.t += MIN
    expect(await idle.check()).toBe('locked')
    // A new session straight after (no check saw the gap in between): reset() — which every unlock calls — starts the clock over.
    st.active = true
    st.t += 60 * MIN
    idle.reset()
    expect(await idle.check()).toBe('idle')
  })

  it('saves first; a save that fails locks nothing, says why, and tries again a minute later if still idle', async () => {
    const { st, idle } = setup(60)
    expect(await idle.check()).toBe('idle') // the session starts
    st.dirty = true
    st.saveFails = new NetError('couldn’t reach the server', null)
    st.t += 60 * MIN
    expect(await idle.check()).toBe('blocked')
    expect(st.locks).toBe(0)
    expect(st.dirty).toBe(true) // the unsaved work is still in the tab
    expect(st.blocked).toEqual(['60: couldn’t reach the server'])
    // Not every tick: the next try waits a minute.
    st.t += IDLE_RETRY_MS - 1
    expect(await idle.check()).toBe('idle')
    expect(st.saves).toBe(1)
    st.saveFails = null // back online
    st.t += 1
    expect(await idle.check()).toBe('locked')
    expect(st).toMatchObject({ saves: 2, locks: 1, dirty: false })
  })

  it('one lock at a time: checks that overlap a slow save share its outcome', async () => {
    const { st, idle } = setup(15)
    expect(await idle.check()).toBe('idle') // the session starts
    let release!: () => void
    st.hold = new Promise<void>((r) => (release = r))
    st.t += 15 * MIN
    const a = idle.check()
    const b = idle.check()
    release()
    expect(await a).toBe('locked')
    expect(await b).toBe('locked')
    expect(st.locks).toBe(1)
  })

  it('the setting: 15 minutes, 1 hour, 4 hours or never — nothing else', () => {
    for (const ok of [15, 60, 240, null]) expect(isIdleMinutes(ok)).toBe(true)
    for (const bad of [0, 5, 30, 1440, '15', undefined, NaN]) expect(isIdleMinutes(bad)).toBe(false)
  })
})
