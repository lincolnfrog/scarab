# Snapshot fixtures

Frozen exports written by *older* engines, so `engine/snapshot-compat.test.ts`
can prove this engine still reads them. They are evidence, not test data to be
tidied: never regenerate one to make a test pass, and never edit one by hand.
If a fixture stops loading, either an upgrade is missing or support was dropped
on purpose — and dropping it means raising `SNAPSHOT_COMPAT.minReadable` in
`engine/upgrades.ts` deliberately.

The test enforces that `minReadable` equals the oldest fixture here, or the
current version when there are none.

## Empty until production

Deliberately. Before Scarab is in production there are no vaults worth
carrying forward, so nothing is frozen here and the engine refuses anything
older than itself. The machinery is tested against synthetic entries instead.
The first fixture to add is the version we declare production on.

## Adding one

Write it with the engine that shipped that version, not by hand-editing a newer
export — the point is to capture what that engine actually produced. A good
fixture is a small household exercising the parts migrations tend to disturb: a
bank account with imported transactions, a lots-tracked brokerage with a trade,
a stock-plan brokerage with unvested shares and a paycheck pointing at it, a
balance-tracked 401(k).

```bash
git worktree add /tmp/scarab-vN <commit-at-that-version>
ln -s "$PWD/node_modules" /tmp/scarab-vN/node_modules
# a short tsx script there: build a household through engine/services, print dumpDb(db)
cd /tmp/scarab-vN && npx tsx mkfixture.ts > engine/fixtures/snapshot-vN.json
git worktree remove /tmp/scarab-vN --force
```

Name it `snapshot-vN.json`; the compat test picks every such file up and
loads it on both engines. Add assertions there for what loading it must
produce — the rows that a tier-C entry has to repair, in particular.
