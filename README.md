# Scarab 🪲

Private household finance. Investments, real estate, cash
& budget, dream home purchase planning, and a Monte Carlo future — behind Google
Identity-Aware Proxy, for exactly the accounts you allowlist.

Start here: **`DESIGN.md`** (architecture, data model, decisions, roadmap),
**`PRIVACY.md`** (the zero-knowledge architecture and its limits),
`CLAUDE.md` (hard rules + design tokens; mockup link inside).

## Disclaimers
This is a personal project. The views, code, and opinions expressed here are my
own and do not represent those of my current of past employers.

**Nothing in this tool should be considered financial advice**. It is provided
purely for informational purposes. The authors of this code make no guarantee
about the accuracy of math, charts, prices, tax information, or estimates of
future numbers reported by the tool. Always do your own research.

## Local development

```bash
npm install
npm run dev        # client on :5173 (proxies /api), server on :8787
npm test           # vitest
npm run typecheck
```

The dev server uses a local `scarab.db` SQLite file (gitignored) and a fake
`dev@localhost` identity. No cloud anything required.

## Architecture

```
You → Identity-Aware Proxy → Cloud Run (this app) → SQLite ⇄ Litestream ⇄ GCS
       (Google sign-in,        (single instance,      (continuous backup,
        2-user IAM allowlist)   scales to zero)        point-in-time restore)
```

- **Auth**: IAP terminates Google sign-in before traffic reaches the app; the
  app reads the authenticated email from the `x-goog-authenticated-user-email`
  header. There is no auth code to get wrong.
- **DB**: one SQLite file, WAL mode, money as integer cents, append-only
  migrations in `server/db.ts`. Litestream streams every write to a private GCS
  bucket and restores on cold start. `--max-instances 1` keeps the single-writer
  invariant.

## First deploy

1. Create a project at console.cloud.google.com and attach billing.
2. `gcloud auth login`
3. `./scripts/bootstrap-gcp.sh <PROJECT_ID> you@… partner@…`
4. Walk the checklist the script prints (both accounts in, third account blocked).

After that, every deploy is just `./scripts/deploy.sh`.

## Costs

Cloud Run / GCS / Cloud Build free tiers cover 2-user scale. This is just an
estimate - your costs could vary based on usage and number of users.

## Roadmap

- **0 — Skeleton + fortress** (this): shell UI, health/identity wiring, IAP deploy.
- **I — Cash**: CSV/OFX import, dedupe, categorizer, income/spend, budget.
- **II — Investments & property**: trade ledger, tax lots, cost basis, EOD prices, valuations.
- **III — Dream Home**: fund tracking, real loan sheets, payment matrix, rental scenario.
- **IV — Future**: Monte Carlo with levers.

## Fonts

Marcellus (display face) is bundled as woff2, licensed under the
[SIL Open Font License](https://openfontlicense.org) — © Astigmatic (Brian J. Bonislawsky).
