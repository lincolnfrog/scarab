import { createHmac, randomBytes } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbLike } from '../engine/db'
import type { Dump } from '../engine/snapshot'
import {
  b64urlEncode,
  decodeRecoveryCode,
  encodeRecoveryCode,
  openPayload,
  parseVaultBlob,
  sealVault,
  sessionHeader,
  wrapForPasskey,
  type VaultBlobV3,
} from '../shared/vault'

/**
 * The household panel's operations (Z7) through the real wiring: session.ts +
 * saveQueue.ts + the sql.js engine + the real Hono app in memory, with a fake
 * authenticator. This tab is Max's (the owner); Nicole is a member whose
 * phone answers the QR prompt when he invites her, and who accepts the
 * invitation on her own device.
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})

/**
 * A fake authenticator: each credential holds a secret; its PRF output is
 * HMAC(secret, salt). `away` credentials exist but their device isn't at
 * hand; `attachment` is what the browser reports for the next ceremony.
 */
const authn = vi.hoisted(() => ({
  creds: new Map<string, Buffer>(),
  away: new Set<string>(),
  attachment: 'platform' as 'platform' | 'cross-platform',
  cancelNext: false,
  /** The credential ids each assertion offered. */
  asked: [] as string[][],
  registered: [] as string[],
}))
vi.mock('./passkey', async (importOriginal) => {
  const real = await importOriginal<typeof import('./passkey')>()
  const prfFor = (id: string, saltB64: string) =>
    new Uint8Array(createHmac('sha256', authn.creds.get(id)!).update(Buffer.from(saltB64, 'base64')).digest())
  const cancelled = () => {
    authn.cancelNext = false
    return new Error('passkey prompt was cancelled or timed out')
  }
  return {
    ...real,
    async registerPasskey(o: { prfSaltB64: string }) {
      if (authn.cancelNext) throw cancelled()
      const id = b64urlEncode(new Uint8Array(randomBytes(16)))
      authn.creds.set(id, randomBytes(32))
      authn.registered.push(id)
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64), attachment: authn.attachment }
    },
    async assertPasskey(o: { prfSaltB64: string; credentialIds: string[] }) {
      authn.asked.push([...o.credentialIds])
      if (authn.cancelNext) throw cancelled()
      const id = o.credentialIds.find((c) => authn.creds.has(c) && !authn.away.has(c))
      if (!id) throw new Error('passkey prompt was cancelled or timed out')
      return { credentialId: id, prfOutput: prfFor(id, o.prfSaltB64), attachment: authn.attachment }
    },
  }
})

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'

const location = { reload: vi.fn(), hostname: 'localhost' }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
const storage = (m: Map<string, string>) => ({
  getItem: (k: string) => m.get(k) ?? null,
  setItem: (k: string, v: string) => void m.set(k, v),
  removeItem: (k: string) => void m.delete(k),
  key: (i: number) => [...m.keys()][i] ?? null,
  get length() {
    return m.size
  },
})
const local$ = new Map<string, string>()
const session$ = new Map<string, string>()
vi.stubGlobal('sessionStorage', storage(session$))
vi.stubGlobal('localStorage', storage(local$))

const as = (who: string) => ({ 'x-goog-authenticated-user-email': `accounts.google.com:${who}` })
let app: ReturnType<typeof import('../server/app').createApp>
let serverDb: DbLike
/**
 * `losePut`: the next PUT /api/vault is applied, then its response is lost. `dropPut`: the next one never reaches the
 * server. `failVaultGets`: that many GET /api/vault fail as if offline. `holdPut`: PUTs wait for it. `who`: whose tab
 * this is (IAP's identity).
 */
const net = { losePut: false, dropPut: false, failVaultGets: 0, unreachableAfterLoss: false, holdPut: null as null | Promise<void>, who: 'max@x' }
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  if (url === '/api/vault' && method === 'GET' && net.failVaultGets > 0) {
    net.failVaultGets--
    throw new TypeError('Failed to fetch')
  }
  if (url === '/api/vault' && method === 'PUT' && net.holdPut) await net.holdPut
  if (url === '/api/vault' && method === 'PUT' && net.dropPut) {
    net.dropPut = false
    throw new TypeError('Failed to fetch')
  }
  const res = await app.request(url, { ...init, headers: { ...(init?.headers as Record<string, string>), ...as(net.who) } })
  if (url === '/api/vault' && init?.method === 'PUT' && net.losePut) {
    net.losePut = false
    if (net.unreachableAfterLoss) net.failVaultGets = 1 // …and asking the server what it holds fails too
    net.unreachableAfterLoss = false
    throw new TypeError('network connection was lost')
  }
  return res
})
vi.stubGlobal('fetch', fetchMock)

let session: typeof import('./session')
let local: typeof import('./local')
let key: Uint8Array

const row = () =>
  serverDb.prepare("SELECT version, data, prev_version, prev_data FROM vault_blobs WHERE owner_email = 'max@x'").get() as {
    version: number
    data: string
    prev_version: number | null
    prev_data: string | null
  }
const storedBlob = () => parseVaultBlob(row().data) as VaultBlobV3
const members = () => (serverDb.prepare("SELECT email FROM household_members WHERE household = 'max@x'").all() as { email: string }[]).map((r) => r.email)
const invited = () => (serverDb.prepare("SELECT email FROM vault_invites WHERE household = 'max@x' ORDER BY email").all() as { email: string }[]).map((r) => r.email)
/** Someone says yes to Max's invitation, from their own device. */
const accepts = async (who: string) =>
  expect(
    (
      await app.request('/api/vault/invites/accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...as(who) },
        body: JSON.stringify({ household: 'max@x' }),
      })
    ).status,
  ).toBe(200)
const history = () => (serverDb.prepare("SELECT count(*) AS n FROM vault_history WHERE owner_email = 'max@x'").get() as { n: number }).n
/** The stored vault's wrappings — only after its header authenticates under `k`. */
const storedKeys = async (k = key) => {
  const blob = storedBlob()
  await openPayload(blob, k)
  return blob.keys.map((w) => ({ label: w.label, identity: w.identity }))
}
const calls = () => fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${u}`)
const write = (name: string) => local.localDispatch('POST', '/api/accounts', { name, kind: 'checking' })
const nicoleGets = () => app.request('/api/vault', { headers: as('nicole@x') })
/** What this device remembers as owed for the stored vault (the salts of the keys whose code is owed), if anything. */
const owed = () => local$.get(`scarab:recovery-owed:${storedBlob().vaultId}`)
/** Another of Max's devices saves the next version: what is stored, resealed under the key it has. */
async function elsewhereSaves() {
  const blob = storedBlob()
  const data = JSON.stringify(await sealVault(sessionHeader(blob, 'localhost'), key, await openPayload(blob, key), row().version + 1))
  const put = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...as('max@x') },
    body: JSON.stringify({ data, version: row().version }),
  })
  expect(put.status).toBe(200)
}

/** A wrapping as an older Scarab added a member's passkey — labelled with their email, no identity — saved on the server and followed by the tab. */
async function injectLegacyWrap(label: string) {
  const id = b64urlEncode(new Uint8Array(randomBytes(16)))
  authn.creds.set(id, randomBytes(32))
  const blob = storedBlob()
  const dump = await openPayload(blob, key)
  const prf = new Uint8Array(createHmac('sha256', authn.creds.get(id)!).update(Buffer.from(blob.prfSalt, 'base64')).digest())
  const legacy = await wrapForPasskey(key, prf, { credentialId: id, label })
  const h = sessionHeader(blob, 'localhost')
  const data = JSON.stringify(await sealVault({ ...h, keys: [...h.keys, legacy] }, key, dump, row().version + 1))
  const put = await app.request('/api/vault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...as('max@x') },
    body: JSON.stringify({ data, version: row().version }),
  })
  expect(put.status).toBe(200)
  await session.refreshFromVault()
  expect(local.localMode.vault!.header.keys.find((w) => w.credentialId === id)).toMatchObject({ label })
  return legacy
}

beforeAll(async () => {
  app = (await import('../server/app')).createApp({ zkOnly: true })
  serverDb = (await import('../server/db')).db as unknown as DbLike
  local = await import('./local')
  session = await import('./session')
  local.localMode.setIdentity('max@x')
})
beforeEach(() => {
  authn.attachment = 'platform'
  authn.cancelNext = false
  authn.away.clear()
})
afterAll(() => vi.unstubAllGlobals())

describe('the household panel, end to end', () => {
  it('creating a vault binds its passkey to the signed-in identity and remembers it as this device’s', async () => {
    await session.startEmpty()
    await write('Checking')
    const r = await session.createVault('Max’s Mac')
    key = await decodeRecoveryCode(r.recoveryCode)
    expect(await storedKeys()).toEqual([{ label: 'Max’s Mac', identity: 'max@x' }])
    const mac = storedBlob().keys[0]!.credentialId
    expect(session.follow.unlockedWith).toEqual({ kind: 'passkey', label: 'Max’s Mac', credentialId: mac })
    expect([...session.thisDevicePasskeys()]).toEqual([mac])
    expect(JSON.parse(local$.get('scarab:device-creds')!)).toEqual([mac])
    expect(session.follow).toMatchObject({ recoveryOwed: false, rotationOwed: null })
  })

  it('inviting a member: the invitation first, then her passkey ceremony, bound to her — and never "this device"', async () => {
    fetchMock.mockClear()
    authn.attachment = 'cross-platform' // her phone, over the QR prompt
    const r = await session.addHouseholdMember(' Nicole@X ', 'Nicole’s iPhone')
    expect(r).toMatchObject({ already: false, pending: true })
    // An invitation, not a membership: the server serves her nothing until she says yes.
    expect(invited()).toEqual(['nicole@x'])
    expect(members()).toEqual([])
    expect((await nicoleGets()).status).toBe(404)
    // The invitation was sent before anything went into the header.
    expect(calls().filter((c) => c.startsWith('POST /api/vault/members') || c.startsWith('PUT /api/vault'))).toEqual([
      'POST /api/vault/members',
      'PUT /api/vault',
    ])
    expect(await storedKeys()).toEqual([
      { label: 'Max’s Mac', identity: 'max@x' },
      { label: 'Nicole’s iPhone', identity: 'nicole@x' },
    ])
    expect(session.thisDevicePasskeys().has(r.wrap.credentialId)).toBe(false)
    await vi.waitFor(() => expect(session.follow.household).toEqual({ owner: 'max@x', members: [], invited: ['nicole@x'] }))
    // She accepts on her own device: now she reaches the vault, and the next poll tells this tab.
    await accepts('nicole@x')
    expect((await nicoleGets()).status).toBe(200)
    expect(members()).toEqual(['nicole@x'])
    expect(invited()).toEqual([])
    await session.checkForUpdates()
    await vi.waitFor(() => expect(session.follow.household).toEqual({ owner: 'max@x', members: ['nicole@x'], invited: [] }))
  })

  it('an invitation withdrawn: it can no longer be accepted, and the passkey added for him comes off — no re-key', async () => {
    authn.attachment = 'cross-platform'
    await session.addHouseholdMember('aaron@x', 'Aaron’s phone') // the invitation, then his passkey a moment later
    expect(invited()).toEqual(['aaron@x'])
    const v = row().version
    expect(await session.cancelInvite('aaron@x')).toEqual({ removed: 1, kept: 0 })
    expect(invited()).toEqual([])
    expect(row().version).toBe(v + 1)
    expect((await storedKeys()).map((w) => w.identity)).toEqual(['max@x', 'nicole@x']) // under the same key: nothing to re-key
    const late = await app.request('/api/vault/invites/accept', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...as('aaron@x') },
      body: JSON.stringify({ household: 'max@x' }),
    })
    expect(late.status).toBe(404)
    // An invitation only, with his passkey to come later: it reads the same to the server, and withdraws with nothing to save.
    await session.addMember('aaron@x')
    expect(invited()).toEqual(['aaron@x'])
    await session.cancelInvite('aaron@x')
    expect(invited()).toEqual([])
    expect(row().version).toBe(v + 1)
    // A member is never "withdrawn": that is Remove from household, which re-keys.
    await expect(session.cancelInvite('nicole@x')).rejects.toThrow(/accepted meanwhile.*Remove from household/)
    expect(members()).toEqual(['nicole@x'])
    expect(row().version).toBe(v + 1)
  })

  it('my own passkey made on a phone over the QR prompt is mine, but not "this device"', async () => {
    authn.attachment = 'cross-platform'
    const phone = await session.addPasskey('Max’s iPhone')
    expect(phone.identity).toBe('max@x')
    expect(session.thisDevicePasskeys().has(phone.credentialId)).toBe(false)
    authn.attachment = 'platform'
    const laptop = await session.addPasskey('Max’s laptop')
    expect(session.thisDevicePasskeys().has(laptop.credentialId)).toBe(true)
    // …and neither may stay: later tests expect Max's Mac as his only passkey.
    await session.removePasskey(phone.credentialId)
    await session.removePasskey(laptop.credentialId)
  })

  it('which passkeys were added while someone was only invited: after the server’s stamp (to the millisecond; to the second on older rows)', () => {
    const stamp = '2026-09-23 18:47:26.250' // as the server writes it: UTC, SQLite's format
    expect(session.addedWhileInvited('2026-09-23T18:47:26.250Z', stamp)).toBe(true)
    expect(session.addedWhileInvited('2026-09-23T18:47:31.000Z', stamp)).toBe(true)
    expect(session.addedWhileInvited('2026-09-23T18:47:26.249Z', stamp)).toBe(false) // a moment before: maybe from an earlier membership
    expect(session.addedWhileInvited('2026-09-20T09:00:00.000Z', stamp)).toBe(false)
    // An invitation stamped to the second only: the rest of that second is ambiguous, so it isn't counted.
    expect(session.addedWhileInvited('2026-09-23T18:47:26.900Z', '2026-09-23 18:47:26')).toBe(false)
    expect(session.addedWhileInvited('2026-09-23T18:47:27.000Z', '2026-09-23 18:47:26')).toBe(true)
    // Unreadable either way: not counted (the passkey stays, and a re-key is the way out).
    expect(session.addedWhileInvited('not a date', stamp)).toBe(false)
    expect(session.addedWhileInvited('2026-09-23T18:47:30.000Z', 'yesterday')).toBe(false)
  })

  it('a passkey from before the invitation (she was in the household once) is not withdrawn with it: only a re-key locks her out', async () => {
    // She leaves on her own; Max invites her back, then thinks better of it.
    expect((await app.request('/api/vault/members/nicole%40x', { method: 'DELETE', headers: as('nicole@x') })).status).toBe(200)
    await session.addMember('nicole@x')
    const v = row().version
    expect(await session.cancelInvite('nicole@x')).toEqual({ removed: 0, kept: 1 })
    expect(invited()).toEqual([])
    expect(row().version).toBe(v) // nothing to save: her older passkey stays, and the panel shows her as no longer in the household
    expect((await storedKeys()).some((w) => w.identity === 'nicole@x')).toBe(true)
    // (Back in, for what follows.)
    await session.addMember('nicole@x')
    await accepts('nicole@x')
  })

  it('a ceremony that fails takes back the invitation it made — and nothing reaches the header', async () => {
    const before = row().version
    authn.cancelNext = true
    await expect(session.addHouseholdMember('aaron@x')).rejects.toThrow(/cancelled/)
    expect(invited()).toEqual([])
    expect(members()).toEqual(['nicole@x'])
    expect(row().version).toBe(before)
    // An invitation that was already waiting stays waiting; someone already in the household stays in.
    await session.addMember('aaron@x')
    authn.cancelNext = true
    await expect(session.addHouseholdMember('aaron@x', 'his phone')).rejects.toThrow(/cancelled/)
    expect(invited()).toEqual(['aaron@x'])
    await session.cancelInvite('aaron@x')
    authn.cancelNext = true
    await expect(session.addHouseholdMember('nicole@x', 'spare phone')).rejects.toThrow(/cancelled/)
    expect(members()).toEqual(['nicole@x'])
    // Not an email, or yourself: refused before anything happens.
    await expect(session.addHouseholdMember('nicole')).rejects.toThrow(/Google account email/)
    await expect(session.addHouseholdMember('MAX@x')).rejects.toThrow(/That’s you/)
    expect(row().version).toBe(before)
  })

  it('renaming a passkey reseals the header: the label changes, whose it is never does', async () => {
    const mac = storedBlob().keys.find((w) => w.label === 'Max’s Mac')!.credentialId
    await session.renamePasskey(mac, '  Max’s MacBook  ')
    expect(await storedKeys()).toEqual([
      { label: 'Max’s MacBook', identity: 'max@x' },
      { label: 'Nicole’s iPhone', identity: 'nicole@x' },
    ])
    expect(session.follow.unlockedWith).toMatchObject({ label: 'Max’s MacBook', credentialId: mac }) // the chip follows the rename
    // bind never re-assigns a wrapping that already names someone.
    await session.renamePasskey(mac, 'Max’s MacBook Pro', 'nicole@x')
    expect((await storedKeys())[0]).toEqual({ label: 'Max’s MacBook Pro', identity: 'max@x' })
    // Refused without a save: no name, too long, not on the vault.
    const v = row().version
    await expect(session.renamePasskey(mac, '   ')).rejects.toThrow(/needs a name/)
    await expect(session.renamePasskey(mac, 'x'.repeat(65))).rejects.toThrow(/64 characters/)
    await expect(session.renamePasskey('nope', 'x')).rejects.toThrow(/no longer on the vault/)
    expect(row().version).toBe(v)
  })

  it('a wrapping from before identities gets bound when renamed, so the rename never loses whose it is', async () => {
    // As an older Scarab added members: the label is her email, no identity. (Its secret is her iPad's.)
    const legacy = await injectLegacyWrap('nicole@x')
    expect('identity' in legacy).toBe(false)
    await session.renamePasskey(legacy.credentialId, 'Nicole’s iPad', 'nicole@x')
    expect((await storedKeys()).find((w) => w.label === 'Nicole’s iPad')).toEqual({ label: 'Nicole’s iPad', identity: 'nicole@x' })
  })

  it('showing the recovery code takes a fresh passkey answer that opens this session’s key', async () => {
    authn.asked.length = 0
    expect(await session.revealRecoveryCode()).toBe(await encodeRecoveryCode(key))
    expect(authn.asked).toHaveLength(1)
    expect(authn.asked[0]).toEqual(storedBlob().keys.map((w) => w.credentialId))
    authn.cancelNext = true
    await expect(session.revealRecoveryCode()).rejects.toThrow(/cancelled/)
    // Where the vault's passkeys can't be used, it says where to go instead.
    location.hostname = 'elsewhere.example'
    await expect(session.revealRecoveryCode()).rejects.toThrow(/belong to localhost/)
    location.hostname = 'localhost'
  })

  it('removing a member cuts her off at once; her passkeys may not answer the re-key, so without his it waits', async () => {
    const macs = storedBlob().keys.filter((w) => w.identity === 'max@x').map((w) => w.credentialId)
    const hers = storedBlob().keys.filter((w) => w.identity === 'nicole@x' || w.label === 'Nicole’s iPad').map((w) => w.credentialId)
    for (const c of macs) authn.away.add(c) // only her phone is at hand
    authn.asked.length = 0
    const v = row().version
    await expect(session.removeFromHousehold('nicole@x', hers)).rejects.toThrow(/cancelled/)
    // Step 1 happened: the courier no longer serves her. Step 2 didn't: same key, nothing saved — and that is remembered.
    expect(members()).toEqual([])
    expect((await nicoleGets()).status).toBe(404)
    expect(row().version).toBe(v)
    expect(authn.asked).toEqual([macs]) // her passkeys were never offered
    expect(session.follow.rotationOwed).toBe('nicole@x')
    const vaultId = storedBlob().vaultId
    expect(local$.get(`scarab:rotation-owed:${vaultId}`)).toBe('nicole@x')
  })

  it('finishing it re-keys without her, purges every earlier version, and owes the person the new recovery code', async () => {
    expect(history()).toBeGreaterThan(0) // every earlier save kept the version it replaced, sealed under the old key
    // Another of her passkeys from before identities, labelled with her email, is offered first by list order —
    // finishing (as after a reload, with nothing but her email to go on) must still not let it answer.
    const legacy = await injectLegacyWrap('nicole@x')
    local.localMode.vault!.header.keys.sort((a, b) => (a.credentialId === legacy.credentialId ? -1 : b.credentialId === legacy.credentialId ? 1 : 0))
    authn.asked.length = 0
    const oldKey = key
    const r = await session.removeFromHousehold('nicole@x') // her membership is already gone: that's fine
    expect(authn.asked).toEqual([storedBlob().keys.map((w) => w.credentialId)])
    expect(authn.asked[0]).not.toContain(legacy.credentialId)
    key = await decodeRecoveryCode(r.recoveryCode)
    expect(r.kept).toBe('Max’s MacBook Pro')
    // Only the passkey that answered stays, still his; the new key opens the stored vault and the old one doesn't.
    expect(await storedKeys()).toEqual([{ label: 'Max’s MacBook Pro', identity: 'max@x' }])
    await expect(openPayload(storedBlob(), oldKey)).rejects.toThrow(/failed authentication/)
    // Nothing sealed under the old key is kept by the server.
    expect(history()).toBe(0)
    expect(row()).toMatchObject({ prev_version: null, prev_data: null })
    expect(session.follow.rotationOwed).toBeNull()
    expect(local$.has(`scarab:rotation-owed:${storedBlob().vaultId}`)).toBe(false)
    // The old code no longer works, so the new one is owed until the person says it's stored.
    expect(session.follow.recoveryOwed).toBe(true)
    session.acknowledgeRecoveryCode()
    expect(session.follow.recoveryOwed).toBe(false)
    expect(local$.has(`scarab:recovery-owed:${storedBlob().vaultId}`)).toBe(false)
  })

  it('inviting her back: she accepts again; then "already a member" is not an error, and a re-key had dropped her passkey', async () => {
    const first = await session.addHouseholdMember('nicole@x', 'Nicole’s iPhone')
    expect(first).toMatchObject({ already: false, pending: true })
    // Still invited (she hasn't answered): another passkey for her doesn't send a second invitation.
    fetchMock.mockClear()
    const spare = await session.addHouseholdMember('nicole@x', 'Nicole’s spare')
    expect(spare).toMatchObject({ already: false, pending: true })
    expect(calls().filter((c) => c.startsWith('POST /api/vault/members'))).toEqual([])
    await session.removePasskey(spare.wrap.credentialId)
    await accepts('nicole@x')
    const again = await session.addHouseholdMember('nicole@x', 'Nicole’s iPad')
    expect(again).toMatchObject({ already: true, pending: false })
    expect(members()).toEqual(['nicole@x'])
    expect((await storedKeys()).map((w) => w.label)).toEqual(['Max’s MacBook Pro', 'Nicole’s iPhone', 'Nicole’s iPad'])
  })

  it('a removal refuses when only her passkeys could re-key; removing yourself is not offered', async () => {
    const mine = storedBlob().keys.filter((w) => w.identity === 'max@x').map((w) => w.credentialId)
    await expect(session.removeFromHousehold('nicole@x', mine)).rejects.toThrow(/none is left to re-key it with/)
    expect(members()).toEqual(['nicole@x']) // refused before anything happened
    await expect(session.removeFromHousehold('max@x')).rejects.toThrow(/can’t remove yourself/)
  })

  it('a re-key whose response was lost is recognised at once: the new code comes back, owed until it is stored', async () => {
    session.acknowledgeRecoveryCode()
    const v = row().version
    net.losePut = true
    const r = await session.rotateVault() // applied, answer lost: the tab asks what the server holds, and it is the upload
    key = await decodeRecoveryCode(r.recoveryCode)
    expect(r.version).toBe(v + 1)
    expect(local.localMode.vault).toMatchObject({ version: v + 1 })
    expect(await storedKeys()).toEqual([{ label: 'Max’s MacBook Pro', identity: 'max@x' }]) // the code shown opens what is stored
    expect(session.follow.recoveryOwed).toBe(true)
    expect(owed()).toBe(storedBlob().prfSalt) // remembered by the key it is for
    expect(session.autosave.status).not.toBe('error')
    session.acknowledgeRecoveryCode()
    expect(owed()).toBeUndefined()
  })

  it('…and if the server can’t be asked either, the next save’s conflict adopts it and the new code is owed', async () => {
    net.losePut = true
    net.failVaultGets = 1
    await expect(session.rotateVault()).rejects.toThrow(/couldn’t reach the server.*may have reached the server anyway/)
    expect(session.follow.recoveryOwed).toBe(false) // nothing committed yet: this tab still holds the old key…
    expect(owed()).toBe(storedBlob().prfSalt) // …but this device remembers the key the upload was for
    await write('Savings')
    await session.saveVault() // 409 → the lost re-key is recognised as landed and adopted, then this save goes on top
    expect(session.follow.recoveryOwed).toBe(true)
    // The code shown now is the one that opens the vault the server holds.
    const code = await session.revealRecoveryCode()
    key = await decodeRecoveryCode(code)
    const dump = JSON.parse(new TextDecoder().decode(await openPayload(storedBlob(), key))) as Dump
    expect((dump.tables.accounts ?? []).map((a) => a.name)).toEqual(['Checking', 'Savings'])
    session.acknowledgeRecoveryCode()
  })

  it('a lost re-key on a clean tab: the next check locks it, and unlocking again asks for the new code — which opens the vault', async () => {
    expect(local.localMode.dirty).toBe(false)
    net.losePut = true
    net.failVaultGets = 1
    await expect(session.rotateVault()).rejects.toThrow(/couldn’t reach the server/)
    const stored = storedBlob().prfSalt
    expect(stored).not.toBe(local.localMode.vault!.header.prfSalt) // it landed: the server holds the new key
    expect(owed()).toBe(stored)
    location.reload.mockClear()
    await session.checkForUpdates() // clean, and the server moved on: it loads — and the tab's key no longer opens it
    expect(location.reload).toHaveBeenCalledTimes(1)
    expect(local.localMode.active).toBe(false)
    expect(session$.get('scarab:lock-note')).toMatch(/re-keyed/) // (takeLockNote reads once per page load)
    session$.delete('scarab:lock-note')
    await session.unlockVault() // the passkey that answered the re-key
    expect(session.follow.recoveryOwed).toBe(true)
    const code = await session.revealRecoveryCode()
    key = await decodeRecoveryCode(code)
    await openPayload(storedBlob(), key)
    session.acknowledgeRecoveryCode()
    expect(owed()).toBeUndefined()
  })

  it('a re-key that never reached the server owes nothing once the vault opens under the key it still has', async () => {
    const salt = local.localMode.vault!.header.prfSalt
    net.dropPut = true
    await expect(session.rotateVault()).rejects.toThrow(/couldn’t reach the server/)
    expect(storedBlob().prfSalt).toBe(salt) // nothing landed
    expect(owed()).toBeDefined() // …which this tab can’t know: a request on its way may still land
    expect(session.follow.recoveryOwed).toBe(false)
    await session.lockVault()
    await session.unlockVault()
    expect(session.follow.recoveryOwed).toBe(false) // the vault is still under the old key: its code still works
    expect(owed()).not.toContain(salt) // (the other key stays listed: it would count only if that upload landed after all)
    await openPayload(storedBlob(), key)
  })

  it('a code owed from before the flag named its key (a timestamp) still counts — for the key the vault is under', async () => {
    const { vaultId, prfSalt } = storedBlob()
    local$.set(`scarab:recovery-owed:${vaultId}`, '2026-09-20T12:00:00.000Z')
    await session.lockVault()
    await session.unlockVault()
    expect(session.follow.recoveryOwed).toBe(true)
    expect(owed()!.split(' ')).toContain(prfSalt)
    expect(owed()).not.toMatch(/2026-/)
    session.acknowledgeRecoveryCode()
    expect(session.follow.recoveryOwed).toBe(false)
    local$.delete(`scarab:recovery-owed:${vaultId}`) // what's left names keys that never landed
  })

  it('a refused re-key takes back what it owed; a code still owed for the current key stays owed', async () => {
    const salt = local.localMode.vault!.header.prfSalt
    local$.set(`scarab:recovery-owed:${storedBlob().vaultId}`, salt) // this key's code, not yet confirmed stored
    await elsewhereSaves() // another of Max's devices saves first: the re-key's upload is refused (409), not lost
    await expect(session.rotateVault()).rejects.toMatchObject({ status: 409 })
    expect(owed()).toBe(salt)
    await session.refreshFromVault({ discard: true })
    expect(session.follow.recoveryOwed).toBe(true)
    session.acknowledgeRecoveryCode()
    expect(owed()).toBeUndefined()
  })

  it('Lock waits for a re-key already uploading, so its outcome is heard before the page goes', async () => {
    let release = () => {}
    net.holdPut = new Promise<void>((r) => (release = r))
    fetchMock.mockClear()
    const rotating = session.rotateVault()
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/vault' && (i as RequestInit | undefined)?.method === 'PUT')).toBe(true))
    location.reload.mockClear()
    const locking = session.lockVault()
    await new Promise((r) => setTimeout(r, 30))
    expect(location.reload).not.toHaveBeenCalled() // still uploading
    net.holdPut = null
    release()
    key = await decodeRecoveryCode((await rotating).recoveryCode)
    await locking
    expect(location.reload).toHaveBeenCalledTimes(1)
    await session.unlockVault()
    expect(session.follow.recoveryOwed).toBe(true) // its code was never confirmed stored
    await openPayload(storedBlob(), key)
    session.acknowledgeRecoveryCode()
  })

  it('she leaves from her own tab: whatever is unsaved goes into the vault first, then the server stops serving her, and the session ends', async () => {
    // A re-key since dropped her passkeys: Max adds one for her (she's still a member), then — her device: her identity, that passkey.
    const ipad = (await session.addHouseholdMember('nicole@x', 'Nicole’s iPad')).wrap.credentialId
    local.exitLocalMode()
    location.reload.mockClear()
    net.who = 'nicole@x'
    local.localMode.setIdentity('nicole@x')
    try {
      for (const w of storedBlob().keys) if (w.credentialId !== ipad) authn.away.add(w.credentialId)
      await session.unlockVault()
      await write('Nicole’s savings')
      const v = row().version
      await session.leaveHousehold()
      expect(row().version).toBe(v + 1) // her last change was saved to the household first
      expect(members()).toEqual([])
      expect((await nicoleGets()).status).toBe(404)
      expect(location.reload).toHaveBeenCalledTimes(1) // the session ended, back to the front door…
      expect(session.takeLockNote()).toMatch(/You left the household/) // …which says why
      // Her passkeys stay on the vault until Max re-keys: his panel shows her as no longer in the household.
      expect((await storedKeys()).some((w) => w.identity === 'nicole@x')).toBe(true)
    } finally {
      net.who = 'max@x'
      local.localMode.setIdentity('max@x')
      authn.away.clear()
    }
    // Back on Max's tab: she is out, so a re-key without her is what's owed (his panel offers it).
    await session.unlockWithRecoveryCode(await encodeRecoveryCode(key))
    const r = await session.removeFromHousehold('nicole@x') // her membership is already gone: that's fine
    key = await decodeRecoveryCode(r.recoveryCode)
    expect((await storedKeys()).map((w) => w.identity)).toEqual(['max@x'])
  })

  it('what the device remembers comes back with the vault: an owed code survives a fresh unlock', async () => {
    local.exitLocalMode()
    await session.unlockWithRecoveryCode(await encodeRecoveryCode(key))
    expect(session.follow.recoveryOwed).toBe(true)
    expect(session.follow.rotationOwed).toBeNull()
    session.acknowledgeRecoveryCode()
    local.exitLocalMode()
    await session.unlockVault()
    expect(session.follow.recoveryOwed).toBe(false)
    expect(session.follow.unlockedWith).toMatchObject({ kind: 'passkey', label: 'Max’s MacBook Pro' })
  })
  it('a create whose response was lost is recognised at once: the vault is this tab’s, and its code comes back', async () => {
    const del = await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(del.status).toBe(200)
    local.exitLocalMode()
    await session.startEmpty()
    await write('Checking')
    net.losePut = true
    const r = await session.createVault('Max’s Mac')
    key = await decodeRecoveryCode(r.recoveryCode)
    expect(r.version).toBe(1)
    expect(local.localMode.vault).toMatchObject({ version: 1 })
    await openPayload(storedBlob(), key)
    expect(session.follow.recoveryOwed).toBe(false) // the code is on screen now: the create's one unprompted showing
    expect(owed()).toBeUndefined()
  })

  it('a create whose response was lost while the server can’t be asked: the vault is stored, and unlocking it asks for its code', async () => {
    const del = await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(del.status).toBe(200)
    local.exitLocalMode()
    await session.startEmpty()
    await write('Checking')
    net.losePut = true
    net.unreachableAfterLoss = true
    await expect(session.createVault('Max’s Mac')).rejects.toThrow(/couldn’t reach the server.*may have been stored anyway/)
    expect(local.localMode.vault).toBeNull()
    expect(owed()).toBe(storedBlob().prfSalt) // stored — and this device remembers that nobody has seen its code
    await expect(session.createVault('Max’s Mac')).rejects.toThrow(/already stored here \(v1\)/)
    local.exitLocalMode()
    await session.unlockVault()
    expect(session.follow.recoveryOwed).toBe(true)
    key = await decodeRecoveryCode(await session.revealRecoveryCode())
    await openPayload(storedBlob(), key)
    session.acknowledgeRecoveryCode()
    expect(owed()).toBeUndefined()
  })

  it('a create refused outright (a vault appeared meanwhile) owes nothing', async () => {
    const del = await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(del.status).toBe(200)
    local.exitLocalMode()
    await session.startEmpty()
    let release = () => {}
    net.holdPut = new Promise<void>((r) => (release = r))
    fetchMock.mockClear()
    const creating = session.createVault('Max’s Mac')
    await vi.waitFor(() => expect(calls()).toContain('PUT /api/vault'))
    // Another device creates one first; this upload then meets it (409).
    const theirs = await app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ data: '{"v":3}', version: 0 }) })
    expect(theirs.status).toBe(200)
    net.holdPut = null
    release()
    await expect(creating).rejects.toThrow(/stored here in the meantime — nothing was overwritten/)
    expect([...local$.keys()].filter((k) => k.startsWith('scarab:recovery-owed:'))).toEqual([])
  })
})

describe('creating a vault from the front door (an empty start)', () => {
  /** Whether leaving the page now would ask "Leave site?" (local.ts's beforeunload: an engine with unsaved work). */
  const wouldAskToLeave = () => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  }
  const deleteStored = async () => {
    const del = await app.request('/api/vault', { method: 'DELETE', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ confirm: 'DELETE' }) })
    expect(del.status).toBe(200)
  }

  it('a create the checks refuse, or whose passkey prompt is cancelled, boots no engine — a reload has nothing to ask about', async () => {
    local.exitLocalMode()
    // (What the front door used to do first: an empty start counts as unsaved work, so every failure after it left a tab that asks.)
    await session.startEmpty()
    expect(wouldAskToLeave()).toBe(true)
    local.exitLocalMode()

    // The vault another device made above is still stored: refused before the prompt — and before any engine.
    const registered = authn.registered.length
    await expect(session.createVault('Max’s Mac', { empty: true })).rejects.toThrow(/already stored here \(v1\)/)
    expect(authn.registered).toHaveLength(registered)
    expect(local.localMode.active).toBe(false)
    expect(wouldAskToLeave()).toBe(false)

    await deleteStored()
    authn.cancelNext = true
    await expect(session.createVault('Max’s Mac', { empty: true })).rejects.toThrow(/cancelled/)
    expect(local.localMode.active).toBe(false)
    expect(wouldAskToLeave()).toBe(false)
    expect([...local$.keys()].filter((k) => k.startsWith('scarab:recovery-owed:'))).toEqual([])
  })

  it('one that fails once the engine is up (a vault appeared meanwhile) leaves it with nothing unsaved', async () => {
    let release = () => {}
    net.holdPut = new Promise<void>((r) => (release = r))
    fetchMock.mockClear()
    const creating = session.createVault('Max’s Mac', { empty: true })
    await vi.waitFor(() => expect(calls()).toContain('PUT /api/vault'))
    expect(local.localMode).toMatchObject({ active: true, vault: null }) // booted after the passkey, for the first upload
    const theirs = await app.request('/api/vault', { method: 'PUT', headers: { 'content-type': 'application/json', ...as('max@x') }, body: JSON.stringify({ data: '{"v":3}', version: 0 }) })
    expect(theirs.status).toBe(200)
    net.holdPut = null
    release()
    await expect(creating).rejects.toThrow(/stored here in the meantime — nothing was overwritten/)
    expect(local.localMode).toMatchObject({ active: true, vault: null, dirty: false, writes: 0 })
    expect(wouldAskToLeave()).toBe(false)
  })

  it('one that goes through holds the new vault, saved — and a retry after a failure replaces the empty start', async () => {
    await deleteStored()
    const r = await session.createVault('Max’s Mac', { empty: true })
    key = await decodeRecoveryCode(r.recoveryCode)
    expect(r.version).toBe(1)
    expect(local.localMode).toMatchObject({ active: true, dirty: false })
    expect(local.localMode.vault).toMatchObject({ version: 1 })
    await openPayload(storedBlob(), key)
    expect(wouldAskToLeave()).toBe(false)
    await expect(session.createVault('Max’s Mac', { empty: true })).rejects.toThrow(/already has a vault/)
  })
})
