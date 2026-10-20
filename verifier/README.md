# Scarab Verify

A Chrome extension (Manifest V3, loaded unpacked, never from a store) that
checks that the page scarab.one serves *you* is the release this repository
attested — from your own browser, with your own session. It is the browser-side
half of the trust chain in PRIVACY.md ("The trust root: served JavaScript"):
`scripts/verify-served.sh` checks the site from outside, as a verifier service
account; this checks it from the browser that got the page.

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
   the browser reported, and whether the document's load event has fired.
   It fetches nothing and hashes nothing: a page can patch its own `fetch`
   and `crypto.subtle`, so nothing inside the page is trusted to check the
   page.
2. **The service worker learns which release the site claims to be**
   (`src/worker.ts`): `GET <origin>/build.json`, with your cookies and
   `cache: no-store`. That file is the build manifest the server serves
   (`scripts/build-manifest.mjs`): `{ repo, commit, tag, assets }`. The only
   thing used from it is the **tag** — which release to compare with — and
   the popup shows it. The `repo` field is *not* used: see the next step.
3. **It fetches the attested manifest for that release from the repository
   fixed in the extension.** For scarab.one that is
   `https://github.com/lincolnfrog/scarab/releases/download/<tag>/build.json`
   (`PINNED_REPO` in `src/verify.ts`), the file
   `.github/workflows/release.yml` built twice, attested with Sigstore and
   attached to the release — an origin the site cannot answer for. The
   repository is **never read from the site**: a compromised server could
   otherwise serve a poisoned bundle together with a `build.json` naming a
   fork whose release lists the poisoned hashes, and the badge would go
   green. No setting can move it for scarab.one either; a self-hosted origin
   gets its repository (or manifest address) from what *you* type when you
   add it. A site whose `build.json` names another repository is still
   checked against the configured one, and the badge title and the popup
   carry a warning saying so. No cookies go to GitHub.
4. **It re-fetches every recorded URL** as the page would (your cookies,
   `cache: no-store`), hashes the bytes with SubtleCrypto SHA-256 and compares
   with the attested manifest (`src/verify.ts`): the document against
   `index.html`, every other URL against its path under `dist/`. A file whose
   hash differs is a **mismatch**; a file the manifest does not list is
   **not in release** (the headline attack: one extra script); a listed file
   that the server answers with the shell is **missing**; a file whose hash
   is right but whose byte count differs from what the page received is
   **size differs** (a weak signal: see below). No `/build.json`, a site
   that names no release, or a release with no manifest attached is
   **unverifiable**: nothing proven, which is not the same as wrong. So is a
   page of the server rather than of the app (`/api/health`, `/build.json`
   opened directly).

Nothing is green before the document's load event: the first reports carry
the shell alone, and a check that said ✓ on those would be vouching for
chunks it had not seen. Until a report made after the load event has been
judged, the badge stays at "checking"; a failure shows at once.

The verdict is on the toolbar badge — a green check (the release and commit in
the tooltip), a red cross, a grey question mark — and in the popup: the
repository it was checked against, the release and commit, linked (to the
configured repository only, never to an address from the site); the attested
manifest, linked; any warning; a table of every file with the bytes the page
saw, the bytes the re-fetch returned and its status; the time of the last
check; **Check again**, which asks the page for its current list and fetches
everything afresh. A new document (a reload, a navigation) starts over; a
screen opened within the app extends the running check with its own chunks.

## What this proves, and what it catches that `verify-served.sh` cannot

What it proves is this: **what the site serves, right now, to a request that
carries your cookies and comes from your browser, is the attested release**.
The script fetches scarab.one as the `scarab-verify` service account, so a
deployment that singled out one member's responses *by identity* — a poisoned
bundle for them, the honest files for everyone else, the verifier included —
would pass it. That is the gap this closes: the re-fetches are made as you.

## What it still cannot prove

- **The re-fetch is a second request, and it is distinguishable from the
  page's.** The browser marks it: `Sec-Fetch-Site: none`,
  `Sec-Fetch-Dest: empty`, `Sec-Fetch-Mode: cors`, no `Referer`, where the
  page's own loads carry `same-origin`, `script`/`style`/`document` and the
  referrer. An extension cannot change those headers. A server keyed on
  *identity* is caught; a server keyed on *those headers* — poison the
  response whose `Sec-Fetch-Dest` is `script`, answer the extension's
  honestly — is not. The byte-count comparison (what the page's resource
  timing reported against what the re-fetch returned) narrows this only
  weakly: padding a poisoned file to the attested length is a comment away,
  so treat "size differs" as a bonus catch, not a guarantee. What the page
  actually received is seen by nothing but the page.
- **The check is retrospective.** A chunk has run by the time the badge can
  turn red. The extension tells you *that* you were served something else,
  after the fact; it does not stop it. (Scarab's CSP keeps a served bundle
  from calling home, which bounds what a poisoned chunk can do; PRIVACY.md
  has that argument.)
- **It does not verify the Sigstore attestation.** The GitHub release is its
  trust anchor: it believes the `build.json` attached to the release is the
  one CI built. To go further, from any machine with the GitHub CLI:

      gh attestation verify build.json --repo lincolnfrog/scarab

  which proves that file was built by `.github/workflows/release.yml` from
  the tagged commit. The popup links the manifest it used.
- **It does not know whether the release is the latest.** The tag is the one
  thing it takes from the site, and only to pick which release to compare
  with: a server that serves an older attested release, honestly labelled,
  is green. The badge and the popup name the release; the releases page says
  which is current.
- **It checks what the page loaded, not what the code does.** The source is
  the audit; this only makes sure the audit and the page are about the same
  bytes. Code the page computes at run time came from a checked file.
- **It trusts the browser, GitHub and itself.** Another extension with host
  permissions on scarab.one could alter responses the page sees; a browser
  can be compromised; the extension you load is the code you read in `src/`
  (there is no bundler, and `npm run build:verifier` is `tsc` plus a copy).
- **Signed out, it proves nothing.** A sign-in redirect on a re-fetch is
  reported as unreachable and the verdict is unverifiable, not green.

## What sticks, and what is retried

A result stands for the document: a file that could not be re-fetched once
(the network dropped, the session expired) stays "unreachable" — and the page
unverifiable — until **Check again** or a reload, which fetch everything anew.
A report the content script could not deliver because the worker was asleep
or being updated is sent once more a second later; after that, the next
report (a screen opening) or **Check again** carries the full list. A tab
that leaves the origin while a check is running is cleared, and that check
writes nothing back.

## What the operator's server sees

The extension's requests are the page's requests again: `GET /build.json`
once per page load, then one `GET` per file the page loaded (the document and
every asset: the front door is about 20 files and 600 KB; a session that
opens every screen and the in-tab database approaches the whole build, about
2 MB), each with the same cookies the page sends — so the same IAP identity,
the same `x-goog-authenticated-user-email` on the server's side — and
`Cache-Control: no-store`, marked as described above (`Sec-Fetch-Site: none`).
Each URL is fetched once per document; a screen opened later adds only its
chunks; **Check again** fetches everything again. One request goes to GitHub
per page load (the release asset), without cookies. Nothing is sent anywhere
else; the results live in the browser's session storage and vanish when it
closes.

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
the popup) and add your site's origin, e.g. `https://scarab.example`, with
where its attested manifests come from: its GitHub repository
(`https://github.com/you/scarab`, whose releases carry `build.json` as this
repository's do), or, for releases that are not on GitHub, the address of the
manifests with `{tag}` standing for the release tag
(`https://releases.example/{tag}/build.json`). One of the two is required —
the extension never takes the source from the site. Chrome asks you to grant
that host; the extension then runs on it. scarab.one itself cannot be added
or changed: its repository is fixed in the code.

## Tests

- `npm test` runs `src/verify.test.ts` with the repository's vitest: the
  manifest parsers; the manifest address coming from the setting and never
  from the site; URL → path mapping (the hashed `/assets/` paths, the root
  document, the web manifest and icons, a page of the server); each file's
  judgement; the page's verdict, including that nothing is green before the
  document has loaded; the settings, including that nothing stored can move
  scarab.one's anchor.
- `npm run test:verifier` runs `e2e/verifier.spec.ts` with Playwright: the
  built app served by `dist-server/index.js` as scarab.one runs it, the
  attested manifest served from a second local origin standing in for the
  GitHub release, and the extension loaded unpacked into a persistent
  Chromium context. Green on the untouched build (every file the page loaded,
  byte counts agreeing); no green before the page has loaded, with its entry
  chunk held back; a tab that leaves the origin mid-check cleared, with the
  check writing nothing back; a site naming another repository still checked
  against the configured one, with the warning; `/api/health` opened directly
  as nothing to check; red with a script the release does not ship; red
  after one asset is tampered with on disk, caught by **Check again** and by a
  fresh load; grey once `build.json` is gone. `VERIFIER_SKIP_BUILD=1` reuses
  an existing app build.

## Files

| file | what |
| --- | --- |
| `src/verify.ts` | the comparison, pure: manifests, the pinned repository, paths, judgement, verdict, settings |
| `src/content.ts` | records what the page loaded (no imports: a classic script) |
| `src/worker.ts` | fetches, hashes, compares; one queue per tab; badge and session state |
| `src/popup.ts`, `static/popup.html` | the result for the current tab |
| `src/options.ts`, `static/options.html` | the origins to check and their sources |
| `src/origins.ts` | settings storage and the registered content scripts |
| `src/chrome.d.ts` | the slice of the Chrome API used, typed by hand |
| `static/manifest.json` | permissions: `storage` (settings), `scripting` (the content script for a self-hosted origin is registered at run time); hosts: scarab.one, GitHub's release-asset path and its download CDN |
| `build.mjs` | `tsc`, copy `static/`, draw the icons |
| `e2e/` | the Playwright check |
