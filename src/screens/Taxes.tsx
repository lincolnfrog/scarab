import { useCallback, useEffect, useState } from 'react'
import { formatCents, formatQtyMicro, parseMoney } from '../../shared/money'
import { get, put } from '../api'

type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh'
type StateInfo = {
  code: string
  name: string
  kind: 'none' | 'flat' | 'brackets' | 'custom'
  rateMicro?: number
  vintage?: string
  note?: string
}
type TaxSettings = {
  filingStatus: FilingStatus
  state: string
  customStateRateMicro: number
  wagesAnnualCents: number
  otherIncomeCents: number
  deductionMode: 'standard' | 'itemized'
  itemizedCents: number
  withheldFederalCents: number
  withheldStateCents: number
  estPaidFederalCents: number
  estPaidStateCents: number
  priorYearTaxFederalCents: number
  priorYearTaxStateCents: number
  priorYearAgiOver150k: boolean
  qualifiedDividendShareMicro: number
}
type VestEvent = { symbol: string; account: string; vest_on: string; qty_micro: number; cents: number | null }
type SafeHarbor = {
  rule: string
  weights: [number, number, number, number]
  assumed: boolean
  requiredCents: number
  basis: string
  paidCents: number
  remainingCents: number
  thresholdCents: number
  belowThreshold: boolean
  priorYearHarborAvailable: boolean
  quarters: { due: string; past: boolean; cents: number; weightPct: number }[]
}
type HarvestLot = {
  symbol: string
  trade_id: number | null
  opened_on: string
  qty_micro: number
  cost_cents: number
  value_cents: number
  gain_cents: number
  term: 'st' | 'lt'
  days_to_lt: number
  wash_risk: boolean
  tax_delta_cents: number
  after_tax_cents: number
}
type Tax = {
  vintage: string
  states: StateInfo[]
  year: number
  settings: TaxSettings
  incomes: {
    wagesCents: number
    otherCents: number
    rsuYtdCents: number
    rsuProjectedCents: number
    rsuProjected: VestEvent[]
    rsuUnpriced: number
    dividendsYtdCents: number
    dividendsQualifiedCents: number
    dividendsOrdinaryCents: number
    realizedStCents: number
    realizedLtCents: number
    totalIncomeCents: number
    deductionCents: number
  }
  tax: {
    netStCents: number
    netLtCents: number
    capLossUsedCents: number
    capLossCarryCents: number
    taxableOrdinaryCents: number
    taxableLtCents: number
    qualifiedDividendCents: number
    fedOrdinaryCents: number
    fedLtCents: number
    niitCents: number
    fedTotalCents: number
    stateCents: number
    mhstCents: number
    totalCents: number
  }
  marginal: { ordinaryMicro: number; stMicro: number; ltMicro: number }
  effRateMicro: number
  fedGapCents: number
  stateGapCents: number
  safeHarbor: SafeHarbor
  stateSafeHarbor: SafeHarbor | null
  harvest: {
    rows: HarvestLot[]
    totals: { harvestableStCents: number; harvestableLtCents: number; estTaxSavedCents: number; washFlagged: number }
  }
}

const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
const money = (cents: number) => (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })

type Form = {
  filingStatus: FilingStatus
  state: string
  customStateRate: string
  wages: string
  other: string
  deductionMode: 'standard' | 'itemized'
  itemized: string
  withheldFederal: string
  withheldState: string
  estPaidFederal: string
  estPaidState: string
  priorYearTax: string
  priorYearTaxState: string
  priorYearAgiOver150k: boolean
  qualifiedShare: string
}

const toForm = (s: TaxSettings): Form => ({
  filingStatus: s.filingStatus,
  state: s.state,
  customStateRate: s.customStateRateMicro ? (s.customStateRateMicro / 10_000).toString() : '',
  wages: s.wagesAnnualCents ? money(s.wagesAnnualCents) : '',
  other: s.otherIncomeCents ? money(s.otherIncomeCents) : '',
  deductionMode: s.deductionMode,
  itemized: s.itemizedCents ? money(s.itemizedCents) : '',
  withheldFederal: s.withheldFederalCents ? money(s.withheldFederalCents) : '',
  withheldState: s.withheldStateCents ? money(s.withheldStateCents) : '',
  estPaidFederal: s.estPaidFederalCents ? money(s.estPaidFederalCents) : '',
  estPaidState: s.estPaidStateCents ? money(s.estPaidStateCents) : '',
  priorYearTax: s.priorYearTaxFederalCents ? money(s.priorYearTaxFederalCents) : '',
  priorYearTaxState: s.priorYearTaxStateCents ? money(s.priorYearTaxStateCents) : '',
  priorYearAgiOver150k: s.priorYearAgiOver150k,
  qualifiedShare: s.qualifiedDividendShareMicro ? (s.qualifiedDividendShareMicro / 10_000).toString() : '',
})

function Schedule({ title, sh }: { title: string; sh: SafeHarbor }) {
  const weighted = sh.weights.some((w) => w !== sh.weights[0])
  return (
    <>
      <div className="sub2 topline">
        {title} ({sh.basis}): <b className="inkstrong">{formatCents(sh.requiredCents)}</b> —{' '}
        {sh.belowThreshold ? (
          <>the shortfall after withholding is under {formatCents(sh.thresholdCents)}, so no estimated payments are required.</>
        ) : sh.remainingCents > 0 ? (
          <>still <b className="inkstrong">{formatCents(sh.remainingCents)}</b> to pay across the remaining dates:</>
        ) : (
          <>covered by projected withholding and payments. No estimated payments required.</>
        )}
        {!sh.priorYearHarborAvailable && <> Prior-year safe harbor unavailable at this income — 90% of this year applies.</>}
      </div>
      {sh.remainingCents > 0 && (
        <table style={{ marginTop: 8 }}>
          <tbody>
            {sh.quarters.map((q) => (
              <tr key={q.due}>
                <td className={q.past ? 'muted' : ''}>
                  {q.due}{q.past ? ' · passed' : ''}
                  {weighted && <span className="muted"> · {q.weightPct}%</span>}
                </td>
                <td className="r num">{q.past ? '—' : formatCents(q.cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="sub2" style={{ marginTop: 6 }}>
        {sh.rule}
        {weighted ? ` — installments weighted ${sh.weights.join('/')}.` : '.'}
        {sh.assumed && ' This state\'s actual schedule and thresholds are not bundled; the federal shape is assumed.'}
      </p>
    </>
  )
}

export default function Taxes() {
  const [tax, setTax] = useState<Tax | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const t = await get<Tax>('/api/tax')
    setTax(t)
    setForm((f) => f ?? toForm(t.settings))
  }, [])

  useEffect(() => {
    load().catch((e) => setMsg(`${e instanceof Error ? e.message : e}`))
  }, [load])

  async function save() {
    if (!form) return
    setSaving(true)
    setMsg(null)
    try {
      const dollars = (v: string) => (v.trim() ? parseMoney(v) : 0)
      await put('/api/tax/settings', {
        filingStatus: form.filingStatus,
        state: form.state,
        customStateRateMicro: form.customStateRate.trim()
          ? Math.round(Number(form.customStateRate) * 10_000)
          : 0,
        wagesAnnualCents: dollars(form.wages),
        otherIncomeCents: dollars(form.other),
        deductionMode: form.deductionMode,
        itemizedCents: dollars(form.itemized),
        withheldFederalCents: dollars(form.withheldFederal),
        withheldStateCents: dollars(form.withheldState),
        estPaidFederalCents: dollars(form.estPaidFederal),
        estPaidStateCents: dollars(form.estPaidState),
        priorYearTaxFederalCents: dollars(form.priorYearTax),
        priorYearTaxStateCents: dollars(form.priorYearTaxState),
        priorYearAgiOver150k: form.priorYearAgiOver150k,
        qualifiedDividendShareMicro: form.qualifiedShare.trim()
          ? Math.round(Number(form.qualifiedShare) * 10_000)
          : 0,
      })
      await load()
      setMsg('Saved — every number on this screen just recomputed.')
    } catch (e) {
      setMsg(`Could not save — ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  if (!tax || !form) return <div className="card">{msg ?? 'Deriving the tax picture…'}</div>

  const { incomes, tax: t, safeHarbor: sh, stateSafeHarbor: ssh, harvest } = tax
  const stateInfo = tax.states.find((s) => s.code === form.state)
  const stateName = stateInfo?.name ?? 'State'
  const hasQualified = incomes.dividendsQualifiedCents > 0
  const gap = tax.fedGapCents + tax.stateGapCents
  const losses = harvest.rows.filter((r) => r.gain_cents < 0)
  const nearLt = harvest.rows.filter((r) => r.gain_cents > 0 && r.term === 'st' && r.days_to_lt <= 90)
  const setF = (patch: Partial<Form>) => setForm({ ...form, ...patch })

  return (
    <div className="grid12">
      {/* ---------- headline ---------- */}
      <div className="card c8">
        <h2>Projected {tax.year} tax</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <div className="heronum" style={{ fontSize: 44 }}>{formatCents(t.totalCents)}</div>
          <span className={`delta ${gap > 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600, fontSize: 13 }}>
            {gap > 0 ? `▲ ${formatCents(gap)} more than you're on track to pay` : `▼ ${formatCents(-gap)} over-withheld so far`}
          </span>
        </div>
        <table style={{ marginTop: 14 }}>
          <tbody>
            <tr><td className="muted">Federal — ordinary income</td><td className="r num">{formatCents(t.fedOrdinaryCents)}</td></tr>
            <tr><td className="muted">Federal — long-term gains{hasQualified ? ' & qualified dividends' : ''}</td><td className="r num">{formatCents(t.fedLtCents)}</td></tr>
            {t.niitCents > 0 && <tr><td className="muted">Net investment income tax (3.8%)</td><td className="r num">{formatCents(t.niitCents)}</td></tr>}
            <tr><td className="muted">{stateInfo?.name ?? 'State'}{t.mhstCents > 0 ? ' (incl. 1% MHST)' : ''}</td><td className="r num">{formatCents(t.stateCents)}</td></tr>
          </tbody>
        </table>
        <div className="sub2 topline">
          Effective rate <b className="inkstrong">{pct(tax.effRateMicro)}</b> · next dollar of salary
          taxed at <b className="inkstrong">{pct(tax.marginal.ordinaryMicro)}</b> · short-term gain{' '}
          <b className="inkstrong">{pct(tax.marginal.stMicro)}</b> · long-term gain{' '}
          <b className="inkstrong">{pct(tax.marginal.ltMicro)}</b>
        </div>
      </div>

      {/* ---------- income picture ---------- */}
      <div className="card c4">
        <h2>Income this year</h2>
        <table>
          <tbody>
            <tr><td className="muted">Salary (projected)</td><td className="r num">{formatCents(incomes.wagesCents)}</td></tr>
            <tr><td className="muted">RSU vests (from the ledger)</td><td className="r num">{formatCents(incomes.rsuYtdCents)}</td></tr>
            {(incomes.rsuProjected.length > 0 || incomes.rsuUnpriced > 0) && (
              <tr>
                <td className="muted" title={incomes.rsuProjected.map((e) => `${e.vest_on} · ${formatQtyMicro(e.qty_micro)} ${e.symbol}${e.cents === null ? ' (no price yet)' : ` ≈ ${formatCents(e.cents)}`}`).join('\n')}>
                  RSU vests still to come ({incomes.rsuProjected.length}, at today's price)
                  {incomes.rsuUnpriced > 0 && <span title="Some scheduled vests have no price on file — add one in Invest"> ⚠</span>}
                </td>
                <td className="r num">{formatCents(incomes.rsuProjectedCents)}</td>
              </tr>
            )}
            {hasQualified ? (
              <>
                <tr><td className="muted">Qualified dividends</td><td className="r num">{formatCents(incomes.dividendsQualifiedCents)}</td></tr>
                <tr><td className="muted">Ordinary dividends &amp; interest</td><td className="r num">{formatCents(incomes.dividendsOrdinaryCents)}</td></tr>
              </>
            ) : (
              <tr><td className="muted">Dividends &amp; interest</td><td className="r num">{formatCents(incomes.dividendsYtdCents)}</td></tr>
            )}
            <tr><td className="muted">Other income</td><td className="r num">{formatCents(incomes.otherCents)}</td></tr>
            <tr><td className="muted">Realized short-term</td><td className={`r num ${incomes.realizedStCents < 0 ? 'neg' : ''}`}>{formatCents(incomes.realizedStCents, { sign: incomes.realizedStCents > 0 })}</td></tr>
            <tr><td className="muted">Realized long-term</td><td className={`r num ${incomes.realizedLtCents < 0 ? 'neg' : ''}`}>{formatCents(incomes.realizedLtCents, { sign: incomes.realizedLtCents > 0 })}</td></tr>
            {t.capLossUsedCents > 0 && <tr><td className="muted">Capital loss vs ordinary</td><td className="r num">−{formatCents(t.capLossUsedCents)}</td></tr>}
            {t.capLossCarryCents > 0 && <tr><td className="muted">Loss carryforward</td><td className="r num">{formatCents(t.capLossCarryCents)}</td></tr>}
            <tr><td className="muted">Deduction ({tax.settings.deductionMode})</td><td className="r num">−{formatCents(incomes.deductionCents)}</td></tr>
            <tr><td className="strong">Taxable</td><td className="r num strong">{formatCents(t.taxableOrdinaryCents + t.taxableLtCents)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* ---------- withholding & quarterlies ---------- */}
      <div className="card c6">
        <h2>Withholding gap &amp; safe harbor</h2>
        <table>
          <tbody>
            <tr><td className="muted">Federal liability (projected)</td><td className="r num">{formatCents(t.fedTotalCents)}</td></tr>
            <tr><td className="muted">Federal withholding + est. payments</td><td className="r num">{formatCents(sh.paidCents)}</td></tr>
            <tr>
              <td className="strong">Federal gap</td>
              <td className={`r num strong ${tax.fedGapCents > 0 ? 'neg' : 'pos'}`}>{formatCents(tax.fedGapCents, { sign: tax.fedGapCents > 0 })}</td>
            </tr>
            <tr><td className="muted">{stateInfo?.name ?? 'State'} gap</td><td className={`r num ${tax.stateGapCents > 0 ? 'neg' : 'pos'}`}>{formatCents(tax.stateGapCents, { sign: tax.stateGapCents > 0 })}</td></tr>
          </tbody>
        </table>
        <Schedule title="Federal safe harbor" sh={sh} />
        {ssh && <Schedule title={`${stateName} safe harbor`} sh={ssh} />}
        {!ssh && (
          <p className="sub2" style={{ marginTop: 8 }}>No state income tax — no state estimated payments.</p>
        )}
      </div>

      {/* ---------- harvesting ---------- */}
      <div className="card c6">
        <h2>Loss harvesting</h2>
        {losses.length === 0 ? (
          <p className="sub2">
            No open lot is under water at today's prices — nothing to harvest. Short-term gain lots
            approaching long-term status will appear here as they get close.
          </p>
        ) : (
          <>
            <div className="sub2" style={{ marginBottom: 8 }}>
              Harvestable: <b className="inkstrong">{formatCents(harvest.totals.harvestableStCents + harvest.totals.harvestableLtCents)}</b>{' '}
              in losses · est. tax saved <b className="inkstrong">{formatCents(harvest.totals.estTaxSavedCents)}</b>
              {harvest.totals.washFlagged > 0 && <> · ⚠ {harvest.totals.washFlagged} wash-sale risk{harvest.totals.washFlagged > 1 ? 's' : ''}</>}
            </div>
            <table>
              <thead>
                <tr><th>Lot</th><th className="r">Qty</th><th className="r">Value</th><th className="r">Loss</th><th>Term</th><th className="r">Tax saved</th></tr>
              </thead>
              <tbody>
                {losses.map((l, i) => (
                  <tr key={`${l.symbol}-${l.trade_id ?? i}`}>
                    <td><span className="tk"><span className="lg">{l.symbol}</span></span> <span className="muted">{l.opened_on}</span>{l.wash_risk && <span title="A buy of this asset in the last 30 days would disallow the loss (wash sale). Vests count as buys — and one within 30 days after selling triggers it too."> ⚠</span>}</td>
                    <td className="r num">{formatQtyMicro(l.qty_micro)}</td>
                    <td className="r num">{formatCents(l.value_cents)}</td>
                    <td className="r num neg">{formatCents(l.gain_cents)}</td>
                    <td className="muted">{l.term === 'lt' ? 'long' : 'short'}</td>
                    <td className="r num pos">{formatCents(-l.tax_delta_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {nearLt.length > 0 && (
          <div className="sub2 topline">
            Almost long-term:{' '}
            {nearLt
              .sort((a, b) => a.days_to_lt - b.days_to_lt)
              .slice(0, 4)
              .map((l) => (
                <span key={`${l.symbol}-${l.trade_id}`} style={{ marginRight: 10 }}>
                  <b className="inkstrong">{l.symbol}</b> {l.opened_on} · {l.days_to_lt}d → saves{' '}
                  {formatCents(Math.round((l.gain_cents * (tax.marginal.stMicro - tax.marginal.ltMicro)) / 1_000_000))}
                </span>
              ))}
          </div>
        )}
      </div>

      {/* ---------- settings ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Tax settings</h2>
          <div className="right">
            <button className="btn gold" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save & recompute'}</button>
          </div>
        </div>
        <div className="formrow">
          <select value={form.filingStatus} onChange={(e) => setF({ filingStatus: e.target.value as FilingStatus })}>
            <option value="mfj">Married filing jointly</option>
            <option value="single">Single</option>
            <option value="mfs">Married filing separately</option>
            <option value="hoh">Head of household</option>
          </select>
          <select value={form.state} onChange={(e) => setF({ state: e.target.value })}>
            {tax.states.map((s) => (
              <option key={s.code} value={s.code}>{s.name}</option>
            ))}
          </select>
          {stateInfo?.kind === 'custom' && (
            <input className="qty" placeholder="state marginal %" title="This state's brackets aren't bundled yet — enter your marginal rate" value={form.customStateRate} onChange={(e) => setF({ customStateRate: e.target.value })} />
          )}
          <select value={form.deductionMode} onChange={(e) => setF({ deductionMode: e.target.value as 'standard' | 'itemized' })}>
            <option value="standard">Standard deduction</option>
            <option value="itemized">Itemized</option>
          </select>
          {form.deductionMode === 'itemized' && (
            <input className="money" placeholder="itemized total $" value={form.itemized} onChange={(e) => setF({ itemized: e.target.value })} />
          )}
        </div>
        <div className="formrow" style={{ marginTop: 8 }}>
          <input className="money" placeholder="salary, full year $" title="Projected W-2 gross for the year, excluding RSU vests (those come from the ledger)" value={form.wages} onChange={(e) => setF({ wages: e.target.value })} />
          <input className="money" placeholder="other income $" value={form.other} onChange={(e) => setF({ other: e.target.value })} />
          <input className="money" placeholder="federal withholding $" title="Projected full-year federal withholding — paystub year-to-date extrapolated, plus RSU supplemental withholding" value={form.withheldFederal} onChange={(e) => setF({ withheldFederal: e.target.value })} />
          <input className="money" placeholder="state withholding $" value={form.withheldState} onChange={(e) => setF({ withheldState: e.target.value })} />
          <input className="money" placeholder="federal est. payments made $" value={form.estPaidFederal} onChange={(e) => setF({ estPaidFederal: e.target.value })} />
          <input className="money" placeholder="last year's federal tax $" title="Total tax from last year's 1040 — sets the safe-harbor floor" value={form.priorYearTax} onChange={(e) => setF({ priorYearTax: e.target.value })} />
          {stateInfo && stateInfo.kind !== 'none' && (
            <>
              <input className="money" placeholder="state est. payments made $" value={form.estPaidState} onChange={(e) => setF({ estPaidState: e.target.value })} />
              <input className="money" placeholder="last year's state tax $" title="Total tax from last year's state return — sets the state safe-harbor floor" value={form.priorYearTaxState} onChange={(e) => setF({ priorYearTaxState: e.target.value })} />
            </>
          )}
          <label className="sub2" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={form.priorYearAgiOver150k} onChange={(e) => setF({ priorYearAgiOver150k: e.target.checked })} />
            AGI over $150k last year (110% safe harbor)
          </label>
        </div>
        <div className="formrow" style={{ marginTop: 8 }}>
          <input className="qty" placeholder="qualified dividend %" title="Share of 'Dividends & interest' transactions that are qualified dividends (taxed at long-term rates). Broad ETFs run 90%+; interest is 0%. Blank = all ordinary." value={form.qualifiedShare} onChange={(e) => setF({ qualifiedShare: e.target.value })} />
          <span className="sub2">of dividends &amp; interest are qualified dividends</span>
        </div>
        {msg && <div className="sub2 importmsg">{msg}</div>}
        <p className="sub2" style={{ marginTop: 10 }}>
          Estimation for planning, not tax advice or preparation. Brackets: {tax.vintage}.
          {stateInfo?.note ? ` ${stateInfo.note}` : ''} RSU vest income and
          realized gains are derived from the ledger; scheduled vests are valued at today's price (set the
          cadence in Invest → Unvested RSUs); dividends from categorized transactions. Payroll taxes
          (Social Security, Medicare) are not modeled. Washington's capital-gains excise and Massachusetts's
          millionaire surtax are not modeled. Verify with a professional before acting.
        </p>
      </div>
    </div>
  )
}
