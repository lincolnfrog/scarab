import type { Rollback } from '../../session'
import { confirm } from '../../ui/dialogs'
import { relTime } from '../../ui/syncStatus'
import './vault.css'

const when = (iso: string) => {
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : ` (${relTime(t, Date.now())})`
}

/** What is older about the served copy, and the two ways that happens. */
function explain(r: Rollback) {
  const seen = (
    <>
      <b>v{r.seen.seq}</b>
      {when(r.seen.at)}
    </>
  )
  return r.kind === 'rollback' ? (
    <>
      <p>
        This device last saw this vault at {seen}. The copy the server is serving was sealed as <b>v{r.served.seq}</b>,
        so it is missing whatever changed after that.
      </p>
      <p>
        That happens when the server is restored from a backup. It can also mean someone who controls the server is
        replaying an old copy — one from before a key rotation, or before a member was removed.
      </p>
    </>
  ) : r.kind === 'fork' ? (
    <>
      <p>
        This device saw {seen}, and the server’s v{r.served.seq} is a different copy. The vault’s history has split —
        usually because the server was restored from a backup and someone saved over it since.
      </p>
      <p>What this device saw at v{r.seen.seq} is not in the server’s copy.</p>
    </>
  ) : (
    <>
      <p>
        This device has seen this vault in the current format, at {seen}. The server is serving a copy in the older
        v2 format, which predates that — an older copy put back, by a restore or on purpose.
      </p>
    </>
  )
}

const title = (r: Rollback) =>
  r.kind === 'rollback'
    ? `The server is serving an older copy (v${r.served.seq})`
    : r.kind === 'fork'
      ? `The server’s v${r.served.seq} isn’t the one this device saw`
      : 'The server is serving an older-format copy'

/**
 * The stop before opening a vault copy that is older than what this device
 * last saw of it (see session.ts Rollback). Says what is missing and the two
 * ways it happens — a server restored from backup, or someone replaying an
 * old copy — and asks: Open anyway / Cancel. Cancel changes nothing.
 */
export function confirmOpenOlder(r: Rollback): Promise<boolean> {
  return confirm({
    title: title(r),
    body: (
      <div className="zk-replace">
        {explain(r)}
        <p>If you open it, your saves continue from it. If someone still has the newer version open, let them save first.</p>
      </div>
    ),
    confirmLabel: 'Open anyway',
    cancelLabel: 'Cancel',
    danger: true,
  })
}

/**
 * The same stop before Keep mine puts this tab's copy on top of such a copy
 * (session.ts keepMine). Keeping goes ahead on this tab's own passkey list,
 * not the older copy's, so nothing removed since comes back.
 */
export function confirmKeepOverOlder(r: Rollback): Promise<boolean> {
  return confirm({
    title: title(r),
    body: (
      <div className="zk-replace">
        {explain(r)}
        <p>
          Keep mine saves this tab’s copy as v{r.served.version + 1} with this tab’s passkey list — the older copy’s list isn’t
          brought back, so a passkey removed since stays removed. v{r.served.version} stays in the vault’s history.
        </p>
      </div>
    ),
    confirmLabel: 'Keep mine anyway',
    cancelLabel: 'Cancel',
    danger: true,
  })
}
