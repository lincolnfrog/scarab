# Snapshot fixtures

Frozen exports written by *older* engines, so `engine/snapshot-compat.test.ts`
can prove this engine still reads them. They are evidence, not test data to be
tidied: never regenerate one to make a test pass, and never edit one by hand.
If a fixture stops loading, either an upgrade is missing or support was dropped
on purpose — and dropping it means raising `SNAPSHOT_COMPAT.minReadable` in
`engine/upgrades.ts` deliberately.

The test enforces that `minReadable` equals the oldest fixture here, or the
current version when there are none.

## While there is one vault: a rolling floor

Real household data went into a vault on 2026-09-25 (schema v21), so vaults
must keep opening across upgrades. While that is the only vault, the floor
doesn't have to stay put — it can follow the vault up:

1. **A schema change ships with the floor where it is.** An additive one (new
   table, new column with a default) needs nothing more; one that reshapes data
   needs an `upgrades` entry in `engine/upgrades.ts` — or step 3 first, so the
   floor is already at the version before it.
2. **The vault catches up.** Unlocking with the new engine leaves the tab
   unsaved (`loadDump` reports the snapshot `older`), so the next save —
   automatic — reseals it at the new version. Check the Vault screen shows it
   saved after the deploy; every other member's tabs need the same unlock.
3. **Then the floor may rise** to that version: freeze its fixture (below),
   delete the older one, and set `minReadable` to it. Kept versions in the
   vault's history older than the floor stop being restorable — that is the
   price.

Once anyone else keeps a vault, stop: their unlock can't be confirmed, so the
floor only ever drops from then on (as the section below describes).

Current floor: `snapshot-v21.json`, frozen 2026-09-25 from `c459152`.

## Adding one

Write it with the engine that shipped that version, not by hand-editing a newer
export — the point is to capture what that engine actually produced.
`scripts/mkfixture.ts` builds the household (a checking account with an import
and a budget, a lots brokerage with a trade and a starting position, a crypto
account, a stock plan with a scheduled grant, a net-settled vest and a paycheck
pointing at it, a balance-tracked 401(k), a home with a valuation and its
mortgage); run the copy at that commit:

```bash
git worktree add /tmp/scarab-vN <commit-at-that-version>
ln -s "$PWD/node_modules" /tmp/scarab-vN/node_modules
(cd /tmp/scarab-vN && npx tsx scripts/mkfixture.ts) > engine/fixtures/snapshot-vN.json
git worktree remove /tmp/scarab-vN --force
```

Name it `snapshot-vN.json`; the compat test picks every such file up and
loads it on both engines. Add assertions there for what loading it must
produce — the rows that a tier-C entry has to repair, in particular.
