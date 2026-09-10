# Scarab — design document

Private household finance, built ledger-first, evolving into a zero-knowledge
public service (scarab.one). This document is the map: what exists, why it's
shaped this way, and what remains. Companion documents: `PRIVACY.md` (the
privacy architecture and its honest limits), `README.md` (quickstart),
`CLAUDE.md` (hard rules for anyone — human or model — writing code here).

## 1. Product

Six screens: **Dashboard** (net worth hero, allocation, activity),
**Investments** (lots, RSUs, tax picture, detailed charts), **Real estate**
(valuations, mortgages, equity), **Cash & budget** (imports, categorizer,
plan-vs-actual), **Dream Home** (down-payment fund, loan options, payment
matrix, rental scenario, tax gross-up, carry-vs-payoff), **Future** (Monte
Carlo over the real balance sheet), plus **Data & Vault** (export/import,
encrypted vault, local mode).

Two deployment modes, one codebase:

- **Household mode** (running today): Cloud Run + Identity-Aware Proxy, IAM
  allowlist of the household's Google accounts, server-side SQLite with
  Litestream replication to GCS. Zero auth code — identity is IAP's
  `x-goog-authenticated-user-email` header.
- **Zero-knowledge mode** (scarab.one, in progress): the same app runs
  entirely in the browser; the server stores only client-encrypted blobs.
  Deployment insight: scarab.one is this exact stack with IAP set to
  `allAuthenticatedUsers` — any Google account signs in, the server routes
  their ciphertext by email, and there is still no auth code.

## 2. Architecture

```
src/        React screens (Vite). Screens call get/post('/api/…') and do not
            know which universe answers.
src/api.ts  The switch: local mode on → src/local.ts dispatcher; else fetch.
src/local.ts  Per-tab local mode: sql.js database + a routing table mapping
            /api paths to engine/services. /api/vault passes through to the
            network — the encrypted courier channel.
engine/     THE CORE. Isomorphic: runs byte-identical in Node and browsers.
  db.ts        DbLike — 4-method seam (prepare/exec/transaction/pragma).
  migrations.ts  Append-only migrations array + migrate().
  import.ts    Statement parsing (WF CSV, generic CSV w/ debit-credit
               magnitudes, OFX), dedupe (FITID or sha1+ordinal), categorizer
               (longest-pattern rules), merchant extraction, transfer-pair
               detection.
  repairs.ts   One-off boot repairs (guarded by app_meta keys) + retroactive
               rule application.
  lots.ts      FIFO/specific-lot/explicit-basis engine, ST/LT splits.
  networth.ts  Month-end series derived entirely from dated facts.
  simulate.ts  Seeded Monte Carlo (mulberry32 + Box-Muller): lognormal or
               historical block-bootstrap draws, dated events, crossing year,
               price-a-decision.
  history.ts   Annual US stock real total returns 1928→ (Damodaran nominal ÷
               CPI-U). Append-only; refresh yearly.
  scenarios.ts The decision engine: named knob-sets compared side by side
               against the ledger; deltas vs the baseline.
  services.ts  Every API handler body as (db, args) functions. ApiError(status).
  snapshot.ts  Dump/load of all tables — THE interchange format (export files,
               vault payloads, local-mode hydration).
  sqljs-db.ts  sql.js adapter for DbLike.
  hash.ts      Synchronous SHA-1 (WebCrypto is async; node:crypto isn't in
               browsers). Parity-tested against node:crypto.
server/     Node-only shell.
  db.ts, migrations.ts  better-sqlite3 openDb + migrate.
  api.ts api2.ts api3.ts  Thin Hono wrappers over engine/services.
  api4.ts     Vault blob store + export/import endpoints.
  api5–8.ts   Tax, digest/recurring, scenarios, and the ZK front door + price
              basket — each a thin wrapper over one engine/service module.
  basket.ts   The daily price basket: the whole US-listed universe + top crypto,
              quoted once a day and served identically to every caller, so a
              local/ZK session refreshes prices without revealing holdings.
  prices.ts charts.ts  Network fetchers (Yahoo, CoinGecko, bitcoin-data.com,
              alternative.me) — fetching stays server-side so engine/ is
              CORS-clean; results are written via services and cached in
              SQLite with once-per-day app_meta flags.
  index.ts    IAP identity middleware, boot repairs, transfer sweep, static
              serving (index no-cache, hashed assets immutable — deploys must
              never strand stale bundles).
shared/     money.ts (integer cents, string-math parsing; micro-share
            quantities), vault.ts (envelope encryption), series.ts (SMA,
            tax gross-up), types.ts.
```

**Testing**: vitest, ~120 tests. The two structural ones: `engine/parity.test.ts`
runs the full import→repair→transfer→networth pipeline on better-sqlite3 AND
sql.js and demands identical output; `engine/hash.test.ts` pins sha1 to
node:crypto. Everything else covers parsers, lots edge cases (365-day
boundary, oversells, specific lots), vault crypto (tamper, wrong passphrase),
money parsing, simulation determinism.

## 3. Data model (migrations 1–10)

Ledger philosophy: **store dated facts, derive everything**. Transactions,
trades, prices, valuations, balances are facts; balances sheets, charts, cost
basis, and net worth are always computed. Never store a derivable number.

1. `app_meta` — also hosts one-off repair flags and fetch-freshness flags.
2. Cash: accounts (opening_cents anchors flows to reality), categories,
   imports, transactions (dedupe_hash unique per account), rules, budgets.
3. Investments/property: invest_accounts (lots- or balance-tracked), assets,
   trades (qty in **micro-shares**, integer), prices (monthly closes),
   balance_snapshots, properties, property_valuations, liabilities,
   liability_balances.
4. rsu_vests (superseded by 6; kept append-only).
5. trades gains sold_lot_trade_id / acquired_on / basis_cents — specific-lot
   and explicit-basis sells.
6. unvested_positions — one running unvested count per account+asset.
7. Household categories (Gardening/Alcohol/Pets/Taxes) + merchant rules;
   card-payment patterns file as Transfer.
8. goal_settings (JSON blobs) + loan_options; brokerage ACH files as Transfer
   (moving your own money is not income).
9. prices_daily + onchain_daily (integer units: realized_price→cents,
   mvrv→millionths, fear_greed→0-100).
10. vault_blobs — ciphertext per owner_email, optimistic-concurrency version,
    sha256, 10MB cap.

Money invariants: **integer cents everywhere**; parsing is string math
(`parseMoney` handles commas-only-in-thousands, accounting parens);
quantities are integer micro-shares (1e6 = one share); rates are micro
(1e6 = 100%). Floats only at two boundaries: external quote APIs (converted
to cents once at ingestion) and Monte Carlo internals (projections, rounded
at the edge).

## 4. Load-bearing design decisions

- **Single writer**: `--max-instances 1` because SQLite. Do not "fix".
- **Uncategorized money never disappears** — it surfaces as explicit rows so
  every card agrees with every other card by construction.
- **Categorizing one transaction files the merchant**: server derives a rule
  via `extractMerchant` (strips bank boilerplate), upserts, sweeps
  non-manual rows. Manual picks are never overridden. Transfer pairs are
  protected from sweeps.
- **Transfer detection**: equal-and-opposite amounts, different accounts,
  ≤3 days, greedy one-to-one, never overrides manual. Runs at boot and after
  imports (idempotent).
- **RSUs**: a vest is a buy at vest-day value (that IS the basis). Unvested
  units are future compensation — shown with market value, excluded from net
  worth.
- **Sell basis resolution**: explicit (acquired_on+basis_cents, for
  pre-Scarab history) > specific lot (sold_lot_trade_id) > FIFO. Selling an
  unopened/future lot degrades to zero-basis + a visible warning, never
  silent corruption.
- **Prices**: current quotes + once-per-asset monthly backfill (without it,
  history values at cost and the net-worth chart cliff-jumps at the present).
  Daily history + on-chain metrics cached with once-per-day flags.
- **Repairs**: data fixes ship as one-off boot repairs guarded by app_meta
  keys (e.g. `repair:card-payment-signs` flipped Citi's negative-credit
  payments and recomputed dedupe hashes to match the fixed parser).
- **Vault crypto** (`shared/vault.ts`): random AES-GCM-256 data key encrypts
  the payload; PBKDF2-SHA256(600k)-derived KEK wraps the data key; raw data
  key doubles as the recovery key (zero-knowledge = no reset). Format is
  versioned — v2 slots in Argon2id or WebAuthn-PRF without breaking blobs.
- **Local mode**: per-tab, in-memory, entered from a snapshot; durable saves
  go through the encrypted vault. Server plaintext provably untouched by
  local edits (verified end-to-end).

## 5. External data sources (and their scars)

| Source | Use | Gotchas learned the hard way |
|---|---|---|
| Yahoo v8 chart | stock+crypto quotes, monthly & daily history | `range=max` silently degrades interval to monthly — use `period1=0&period2=now` for daily. Crypto = `SYM-USD`. Datacenter blocking is a standing risk; errors surface in the UI. |
| CoinGecko simple/price | crypto spot | symbol→id map is hardcoded (`server/prices.ts`). |
| Stooq | (dead) | CSV API gone behind proof-of-work bot protection, 2026. |
| CoinMetrics community | (dropped) | free tier lost `CapRealUSD` — can't derive realized price. |
| bitcoin-data.com | BTC realized price, MVRV | free, keyless, trailing ~4y, ~1 day lag. |
| alternative.me | Fear & Greed | `/fng/?limit=0` full history since 2018. |
| BlockHorizon | (candidate) | 125+ BTC metrics; free tier is site-only; API "upon request" — needs a key before integration. |
| ETF flows | (absent) | no keyless source exists (Farside/SoSoValue/Coinglass all key-gated). |
| FRED fredgraph.csv | 30-yr PMMS mortgage average (digest rate trigger) | freddiemac.com's own CSV 403s datacenter IPs; FRED serves the same series keyless. Response is gzip — Node fetch handles it. |
| Damodaran histretSP + Minneapolis Fed CPI | bundled historical real returns (`engine/history.ts`) | Static, hand-refreshed yearly; not fetched at runtime so ZK mode stays offline-clean. |
| NASDAQ Trader SymDir | quote-basket universe (all US-listed symbols) | `nasdaqlisted.txt` + `otherlisted.txt`, pipe-delimited, keyless. Datacenter IPs may 403 (as Yahoo does); the build is best-effort and keeps yesterday's rows on failure. |
| Yahoo v8 spark (batched) | basket quotes | ~200 symbols per call; v7 quote (crumb+cookie) is the fallback when spark returns nothing. |
| CoinGecko /coins/markets | basket crypto quotes | top ~500 by market cap, keyless, browser-CORS-friendly. |
| SimpleFIN | (planned, household mode) | $1.50/mo, read-only tokens via MX. Fundamentally in tension with ZK mode — see PRIVACY.md. |

## 6. Operations

- `npm run dev` / `npm test` / `npm run typecheck` / `npm run build`.
- `./scripts/deploy.sh` — gcloud run deploy from source (config in `.env.gcp`).
- `./scripts/bootstrap-gcp.sh` — one-time project setup. Non-org projects
  must complete IAP's OAuth client once via the Cloud Run console Security
  tab (script prints this).
- **Backups**: Litestream streams to GCS continuously. To restore locally for
  analysis: copy the replica dir, find the generation with the newest WAL
  (`gcloud storage ls -l …/wal/`), then
  `litestream restore -generation <id> -o out.db "file://<copy>"`.
  Plain `restore` after a gcloud cp picks by file mtime and can silently hand
  you a stale generation.
- Deploy safety: HTML shell is `no-cache`; hashed assets immutable.

## 7. Roadmap

**Done**: Phases 0–IV (all six screens), vault layer (ZK-1), isomorphic
engine + parity (ZK-2), local mode with encrypted saves (ZK-3),
boot-into-local-from-vault + start-empty (ZK front door, 2026-09-09), and the
daily price basket that keeps a ZK session's quotes fresh without naming
holdings (2026-09-09).

**Remaining, in order:**

1. ~~Boot-into-local-from-vault~~ **— done 2026-09-09** (`src/FrontDoor.tsx`,
   `src/session.ts`). The front door shows only when the server holds no
   plaintext: unlock the vault into this tab, or start empty. Save reseals the
   payload under the data key kept from unlock (`sealVault`), so the filed
   recovery key keeps working and the passphrase isn't asked twice. A session
   that begins and ends with no server plaintext.
2. **Persistent unlock** — unwrapped data key as a non-extractable CryptoKey
   in IndexedDB ("remember this device"); then WebAuthn-PRF passkey unlock
   (vault format v2).
3. **Two-member vault** — wrap the data key once per household member; each
   unlocks with their own credential.
4. ~~Quote proxy~~ → **quote basket, done 2026-09-09** (`server/basket.ts`,
   `server/api8.ts`). Rather than proxy per-symbol requests (whose stream is
   the portfolio), the server fetches the whole US-listed universe + top crypto
   once a day (NASDAQ Trader directory + Yahoo spark + CoinGecko markets) and
   serves it whole, identical for every caller; the client picks its own
   symbols out locally. Future: an anonymous-add path for off-universe symbols
   and hashed-bucket daily-history charts in ZK mode (see PRIVACY.md).
5. **Trust chain** — open-source the repo, reproducible builds, sigstore/
   GitHub attestations binding served bundle hashes to public commits,
   published asset manifest.
6. **scarab.one deploy** — ~~vault-only storage~~ (**done 2026-09-09**:
   `SCARAB_ZK_ONLY=1`, `server/app.ts` — plaintext routes refused, boot refuses
   plaintext data, one-time purge flag; `scripts/deploy.sh` forwards both);
   still to do: IAP `allAuthenticatedUsers`, size caps, ToS/privacy pages.
7. Household-mode conveniences that never made ZK controversial: SimpleFIN
   sync, nightly price refresh (Cloud Scheduler + OIDC through IAP),
   tax-rate settings page.

## 8. Design system

Dark-only, desktop-first. Tokens in `src/styles.css`; the authoritative
mockup is linked in CLAUDE.md. Surfaces #0a0d12/#0e1219/#161b24; ink
#f2efe6/#a8adb8/#6e7480; gold accent #e3b23c reserved for nav/CTAs/goal.
Chart series fixed order (CVD-validated on #161b24): gold #bd8a26, lapis
#5b8def, malachite #24a06e, amethyst #8f7fe8, carnelian #d95f42, faience
#2b9cb8. Up/down #34c77b/#e5605c are reserved for gains/losses, never series.
Marcellus (bundled woff2, OFL) for display; ui-monospace tabular-nums for
number columns. Charts are hand-rolled SVG with crosshair tooltips; legends
whenever ≥2 series; log scales tick at 1/2/5×10^k.
