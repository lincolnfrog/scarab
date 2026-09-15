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

export type PasskeyResult = { credentialId: string; prfOutput: Uint8Array }

const RP_NAME = 'Scarab'
const rpId = () => window.location.hostname

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
  if (atCreate) return { credentialId, prfOutput: atCreate }
  return assertPasskey({ prfSaltB64: opts.prfSaltB64, credentialIds: [credentialId] })
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
  return { credentialId: b64urlEncode(new Uint8Array(cred.rawId)), prfOutput }
}
