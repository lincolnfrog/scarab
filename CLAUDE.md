# Scarab — project conventions

Private 2-user household finance app. Cloud Run + IAP, SQLite +
Litestream, React + TS + Vite client, Hono server. See DESIGN.md for the
architecture map, data model and roadmap; PRIVACY.md for what the server sees.

**Design spec**: the interactive mockup artifact —
https://claude.ai/code/artifact/120f3c00-029a-4a63-bc14-139bbb6468ec
Match it when building screens (layout, copy tone, chart anatomy).

## Hard rules

- **`engine/` is isomorphic.** It runs in Node and the browser byte-for-byte:
  no `node:*` imports, no `fetch` to CORS-blocked hosts, sync code only
  (WebCrypto's async digest is why `engine/hash.ts` exists). Database access
  goes through the `DbLike` seam (`engine/db.ts`); better-sqlite3 and sql.js
  must stay interchangeable — `engine/parity.test.ts` and the per-area
  `parity-*.test.ts` suites (on `engine/test/parity.ts`) enforce it.

- **Money is integer cents** (`shared/money.ts`). Floats never touch monetary
  values — not in the DB, the API, or app state.
- **Migrations are append-only** — the `migrations` array in
  `engine/migrations.ts`. Never edit a shipped entry.
- **Snapshots hold household data only.** `engine/snapshot.ts` TABLES excludes
  the courier's tables (`vault_blobs`, `vault_history`, `household_members`,
  `vault_invites`) and the shared price data (`basket_quotes`, `basket:*` keys
  in app_meta, which include the market history). Don't add them back.
- **Single writer**: Cloud Run runs with `--max-instances 1` (SQLite). Don't
  "fix" that flag.
- **No auth code in the app.** Identity is IAP's header
  (`x-goog-authenticated-user-email`); dev fallback is `dev@localhost`.
- **`SCARAB_ZK_ONLY=1` is the vault-only server.** `server/zk-routes.ts`
  (re-exported by `server/app.ts`) is the complete list of what it answers;
  every new route is plaintext-only unless it is deliberately added there, and
  adding one means saying in PRIVACY.md what the server then sees.
- **The tab answers the same API.** Local mode serves every `/api` route but
  the network-only `/vault`, `/basket` and `/mode` from
  `src/local/routes-{core,invest,analytics}.ts`, each calling the
  same engine function as its server route; `src/local/drift.test.ts` fails
  when the two tables disagree. A tab write is `'auto'` (dirty only if the DB
  changed) unless it is read-like or public quotes (`'never'`): browsing must
  never create a vault version.
- **URL fragments carry only screen ids, numeric ids, enums and YYYY-MM
  months** — never tickers, search text or amounts (browsers sync fragments to
  account history). Those go in route state (`useRouteState`). `formatRoute`
  throws in dev on anything but 1–24 letters, digits and dashes, or on a
  non-integer number; it can't tell a ticker from an enum, so that part is on
  you.
- **UI goes through the `src/ui` primitives** — Dialog/Drawer, `confirm()` /
  `prompt()`, Field + Money/Percent/Qty/DateInput, Toast, `useAction`,
  Tooltip, Popover, Menu, Segmented, Skeleton, EmptyState, HeaderSlot. No
  native `confirm`/`prompt`/`alert`, explanations in Tooltip rather than
  `title=`, and no mutation without `useAction` (busy state + toast). Motion
  uses the `--dur-*`/`--ease-*` tokens and honours reduced motion.
- **Derived numbers come from the ledger.** Store facts (transactions, lots,
  valuations); compute charts/balances from them, never store both.

## Design tokens (source: mockup, `src/styles.css`)

- Surfaces: page #0a0d12 · plane #0e1219 · card #161b24. Ink #f2efe6/#a8adb8/#828893 (ink-3 ≥4.5:1 on card).
- Accent gold #e3b23c (nav/CTAs/goal only). Status: up #34c77b, down #e5605c —
  reserved for gains/losses, never series colors.
- Chart series, fixed order (CVD-validated on #161b24 — don't restep):
  s1 gold #bd8a26 · s2 lapis #5b8def · s3 malachite #24a06e · s4 amethyst
  #8f7fe8 · s5 carnelian #d95f42 · s6 faience #2b9cb8.
- Type: Marcellus (display, bundled woff2) · system sans (UI) · ui-monospace
  with tabular-nums for number columns.
- Charts are hand-rolled SVG (no chart library); crosshair+tooltip on
  line/area, per-mark hover on bars; legends whenever ≥2 series.

## Commands

- `npm run dev` — server :8787 + Vite :5173 (proxied /api)
- `npm test` / `npm run typecheck` / `npm run build`
- `./scripts/deploy.sh` — deploy (needs `.env.gcp` from bootstrap)
