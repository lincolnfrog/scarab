import { useCallback, useEffect, useState, type RefCallback } from 'react'
import type { Timing, TimingKind, TwoYear, YearView } from '../../engine/twoyear'
import { formatDollars } from '../../shared/money'
import { get, post } from '../api'
import { Button } from '../ui/Button'
import { Field, MoneyInput, Select } from '../ui/Field'
import { Skeleton } from '../ui/Skeleton'
import { useAction } from '../ui/useAction'
import './twoyear.css'

const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
const KIND: { kind: TimingKind; label: string; verb: string }[] = [
  { kind: 'lt-gain', label: 'Long-term gain', verb: 'Realize' },
  { kind: 'st-gain', label: 'Short-term gain', verb: 'Realize' },
  { kind: 'loss', label: 'Loss (harvest)', verb: 'Harvest' },
  { kind: 'bonus', label: 'Bonus or other pay', verb: 'Take' },
  { kind: 'conversion', label: 'Roth conversion', verb: 'Convert' },
]

const ROWS: { label: string; of: (y: YearView) => number; show?: (a: YearView, b: YearView) => boolean; neg?: boolean }[] = [
  { label: 'Wages', of: (y) => y.wagesCents },
  { label: 'Stock comp', of: (y) => y.rsuCents, show: (a, b) => a.rsuCents + b.rsuCents > 0 },
  { label: 'Dividends & interest', of: (y) => y.dividendsCents, show: (a, b) => a.dividendsCents + b.dividendsCents > 0 },
  { label: 'Other income', of: (y) => y.otherCents, show: (a) => a.otherCents > 0 },
  { label: 'Realized short-term', of: (y) => y.stGainCents, show: (a, b) => a.stGainCents !== 0 || b.stGainCents !== 0 },
  { label: 'Realized long-term', of: (y) => y.ltGainCents, show: (a, b) => a.ltGainCents !== 0 || b.ltGainCents !== 0 },
  { label: 'Loss carried in', of: (y) => -(y.carryInStCents + y.carryInLtCents), show: (_, b) => b.carryInStCents + b.carryInLtCents > 0 },
  { label: 'Deduction', of: (y) => -y.deductionCents },
  { label: 'Federal tax', of: (y) => y.tax.fedTotalCents },
  { label: 'State tax', of: (y) => y.tax.stateCents, show: (a, b) => a.tax.stateCents + b.tax.stateCents > 0 },
]

/**
 * This year and next, side by side (copilot §4e): next year on the same
 * settings — the paychecks for a full year, the grants' scheduled vests, a
 * year of dividends, this year's loss carryforward — on this year's tables;
 * and a timing question priced over both years: the same amount now or in
 * January. `version` bumps when the Taxes screen reloads.
 */
export default function TwoYearCard({ anchor, version }: { anchor?: RefCallback<HTMLElement>; version: number }) {
  const [v, setV] = useState<TwoYear | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [kind, setKind] = useState<TimingKind>('lt-gain')
  const [amount, setAmount] = useState<number | null>(2_500_000)
  const [timing, setTiming] = useState<Timing | null>(null)
  const load = useCallback(async () => {
    setV(await get<TwoYear>('/api/tax/two-year'))
    setErr(null)
  }, [])
  useEffect(() => {
    load().catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
    setTiming(null) // priced against the old numbers
  }, [load, version])
  const price = useAction((k: TimingKind, cents: number) => post<Timing>('/api/tax/timing', { kind: k, amountCents: cents }), {
    errorPrefix: "Couldn't price the timing",
    onDone: setTiming,
  })

  if (!v)
    return (
      <div className="card c12" ref={anchor}>
        <h2>This year and next</h2>
        {err ? <p className="sub2">Couldn't project next year: {err}</p> : <Skeleton h={160} />}
      </div>
    )
  const a = v.thisYear
  const b = v.nextYear
  const meta = KIND.find((k) => k.kind === kind)!
  const t = timing && timing.kind === kind && timing.amountCents === amount ? timing : null

  return (
    <div className="card c12" ref={anchor}>
      <div className="h4row">
        <h2>This year and next</h2>
        <div className="right">
          <span className="muted">{v.vintage}</span>
        </div>
      </div>
      <div className="ty-grid">
        <div className="ui-tablewrap">
          <table className="ty-table">
            <thead>
              <tr>
                <th />
                <th className="r">{a.year}</th>
                <th className="r">{b.year}</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.filter((r) => !r.show || r.show(a, b)).map((r) => (
                <tr key={r.label}>
                  <td className="muted">{r.label}</td>
                  <td className="r num">{formatDollars(r.of(a))}</td>
                  <td className="r num">{formatDollars(r.of(b))}</td>
                </tr>
              ))}
              <tr>
                <td className="strong">Total tax</td>
                <td className="r num strong">{formatDollars(a.tax.totalCents)}</td>
                <td className="r num strong">{formatDollars(b.tax.totalCents)}</td>
              </tr>
              <tr>
                <td className="muted">Next dollar of pay / LT gain</td>
                <td className="r num">{pct(a.marginal.ordinaryMicro)} / {pct(a.marginal.ltMicro)}</td>
                <td className="r num">{pct(b.marginal.ordinaryMicro)} / {pct(b.marginal.ltMicro)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="ty-timing">
          <h3>Now or in January?</h3>
          <form
            className="scr-fields"
            noValidate
            onSubmit={(e) => {
              e.preventDefault()
              if (amount && amount > 0) void price.run(kind, amount)
            }}
          >
            <div className="scr-f lg">
              <Field label="What">
                <Select value={kind} onChange={(e) => setKind(e.target.value as TimingKind)}>
                  {KIND.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                </Select>
              </Field>
            </div>
            <div className="scr-f">
              <Field label="How much">
                <MoneyInput value={amount} onChange={setAmount} />
              </Field>
            </div>
            <Button type="submit" size="mini" busy={price.busy} disabled={!amount} style={{ marginTop: 24 }}>
              Price it
            </Button>
          </form>
          {t && (
            <div className="ty-result">
              <div>
                {meta.verb} in {a.year}: <b className="inkstrong">{formatDollars(t.nowCents.total)}</b> over both years
                <span className="muted"> ({formatDollars(t.nowCents.thisYear)} + {formatDollars(t.nowCents.nextYear)})</span>
              </div>
              <div>
                {meta.verb} in {b.year}: <b className="inkstrong">{formatDollars(t.laterCents.total)}</b>
                <span className="muted"> ({formatDollars(t.laterCents.thisYear)} + {formatDollars(t.laterCents.nextYear)})</span>
              </div>
              <div className="ty-verdict">
                {t.nowSavesCents === 0
                  ? 'The same either way — the two years tax it alike.'
                  : t.nowSavesCents > 0
                    ? `${a.year} costs ${formatDollars(t.nowSavesCents)} less over the two years.`
                    : `${b.year} costs ${formatDollars(-t.nowSavesCents)} less over the two years.`}
              </div>
            </div>
          )}
          <ul className="ty-basis">
            {v.basis.map((x) => <li key={x}>{x}</li>)}
            <li>Waiting a year also means a year longer before the tax is paid, or the gain is kept — not counted. An estimate, not advice.</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
