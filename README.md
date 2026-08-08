# Scarab 🪲

Private household finance. Investments, real estate, cash
& budget, the Dream Home fund, and a Monte Carlo future — behind Google
Identity-Aware Proxy, for exactly the accounts you allowlist, at ~$0/month.

Start here: **`DESIGN.md`** (architecture, data model, decisions, roadmap),
**`PRIVACY.md`** (the zero-knowledge architecture and its honest limits),
`CLAUDE.md` (hard rules + design tokens; mockup link inside).

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
You two → Identity-Aware Proxy → Cloud Run (this app) → SQLite ⇄ Litestream ⇄ GCS
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

## First deploy (one evening)

1. Create a project at console.cloud.google.com and attach billing.
2. `gcloud auth login`
3. `./scripts/bootstrap-gcp.sh <PROJECT_ID> you@… partner@…`
4. Walk the checklist the script prints (both accounts in, third account blocked).

After that, every deploy is just `./scripts/deploy.sh`.

## Costs

Cloud Run / GCS / Cloud Build free tiers cover 2-user scale. The only planned
bill is SimpleFIN Bridge ($1.50/mo) when transaction sync is turned on in
Phase I.

## Roadmap

- **0 — Skeleton + fortress** (this): shell UI, health/identity wiring, IAP deploy.
- **I — Cash**: CSV/OFX import, dedupe, categorizer, income/spend, budget. SimpleFIN.
- **II — Investments & property**: trade ledger, tax lots, cost basis, EOD prices, valuations.
- **III — Dream Home**: fund tracking, real loan sheets, payment matrix, rental scenario.
- **IV — Future**: Monte Carlo with levers.

## Fonts

Marcellus (display face) is bundled as woff2, licensed under the
[SIL Open Font License](https://openfontlicense.org) — © Astigmatic (Brian J. Bonislawsky).
