import { useEffect, useState } from 'react'
import { checkSeen, type SeenCheck, type VaultInfo } from '../../session'
import { relTime } from '../../ui/syncStatus'
import './vault.css'

const short = (sha: string) => `${sha.slice(0, 8)}…`

/**
 * What this device remembers of the stored vault, against what the server
 * serves now: "Last seen on this device: v42 · sha 3fa1c0de… ✓". The memory is
 * this browser's own (written on every unlock and save), so unlike the
 * server's hash it can tell an older or swapped copy from the real one.
 *
 * `pending`: `info` predates a save this tab just made and is being
 * refetched — no verdict until the current copy arrives (this device's
 * memory is already ahead of it, which would read as an older copy).
 */
export function SeenLine({ info, pending }: { info: VaultInfo; pending: boolean }) {
  /** The last comparison, with the version of the copy it was made for (so a newer `info` never borrows it). */
  const [check, setCheck] = useState<{ c: SeenCheck; version: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const stale = pending

  useEffect(() => {
    if (stale) return
    let live = true
    setError(null)
    checkSeen(info)
      .then((c) => live && setCheck({ c, version: info.version }))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [info, stale])

  if (error) return <div className="zk-seen neg">Can’t read the stored vault’s header: {error}</div>
  if (stale || !check) return <div className="zk-seen muted">Checking the stored copy against this device…</div>
  return <SeenText check={check.c} version={check.version} />
}

/** The line itself, for one comparison (`version`: the courier version the copy is served as). */
export function SeenText({ check, version }: { check: SeenCheck; version: number }) {
  const sealedAs = check.servedSeq !== null && check.servedSeq !== version ? ` (sealed as v${check.servedSeq})` : ''
  const at = check.seen ? relTime(Date.parse(check.seen.at), Date.now()) : ''
  const last = check.seen ? (
    <>
      Last seen on this device: <b>v{check.seen.seq}</b> · sha <span className="num">{short(check.seen.sha256)}</span> · {at}
    </>
  ) : null

  switch (check.state) {
    case 'same':
      return (
        <div className="zk-seen">
          {last} <span className="zk-seen-ok">✓ the server’s copy is that one</span>
        </div>
      )
    case 'newer':
      return (
        <div className="zk-seen">
          {last} <span className="muted">· the server has v{version}{sealedAs}, saved since elsewhere</span>
        </div>
      )
    case 'older':
      return (
        <div className="zk-seen">
          {last}{' '}
          <b className="neg">
            · the server’s copy is older: sealed as v{check.servedSeq}
            {check.servedSeq !== version ? `, served as v${version}` : ''}
          </b>
        </div>
      )
    case 'diverged':
      return (
        <div className="zk-seen">
          {last}{' '}
          <b className="neg">
            · the server’s v{check.servedSeq} is a different copy (sha <span className="num">{short(check.sha256)}</span>)
          </b>
        </div>
      )
    case 'downgrade':
      return (
        <div className="zk-seen">
          {last} <b className="neg">· the server now serves an older copy in the v2 format</b>
        </div>
      )
    default:
      return (
        <div className="zk-seen muted">
          {check.format === 2
            ? `Format v2 · sha ${short(check.sha256)} — the older format has no sequence number to check; the next save writes v3.`
            : `This device hasn’t opened or saved this vault yet · v${version}${sealedAs} · sha ${short(check.sha256)} — from its first unlock here, an older copy is caught.`}
        </div>
      )
  }
}
