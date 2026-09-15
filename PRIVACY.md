# Scarab privacy architecture

This document states exactly what Scarab can and cannot see, for both
deployment modes. It is written to be audited against the code, which is the
entire repository you are reading.

## The two modes

**Household mode** (the original deployment): a single Cloud Run instance
behind Google Identity-Aware Proxy with an IAM allowlist. The server holds the
household's SQLite database in plaintext; the boundary is Google's
authentication edge plus the allowlist. Appropriate when the operators *are*
the household.

**Zero-knowledge mode** (scarab.one, in progress): the server stores only
ciphertext. All plaintext handling — parsing, ledgers, charts, simulation,
encryption — happens in the browser. Deployed with `SCARAB_ZK_ONLY=1`, the
server has no plaintext routes at all (see below).

## The vault (shipped)

`shared/vault.ts` implements envelope encryption, entirely client-side, with
passkeys as the only day-to-day key:

- A random 256-bit AES-GCM **data key** encrypts the payload.
- The data key is **wrapped once per passkey**. A passkey's WebAuthn PRF
  extension, evaluated on the vault's salt, yields a deterministic 32-byte
  secret that never leaves the browser; HKDF turns it into the wrapping key.
  Fingerprint or face on the device, synced by Apple or Google across the
  user's devices. There is no passphrase.
- The raw data key doubles as the **recovery code**: 52 characters, shown
  once at creation, meant for paper. It opens the vault on any device.
- Adding a device or a household member adds one more wrapping to the
  header; the payload is never re-encrypted. A member's phone answers the
  browser's QR passkey prompt from an unlocked session, so their passkey is
  created in *their* Apple or Google account and their PRF secret wraps the
  key in *your* tab.
- The server (`server/api4.ts`) stores `{prf salt, wrappings, ciphertext}`
  with a version counter and a SHA-256 it cannot forge cheaply — the client
  recomputes the hash locally ("Verify integrity" on the Data & Vault screen).
  A `household_members` table maps a partner's identity onto the same blob.
  Nothing in the header is secret.
- WebAuthn is used **only as a key-derivation device**. Authentication is
  IAP's job, so the server never sees a challenge, an attestation, or a
  signature; `src/passkey.ts` is a client-only file.

Consequences, stated plainly:

- **A server breach yields ciphertext.** AES-GCM with a 256-bit key; the PRF
  secret never leaves the browser in any form.
- **There is no password reset.** Losing every passkey and the recovery code
  means the vault is gone. In a household, the partner's passkey is the
  practical recovery: they unlock and add you again. The UI says so at the
  moment it matters.
- **A Google or Apple account is not enough.** Synced passkeys are end-to-end
  encrypted by the platform and restoring them to a new device needs an
  existing device's screen lock. The account alone does not decrypt Scarab.
- **Tampering is detectable.** GCM authentication fails closed; a modified
  blob refuses to decrypt rather than decrypting wrongly, and a wrapping
  moved to another credential id fails too (HKDF salts on the id).
- **"Save" reseals, it does not re-key.** A zero-knowledge session keeps the
  data key in memory after unlock and re-encrypts each new payload under it
  (fresh GCM IV every time); every passkey and the recovery code keep
  working. Rotating the key is a deliberate, separate action that keeps only
  the passkey that answers and mints a new recovery code.
- **The server can be made unable to hold plaintext.** With
  `SCARAB_ZK_ONLY=1` (`server/app.ts`), the server answers exactly six
  things: identity, the mode probe, the encrypted-blob courier, its
  membership list (emails it already knows from IAP), the price basket, and
  health. Every other route returns 403 before any handler runs, and the
  server refuses to boot at all if its database holds plaintext (a one-time
  `SCARAB_PURGE_PLAINTEXT=1` wipes a household install's data, keeping
  ciphertext and the basket). The allowed-route list is a single regular
  expression, so the claim is auditable in one line.
- **The front door never sends plaintext.** scarab.one opens to *unlock*
  (one passkey tap decrypts the stored ciphertext in the tab) or *start
  empty*; either way the engine runs in the browser and only ciphertext is
  ever uploaded (`PUT /api/vault`). The server is told nothing but the vault
  version.
- **Browser requirement.** Passkeys with the PRF extension: Chrome and Safari
  on current macOS, iOS, Android and Windows. A browser without it can open
  the vault only with the recovery code, and the front door says so.

## What the server still learns (honesty section)

Zero-knowledge is a statement about *content*, not existence. Even in ZK mode
the operator can observe:

- **Identity and timing**: who syncs, when, and blob sizes (mitigation: none
  planned; this is inherent to hosted sync). Autosave makes this finer-grained:
  a session uploads a fresh ciphertext shortly after each burst of edits, so
  the server sees when you are working, never what on.
- **Quote symbols**: in household mode price fetches name the held symbols to
  the server (which already holds the ledger). In zero-knowledge mode the
  server instead publishes a **daily price basket** — the whole US-listed
  universe plus top crypto, fetched once and served identically to every
  client — and the browser picks its own symbols out locally. The request is
  the same for everyone, so it reveals nothing about the portfolio behind it;
  the residual is identity and timing (who fetched the basket, and when), not
  content. Not yet covered in ZK mode: off-universe holdings and daily-history
  charts — the planned fix is an anonymous-add path and hashed symbol buckets;
  until then those price as-of the last snapshot.
- **Bank sync (future)**: automatic SimpleFIN-style sync is fundamentally in
  tension with zero-knowledge — a server-side job would see plaintext
  transactions. ZK mode therefore ships with manual imports (client-side
  parsing) first; any sync feature will be client-initiated and labeled with
  exactly what it exposes.

## The trust root: served JavaScript

No architecture can *prove* a server runs the code in a repository. What ZK
mode does instead is make the server irrelevant to confidentiality — which
moves the entire trust root to the JavaScript served to the browser. That is
auditable, and the plan is:

1. **Open source** — this repository.
2. **Reproducible builds** — pinned toolchain, deterministic output, published
   bundle hashes per release.
3. **Build provenance attestations** — CI-signed (sigstore) statements binding
   each deployed bundle hash to a public commit, verifiable with
   `gh attestation verify`.
4. **Asset manifest** — a signed list of every served file's hash, so third
   parties (or a verifier extension, à la WhatsApp's Code Verify) can check
   what scarab.one actually serves.

Residual risk, stated plainly: a malicious deployment could serve a poisoned
bundle to a targeted user. The measures above make that detectable after the
fact and expensive to do quietly; they cannot make it impossible. Users with
the highest requirements should self-host (the repo deploys with two scripts)
or run a verified local build.

## Data portability

The Data & Vault screen exports the complete database as one readable JSON
file — every transaction, trade, price, rule, and setting — and restores from
it. No export gatekeeping, no format lock-in. Your data is yours; the export
is also your audit of what Scarab knows.
