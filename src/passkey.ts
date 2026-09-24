import { b64decode, b64urlDecode, b64urlEncode } from '../shared/vault'

/**
 * WebAuthn as a key-derivation device. Identity is IAP's job, so nothing
 * here is verified server-side: no challenge round trip, no attestation, no
 * signature check. A passkey exists only to hand this tab a deterministic
 * 32-byte secret (the PRF extension, evaluated on the vault's salt) that
 * wraps the data key. The browser's own prompt handles everything else —
 * fingerprint, face, the QR hybrid flow to a phone in another ecosystem.
 *
 * Browser-only. The pure crypto it feeds is in shared/vault.ts.
 */

/**
 * `attachment`: where the authenticator that answered lives, as the browser
 * reports it — 'platform' is this device (its own passkey store, Touch ID,
 * Windows Hello, a synced keychain present here); 'cross-platform' is a
 * security key or a phone over the QR prompt. Null when the browser doesn't
 * say. Only a 'platform' answer earns a passkey the "this device" badge.
 */
export type PasskeyResult = { credentialId: string; prfOutput: Uint8Array; attachment: 'platform' | 'cross-platform' | null }

const attachmentOf = (cred: PublicKeyCredential): PasskeyResult['attachment'] => {
  const a = (cred as { authenticatorAttachment?: string | null }).authenticatorAttachment
  return a === 'platform' || a === 'cross-platform' ? a : null
}

const RP_NAME = 'Scarab'

/**
 * The production domain. Passkeys are bound to an RP ID for life, so every
 * page under it — scarab.one itself or any subdomain (www., a staging
 * host) — registers and asserts against the one registrable domain, and a
 * passkey made on one of them works on all of them.
 */
export const PRODUCTION_RP_ID = 'scarab.one'

/**
 * The WebAuthn RP ID to use on `hostname`: scarab.one for scarab.one and its
 * subdomains; anything else (localhost, a run.app host, a self-hosted
 * domain) uses its own hostname, as before. Pure, for the table test.
 */
export function rpIdFor(hostname: string): string {
  const h = hostname.toLowerCase().replace(/\.$/, '')
  return h === PRODUCTION_RP_ID || h.endsWith(`.${PRODUCTION_RP_ID}`) ? PRODUCTION_RP_ID : hostname
}

/** This page's RP ID. A vault's header records the one its passkeys belong to. */
export const rpId = (): string => rpIdFor(window.location.hostname)

/** Passkeys registered under `vaultRpId` can be used on this page. */
export const passkeysWorkHere = (vaultRpId: string): boolean => vaultRpId === rpId()

/** What to tell someone whose vault's passkeys belong to another domain than this page. */
export const wrongOriginMessage = (vaultRpId: string): string =>
  `This vault’s passkeys belong to ${vaultRpId} — open it there, or use the recovery code.`

/** Can this browser do passkeys with PRF at all? Null means "unknown until we try". */
export async function passkeySupport(): Promise<boolean | null> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials?.create) return false
  const caps = (PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> })
    .getClientCapabilities
  if (!caps) return null
  try {
    const c = await caps.call(PublicKeyCredential)
    return 'extension:prf' in c ? c['extension:prf']! : null
  } catch {
    return null
  }
}

const prfFrom = (cred: PublicKeyCredential): Uint8Array | null => {
  const first = cred.getClientExtensionResults().prf?.results?.first
  return first ? new Uint8Array(first as ArrayBuffer) : null
}

function explain(e: unknown): Error {
  if (e instanceof DOMException) {
    if (e.name === 'NotAllowedError') return new Error('passkey prompt was cancelled or timed out')
    if (e.name === 'InvalidStateError') return new Error('this authenticator already holds a passkey for the vault')
    if (e.name === 'NotSupportedError') return new Error('this browser cannot create passkeys here')
    return new Error(`passkey: ${e.message}`)
  }
  return e instanceof Error ? e : new Error(String(e))
}

/**
 * Create a passkey for this vault and return its PRF secret. `user.id` is
 * random per registration so a household member's phone and your own device
 * never overwrite each other's credential (authenticators dedupe on rp+user).
 * Existing credentials are excluded, so an authenticator that already holds
 * one refuses instead of minting a duplicate.
 *
 * Some platforms return PRF output at creation; the rest only on assertion.
 * When it is missing we assert immediately against the new credential —
 * two prompts on registration, one on every unlock after.
 */
export async function registerPasskey(opts: {
  prfSaltB64: string
  label: string
  excludeCredentialIds: string[]
}): Promise<PasskeyResult> {
  const salt = b64decode(opts.prfSaltB64)
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId(), name: RP_NAME },
        user: {
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: opts.label,
          displayName: `${RP_NAME} · ${opts.label}`,
        },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256 (Windows Hello)
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        excludeCredentials: opts.excludeCredentialIds.map((id) => ({ type: 'public-key', id: b64urlDecode(id) as BufferSource })),
        extensions: { prf: { eval: { first: salt as BufferSource } } },
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw explain(e)
  }
  if (!cred) throw new Error('no passkey was created')
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } }
  if (ext.prf && ext.prf.enabled === false)
    throw new Error('this passkey provider does not support the PRF extension — Scarab needs it to derive the vault key')
  const credentialId = b64urlEncode(new Uint8Array(cred.rawId))
  const atCreate = prfFrom(cred)
  // Where it was made is what the creation reported — the follow-up assertion runs wherever the new credential lives.
  if (atCreate) return { credentialId, prfOutput: atCreate, attachment: attachmentOf(cred) }
  const asserted = await assertPasskey({ prfSaltB64: opts.prfSaltB64, credentialIds: [credentialId] })
  return { ...asserted, attachment: attachmentOf(cred) ?? asserted.attachment }
}

/** Ask the authenticator for the PRF secret of one of the vault's passkeys. The browser picks the prompt. */
export async function assertPasskey(opts: { prfSaltB64: string; credentialIds: string[] }): Promise<PasskeyResult> {
  const salt = b64decode(opts.prfSaltB64)
  let cred: PublicKeyCredential | null
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        rpId: rpId(),
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: opts.credentialIds.map((id) => ({ type: 'public-key', id: b64urlDecode(id) as BufferSource })),
        userVerification: 'required',
        extensions: { prf: { eval: { first: salt as BufferSource } } },
        timeout: 120_000,
      },
    })) as PublicKeyCredential | null
  } catch (e) {
    throw explain(e)
  }
  if (!cred) throw new Error('no passkey answered')
  const prfOutput = prfFrom(cred)
  if (!prfOutput)
    throw new Error('the passkey answered without a PRF secret — this browser or provider cannot unlock the vault')
  return { credentialId: b64urlEncode(new Uint8Array(cred.rawId)), prfOutput, attachment: attachmentOf(cred) }
}
