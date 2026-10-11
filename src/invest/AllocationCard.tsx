import { useCallback, useEffect, useState, type RefCallback } from 'react'
import type { Allocation, AssetClass, PlanStep } from '../../engine/allocation'
import { formatDollars } from '../../shared/money'
import { get, put } from '../api'
import { Button } from '../ui/Button'
import { PercentInput, Select } from '../ui/Field'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import './allocation.css'

/** Same list and order as engine/allocation.ts ASSET_CLASSES (the engine module isn't in this bundle). */
export const CLASSES: { cls: AssetClass; label: string }[] = [
  { cls: 'us_stock', label: 'US stocks' },
  { cls: 'intl_stock', label: 'International stocks' },
  { cls: 'bonds', label: 'Bonds' },
  { cls: 'cash', label: 'Cash' },
  { cls: 'real_estate', label: 'Real estate (REITs)' },
  { cls: 'crypto', label: 'Crypto' },
  { cls: 'other', label: 'Other / mixed' },
]
export const CLASS_LABEL = Object.fromEntries(CLASSES.map((c) => [c.cls, c.label])) as Record<AssetClass, string>
export const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
export const pp = (micro: number) => `${micro > 0 ? '+' : micro < 0 ? '−' : '±'}${Math.abs(micro / 10_000).toFixed(1)}pp`
const STEP_TITLE: Record<PlanStep['step'], string> = {
  contribute: '1 · New contributions over the next year',
  sheltered: '2 · Trades inside sheltered accounts — no tax',
  taxable: '3 · Sales in taxable accounts — least gain first',
}

type Targets = Partial<Record<AssetClass, number | null>>
const sumOf = (t: Targets) => Object.values(t).reduce<number>((s, v) => s + (v ?? 0), 0)

function Plan({ a }: { a: Allocation }) {
  const p = a.plan!
  if (p.steps.length === 0) return <p className="sub2">On target — nothing to move.</p>
  const groups = (['contribute', 'sheltered', 'taxable'] as const).map((step) => ({ step, rows: p.steps.filter((s) => s.step === step) })).filter((g) => g.rows.length)
  return (
    <div className="al-plan">
      {groups.map((g) => (
        <section key={g.step}>
          <h3>{STEP_TITLE[g.step]}</h3>
          <ul>
            {g.rows.map((s, i) => (
              <li key={i} className={s.action}>
                <span className="al-act">{s.action === 'buy' ? 'Buy' : 'Sell'}</span>
                <span className="al-cls">{CLASS_LABEL[s.cls]}</span>
                <span className="al-amt">{formatDollars(s.cents)}</span>
                <span className="al-where">
                  {s.where}
                  {s.lot && (
                    <span className="muted">
                      {' '}
                      · lot of {s.lot.openedOn}, {s.lot.term === 'lt' ? 'long' : 'short'}-term, {s.lot.gainCents < 0 ? 'loss' : 'gain'}{' '}
                      {formatDollars(Math.abs(s.lot.gainCents))}
                      {s.lot.washRisk && (
                        <Tooltip content="Another buy of this asset within 30 days (or a vest coming up) would make a loss here a wash sale">
                          <span className="scr-warn" role="img" aria-label="Wash-sale risk"> ⚠</span>
                        </Tooltip>
                      )}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p className="sub2 topline">
        {p.taxable.stGainCents + p.taxable.ltGainCents !== 0 ? (
          <>
            The taxable sales realize {formatDollars(p.taxable.ltGainCents)} long-term and {formatDollars(p.taxable.stGainCents)} short-term —{' '}
            <b className="inkstrong">≈{formatDollars(p.taxable.taxCents)}</b> of tax this year, on top of everything else the year holds.
          </>
        ) : (
          'No taxable sale needed: contributions and sheltered trades close the gap.'
        )}
        {p.unresolvedCents > 0 && <> {formatDollars(p.unresolvedCents)} can't be reached by any sale on record.</>} An estimate, not advice — verify before acting.
      </p>
    </div>
  )
}

/**
 * Target allocation (copilot §4d): what's invested by asset class against the
 * household's target, the plan that closes the gap at the least tax, and the
 * classes themselves — guessed from each fund's symbol and name until set.
 * `rev` is Investments' load counter: a trade or a price refresh re-reads it.
 * The plan stays folded until asked for — or until a link lands on the card
 * (`planOpen`: the Checkup's drift findings point at it).
 */
export default function AllocationCard({ rev, anchor, planOpen = false }: { rev: number; anchor?: RefCallback<HTMLElement>; planOpen?: boolean }) {
  const [a, setA] = useState<Allocation | null>(null)
  const [targets, setTargets] = useState<Targets | null>(null)
  const [showClasses, setShowClasses] = useState(false)
  const [showPlan, setShowPlan] = useState(planOpen)
  useEffect(() => {
    if (planOpen) setShowPlan(true)
  }, [planOpen])
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => {
    const r = await get<Allocation>('/api/allocation')
    setA(r)
    setTargets(r.target ? { ...r.target } : {})
    setErr(null)
  }, [])
  useEffect(() => {
    load().catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [load, rev])

  const saveTarget = useAction((t: Targets) => put('/api/allocation/target', { targets: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v ?? 0])) }), {
    success: 'Target saved — drift and the plan recomputed',
    errorPrefix: "Couldn't save the target",
    onDone: () => void load(),
  })
  const setClass = useAction(
    (kind: 'assets' | 'accounts', id: number, cls: AssetClass | null) => put(`/api/allocation/${kind}/${id}`, { assetClass: cls }),
    { errorPrefix: "Couldn't set the class", onDone: () => void load() },
  )

  if (!a || !targets)
    return (
      <div className="card c12" ref={anchor}>
        <h2>Allocation</h2>
        {err ? <p className="sub2">Couldn't work out the allocation: {err}</p> : <Skeleton h={120} />}
      </div>
    )
  // In a view of its own now: say why it's empty rather than leave the page blank.
  if (a.totalCents <= 0)
    return (
      <div className="card c12" ref={anchor}>
        <h2>Allocation</h2>
        <p className="sub2">Nothing invested yet — once an account holds something, its split by asset class shows here.</p>
      </div>
    )

  const sum = sumOf(targets)
  const saved = a.target ?? {}
  const dirty = CLASSES.some((c) => (targets[c.cls] ?? 0) !== (saved[c.cls] ?? 0))
  const guessed = a.assets.filter((x) => x.guessed).length + a.accounts.filter((x) => x.guessed && x.cents !== 0).length
  const shown = CLASSES.filter((c) => a.rows.some((r) => r.cls === c.cls) || (targets[c.cls] ?? 0) > 0 || a.target === null)

  return (
    <div className="card c12" ref={anchor}>
      <div className="h4row">
        <h2>Allocation{a.target ? ' vs target' : ''}</h2>
        <div className="right">
          <span className="muted">{formatDollars(a.totalCents)} invested, property aside</span>
        </div>
      </div>
      <div className="ui-tablewrap">
        <table className="al-table">
          <thead>
            <tr>
              <th>Class</th>
              <th className="r">Held</th>
              <th className="r">Now</th>
              <th className="r">Target</th>
              <th className="r">Drift</th>
              <th className="r">To target</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const r = a.rows.find((x) => x.cls === c.cls)
              return (
                <tr key={c.cls}>
                  <td>{c.label}</td>
                  <td className="r num">{formatDollars(r?.cents ?? 0)}</td>
                  <td className="r num">{pct(r?.shareMicro ?? 0)}</td>
                  <td className="r al-target">
                    <PercentInput aria-label={`${c.label} target`} valueMicro={targets[c.cls] ?? null} placeholder="—" onChange={(m) => setTargets({ ...targets, [c.cls]: m })} />
                  </td>
                  <td className={`r num${r?.driftMicro != null && Math.abs(r.driftMicro) >= 30_000 ? ' al-off' : ''}`}>{r?.driftMicro != null ? pp(r.driftMicro) : '—'}</td>
                  <td className="r num">{r?.toTargetCents != null ? `${r.toTargetCents >= 0 ? 'buy' : 'sell'} ${formatDollars(Math.abs(r.toTargetCents))}` : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="scr-formfoot">
        <span className="scr-note muted">
          {sum === 0 ? 'No target set — type a share per class.' : sum === 1_000_000 ? 'Targets add up to 100%.' : <span className="neg">Targets add up to {pct(sum)} — they need to make 100%.</span>}
        </span>
        {a.target && (
          <Button variant="ghost" busy={saveTarget.busy} onClick={() => void saveTarget.run({})}>
            Clear target
          </Button>
        )}
        <Button variant="gold" busy={saveTarget.busy} disabled={!dirty || (sum !== 1_000_000 && sum !== 0)} onClick={() => void saveTarget.run(targets)}>
          Save target
        </Button>
      </div>

      {a.plan && (
        <div className="topline">
          <button type="button" className="al-toggle" aria-expanded={showPlan} onClick={() => setShowPlan((v) => !v)}>
            Rebalance plan {showPlan ? '▴' : '▾'}
          </button>
          {showPlan && <Plan a={a} />}
        </div>
      )}

      <div className="topline">
        <button type="button" className="al-toggle" aria-expanded={showClasses} onClick={() => setShowClasses((v) => !v)}>
          Asset classes{guessed > 0 ? ` · ${guessed} guessed` : ''} {showClasses ? '▴' : '▾'}
        </button>
        {showClasses && (
          <div className="ui-tablewrap">
            <table className="al-classes">
              <tbody>
                {a.assets.map((x) => (
                  <tr key={`a${x.id}`}>
                    <td>
                      <b>{x.symbol}</b> <span className="muted">{x.name ?? ''}</span>
                    </td>
                    <td className="r num">{formatDollars(x.cents)}</td>
                    <td className="al-pick">
                      <Select aria-label={`${x.symbol} class`} value={x.guessed ? '' : x.cls} onChange={(e) => void setClass.run('assets', x.id, (e.target.value || null) as AssetClass | null)}>
                        <option value="">{`Guess: ${CLASS_LABEL[x.cls]}`}</option>
                        {CLASSES.map((c) => <option key={c.cls} value={c.cls}>{c.label}</option>)}
                      </Select>
                    </td>
                  </tr>
                ))}
                {a.accounts.map((x) => (
                  <tr key={`b${x.id}`}>
                    <td>
                      <b>{x.name}</b> <span className="muted">balance only — one class for the whole account</span>
                    </td>
                    <td className="r num">{formatDollars(x.cents)}</td>
                    <td className="al-pick">
                      <Select aria-label={`${x.name} class`} value={x.guessed ? '' : x.cls} onChange={(e) => void setClass.run('accounts', x.id, (e.target.value || null) as AssetClass | null)}>
                        <option value="">Not set (other)</option>
                        {CLASSES.map((c) => <option key={c.cls} value={c.cls}>{c.label}</option>)}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
