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
shell, charts — see its section below). Next is the **copilot layer** (§4,
planned 2026-09-30): findings that show their work (4a) and contribution
pace (4b), a Future that knows about taxes and account types (4c) and
target allocation (4d) and the two-year tax view (4e) — the whole copilot
plan — all shipped 2026-10-01. Next: the gap list after it, the follow-ups,
the vault-only milestone and the backlog.
Around it: follow-ups and the backlog at the end (the vault-only milestone
is done).

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
- [ ] Monthly stepping (crossing *month*). (The age axis shipped with 4c,
      on the birth years set on Taxes.)
- [ ] Sliders for the mockup's "levers" card; the knobs are text inputs today.
- [ ] Bond/cash sleeve in historical mode (the record is 100% US stocks,
      re-centred; a blended record would let σ come from the mix rather than
      the knob).

## 4 — Copilot layer (planned 2026-09-30)

Framing from the 2026-09-30 review: the instrument panel is done and the tax
layer already beats most consumer tools; what's missing is the layer that
answers "what should we do" — the copilot the 2026-08-27 review asked for.
Goal: a household relies less on an advisor and a tax professional, without
Scarab ever giving advice. Every item below is derived at read time from the
ledger plus vintage-stamped constant tables, lives in `engine/` (isomorphic,
parity-tested), and shows its work.

Ordering rationale: findings first (cheapest — most of the facts already
exist), contribution pace second (one constants table + the paystub cadence),
Future v3 third (the biggest modeling gap: `engine/simulate.ts` has no tax and
one liquid bucket, so a 401(k) dollar counts like a Roth dollar), then
allocation (needs the asset-class item cut from the September plan).

**Constraint before any of it**: the real vault has existed since schema v21
(2026-09-25). Every migration here must keep v21 readable — freeze the fixture
and lower `SNAPSHOT_COMPAT.minReadable` (`engine/fixtures/README.md`) with the
first item that adds a table, and ship a tier-C upgrade for anything that
changes shape.

Design stance (decided): the layer is deterministic and cited. If a model is
ever added it explains Scarab's numbers on the client and never produces
them — a zero-knowledge server can't see the data, and an auditable rule is
the differentiator.

### 4a — Checkup: findings, not advice

**Shipped 2026-10-01** (`engine/checkup.ts`, `engine/itemize.ts`,
`engine/checkup-settings.ts`, `engine/assumptions.ts`, `server/api11.ts`,
`src/screens/Checkup.tsx`, `src/ui/Finding.tsx`, `src/cards/CheckupCard.tsx`,
`src/tax/BracketBar.tsx`). No migration: the seen mark is an app_meta key
(`checkup:seen:<email>`) and the settings a goal_settings blob (`checkup`),
both already in the snapshot.

A derived, prioritized list — the digest's shape, sorted by dollar impact —
on its own screen (`src/screens/Checkup.tsx`, nav + ⌘K entry) with the top
three echoed on the Dashboard. Nothing stored except a per-person "seen"
mark like the digest's. `engine/checkup.ts`: `getCheckup(db, today, reader)`
returns `{ findings: Finding[], headroom, calendar, settings, roles, seenAt }`,
each finding `{ id, kind, tone, title, impactCents, impactLabel, rule, inputs,
math, leavesOut, action, isNew }` (contract: `shared/checkup-api.ts`).

- [x] **The `Finding` primitive** (`src/ui/Finding.tsx`): one component that
      renders the five parts every finding must carry — the rule with its
      citation and vintage; your inputs; the arithmetic; what it leaves out;
      and the fixed line "an estimate, not advice — verify before acting"
      (`NOT_ADVICE` in the shared contract). Absorbing the scattered Note/Warn
      copy in Taxes is still to do (below).
- [x] **Assumptions page**: a card on the Checkup (`#/checkup/assumptions`,
      ⌘K) — brackets for the household's status, standard deductions, LT
      bands, surtaxes, payroll, capital-loss and wash-sale rules, itemized
      limits, safe-harbor rules, the gift exclusion, the household's state
      table, and the Checkup's own thresholds — each with source and vintage,
      read from the very tables the engine uses. Contribution limits and RMD
      ages join with 4b/4c.
- [x] **Concentration.** Employer stock (stock_plan accounts' assets, held
      anywhere) as a share of liquid and of total net worth, flagged alongside
      the paychecks linked to the same plan; unvested shares shown, not
      counted. Threshold is a setting (default 10% of liquid); impact is the
      value above it.
- [x] **Cash runway.** Bank balances + brokerage cash anchors against the
      trailing-12-month average spend (needs 3 months of history). Under 3
      months → finding (impact: the shortfall); over 12 → idle cash (impact:
      the excess), not counting accounts earmarked for the Dream Home fund.
- [x] **Bracket headroom.** The bracket bar is back (Checkup card): ordinary
      taxable income across the ordinary brackets, LT gains + qualified
      dividends stacked over the 0/15/20 bands, room to the next edge.
- [x] **Itemize vs standard, from the ledger.** `engine/itemize.ts`: mortgage
      interest from each rated loan's recorded balances (month by month,
      $750k debt limit), property tax and giving from category roles (guessed
      by name, set on the Checkup), state income tax from the estimate,
      SALT-capped per 2026 law ($40,400, phased down over $505k to $10k), the
      0.5%-of-AGI charitable floor. Taxes now uses the derived total when
      itemizing with nothing typed (`deductionSource: 'derived'`); a typed
      figure overrides. Finding either way: itemizing beats standard, or a
      typed total is under it.
- [x] **Give appreciated shares, not cash.** Trailing-year giving vs the
      long-term taxable lots with the most gain per dollar; priced as the
      exact tax on that gain this year (NIIT included).
- [x] **Gain harvesting.** LT gain lots filling the room left in the 0% band;
      impact = 15% later − the tax now (state, NIIT). Silent when no wages are
      entered (everything would look like 0% room).
- [x] **Existing findings join the list**: loss harvesting (priced exactly,
      wash-flagged lots left out), federal and state safe-harbor shortfall,
      the additional-Medicare gap, allocation drift (unpriced until 4d gives
      it a target), recurring price creep (annualized), the mortgage-rate
      trigger (priced on the Dream Home loan). Each keeps its home card and
      deep-links to it (`#/tax/harvest`, `#/tax/safe-harbor` are new anchors).
- [x] **Tax calendar.** Upcoming estimated-payment installments with amounts
      (federal + state), Dec 31 (payroll deferrals, trade date for the year),
      Apr 15 (IRA/HSA contributions, the return), and a Form 709 date for any
      gift-category transaction over the $19,000 annual exclusion.
- [x] **Tests**: `engine/checkup.test.ts` (each finding fires and stays
      quiet, impact ordering, per-reader seen mark, snapshot round-trip of the
      mark, itemize math, assumptions) and `engine/parity-checkup.test.ts`.

Follow-ups:

- [ ] Fold Taxes' Note/Warn explanations into `Finding`-style "show the work"
      over time (the safe-harbor and harvest cards first).
- [ ] Mortgage interest holds balances flat between recorded entries; an
      amortization from the payment (or the 1098 figure as an override) would
      be exact. Property tax paid from escrow never reaches a category.
- [ ] Not modeled in `computeTax`: the 2026 non-itemizer charitable deduction
      ($1,000 / $2,000 MFJ) and the 2/37 cap on itemized deductions in the 37%
      bracket — both named in the itemize finding's "leaves out".
- [ ] Local mode keys the seen mark 'local' until the tab knows its identity
      and, unlike the digest, doesn't inherit it after.
- [ ] Checkup lives under More on the phone tab bar; revisit if it earns a tab.

### 4b — Contribution pace & limits

**Shipped 2026-10-01** (`engine/contributions.ts`, `engine/people.ts`,
`engine/checkup-contributions.ts`, `src/tax/ContributionsCard.tsx`;
migration 23, tier B). Limits verified against IRS Notice 2025-67 and Rev.
Proc. 2025-19.

- [x] **Limits table** next to the brackets in `engine/tax.ts`
      (`LIMITS_2026`, `ROTH_IRA_PHASEOUT_2026`, one `LIMITS_VINTAGE`):
      deferrals $24,500 + catch-up $8,000 (50+) / $11,250 (60–63), the $150k
      Roth-catch-up wage line, §415(c) $72,000, IRA $7,500 + $1,100, HSA
      $4,400 / $8,750 + $1,000 (55+), Roth IRA phase-outs by status. On the
      Assumptions page too.
- [x] **Pace from paystubs.** Migration 23 adds the stub's Roth 401(k) line
      (+ YTD) and the employer match (rate, up to a share of pay, true-up).
      Each plan's checks are walked to Dec 31 — the estimated checks so far
      too, when no YTD column is entered — stopping at the person's limit;
      the card shows the pace, the date the limit is reached and the match
      it costs. Findings: room left (priced as income tax deferred), the
      match that stops at the limit, the match left unclaimed, two jobs over
      the limit together. HSA is a per-person setting (coverage + planned
      contributions; family coverage is one shared limit).
- [x] **Backdoor Roth flag**: income over the phase-out start → a finding
      naming the mechanics and the pro-rata rule, priced as the tax the
      `ira`-subtype balances in each person's name would add to a conversion
      (owner-less IRAs are listed, not guessed, when there are two people).
- [x] **Birth year per person** — `goal_settings` 'people' (with HSA
      coverage), edited on Taxes' Contribution pace card; drives catch-ups
      now and 4c's age axis / RMD age next.

Follow-ups:

- [ ] Taxes still projects pre-tax deferrals per check without the limit, so a
      stub-based year that would pass $24,500 understates taxable wages; feed
      the pace's capped figure into `computePayroll`.
- [ ] IRA contributions aren't read from the ledger (they're transfers or
      trades), so there's no IRA "room" finding — only the limit and Roth
      eligibility.
- [ ] The match model is per check with no vesting; no mega-backdoor
      (after-tax) line yet, so §415(c) is computed but never fires.

### 4c — Future v3: taxes, buckets, age

**Shipped 2026-10-01** (`engine/simulate.ts` `simulateTaxed`, `engine/simtax.ts`,
`engine/buckets.ts`, `engine/scenarios.ts`; Future's "Taxes & income" card).
No migration: the new knobs live in the scenario's params JSON and old
scenarios read with defaults (tax model on, taxable-first, 1% advisor fee).

- [x] **Three buckets** resolved from account subtypes at read time:
      taxable (bank, brokerage, crypto, stock plans; basis from the lots,
      balance-tracked taxable taken at value and listed), traditional
      (401k/403b/ira, and untyped retirement accounts), Roth; HSA as Roth by
      default, a scenario knob flips it. This year's pre-tax deferrals + match,
      Roth deferrals and planned HSA (from 4b) split each year's savings.
- [x] **Tax the paths.** Each sim year runs through federal (brackets, LT
      stacking, NIIT) + state at this year's tables, held constant (real
      dollars, indexed tables). Traditional draws are ordinary income,
      taxable sales realize gain pro rata to basis, Roth is free; draws are
      grossed up for their own tax. Working-year flows (a down payment, a
      conversion) stack on today's ordinary income. Results add the median
      lifetime tax, end buckets, and an **after-tax end** (traditional taxed as
      an heir draws it over ten years; taxable steps up) so a conversion is
      compared fairly.
- [x] **Withdrawal order**: taxable-first (default), pro rata, or fill a
      chosen bracket with traditional first.
- [x] **Roth conversions**: a window of years, a fixed amount or "fill to the
      top of the N% bracket"; shown as the delta in lifetime tax and in the
      (after-tax) median end.
- [x] **RMDs** from the traditional bucket at 72/73/75 by birth year (Uniform
      Lifetime Table, IRS Pub. 590-B), taken whether or not spending needs
      them; the excess is reinvested in taxable.
- [x] **Social Security** per person: the benefit at full retirement age and a
      claiming age 62–70, adjusted early/late (42 U.S.C. §402); taxable share
      by provisional income (IRC §86). Scenarios compare claiming ages.
- [x] **Age axis + birth year**: crossing age beside the crossing year and the
      retirement age in the side-by-side table (oldest birth year).
- [x] **Advisor-fee counterfactual**: an AUM-drag knob (default 1%) run
      alongside each scenario; its cost is a column.
- [x] **Tests**: `engine/future-tax.test.ts` (rules tables, buckets from
      subtypes, tax-on-path monotonicity, RMDs whether or not needed,
      conversions shrinking them, determinism, sql.js parity); the existing
      simulator and scenario tests pass unchanged.

Follow-ups:

- [ ] Each spouse's own RMD schedule and traditional balance (one bucket,
      the oldest birth year's RMDs, today); spousal Social Security.
- [ ] Not modeled: the 10% early-withdrawal penalty, IRMAA, the senior
      deduction, state rules for retirement income, dividend drag in taxable.
- [ ] The fan's x-axis could carry ages too (today only the crossing and the
      table do).
- [ ] Compare with taxes runs ~1.8 s for five dev scenarios (crossing search
      is linear); a bisection would cut it if it grows.

### 4d — Target allocation & tax-aware rebalancing

**Shipped 2026-10-01** (`engine/allocation.ts`, `src/invest/AllocationCard.tsx`;
migration 24, tier B).

- [x] **Asset classes**: us_stock, intl_stock, bonds, cash, real_estate,
      crypto, other — set per asset (`assets.asset_class`) or guessed at read
      time from a list of widely held funds, then the name (the basket's
      where the household server has it), then the kind. Bank and brokerage
      cash are cash; a balance-tracked account takes one class of its own
      (`invest_accounts.asset_class`, "other" until set). Property stays out.
      Custom groups on top: not done (follow-up).
- [x] **Target** per class (goal_settings 'allocation', must make 100%) and
      drift against it on Investments (`#/invest/allocation`); the digest's
      ≥3pp drift and the Checkup's drift finding read the target when there
      is one (and the Checkup prices how far off it is).
- [x] **Rebalance plan**: a year of new contributions (from the paystub pace)
      into the underweight first, then trades inside sheltered accounts, then
      taxable sales of the overweight lots from the least gain per dollar
      (losses first), the tax priced with `realizedTaxEstimate` on the year
      (the same exact delta `previewTrade` uses); wash-sale risk flagged per
      lot. Plus the **asset-location** finding: bonds in taxable while a
      traditional account holds stock, or bonds in Roth while stock sits
      elsewhere (municipal funds excepted).

Follow-ups:

- [ ] Custom groups (e.g. "small value", "employer stock") over the classes.
- [ ] Look through target-date and balanced funds (today one class, "other",
      unless set) — a stock/bond split per fund would be better.
- [ ] The plan sells within a class without choosing *which* fund to buy, and
      doesn't net buys and sells per account.

### 4e — Two-year tax view

**Shipped 2026-10-01** (`engine/twoyear.ts`, `src/tax/TwoYearCard.tsx`,
`#/tax/two-year`).

- [x] Next year on the same settings: each paycheck for a full year (pre-tax
      deferrals capped at next year's limit for the earner's age), the grants'
      scheduled vests after this year's (`projectVests` now walks past Dec 31),
      a year of dividends from the last twelve months, the same deduction, and
      this year's capital-loss carryforward flowing in by character (§1212(b):
      the $3,000 comes out of short-term first). This year's tables are held
      for next year. "Now or in January?" prices the same amount — a long- or
      short-term gain, a harvested loss, a bonus, a Roth conversion — in each
      year, over both years' tax, carryforward included (POST /api/tax/timing,
      read-like).

Follow-ups:

- [ ] This year's projection doesn't cap pre-tax deferrals at the limit (see
      4b); next year's does, so two otherwise identical years can differ by
      the tax on the excess.
- [ ] Next year's indexed tables when the IRS publishes them (bundle 2027 and
      let each year use its own).
- [ ] A Checkup finding when a timing choice is worth more than a threshold
      (e.g. a large loss lot whose harvest is worth far more this year).

### Gap list (after 4a–4e)

- [ ] **Liabilities beyond mortgages**: cards, student and auto loans
      (`liabilities.property_id` is already nullable; needs a kind, a minimum
      payment and a home off Real estate), then payoff-vs-invest at the
      after-tax return.
- [ ] **Equity comp beyond RSUs**: ESPP lots with the discount and qualifying
      vs disqualifying dispositions; ISO exercises with an AMT estimate and
      the disqualifying-sale escape; NSOs. Only if the household holds them.
- [ ] **Coverage & continuity**: life and disability need from income
      replacement (pay_sources and the ledger's spend), an umbrella threshold
      from net worth, a beneficiary checklist per account — pairs with the
      continuity export in the backlog below.
- [ ] **Fees**: expense ratio per fund if the basket can carry it (Yahoo's
      fund profile publishes one; verify from the deployment's IP), the
      weighted portfolio ratio, the drag as a Future event.
- [ ] **Gifting & 529**: annual-exclusion tracking from a gift category; a
      `529` subtype (today a 529 files under `other`) with its tax treatment
      (state deduction where bundled).

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

- [x] **Anonymous add** for mutual funds (2026-10-20): `POST /api/basket/suggest`
      names the wanted fund among 31 others drawn from the SEC's public-domain
      list of fund share-class tickers (`src/invest/fund-tickers.txt`,
      `scripts/fetch-fund-tickers.mjs`), seeded from the vault's key so a
      repeat names the same 32 and the server can't precompute the draw; sent
      after a random 30 s–10 min delay; the server adds all 32 to
      `basket:extra:asks` with no identity or time, as whole asks (never a
      symbol dropped on its own), quotes them from the next build. The draw
      indexes the whole list with rejection, so a basket change swaps one
      member, not the set; a sent ask is remembered in the vault
      (`ui:basket-asks`) so no device repeats it. UI: "Ask the basket to
      cover this fund" in the holding drawer → `#/invest/cover`. Residual,
      stated in PRIVACY.md: the server learns one-of-32 and when; popularity
      ranking, later bucket fetches, and the quotable subset visible in the
      basket can narrow it. CITs and private stock
      stay hand-priced (no public feed). Stronger alternative on the table:
      the whole SEC list in the basket (≈3× the files and crawls).
- [ ] Decoy daily buckets from a per-vault secret (blunts both the bucket
      and the suggest residuals; PRIVACY.md "Daily history").
- [ ] The whole SEC fund list in the basket, if the file sizes stop
      mattering — then `basket/suggest` goes.
- [x] ZK *monthly* history (2026-09-23): the shared market history file,
      ten years of month-ends for the whole basket, identical for every caller
      (`server/history-pack.ts`, `GET /api/basket/history`).
- [x] ZK *daily* history (2026-10-20): hashed symbol buckets — the universe
      dealt into 64 files by SHA-1 (`shared/buckets.ts`), two years of daily
      closes each, crawled on the budget the monthly file shares
      (`server/daily-buckets.ts`, `server/crawl-budget.ts`), served at
      `GET /api/basket/daily/:bucket`; a holding's chart fetches the bucket
      its symbol falls in, in memory only. PRIVACY.md "Daily history" has the
      numbers and the honest limit (popularity ranking inside a bucket).
      Possible hardening left: decoy buckets from a per-vault secret.
- [ ] Migrate household price refresh onto the basket path too (one code path);
      today `POST /api/prices/refresh` still fetches held symbols per-symbol.
- [x] Passkey-only vault v2 (WebAuthn PRF; no passphrase; typed recovery
      code) and the household member flow — DESIGN.md roadmap #2 and #3,
      2026-09-15. Exercised on real authenticators in 2026-10: the vault was
      created and unlocked with platform passkeys on scarab.one, and the
      second member enrolled through the QR (hybrid) prompt (until then only
      CDP virtual authenticators had run the ceremonies).
- [x] Live basket build couldn't run from the build sandbox (egress 403s to
      nasdaqtrader.com / coingecko); verified on the deployment — the basket
      serves the live vault's prices (the vault-only milestone below).

## Milestone: re-import from scratch through the vault (2026-09-09) — done

**Done by 2026-10-01**: the site is vault-only on scarab.one (`SCARAB_ZK_ONLY=1`
in `.env.gcp`), the household's data was re-entered through the front door
into a passkey vault (real data since schema v21, 2026-09-25), Nicole was
invited and joined, and the vault has been resealed at later schema versions
as they shipped. What the milestone needed:

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

- [x] **Deploy vault-only**: `SCARAB_ZK_ONLY=1` (kept in `.env.gcp`), the
      plaintext purged once.
- [x] **Autosave in a session** (2026-09-15, `src/session.ts`): once a session
      key exists, every write reseals + PUTs after a 1.5s debounce, or at once
      when the tab is hidden. Saves are serialized; writes that land mid-upload
      keep the tab dirty for the next one. A version conflict (another device
      saved first) is sticky and shown, not retried — a manual save or a fresh
      unlock clears it.
- [x] The basket serves the live vault's prices. The market history's
      monthly rebuild under request-based CPU is still a follow-up (below).
- [x] Gzip before encrypt (2026-09-23): vault format v3 frames the plaintext
      as [length][gzip][zero padding to a size bucket] inside the encryption —
      a snapshot-shaped 2.5 MB dump stores at under a quarter of its size, and
      the stored size only tells a bucket.
- [x] Format v3 authenticates the header and the version it was sealed for;
      each device remembers the last version it saw and asks before opening an
      older copy (2026-09-23).
- [x] RP ID pinned in code: passkeys use `scarab.one` on scarab.one and its
      subdomains (2026-09-23); the real vault was created on scarab.one.
- [x] Snapshot fixture: `snapshot-v21.json` frozen at the production cut
      (2026-09-25), replaced by `snapshot-v25.json` when the floor rose to 25
      (2026-10-01) — a rolling floor while there is one household vault
      (`engine/fixtures/README.md`).
- [x] Two people on one vault: Nicole invited, consented, enrolled through the
      QR (hybrid) prompt and unlocks with her own passkey (2026-10).

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

- [x] **Production origin**: scarab.one — the real vault and its passkeys
      live there.
- [x] **`--ink-3` contrast**: now #828893, 4.84:1 on `--card` (2026-09-24).
- [x] **First market-history build** (2026-09-24): built locally with
      `npm run seed:history` into `seed/history-pack.json.gz` (gitignored:
      Yahoo-derived data; shipped via `.gcloudignore` + Dockerfile), stored at
      boot by `seedHistoryPack` when newer than the server's. Re-run and
      redeploy to refresh it.
- [x] Monthly rebuilds on Cloud Run crawled under request-based CPU (the
      served file stayed current meanwhile via daily basket merges). Decided
      2026-10-20 for a scheduled trigger over `--no-cpu-throttling`:
      `.github/workflows/history.yml` → `POST /api/basket/crawl`
      (`server/crawl.ts`) runs the build inside the request, four minutes at a
      time, as the `scarab-history` service account (`scripts/history-sa.sh`,
      one-time). `--no-cpu-throttling` bills idle minutes, still loses the
      build at scale-to-zero, and starts nothing. Never `--max-instances`.
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
- [x] **Declare production**: v21 fixture frozen (2026-09-25); the floor
      followed the vault up to v25 on 2026-10-01 once the Session card's
      new schema readout showed it resealed there.
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
- [x] The member-passkey "Add it now" (QR/hybrid) path: verified on real
      devices 2026-10 — Nicole accepted the invitation and enrolled by scanning
      the owner's QR code.

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

## Debt — spelled out (2026-10-01)

Net worth used to keep debt in two places and never together: mortgages as
liabilities tied to a property, and credit cards as ordinary bank accounts
whose negative balance quietly lowered "Cash". One Debt view over both, each
stored the way its facts arrive (card balances from the ledger, loans from
statements).

- [x] **Credit card account type** (migration 27). Cards are created — or
      switched — as `credit` on Cash & budget, which now lists every account
      with its balance, its type and a **Set balance** (a card's is entered as
      the amount owed). Cards stay out of the dream-home fund picker and the
      asset allocation.
- [x] **Debt in net worth.** A `credit` part beside `liabilities` (loans), so
      `cash` is the bank alone and home equity is unchanged; `getNetworth`
      returns `debts`, one row per loan and card. Dashboard: an **Owed** list
      under the ring, "Cash = in the bank − on cards" beside "Home equity =
      value − mortgage" (ring and tiles show cash net of cards, so they still
      sum to net worth), and the Breakdown chart's Debt layer covers loans and
      cards. Compare gains `nw:credit` ("Credit cards") and `nw:debt`;
      `nw:liabilities` is labelled "Loans". The digest names card balances as
      a driver; Checkup's runway subtracts them; Future starts from cash net
      of them.
- [x] **Where the rest of the money went** (2026-10-02). Cash & budget's
      income-vs-spending is paychecks against spending, so a household whose
      stock and crypto sales land as transfers — and whose tax bills on them
      land as spending — looks like it spends what it makes. `MonthlyFlow`
      gains `tax_cents` (spending filed under the built-in Taxes category) and
      `moved_cents` (transfers out of the bank and card accounts net of
      transfers in: in-ledger moves cancel, so it is what went to or came from
      investments, crypto, people). The spending bar shows tax payments as a
      lighter top with "Net before tax payments" in its tooltip; the Savings
      card adds "Kept before tax payments", "Moved to investments & other
      accounts" and a line over the months on screen.
- [ ] **Loans not tied to a house** — car, student, personal, HELOC, a
      401(k) loan. A liability with no property, entered from statements like
      a mortgage: `liabilities.property_id` is already nullable and net worth
      and `listDebts` already count such a row, so it is mostly UI — where
      they're added and updated (today only Real estate, per property),
      a kind (auto/student/personal/heloc/401k/other), the rate and term for
      a payoff date, and an Owed row linking to it. Two things to fix with it:
      the Dashboard's home equity is `property + liabilities`, which would
      then subtract a car loan from the house (use property-linked loans
      only), and Future's `liabilitiesCents` is described as mortgages.
      Deferred: the household has no such loan (2026-10-01).

## Past sales, pasted (2026-10-02)

- [x] **Paste past sales** — shares sold before Scarab tracked them, each
      with its lot: `symbol, shares, cost basis, acquired, sale amount, sold`
      (a realized gain/loss page's columns; a header may reorder them).
      Cost basis and sale amount are each a total or per share (a toggle the
      sheet remembers per viewer); extra decimals are kept until the one
      rounding to cents. Every row is an explicit-basis sale
      (`createPastSales`, `POST /api/trades/sales`, all or none): the gain
      realizes with the lot's acquisition date setting the term, and the
      holdings are untouched. A dry run previews the engine's errors and
      warnings as you type — a lot of that symbol acquired that day already
      on the books (sell that lot instead), or a sale already recorded.
      Opened from the account drawer beside "Paste starting positions", and
      from Record trade when Sell is chosen.

## Vests: what the portal shows, and a reminder (2026-10-05)

- [x] **Vest… takes the shares received.** A "Tax withholding: Shares
      withheld / Shares received" toggle (remembered per viewer); with
      received, withheld = gross − received (`vestMath.withheldOf`), so a
      portal that shows only the net shares needs no calculator.
- [x] **Vests to record, in the digest.** `vestsDue` lists every grant whose
      next scheduled vest has passed unrecorded — a to-do, so it shows
      whatever the digest's window and "Caught up" doesn't clear it; it
      links to the account's Grants tab, and goes once Vest… records it.
      Vests are still never recorded automatically: the release's FMV and
      withholding are the facts the basis and the tax are computed from.

## The plan around a managed strategy (2026-10-11)

A tax-aware long/short account (AQR Flex, Parametric, direct indexing)
manufactures losses Scarab can only see as the broker's year-to-date figure
(migration 26). What the household needed on top was the *plan*: when money
went in, what the manager expects it to harvest, and how a sale planned for
January nets against it. Built generically — a managed strategy, not a
vendor — as inputs the user types, never as code: a plugin layer was
considered and rejected (the served JavaScript is the ZK trust root;
vault-stored code would run against the plaintext ledger and the unlocked
key, and can't be held to the engine's invariants).

- [x] **Deposits and withdrawals** (`account_flows`): the fact a balance
      history can't show; dated ahead, a planned deposit. The drawer's
      Deposits tab, with the deposits set against the latest balance.
- [x] **The harvest forecast** (`harvest_profiles`, `harvest_forecasts`):
      the manager's estimate — rates on new money by age, dollar figures for
      the standing book by year, the day given and the source — spread over
      the calendar (`engine/harvest.ts`). The drawer's Forecast tab, taxable
      balance accounts only; labelled an estimate everywhere it is read.
- [x] **Planned sales** (`planned_sales`): shares of a holding on a day
      ahead, at a typed price or today's quote, realized off the lots as they
      stand (FIFO, long-term by the planned day; warns when the holdings
      shrink under a plan). Entered on the capacity view.
- [x] **Loss capacity** (`engine/capacity.ts`, `GET /tax/capacity`,
      `#/tax/capacity`): reported + forecast losses against recorded +
      planned gains, netted year by year with the carry by character and the
      tax on what is left, on this year's tables; the chart (facts solid,
      forecast and plan dashed, each year from its carry-in), the per-year
      table, the managed accounts, how it was worked out and what it leaves
      out. The two-year view folds the plan into both columns (basis lines
      say so); the Projected tax card stays facts-only. Dream Home's
      carryforward fallback follows it.
- [x] **Floor to v27** once the vault was confirmed resealed there
      (`snapshot-v27.json` from `5fa224a`; the fixture script now covers a
      credit card and a broker-reported loss).

Follow-ups:

- [ ] A Checkup finding for a planned sale the losses won't cover by then.
- [ ] A money-weighted return for balance-tracked accounts now that their
      deposits are recorded (today only lots accounts have one).
- [ ] "Plan a sale…" from the holding drawer, prefilled.
- [ ] Future: a planned sale as a scenario event (proceeds net of the tax
      the capacity view prices) and its proceeds as a planned deposit.
- [ ] The forecast treats a withdrawal as not reducing it; a pro-rata
      reduction of the standing book would be the next refinement.

## A stranger's way in (2026-10-22)

Before open sign-up is switched on, a new household needs a way in: a vault
used to land on an empty Dashboard, and there was no way to see what Scarab
does before typing in real numbers.

- [x] **Setup checklist** (`engine/setup.ts`, `GET`/`PUT /api/setup`,
      `src/cards/Setup.tsx`): six steps read from the ledger at read time —
      a bank or card account with transactions, an investment account with
      holdings or a balance, a property, a paycheck, birth years for everyone
      the ledger names, filing status and state saved on Taxes (the defaults
      are an assumption until then; "That's right" saves them). Each links
      into the existing flow (`#/cash/import?d=add-account` or `?d=import`,
      `#/invest?d=add-account`, `#/re?d=add-property`, `#/tax?d=add-paycheck`,
      `#/tax/contributions`, `#/tax/settings`). The hero of an empty
      Dashboard; then a card in the attention row over `#/dash/setup`; gone
      when complete or hidden (a per-person app_meta mark, reversible from the
      detail view and ⌘K "Setting up").
- [x] **Sample household** (`engine/sample.ts`, `src/sample.ts`, "Look around
      with a sample household" on the front door's setup step): two earners
      (biweekly and semimonthly stubs, one with RSUs in a stock plan priced by
      hand), a house with a mortgage, a joint brokerage with long-held lots and
      monthly buys, a 401(k) and a 403(b) by statement balance, checking,
      savings and a card, two years of transactions filed by the seed rules
      plus a pasted few, a budget, a Dream Home goal, an allocation target —
      so every screen and nine Checkup findings have something to say. Built
      in the tab through the engine's write paths, deterministic per day;
      index funds take real month-end closes from the shared market history
      when the tab has it. A session `setVault` refuses: no save queue, no
      autosave, no upload, no "Leave site?"; badged in the topbar chip,
      sidebar and a banner; Data & Vault shows one card; "Leave the sample"
      reloads to the front door with the address bar cleared. The entry
      bundle grew 1.75 kB (badge, guards); the builder is its own chunk.
- [x] **Proof** (`e2e/sample.spec.ts`, `npm run test:egress` beside the
      egress proof, sharing `e2e/harness.ts`): open, browse, edit, background,
      leave — only GETs, only allowlisted paths, no vault stored, none of the
      sample's data in a request or in browser storage.

Follow-ups:

- [ ] "Connect your bank" as step one once in-tab SimpleFIN sync lands (only
      the bank step's action in `src/cards/Setup.tsx` changes).
- [ ] Cash's first-run account form overflows its card at 375px (the
      select runs past the edge) — seen while checking the checklist's link.
- [ ] The design mockup has no empty-household state or sample badge; add
      them when it is next re-cut.

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
- [x] Trust chain (DESIGN.md roadmap) treated as a headline feature of
      scarab.one, not a chore: reproducible builds + attestations are the
      differentiator. (2026-10-19: `build.json` manifest, two-build
      reproducibility check, digest-pinned image attested with Sigstore,
      deploy by verified digest, `verify-served.sh`, CSP; PRIVACY.md.)
