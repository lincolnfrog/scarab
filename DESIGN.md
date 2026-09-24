# Scarab — design document

Private household finance, built ledger-first, evolving into a zero-knowledge
public service (scarab.one). This document is the map: what exists, why it's
shaped this way, and what remains. Companion documents: `PRIVACY.md` (the
privacy architecture and its honest limits), `README.md` (quickstart),
`CLAUDE.md` (hard rules for anyone — human or model — writing code here),
`tasks.md` (the backlog).

## 1. Product

Eight screens plus **Data & Vault**, in nav order (`src/router.ts` SCREENS):
**Dashboard** (net-worth hero with a Total/Breakdown chart, grouped stat
tiles with 12-month sparklines, allocation donut, dream-home tile, activity,
the "since you were last here" digest), **Investments** (account strip and
drawer, holdings per account, a record-trade sheet that previews gain, tax
and wash sales, the activity ledger, starting positions, balance check-in,
owner filter, portfolio value vs. cost, return by holding, price charts),
**Real estate** (valuations, mortgages, equity), **Cash & budget** (imports,
categorizer, plan-vs-actual, recurring bills), **Dream Home** (down-payment
fund, loan options, payment matrix, rental scenario, tax gross-up,
carry-vs-payoff), **Taxes** (federal + state estimate, paychecks, withholding
gap, harvesting, realized-gains report with a Form 8949-shaped CSV),
**Future** (scenarios over a Monte Carlo of the real balance sheet),
**Compare** (any series Scarab tracks, overlaid as values, rebased to 100,
% change or A−B, with a Performance preset and saved views), and **Data &
Vault** (export/import, and the encrypted vault's session, household,
recovery, backups, history and advanced cards). ⌘K / Ctrl-K opens a command
palette: every screen, and actions through deep links.

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
src/        React 19 client (Vite). Screens call get/post('/api/…') and do not
            know which universe answers.
  App.tsx     The shell: boot (/api/mode → the front door or the app), sidebar,
            topbar (⌘K hint, SyncChip), DialogHost, CommandPalette, ToastHost,
            and one ScreenSlot per screen visited. Screens are code-split
            (lazy loaders read with use(); the one being opened loads with the
            boot requests, the rest in the background) and kept alive in
            React <Activity>: a hidden screen is display:none with its effects
            torn down and its state kept; revealing it re-runs its effects, so
            it refetches quietly behind what it already shows. Each screen's
            ErrorBoundary is keyed on the data universe: a data swap remounts
            every screen.
  router.ts   Hash routing: #/<screen>[/<section>][?key=value]. A fragment
            carries only screen ids, numeric ids, enums and YYYY-MM months —
            browsers sync fragments to account history — and formatRoute
            throws in dev on anything else (drops it in production). Tickers,
            search text and selections live in route state (useRouteState →
            history.state), carried onto new entries of the same screen and
            across data swaps. navigate / setParams / Link; a screen change
            runs as a view transition; a link to a section re-scrolls even
            when it is already in the URL.
  ui/         The primitives (APIs frozen for the streams; see §8): Button,
            Dialog/Drawer, dialogs.tsx (confirm/prompt/DialogHost, typed
            confirms), Field + TextInput/Select/DateInput/MoneyInput/
            PercentInput/QtyInput (text in; integer cents or micro out, null
            while it doesn't parse; an unparseable box blocks its form's
            submit), Popover, Menu, Segmented, Tabs, Tooltip, Toast, Skeleton,
            EmptyState, ErrorBoundary, LiveRegion, HeaderSlot (a portal into
            the page header, shown only with its screen), screen.tsx
            (ScreenProvider, useScreen, useAnchor), useAction (busy + toasts;
            never rejects), motion.ts, CommandPalette (useDeepAction runs a
            screen's ?d= deep link once, then drops it), SyncChip /
            SidebarStatus / syncStatus.ts (session status). ui.css (.ui-*).
  api.ts      The switch: local mode on → the in-tab dispatcher; else fetch.
            The network-only prefixes (/vault, /basket, /mode) always go to the
            server. In household mode it counts this tab's own server writes
            (serverWriteCount, 'scarab-server-write') so caches can key on it.
  local.ts    Local mode: the whole app against a sql.js database in this tab,
            per-tab and in memory. localDispatch matches the route and runs its
            handler; the tab turns dirty only when an 'auto' route actually
            changed the database (totalChanges) — a failed or no-op write, a
            read-like POST or a quote refresh ('never') leaves it clean, so
            browsing never creates a vault version.
  local/      table.ts (matching: method + exact segment count, first match
            wins; DirtyPolicy), routes.ts (NETWORK_ONLY; loads the lists lazily
            so the engine stays out of the household bundle), routes-core.ts
            (cash, budget, property, goal, tax, digest, scenarios,
            export/import, /me), routes-invest.ts (accounts, trades, portfolio,
            grants, balances), routes-analytics.ts (price refresh from the
            basket, charts, series, returns; the tab's in-memory copy of the
            market history). Each handler calls the engine function its server
            route calls; drift.test.ts holds the two tables together.
  session.ts  The ZK session: unlock, create (PUT version 0 — never
            overwrites; the owner's typed REPLACE deletes first), passkeys,
            rotation. Every save goes through src/saveQueue.ts: one at a time,
            reading key+header when it runs (so a queued save can't undo a
            passkey change or rotation), no upload when the tables are
            unchanged, lost responses adopted by sha, autosave 1.5s after the
            last write with 2s→5s→15s→60s retry offline; 409/413 are sticky.
            Saves write vault format v3 (shared/vault.ts): the header (vault
            id, RP ID, salt, seq = version stored as, wrappings) is the
            payload's AES-GCM AAD; payload = [u32 len][gzip][zero pad to a
            size bucket]. v2 still opens. Each device remembers the last v3
            seq+sha+salt it saw (localStorage scarab:seen:<vaultId>) and asks
            before opening an older copy. Passkeys use RP ID scarab.one on
            scarab.one and its subdomains (src/passkey.ts rpIdFor).
            A session follows the other member: a watcher asks /api/mode every
            45s while the tab is visible, and on focus (saveQueue.ts
            createWatcher + decideOnPoll). A clean tab loads a newer version in
            place (refreshFromVault: queue-exclusive with saves, re-checks for
            edits just before replacing, adopts the header); unsaved work or a
            409 raises the banner and src/ConflictSheet.tsx (Take theirs · Keep
            mine, only once the server keeps history · Download mine). Keep
            mine judges the served copy against the device's memory like an
            unlock, and over an older copy keeps this tab's own header. A blob
            the session key no longer opens (re-keyed) locks to the front door
            — unless the tab was edited while it downloaded: then the sheet
            decides.
            Uploads name the blob they replace (baseSha256; 409 over a vault
            replaced at the same version), and /api/mode carries its sha256.
            PUT records who saved (vault_blobs.updated_by) for "saved by …";
            BroadcastChannel('scarab-session') tells a second tab it is one.
            Each wrapping names its identity (PasskeyWrap.identity, in the
            authenticated header); src/screens/vault/people.ts ties passkeys
            to the owner and household_members by it — never by label.
            Membership is by consent: POST /vault/members records a
            vault_invites row — one per (email, household) since migration
            21 — and always answers {ok:true} (no enumeration); the invitee
            accepts on their own device (FrontDoor 'invite' step, behind a
            confirm → POST /vault/invites/accept {household, replaceOwn?,
            version?}, which ends their own vault or other membership only
            when asked) or declines (DELETE /vault/invites/:household);
            householdOf ignores invitations; /api/mode.invites lists the
            caller's own.
            addHouseholdMember: invite, then the ceremony (an invitation it
            made is withdrawn — ?pending=1, never a membership — if that
            fails); cancelInvite also drops their wraps (no re-key: never
            served). leaveHousehold: save, DELETE self, lock with a note.
            Idle auto-lock (saveQueue createIdleLock; per-device
            localStorage scarab:idle-lock 15m/1h/4h/never): lockVault with a
            note, never over a failed save (follow.idleBlocked → banner).
            lockVault waits for queued and in-flight uploads.
            Removing one: DELETE the member (owner
            or self only), then rotateVault excluding their passkeys with
            PUT purgeHistory (drops vault_history + prev_*), then a new
            recovery code the sheet won't release until acknowledged
            (follow.recoveryOwed / rotationOwed persist per vault on the
            device). A re-key or a create marks its new code owed
            (scarab:recovery-owed:<vaultId> lists the PRF salts owed) before
            it uploads, and a lost answer is settled at once (saveQueue
            settle: ask the server what it holds, adopt it if it is this
            upload). Showing the code takes a fresh passkey assertion.
            History: PUT moves the replaced blob into vault_history (prev_*
            no longer written), pruned by api4 historyToDrop (last 20, last
            per UTC day for 30 days, 8 newest pins, 64 MB cap); a save may
            pin it (saveQueue deps.pin: 'pre-upgrade' after an unlock that
            ran a tier-C upgrade, 'pre-restore' before a restore). GET
            /vault/history[/:version] (ZK patterns). openHistoryVersion
            opens a version with the session key and counts rows in a
            scratch sql.js db; restoreSnapshot saves unsaved work first,
            loads the data queue-exclusively and saves it resealed under
            the current key+header. Backups: makeBackup seals the tab as a
            .scarab file ({scarab:'backup', format:1, vault: v3 blob}); open
            with the session key, a passkey or its recovery code; restore
            into the vault, or — when none is stored — restoreBackupAsVault
            (version-0 create with the backup's key and header; refused for a
            backup from before a re-key this device saw, asked for one merely
            older) or, leading at the front door, newVaultFromBackup (fresh
            key, vault id, passkey and code). The front door unlocks the
            stored vault with a backup's key when it can (enterWithBackup); a
            backup waiting for the session is offered by vault/Preview.tsx's
            host in the sync chip.
            src/screens/Vault.tsx → vault/{Session,Household,Recovery,
            Backups,History,Advanced}.tsx cards.
  screens/    Dashboard, Invest, RealEstate, Cash, Goal, Taxes, Future,
            Compare, Vault (+ vault/), with pure helpers beside them
            (cash-route.ts: Cash's filters ↔ the hash; future-sync.ts:
            flush-on-hide debounce, edit generations, the compare cache key).
            Compare.tsx overlays up to six series from GET /series (picker
            chips as the legend, Value / Rebased / % change / A−B, a stats
            row, saved views in app_meta ui:chart-views, the Performance
            preset: :twr lines against a bench:<SYM>); its selection lives in
            route state, only a saved view's id (?v=) in the URL. screens.css
            (.scr-*).
  invest/     Investments (.inv-*): AccountStrip, AccountDrawer (Positions ·
            Activity · Grants · Settings), AddAccountFlow, TradeSheet (live
            preview from POST /trades/preview), ActivityTable (edit and delete
            trades in place), OpeningPositionsSheet, CheckinDrawer,
            BalanceAccounts, CashPanel, VestDialog, GrantsPanel, SetPrice,
            SymbolInput (a combobox over the shared basket — typing sends
            nothing), HoldingsTable, TaxPictureCard, OwnerPills; pure
            *Math.ts, ownerFilter, priceRefresh, symbolSearch, form8949.
  chart/      The chart core (.ch-*): TimeChart — every trend: UTC time axis,
            a crosshair that reads each series "as of" the snapped date,
            legend toggles, range presets, drag-to-zoom, keyboard stepping,
            dashed estimated segments, markers, thresholds, bands, a trade
            rug, stacked layers, rebased/% modes that refuse a series ≤ 0 at
            the anchor, one y-axis. scale.ts (nice/log/time ticks, M4
            decimation), format.ts, palette.ts (s1–s6, pinned slots),
            ChartTip, Legend, Sparkline, DriverBars, SeriesPicker,
            PerformanceDialog, CountUp; pure *Model.ts files carry the logic.
  cards/      Cards built on it: StatTile, DreamHomeTile, ActivityCard,
            PortfolioValueCard, HoldingsReturnsCard, PriceChartCard,
            RealEstateChart, GoalFundChart, FutureFan, CashFlowCard,
            CategorySpendCard; cardModel.ts.
  tax/        Taxes cards (HarvestCard, RealizedCard) and their copy.
  viz.tsx BigChart.tsx  Donut, GroupedBars, HBars, Bullets; the daily price
            chart (log scale, 50D/200D/200W, buys and sells marked).
  FrontDoor.tsx ConflictSheet.tsx RecoveryCode.tsx DigestCard.tsx
  RecurringCard.tsx passkey.ts saveQueue.ts
engine/     THE CORE. Isomorphic: runs byte-identical in Node and browsers.
  db.ts        DbLike — 4-method seam (prepare/exec/transaction/pragma).
  errors.ts    ApiError(status), bad/notFound, isoDay/isoMonth. The tab turns an
               ApiError back into a plain Error with the same message.
  migrations.ts  Append-only migrations array + migrate().
  upgrades.ts  Reading older snapshots: tiers A/B/C, SNAPSHOT_COMPAT (§3).
  import.ts    Statement parsing (WF CSV, generic CSV w/ debit-credit
               magnitudes, OFX), dedupe (FITID or sha1+ordinal), categorizer
               (longest-pattern rules), merchant extraction, transfer-pair
               detection.
  repairs.ts   One-off boot repairs (guarded by app_meta keys) + retroactive
               rule application.
  lots.ts      FIFO/specific-lot/explicit-basis engine, ST/LT splits (the
               anniversary rule), per-sale parts for the ledger.
  holdings.ts  loadHoldings: positions per (account, asset) — the seam every
               lots consumer reads — and the cash anchor (cashAt).
  invest.ts    Investment accounts and their profile, trades (validateTrade;
               create, update and delete with a replay check), the portfolio,
               account detail, opening positions, manual prices, grants and
               vests (net settlement), balance snapshots, the check-in.
  positions-paste.ts  Pure parser for pasted starting positions.
  prices.ts    Quotes in (upsertPrices; applyBasket → prices + prices_daily),
               chart data with its coverage, the market-history codec
               (encode/decodeMonthly, packMarket), applyMonthlyHistory, and
               the per-symbol fetch-flag names.
  networth.ts  Month-end series derived entirely from dated facts (each table
               grouped once, binary-searched lookups; the current month as of
               today).
  analytics.ts The series layer (nw, inv, pos, set, px, cash, prop, liab,
               goal:fund, cf; :twr; bench:<SYM>), its catalog, and Compare's
               saved views.
  returns.ts   Return by holding: money-weighted (XIRR) from open lots and
               today's price — no price history needed.
  tax.ts       Bracket math (federal + bundled states), realized picture,
               harvest list, trade preview, realized report; paychecks.ts
               projects per-person payroll.
  digest.ts recurring.ts  The digest and recurring-transaction detection.
  simulate.ts  Seeded Monte Carlo (mulberry32 + Box-Muller): lognormal or
               historical block-bootstrap draws, dated events, crossing year,
               price-a-decision.
  history.ts   Annual US stock real total returns 1928→ (Damodaran nominal ÷
               CPI-U). Append-only; refresh yearly.
  scenarios.ts The decision engine: named knob-sets compared side by side
               against the ledger; deltas vs the baseline.
  services.ts  Cash, budget, property, goal (with its derivation), activity
               and the rest as (db, args) functions; re-exports errors,
               invest and prices.
  snapshot.ts  Dump/load of all household tables — THE interchange format
               (export files, vault payloads, local-mode hydration). loadDump
               validates every row against the schema before its first write.
  sqljs-db.ts  sql.js adapter for DbLike (an LRU of 256 compiled statements).
  hash.ts      Synchronous SHA-1 (WebCrypto is async; node:crypto isn't in
               browsers). Parity-tested against node:crypto.
  test/        Test-only: parity.ts (onBothEngines), household.ts (a seed).
server/     Node-only shell.
  index.ts    Boot: prepareDatabase (vault-only: refuse or purge plaintext;
              household: repairs + transfer sweep), then serve.
  app.ts      createApp: IAP identity → the ZK gate (403 before any handler)
              → bodyLimits → jsonBodies → routes; onError answers JSON
              { error } (4xx for an ApiError, 500 otherwise). Static serving:
              index no-cache, hashed assets immutable — deploys must never
              strand stale bundles.
  zk-routes.ts  The vault-only allowlist: one literal list, a section per area.
  http.ts     jsonBodies (one parse; 400 for a body that isn't a JSON object
              or array), onError, restoreRefusal (a snapshot's fault → 400).
  db.ts, migrations.ts  better-sqlite3 openDb + migrate.
  api.ts api2.ts api3.ts  Thin Hono wrappers over engine/services.
  api4.ts     The vault courier (blob, version + baseSha256 concurrency,
              updated_by, history and its pruning, purge on re-key, owner-only
              DELETE), members and invitations, body caps, export/import.
  api5–7.ts   Tax, digest/recurring, scenarios.
  api8.ts     /mode (the front door, and a session's poll) and the price
              basket (GET, status, throttled rebuild).
  api9.ts     Brokerage: account detail, owners, assets, check-in, balances,
              trade edit/delete/preview, opening positions, manual prices,
              the realized report.
  api10.ts    Market data and analytics: price refresh, daily charts, series,
              catalog and views, returns, the market history file.
  basket.ts   The daily price basket: the whole US-listed universe + top crypto,
              quoted once a day and served identically to every caller, so a
              local/ZK session refreshes prices without revealing holdings.
  history-pack.ts  The monthly market history (§5): ten years of month-end
              closes for the basket universe, one file for every caller.
  prices.ts charts.ts rates.ts  Network fetchers (Yahoo, CoinGecko, FRED) —
              fetching stays server-side so engine/ is CORS-clean; results are
              written via services and cached in SQLite with once-per-day
              app_meta flags.
  upstream.ts Every outside call carries a 30s deadline.
shared/     money.ts (integer cents, string-math parsing, percent micro,
            micro-share quantities), dates.ts (calendar-day and month math,
            todayLocal, anniversaryIso, isRealIsoDay), vault.ts (envelope
            encryption, format v3, the rollback judge, the recovery code),
            series.ts (SMA, weekly resample, tax gross-up, rebase/% change,
            CAGR, drawdown), perf.ts (xirr; Modified-Dietz months chain-linked
            in exact BigInt for TWR), capgains.ts (§1211/1222 netting),
            series-api.ts and invest-api.ts (wire contracts), types.ts.
```

**Testing**: vitest, 86 files and about 1,340 tests, run in Node with no DOM:
screens are checked in a real browser, their logic lives in pure
`*Model.ts`/`*Math.ts`/`*-route.ts` modules with unit tests, and a few
components render to static markup. The structural ones:

- **Engine parity.** `engine/parity.test.ts` runs the full
  import→repair→transfer→networth pipeline on better-sqlite3 AND sql.js and
  demands identical output; each area adds its own suite on
  `engine/test/parity.ts` `onBothEngines` (parity-invest, parity-analytics,
  holdings, cash, prices, activity), and the migration tests run on both too.
  `engine/hash.test.ts` pins sha1 to node:crypto.
- **Route drift.** `src/local/drift.test.ts` builds the real server app and
  fails if any server `/api` route is neither mirrored in the tab's table nor
  network-only, or if the tab answers anything the server doesn't.
- **Snapshots and schema.** `engine/snapshot.test.ts` asserts the excluded
  tables; `snapshot-compat.test.ts` holds `minReadable` to the oldest fixture
  (none until production); `migrations.test.ts` replays #20 and #21 over
  older databases.
- **Vault.** `shared/vault.test.ts` covers format v3: relabelling a passkey,
  moving an identity, dropping or injecting a wrapping, swapping the salt or
  RP ID and replaying under another seq all fail; a golden canonical header;
  v2 still reads; padding buckets; the gzip-bomb cap; the recovery code's
  check group. There is no passphrase anywhere.
- **Sessions end to end.** `src/session*.test.ts` drive the real session.ts,
  saveQueue.ts and sql.js engine against the real Hono app (fetch routed
  straight in), opening vaults with the recovery code or a fake PRF
  authenticator: autosave, conflicts and following, members and invitations,
  history, backups, idle lock, v3 and rollback. `server/app.test.ts` covers the
  ZK allowlist, the courier's versioning and history, invitations and body
  caps.

Everything else covers parsers, lots edge cases (the anniversary, oversells,
specific lots, per-account pools), tax, money parsing, series and returns
math, chart scales (including a non-vacuous America/Los_Angeles test), and
simulation determinism.

## 3. Data model (migrations 1–21)

Ledger philosophy: **store dated facts, derive everything**. Transactions,
trades, prices, valuations, balances are facts; balance sheets, charts, cost
basis, returns and net worth are always computed. Never store a derivable
number.

1. `app_meta` — also hosts one-off repair flags, per-symbol fetch flags
   (`backfilled:v2:`, `backfill_failed:`, `daily:v2:`), hand-entered price
   provenance (`price:manual:<SYM>`), digest marks, Compare's saved views
   (`ui:chart-views`) and, on the server only, the `basket:*` keys.
2. Cash: accounts (opening_cents anchors flows to reality), categories,
   imports, transactions (dedupe_hash unique per account), rules, budgets.
3. Investments/property: invest_accounts (lots- or balance-tracked), assets,
   trades (qty in **micro-shares**, integer), prices (one close per asset per
   day quoted: refresh quotes, hand-entered prices, and month-end closes from
   a backfill or the market history), balance_snapshots, properties,
   property_valuations, liabilities, liability_balances.
4. rsu_vests (superseded by 6; kept append-only).
5. trades gains sold_lot_trade_id / acquired_on / basis_cents — specific-lot
   and explicit-basis sells. A buy may carry acquired_on too: a starting
   position or a transfer in keeps its true acquisition date.
6. unvested_positions — one running unvested count per account+asset.
7. Household categories (Gardening/Alcohol/Pets/Taxes) + merchant rules;
   card-payment patterns file as Transfer.
8. goal_settings (JSON blobs) + loan_options; brokerage ACH files as Transfer
   (moving your own money is not income).
9. prices_daily — daily closes for the price chart (Yahoo on a household
   server; in a tab, each day's basket quote accrues here) — and onchain_daily,
   which nothing ever wrote or read: it stays (append-only) but snapshots no
   longer carry it.
10. vault_blobs — ciphertext per household key, optimistic-concurrency
    version, sha256, 10MB cap.
11. scenarios — named Future knob-sets; exactly one baseline.
12. basket_quotes — the shared daily basket (server infrastructure; empty in a
    tab).
13. A vest cadence on unvested_positions (next_vest_on, vest_every_months,
    vest_qty_micro). next_vest_on is the schedule's **anchor**: the k-th vest
    falls k × cadence months after it, never stepped from a clamped earlier
    date, and the next unrecorded vest is derived from the ledger's RSU-vest
    buys, so deleting a recorded vest makes it due again.
14. pay_sources — one row per earner per employer, from the latest paystub.
15. household_members — a member's email → a household's blob.
16. invest_accounts.stock_plan — employee stock plans are opt-in.
17. vault_blobs.prev_* — one step of history. Superseded by 20: never written
    now, cleared by every save, and a leftover copy joins vault_history. The
    operator restore its comment describes is replaced by the in-app History
    card.
18. invest_accounts profile: subtype (taxable, 401k, 403b, ira, roth_ira, hsa,
    crypto, stock_plan, other; NULL = infer from kind), institution, owner
    (NULL = joint), mask (last 4), sort. Descriptive household data.
19. basket_quotes.name + etf — symbol search can say what VTI is.
20. vault_history (replaced blobs with updated_by and pin, pruned by api4's
    HISTORY_POLICY), vault_blobs.updated_by, vault_invites.
21. vault_invites keyed on (email, household): each household's invitation
    waits on its own; none replaces another's.

**Server-only, never in a snapshot**: vault_blobs, vault_history,
household_members, vault_invites, basket_quotes and the `basket:*` app_meta
keys (build stamps, the rebuild throttle, the market history file). A
snapshot is household data; the courier's routing and the shared price data
belong to the deployment.

**How facts become numbers** (the non-obvious rules):

- **Lots** pool per (account, asset) — VTI in a taxable account and VTI in a
  Roth are two positions. A lot opens on `acquired_on ?? traded_on`, FIFO
  follows acquisition order, and long-term means sold after the anniversary
  (Feb 29 → Feb 28). A `retirement`-kind account is sheltered: its sales never
  reach the tax bill or the harvest list. Wash-sale scans still span every
  account (IRAs included; crypto excluded).
- **The cash anchor**: a balance_snapshots row on a lots-tracked account is
  that account's cash at the end of that day. Cash on a later day = the latest
  anchor + sale proceeds − buys dated after it (trades on the anchor day are
  already in it). Vests, starting positions, buys booked after their shares
  were acquired (transfers in) and vest-withholding sales move no cash.
  Deposits aren't recorded; a newer anchor re-bases. An account with no
  anchor has no cash as far as Scarab knows: its sale proceeds drop out of net
  worth, and the drawer says how much. On a balance-tracked account the same
  row is still the account's whole balance.
- **Net-settlement vests**: a buy of the gross shares at vest value ('RSU
  vest') plus a same-day sale of the withheld shares at exactly their share of
  that cost ('RSU withholding'), so the withholding realizes $0 and stays off
  the realized report.
- **Hand-entered prices** are ordinary price rows marked by
  `price:manual:<SYM>`; a later market quote supersedes them.
- **Snapshot compatibility** (`engine/upgrades.ts`): tier A (UX) and B
  (additive schema) changes need nothing; a tier-C change (data changes shape)
  needs an upgrade entry. Until production, `SNAPSHOT_COMPAT.minReadable` is
  the current version and the registry is empty, so an older snapshot is
  refused rather than upgraded (`engine/fixtures/README.md`) — every new
  migration makes earlier dev vaults unreadable until then.

Money invariants: **integer cents everywhere**; parsing is string math
(`parseMoney` handles commas-only-in-thousands, accounting parens);
quantities are integer micro-shares (1e6 = one share); rates are micro
(1e6 = 100%), and so are performance indexes (1e6 = 100 at the base month).
Floats only at a few boundaries: external quote APIs (converted to cents once
at ingestion), Monte Carlo internals (rounded at the edge), and rate solving
(xirr, CAGR roots — rounded to a whole micro before they leave).

## 4. Load-bearing design decisions

- **Single writer**: `--max-instances 1` because SQLite. Do not "fix".
- **Uncategorized money never disappears** — it surfaces as explicit rows so
  every card agrees with every other card by construction.
- **One income/spending definition**: each category nets its month in its own
  direction, never below zero — a refund lowers its category's spending and is
  never income. Cash bars, category cards, budget and Compare's `cf:*` share it.
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
  pre-Scarab history) > specific lot (sold_lot_trade_id) > FIFO, within the
  sale's own account. validateTrade refuses, before any write, a future date,
  a lot from another account or asset, and a lot bought after the sale; a
  trade edit or delete that would leave another sale short is refused, and a
  delete rewrites the sales that drew on the deleted lot to explicit basis.
  Legacy data selling an unopened lot still degrades to zero-basis + a visible
  warning, never silent corruption.
- **Prices**: current quotes + once-per-asset monthly backfill (without it,
  history values at cost and the net-worth chart cliff-jumps at the present).
  Monthly bars are stamped at month-end. Daily history is cached with
  once-per-day flags; a failed backfill retries weekly. A ZK tab's prices come
  only from the two shared files (§5).
- **Returns**: money-weighted per holding (XIRR from open lots, annualized
  only after a year) needs no history; time-weighted indexes (`:twr`) chain
  monthly Modified-Dietz periods and go null when under 90% of the value in
  view had a market price; `bench:<SYM>` is a price index on the same base, and
  Compare rebases both at a common month to overlay them.
- **Repairs**: data fixes ship as one-off boot repairs guarded by app_meta
  keys (e.g. `repair:card-payment-signs` flipped Citi's negative-credit
  payments and recomputed dedupe hashes to match the fixed parser).
- **Vault crypto** (`shared/vault.ts`, format v3): random AES-GCM-256 data
  key encrypts the gzipped, size-padded payload with the whole header as
  additional data; each passkey's WebAuthn PRF output (HKDF'd) wraps the data
  key once; raw data key doubles as the typed recovery code, 54 characters
  with a check group (zero-knowledge = no reset). No passphrase. WebAuthn is a
  key-derivation device only (`src/passkey.ts`, client-side, nothing verified
  server-side — IAP authenticates). v2 still opens; v1 (PBKDF2 passphrase) was
  dropped before any real vault existed.
- **Local mode**: per-tab, in-memory, entered from a snapshot; durable saves
  go through the encrypted vault. Server plaintext provably untouched by
  local edits (verified end-to-end). Browsing never creates a vault version:
  quote refreshes ride along with the next real save, while the one-time
  market-history import is `'auto'` and does persist.
- **Keep-alive screens**: debounced saves flush when a screen hides, portals
  render only for the showing screen, and a hidden screen never writes the
  URL. The Future compare cache keys on an exact data version (in a tab:
  `localMode.dataRevision`, which moves on every change to its database, a
  price refresh included; on the household server: this tab's own writes, so
  the other member's still land unseen until a reload).
- **Addresses carry no household data**: see the router in §2.

## 5. External data sources (and their scars)

| Source | Use | Gotchas learned the hard way |
|---|---|---|
| Yahoo v8 chart | stock+crypto quotes, monthly & daily history | `range=max` silently degrades interval to monthly — use `period1=0&period2=now` for daily. Crypto = `SYM-USD`. Monthly bars carry the month's *last* close but are timestamped at the month's *open* (in the exchange's zone): stamp them at month-end, or today for the month in progress (`backfilled:v2:` flag; older month-open rows were left as they are). A failed backfill is stamped `backfill_failed:<SYM>` and retried weekly, not on every refresh. Datacenter blocking is a standing risk; errors surface in the UI. |
| CoinGecko simple/price | crypto spot | symbol→id map is hardcoded (`server/prices.ts`). |
| Stooq | (dead) | CSV API gone behind proof-of-work bot protection, 2026. |
| CoinMetrics community | (dropped) | free tier lost `CapRealUSD` — can't derive realized price. |
| bitcoin-data.com, alternative.me | (never wired) BTC realized price and MVRV; Fear & Greed | free and keyless (trailing ~4y, ~1 day lag; `/fng/?limit=0` full history since 2018). Scouted for migration 9's `onchain_daily`, but no fetcher or reader was ever built: the table is empty and snapshots no longer carry it. |
| BlockHorizon | (candidate) | 125+ BTC metrics; free tier is site-only; API "upon request" — needs a key before integration. |
| ETF flows | (absent) | no keyless source exists (Farside/SoSoValue/Coinglass all key-gated). |
| FRED fredgraph.csv | 30-yr PMMS mortgage average (digest rate trigger) | freddiemac.com's own CSV 403s datacenter IPs; FRED serves the same series keyless. Response is gzip — Node fetch handles it. |
| Damodaran histretSP + Minneapolis Fed CPI | bundled historical real returns (`engine/history.ts`) | Static, hand-refreshed yearly; not fetched at runtime so ZK mode stays offline-clean. |
| NASDAQ Trader SymDir | quote-basket universe (all US-listed symbols), security names, ETF flag | `nasdaqlisted.txt` + `otherlisted.txt`, pipe-delimited, keyless. Names lose the "- Common Stock" boilerplate. Datacenter IPs may 403 (as Yahoo does); the build is best-effort and keeps yesterday's rows on failure. |
| Yahoo v8 spark (batched) | basket quotes | ~200 symbols per call; v7 quote (crumb+cookie) is the fallback when spark returns nothing. Batches fail piecemeal: a symbol a build misses keeps its last (dated) quote for 14 days before it drops out. |
| Yahoo v8 spark, `range=10y&interval=1mo` | monthly market history (`server/history-pack.ts`, GET /api/basket/history): month-end closes for the whole basket universe, one file for every caller | **20 symbols per call at most** (more is a 400), so a full build is ~600 calls: one call per 1.5s, ≤160 per run, runs ≥20 min apart, ≤640 a day, resumable (progress saved every 10 batches), and the first 429/403/5xx/unreadable reply pauses it until the next UTC day. Runs start only when someone asks for the file (or a household's series catalog), never on a timer. v8 replies carry no exchange zone, but US listings' monthly bars open at New York midnight (04:00/05:00Z) and crypto's at 00:00Z, so the UTC month is right; the live bar for the month in progress is last and wins. An unknown symbol is simply absent from the reply. Stored delta-encoded in app_meta `basket:history:v1` (~4 MB JSON, ~1.5 MB gzipped); rebuilt once a month has closed, and each daily basket build merges its quotes into the month in progress. A tab keeps the file in memory for `bench:*` and copies only its traded assets' month ends into `prices` (engine/prices.ts `applyMonthlyHistory`). |
| CoinGecko /coins/markets | basket crypto quotes and names | top ~500 by market cap, keyless, browser-CORS-friendly. A failed crypto source leaves yesterday's crypto rows alone (the basket is replaced per kind). |
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
- **Cloud Run CPU**: with request-based CPU and `--min-instances 0`, work that
  outlives its request — the market history build, a daily basket build —
  gets little CPU. The history build resumes from saved progress, so it still
  finishes, but the first full build (~600 Yahoo calls) can take several
  visits or days. Undecided: `--no-cpu-throttling`, or a scheduled ping to
  `GET /api/basket/history`. Never change `--max-instances`.
- **Request size**: Cloud Run's HTTP/1 front end refuses request bodies over
  32 MiB before they reach the container, below the app's 64 MB restore cap
  (`server/api4.ts` BODY_LIMITS). A household restore bigger than that needs a
  gzipped upload (backlog).

## 7. Roadmap

**Done**: Phases 0–IV (the original six screens), vault layer (ZK-1),
isomorphic engine + parity (ZK-2), local mode with encrypted saves (ZK-3),
boot-into-local-from-vault + start-empty (ZK front door, 2026-09-09), the
daily price basket that keeps a ZK session's quotes fresh without naming
holdings (2026-09-09), the passkey-only vault and a two-member household
(2026-09-15), and the improvement pass below (2026-09-23).

1. ~~Boot-into-local-from-vault~~ **— done 2026-09-09** (`src/FrontDoor.tsx`,
   `src/session.ts`). The front door shows only when the server holds no
   plaintext: unlock the vault into this tab, or start empty. Save reseals the
   payload under the data key kept from unlock (`sealVault`), so the filed
   recovery key keeps working. A session that begins and ends with no server
   plaintext.
2. ~~Persistent unlock / passkeys~~ **— done 2026-09-15**: the vault is
   passkey-only (WebAuthn PRF → HKDF → wraps the data key). One tap unlocks;
   Apple/Google sync the passkey across devices; the QR hybrid prompt covers
   a device without one. An IndexedDB key cache was dropped as unnecessary.
3. ~~Two-member vault~~ **— done 2026-09-15, made safe 2026-09-23**: "Add
   household member" runs the same passkey registration with the partner's
   phone answering the QR prompt. Since 2026-09-23 membership needs the
   invitee's consent (`vault_invites`, migrations #20/#21), passkeys are bound
   to identities in the authenticated header, and removing someone is a
   re-key that purges the server's history.
4. ~~Quote proxy~~ → **quote basket, done 2026-09-09** (`server/basket.ts`,
   `server/api8.ts`), **plus the monthly market history, 2026-09-23**
   (`server/history-pack.ts`). Rather than proxy per-symbol requests (whose
   stream is the portfolio), the server fetches the whole US-listed universe +
   top crypto and serves it whole, identical for every caller; the client
   picks its own symbols out locally. The same holds for ten years of
   month-end closes, one file for everyone.
5. ~~Performance attribution~~ **— done 2026-09-23**: return by holding
   (money-weighted, XIRR), monthly time-weighted indexes per account, holding
   or set of holdings (`inv|pos|set:…:twr`), `bench:<SYM>` benchmarks, and
   Compare's Performance preset to overlay them.
6. **The 2026-09-23 improvement pass** (a foundation plus five streams — zero
   knowledge, brokerage, analytics, UI shell, charts — then an integration
   round and an adversarial review whose confirmed findings were fixed):
   - *Shell*: hash router with privacy-checked fragments, keep-alive and
     code-split screens, view-transition crossfades, the `src/ui` primitives
     (no native dialogs; every save and failure toasts), ⌘K palette, `?d=`
     deep links, header actions and section anchors.
   - *Zero knowledge, two people*: one save queue (no-op and failed writes
     never upload, offline retry, sticky 409/413); vault format v3
     (authenticated header and seq, gzip + size padding, per-device rollback
     memory); passkeys pinned to scarab.one; creating never overwrites
     (owner-only typed delete); following the other member (45s poll,
     in-place refresh, conflict sheet); "saved by"; the members panel;
     consent-based invitations; removal as a re-key; a fresh passkey to show
     the recovery code, which gained a check group; version history with
     preview and restore; encrypted `.scarab` backups; idle auto-lock.
   - *Brokerage*: per-account lot pools and the anniversary rule; trade
     validation; account profiles (#18) with a strip, drawer and guided add;
     a trade sheet previewing gain, tax and wash sales; the activity ledger
     with edit and delete; starting-positions paste; hand-entered prices;
     balance accounts and the check-in; the cash anchor; net-settlement vests;
     symbol search over the basket (#19 names); owner filter; the realized
     report and Form 8949-shaped CSV.
   - *Analytics*: the series API (catalog, saved views), returns (item 5),
     the market history (item 4), month-end stamping of monthly bars, the
     sql.js statement cache.
   - *Charts*: TimeChart behind every trend, the Compare screen, a Dashboard
     matching the mockup, portfolio value vs. cost, return by holding, fixed
     axes/donut/price chart, keyboard access throughout, CSS-only motion.
   - *Hardening*: a JSON error contract and one body parse on the server,
     deadlines on every upstream call, body caps (64 MB for a restore), and a
     `netWorthSeries` rewrite roughly 5–15× faster.

**Remaining, in order:**

1. **Production origin, before the real vault.** Passkeys bind to the RP ID
   for life, and `run.app` is on the Public Suffix List: map scarab.one first,
   or accept re-registering every passkey later.
2. **A real-authenticator pass**: create → unlock → add member on a Mac and an
   iPhone (QR hybrid). This pass exercised ceremonies with CDP virtual
   authenticators (PRF), recovery codes and unit tests only.
3. **scarab.one deploy** — ~~vault-only storage~~ (done 2026-09-09:
   `SCARAB_ZK_ONLY=1`, one-time purge), ~~size caps~~ (done 2026-09-23: a
   body cap on every route, on top of the 10MB blob cap); still to do: the
   vault-only cut-over itself (see tasks.md), verifying the basket and history
   builds from Cloud Run's IP, the CPU-throttling decision (§6), IAP
   `allAuthenticatedUsers`, ToS/privacy pages.
4. **Declare production**: freeze the first snapshot fixture and lower
   `SNAPSHOT_COMPAT.minReadable` to it (`engine/fixtures/README.md`); from
   then on every tier-C migration ships an upgrade.
5. **Trust chain** — open-source the repo, reproducible builds, sigstore/
   GitHub attestations binding served bundle hashes to public commits,
   published asset manifest (and, with it, a proper ZK-only build target).
6. **ZK market data**: an anonymous-add path for off-universe symbols (today:
   a hand-entered price), and daily history through hashed symbol buckets
   once the monthly file has proved itself (see PRIVACY.md).
7. Household-mode conveniences that never made ZK controversial: SimpleFIN
   sync, nightly price refresh (Cloud Scheduler + OIDC through IAP), one price
   path (household refresh on the basket too). (The tax-rate settings page
   shipped with Taxes, 2026-08-27.)

## 8. Design system

Dark-only, desktop-first: no screen scrolls the page sideways at 1100px (a
wide table scrolls inside its card), and the drawers and the add-account flow
fit 390px. Tokens in
`src/styles.css`; the authoritative mockup is linked in CLAUDE.md. Surfaces
#0a0d12/#0e1219/#161b24; ink #f2efe6/#a8adb8/#6e7480; gold accent #e3b23c
reserved for nav/CTAs/goal (and the focus ring). Chart series fixed order
(CVD-validated on #161b24): gold #bd8a26, lapis #5b8def, malachite #24a06e,
amethyst #8f7fe8, carnelian #d95f42, faience #2b9cb8. Up/down #34c77b/#e5605c
are reserved for gains/losses, never series. Marcellus (bundled woff2, OFL)
for display; ui-monospace tabular-nums for number columns. One control
height: `--control-h` 34px, `--control-h-mini` 28px.

**Motion** is CSS-first. Tokens on `:root`: `--ease-out`, `--ease-io`,
`--dur-1` 90ms (hover, press), `--dur-2` 180ms (popovers, dialogs, toasts),
`--dur-3` 280ms (drawers), `--dur-4` 600ms (chart reveals); `src/ui/motion.ts`
`DUR` mirrors them for JS. Screen changes and the front door's steps crossfade
through the View Transitions API (`withViewTransition`); the nav indicator
slides; chart lines clip in on first view, bars grow from the baseline with a
small stagger, and hero figures count up once. Nothing replays on a
keep-alive revisit.

**Reduced motion**: one kill-switch in `styles.css` turns every transition
and animation off (the `::backdrop` and view-transition trees included), and
`withViewTransition` skips the API. What must stay visible stays, still:
skeletons and the passkey-waiting ring.

**Primitives** (`src/ui`, listed in §2) are the only way a screen shows a
dialog, a field, a menu or a toast. The rules they carry: no native dialogs;
money typed anywhere goes through MoneyInput or `prompt({kind:'money'})`
into `parseMoney`; every mutation runs through `useAction` (busy state,
success/error toast); explanations sit in a focusable Tooltip, not `title=`;
a first load shows a Skeleton and a revisit shows the last data while it
refreshes; an empty state says what is missing and offers the one action
that fixes it. Keyboard: the nav marks `aria-current`, dialogs and popovers
return focus to what opened them, Esc closes the innermost layer only, and
charts step with ←/→. CSS is area-prefixed: `.ui-*` (primitives), `.scr-*`
(screens), `.inv-*` (Investments), `.ch-*` (charts), `.zk-*` (vault and
session).

**Charts** are hand-rolled SVG: TimeChart for every trend (money charts sit on
a $0 baseline by default; `baseline="fit"` would give the mockup's fitted
look), BigChart for daily price history, `viz.tsx` for the donut and bars.
Crosshair tooltips that flip rather than clip; legends whenever ≥2 series;
one y-axis only (Compare rebases instead of a second axis); rebasing refuses a
series at or below 0 at the anchor; estimated (at-cost) stretches are dashed;
log scales tick at 1/2/5×10^k and fall back to linear when the range is under
2× or touches zero. Series colours come only from s1–s6 in order (Compare
pins a slot per series); gold only for the goal, nav, CTAs and focus; up/down
only for gains and losses.

**Open decision**: `--ink-3` measures 3.68:1 on `--card`, under 4.5:1 for the
11px card titles. Nudge it to about #7d8390, or use `--ink-2` for text under
12px — a token change, so it waits for a yes.
