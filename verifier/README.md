# Scarab Verify

A Chrome extension (Manifest V3, loaded unpacked, never from a store) that
checks that the page scarab.one serves *you* is the release the repository
attested — from your own browser, with your own session. It is the browser-side
half of the trust chain in PRIVACY.md ("The trust root: served JavaScript"):
`scripts/verify-served.sh` checks the site from outside, as a verifier service
account; this checks it from the one vantage point that sees exactly what you
get.

## What it does

On a configured origin (scarab.one by default; a self-hosted install is added
in its settings), for every page load:

1. **The content script records what the page loads** (`src/content.ts`): the
   document itself, every `script[src]`, `link[rel=stylesheet]`,
   `link[rel=modulepreload]` and the web manifest link as they appear in the
   DOM (a MutationObserver), and everything the document fetches from its
   origin as reported by resource timing (a PerformanceObserver, buffered, so
   it sees what arrived before the script ran and what a screen loads an hour
   later: the app is a code-split Vite build, and chunks, the sql.js wasm
   and the fonts arrive as screens open). For each it keeps the byte count
   the browser reported. It fetches nothing and hashes nothing: a page can
   patch its own `fetch` and `crypto.subtle`, so nothing inside the page is
   trusted to check the page.
2. **The service worker learns which release the site claims to be**
   (`src/worker.ts`): `GET <origin>/build.json`, with your cookies and
   `cache: no-store`. That file is the build manifest the server serves
   (`scripts/build-manifest.mjs`): `{ repo, commit, tag, assets }`.
3. **It fetches the attested manifest for that release from GitHub**:
   `<repo>/releases/download/<tag>/build.json`, the file
   `.github/workflows/release.yml` built twice, attested with Sigstore and
   attached to the release — a different origin, one the site cannot answer
   for. No cookies go to GitHub.
4. **It re-fetches every recorded URL** as the page would (your cookies,
   `cache: no-store`), hashes the bytes with SubtleCrypto SHA-256 and compares
   with the attested manifest (`src/verify.ts`): the document against
   `index.html`, every other URL against its path under `dist/`. A file whose
   hash differs is a **mismatch**; a file the manifest does not list is
   **not in release** (the headline attack: one extra script); a listed file
   that the server answers with the shell is **missing**; a file whose hash
   is right but whose byte count differs from what the page received is
   **size differs** (see below). No `/build.json`, a site that names no
   release, or a release with no manifest attached is **unverifiable**:
   nothing proven, which is not the same as wrong.

The verdict is on the toolbar badge — a green check (the release and commit in
the tooltip), a red cross, a grey question mark — and in the popup: release and
commit, linked to GitHub; the attested manifest, linked; a table of every file
with the bytes the page saw, the bytes the re-fetch returned and its status;
the time of the last check; **Check again**, which asks the page for its
current list and fetches everything afresh. A new document (a reload, a
navigation) starts over; a screen opened within the app extends the running
check with its own chunks.

## What this catches that `verify-served.sh` cannot

The script fetches scarab.one as the `scarab-verify` service account. A
deployment that singled out one member's responses — a poisoned bundle for
them, the honest files for everyone else, the verifier included — would pass
it. The extension asks for the files with *your* session, from *your* browser,
right after *your* page got them, and it compares what it gets with what the
page reported receiving. A targeted response is what it exists to catch.

## What it still cannot prove

- **The re-fetch is a second request.** The server answered the page once and
  the extension once, and nothing forces the two answers to be the same. The
  extension narrows this: it compares the list of URLs the page loaded with
  what it re-fetched (a file the page loaded that the release does not ship
  fails whatever the re-fetch of the others says), and the byte count the
  browser reported for each file with the length of the re-fetched bytes —
  so a server that wanted to fool it would have to answer the page with
  different code of exactly the same length as the attested file, for every
  file it swapped. That is a narrower hole, not a closed one; the content
  of the first response is never seen by anything but the page. Closing it
  needs the browser itself (Subresource Integrity on every script would do
  it for the shell's own references; the browser's own hashing of every
  response is not something an extension can read).
- **It does not verify the Sigstore attestation.** The GitHub release is its
  trust anchor: it believes the `build.json` attached to the release is the
  one CI built. To go further, from any machine with the GitHub CLI:

      gh attestation verify build.json --repo lincolnfrog/scarab

  which proves that file was built by `.github/workflows/release.yml` from
  the tagged commit. The popup links the manifest it used.
- **It does not know whether the release is the latest.** A server that
  serves an older attested release, honestly labelled, is green. The badge
  and the popup name the release; the releases page says which is current.
- **It checks what the page loaded, not what the code does.** The source is
  the audit; this only makes sure the audit and the page are about the same
  bytes. Code the page computes at run time came from a checked file.
- **It trusts the browser, GitHub and itself.** Another extension with host
  permissions on scarab.one could alter responses the page sees; a browser
  can be compromised; the extension you load is the code you read in `src/`
  (there is no bundler, and `npm run build:verifier` is `tsc` plus a copy).
- **Signed out, it proves nothing.** A sign-in redirect on a re-fetch is
  reported as unreachable and the verdict is unverifiable, not green.

## What the operator's server sees

The extension's requests are the page's requests again: `GET /build.json`
once per page load, then one `GET` per file the page loaded (the document and
every asset: the front door is about 20 files and 600 KB; a session that
opens every screen and the in-tab database approaches the whole build, about
2 MB), each with the same cookies the page sends — so the same IAP identity, the same `x-goog-authenticated-user-
email` on the server's side — and `Cache-Control: no-store`. Each URL is
fetched once per document; a screen opened later adds only its chunks;
**Check again** fetches everything again. One request goes to GitHub per page
load (the release asset), without cookies. Nothing is sent anywhere else; the
results live in the browser's session storage and vanish when it closes.

## Loading it

It is not published to the Chrome Web Store, and will not be: the point is to
load code you can read.

1. Build it: `npm run build:verifier` (TypeScript → `verifier/dist/`; the
   icons are drawn by the build, so the repository holds no binaries).
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click
   **Load unpacked**, and choose `verifier/dist`.
3. Pin **Scarab Verify** to the toolbar (the puzzle-piece menu).
4. Open scarab.one. The badge shows `…` while it checks, then `✓`, `✕` or `?`.
   Click it for the details.

Chrome 110 or newer. After pulling a new version of this repository, build
again and click the reload arrow on the extension's card.

### A self-hosted Scarab

Open the extension's settings (right-click its icon → Options, or the link in
the popup) and add your site's origin, e.g. `https://scarab.example`. Chrome
asks you to grant that host; the extension then runs on it. Leave the manifest
address empty if your site's `/build.json` names a GitHub repository whose
releases carry `build.json` (as this repository's do). If your releases live
elsewhere, give the address of the attested manifest with `{tag}` standing for
the release tag — `https://releases.example/{tag}/build.json`.

## Tests

- `npm test` runs `src/verify.test.ts` with the repository's vitest: the
  manifest parsers, URL → path mapping (the hashed `/assets/` paths, the root
  document, the web manifest and icons), each file's judgement and the page's
  verdict.
- `npm run test:verifier` runs `e2e/verifier.spec.ts` with Playwright: the
  built app served by `dist-server/index.js` as scarab.one runs it, the
  attested manifest served from a second local origin standing in for the
  GitHub release, and the extension loaded unpacked into a persistent
  Chromium context. Green on the untouched build (every file the page loaded,
  byte counts agreeing); red with a script the release does not ship; red
  after one asset is tampered with on disk, caught by **Check again** and by a
  fresh load; grey once `build.json` is gone. `VERIFIER_SKIP_BUILD=1` reuses
  an existing app build.

## Files

| file | what |
| --- | --- |
| `src/verify.ts` | the comparison, pure: manifests, paths, judgement, verdict, settings |
| `src/content.ts` | records what the page loaded (no imports: a classic script) |
| `src/worker.ts` | fetches, hashes, compares; badge and session state |
| `src/popup.ts`, `static/popup.html` | the result for the current tab |
| `src/options.ts`, `static/options.html` | the origins to check |
| `src/origins.ts` | settings storage and the registered content scripts |
| `src/chrome.d.ts` | the slice of the Chrome API used, typed by hand |
| `static/manifest.json` | permissions: storage, scripting; hosts: scarab.one, GitHub and its release CDN |
| `build.mjs` | `tsc`, copy `static/`, draw the icons |
| `e2e/` | the Playwright check |
