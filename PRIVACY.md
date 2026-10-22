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
- The raw data key doubles as the **recovery code**: 54 characters — 52
  for the key and a 2-character check group (10 bits of its SHA-256) —
  shown at creation (and later only after a fresh passkey, see below), meant
  for paper. It opens the vault on any device, on any domain. The check group
  lets a typo be reported as a typo, before
  anything is fetched, separately from a correctly typed code that doesn't
  open this vault; codes from before it (52 characters) still work. The
  Data & Vault screen's drill checks a written-down code against the key
  already in the tab: nothing is sent, and nothing is kept.
- Adding a device or a household member adds one more wrapping of the same
  data key to the header; no other wrapping changes and the key never does
  (the payload is resealed under it, since v3 authenticates the header — so
  adding a passkey is a save). A member's phone answers the
  browser's QR passkey prompt from an unlocked session, so their passkey is
  created in *their* Apple or Google account and their PRF secret wraps the
  key in *your* tab. The invitation is sent first
  (`POST /api/vault/members`), so no one's passkey lands in the header for
  someone the household didn't ask in; if the passkey prompt then fails, the
  tab withdraws the invitation it made. Each wrapping names the identity it
  belongs to (their sign-in email), which is how the Data & Vault screen
  ties passkeys to people — never by label, which is free text anyone can
  rename.
- **Nobody joins a household without saying yes.** `POST /api/vault/members`
  only records an invitation (`vault_invites`); the server keeps serving the
  invitee their own vault, or nothing, until they accept it signed in on
  their own device — the front door shows who sent it, with Join, Decline and
  Not now, focuses none of them, and asks once more before joining ("they will
  be able to read what you add") (`POST /api/vault/invites/accept`,
  `DELETE /api/vault/invites/:household`, the two patterns added to the
  vault-only allowlist). The invitation answers
  `200 {ok: true}` whatever the email is — unknown, owning a vault, in another
  household, or already in this one — so it can't be used to learn who uses
  Scarab; the only refusals are about the caller (inviting yourself, or a
  household with no vault yet). Someone can hold invitations from several
  households at once; accepting names the household, so the yes goes to the
  one that was shown and uses up only that invitation (the others wait for
  their own answer), and it ends what the invitee had: their own vault (deleted with its
  history, members and invitations, as `DELETE /api/vault` would — the front
  door asks for a typed DELETE first and the request carries the version
  confirmed) or their membership elsewhere; either must be asked for
  (`replaceOwn`). A member can leave on their own (`DELETE
  /api/vault/members/<self>`, from the front door or the Household card; a
  session saves what is unsaved first). The household sees its own
  unanswered invitations, and the owner — or whoever sent one — can withdraw
  it (`?pending=1`, which never touches a membership); a passkey already added
  for them comes off the vault with it, without a re-key, since the server
  never served them the vault. `/api/mode` lists only the caller's own
  waiting invitations.
- The server (`server/api4.ts`) stores the blob — a header plus ciphertext —
  with a version counter and a SHA-256 of it. It never parses the blob. A
  `household_members` table maps a partner's identity onto the same blob,
  once they have accepted a `vault_invites` invitation.
  Nothing in the header is secret: a random vault id, the passkeys' RP ID,
  the PRF salt, the sequence number, and each passkey's label, date, the
  identity it belongs to (an email the server already knows from IAP and the
  member list) and wrapped key.
- **Vault format v3** (written by every save; `shared/vault.ts`). The whole
  header is authenticated: it is the AES-GCM additional data of the payload,
  as canonical JSON (fixed field order, wrappings sorted by credential id). A
  relabelled passkey, a passkey re-assigned to another person, an injected or
  dropped wrapping, a swapped salt or RP ID, or a payload replayed under
  another sequence number fails to decrypt.
  `seq` is the version the blob was sealed to be stored as. The plaintext is
  gzipped and padded inside the encryption — `[length][gzip][zeros]`, to at
  least 32 KiB and otherwise the next eighth of a power of two — so the stored
  size tells the server a size bucket, not the size. Vaults written in the
  earlier v2 format still open; the first save rewrites them as v3.
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
  blob — payload or header — refuses to decrypt rather than decrypting
  wrongly, and a wrapping moved to another credential id fails too (HKDF
  salts on the id).
- **An older copy is caught, by a device that has seen a newer one.** Each
  browser remembers the last v3 state it opened or saved of a vault —
  `localStorage` `scarab:seen:<vaultId>` = `{seq, sha256, at, creds, prfSalt}`,
  where the hash is of the ciphertext as this device computed it, `creds` are
  credential ids and `prfSalt` is the header's (minted with the key, so it
  says which key without revealing it) — none of it secret. An unlock that is served an earlier
  `seq` than that, a different blob at the same `seq`, or a v2 copy of a
  vault this device knows in v3, stops and asks (Open anyway / Cancel).
  Honest limits: this is per device and trust-on-first-use — a new browser,
  a private window or cleared site data has no memory to compare against,
  and a server can always withhold the newest copy from someone who never
  saw it. A copy sealed for another version than the one it is served as
  opens with a notice. This matters most after a key rotation or a member's
  removal: a replayed pre-rotation copy still opens with the old key, and
  this is what flags it. The Data & Vault screen shows the comparison
  ("Last seen on this device: v42 · sha 3fa1… ✓").
- **Passkeys are pinned to scarab.one.** WebAuthn binds a passkey to an RP
  ID for life. Every page on scarab.one or a subdomain of it uses the RP ID
  `scarab.one` (`src/passkey.ts` `rpIdFor`), and the vault header records
  the RP ID its passkeys belong to; opened anywhere else, the vault says
  where its passkeys work and offers the recovery code, which works on any
  domain. Other hosts (development, self-hosting, a `run.app` deployment) use
  their own hostname — so passkeys made on a deployment before scarab.one is
  mapped belong to that host and would have to be added again on scarab.one.
- **"Save" reseals, it does not re-key.** A zero-knowledge session keeps the
  data key in memory after unlock and re-encrypts each new payload under it
  (fresh GCM IV every time); every passkey and the recovery code keep
  working. Rotating the key is a deliberate, separate action that keeps only
  the passkey that answers, mints a new recovery code, and asks the server to
  delete every earlier version it keeps (`purgeHistory`: they are sealed
  under the old key). Any member can rotate, not only the owner: everyone in
  the household already holds the key and could upload any header anyway, so
  the server doesn't pretend to stop it. Everyone else's passkeys — the
  owner's too, when a member rotates — then have to be added again. The app
  offers **Rotate key…** only to the owner; a member is told to ask the owner
  instead, so nobody locks the owner out by accident. Renaming
  a passkey edits the authenticated header, so it is a save like any other.
- **Removing someone is a re-key, not a list edit.** Only the household's
  owner can take a member out (`DELETE /api/vault/members/:email`; a member
  can remove only themselves, anyone else gets 403 — the existing
  `vault/members/[^/]+` pattern, no new route). The server then stops serving
  them the ciphertext at once. They still know the key, so the owner's tab
  re-keys the vault straight away: a new data key wrapped only for the
  passkey the owner answers with (the removed person's passkeys are not
  allowed to answer), uploaded with `purgeHistory` so the server deletes
  every earlier version it keeps, and a new recovery
  code that the screen won't let go of until the owner says it is stored.
  Every other passkey — the owner's other devices included — has to be
  added again; that is the cost of the key being new. Honest limits: what
  they opened while they were in the household (and any export they made)
  stays with them; re-keying protects what is saved from then on. If the
  re-key doesn't happen (a cancelled prompt), the device remembers that it
  is owed — `localStorage` `scarab:rotation-owed:<vaultId>` holds their email,
  on this device only — and the screen keeps asking.
- **Showing the recovery code takes a fresh passkey.** An unlocked tab
  doesn't hand the code to whoever is sitting at it: the screen asks one of
  the vault's passkeys first, and the answer must unwrap the session's key.
  Copy puts it on the clipboard and overwrites the clipboard a minute later
  (best effort: a browser lets only a focused page do that, so it waits for
  focus, and it can't check first whether you copied something else since).
  After a re-key this device remembers that a new code is owed
  (`scarab:recovery-owed:<vaultId>`: the PRF salts of the keys whose code is
  owed — public, every header lists its salt) until someone confirms it is
  stored. It is written before the upload that sets the new key, a create's
  included, so an answer lost on the way — or a tab locked or closed while
  it uploads — still leaves the reminder; an upload the server refuses
  outright takes it back, and when the vault next opens only the key it is
  actually under counts. A lost answer is first checked at once: the tab asks
  the server what it holds, and if that is its own upload, byte for byte, it
  carries on as if the answer had arrived — the new code is shown then.
  Locking waits for an upload already on its way.
- **"This device" is remembered locally.** The household panel marks the
  passkeys this browser's own authenticator made or answered with — only
  when the browser reports a platform authenticator, never a phone over the
  QR prompt — in `localStorage` `scarab:device-creds`: credential ids, which
  every vault header lists anyway.
- **The server keeps earlier versions — still ciphertext.** Each save moves
  the blob it replaces into `vault_history` (`server/api4.ts`): the last 20
  versions, the last one of each day for 30 days, and the 8 newest versions
  a save asked to keep (`pin`: `pre-upgrade`, the copy an older engine wrote
  before this one upgraded the snapshot; `pre-restore`, the version a restore
  replaced), up to 64 MB per household — past that the oldest go first,
  unpinned before pinned, never the most recent. `GET /api/vault/history`
  lists them (version, the ciphertext's hash and size, when and by whom it
  was stored, its pin — what the server already knew at each save) and
  `GET /api/vault/history/:version` returns one blob, both only for the
  caller's own household (the same `householdOf` routing as the vault).
  These are the two patterns this adds to the vault-only allowlist
  (`vault/history`, `vault/history/[0-9]+`). The Data & Vault screen's
  History card opens a version **in the tab**, with the key it already
  holds — which authenticates it, and its header says which version it was
  sealed for, so the server can't pass one version off as another — and
  counts its rows in a scratch database, never the tab's own. Restoring is a
  save like any other: the old data is resealed under the **current** key
  and header (a passkey removed since does not come back), and the version
  it replaces is kept, pinned, so the restore can be undone. A re-key
  (rotation, removing a member) deletes the whole history, since it is
  sealed under the retired key; so does deleting the vault. The older
  single-step copy (`prev_*`, migration 17) is no longer written; a leftover
  one joins the history at the next save.
- **Encrypted backups stay with you.** Data & Vault → Backups makes a
  `.scarab` file: the tab's data (unsaved changes included) sealed exactly
  like a vault version, under the vault's key and header, and downloaded —
  never uploaded. It opens with the tab's key, with a passkey that was on
  the vault when it was made, or with the recovery code from then (a backup
  keeps the key it was sealed with through later rotations, so an old code
  still opens an old backup — keep that in mind when you rotate because a
  code leaked). Like the stored blob, the file's header is readable: passkey
  labels, the identities they belong to, the RP ID, the vault id; the data
  is AES-GCM ciphertext and any change to the file fails to open. Putting a
  backup back is an explicit restore — into the open vault under its
  current key, with the replaced version kept (as above) — or, when no vault
  is stored at all, the backup becomes the vault with the key and passkeys
  it was sealed with (a version-0 create, refused if a vault exists). A
  device that saw the vault at a later version is told the restored one is
  an older copy, which it is — the restoring device included, before it
  restores: its memory (`scarab:seen:<vaultId>`) says the version it saw and
  which key. A backup from before a re-key it saw is never put back as it
  was, since that would bring back the retired key, its recovery code and
  the passkeys it listed; one that is only older is put back as it was only
  after the person says yes to exactly that (its passkey list comes back, and
  this device's memory starts over from it). The front door leads instead
  with a new vault from the backup's data — a fresh key, vault id, passkey
  and recovery code, which nothing the backup was sealed with opens; the
  memory of the old vault stays as it was. (A server that answers "no vault"
  may be withholding one; this is what keeps that from undoing a rotation or
  a removal.) The front door opens a backup too: if its key also opens the
  stored vault, that one prompt unlocks both.
- **Creating a vault never overwrites one.** A new vault is uploaded as
  version 0, which the server refuses (409) whenever a vault is already
  stored. Replacing one is an explicit delete: `DELETE /api/vault` (answered
  by the existing `vault` pattern of the vault-only allowlist — no new route
  pattern) removes the blob together with its stored history, its member rows
  and its invites. Only the household's owner may call it (the identity that
  created the vault; a member gets 403), the body must say
  `{confirm: "DELETE"}`, and a stale `version` is refused. The front door's
  **Start over** is shown only to the owner, names the version and the members
  who would lose access, requires typing REPLACE, and deletes only after the
  new passkey exists. The server learns that the owner started over — which
  the new version-1 blob would tell it anyway.
- **The server can be made unable to hold plaintext.** With
  `SCARAB_ZK_ONLY=1`, the server answers exactly six things: identity, the
  mode probe, the encrypted-blob courier (with the versions it keeps), its
  membership list and invitations (emails it already knows from IAP), the
  price basket with its market history (the monthly file and the daily
  buckets, each identical for every caller, the scheduled trigger that
  builds them, and the one-of-k ask that widens the basket), and health. Every other route returns 403 before any handler runs,
  and the server refuses to boot at all if its database holds plaintext (a
  one-time `SCARAB_PURGE_PLAINTEXT=1` wipes a household install's data,
  keeping the ciphertext, its membership routing and the shared price data). The
  allowed routes are one short literal list, `server/zk-routes.ts`, so the
  claim is auditable on one screen.
- **Request bodies are capped** before any handler reads them
  (`server/api4.ts` `bodyLimits`): on a vault-only server 15MB for
  `PUT /api/vault` and 64KB for everything else — nothing but ciphertext is
  ever large there — and 20MB on a household server, whose imports carry
  whole statements (64MB for `POST /api/import`, a whole-database restore,
  which grows with the household's price history). Past the cap the answer
  is 413 and nothing is stored; the same goes for a vault blob past the 10MB
  payload cap (about 14MB of base64). (In front of all this, Cloud Run
  refuses any request body over 32 MiB.)
- **The basket rebuild is throttled.** `POST /api/basket/rebuild` stays on
  the vault-only list (it is the only way to rebuild there), but a build
  already running is joined rather than doubled, and a new one starts at most
  once per 15 minutes (429 otherwise). The server keeps the time of the last
  request (`basket:rebuild_requested_at`), which is infrastructure, never part
  of anyone's snapshot.
- **A session follows the other member's saves.** While a session's tab is
  visible it asks `GET /api/mode` every 45 seconds, and when the tab regains
  focus: about the vault, the answer is its version, when it was stored, by
  whom, and the SHA-256 of its ciphertext (a hash of what the same caller can
  download anyway); the rest is the caller's own routing (whose household it
  is in, invitations waiting for it) and the server's mode. Nothing is sent.
  If the version moved on and the tab has no unsaved work, the tab downloads
  the blob and opens it with the key it already holds, which authenticates
  the header and its sequence number and runs the same older-copy check as an
  unlock; passkeys another member added come along with the header. With unsaved work (or a save
  refused because the vault moved on) nothing is replaced: a banner and a
  sheet offer **Take theirs**, **Download mine** — an unencrypted JSON export
  of the tab, saved to this device only — and **Keep mine**, which the
  server's history makes safe: the other member's version stays kept. Keep mine reseals this tab's data under the key
  and header the other member's version was opened with, and is refused if
  the vault was re-keyed meanwhile: resealing under an old key would undo a
  rotation or a member's removal. Their version is judged against this
  device's memory first, like an unlock: an older copy than this device saw
  asks before anything is saved, and then keeps this tab's own header —
  never the older copy's, which would bring back a passkey removed since. A
  blob the tab's key no longer opens means exactly that re-keying, so the
  session locks and goes back to the front door — unless the tab was edited
  while the blob downloaded: then nothing ends until the person chooses (the
  sheet offers Download mine first; Take theirs locks).
- **A replaced vault is never overwritten by a tab of the old one.** Each
  upload names the blob it replaces (`baseSha256`, the SHA-256 of the stored
  ciphertext this tab last opened or saved), and `PUT /api/vault` refuses it
  (409) when the stored blob at that version is a different one — a vault
  deleted and created again, or restored, that has reached the same version
  number. The poll's hash lets the tab say so before it tries; a vault it can
  no longer open sends it back to the front door.
- **Who saved is recorded.** `PUT /api/vault` stores the caller's IAP
  identity with the version (`updated_by`) — an identity the server already
  sees on every request — and `GET /api/vault` and `/api/mode` return it to
  the household, so a tab can say "saved by nicole@…". The avatars come from
  the household's member list (`/api/vault/members`, already on the
  vault-only list), never from passkey labels.
- **Idle auto-lock is a setting of this device.** The Session card offers
  15 minutes, 1 hour, 4 hours or never (the default), kept in `localStorage`
  (`scarab:idle-lock`) and never sent anywhere. After that long without a key,
  pointer or scroll in the tab, the session saves what is unsaved and locks —
  the key leaves memory with the page, and the front door says why. It never
  locks over changes it couldn't save: a banner says why instead, and it tries
  again a minute later.
- **Another tab is noticed without the server.** Tabs of the same browser
  ping each other on a `BroadcastChannel('scarab-session')` carrying a random
  tab id and nothing else; the second tab to open a session is told that each
  tab holds its own copy. It never leaves the browser.
- **Addresses carry no household data.** Browsers sync full URLs, fragments
  included, to the signed-in account's history, so a Scarab address holds
  only screen ids, numeric ids, enums and months (`#/cash?cat=12&month=2026-08`).
  `formatRoute` (`src/router.ts`) refuses any value that isn't 1–24 letters,
  digits and dashes, and any fractional number, which keeps out search text
  and amounts; keeping tickers out is a rule of the code. Tickers, search
  text and selections ride in the history entry's state instead, which stays
  in this browser's own session history. What Scarab keeps in browser storage is
  bookkeeping, not household data: the `localStorage` keys named above
  (`scarab:seen:*`, `scarab:device-creds`, `scarab:recovery-owed:*`,
  `scarab:rotation-owed:*`, `scarab:idle-lock`) and, per tab, a lock note, a
  reload guard, the household-mode choice and the day prices were last
  refreshed (`sessionStorage`). The tab's database itself lives only in
  memory.
- **The front door never sends plaintext.** scarab.one opens to *unlock*
  (one passkey tap decrypts the stored ciphertext in the tab) or *start
  empty*; either way the engine runs in the browser and only ciphertext is
  ever uploaded (`PUT /api/vault`). Besides the ciphertext, an upload says
  only which stored version it replaces (its number and hash) and, when it
  applies, a pin or a request to purge the history.
- **Browser requirement.** Passkeys with the PRF extension: Chrome and Safari
  on current macOS, iOS, Android and Windows. A browser without it can open
  the vault only with the recovery code, and the front door says so.

**Runnable proof.** `npm run test:egress` (`e2e/egress.spec.ts`, run on every
push by `.github/workflows/egress.yml`) builds the app, starts the real
vault-only server and drives a whole session in headless Chromium with a
virtual passkey — create a vault, enter data on every screen that takes input,
let autosave run, reload, unlock, browse every screen plus the history and
both backups, and a holding's drawer (whose chart asks for a hashed bucket) —
while recording every request the browser makes. It then
asserts (a) every request was same-origin and either a static file or on the
`server/zk-routes.ts` allowlist, imported, not copied; (b) the only writes were
`PUT /api/vault`; (c) every upload opens with the recovery code to a snapshot
holding the test's canary data, and no canary — nor the code — appears in
clear in any request, in `localStorage` or in `sessionStorage`; (d) browsing
alone uploaded nothing and left the stored version where it was; (e) the
server's plaintext tables stayed empty. A screen that calls a plaintext route
fails it, naming the request — even though the server would have refused it.

## What the server still learns (honesty section)

Zero-knowledge is a statement about *content*, not existence. Even in ZK mode
the operator can observe:

- **Identity and timing**: who syncs, when, and blob sizes — rounded up to a
  size bucket by the v3 padding, so the server sees roughly how big a vault
  is (32 KiB minimum, then steps of an eighth of a power of two), and the
  header's length, which grows with each passkey (inherent to hosted sync). Autosave makes this finer-grained:
  a session uploads a fresh ciphertext 1.5 seconds after each burst of edits
  (at once when the tab is hidden), so the server sees when you are working,
  never what on. Browsing never uploads: a write that failed or changed
  nothing leaves the tab clean, and a save whose data equals what was last
  sealed sends nothing. While the server can't be reached the tab retries
  (2s, 5s, 15s, then every 60s, and at once when the browser is back online),
  so an outage shows up as repeated attempts. A refused save (409) carries
  the stored blob's SHA-256 — a hash of ciphertext the caller could download
  anyway — so a tab whose last upload got no response can recognise that it
  landed. Following the other member adds a heartbeat: a session's tab asks
  `/api/mode` every 45 seconds while it is visible (and on focus, never while
  hidden), so the server can tell when a session tab is open and in view —
  not what it shows — and it records which member stored each version. A
  re-key (rotation or removal) is visible as such: the upload asks for
  history to be purged, and the header's wrappings shrink to one. Vault
  history adds little it didn't see anyway (each kept version was once the
  stored one): opening the History card or a version is a request the
  server sees, and a pin says why a version is kept — that an upgraded
  snapshot was about to be rewritten, or that a restore happened. A restore
  itself is an ordinary upload; a backup file never reaches the server.
  Invitations are routing the server holds by necessity: who invited which
  email, and when (an email it would learn from IAP anyway once that person
  signs in). An answered or withdrawn invitation is deleted — the server sees
  the request, and keeps no record of a decline — and an accepted one becomes
  a membership row saying who invited them and when they joined. It keeps one
  waiting invitation per email and household (`vault_invites` is keyed on
  both): inviting the same person again refreshes that household's own
  invitation, and one from another household neither replaces it nor shows in
  its list. The invitee sees every one waiting, with who sent each, and
  answers each on its own; a household's invitation stands until the invitee
  answers it or the household withdraws it.
- **Open sign-up**: with `allAuthenticatedUsers` on the IAP policy
  (`scripts/open-signup.sh --open`; `--close` takes it back), any Google
  account can sign in to scarab.one and create a vault. The server, and
  Google's IAP in front of it, then learn every signer's email at their first
  sign-in — a stranger's as a member's — and from then on the identity and
  timing above. The two-person allowlist stays in the policy as a harmless
  subset, and the verifier service account (`scarab-verify`, PRIVACY.md "The
  trust root") is one more identity on it: an identity the operator already
  is, so opening adds no other. Anyone signed in can invite any email, so a
  stranger can invite you: the invitation waits at the front door, shows who
  sent it, and can be declined — the server deletes the row and keeps no
  record of the decline. What the server holds per vault stays bounded
  whoever creates one: a single blob capped at 10 MB (about 14 MB as base64;
  larger uploads are refused before anything is stored) with its pruned
  history (the last 20 versions, one a day for 30 days, up to 8 pinned,
  64 MB per household). The terms and privacy pages the front door's create
  step and Data & Vault → Advanced link to (`public/terms.html`,
  `public/privacy.html`) are static files of this origin — served, hashed and
  attested like the rest, no JavaScript — and say this in fewer words; they
  name the contact address (help.scarab.one@gmail.com)
  (the egress proof opens both and holds them to the same policy).
  `scripts/open-signup.sh --open` reads the live service's environment first
  and refuses unless `SCARAB_ZK_ONLY` is set there: a household-mode server
  has no gate of its own behind IAP, so opening IAP on one would hand every
  Google account the household's plaintext.
- **Request logs, and the one cookie**: the app logs no requests — only a
  handler's failure with its method and path (`server/http.ts`), and the
  boot lines. Google's infrastructure in front of it does: Cloud Run's
  request log carries each request's route, size, time, status and client
  address, and with Cloud Audit Logs on for IAP, the signed-in identity of
  each request too — as for any site behind IAP, in the operator's project.
  The app sets no cookies; the one cookie scarab.one leaves in a browser is
  IAP's sign-in session cookie, which Google sets and reads.
- **Quote symbols**: in household mode price fetches name the held symbols to
  the server (which already holds the ledger). In zero-knowledge mode the
  server instead publishes a **daily price basket** — the whole US-listed
  universe plus top crypto, fetched once and served identically to every
  client — and the browser picks its own symbols out locally. The request is
  the same for everyone, so it reveals nothing about the portfolio behind it;
  the residual is identity and timing (who fetched the basket, and when), not
  content. Symbol search runs over that same basket in the tab, so typing a
  ticker sends nothing. Each basket row carries the security's previous close
  beside its price — public market data, the same for everyone — so the tab
  works out the day's gain or loss on its own holdings locally; nothing new
  is asked of the server for it. A session's "prices as of" line asks when the basket
  was built (`/api/basket/status`, on entry and when the tab returns to view,
  at most every 30 minutes). Monthly history comes from the shared market
  history file (below), and a holding's daily price chart from the hashed
  symbol bucket its symbol falls in ("Daily history", below): the tab asks
  for one of 64 shared files, never for the symbol. A mutual fund the basket
  doesn't quote can be asked for — "Anonymous add", below: the request names
  it among 31 other funds, so the server learns one of 32, and when. Not
  covered, and not coverable this way: a collective investment trust, private
  stock or a plan-specific unit has no public price feed — they take a
  hand-entered price, kept with the rest of the household's encrypted data.
- **Bank sync (future)**: automatic SimpleFIN-style sync is fundamentally in
  tension with zero-knowledge — a server-side job would see plaintext
  transactions. ZK mode therefore ships with manual imports (client-side
  parsing) first; any sync feature will be client-initiated and labeled with
  exactly what it exposes.

## The trust root: served JavaScript

No architecture can *prove* a server runs the code in a repository. What ZK
mode does instead is make the server irrelevant to confidentiality — which
moves the entire trust root to the JavaScript served to the browser. That is
auditable, and this is what exists (since 2026-10-19):

1. **Open source** — this repository, AGPL-3.0.
2. **Reproducible builds** — `npm run build` is deterministic (a lockfile with
   an integrity hash for every package, no timestamps or absolute paths in the
   output) and ends by writing `dist/build.json`: the sha256 of every served
   file, with the commit, tag and repository it was built from
   (`scripts/build-manifest.mjs`). The release workflow
   (`.github/workflows/release.yml`) builds the app twice, on two runners, and
   fails unless the two manifests are byte-identical; it then builds the
   Docker image (`Dockerfile`, base images pinned by digest, Litestream by
   checksum) and fails unless the manifest inside the image is that same
   file. Every push to `main` runs all of this as a dry run.
3. **Build provenance attestations** — on a `v*` tag the workflow pushes the
   image to Artifact Registry through Workload Identity Federation (no key
   exists anywhere; the CI identity can push images and nothing else), signs
   SLSA provenance for the image digest *and* for `build.json` with Sigstore
   (`actions/attest-build-provenance`), checks both with `gh attestation
   verify`, and publishes a GitHub release with `build.json` attached.
   Deploying stays a human act: `./scripts/deploy.sh vX.Y.Z` verifies that
   the image's attestation names that tag and this workflow, then deploys by
   digest, never by tag and never from a laptop's working tree
   (`--source` remains only for the first deploy of a fresh project, and is
   labelled unattested everywhere it shows).
4. **Asset manifest, served and checkable** — the server serves `/build.json`
   as a static file, `/api/health` reports `build.commit`, and Data & Vault
   → Advanced → *Served code* shows the release and commit, linked to GitHub.
   `scripts/verify-served.sh` is the check, and it runs **outside the page**:
   it fetches scarab.one's `index.html` and `/build.json` through IAP as the
   verifier service account (`scarab-verify`, on the IAP allowlist like a
   member — IAP's Google-managed OAuth client takes no programmatic clients,
   but it accepts a service account's short-lived self-signed JWT, which only
   the operator's account may sign; `bootstrap-gcp.sh trust-chain` sets both
   up), verifies the release's `build.json` attestation, then
   downloads every file that manifest lists and compares hashes — the
   `index.html` included, so a shell that loaded any other script fails too.
   The server also sends a Content-Security-Policy on every response
   (`server/app.ts`): scripts, styles, fonts and every fetch from this
   origin only, the one inline style by hash, no framing — a bundle that
   tried to call home would be refused by the browser before a verifier
   caught it.

   **From your own browser** — `verifier/` is Scarab Verify, a Chrome
   extension (loaded unpacked from this repository, never from a store) that
   runs the same check from the vantage point the script lacks: your tab, your
   session. On scarab.one it records every file the page loads — the
   document, each script, stylesheet and chunk as screens open, the fonts, the
   wasm, the web manifest, with the byte counts the browser reports — reads
   the release tag from the site's `/build.json`, fetches that release's
   attested `build.json` from **this repository's GitHub release, an address
   fixed in the extension's code** (the site names a repository too, and it is
   ignored: a server that chose its own trust anchor could point at a fork
   whose release lists the hashes of whatever it serves), then re-fetches
   every recorded URL as you and hashes it with its own crypto. A green check
   on the toolbar names the release; a red cross names the files that differ
   or that the release does not ship; a grey question mark means nothing to
   check against; a site naming another repository gets a warning. What it
   proves is that what the site serves *right now*, to a request carrying your
   cookies from your browser, is the attested release — which catches a
   deployment that targets one person by identity, the gap the service-account
   script has. `verifier/README.md` says what it still cannot prove: its
   re-fetch is a second request that the browser marks as an extension's
   (`Sec-Fetch-Site: none`, no referrer), so a server keyed on those headers
   rather than on identity could answer it honestly; the byte-count comparison
   with what the page saw narrows that only weakly; the check is retrospective
   (a chunk has run by the time the badge turns red); the Sigstore attestation
   is not checked (the GitHub release is its anchor; `gh attestation verify`
   goes further); and it cannot tell an old attested release from the current
   one.

The exact commands, for anyone with a GitHub account and the GitHub CLI:

```
# The release's manifest was built by GitHub's runners from the tagged commit
# by .github/workflows/release.yml (the attestation is public):
gh attestation verify build.json --repo lincolnfrog/scarab

# The image a deploy will run (its digest is in the release notes); deploy.sh
# does this before every deploy:
gh attestation verify oci://<region>-docker.pkg.dev/<project>/scarab/scarab@sha256:… --repo lincolnfrog/scarab

# What scarab.one serves is that manifest, file by file (the operator, with
# gcloud signed in as the account allowed to sign for the verifier):
./scripts/verify-served.sh --tag vX.Y.Z

# Or rebuild the release yourself and compare the asset hashes:
git checkout vX.Y.Z && npm ci && npm run build && diff <(jq .assets dist/build.json) <(jq .assets build.json)
```

Residual risk, stated plainly:

- A malicious deployment could still serve a poisoned bundle, to everyone or
  to one targeted user. The chain makes that **detectable after the fact**,
  not impossible: the poisoned response either fails the manifest check or
  comes with a `build.json` that no public release attests. The script
  fetches as `scarab-verify`, not as you: a server that singled out one
  person's responses could still serve the verifier the honest files. The
  browser is the only vantage point that sees exactly what you get, so the
  check that catches that runs there: the Scarab Verify extension
  (`verifier/`), or by hand the procedure in the script's header —
  view-source, the asset URLs, your own hashing tools. Each member of the
  household should keep the extension on, or run the check now and then and
  after any deploy.
- The verifier must run outside the page. A malicious bundle can patch
  `fetch`, `crypto.subtle` and the DOM from inside the tab, so a "verify"
  button in the app would prove nothing; the script fetches the origin with
  its own HTTP client and hashes with its own tools.
- The attestations prove *what was built from which commit*, not that the
  source is good. The source is the audit; the chain only makes sure the
  audit and the deployment are about the same bytes.
- The Node base images and npm packages are pinned by digest, not rebuilt
  from source; Cloud Run, IAP and the browser are trusted as platforms.
- Users with the highest requirements should self-host (the repo deploys
  with two scripts) or run a verified local build.

## Data portability

The Data & Vault screen exports the complete database as one readable JSON
file — every transaction, trade, price, rule, and setting — and restores from
it. In a zero-knowledge session it also makes the encrypted `.scarab` backup
described above: the same data, sealed under the vault's key, for when a
plaintext file on disk is the wrong trade. No export gatekeeping, no format lock-in. Your data is yours; the export
is also your audit of what Scarab knows.

## Market history the server serves

A zero-knowledge tab can't ask Yahoo for its own symbols' history — the
browser blocks it, and a per-symbol request through the server would be the
portfolio. So the server publishes one more shared file, the basket's
companion: **`GET /api/basket/history`**, month-end closes over ten years for
every symbol in the daily basket (the whole US-listed universe plus the top
crypto), about 1.5 MB gzipped.

- **One file, the same bytes for everyone.** Every caller — any identity, on a
  household or a vault-only server — gets the identical file, with one ETag
  (a hash of the file) and a 304 when it is unchanged. The request carries no
  symbols and no parameters; the server does not read the caller's identity to
  answer it. `basket/history` is the one pattern this adds to the vault-only
  allowlist (`server/zk-routes.ts`); applying history (`POST
  /api/prices/history`) and every series route stay plaintext-only and get a
  403 there.
- **What the server learns** is that an identity downloaded the file, and
  when. A tab asks for it when a chart needs benchmarks (the series catalog
  or a `bench:` series) and after a price refresh when an asset it has traded
  (one the basket covers) has no price history yet — no close from before its
  first trade and none the file would have left at a finished month's end
  (refresh quotes don't count) — at most every 30 minutes (a minute while the
  file isn't ready), and then usually a 304. That says roughly "this household opened Compare" or "recorded a
  holding it has no price history for yet"; it never says which symbols.
- **What the tab does with it.** The file stays in the tab's memory.
  Benchmarks (`bench:SPY`, …) are read from it there and never enter the
  vault. The only copy into the vault is `POST /api/prices/history`, run in the
  tab: month-end closes (through the file's last complete month) for the
  assets this household has traded, and for no other symbol, written to its
  own price table so past months are valued at market instead of at cost. It
  never overwrites a price the household already has, and it leaves out an
  asset whose history is more than 2× away from the household's own latest
  price (a coin sharing a ticker, say), naming it instead. That one import
  becomes part of the next encrypted save; applying the same file again
  writes nothing, so it can't create a vault version on its own.
- **Where the server gets it.** From Yahoo's spark endpoint, 20 universe
  symbols per request — never a household's list. The build is throttled
  (one request every 1.5 s, at most 160 per run, runs at least 20 minutes
  apart, 640 a day; the first refusal pauses it until the next day), starts
  only when someone asks for the file (or a household server's series
  catalog) or when the scheduled crawl below asks, and never runs twice at
  once. It is rebuilt each month once a
  month has closed; in between, each daily basket build folds its quotes into
  the month in progress. Until the first build completes, the route answers
  202 with its progress, and a benchmark says why it is greyed out.
- **Who keeps it built.** Cloud Run gives the server CPU only while a request
  is open, so a build that outlives the request that started it crawls and
  dies with the idle instance — and nobody browsing keeps a request open for
  ~600 paced calls. So the build is driven by a schedule:
  `.github/workflows/history.yml` calls **`POST /api/basket/crawl`** every six
  hours during the first five days of a month (when a rebuild is due) and
  once a day otherwise, and the server runs the build *inside that request*
  for up to four minutes, saving progress, then answers with how far it got
  and when to call again (`retryAfter`); the job repeats until the file is
  current or the day's 640 calls are spent. The caller is a dedicated
  service account, `scarab-history`, on the IAP allowlist like a member
  (`scripts/history-sa.sh` creates it, once); the workflow signs in through
  Workload Identity Federation as the release workflow's `scarab-ci` and
  signs a ten-minute JWT as `scarab-history` — no key exists anywhere. What
  the server learns from it: that `scarab-history` called, and when (the
  schedule above, and a manual run of the workflow). The request carries no
  body the server reads and the answer is the build's public progress; the
  route is a trigger and idempotent — any member may call it, and a call
  when nothing is due, or too soon after a run, does nothing. `basket/crawl`
  is the pattern this adds to the vault-only allowlist. (The alternative,
  `--no-cpu-throttling` on the service, was not taken: it bills the instance
  for every idle minute, still loses the build when the instance scales to
  zero, and starts nothing by itself.)
- **Where it is kept.** In the server's `app_meta` under `basket:history:*`
  keys — shared infrastructure like the basket itself: never part of anyone's
  snapshot or export, and kept by the zero-knowledge purge.
- **Honest scope.** Monthly closes only (split-adjusted, no dividends).
  Opening-position lots still start on their as-of date by design; the file
  fills history for back-dated trades, benchmarks and price series. Symbols
  outside the basket universe get no history.

### Daily history

A holding's price chart wants daily closes, and one file of two years of
daily closes for the whole universe would be about 35 MB of JSON — too much
to download for one chart. So the daily history is dealt into **hashed
symbol buckets**, Safe-Browsing style: the tab asks for the bucket its symbol
falls in, never for the symbol — **`GET /api/basket/daily/:bucket`**
(`server/daily-buckets.ts`, served since 2026-10-20).

- **The deal.** `shared/buckets.ts` `dailyBucket`: the first 32 bits of
  SHA-1 over `kind:SYMBOL` (the basket's spelling), modulo **N = 64**. The
  same function runs on the server, which deals, and in the tab, which asks,
  and a test pins it: changing it moves every symbol to another file. The
  universe is the basket's — about 11,000 symbols (every US-listed stock and
  ETF, plus the top 500 crypto) — so a bucket holds **about 170 symbols**.
- **What a request reveals.** Opening a holding's chart asks for one bucket:
  the server learns that this identity's holding is one of that bucket's
  ~170 symbols. A household that opens the charts of *k* holdings reveals at
  most *k* bucket numbers, each with ~170 candidates; buckets are fixed, so
  asking again (a new session, another day) adds nothing. The honest limit:
  the 170 are not equally likely — a bucket that holds a famous fund was
  more probably asked for because of it than because of an obscure
  micro-cap, so an operator ranking by popularity does better than 1-in-170.
  The number is an anonymity *set*, not a probability. A symbol outside the
  universe (a private stock) still hashes to a bucket, which then carries
  nothing of it; the request reveals only that bucket. The sparklines and
  the holdings table ask for nothing: they draw what the tab has.
- **What the server learns**, then: that an identity asked for bucket *b*,
  and when — when a holding's drawer opens, at most every 30 minutes per
  bucket (a minute while the files aren't ready), and after that usually a
  304. Every caller gets the identical file for a bucket, with one ETag; the
  server does not read the caller's identity to answer. `basket/daily/[0-9]+`
  is the pattern this adds to the vault-only allowlist.
- **The files.** Two years of daily closes per symbol (`DAILY_YEARS`; the
  monthly file keeps the ten-year tail), each symbol one compact array on a
  calendar-day axis — `[offset, first, Δ, Δ, …]`, null on a day without a
  close — so a bucket is roughly 550 KB of JSON and 180 KB gzipped, and all
  64 about 35 MB in the server's `app_meta` under `basket:daily:*` keys:
  shared infrastructure like the basket, never part of anyone's snapshot or
  export, kept by the zero-knowledge purge.
- **What the tab does with it.** The file stays in the tab's memory
  (`src/local/routes-analytics.ts`), kept 30 minutes; the chart joins the
  bucket's closes with the basket quotes the tab has collected (today's,
  which the crawl hasn't seen yet) and the month-ends before the bucket's
  reach. **Nothing from a bucket is written to the vault**: the only price
  write from shared data remains the monthly import above, and it is
  unchanged.
- **Where the server gets it.** The same Yahoo spark endpoint as the monthly
  file, `range=2y&interval=1d`, 20 symbols a call, on **one shared budget**
  (`server/crawl-budget.ts`): one call every 1.5 s, 160 a run, runs 20
  minutes apart, **640 a day for both files together**, the first refusal
  pausing both until the next day. One crawl of the universe is about 600
  calls — a day's budget — and happens once, then again each month once a
  month has closed (a day the basket missed, split adjustments, the window
  moving on); between crawls each daily basket build folds its quotes into
  every bucket. The scheduled trigger (above) runs the monthly file first,
  then the buckets; wanting a bucket also starts or resumes the crawl on a
  server nothing schedules. Until the first crawl completes the route answers
  202 with its progress and the chart draws what the tab has.
- **Honest scope.** Daily closes, split-adjusted as of the crawl, no
  dividends. Between crawls the folded basket quotes are what the market
  printed: after a split the quotes drop to the new price while the crawled
  history before it stays unadjusted until the next monthly crawl — a cliff
  in the chart for up to a month, the same one the monthly file has between
  rebuilds.
- **Not done, and why.** Decoy buckets — a tab also fetching a few fixed
  buckets it has no holding in, chosen from a secret so the server can't
  tell them apart — would blur the *k* above; they need a per-vault secret
  the tab has only once a vault exists, and are left for later.

### Anonymous add

The basket's universe is the exchange directory, so a mutual fund — the
retirement-plan holding par excellence — has no quote and took a hand-entered
price. Widening the basket on request runs into the one fact this document
keeps returning to: **every request carries the IAP identity**, so a request
naming one fund ties that fund to the household. Nothing on the server's side
can undo that; the only tool is k-anonymity on the client's side, and it is
honest only if the k are drawn from the same population as the real one —
otherwise the real one stands out. That population exists, and is clean: the
SEC publishes every registered fund share class's ticker
(`company_tickers_mf.json`, EDGAR's mapping of series and classes to
symbols — a US government work, public domain). It is bundled as
`src/invest/fund-tickers.txt` (28,586 tickers, 166 KB, fetched 2026-10-20;
`scripts/fetch-fund-tickers.mjs` refreshes it, and its header says so), in a
chunk that loads only when the view opens.

- **The ask.** A holding's drawer offers *Ask the basket to cover this fund*
  only when the symbol is a registered fund's ticker that the basket doesn't
  quote (`src/invest/suggest.ts` `canSuggest`). The view
  (`#/invest/cover`; the symbol rides in route state, never the address)
  says in one line what the request does, and on a click schedules
  **`POST /api/basket/suggest`** naming the wanted fund among **31 others
  drawn from the same list** (`k = 32`; `src/invest/chaff.ts`), sent after a
  random wait of 30 seconds to ten minutes while the tab stays open — so
  the request doesn't trail the vault save that recorded the fund.
- **Which 31.** A draw seeded from the vault's data key and the symbol
  (SHA-256 over both, with a counter; `pickChaff`). Each draw is an index
  over the whole bundled list — never over a list filtered by what the
  basket quotes today — and a drawn symbol that is the wanted one, one the
  basket already quotes (no chaff: the server has it) or one drawn before is
  rejected and the next draw taken. So a change in the basket between two
  asks — an ETF listed or delisted, a fund someone else asked for since —
  swaps out at most the members it touches, one for one, never the whole
  set. Secret-seeded, so the server cannot run the draw for every fund and
  match the set it received — a draw seeded from the symbol alone would be
  exactly that lookup table. And asked for **once**: a sent ask is recorded
  with the household's data (`ui:basket-asks`, through
  `PUT /api/prices/asked` in the tab, so it rides the next save), and
  neither this device nor the other member's offers that fund again — a
  second request with a different list would name the fund by intersection.
  Before a vault exists there is no secret: the draw is random, and the
  memory is the tab's until a vault is created. A refreshed
  `fund-tickers.txt` is a new list and a new draw, which the memory covers
  too.
- **What the server does.** It keeps the request as one ask, its symbols
  together, in a plain list of asks, `basket:extra:asks` (`server/basket.ts`)
  — no identity, no time, nothing to tell the wanted one by. Every daily
  build quotes the asks' symbols with the universe (the fund's name comes
  from the quote source, since no directory lists it), and the monthly file
  and the daily buckets pick them up at their next crawls. A symbol Yahoo
  never quotes is **not** dropped on its own: which of an ask's symbols
  survived would be a record of which were real, so an ask stays whole until
  the list's cap (4,000 symbols) forces the oldest asks out, whole. The route
  refuses a request naming fewer than two or more than 64 symbols and takes
  one request a minute from everyone together (a brake that records the time
  of the last request and nothing else). Its answer says how many of the
  symbols were new to the list, not which. `basket/suggest` is the pattern
  this adds to the vault-only allowlist.
- **What the server learns — the residual, exactly.** That this identity
  named one of these 32 registered funds, and when. Not which: the request
  gives it no way to tell, and nothing it stores helps later. Two honest
  limits on the "one of 32". First, the 32 are not equally likely to an
  operator who knows which funds are popular: a famous fund among obscure
  share classes stands out, so the anonymity set is strongest for exactly the
  institutional and retirement classes that need this path most (the basket
  already quotes everything exchange-traded), and weakest for a household
  name. Second, once the fund is quoted it is in the basket for everyone,
  and a household's later requests — the basket, a bucket — are the same as
  anyone's; but the operator who saw the ask can watch for *that* fund's
  bucket being fetched by *that* identity later, which narrows 32 toward
  one over time. (Decoy buckets, above, would blunt this too.) Third, the
  chaff is drawn from the SEC's whole list, most of which Yahoo may not
  quote, while the wanted fund is quotable by construction; after the next
  build the public basket shows which of the 32 got a quote, and *that*
  subset — not 32 — is the real set. The server keeps no second copy of it
  (asks stay whole, above), but the basket is for everyone to read. Every
  household that holds a fund someone already asked for pays nothing: it is
  simply in the basket.
- **The alternative, and why not now.** Putting the whole SEC list in the
  basket would make the ask unnecessary and leak nothing — the strongest
  answer. It is also about three times the basket (28,586 more symbols,
  most of them dead or institutional classes Yahoo may not quote), three
  times the monthly file a tab downloads for benchmarks (~4.5 MB gzipped),
  three times the crawls (two more days of budget a month), and 150 more
  quote calls a day. If the file sizes stop mattering, that is the path to
  take, and the suggest route goes with it.
