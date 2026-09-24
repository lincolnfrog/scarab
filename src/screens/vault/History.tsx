import { useEffect, useState } from 'react'
import { localMode } from '../../local'
import { fetchHistory, openHistoryVersion, type VaultHistory } from '../../session'
import { Button } from '../../ui/Button'
import { Skeleton } from '../../ui/Skeleton'
import { parseServerTime, relTime, sizeText, useNow, whoLabel } from '../../ui/syncStatus'
import { Tooltip } from '../../ui/Tooltip'
import { useAction } from '../../ui/useAction'
import { showSnapshot } from './Preview'
import { pinLabel, policyText } from './versions'
import './vault.css'

/** Rows shown before "Show all". */
const FIRST = 8

const clock = (t: number) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/**
 * The History card: earlier versions the server keeps (ciphertext it can't
 * read), newest first. Open one to see what it holds against this tab —
 * decrypted here, with the session's key — and restore it from there, which
 * is never destructive. Shown only in a session with a vault: opening a
 * version takes its key.
 */
export function HistoryCard() {
  const session = localMode.vault
  const version = session?.version ?? null
  const now = useNow()
  const [h, setH] = useState<VaultHistory | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [opening, setOpening] = useState<number | null>(null)

  // Every save (anyone's) moves a version into the history: ask again whenever this tab's version moves.
  useEffect(() => {
    if (version === null) return
    let live = true
    fetchHistory()
      .then((r) => {
        if (!live) return
        setH(r)
        setError(null)
      })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [version])

  const open = useAction(
    async (v: number) => {
      setOpening(v)
      try {
        return await openHistoryVersion(v)
      } finally {
        setOpening(null)
      }
    },
    { errorPrefix: 'Couldn’t open that version', onDone: showSnapshot },
  )

  if (!localMode.active || !session) return null

  const entries = h?.entries ?? []

  return (
    <section className="card c12 zk-card" aria-labelledby="zk-history-h">
      <div className="h4row">
        <h2 id="zk-history-h">History</h2>
        <div className="right muted">
          {!h ? '' : entries.length === 0 ? 'nothing kept yet' : `${entries.length} earlier version${entries.length === 1 ? '' : 's'} · ${sizeText(h.bytes)} kept`}
        </div>
      </div>
      <p className="zk-lead">
        Every save keeps the version it replaces, still encrypted. Open one to see what it holds against this tab — it is decrypted here, never on the
        server — and restore it if you want it back. Restoring is never destructive: the version you have now stays here too.
      </p>
      {error && h === undefined ? (
        <p className="sub2 neg" role="alert">
          Couldn’t load the history: {error}
        </p>
      ) : h === undefined ? (
        <div className="zk-hist-skel" aria-busy="true" aria-label="Loading the history">
          <Skeleton h={14} w="60%" />
          <Skeleton h={14} w="75%" />
          <Skeleton h={14} w="50%" />
        </div>
      ) : (
        <HistoryList h={h} version={session.version} dirty={localMode.dirty} identity={localMode.identity} now={now} all={all} opening={opening} onOpen={(v) => void open.run(v)} />
      )}
      {h && entries.length === 0 && <p className="sub2 muted zk-hist-empty">No earlier versions yet — the next save keeps this one.</p>}
      {h && entries.length > FIRST && (
        <button type="button" className="zk-link" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${entries.length}`}
        </button>
      )}
      <p className="sub2 muted zk-foot">
        {h ? policyText(h.policy) : ''} Rotating the key or removing someone from the household deletes the history: it is sealed under the old key.
      </p>
    </section>
  )
}

/** The list itself: this tab's version first, then each kept version, newest first. */
export function HistoryList(p: {
  h: VaultHistory
  version: number
  dirty: boolean
  identity: string | null
  now: number
  all: boolean
  opening: number | null
  onOpen: (version: number) => void
}) {
  return (
    <table className="zk-hist">
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">Saved</th>
          <th scope="col">By</th>
          <th scope="col" className="r">
            Size
          </th>
          <th scope="col">
            <span className="zk-sr">Kept because</span>
          </th>
          <th scope="col" className="r">
            <span className="zk-sr">Open</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr className="zk-hist-now">
          <th scope="row">
            v{p.version}
          </th>
          <td colSpan={5} className="muted">
            now — this tab{p.dirty ? ', with unsaved changes' : ''}
          </td>
        </tr>
        {(p.all ? p.h.entries : p.h.entries.slice(0, FIRST)).map((e) => {
          const at = parseServerTime(e.updated_at)
          const pin = pinLabel(e.pin)
          return (
            <tr key={e.version}>
              <th scope="row">
                v{e.version}
              </th>
              <td>
                {at === null ? (
                  `${e.updated_at} UTC`
                ) : (
                  <Tooltip content={clock(at)}>
                    <span>{relTime(at, p.now)}</span>
                  </Tooltip>
                )}
              </td>
              <td className="zk-hist-by">{whoLabel(e.updated_by, p.identity)}</td>
              <td className="r muted">{sizeText(e.size)}</td>
              <td>{pin && <span className="zk-pk-badge" data-tone="quiet">{pin}</span>}</td>
              <td className="r">
                <Button
                  size="mini"
                  busy={p.opening === e.version}
                  disabled={p.opening !== null && p.opening !== e.version}
                  onClick={() => p.onOpen(e.version)}
                  aria-label={`Open v${e.version}`}
                >
                  Open…
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
