import { useState } from 'react'
import type { Dump } from '../../../engine/snapshot'
import { CURRENT_VERSION } from '../../../engine/upgrades'
import { get } from '../../api'
import { enterLocalMode, localMode } from '../../local'
import { passkeysWorkHere } from '../../passkey'
import { follow, rotateVault, startEmpty, type Members, type VaultInfo } from '../../session'
import { Button } from '../../ui/Button'
import { confirm } from '../../ui/dialogs'
import { parseServerTime, relTime, sizeText, whoLabel } from '../../ui/syncStatus'
import { toast } from '../../ui/Toast'
import { useAction } from '../../ui/useAction'
import { showRecoveryCode } from './codeSheet'
import { SeenLine } from './SeenLine'
import './vault.css'

export type BasketStatus = { builtAt: string | null; count: number; errors: string[]; building: boolean }

const today = () => new Date().toISOString().slice(0, 10)

/**
 * The Advanced card, collapsed by default: the stored copy and this device's
 * memory of it, rotating the key, the price basket, the engine parity check,
 * and — in household mode — the ways into a zero-knowledge session.
 */
export function AdvancedCard(p: {
  open: boolean
  onToggle: (open: boolean) => void
  info: VaultInfo | null | undefined
  /** Who is in the household (GET /api/vault/members), or null when not known. */
  members: Members | null
  refetching: boolean
  basket: BasketStatus | null
  reload: () => void
}) {
  const local = localMode.active
  const session = localMode.vault
  const [engineResult, setEngineResult] = useState<string[] | null>(null)

  const rotate = useAction(
    async () => {
      const ok = await confirm({
        title: 'Rotate the vault key?',
        body: (
          <div className="zk-confirm">
            <p>A new key and a new recovery code. The passkey you answer with stays; every other passkey and the current recovery code stop working, and those passkeys must be added again.</p>
            <p>Earlier versions the server keeps are deleted, since they are sealed under the old key. For when a recovery code or a device may have fallen into the wrong hands.</p>
          </div>
        ),
        confirmLabel: 'Rotate key',
        danger: true,
      })
      if (!ok) return null
      const r = await rotateVault()
      showRecoveryCode({
        code: r.recoveryCode,
        title: 'New recovery code',
        subtitle: `Vault v${r.version} is re-keyed; only “${r.kept}” unlocks it now. The old recovery code no longer works.`,
        required: true,
      })
      return r
    },
    { errorPrefix: 'Couldn’t rotate the key', onDone: p.reload },
  )

  const rebuild = useAction(
    async () => {
      const r = await fetch('/api/basket/rebuild', { method: 'POST' })
      const j = (await r.json().catch(() => ({}))) as { stocks?: number; crypto?: number; universe?: number; errors?: string[]; ms?: number; error?: string; retryAfter?: number }
      if (r.status === 429) {
        const mins = Math.max(1, Math.ceil((j.retryAfter ?? 60) / 60))
        toast.info(`The basket was built minutes ago — it can be rebuilt again in about ${mins} min.`)
        return
      }
      if (!r.ok) throw new Error(j.error ?? `${r.status} ${r.statusText}`)
      toast.success(
        `Basket: ${j.stocks ?? 0} of ${j.universe ?? 0} listed stocks, ${j.crypto ?? 0} crypto, ${((j.ms ?? 0) / 1000).toFixed(1)}s${j.errors?.length ? ` — ${j.errors.length} error(s)` : ''}`,
      )
    },
    { errorPrefix: 'Couldn’t rebuild the basket', onDone: p.reload },
  )

  const startBlank = useAction(startEmpty, { errorPrefix: 'Couldn’t start a session' })
  const startFromServer = useAction(
    async () => {
      await enterLocalMode(await get<Dump>('/api/export'))
      toast.success('Server data copied into this tab — create a vault to keep changes')
    },
    { errorPrefix: 'Couldn’t start a session' },
  )

  async function runParity() {
    setEngineResult(['Loading WASM SQLite + engine…'])
    try {
      const t0 = performance.now()
      const [{ openBrowserDb }, { migrate }, { loadDump }, { netWorthSeries }, wasmUrl] = await Promise.all([
        import('../../../engine/sqljs-db'),
        import('../../../engine/migrations'),
        import('../../../engine/snapshot'),
        import('../../../engine/networth'),
        import('sql.js/dist/sql-wasm.wasm?url').then((m) => m.default),
      ])
      const lines = [`Engine + WASM loaded in ${(performance.now() - t0).toFixed(0)}ms`]
      setEngineResult([...lines])
      const t1 = performance.now()
      const dump = await get<Dump>('/api/export')
      const db = await openBrowserDb({ wasmUrl })
      migrate(db)
      const loaded = loadDump(db, dump)
      const txCount = (db.prepare('SELECT count(*) AS n FROM transactions').get() as { n: number }).n
      const upgraded = loaded.upgraded.length ? ` → v${CURRENT_VERSION} (upgraded ${loaded.upgraded.join(', ')})` : ''
      lines.push(`Database rebuilt in a scratch engine: ${txCount} transactions, schema v${loaded.from}${upgraded} (${(performance.now() - t1).toFixed(0)}ms)`)
      const t2 = performance.now()
      const localSeries = netWorthSeries(db, today())
      const ref = await get<{ series: { month: string; total: number }[] }>('/api/networth')
      const match =
        localSeries.length === ref.series.length && localSeries.every((pt, i) => pt.total === ref.series[i]!.total && pt.month === ref.series[i]!.month)
      lines.push(`Net worth recomputed in ${(performance.now() - t2).toFixed(0)}ms: ${localSeries.length} months`)
      lines.push(match ? `✓ Parity: all ${localSeries.length} months match exactly.` : `✗ Mismatch — report this.`)
      db.close()
      setEngineResult([...lines])
    } catch (e) {
      setEngineResult([`Failed: ${e instanceof Error ? e.message : e}`])
    }
  }

  const info = p.info
  const saved = info ? parseServerTime(info.updated_at) : null
  const basket = p.basket
  // Only the household's owner re-keys: a rotation keeps just the passkey that answers, so a member's would lock the owner
  // out of theirs. (Nobody is offered it while the household isn't known.)
  const owner = p.members?.household ?? follow.household?.owner ?? null
  const me = localMode.identity?.trim().toLowerCase() || null
  const mine = !!owner && !!me && owner.trim().toLowerCase() === me
  const canRotate = !!session && mine && passkeysWorkHere(session.header.rpId)

  return (
    <details className="card zk-card zk-adv" open={p.open} onToggle={(e) => p.onToggle((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="zk-adv-sum">
        <h2>Advanced</h2>
        <span className="muted">this device’s memory of the vault · key rotation · price basket · engine check{!local ? ' · start a session' : ''}</span>
      </summary>

      <div className="zk-adv-grid">
        <div className="zk-adv-sec">
          <h3 className="zk-h3">The stored copy</h3>
          {info ? (
            <>
              <p className="sub2">
                <span className="num">v{info.version}</span> · {sizeText(info.size)} stored · saved {saved !== null ? relTime(saved, Date.now()) : `${info.updated_at} UTC`}
                {info.updated_by ? ` by ${whoLabel(info.updated_by, localMode.identity)}` : ''} · sha <span className="num">{info.sha256.slice(0, 10)}…</span>
              </p>
              <SeenLine info={info} pending={p.refetching} />
            </>
          ) : (
            <p className="sub2">{info === null ? 'No vault is stored yet.' : 'Loading…'}</p>
          )}
          {canRotate ? (
            <div className="formrow zk-actions">
              <Button variant="danger" busy={rotate.busy} onClick={() => void rotate.run()}>
                Rotate key…
              </Button>
            </div>
          ) : session && owner && !mine ? (
            <p className="sub2 muted zk-rotate-note">
              Only {owner} can re-key this vault — ask them to if a recovery code or a device may be in the wrong hands.
            </p>
          ) : null}
        </div>

        <div className="zk-adv-sec">
          <h3 className="zk-h3">Price basket</h3>
          <p className="sub2">
            {basket
              ? basket.count > 0
                ? `${basket.count.toLocaleString('en-US')} symbols · built ${basket.builtAt?.replace('T', ' ').slice(0, 16)} UTC`
                : basket.building
                  ? 'Building…'
                  : 'Not built yet.'
              : '—'}
          </p>
          {basket && basket.errors.length > 0 && (
            <p className="sub2 neg">
              {basket.errors.slice(0, 3).join(' · ')}
              {basket.errors.length > 3 ? ` · +${basket.errors.length - 3} more` : ''}
            </p>
          )}
          <p className="sub2 muted">
            Every listed US stock and ETF plus the top 500 crypto assets, quoted once a day and served whole — a session picks its own symbols out
            locally, so the server never learns what you hold.
          </p>
          <div className="formrow zk-actions">
            <Button size="mini" variant="ghost" busy={rebuild.busy} onClick={() => void rebuild.run()}>
              Rebuild basket now
            </Button>
            <Button size="mini" variant="ghost" onClick={() => void runParity()} title="rebuild the database in a scratch engine and check net worth month by month">
              Run engine parity check
            </Button>
          </div>
          {engineResult && (
            <div className="zk-engine" role="status">
              {engineResult.map((l, i) => (
                <div key={i} className={l.startsWith('✗') || l.startsWith('Failed') ? 'neg' : ''}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>

        {!local && (
          <div className="zk-adv-sec">
            <h3 className="zk-h3">Start a zero-knowledge session</h3>
            <p className="sub2">
              Run Scarab entirely in this tab. Start empty, or copy the server’s current data in — then create a vault with a passkey (Session) to
              keep it.
            </p>
            <div className="formrow zk-actions">
              <Button variant="gold" busy={startBlank.busy} disabled={startFromServer.busy} onClick={() => void startBlank.run()}>
                Start empty in this tab
              </Button>
              <Button busy={startFromServer.busy} disabled={startBlank.busy} onClick={() => void startFromServer.run()} title="copy the server’s current data into an in-tab session">
                Start from server data
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  )
}
