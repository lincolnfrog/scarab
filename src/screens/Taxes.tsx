import { useCallback, useEffect, useState } from 'react'
import { formatCents, formatQtyMicro, parseMoney } from '../../shared/money'
import { del, get, post, put } from '../api'

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
  rsuWithholdFederalMicro: number
  rsuWithholdStateMicro: number | null
}
type VestEvent = { symbol: string; account: string; account_id: number; vest_on: string; qty_micro: number; cents: number | null }
type PayCadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'
type PayAmounts = { grossCents: number; retirementCents: number; benefitsCents: number; fedWithheldCents: number; stateWithheldCents: number }
type PaySource = {
  id: number
  earner: string
  employer: string
  cadence: PayCadence
  paidOn: string
  grossCents: number
  retirementCents: number
  benefitsCents: number
  fedWithheldCents: number
  stateWithheldCents: number
  ytdGrossCents: number | null
  ytdRetirementCents: number | null
  ytdBenefitsCents: number | null
  ytdFedWithheldCents: number | null
  ytdStateWithheldCents: number | null
  investAccountId: number | null
}
type PayProjection = PaySource & {
  stale: boolean
  ytdEstimated: boolean
  periodsElapsed: number
  periodsRemaining: number
  ytd: PayAmounts
  projected: PayAmounts & { taxableWagesCents: number; ficaWagesCents: number }
}
type EarnerPayroll = {
  earner: string
  wagesCents: number
  rsuCents: number
  ficaWagesCents: number
  fedWithheldCents: number
  stateWithheldCents: number
  socialSecurityCents: number
  socialSecurityWithheldCents: number
  medicareCents: number
  addlMedicareWithheldCents: number
}
type Payroll = {
  sources: PayProjection[]
  earners: EarnerPayroll[]
  wagesCents: number
  fedWithheldCents: number
  stateWithheldCents: number
  ficaWagesCents: number
  socialSecurityCents: number
  excessSocialSecurityCents: number
  medicareCents: number
  addlMedicareCents: number
  addlMedicareWithheldCents: number
  stale: number
}
type InvestAccount = { id: number; name: string; tracking: string }
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
    wagesFromPaychecks: boolean
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
    addlMedicareCents: number
    fedTotalCents: number
    stateCents: number
    mhstCents: number
    totalCents: number
  }
  marginal: { ordinaryMicro: number; stMicro: number; ltMicro: number }
  effRateMicro: number
  payroll: Payroll
  rsuWithholding: { baseCents: number; federalMicro: number; stateMicro: number; federalCents: number; stateCents: number }
  withheldFederalCents: number
  withheldStateCents: number
  fedCreditsCents: number
  estPaidFederalCents: number
  estPaidStateCents: number
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
const pct2 = (micro: number) => `${(micro / 10_000).toFixed(2).replace(/\.?0+$/, '')}%`
const money = (cents: number) => (cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })
const CADENCE_LABEL: Record<PayCadence, string> = { weekly: 'weekly', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'monthly' }

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
  rsuFed: string
  rsuState: string
}

type PayForm = {
  id: number | null
  earner: string
  employer: string
  cadence: PayCadence
  paidOn: string
  gross: string
  retirement: string
  benefits: string
  fed: string
  state: string
  ytdGross: string
  ytdRetirement: string
  ytdBenefits: string
  ytdFed: string
  ytdState: string
  investAccountId: string
}
const emptyPay = (earner = ''): PayForm => ({
  id: null, earner, employer: '', cadence: 'biweekly', paidOn: '', gross: '', retirement: '', benefits: '', fed: '', state: '',
  ytdGross: '', ytdRetirement: '', ytdBenefits: '', ytdFed: '', ytdState: '', investAccountId: '',
})
const optMoney = (c: number | null) => (c ? money(c) : '')
const toPayForm = (p: PaySource): PayForm => ({
  id: p.id,
  earner: p.earner,
  employer: p.employer,
  cadence: p.cadence,
  paidOn: p.paidOn,
  gross: money(p.grossCents),
  retirement: optMoney(p.retirementCents),
  benefits: optMoney(p.benefitsCents),
  fed: optMoney(p.fedWithheldCents),
  state: optMoney(p.stateWithheldCents),
  ytdGross: optMoney(p.ytdGrossCents),
  ytdRetirement: optMoney(p.ytdRetirementCents),
  ytdBenefits: optMoney(p.ytdBenefitsCents),
  ytdFed: optMoney(p.ytdFedWithheldCents),
  ytdState: optMoney(p.ytdStateWithheldCents),
  investAccountId: p.investAccountId === null ? '' : String(p.investAccountId),
})

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
  rsuFed: (s.rsuWithholdFederalMicro / 10_000).toString(),
  rsuState: s.rsuWithholdStateMicro === null ? '' : (s.rsuWithholdStateMicro / 10_000).toString(),
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
  const [accounts, setAccounts] = useState<InvestAccount[]>([])
  const [pay, setPay] = useState<PayForm | null>(null)
  const [payMsg, setPayMsg] = useState<string | null>(null)
  const [paySaving, setPaySaving] = useState(false)

  const load = useCallback(async () => {
    const [t, a] = await Promise.all([get<Tax>('/api/tax'), get<InvestAccount[]>('/api/invest/accounts')])
    setTax(t)
    setAccounts(a)
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
        rsuWithholdFederalMicro: form.rsuFed.trim() ? Math.round(Number(form.rsuFed) * 10_000) : 0,
        rsuWithholdStateMicro: form.rsuState.trim() ? Math.round(Number(form.rsuState) * 10_000) : null,
      })
      await load()
      setMsg('Saved — every number on this screen just recomputed.')
    } catch (e) {
      setMsg(`Could not save — ${e instanceof Error ? e.message : e}`)
    } finally {
      setSaving(false)
    }
  }

  async function savePay() {
    if (!pay) return
    setPaySaving(true)
    setPayMsg(null)
    try {
      const dollars = (v: string) => (v.trim() ? parseMoney(v) : 0)
      const opt = (v: string) => (v.trim() ? parseMoney(v) : null)
      const body = {
        earner: pay.earner,
        employer: pay.employer,
        cadence: pay.cadence,
        paidOn: pay.paidOn,
        grossCents: dollars(pay.gross),
        retirementCents: dollars(pay.retirement),
        benefitsCents: dollars(pay.benefits),
        fedWithheldCents: dollars(pay.fed),
        stateWithheldCents: dollars(pay.state),
        ytdGrossCents: opt(pay.ytdGross),
        ytdRetirementCents: opt(pay.ytdRetirement),
        ytdBenefitsCents: opt(pay.ytdBenefits),
        ytdFedWithheldCents: opt(pay.ytdFed),
        ytdStateWithheldCents: opt(pay.ytdState),
        investAccountId: pay.investAccountId ? Number(pay.investAccountId) : null,
      }
      if (pay.id === null) await post('/api/paychecks', body)
      else await put(`/api/paychecks/${pay.id}`, body)
      setPay(null)
      await load()
      setPayMsg(`Saved ${pay.earner.trim()}'s paycheck — wages and withholding recomputed.`)
    } catch (e) {
      setPayMsg(`Could not save — ${e instanceof Error ? e.message : e}`)
    } finally {
      setPaySaving(false)
    }
  }

  async function removePay(p: PayProjection) {
    if (!window.confirm(`Remove ${p.earner}'s ${p.employer || 'paycheck'}? The tax picture will recompute without it.`)) return
    try {
      await del(`/api/paychecks/${p.id}`)
      if (pay?.id === p.id) setPay(null)
      await load()
      setPayMsg(null)
    } catch (e) {
      setPayMsg(`Could not remove — ${e instanceof Error ? e.message : e}`)
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
  const setP = (patch: Partial<PayForm>) => pay && setPay({ ...pay, ...patch })
  const { payroll, rsuWithholding: rsuW } = tax
  const hasPaychecks = payroll.sources.length > 0
  const earners = [...new Set(payroll.sources.map((p) => p.earner))]
  const amtGap = tax.tax.addlMedicareCents - payroll.addlMedicareWithheldCents

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
            {t.addlMedicareCents > 0 && <tr><td className="muted">Additional Medicare Tax (0.9%)</td><td className="r num">{formatCents(t.addlMedicareCents)}</td></tr>}
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
            <tr>
              <td className="muted" title={hasPaychecks ? payroll.earners.map((e) => `${e.earner}: ${formatCents(e.wagesCents)} taxable wages`).join('\n') : 'From the salary setting below — add paychecks to derive it'}>
                Salary ({hasPaychecks ? `from ${payroll.sources.length} paycheck${payroll.sources.length > 1 ? 's' : ''}` : 'projected'})
                {payroll.stale > 0 && <span title="A paystub is from last year — every pay date this year is projected from it"> ⚠</span>}
              </td>
              <td className="r num">{formatCents(incomes.wagesCents)}</td>
            </tr>
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
            <tr>
              <td className="muted" title={hasPaychecks ? `${formatCents(payroll.fedWithheldCents)} on paychecks · ${formatCents(rsuW.federalCents)} on ${formatCents(rsuW.baseCents)} of vests at ${pct(rsuW.federalMicro)}` : 'From the withholding setting below'}>
                Federal withholding{hasPaychecks ? ' (paychecks + vests)' : ''}
              </td>
              <td className="r num">{formatCents(tax.withheldFederalCents)}</td>
            </tr>
            {tax.fedCreditsCents > 0 && (
              <tr>
                <td className="muted" title={`${formatCents(payroll.addlMedicareWithheldCents)} Medicare surtax withheld · ${formatCents(payroll.excessSocialSecurityCents)} Social Security withheld past the wage base`}>Payroll-tax credits</td>
                <td className="r num">{formatCents(tax.fedCreditsCents)}</td>
              </tr>
            )}
            {tax.estPaidFederalCents > 0 && <tr><td className="muted">Federal est. payments made</td><td className="r num">{formatCents(tax.estPaidFederalCents)}</td></tr>}
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

      {/* ---------- paychecks ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Paychecks</h2>
          <div className="right">
            {!pay && <button className="chipbtn" onClick={() => { setPay(emptyPay()); setPayMsg(null) }}>+ paycheck</button>}
          </div>
        </div>
        {hasPaychecks ? (
          <table>
            <thead>
              <tr>
                <th>Earner</th><th>Cadence</th><th>Last stub</th>
                <th className="r">Per check</th><th className="r">Withheld</th>
                <th className="r">Wages {tax.year}</th><th className="r">Fed withheld</th><th className="r">{stateName}</th>
                <th className="r">Soc. Sec.</th><th className="r">Medicare</th><th></th>
              </tr>
            </thead>
            <tbody>
              {payroll.sources.map((p) => {
                const e = payroll.earners.find((x) => x.earner === p.earner)
                const oneEmployer = payroll.sources.filter((x) => x.earner === p.earner).length === 1
                return (
                  <tr key={p.id} className={pay?.id === p.id ? 'selrow' : ''}>
                    <td>
                      <b className="inkstrong">{p.earner}</b>{p.employer && <span className="muted"> · {p.employer}</span>}
                      {p.investAccountId !== null && <span className="muted" title={`Stock comp vesting into ${accounts.find((a) => a.id === p.investAccountId)?.name ?? 'this account'} counts as this employer's wages`}> · RSUs</span>}
                    </td>
                    <td className="muted">{CADENCE_LABEL[p.cadence]}</td>
                    <td className="muted" title={p.stale ? 'From last year — every pay date this year is projected from it' : p.ytdEstimated ? `No YTD column entered — the ${p.periodsElapsed} pay dates so far are assumed to match` : `YTD column as printed · ${p.periodsRemaining} pay dates left`}>
                      {p.paidOn}{p.stale ? ' ⚠' : p.ytdEstimated ? ' · YTD est.' : ''}
                    </td>
                    <td className="r num" title={`gross ${formatCents(p.grossCents)}${p.retirementCents ? ` · 401k ${formatCents(p.retirementCents)}` : ''}${p.benefitsCents ? ` · pre-tax benefits ${formatCents(p.benefitsCents)}` : ''}`}>{formatCents(p.grossCents)}</td>
                    <td className="r num">{formatCents(p.fedWithheldCents)}{p.stateWithheldCents > 0 && <span className="muted"> + {formatCents(p.stateWithheldCents)}</span>}</td>
                    <td className="r num" title={`gross ${formatCents(p.projected.grossCents)} − pre-tax ${formatCents(p.projected.retirementCents + p.projected.benefitsCents)}`}>{formatCents(p.projected.taxableWagesCents)}</td>
                    <td className="r num">{formatCents(p.projected.fedWithheldCents)}</td>
                    <td className="r num">{formatCents(p.projected.stateWithheldCents)}</td>
                    <td className="r num muted" title={oneEmployer ? '6.2% up to the wage base' : `${p.earner}'s Social Security across employers`}>{e && oneEmployer ? formatCents(e.socialSecurityCents) : e ? formatCents(e.socialSecurityCents) : '—'}</td>
                    <td className="r num muted" title={e && e.addlMedicareWithheldCents > 0 ? `incl. ${formatCents(e.addlMedicareWithheldCents)} surtax withheld above $200k` : '1.45%'}>{e ? formatCents(e.medicareCents + e.addlMedicareWithheldCents) : '—'}</td>
                    <td className="r nowrap">
                      <button className="btn mini ghosty" onClick={() => { setPay(toPayForm(p)); setPayMsg(null) }}>edit</button>{' '}
                      <button className="btn mini ghosty" onClick={() => removePay(p)}>×</button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <p className="sub2">
            No paychecks yet. Add the latest paystub for each earner — a regular check's gross and withholding,
            and the year-to-date column if it's handy — and salary, withholding and payroll taxes derive from it
            instead of the full-year guesses below.
          </p>
        )}
        {hasPaychecks && (
          <div className="sub2 topline">
            Payroll taxes {tax.year}: Social Security <b className="inkstrong">{formatCents(payroll.socialSecurityCents)}</b> · Medicare{' '}
            <b className="inkstrong">{formatCents(payroll.medicareCents)}</b>
            {t.addlMedicareCents > 0 && (
              <>
                {' '}· Additional Medicare Tax <b className="inkstrong">{formatCents(t.addlMedicareCents)}</b> on{' '}
                {formatCents(payroll.ficaWagesCents)} of household wages, of which employers withhold{' '}
                <b className="inkstrong">{formatCents(payroll.addlMedicareWithheldCents)}</b>
                {amtGap > 0 && <span className="neg"> — {formatCents(amtGap)} lands on the return</span>}
              </>
            )}
            {payroll.excessSocialSecurityCents > 0 && <> · {formatCents(payroll.excessSocialSecurityCents)} of Social Security over-withheld across employers comes back as a credit</>}
            {rsuW.baseCents > 0 && (
              <> · vests not yet on a stub ({formatCents(rsuW.baseCents)}) withheld at {pct(rsuW.federalMicro)} federal{rsuW.stateMicro > 0 ? ` / ${pct2(rsuW.stateMicro)} ${stateName}` : ''}</>
            )}
          </div>
        )}
        {pay && (
          <div style={{ marginTop: 12 }}>
            <div className="formrow">
              <input list="earners" className="sym" style={{ textTransform: 'none', width: 110 }} placeholder="earner" value={pay.earner} onChange={(e) => setP({ earner: e.target.value })} />
              <datalist id="earners">{earners.map((n) => <option key={n} value={n} />)}</datalist>
              <input style={{ width: 140 }} placeholder="employer" value={pay.employer} onChange={(e) => setP({ employer: e.target.value })} />
              <select value={pay.cadence} onChange={(e) => setP({ cadence: e.target.value as PayCadence })}>
                <option value="weekly">paid weekly</option>
                <option value="biweekly">paid every 2 weeks</option>
                <option value="semimonthly">paid twice a month</option>
                <option value="monthly">paid monthly</option>
              </select>
              <input className="date" type="date" title="Pay date printed on the stub these numbers come from" value={pay.paidOn} onChange={(e) => setP({ paidOn: e.target.value })} />
              <select value={pay.investAccountId} title="Where this employer's RSUs vest — their income counts as this earner's wages for Medicare and their withholding is already on this stub's YTD" onChange={(e) => setP({ investAccountId: e.target.value })}>
                <option value="">no stock comp</option>
                {accounts.filter((a) => a.tracking === 'lots').map((a) => <option key={a.id} value={a.id}>RSUs vest into {a.name}</option>)}
              </select>
            </div>
            <div className="formrow" style={{ marginTop: 8 }}>
              <span className="sub2" style={{ width: 96 }}>This paycheck</span>
              <input className="money" placeholder="gross $" title="Regular gross for one pay period, excluding stock comp (that comes from the ledger)" value={pay.gross} onChange={(e) => setP({ gross: e.target.value })} />
              <input className="money" placeholder="401k $" title="Pre-tax retirement (401k/403b) — reduces taxable wages, not payroll-tax wages" value={pay.retirement} onChange={(e) => setP({ retirement: e.target.value })} />
              <input className="money" placeholder="pre-tax benefits $" title="§125 premiums, HSA, FSA — reduce both taxable and payroll-tax wages" value={pay.benefits} onChange={(e) => setP({ benefits: e.target.value })} />
              <input className="money" placeholder="federal tax $" title="Federal income tax withheld on this check" value={pay.fed} onChange={(e) => setP({ fed: e.target.value })} />
              <input className="money" placeholder="state tax $" value={pay.state} onChange={(e) => setP({ state: e.target.value })} />
            </div>
            <div className="formrow" style={{ marginTop: 8 }}>
              <span className="sub2" style={{ width: 96 }} title="Optional. Leave blank to assume every pay date this year matched this check. Enter the YTD gross as printed to anchor on it.">Year to date</span>
              <input className="money" placeholder="YTD gross $" value={pay.ytdGross} onChange={(e) => setP({ ytdGross: e.target.value })} />
              <input className="money" placeholder="YTD 401k $" disabled={!pay.ytdGross.trim()} value={pay.ytdRetirement} onChange={(e) => setP({ ytdRetirement: e.target.value })} />
              <input className="money" placeholder="YTD benefits $" disabled={!pay.ytdGross.trim()} value={pay.ytdBenefits} onChange={(e) => setP({ ytdBenefits: e.target.value })} />
              <input className="money" placeholder="YTD federal $" title="As printed — this includes any withholding on vests so far" disabled={!pay.ytdGross.trim()} value={pay.ytdFed} onChange={(e) => setP({ ytdFed: e.target.value })} />
              <input className="money" placeholder="YTD state $" disabled={!pay.ytdGross.trim()} value={pay.ytdState} onChange={(e) => setP({ ytdState: e.target.value })} />
              <button className="btn gold" disabled={paySaving || !pay.earner.trim() || !pay.paidOn || !pay.gross.trim()} onClick={savePay}>{paySaving ? 'Saving…' : pay.id === null ? 'Add paycheck' : 'Save paycheck'}</button>
              <button className="btn ghosty" onClick={() => setPay(null)}>Cancel</button>
            </div>
          </div>
        )}
        {payMsg && <div className="sub2 importmsg">{payMsg}</div>}
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
          {!hasPaychecks && (
            <>
              <input className="money" placeholder="salary, full year $" title="Projected W-2 gross for the year, excluding RSU vests (those come from the ledger). Superseded once a paycheck is added above." value={form.wages} onChange={(e) => setF({ wages: e.target.value })} />
              <input className="money" placeholder="federal withholding $" title="Projected full-year federal withholding — paystub year-to-date extrapolated, plus RSU supplemental withholding. Superseded once a paycheck is added above." value={form.withheldFederal} onChange={(e) => setF({ withheldFederal: e.target.value })} />
              <input className="money" placeholder="state withholding $" value={form.withheldState} onChange={(e) => setF({ withheldState: e.target.value })} />
            </>
          )}
          <input className="money" placeholder="other income $" title="Interest and other ordinary income that isn't in the ledger" value={form.other} onChange={(e) => setF({ other: e.target.value })} />
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
          {hasPaychecks && (
            <>
              <span className="sub2" style={{ marginLeft: 12 }}>vests withheld at</span>
              <input className="qty" placeholder="22" title="Federal supplemental-wage rate the employer withholds on vests (22% by statute; 37% once supplemental wages pass $1M)" value={form.rsuFed} onChange={(e) => setF({ rsuFed: e.target.value })} />
              <span className="sub2">% federal</span>
              {stateInfo && stateInfo.kind !== 'none' && (
                <>
                  <input className="qty" placeholder={pct2(rsuW.stateMicro).replace('%', '')} title={`State supplemental rate on stock comp. Blank = ${stateName}'s published rate (${pct2(rsuW.stateMicro)})`} value={form.rsuState} onChange={(e) => setF({ rsuState: e.target.value })} />
                  <span className="sub2">% {stateName}</span>
                </>
              )}
            </>
          )}
        </div>
        {msg && <div className="sub2 importmsg">{msg}</div>}
        <p className="sub2" style={{ marginTop: 10 }}>
          Estimation for planning, not tax advice or preparation. Brackets: {tax.vintage}.
          {stateInfo?.note ? ` ${stateInfo.note}` : ''} RSU vest income and
          realized gains are derived from the ledger; scheduled vests are valued at today's price (set the
          cadence in Invest → Unvested RSUs); dividends from categorized transactions.
          {hasPaychecks
            ? ' Salary, withholding and payroll taxes (Social Security, Medicare, the 0.9% surtax) are projected from each paystub by walking its pay cadence to Dec 31; enter a paystub without stock comp in its gross, since vests come from the ledger.'
            : ' Payroll taxes (Social Security, Medicare) are modeled once paychecks are added.'}{' '}
          Washington's capital-gains excise and Massachusetts's millionaire surtax are not modeled. Verify with a professional before acting.
        </p>
      </div>
    </div>
  )
}
