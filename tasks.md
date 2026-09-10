# Scarab — tasks

Product backlog, distilled from the 2026-08-27 product review. Framing from
that review: Scarab is an excellent *instrument panel* (what is true?) and the
leap to indispensable is becoming a *copilot* (what should we do?). Everything
below follows the house invariants: facts in the ledger, everything else
derived; integer cents; tax/analysis math lives in `engine/` (isomorphic) so
it works identically in household and zero-knowledge modes.

Ordering rationale: tax layer first (largest concrete dollar value, builds on
the lot engine — our strongest asset), digest second, decision engine third
(biggest win, most design-heavy). All three shipped; what's left is follow-ups
and the smaller backlog below.

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

Follow-ups (not blocking):

- [ ] State estimated-payment schedules (CA weights 30/40/0/30) — federal-only today.
- [ ] Bundle brackets for more progressive states (NY, NJ, OR, MN, HI…) — custom
      marginal rate is the fallback today.
- [ ] Project remaining-year vests into the income picture (needs a vest
      schedule; unvested_positions has no dates).
- [ ] Qualified vs ordinary dividend split (all treated as ordinary today).
- [ ] 2026 CA brackets when the FTB publishes them (currently 2025; HoH estimated).

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
      ordinary US holdings.)
- [ ] ZK daily-history charts: hashed symbol buckets so a client fetches 1-of-N
      buckets instead of naming the ticker (Safe-Browsing style). Charts are
      as-of-snapshot in local mode today.
- [ ] Migrate household price refresh onto the basket path too (one code path);
      today `POST /api/prices/refresh` still fetches held symbols per-symbol.
- [ ] Persistent unlock (non-extractable CryptoKey in IndexedDB; then
      WebAuthn-PRF passkey, vault v2) — DESIGN.md roadmap #2.
- [ ] Live basket build couldn't run from the build sandbox (egress 403s to
      nasdaqtrader.com / coingecko); verify a real build on the deployment.

## Milestone: re-import from scratch through the vault (2026-09-09)

The site becomes vault-only and the household's data is re-entered through the
front door (start empty → accounts → statements → trades/properties/liabilities
→ save). Done so far:

- [x] Snapshots hold household data only: `vault_blobs` and the basket
      (`basket_quotes`, `basket:*` app_meta keys) are out of `TABLES`. Before
      this, every household backup nested the previous ciphertext inside the new
      blob, and a restore rolled the vault version back.
- [x] `SCARAB_ZK_ONLY=1` server (`server/app.ts`): only me/health/mode/vault/
      basket routes answer; boot refuses plaintext data unless
      `SCARAB_PURGE_PLAINTEXT=1` wipes it once; `/api/mode` reports it and the
      front door drops the household escape hatch. Tests in `server/app.test.ts`.

Still needed for the milestone:

- [ ] **Deploy vault-only**: download a plain export of the current site as a
      keepsake, then `SCARAB_ZK_ONLY=1 SCARAB_PURGE_PLAINTEXT=1 ./scripts/deploy.sh`
      (put `SCARAB_ZK_ONLY=1` in `.env.gcp` so later deploys keep it).
- [ ] **Autosave in a session**: once a session key exists, reseal + PUT after
      each write (debounced). Importing is dozens of steps; a closed tab loses
      them all today.
- [ ] Verify the basket builds on the real deployment (see above).
- [ ] Then: two-member vault (partner sees "Nothing here yet" — blobs are
      per-email), gzip before encrypt (10MB blob cap), persistent unlock.

## Backlog: smaller, high leverage

- [ ] Performance attribution on Invest: TWR/IRR per account and total, vs a
      hold-SPY benchmark (trades + daily prices already suffice).
- [ ] Life-event annotations on the net-worth chart (dated facts deserve a
      memory: "bought the car", "changed jobs").
- [ ] Continuity export: "if something happens to me" document generated from
      the ledger (accounts, institutions, recovery-key locations). Pairs with
      the two-member vault roadmap item.
- [ ] Trust chain (DESIGN.md roadmap #5) treated as a headline feature of
      scarab.one, not a chore: reproducible builds + attestations are the
      differentiator.
