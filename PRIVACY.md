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
encryption — happens in the browser.

## The vault (shipped)

`shared/vault.ts` implements envelope encryption, entirely client-side:

- A random 256-bit AES-GCM **data key** encrypts the payload.
- The data key is **wrapped** by a key derived from the user's passphrase
  (PBKDF2-SHA256, 600,000 iterations — WebCrypto-native; the format is
  versioned so Argon2id or WebAuthn-PRF passkey wrapping can ship as v2).
- The raw data key doubles as the **recovery key**, downloaded at backup time.
- The server (`server/api4.ts`) stores `{kdf params, wrapped key, ciphertext}`
  with a version counter and a SHA-256 it cannot forge cheaply — the client
  recomputes the hash locally ("Verify integrity" on the Data & Vault screen).

Consequences, stated plainly:

- **A server breach yields ciphertext.** AES-GCM with a 256-bit key; the
  passphrase never leaves the browser in any form.
- **There is no password reset.** Losing both the passphrase and every
  recovery key means the vault is gone. This is a feature with a cost; the UI
  says so at the moment it matters.
- **Tampering is detectable.** GCM authentication fails closed; a modified
  blob refuses to decrypt rather than decrypting wrongly.

## What the server still learns (honesty section)

Zero-knowledge is a statement about *content*, not existence. Even in ZK mode
the operator can observe:

- **Identity and timing**: who syncs, when, and blob sizes (mitigation: none
  planned; this is inherent to hosted sync).
- **Quote symbols**: price fetches go through the server (Yahoo/CoinGecko have
  no browser CORS). The proxy sees tickers, not quantities. Mitigation: a
  shared quote cache serves all users from one upstream fetch, so individual
  request patterns blur; symbol padding is possible if warranted.
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
