# Scarab — tasks

Product backlog, distilled from the 2026-08-27 product review. Framing from
that review: Scarab is an excellent *instrument panel* (what is true?) and the
leap to indispensable is becoming a *copilot* (what should we do?). Everything
below follows the house invariants: facts in the ledger, everything else
derived; integer cents; tax/analysis math lives in `engine/` (isomorphic) so
it works identically in household and zero-knowledge modes.

Ordering rationale: tax layer first (largest concrete dollar value, builds on
the lot engine — our strongest asset), digest second, decision engine third
(biggest win, most design-heavy). All three shipped, and so did the
2026-09-23 improvement pass (zero knowledge for two, brokerage, analytics, UI
shell, charts — see its section below); what's left is follow-ups, the
vault-only milestone, and the backlog at the end.

## Active: 1 — Tax intelligence layer

**Shipped 2026-08-27** (`engine/tax.ts`, `server/api5.ts`, `src/screens/Taxes.tsx`):
real 2026 federal brackets + LT stacking + NIIT, CA brackets + MHST, no-tax and
flat states bundled, custom-rate fallback for the rest. Follow-ups now live at
the bottom of this section.

We track tax lots, ST/LT splits, RSU vests, and basis resolution more
rigorously than most consumer tools, then do nothing with it. Turn that data
into answers. All computation derived from trades/vests/prices at read time —
no stored tax numbers.

- [x] **Tax settings.** Filing status + rates (federal ST/LT, state,
      withholding rate on RSU vests). Decide: user-entered marginal rates vs
      real bracket math (open question — see review). Storage:
      `goal_settings`-style JSON blob or a proper `tax_settings` table
      (append-only migration either way).
- [x] **`engine/tax.ts`.** Year-to-date realized picture from the ledger:
      realized ST/LT gains via the lots engine, RSU ordinary income from
      vest-day values, dividends/interest if present. Pure `(db, args)`
      service functions like everything else.
- [x] **Withholding gap.** Estimated tax on YTD + projected full-year comp
      vs. what's actually withheld (RSU flat supplemental rate is the classic
      April surprise). Surface as one number with the assumption spelled out.
- [x] **Harvesting advisor.** Per-lot unrealized loss report: which specific
      lots are harvestable, ST/LT character of the loss, what selling them
      offsets. Wash-sale awareness: flag lots with purchases (incl. vests)
      within ±30 days, and warn on proposed sells that would trip one.
- [x] **After-tax proceeds everywhere.** Hover on any lot in Invest shows net
      after estimated tax, not gross. Reuse `grossSaleForNet` family in
      `shared/series.ts`; extend for ST/LT split.
- [x] **Estimated quarterlies.** Safe-harbor check (110% prior-year /
      90% current-year) + due-date awareness.
- [x] **Tax screen or Invest section.** Follow the mockup design language
      (tokens in CLAUDE.md). One headline number: projected tax bill / refund
      gap for the current year.
- [x] **Tests.** Lot-edge cases (wash-sale window boundaries, vest-then-sell,
      specific-lot harvests), parity (better-sqlite3 vs sql.js), determinism.
- [x] **Disclaimer copy.** This is estimation, not advice; say so in the UI
      where the numbers appear (matches README stance).

Follow-ups — **shipped 2026-09-10** except the last:

- [x] State estimated-payment schedules. `estimatedSchedule(rule, …)` runs the
      federal and state safe harbors under one shape; CA's Form 540-ES rule is
      bundled (30/40/0/30 installments, $500/$250 threshold, no prior-year
      harbor at $1M+ AGI). Other taxing states get the federal shape, flagged
      `assumed` in the API and the UI. New settings: state est. payments made,
      last year's state tax.
- [x] Bundled brackets for NY (2026, IT-2105-I), NJ (statutory), OR (2026
      OR-ESTIMATE), MN (2026 DoR), HI (2026 Act 46 schedule + doubled standard
      deduction), and — same day — VA, MD (2025 tiers + 2% gains surcharge),
      OH (2026 flat), WI (2025, sliding deduction), CT (exemption phase-out),
      SC (2026 Act 110: two brackets, SCIAD, 44% LT exclusion), DC (2026
      D-40ES). One `StateTable` each in `engine/tax.ts` with a vintage, a
      "what's not modeled" note the UI prints, and optional hooks for
      income-dependent deductions, exclusions, and surcharges. 13 states are
      bracketed, 9 have no tax, 15 are flat; the custom rate remains the
      fallback for the 14 left (AL AR DE KS ME MO MT NE NM ND OK RI VT WV).
- [x] Remaining-year vests. Migration 13 adds an optional cadence to
      `unvested_positions` (`next_vest_on`, `vest_every_months`,
      `vest_qty_micro`); `projectVests` walks it to Dec 31 at today's price and
      the income lands in `incomes.rsuProjectedCents`. Since 2026-09-23
      `next_vest_on` is the schedule's anchor (the k-th vest is k × cadence
      months after it, never stepped from a clamped date); the next unrecorded
      vest is derived from the ledger's vest buys, so recording one rewrites
      nothing and deleting one makes it due again.
- [x] Qualified vs ordinary dividends: a `qualifiedDividendShareMicro` setting
      splits the 'Dividends & interest' category; the qualified part stacks with
      LT gains federally and stays ordinary for the state.
- [x] **Per-person paychecks** (2026-09-10; migration 14 `pay_sources`,
      `engine/paychecks.ts`, `POST/PUT/DELETE /paychecks`). One row per earner
      per employer, transcribed from the latest stub: a regular check's gross,
      401k, §125 benefits, federal/state withholding, plus the optional YTD
      column anchored on the stub's pay date. `projectPaySource` walks the
      cadence (weekly/biweekly/semimonthly/monthly; semi-monthly pairs d with
      d+15, month-end with the 15th) to Dec 31, so full-year wages and
      withholding are derived — the `wagesAnnualCents`/`withheld*Cents`
      settings only apply while no stub exists. Payroll taxes follow:
      Social Security capped per person (excess across employers is a credit),
      Medicare, and the Additional Medicare Tax owed on household wages over
      the filing-status threshold but withheld per employer above $200k — the
      two-earner gap lands in `fedGapCents`. Stock comp is attributed per
      earner through an optional `invest_account_id`; vests a stub's YTD can't
      vouch for get supplemental withholding at 22% federal / the state's
      flat rate (CA 10.23%, NY 11.70%), overridable in settings.
- [ ] 2026 CA brackets when the FTB publishes them. As of 2026-09-10 they are
      not out (the EDD's 2026 withholding tables still use 2025 thresholds), so
      `CA` in `engine/tax.ts` now carries the *official 2025* Schedules X/Y/Z and
      $5,706/$11,412 deduction (the previous table was actually 2024 data). The
      swap is one entry: four arrays, one deduction line, one vintage string.

## 2 — Digest & proactivity

**Shipped 2026-08-27** (`engine/recurring.ts`, `engine/digest.ts`,
`server/api6.ts`, `server/rates.ts`, `src/DigestCard.tsx`,
`src/RecurringCard.tsx`) — as an in-app "Since you were last here" panel,
which works in BOTH modes (per-person high-water mark in app_meta rides the
snapshot, so local/ZK gets the identical digest).

- [x] Recurring-transaction detection: merchant groups via extractMerchant,
      cadence bands (weekly→yearly) gated on gap consistency, same-day charge
      collapsing, lapse + price-creep flags. Nothing stored — always derived.
- [x] Digest on Dashboard: net-worth delta + top drivers vs baseline month,
      new/uncategorized arrivals (by created_at), new recurring merchants,
      price creep, possible cancellations, allocation drift ≥3pp, budget
      overruns, 30-yr mortgage-rate trigger vs best saved loan option
      (Freddie PMMS via FRED fredgraph.csv — freddiemac.com 403s datacenter
      IPs). "Caught up" resets the mark; same-day re-surfacing only on
      genuinely new arrivals.
- [x] "Safe to spend this month" on Cash: budget − spent − recurring bills
      still expected this month (no double counting once a bill posts), with
      the Recurring & subscriptions table.

Follow-ups (not blocking):

- [ ] Email delivery of the same digest (Cloud Scheduler + OIDC through IAP +
      an email provider key). The digest computation is already a pure
      (db, email, today) function — the job only needs to render and send.
- [ ] Semi-monthly payroll (1st/15th) currently reads as biweekly — treat as
      its own cadence if it matters for safe-to-spend income.

## 3 — Decision engine (Future v2)

**Shipped 2026-09-03** (`engine/scenarios.ts`, `engine/history.ts`,
`engine/simulate.ts`, `server/api7.ts`, `src/screens/Future.tsx`; migration
#11 `scenarios`). Design decisions taken: a proper `scenarios` table rather
than a goal_settings blob; overlay chart (all medians, bands for the selected
one) + side-by-side table rather than small multiples; crossing date = the
earliest retirement year with ≥ threshold odds (default 90%, adjustable),
re-running the sim per candidate year; historical returns bundled as a
constant (Damodaran nominal ÷ CPI-U, 1928–2025) and block-bootstrapped in
10-year runs, re-centred to the scenario's mean/σ so the comparison with
lognormal isolates sequence risk rather than asset mix.

- [x] Scenario objects (named knob-sets, persisted in `scenarios`), compared
      side by side: retire 55 vs 60, buy in '27 vs '29. Balance sheet and
      dream-home terms are resolved from the ledger at read time, never stored.
      Baseline is explicit; every other scenario reports deltas against it.
- [x] Historical bootstrap sampling alongside lognormal draws (global toggle so
      all scenarios stay on the same footing; same seed either way).
- [x] Headline "crossing date": earliest retirement year clearing the odds
      threshold — yearly resolution, since the sim steps yearly.
- [x] Price-a-decision: any dated cash flow (one-off or yearly until a year)
      priced against a scenario — future value at retirement, odds before →
      after, median-at-end delta — and saveable into the scenario as an event.
- [x] Tests (17): events, recurring windows, historical determinism +
      re-centring, crossing-year monotonicity, CRUD/validation/baseline
      promotion, sql.js parity + snapshot round-trip.

Follow-ups (not blocking):

- [ ] Carry-vs-payoff as a first-class event: "pay off $X of mortgage in year
      Y" should also drop the liability and its amortization, not just the
      liquid side (events only touch liquid today).
- [ ] "Price a decision" entry points on other screens (Dream Home, Real
      estate) posting to `/api/scenarios/price` with the amount pre-filled.
- [ ] Monthly stepping (crossing *month*), and an age axis — needs a birth year
      setting.
- [ ] Sliders for the mockup's "levers" card; the knobs are text inputs today.
- [ ] Bond/cash sleeve in historical mode (the record is 100% US stocks,
      re-centred; a blended record would let σ come from the mix rather than
      the knob).

## Zero-knowledge front door & price basket

**Shipped 2026-09-09** (`src/FrontDoor.tsx`, `src/session.ts`, `server/basket.ts`,
`server/api8.ts`, `engine/services.ts` applyBasket, `shared/vault.ts` sealVault;
migration #12 `basket_quotes`). Verified end to end: start empty → add data in
the tab → save → the only server write is `PUT /api/vault` with ciphertext →
reload → unlock → data restored, with the server's user tables never touched.

- [x] Boot-into-local-from-vault + start-empty front door (shown only when the
      server holds no plaintext), unlock in-tab, household escape hatch.
- [x] Reseal-on-save under the data key kept from unlock — no new recovery key
      minted every save; passphrase asked once.
- [x] Daily price basket: whole US-listed universe + top crypto, fetched once a
      day (NASDAQ Trader + Yahoo spark/v7 + CoinGecko markets), served whole and
      identical to every caller; local/ZK refresh picks its own symbols out.
- [x] Tests: directory parsing, spark/v7/coingecko parsers, once-a-day build
      guard, applyBasket, vault reseal round-trip.

Follow-ups (not blocking):

- [ ] **Anonymous add** for off-universe symbols: an identity-opaque, delayed,
      chaffed request that widens the basket without linking a symbol to a
      person. (Deferred by decision — the whole-universe basket already covers
      ordinary US holdings, and since 2026-09-23 a fund or private stock can
      take a hand-entered price.)
- [x] ZK *monthly* history (2026-09-23): the shared market history file,
      ten years of month-ends for the whole basket, identical for every caller
      (`server/history-pack.ts`, `GET /api/basket/history`).
- [ ] ZK *daily* history: hashed symbol buckets so a client fetches 1-of-N
      buckets instead of naming the ticker (Safe-Browsing style) — only once
      the monthly file has proved itself. A tab's daily chart is month-ends
      plus the basket quotes it has collected.
- [ ] Migrate household price refresh onto the basket path too (one code path);
      today `POST /api/prices/refresh` still fetches held symbols per-symbol.
- [x] Passkey-only vault v2 (WebAuthn PRF; no passphrase; typed recovery
      code) and the household member flow — DESIGN.md roadmap #2 and #3,
      2026-09-15. Still not exercised on a real authenticator (the 2026-09-23
      pass used CDP virtual authenticators): verify create → unlock → add
      member on a Mac + iPhone before the vault-only deploy.
- [ ] Live basket build couldn't run from the build sandbox (egress 403s to
      nasdaqtrader.com / coingecko); verify a real build on the deployment.

## Milestone: re-import from scratch through the vault (2026-09-09)

The site becomes vault-only and the household's data is re-entered through the
front door (start empty → accounts → statements → trades/properties/liabilities
→ save). Done so far:

- [x] Snapshots hold household data only: `vault_blobs` and the basket
      (`basket_quotes`, `basket:*` app_meta keys) are out of `TABLES`. Before
      this, every household backup nested the previous ciphertext inside the new
      blob, and a restore rolled the vault version back. (Since 2026-09-23
      vault_history, household_members, vault_invites and the dead
      onchain_daily are out too.)
- [x] `SCARAB_ZK_ONLY=1` server: only me/health/mode/vault/basket routes
      answer (the allowlist now lives in `server/zk-routes.ts`, and since
      2026-09-23 also covers vault history, invitations and the market
      history); boot refuses plaintext data unless `SCARAB_PURGE_PLAINTEXT=1`
      wipes it once; `/api/mode` reports it and the front door drops the
      household escape hatch. Tests in `server/app.test.ts`.

Still needed for the milestone:

- [ ] **Deploy vault-only**: download a plain export of the current site as a
      keepsake, then `SCARAB_ZK_ONLY=1 SCARAB_PURGE_PLAINTEXT=1 ./scripts/deploy.sh`
      (put `SCARAB_ZK_ONLY=1` in `.env.gcp` so later deploys keep it).
- [x] **Autosave in a session** (2026-09-15, `src/session.ts`): once a session
      key exists, every write reseals + PUTs after a 1.5s debounce, or at once
      when the tab is hidden. Saves are serialized; writes that land mid-upload
      keep the tab dirty for the next one. A version conflict (another device
      saved first) is sticky and shown, not retried — a manual save or a fresh
      unlock clears it.
- [ ] Verify the basket builds on the real deployment (see above) — and the
      market history build, which needs a CPU decision (DESIGN.md §6).
- [x] Gzip before encrypt (2026-09-23): vault format v3 frames the plaintext
      as [length][gzip][zero padding to a size bucket] inside the encryption —
      a snapshot-shaped 2.5 MB dump stores at under a quarter of its size, and
      the stored size only tells a bucket.
- [x] Format v3 authenticates the header and the version it was sealed for;
      each device remembers the last version it saw and asks before opening an
      older copy (2026-09-23).
- [x] RP ID pinned in code: passkeys use `scarab.one` on scarab.one and its
      subdomains (2026-09-23). **Decision still open**: map scarab.one before
      the real vault exists — a `run.app` host binds passkeys to itself.
- [ ] Snapshot fixture: deliberately none until production (the v17 fixture
      step was cut). At the production cut: freeze that version's fixture and
      lower `SNAPSHOT_COMPAT.minReadable` to it (`engine/fixtures/README.md`).
      Until then every migration (#18–#21 this pass) leaves earlier dev vaults
      unreadable.

## Improvement pass — shipped 2026-09-23

One plan (a foundation, then five streams — zero knowledge and two people,
brokerage, analytics, UI shell, charts), an integration round, and a
six-dimension adversarial review whose 34 confirmed findings were fixed.
Migrations #18–#21. DESIGN.md §7 has the roadmap view; this is the checklist.

- [x] **Shell**: hash router (`src/router.ts`) — Back/Forward, reload stays
      put, deep links to sections and `?d=` actions; fragments carry only ids,
      enums and months (tickers and search text ride in route state). Screens
      kept alive in `<Activity>` and code-split. `src/ui` primitives replace
      every native dialog; every save and failure toasts; labelled fields
      with integer parsing; view-transition crossfades that honour reduced
      motion; ⌘K command palette.
- [x] **Zero knowledge, two people**: one save queue (browsing never makes a
      vault version; offline edits save on their own; 409/413 sticky);
      following the other member (45s poll, in-place refresh, conflict sheet
      with Take theirs / Keep mine / Download mine); "saved by"; vault format
      v3 (above); create never overwrites, and delete is owner-only and typed;
      members panel with passkeys bound to identities; consent-based
      invitations, one per household (#20, #21); removal = re-key + history
      purge; a fresh passkey to show the recovery code, which gained a check
      group; version history with preview and restore (#20); encrypted
      `.scarab` backups; idle auto-lock; request body caps; a throttled basket
      rebuild.
- [x] **Brokerage**: lots pooled per account (a Roth's gains stay off the tax
      bill), the anniversary rule, trades validated before any write; account
      profiles (#18) with strip, drawer and guided add; a record-trade sheet
      previewing gain, estimated tax and wash sales (upcoming vests included);
      an activity ledger with edit and delete; pasted starting positions with
      true acquisition dates; hand-entered prices; balance accounts, the
      check-in and stale chips; the cash anchor; net-settlement vests; symbol
      search over the basket (#19 names); owner pills; the realized-gains
      report with a Form 8949-shaped CSV.
- [x] **Analytics**: the series API (`engine/analytics.ts`: catalog, saved
      views shared through the vault); return by holding (money-weighted,
      XIRR); monthly TWR for accounts, holdings and sets vs `bench:<SYM>`; the
      shared monthly market history for ZK tabs; month-end stamping of
      monthly bars; basket names; the sql.js statement cache.
- [x] **Charts**: TimeChart behind every trend (UTC axis, multi-series
      crosshair, legend toggles, presets, drag-to-zoom, keyboard); the Compare
      screen (values, rebased, % change, A−B; Performance preset; saved
      views); the Dashboard to the mockup (grouped tiles with sparklines,
      Total/Breakdown, dream-home tile, clickable activity, digest driver
      bars); portfolio value vs. cost; return-by-holding bars; a fixed price
      chart, donut and axes.
- [x] **Hardening from the review**: a re-key or create whose answer is lost
      still shows (or keeps owing) its new recovery code; restoring an old backup can't resurrect a retired key;
      Keep mine checks for an older copy; number boxes never hold a stale
      value; netWorthSeries 5–15× faster; JSON errors instead of opaque 500s;
      deadlines on every upstream fetch; a 64 MB restore cap; per-symbol price
      flags cleared with their asset; crypto exempt from wash-sale flags.
- [x] **Performance attribution** (from the backlog): XIRR per holding, TWR
      per account/holding/set, benchmarks, overlaid in Compare.

## Open follow-ups from the 2026-09-23 pass

Decisions for the user:

- [ ] **Production origin** before the real vault: scarab.one (user setting
      it up 2026-09-24). Passkeys bind to the hostname for life, and the RP ID
      pin to scarab.one is already in src/passkey.ts.
- [x] **`--ink-3` contrast**: now #828893, 4.84:1 on `--card` (2026-09-24).
- [x] **First market-history build** (2026-09-24): built locally with
      `npm run seed:history` into `seed/history-pack.json.gz` (gitignored:
      Yahoo-derived data; shipped via `.gcloudignore` + Dockerfile), stored at
      boot by `seedHistoryPack` when newer than the server's. Re-run and
      redeploy to refresh it.
- [ ] Monthly rebuilds on Cloud Run still crawl under request-based CPU (the
      served file stays current meanwhile via daily basket merges). If that
      matters: `--no-cpu-throttling` or a scheduled ping; never `--max-instances`.
- [x] Money trend charts fit the data (TimeChart default `baseline="fit"`;
      stacks keep $0) and carry a Lin/Log switch (2026-09-24).

Engineering:

- [ ] **Restores over 32 MiB**: Cloud Run's front end refuses larger request
      bodies before the app's 64 MB cap. Needs a gzipped upload
      (Content-Encoding) from `src/screens/vault/Backups.tsx` and server
      support in `server/api4.ts`.
- [ ] **Owner-scoped money-weighted rates**: `getHoldingsReturns(db, today,
      accountIds?)` in `engine/returns.ts` plus `?accounts=` on
      `GET /api/portfolio/returns` (server/api10.ts and the tab's
      routes-analytics.ts). Then HoldingsReturnsCard can drop its "held
      outside this scope → no rate" fallback.
- [ ] **Declare production**: freeze the first snapshot fixture and lower
      `SNAPSHOT_COMPAT.minReadable` (see the milestone above). The
      'pre-upgrade' history pin can't fire until then.
- [ ] Household mode's Future cache sees only this tab's own server writes;
      the other member's changes show after a reload.
- [ ] `useAnchor` should follow a section until the page settles on every
      screen (Cash does it with its own `useSettleOnSection`).
- [ ] End session reloads without waiting for an upload in flight (Lock does
      wait); `toast.info` can't take a `detail`.
- [x] Holdings table at 1100px scrolled sideways inside its card — cost basis
      and % of cost now sit under Value and Unrealized (fits at 1100–1920 and
      in the account drawer).
- [ ] Drop the `NestedDialog` pass-through (BalanceAccounts.tsx,
      GrantsPanel.tsx, `.inv-nested`) now that Dialog ignores bubbled events.
- [ ] A fresh-load deep link that opens two dialogs at once (a trade sheet over
      an account drawer) closes both on one Esc (Chrome's close-watcher
      grouping).
- [ ] Taxes still estimates RSU withholding at the flat supplemental rate.
- [ ] The 390px app shell doesn't collapse (screens themselves fit).
- [ ] Future's first compare (`POST /api/scenarios/compare`, 5 dev
      scenarios) takes 6–16 s over HTTP, mostly simulate + crossingYear;
      a cold `#/future?d=new-scenario` waits for it before opening.
- [x] `prompt()` text fields prefill the default with the caret at the end
      (src/ui/dialogs.tsx), so typing a name appends to it — an untouched
      default is now selected on focus.
- [ ] Household Data & Vault logs a console 404 for `GET /api/vault` ("no
      vault yet" is its signal); answer 200 `{vault:null}` instead.
- [x] Unknown `/api/*` paths (or a listed path with an unhandled method) fall
      through to the SPA fallback: 200 index.html instead of a JSON 404/405.
      Now a JSON 404 (`server/app.ts`, tested in both modes).
- [x] Starting-positions placeholder mixes tab, comma and space separators,
      but `parsePositions` picks one per paste — pasting it verbatim fails.
      Now one separator, with a test that the placeholder parses as shown.
- [ ] The trade sheet's symbol box and Holdings can show different last
      prices for the same symbol (seen: VTI $381.27 vs $378.23).
- [x] Price upserts rewrite identical closes, so every refresh moves the tab's
      `dataRevision` and re-runs Future's compare even when nothing changed.
      Fixed with `WHERE close_cents IS NOT excluded.close_cents` (parity-tested).
- [ ] The member-passkey "Add it now" (QR/hybrid) path is untested — the pass
      used one CDP virtual authenticator per tab.

## Cut from the 2026-09-23 plan (revisit later)

- [ ] Brokerage CSV import — wait for real redacted exports; build a generic
      column mapper. (Starting-positions paste covers onboarding.)
- [ ] Stock splits: an `asset_events` table, manual recording, basket-ratio
      detection. Rare and tax-critical.
- [ ] Close account / transfer lots between accounts.
- [ ] Dividends inside brokerage accounts (`invest_income`) — now that the cash
      anchor exists; needs a migration and tax changes.
- [ ] Asset classes and custom groups (the #18 owner column is in).
- [ ] Modified-Dietz returns for balance-tracked accounts — needs contribution
      facts that don't exist yet.
- [ ] `created_by` on trades, a change log, a "who changed what" digest.
- [ ] Change-journal replay, a member-2 onboarding wizard, per-member key
      pairs (L+ for rare events).
- [ ] Holdings small multiples, drawdown panel, waterfall attribution, a tax
      bracket bar, synced crosshairs, a table view / CSV copy of any chart, and
      moving BigChart onto TimeChart.
- [ ] Chart annotations (a table plus derived markers) — see life events below.
- [ ] A daily ledger-sweep engine — revisit with profiling (monthly series
      suffice; netWorthSeries was made fast instead).

Decided against, with the reason (don't redo without a new one):

- Tickers and search text in the URL — browser history sync uploads fragments.
- Nav as `<a>` (cmd-click opens a tab) — would spawn self-conflicting ZK
  sessions; deep links still work through the hash.
- A `VITE_SCARAB_ZK` build flag — can't pass through `gcloud run deploy
  --source`; a proper ZK build target belongs to the trust chain.
- Removing `basket/rebuild` from the ZK allowlist — it is the only rebuild path
  there; throttled instead.
- A `useApi` cache — keep-alive screens already show stale data while they
  revalidate.
- Global topbar range pills — daily and monthly series don't line up; each
  chart has presets.
- Generic undo toasts / `restoreRows` — typed confirms plus vault history cover
  recovery.
- Taxes autosave — 13 interdependent settings would recompute and write the
  vault on half-typed input; explicit save with a dirty marker instead.
- Household name, and avatars from passkey labels — labels are free text;
  avatars come from the members list.
- Converting the inline styles, centring the grid, an animated segmented
  thumb, Taxes/Vault tabs, card stagger, app-wide count-ups, rAF tweens, a
  donut sweep — churn or motion overreach.
- A separate benchmark route (superseded by `bench:` over the market history)
  and an `invest_cash` table (superseded by the cash anchor).
- Incremental daily price fetch — the full refetch keeps split adjustment
  consistent.

## Backlog: smaller, high leverage

- [x] Performance attribution on Invest — shipped 2026-09-23 (above): a
      money-weighted rate per holding and for the household total, TWR per
      account. Still open within it: a money-weighted rate per account or
      owner (see the owner-scoped follow-up).
- [ ] Life-event annotations on the net-worth chart (dated facts deserve a
      memory: "bought the car", "changed jobs").
- [ ] Continuity export: "if something happens to me" document generated from
      the ledger (accounts, institutions, recovery-key locations). Pairs with
      the two-member vault roadmap item.
- [ ] Trust chain (DESIGN.md roadmap) treated as a headline feature of
      scarab.one, not a chore: reproducible builds + attestations are the
      differentiator.
