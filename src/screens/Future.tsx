import { useCallback, useEffect, useRef, useState } from 'react'
import { formatCents } from '../../shared/money'
import { del, post, put } from '../api'
import { fmtShort, LineChart } from '../viz'

/**
 * Future — the decision engine. Named scenarios (knob-sets) run side by side
 * against today's ledger; one is the baseline the rest are measured against.
 * The headline is the crossing date: the earliest retirement year the plan
 * clears the odds threshold.
 */

type SimEvent = { year: number; amountCents: number; untilYear?: number; label?: string }
type Params = {
  meanReturnMicro: number
  volMicro: number
  propertyGrowthMicro: number
  saveBeforeBuyCents: number
  saveAfterBuyCents: number
  btcShockMicro: number
  buyEnabled: boolean
  buyYear: number
  retireYear: number
  retireSpendCents: number
  endYear: number
  events: SimEvent[]
}
type SimResult = {
  years: number[]
  p10: number[]
  p25: number[]
  p50: number[]
  p75: number[]
  p90: number[]
  successPct: number
  medianEndCents: number
  p10EndCents: number
}
type Run = {
  id: number
  name: string
  isBaseline: boolean
  params: Params
  result: SimResult
  crossingYear: number | null
  delta: null | { successPct: number; medianEndCents: number; p10EndCents: number; crossingYears: number | null }
}
type Compare = {
  balance: { cash: number; brokerage: number; retirement: number; crypto: number; property: number; liabilities: number; total: number } | null
  home: { priceCents: number; cashOutCents: number; rateMicro: number; termMonths: number; loanName: string | null } | null
  draw: 'lognormal' | 'historical'
  thresholdPct: number
  runs: Run[]
}
type Price = {
  successBeforePct: number
  successAfterPct: number
  medianEndBeforeCents: number
  medianEndAfterCents: number
  futureValueCents: number
  atYear: number
}

/** The knobs as the inputs hold them — strings, parsed on save. */
type Knobs = {
  meanReturn: string
  vol: string
  propertyGrowth: string
  saveBefore: string
  saveAfter: string
  btcShock: string
  buyEnabled: boolean
  buyYear: string
  retireYear: string
  retireSpend: string
  endYear: string
}

const SERIES = ['#bd8a26', '#5b8def', '#24a06e', '#8f7fe8', '#d95f42', '#2b9cb8']
const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`
const colorOf = (i: number) => SERIES[i % SERIES.length]!

const money = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? Math.round(n * 100) : 0
}
const pctMicro = (s: string) => {
  const n = Number(s)
  return Number.isFinite(n) ? Math.round(n * 10_000) : 0
}
const dollars = (cents: number) => (cents / 100).toLocaleString('en-US')
const pctStr = (micro: number) => String(Math.round(micro / 100) / 100)

function toKnobs(p: Params): Knobs {
  return {
    meanReturn: pctStr(p.meanReturnMicro),
    vol: pctStr(p.volMicro),
    propertyGrowth: pctStr(p.propertyGrowthMicro),
    saveBefore: dollars(p.saveBeforeBuyCents),
    saveAfter: dollars(p.saveAfterBuyCents),
    btcShock: pctStr(p.btcShockMicro),
    buyEnabled: p.buyEnabled,
    buyYear: String(p.buyYear),
    retireYear: String(p.retireYear),
    retireSpend: dollars(p.retireSpendCents),
    endYear: String(p.endYear),
  }
}
function fromKnobs(k: Knobs, prev: Params): Omit<Params, 'events'> {
  const yr = (s: string, fallback: number) => {
    const n = Number(s)
    return Number.isInteger(n) && n > 1900 && n < 2300 ? n : fallback
  }
  return {
    meanReturnMicro: pctMicro(k.meanReturn),
    volMicro: Math.max(0, pctMicro(k.vol)),
    propertyGrowthMicro: pctMicro(k.propertyGrowth),
    saveBeforeBuyCents: Math.max(0, money(k.saveBefore)),
    saveAfterBuyCents: Math.max(0, money(k.saveAfter)),
    btcShockMicro: Math.max(-1_000_000, pctMicro(k.btcShock)),
    buyEnabled: k.buyEnabled,
    buyYear: yr(k.buyYear, prev.buyYear),
    retireYear: yr(k.retireYear, prev.retireYear),
    retireSpendCents: Math.max(0, money(k.retireSpend)),
    endYear: yr(k.endYear, prev.endYear),
  }
}

const signed = (n: number, unit = '') => (n > 0 ? `+${n}${unit}` : n < 0 ? `${n}${unit}` : `±0${unit}`)
const signedMoney = (c: number) => (c === 0 ? '±0' : (c > 0 ? '+' : '−') + fmtShort(Math.abs(c)))
const cls = (n: number) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'muted')

export default function Future() {
  const [cmp, setCmp] = useState<Compare | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [draw, setDraw] = useState<'lognormal' | 'historical'>('lognormal')
  const [threshold, setThreshold] = useState('90')
  const [knobs, setKnobs] = useState<Knobs | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [decision, setDecision] = useState({ label: '', amount: '80,000', year: '', until: '' })
  const [price, setPrice] = useState<Price | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compare = useCallback(async () => {
    setBusy(true)
    try {
      const t = Number(threshold)
      const r = await post<Compare>('/api/scenarios/compare', {
        draw,
        thresholdPct: Number.isFinite(t) ? t : 90,
      })
      setCmp(r)
      setErr(null)
      setSelected((s) => (s !== null && r.runs.some((x) => x.id === s) ? s : (r.runs.find((x) => x.isBaseline) ?? r.runs[0])?.id ?? null))
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [draw, threshold])

  useEffect(() => {
    void compare()
  }, [compare])

  const run = cmp?.runs.find((r) => r.id === selected) ?? null
  const base = cmp?.runs.find((r) => r.isBaseline) ?? cmp?.runs[0] ?? null

  // Selecting a scenario loads its knobs; edits autosave after a pause.
  useEffect(() => {
    if (run && !dirty) setKnobs(toKnobs(run.params))
  }, [run, dirty])

  const save = useCallback(
    async (patch: Partial<Params>) => {
      if (!run) return
      try {
        await put(`/api/scenarios/${run.id}`, { params: { ...run.params, ...patch } })
        setDirty(false)
        await compare()
      } catch (e) {
        setErr((e as Error).message)
      }
    },
    [run, compare],
  )

  useEffect(() => {
    if (!dirty || !knobs || !run) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void save(fromKnobs(knobs, run.params)), 500)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [knobs, dirty, run, save])

  const editKnob = (patch: Partial<Knobs>) => {
    setKnobs((k) => (k ? { ...k, ...patch } : k))
    setDirty(true)
  }

  const addScenario = async (cloneFromId?: number) => {
    const name = window.prompt(cloneFromId ? 'Name for the copy' : 'Name the scenario', cloneFromId ? `${run?.name} (copy)` : 'Retire at 60')
    if (!name?.trim()) return
    try {
      const s = await post<{ id: number }>('/api/scenarios', { name: name.trim(), cloneFromId })
      setDirty(false)
      setSelected(s.id)
      await compare()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const rename = async () => {
    if (!run) return
    const name = window.prompt('Rename scenario', run.name)
    if (!name?.trim() || name.trim() === run.name) return
    await put(`/api/scenarios/${run.id}`, { name: name.trim() }).then(compare).catch((e) => setErr((e as Error).message))
  }
  const makeBaseline = async () => {
    if (!run) return
    await put(`/api/scenarios/${run.id}`, { isBaseline: true }).then(compare).catch((e) => setErr((e as Error).message))
  }
  const remove = async () => {
    if (!run || !cmp || cmp.runs.length <= 1) return
    if (!window.confirm(`Delete “${run.name}”?`)) return
    await del(`/api/scenarios/${run.id}`)
      .then(() => {
        setDirty(false)
        setSelected(null)
        return compare()
      })
      .catch((e) => setErr((e as Error).message))
  }

  const decisionEvent = (): SimEvent | null => {
    if (!run) return null
    const amount = money(decision.amount)
    const year = Number(decision.year) || run.params.buyYear
    if (!amount || !Number.isInteger(year)) return null
    const until = Number(decision.until)
    const ev: SimEvent = { year, amountCents: -Math.abs(amount) }
    if (Number.isInteger(until) && until > year) ev.untilYear = until
    if (decision.label.trim()) ev.label = decision.label.trim()
    return ev
  }
  const priceIt = async () => {
    const ev = decisionEvent()
    if (!run || !ev) return
    try {
      setPrice(await post<Price>('/api/scenarios/price', { scenarioId: run.id, event: ev, draw }))
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  const commitDecision = async () => {
    const ev = decisionEvent()
    if (!run || !ev) return
    setPrice(null)
    await save({ events: [...run.params.events, ev] })
  }
  const removeEvent = async (i: number) => {
    if (!run) return
    await save({ events: run.params.events.filter((_, j) => j !== i) })
  }

  if (cmp && !cmp.balance)
    return (
      <div className="card wide">
        <h2>Nothing to project yet</h2>
        <p>The simulation starts from your real balance sheet — import accounts and add holdings first.</p>
      </div>
    )
  if (!cmp || !run || !knobs || !base)
    return (
      <div className="card wide">
        <p className="sub2">{err ?? 'Running…'}</p>
      </div>
    )

  const idx = cmp.runs.findIndex((r) => r.id === run.id)
  const color = colorOf(idx)
  const longest = cmp.runs.reduce((a, r) => (r.result.years.length > a.length ? r.result.years : a), [] as number[])
  const endYear = run.result.years[run.result.years.length - 1]

  const knob = (key: keyof Knobs, label: string, width = 90, suffix = '') => (
    <span className="addform" key={key}>
      <label className="sub2">{label}</label>
      <input style={{ width }} value={String(knobs[key])} onChange={(e) => editKnob({ [key]: e.target.value })} />
      {suffix && <span className="sub2">{suffix}</span>}
    </span>
  )

  return (
    <div className="grid12">
      {/* ---------- scenario rail ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Scenarios</h2>
          <div className="right muted">
            real (inflation-adjusted) dollars · 2,000 paths · today's balance sheet {fmtShort(cmp.balance!.total)}
            {busy && <span className="muted"> · running…</span>}
          </div>
        </div>
        <div className="formrow" style={{ alignItems: 'center', gap: 8 }}>
          {cmp.runs.map((r, i) => (
            <button
              key={r.id}
              className={`chipbtn${r.id === run.id ? ' on' : ''}`}
              onClick={() => {
                setDirty(false)
                setSelected(r.id)
                setPrice(null)
              }}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}
            >
              <span className="sw" style={{ background: colorOf(i), width: 9, height: 9, borderRadius: 2, display: 'inline-block' }} />
              {r.name}
              {r.isBaseline && <span className="tag">baseline</span>}
            </button>
          ))}
          <button className="btn mini" onClick={() => void addScenario()}>+ New</button>
          <button className="btn mini ghosty" onClick={() => void addScenario(run.id)}>Duplicate</button>
          <button className="btn mini ghosty" onClick={() => void rename()}>Rename</button>
          {!run.isBaseline && <button className="btn mini ghosty" onClick={() => void makeBaseline()}>Set as baseline</button>}
          {cmp.runs.length > 1 && <button className="btn mini ghosty" onClick={() => void remove()}>Delete</button>}
          <span style={{ flex: 1 }} />
          <span className="sub2">Returns</span>
          <button className={`chipbtn${draw === 'lognormal' ? ' on' : ''}`} onClick={() => setDraw('lognormal')}>Lognormal</button>
          <button className={`chipbtn${draw === 'historical' ? ' on' : ''}`} onClick={() => setDraw('historical')}>Historical sequences</button>
          <span className="addform">
            <label className="sub2">Crossing at</label>
            <input style={{ width: 44 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            <span className="sub2">% odds</span>
          </span>
        </div>
        {err && <div className="sub2 neg" style={{ marginTop: 8 }}>{err}</div>}
      </div>

      {/* ---------- assumptions for the selected scenario ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>
            Assumptions · <span style={{ color }}>{run.name}</span>
          </h2>
          <div className="right muted">
            {dirty ? 'saving…' : 'saved'} · crypto slice {fmtShort(cmp.balance!.crypto)} (the shock knob hits this before anything runs)
          </div>
        </div>
        <div className="formrow">
          {knob('meanReturn', 'Real return', 60, '%')}
          {knob('vol', 'Volatility', 55, '%')}
          {knob('propertyGrowth', 'Property growth', 55, '%')}
          {knob('saveBefore', 'Save/yr now', 100)}
          {knob('saveAfter', 'Save/yr after buying', 100)}
          {knob('btcShock', 'BTC shock', 55, '%')}
        </div>
        <div className="formrow" style={{ marginTop: 8 }}>
          <label className="sub2" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={knobs.buyEnabled} onChange={(e) => editKnob({ buyEnabled: e.target.checked })} />
            Buy the dream home ({cmp.home ? fmtShort(cmp.home.priceCents) : '—'}
            {cmp.home?.loanName ? `, ${cmp.home.loanName}` : ', terms from the Dream Home tab'})
          </label>
          {knobs.buyEnabled && knob('buyYear', 'in', 70)}
          {knob('retireYear', 'Retire', 70)}
          {knob('retireSpend', 'Spend/yr retired', 100)}
          {knob('endYear', 'Project to', 70)}
        </div>
      </div>

      {/* ---------- overlay chart + odds ---------- */}
      <div className="card c9">
        <div className="h4row">
          <h2>Household net worth · simulated (today's dollars)</h2>
          <div className="right legend">
            {cmp.runs.map((r, i) => (
              <span className="li" key={r.id}>
                <span className="sw ln" style={{ background: colorOf(i), width: 14, height: 3, borderRadius: 2 }} />
                {r.name}
              </span>
            ))}
            <span className="li"><span className="sw" style={{ background: rgba(color, 0.16) }} />10–90th</span>
            <span className="li"><span className="sw" style={{ background: rgba(color, 0.32) }} />25–75th</span>
          </div>
        </div>
        <LineChart
          labels={longest.map(String)}
          series={cmp.runs.map((r, i) => ({
            name: r.name,
            color: colorOf(i),
            values: r.result.p50,
            dash: r.id === run.id ? undefined : '4 3',
          }))}
          bands={[
            { lo: run.result.p10, hi: run.result.p90, fill: rgba(color, 0.16) },
            { lo: run.result.p25, hi: run.result.p75, fill: rgba(color, 0.32) },
          ]}
          h={300}
          maxXTicks={7}
          tipLabel={(i) => `${longest[i]}`}
        />
        <div className="sub2" style={{ marginTop: 6 }}>
          Solid line and bands: {run.name}. Dashed: the other scenarios' medians.
        </div>
      </div>
      <div className="card c3">
        <h2>{run.name}</h2>
        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <div className="muted">Crossing date · ≥{cmp.thresholdPct}% odds</div>
            <div className="heronum" style={{ fontSize: 36, color }}>{run.crossingYear ?? '—'}</div>
            <div className="sub2">
              {run.crossingYear
                ? `earliest retirement year the plan still clears ${cmp.thresholdPct}%`
                : `no year before ${endYear} clears ${cmp.thresholdPct}%`}
              {run.delta?.crossingYears != null && run.delta.crossingYears !== 0 && (
                <>
                  {' '}
                  · <b className={cls(-run.delta.crossingYears)}>{signed(run.delta.crossingYears, ' yr')}</b> vs {base.name}
                </>
              )}
            </div>
          </div>
          <div>
            <div className="muted">Plan succeeds¹</div>
            <div className="v" style={{ fontSize: 24, fontWeight: 650 }}>
              {run.result.successPct}%
              {run.delta && <span className={`sub2 ${cls(run.delta.successPct)}`} style={{ marginLeft: 8 }}>{signed(run.delta.successPct, 'pp')}</span>}
            </div>
          </div>
          <div>
            <div className="muted">Median at {endYear}</div>
            <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
              {fmtShort(run.result.medianEndCents)}
              {run.delta && <span className={`sub2 ${cls(run.delta.medianEndCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.medianEndCents)}</span>}
            </div>
          </div>
          <div>
            <div className="muted">10th percentile</div>
            <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
              {fmtShort(run.result.p10EndCents)}
              {run.delta && <span className={`sub2 ${cls(run.delta.p10EndCents)}`} style={{ marginLeft: 8 }}>{signedMoney(run.delta.p10EndCents)}</span>}
            </div>
          </div>
          <div className="sub2 topline">
            ¹ {run.params.buyEnabled && cmp.home ? `buy the house in ${run.params.buyYear} and ` : ''}spend{' '}
            {formatCents(run.params.retireSpendCents)}/yr from {run.params.retireYear} without the liquid portfolio running out
            before {endYear}.
          </div>
        </div>
      </div>

      {/* ---------- side by side ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Side by side</h2>
          <div className="right muted">deltas vs {base.name} · {draw === 'historical' ? 'historical sequences' : 'lognormal draws'}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Scenario</th>
              <th className="r">Crossing (≥{cmp.thresholdPct}%)</th>
              <th className="r">Plan succeeds</th>
              <th className="r">Median at end</th>
              <th className="r">10th pct</th>
              <th>Retire</th>
              <th>Home</th>
              <th>Save/yr</th>
              <th>Spend/yr</th>
              <th>Events</th>
            </tr>
          </thead>
          <tbody>
            {cmp.runs.map((r, i) => (
              <tr key={r.id} className={r.id === run.id ? 'selrow' : undefined} onClick={() => { setDirty(false); setSelected(r.id); setPrice(null) }} style={{ cursor: 'pointer' }}>
                <td>
                  <span className="sw" style={{ background: colorOf(i), width: 9, height: 9, borderRadius: 2, display: 'inline-block', marginRight: 8 }} />
                  {r.name} {r.isBaseline && <span className="tag">baseline</span>}
                </td>
                <td className="r num">
                  {r.crossingYear ?? '—'}
                  {r.delta?.crossingYears != null && r.delta.crossingYears !== 0 && (
                    <span className={`sub2 ${cls(-r.delta.crossingYears)}`} style={{ marginLeft: 6 }}>{signed(r.delta.crossingYears)}</span>
                  )}
                </td>
                <td className="r num">
                  {r.result.successPct}%
                  {r.delta && <span className={`sub2 ${cls(r.delta.successPct)}`} style={{ marginLeft: 6 }}>{signed(r.delta.successPct, 'pp')}</span>}
                </td>
                <td className="r num">
                  {fmtShort(r.result.medianEndCents)}
                  {r.delta && <span className={`sub2 ${cls(r.delta.medianEndCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.medianEndCents)}</span>}
                </td>
                <td className="r num">
                  {fmtShort(r.result.p10EndCents)}
                  {r.delta && <span className={`sub2 ${cls(r.delta.p10EndCents)}`} style={{ marginLeft: 6 }}>{signedMoney(r.delta.p10EndCents)}</span>}
                </td>
                <td className="num">{r.params.retireYear}</td>
                <td className="num">{r.params.buyEnabled && cmp.home ? `buy ${r.params.buyYear}` : 'no purchase'}</td>
                <td className="num">
                  {fmtShort(r.params.saveBeforeBuyCents)}
                  {r.params.buyEnabled && cmp.home && ` → ${fmtShort(r.params.saveAfterBuyCents)}`}
                </td>
                <td className="num">{fmtShort(r.params.retireSpendCents)}</td>
                <td className="sub2">{r.params.events.length ? r.params.events.map((e) => e.label ?? `${fmtShort(e.amountCents)} ${e.year}`).join(' · ') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ---------- price a decision ---------- */}
      <div className="card c6">
        <div className="h4row">
          <h2>Price a decision</h2>
          <div className="right muted">against {run.name}</div>
        </div>
        <div className="formrow">
          <span className="addform">
            <label className="sub2">What</label>
            <input style={{ width: 140 }} placeholder="Kitchen remodel" value={decision.label} onChange={(e) => setDecision((d) => ({ ...d, label: e.target.value }))} />
          </span>
          <span className="addform">
            <label className="sub2">Costs $</label>
            <input style={{ width: 90 }} value={decision.amount} onChange={(e) => setDecision((d) => ({ ...d, amount: e.target.value }))} />
          </span>
          <span className="addform">
            <label className="sub2">in</label>
            <input style={{ width: 60 }} placeholder={String(run.params.buyYear)} value={decision.year} onChange={(e) => setDecision((d) => ({ ...d, year: e.target.value }))} />
          </span>
          <span className="addform">
            <label className="sub2">every year until</label>
            <input style={{ width: 60 }} placeholder="—" value={decision.until} onChange={(e) => setDecision((d) => ({ ...d, until: e.target.value }))} />
          </span>
          <button className="btn mini" onClick={() => void priceIt()}>Price it</button>
        </div>
        {price && (
          <div className="topline">
            <div style={{ fontSize: 15 }}>
              <b className="inkstrong">{formatCents(Math.abs(money(decision.amount)))}</b>
              {decision.until && Number(decision.until) > (Number(decision.year) || run.params.buyYear) ? ' a year' : ''} in{' '}
              {decision.year || run.params.buyYear} is <b className="inkstrong">{fmtShort(Math.abs(price.futureValueCents))}</b> at{' '}
              {price.atYear}
              {' · '}odds <b className="inkstrong">{price.successBeforePct}%</b> →{' '}
              <b className={cls(price.successAfterPct - price.successBeforePct)}>{price.successAfterPct}%</b>
              {' · '}median at {endYear}{' '}
              <b className={cls(price.medianEndAfterCents - price.medianEndBeforeCents)}>{signedMoney(price.medianEndAfterCents - price.medianEndBeforeCents)}</b>
            </div>
            <div className="sub2" style={{ marginTop: 6 }}>
              Future value compounds the outlay at the scenario's real return to {price.atYear} — what the money would have been if left invested. The odds and median deltas come from re-running the simulation with the event in it.
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="btn mini gold" onClick={() => void commitDecision()}>Add to {run.name}</button>
            </div>
          </div>
        )}
      </div>
      <div className="card c6">
        <div className="h4row">
          <h2>Events in {run.name}</h2>
          <div className="right muted">dated cash flows against the liquid portfolio</div>
        </div>
        {run.params.events.length === 0 ? (
          <p className="sub2">None yet. Price a decision and add it, or use one to model a sabbatical, an inheritance, a mortgage payoff, tuition.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Event</th><th>When</th><th className="r">Amount</th><th /></tr>
            </thead>
            <tbody>
              {run.params.events.map((e, i) => (
                <tr key={i}>
                  <td>{e.label ?? <span className="muted">untitled</span>}</td>
                  <td className="num">{e.untilYear ? `${e.year}–${e.untilYear}, yearly` : e.year}</td>
                  <td className={`r num ${e.amountCents < 0 ? 'neg' : 'pos'}`}>{formatCents(e.amountCents, { sign: true })}</td>
                  <td className="r"><button className="btn mini ghosty" onClick={() => void removeEvent(i)}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card c12">
        <h2>How to read this</h2>
        <p>
          Each scenario is a set of assumptions run over the same balance sheet — 2,000 futures, in real dollars, with the
          same random seed so two scenarios differ only where their knobs differ. <b className="inkstrong">Lognormal</b>{' '}
          draws each year's return independently from your return and volatility. <b className="inkstrong">Historical
          sequences</b> instead replay ten-year runs of actual US stock real returns since 1928, re-centred to your return and
          volatility — same expected return, real order of events, so a 1966 or 2000 start can happen. Property grows
          deterministically, the down payment leaves the portfolio in the purchase year, the new mortgage amortizes, events
          land in their years, and saving switches to spending at retirement. The crossing date is the earliest retirement
          year at which the plan still clears the odds threshold with everything else held fixed. A flashlight, not a promise
          — revisit the assumptions yearly.
        </p>
      </div>
    </div>
  )
}
