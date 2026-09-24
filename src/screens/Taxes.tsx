import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { formatCents, formatDollars, formatQtyMicro } from '../../shared/money'
import { del, get, post, put } from '../api'
import { Link } from '../router'
import HarvestCard from '../tax/HarvestCard'
import { gapLine, scheduleNote } from '../tax/copy'
import RealizedCard from '../tax/RealizedCard'
import type { TaxResponse } from '../tax/types'
import { Button } from '../ui/Button'
import { useDeepAction } from '../ui/CommandPalette'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, MoneyInput, PercentInput, Select, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { Menu } from '../ui/Menu'
import { prefersReducedMotion } from '../ui/motion'
import { useAnchor } from '../ui/screen'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import './screens.css'

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
type InvestAccount = { id: number; name: string; tracking: string; stock_plan: number }
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
  harvest: TaxResponse['harvest']
}

const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
const pct2 = (micro: number) => `${(micro / 10_000).toFixed(2).replace(/\.?0+$/, '')}%`
const CADENCE_LABEL: Record<PayCadence, string> = { weekly: 'weekly', biweekly: 'every 2 weeks', semimonthly: 'twice a month', monthly: 'monthly' }
const FILING_LABEL: Record<FilingStatus, string> = { mfj: 'married filing jointly', single: 'single', mfs: 'married filing separately', hoh: 'head of household' }

/** A row note behind a dotted underline: hover or focus shows it (Tooltip), one line per entry. */
function Note(p: { tip: string | string[]; children: ReactNode }) {
  const lines = Array.isArray(p.tip) ? p.tip : [p.tip]
  return (
    <Tooltip content={lines.length > 1 ? lines.map((l, i) => <span key={i} className="scr-tipline">{l}</span>) : lines[0]}>
      <span className="scr-tipped">{p.children}</span>
    </Tooltip>
  )
}
/** A ⚠ that explains itself on hover or focus. */
function Warn(p: { tip: string }) {
  return (
    <Tooltip content={p.tip}>
      <span className="scr-warn" role="img" aria-label="Warning">⚠</span>
    </Tooltip>
  )
}

/**
 * The settings form holds the typed values the inputs emit — integer cents
 * and micro — never strings to re-parse on save. A zero shows as an empty
 * field (null) so the placeholder reads through; blank saves as 0, except the
 * state vest rate, where blank means "the state's published rate" (null).
 */
type Form = Omit<TaxSettings, 'customStateRateMicro' | 'wagesAnnualCents' | 'otherIncomeCents' | 'itemizedCents'
  | 'withheldFederalCents' | 'withheldStateCents' | 'estPaidFederalCents' | 'estPaidStateCents' | 'priorYearTaxFederalCents'
  | 'priorYearTaxStateCents' | 'qualifiedDividendShareMicro' | 'rsuWithholdFederalMicro'> & {
  customStateRateMicro: number | null
  wagesAnnualCents: number | null
  otherIncomeCents: number | null
  itemizedCents: number | null
  withheldFederalCents: number | null
  withheldStateCents: number | null
  estPaidFederalCents: number | null
  estPaidStateCents: number | null
  priorYearTaxFederalCents: number | null
  priorYearTaxStateCents: number | null
  qualifiedDividendShareMicro: number | null
  rsuWithholdFederalMicro: number | null
}
const orNull = (n: number) => (n === 0 ? null : n)
const toForm = (s: TaxSettings): Form => ({
  filingStatus: s.filingStatus,
  state: s.state,
  customStateRateMicro: orNull(s.customStateRateMicro),
  wagesAnnualCents: orNull(s.wagesAnnualCents),
  otherIncomeCents: orNull(s.otherIncomeCents),
  deductionMode: s.deductionMode,
  itemizedCents: orNull(s.itemizedCents),
  withheldFederalCents: orNull(s.withheldFederalCents),
  withheldStateCents: orNull(s.withheldStateCents),
  estPaidFederalCents: orNull(s.estPaidFederalCents),
  estPaidStateCents: orNull(s.estPaidStateCents),
  priorYearTaxFederalCents: orNull(s.priorYearTaxFederalCents),
  priorYearTaxStateCents: orNull(s.priorYearTaxStateCents),
  priorYearAgiOver150k: s.priorYearAgiOver150k,
  qualifiedDividendShareMicro: orNull(s.qualifiedDividendShareMicro),
  rsuWithholdFederalMicro: s.rsuWithholdFederalMicro,
  rsuWithholdStateMicro: s.rsuWithholdStateMicro,
})
/** What PUT /api/tax/settings receives — also the form's identity for the "unsaved changes" check. */
const toSettings = (f: Form): TaxSettings => ({
  filingStatus: f.filingStatus,
  state: f.state,
  customStateRateMicro: f.customStateRateMicro ?? 0,
  wagesAnnualCents: f.wagesAnnualCents ?? 0,
  otherIncomeCents: f.otherIncomeCents ?? 0,
  deductionMode: f.deductionMode,
  itemizedCents: f.itemizedCents ?? 0,
  withheldFederalCents: f.withheldFederalCents ?? 0,
  withheldStateCents: f.withheldStateCents ?? 0,
  estPaidFederalCents: f.estPaidFederalCents ?? 0,
  estPaidStateCents: f.estPaidStateCents ?? 0,
  priorYearTaxFederalCents: f.priorYearTaxFederalCents ?? 0,
  priorYearTaxStateCents: f.priorYearTaxStateCents ?? 0,
  priorYearAgiOver150k: f.priorYearAgiOver150k,
  qualifiedDividendShareMicro: f.qualifiedDividendShareMicro ?? 0,
  rsuWithholdFederalMicro: f.rsuWithholdFederalMicro ?? 0,
  rsuWithholdStateMicro: f.rsuWithholdStateMicro,
})
const sameSettings = (a: TaxSettings, b: TaxSettings) => JSON.stringify(a) === JSON.stringify(b)

/** The paycheck editor, typed the same way: cents in, cents out. Optional amounts are null when empty. */
type PayForm = {
  id: number | null
  earner: string
  employer: string
  cadence: PayCadence
  paidOn: string
  grossCents: number | null
  retirementCents: number | null
  benefitsCents: number | null
  fedWithheldCents: number | null
  stateWithheldCents: number | null
  ytdGrossCents: number | null
  ytdRetirementCents: number | null
  ytdBenefitsCents: number | null
  ytdFedWithheldCents: number | null
  ytdStateWithheldCents: number | null
  investAccountId: string
}
const emptyPay = (earner = ''): PayForm => ({
  id: null, earner, employer: '', cadence: 'biweekly', paidOn: '', grossCents: null, retirementCents: null,
  benefitsCents: null, fedWithheldCents: null, stateWithheldCents: null, ytdGrossCents: null, ytdRetirementCents: null,
  ytdBenefitsCents: null, ytdFedWithheldCents: null, ytdStateWithheldCents: null, investAccountId: '',
})
const toPayForm = (p: PaySource): PayForm => ({
  id: p.id,
  earner: p.earner,
  employer: p.employer,
  cadence: p.cadence,
  paidOn: p.paidOn,
  grossCents: p.grossCents,
  retirementCents: orNull(p.retirementCents),
  benefitsCents: orNull(p.benefitsCents),
  fedWithheldCents: orNull(p.fedWithheldCents),
  stateWithheldCents: orNull(p.stateWithheldCents),
  ytdGrossCents: p.ytdGrossCents,
  ytdRetirementCents: p.ytdRetirementCents,
  ytdBenefitsCents: p.ytdBenefitsCents,
  ytdFedWithheldCents: p.ytdFedWithheldCents,
  ytdStateWithheldCents: p.ytdStateWithheldCents,
  investAccountId: p.investAccountId === null ? '' : String(p.investAccountId),
})
const toPayBody = (f: PayForm) => ({
  earner: f.earner,
  employer: f.employer,
  cadence: f.cadence,
  paidOn: f.paidOn,
  grossCents: f.grossCents ?? 0,
  retirementCents: f.retirementCents ?? 0,
  benefitsCents: f.benefitsCents ?? 0,
  fedWithheldCents: f.fedWithheldCents ?? 0,
  stateWithheldCents: f.stateWithheldCents ?? 0,
  // The YTD column is all-or-nothing: without a YTD gross the rest are dropped (the engine does the same).
  ytdGrossCents: f.ytdGrossCents,
  ytdRetirementCents: f.ytdGrossCents === null ? null : f.ytdRetirementCents,
  ytdBenefitsCents: f.ytdGrossCents === null ? null : f.ytdBenefitsCents,
  ytdFedWithheldCents: f.ytdGrossCents === null ? null : f.ytdFedWithheldCents,
  ytdStateWithheldCents: f.ytdGrossCents === null ? null : f.ytdStateWithheldCents,
  investAccountId: f.investAccountId ? Number(f.investAccountId) : null,
})

/**
 * A number field whose text doesn't parse shows its own inline error but
 * never emits, so the form still holds the last good value. Before a save,
 * refuse while any field in the form is flagged — saving the stale value
 * would quietly discard what the person can see they typed.
 */
function firstInvalid(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? null
}
function refuseIfInvalid(root: HTMLElement | null): boolean {
  const bad = firstInvalid(root)
  if (!bad) return false
  bad.focus()
  toast.error('Fix the highlighted field first', { detail: 'An amount or rate there isn’t a number Scarab can read.' })
  return true
}

/** A titled group of fields inside a card. */
function Group(p: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="scr-group">
      <div className="scr-group-head">
        {p.title}
        {p.note && <span className="muted">{p.note}</span>}
      </div>
      {p.children}
    </div>
  )
}

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
        {scheduleNote(sh.rule, sh.weights)}
        {sh.assumed && ' This state\'s actual schedule and thresholds are not bundled; the federal shape is assumed.'}
      </p>
    </>
  )
}

export default function Taxes() {
  const [tax, setTax] = useState<Tax | null>(null)
  const [form, setForm] = useState<Form | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<InvestAccount[]>([])
  const [pay, setPay] = useState<PayForm | null>(null)
  const settingsRef = useRef<HTMLDivElement>(null)
  const payRef = useRef<HTMLDivElement>(null)
  const earnersListId = useId()
  // '#/tax/paychecks' and '#/tax/settings' scroll to these cards (the Dashboard and other screens link here).
  const paychecksAnchor = useAnchor('paychecks')
  const settingsAnchor = useAnchor('settings')
  const [opened, setOpened] = useState(0) // bumps on every "+ Paycheck", so a second click scrolls back to the editor

  /** The stored settings the form was last filled from: an unedited form follows the store, an edited one is kept. */
  const formFrom = useRef<TaxSettings | null>(null)
  const load = useCallback(async () => {
    const [t, a] = await Promise.all([get<Tax>('/api/tax'), get<InvestAccount[]>('/api/invest/accounts')])
    setTax(t)
    setAccounts(a)
    // A half-edited settings form survives the refetch (and a trip to another screen). An unedited one takes the
    // stored settings, so a change saved elsewhere (the other member) shows instead of reading as "unsaved changes"
    // that Save would write back over it.
    const from = formFrom.current
    formFrom.current = t.settings
    setForm((f) => (f === null || from === null || sameSettings(toSettings(f), toSettings(toForm(from))) ? toForm(t.settings) : f))
    setLoadError(null)
  }, [])

  const firstLoad = useCallback(() => {
    load().catch((e) => setLoadError(`${e instanceof Error ? e.message : e}`))
  }, [load])
  useEffect(() => {
    firstLoad() // on mount and on every reveal: a quiet refetch behind what's showing
  }, [firstLoad])

  // Opening the editor (new, or another row) brings it into view with the cursor in its first field — once per
  // opening. Keep-alive re-runs effects when the screen is revealed; an editor left open must not take the scroll
  // position and focus back from the shell then (it restores the one the screen was left at, and focuses the h1).
  const payKey = pay ? String(pay.id) : null
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    const opening = payKey === null ? null : `${payKey}#${opened}`
    if (opening === null) {
      shownFor.current = null // closed: the next opening, even of the same row, is new
      return
    }
    if (opening === shownFor.current || !payRef.current) return
    shownFor.current = opening
    payRef.current.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    payRef.current.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }, [payKey, opened])
  /** "+ Paycheck": a blank editor in view with the cursor in it. An edit already open stays — it's brought back into view, never discarded. */
  const newPaycheck = () => {
    if (pay && pay.id !== null) toast.info(`Save or cancel the edit to ${pay.earner || 'this paycheck'} first`)
    else if (!pay) setPay(emptyPay())
    setOpened((n) => n + 1)
  }

  // '#/tax?d=add-paycheck' (the ⌘K palette): "+ Paycheck" on arrival, once the editor has its data.
  useDeepAction('tax', { 'add-paycheck': newPaycheck }, !!tax && !!form)

  /** After a save: recompute the picture. A failed refetch isn't a failed save, so it says so separately. */
  const reload = useCallback(() => {
    load().catch((e) => toast.error("Couldn't refresh the tax picture", { detail: e instanceof Error ? e.message : String(e) }))
  }, [load])

  const saveSettings = useAction(
    (s: TaxSettings) => put<{ ok: true; settings: TaxSettings }>('/api/tax/settings', s),
    {
      success: 'Tax settings saved — every number on this screen recomputed',
      errorPrefix: "Couldn't save the tax settings",
      onDone: (r) => {
        // Adopt what was stored on both sides of the "unsaved changes" check at once, so it clears without a flicker.
        setTax((cur) => (cur ? { ...cur, settings: r.settings } : cur))
        setForm(toForm(r.settings))
        formFrom.current = r.settings
        reload()
      },
    },
  )

  const savePay = useAction(
    async (f: PayForm) => {
      const body = toPayBody(f)
      if (f.id === null) await post('/api/paychecks', body)
      else await put(`/api/paychecks/${f.id}`, body)
      return f.earner.trim()
    },
    {
      success: (earner) => `Saved ${earner}'s paycheck — wages and withholding recomputed`,
      errorPrefix: "Couldn't save the paycheck",
      onDone: () => {
        setPay(null)
        reload()
      },
    },
  )

  const removePay = useAction(
    async (p: PayProjection) => {
      await del(`/api/paychecks/${p.id}`)
      return p
    },
    {
      success: (p) => `Removed ${p.earner}'s ${p.employer || 'paycheck'} — the tax picture recomputed without it`,
      errorPrefix: "Couldn't remove the paycheck",
      onDone: (p) => {
        setPay((cur) => (cur?.id === p.id ? null : cur))
        reload()
      },
    },
  )

  async function askRemovePay(p: PayProjection) {
    const ok = await confirm({
      title: `Remove ${p.earner}'s ${p.employer || 'paycheck'}?`,
      body: 'The tax picture will recompute without it.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) void removePay.run(p)
  }

  // A failed first load says so, with a retry; a failed refresh keeps what's on screen.
  if (!tax || !form)
    return (
      <>
        <HeaderSlot sub="Projected federal and state tax for this year" />
        {loadError ? (
          <div className="card wide" role="alert">
            <h2>Couldn't load the tax picture</h2>
            <p className="sub2">{loadError}</p>
            <Button onClick={firstLoad}>Retry</Button>
          </div>
        ) : (
          <div className="grid12" aria-busy="true" aria-label="Loading Taxes">
            <div className="card c8"><Skeleton h={18} w={180} /><Skeleton h={44} w="45%" style={{ marginTop: 12 }} /><Skeleton h={120} style={{ marginTop: 14 }} /></div>
            <div className="card c4"><Skeleton h={18} w={140} /><Skeleton h={200} style={{ marginTop: 12 }} /></div>
            <div className="card c12"><Skeleton h={18} w={120} /><Skeleton h={140} style={{ marginTop: 12 }} /></div>
          </div>
        )}
      </>
    )

  const { incomes, tax: t, safeHarbor: sh, stateSafeHarbor: ssh, harvest } = tax
  const stateInfo = tax.states.find((s) => s.code === form.state)
  const stateName = stateInfo?.name ?? 'State'
  const stateTaxed = !!stateInfo && stateInfo.kind !== 'none'
  const hasQualified = incomes.dividendsQualifiedCents > 0
  const gap = tax.fedGapCents + tax.stateGapCents
  const setF = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f))
  const setP = (patch: Partial<PayForm>) => setPay((p) => (p ? { ...p, ...patch } : p))
  const { payroll, rsuWithholding: rsuW } = tax
  const hasPaychecks = payroll.sources.length > 0
  // Where grants (and their vest cadence) are edited: a stock-plan account's drawer on Investments.
  const stockPlan = accounts.find((a) => a.tracking === 'lots' && a.stock_plan === 1) ?? null
  const earners = [...new Set(payroll.sources.map((p) => p.earner))]
  const amtGap = tax.tax.addlMedicareCents - payroll.addlMedicareWithheldCents
  const settingsDirty = !sameSettings(toSettings(form), toSettings(toForm(tax.settings)))
  const payReady = !!pay && !!pay.earner.trim() && !!pay.paidOn && (pay.grossCents ?? 0) > 0

  const onSaveSettings = () => {
    if (!refuseIfInvalid(settingsRef.current)) void saveSettings.run(toSettings(form))
  }
  const onSavePay = () => {
    if (pay && !refuseIfInvalid(payRef.current)) void savePay.run(pay)
  }

  return (
    <div className="grid12">
      <HeaderSlot
        sub={`${tax.year} projection · ${FILING_LABEL[tax.settings.filingStatus]} · ${tax.states.find((s) => s.code === tax.settings.state)?.name ?? tax.settings.state}`}
        actions={<Button variant="gold" onClick={newPaycheck}>+ Paycheck</Button>}
      />
      {/* ---------- headline ---------- */}
      <div className="card c8">
        <h2>Projected {tax.year} tax</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap' }}>
          <div className="heronum" style={{ fontSize: 44 }}>{formatCents(t.totalCents)}</div>
          <span className={`delta ${gapLine(gap).tone}`} style={{ fontWeight: 600, fontSize: 13 }}>
            {gapLine(gap).text}
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
              <td className="muted">
                <Note tip={hasPaychecks ? payroll.earners.map((e) => `${e.earner}: ${formatCents(e.wagesCents)} taxable wages`) : 'From the salary setting below — add paychecks to derive it'}>
                  Salary ({hasPaychecks ? `from ${payroll.sources.length} paycheck${payroll.sources.length > 1 ? 's' : ''}` : 'projected'})
                </Note>
                {payroll.stale > 0 && <> <Warn tip="A paystub is from last year — every pay date this year is projected from it" /></>}
              </td>
              <td className="r num">{formatCents(incomes.wagesCents)}</td>
            </tr>
            <tr><td className="muted">RSU vests (from the ledger)</td><td className="r num">{formatCents(incomes.rsuYtdCents)}</td></tr>
            {(incomes.rsuProjected.length > 0 || incomes.rsuUnpriced > 0) && (
              <tr>
                <td className="muted">
                  <Note tip={incomes.rsuProjected.length ? incomes.rsuProjected.map((e) => `${e.vest_on} · ${formatQtyMicro(e.qty_micro)} ${e.symbol}${e.cents === null ? ' (no price yet)' : ` ≈ ${formatCents(e.cents)}`}`) : 'No priced vests scheduled'}>
                    RSU vests still to come ({incomes.rsuProjected.length}, at today's price)
                  </Note>
                  {incomes.rsuUnpriced > 0 && <> <Warn tip="Some scheduled vests have no price on file — add one in Investments" /></>}
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
              <td className="muted">
                <Note tip={hasPaychecks ? `${formatCents(payroll.fedWithheldCents)} on paychecks · ${formatCents(rsuW.federalCents)} on ${formatCents(rsuW.baseCents)} of vests at ${pct(rsuW.federalMicro)}` : 'From the withholding setting below'}>
                  Federal withholding{hasPaychecks ? ' (paychecks + vests)' : ''}
                </Note>
              </td>
              <td className="r num">{formatCents(tax.withheldFederalCents)}</td>
            </tr>
            {tax.fedCreditsCents > 0 && (
              <tr>
                <td className="muted">
                  <Note tip={`${formatCents(payroll.addlMedicareWithheldCents)} Medicare surtax withheld · ${formatCents(payroll.excessSocialSecurityCents)} Social Security withheld past the wage base`}>Payroll-tax credits</Note>
                </td>
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
      <HarvestCard harvest={harvest} marginal={tax.marginal} />
      <RealizedCard year={tax.year} />

      {/* ---------- paychecks ---------- */}
      <div className="card c12" ref={paychecksAnchor}>
        <div className="h4row">
          <h2>Paychecks</h2>
          <div className="right">
            {!pay && <button className="chipbtn" onClick={newPaycheck}>+ paycheck</button>}
          </div>
        </div>
        {hasPaychecks ? (
          <div className="scr-tablewrap">
            <table>
              <thead>
                <tr>
                  <th>Earner</th>
                  <th className="r">Per check</th><th className="r">Withheld</th>
                  <th className="r"><Note tip="Taxable wages projected to Dec 31, in whole dollars">Wages {tax.year}</Note></th><th className="r">Fed withheld</th><th className="r">{stateName}</th>
                  <th className="r">Soc. Sec.</th><th className="r">Medicare</th><th><span className="ui-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {payroll.sources.map((p) => {
                  const e = payroll.earners.find((x) => x.earner === p.earner)
                  const oneEmployer = payroll.sources.filter((x) => x.earner === p.earner).length === 1
                  return (
                    <tr key={p.id} className={pay?.id === p.id ? 'selrow' : ''}>
                      <td className="scr-who">
                        <b className="inkstrong">{p.earner}</b>{p.employer && <span className="muted"> · {p.employer}</span>}
                        {p.investAccountId !== null && (
                          <span className="muted">
                            {' · '}
                            <Note tip={`Stock comp vesting into ${accounts.find((a) => a.id === p.investAccountId)?.name ?? 'this account'} counts as this employer's wages`}>RSUs</Note>
                          </span>
                        )}
                        <span className="scr-cellsub">
                          <Note tip={p.stale ? 'From last year — every pay date this year is projected from it' : p.ytdEstimated ? `No YTD column entered — the ${p.periodsElapsed} pay dates so far are assumed to match` : `YTD column as printed · ${p.periodsRemaining} pay dates left`}>
                            {CADENCE_LABEL[p.cadence]} · stub {p.paidOn}{p.ytdEstimated && !p.stale ? ' · YTD est.' : ''}
                          </Note>
                          {p.stale && <> <Warn tip="This paystub is from last year — every pay date this year is projected from it. Add this year's latest stub." /></>}
                        </span>
                      </td>
                      <td className="r num">
                        <Note tip={`gross ${formatCents(p.grossCents)}${p.retirementCents ? ` · 401k ${formatCents(p.retirementCents)}` : ''}${p.benefitsCents ? ` · pre-tax benefits ${formatCents(p.benefitsCents)}` : ''}`}>{formatCents(p.grossCents)}</Note>
                      </td>
                      <td className="r num">{formatCents(p.fedWithheldCents)}{p.stateWithheldCents > 0 && <span className="scr-cellsub">+ {formatCents(p.stateWithheldCents)}</span>}</td>
                      <td className="r num">
                        <Note tip={`gross ${formatCents(p.projected.grossCents)} − pre-tax ${formatCents(p.projected.retirementCents + p.projected.benefitsCents)}`}>{formatDollars(p.projected.taxableWagesCents)}</Note>
                      </td>
                      <td className="r num">{formatDollars(p.projected.fedWithheldCents)}</td>
                      <td className="r num">{formatDollars(p.projected.stateWithheldCents)}</td>
                      <td className="r num muted">
                        {e ? <Note tip={oneEmployer ? '6.2% up to the wage base' : `${p.earner}'s Social Security across employers`}>{formatDollars(e.socialSecurityCents)}</Note> : '—'}
                      </td>
                      <td className="r num muted">
                        {e ? <Note tip={e.addlMedicareWithheldCents > 0 ? `incl. ${formatCents(e.addlMedicareWithheldCents)} surtax withheld above $200k` : '1.45%'}>{formatDollars(e.medicareCents + e.addlMedicareWithheldCents)}</Note> : '—'}
                      </td>
                      <td className="scr-act">
                        <Menu
                          label={`${p.earner}'s ${p.employer || 'paycheck'}`}
                          align="end"
                          items={[
                            { label: 'Edit…', onSelect: () => setPay(toPayForm(p)) },
                            { label: 'Remove…', danger: true, onSelect: () => void askRemovePay(p) },
                          ]}
                        />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
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
          <div className="scr-editor" ref={payRef}>
            <Group title={pay.id === null ? 'New paycheck' : `Edit ${pay.earner || 'paycheck'}`}>
              <FieldGrid min={140}>
                <Field label="Earner">
                  <TextInput list={earnersListId} autoComplete="off" maxLength={40} placeholder="e.g. Max" value={pay.earner} onChange={(e) => setP({ earner: e.target.value })} />
                </Field>
                <datalist id={earnersListId}>{earners.map((n) => <option key={n} value={n} />)}</datalist>
                <Field label="Employer">
                  <TextInput autoComplete="off" maxLength={60} placeholder="optional" value={pay.employer} onChange={(e) => setP({ employer: e.target.value })} />
                </Field>
                <Field label="Paid">
                  <Select value={pay.cadence} onChange={(e) => setP({ cadence: e.target.value as PayCadence })}>
                    <option value="weekly">weekly</option>
                    <option value="biweekly">every 2 weeks</option>
                    <option value="semimonthly">twice a month</option>
                    <option value="monthly">monthly</option>
                  </Select>
                </Field>
                <Field label="Pay date" hint="as printed on this stub">
                  <DateInput value={pay.paidOn} onChange={(v) => setP({ paidOn: v })} />
                </Field>
                <Field label="Stock comp" hint="RSU income counts as this employer's wages">
                  <Select value={pay.investAccountId} onChange={(e) => setP({ investAccountId: e.target.value })}>
                    <option value="">none</option>
                    {accounts.filter((a) => a.tracking === 'lots' && a.stock_plan === 1).map((a) => <option key={a.id} value={a.id}>vests into {a.name}</option>)}
                  </Select>
                </Field>
              </FieldGrid>
            </Group>
            <Group title="This paycheck" note="one regular pay period — leave stock comp out, it comes from the ledger">
              <FieldGrid min={140}>
                <Field label="Gross pay">
                  <MoneyInput value={pay.grossCents} onChange={(c) => setP({ grossCents: c })} />
                </Field>
                <Field label="401(k) / 403(b)" hint="lowers taxable wages">
                  <MoneyInput value={pay.retirementCents} placeholder="0.00" onChange={(c) => setP({ retirementCents: c })} />
                </Field>
                <Field label="Pre-tax benefits" hint="§125, HSA, FSA">
                  <MoneyInput value={pay.benefitsCents} placeholder="0.00" onChange={(c) => setP({ benefitsCents: c })} />
                </Field>
                <Field label="Federal tax withheld">
                  <MoneyInput value={pay.fedWithheldCents} placeholder="0.00" onChange={(c) => setP({ fedWithheldCents: c })} />
                </Field>
                <Field label={`${stateName} tax withheld`}>
                  <MoneyInput value={pay.stateWithheldCents} placeholder="0.00" onChange={(c) => setP({ stateWithheldCents: c })} />
                </Field>
              </FieldGrid>
            </Group>
            <Group title="Year to date" note="optional — as printed; blank assumes every pay date this year matched this check">
              <FieldGrid min={140}>
                <Field label="YTD gross">
                  <MoneyInput value={pay.ytdGrossCents} onChange={(c) => setP({ ytdGrossCents: c })} />
                </Field>
                <Field label="YTD 401(k)">
                  <MoneyInput value={pay.ytdRetirementCents} disabled={pay.ytdGrossCents === null} onChange={(c) => setP({ ytdRetirementCents: c })} />
                </Field>
                <Field label="YTD benefits">
                  <MoneyInput value={pay.ytdBenefitsCents} disabled={pay.ytdGrossCents === null} onChange={(c) => setP({ ytdBenefitsCents: c })} />
                </Field>
                <Field label="YTD federal" hint="includes withholding on vests">
                  <MoneyInput value={pay.ytdFedWithheldCents} disabled={pay.ytdGrossCents === null} onChange={(c) => setP({ ytdFedWithheldCents: c })} />
                </Field>
                <Field label={`YTD ${stateName}`}>
                  <MoneyInput value={pay.ytdStateWithheldCents} disabled={pay.ytdGrossCents === null} onChange={(c) => setP({ ytdStateWithheldCents: c })} />
                </Field>
              </FieldGrid>
            </Group>
            <div className="scr-formfoot">
              {!payReady && <span className="sub2 scr-note">Earner, pay date and gross pay are needed.</span>}
              <Button variant="ghost" onClick={() => setPay(null)} disabled={savePay.busy}>Cancel</Button>
              <Button variant="gold" busy={savePay.busy} disabled={!payReady} onClick={onSavePay}>
                {pay.id === null ? 'Add paycheck' : 'Save paycheck'}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ---------- settings ---------- */}
      <div className="card c12" ref={settingsAnchor}>
        <div className="h4row">
          <h2>Tax settings</h2>
          <div className="right">
            {settingsDirty && <span className="scr-dirty" role="status">Unsaved changes</span>}
            <Button variant="gold" busy={saveSettings.busy} disabled={!settingsDirty} onClick={onSaveSettings}>
              Save &amp; recompute
            </Button>
          </div>
        </div>
        <div ref={settingsRef}>
          <Group title="Filing">
            <FieldGrid min={180}>
              <Field label="Filing status">
                <Select value={form.filingStatus} onChange={(e) => setF({ filingStatus: e.target.value as FilingStatus })}>
                  <option value="mfj">Married filing jointly</option>
                  <option value="single">Single</option>
                  <option value="mfs">Married filing separately</option>
                  <option value="hoh">Head of household</option>
                </Select>
              </Field>
              <Field label="State">
                <Select value={form.state} onChange={(e) => setF({ state: e.target.value })}>
                  {tax.states.map((s) => (
                    <option key={s.code} value={s.code}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              {stateInfo?.kind === 'custom' && (
                <Field label="State marginal rate" hint="this state's brackets aren't bundled yet">
                  <PercentInput valueMicro={form.customStateRateMicro} placeholder="0" onChange={(m) => setF({ customStateRateMicro: m })} />
                </Field>
              )}
              <Field label="Deduction">
                <Select value={form.deductionMode} onChange={(e) => setF({ deductionMode: e.target.value as 'standard' | 'itemized' })}>
                  <option value="standard">Standard deduction</option>
                  <option value="itemized">Itemized</option>
                </Select>
              </Field>
              {form.deductionMode === 'itemized' && (
                <Field label="Itemized total">
                  <MoneyInput value={form.itemizedCents} placeholder="0.00" onChange={(c) => setF({ itemizedCents: c })} />
                </Field>
              )}
            </FieldGrid>
          </Group>
          <Group
            title="Income & payments"
            note={hasPaychecks ? <>salary and withholding come from the <Link className="scr-link" to={{ screen: 'tax', rest: ['paychecks'] }}>paychecks</Link> above</> : undefined}
          >
            <FieldGrid min={180}>
              {!hasPaychecks && (
                <>
                  <Field label="Salary, full year" hint="W-2 gross without RSU vests">
                    <MoneyInput value={form.wagesAnnualCents} placeholder="0.00" onChange={(c) => setF({ wagesAnnualCents: c })} />
                  </Field>
                  <Field label="Federal withheld, full year" hint="stubs' YTD extrapolated + vests">
                    <MoneyInput value={form.withheldFederalCents} placeholder="0.00" onChange={(c) => setF({ withheldFederalCents: c })} />
                  </Field>
                  {stateTaxed && (
                    <Field label={`${stateName} withheld, full year`}>
                      <MoneyInput value={form.withheldStateCents} placeholder="0.00" onChange={(c) => setF({ withheldStateCents: c })} />
                    </Field>
                  )}
                </>
              )}
              <Field label="Other income" hint="interest and ordinary income not in the ledger">
                <MoneyInput value={form.otherIncomeCents} placeholder="0.00" onChange={(c) => setF({ otherIncomeCents: c })} />
              </Field>
              <Field label="Federal est. payments" hint="made so far this year">
                <MoneyInput value={form.estPaidFederalCents} placeholder="0.00" onChange={(c) => setF({ estPaidFederalCents: c })} />
              </Field>
              <Field label="Last year's federal tax" hint="total tax on last year's 1040 — the safe-harbor floor">
                <MoneyInput value={form.priorYearTaxFederalCents} placeholder="0.00" onChange={(c) => setF({ priorYearTaxFederalCents: c })} />
              </Field>
              {stateTaxed && (
                <>
                  <Field label={`${stateName} est. payments`} hint="made so far this year">
                    <MoneyInput value={form.estPaidStateCents} placeholder="0.00" onChange={(c) => setF({ estPaidStateCents: c })} />
                  </Field>
                  <Field label={`Last year's ${stateName} tax`} hint="sets the state safe-harbor floor">
                    <MoneyInput value={form.priorYearTaxStateCents} placeholder="0.00" onChange={(c) => setF({ priorYearTaxStateCents: c })} />
                  </Field>
                </>
              )}
              <label className="scr-check">
                <input type="checkbox" checked={form.priorYearAgiOver150k} onChange={(e) => setF({ priorYearAgiOver150k: e.target.checked })} />
                AGI over $150k last year (110% safe harbor)
              </label>
            </FieldGrid>
          </Group>
          <Group title="Dividends & vests">
            <FieldGrid min={180}>
              <Field label="Qualified dividends" hint="share of dividends & interest; broad ETFs run 90%+, interest 0%">
                <PercentInput valueMicro={form.qualifiedDividendShareMicro} placeholder="0" onChange={(m) => setF({ qualifiedDividendShareMicro: m })} />
              </Field>
              {hasPaychecks && (
                <>
                  <Field label="Vests withheld, federal" hint="22% by statute; 37% once supplemental wages pass $1M">
                    <PercentInput valueMicro={form.rsuWithholdFederalMicro} placeholder="22" onChange={(m) => setF({ rsuWithholdFederalMicro: m })} />
                  </Field>
                  {stateTaxed && (
                    <Field label={`Vests withheld, ${stateName}`} hint={`blank = the published rate (${pct2(rsuW.stateMicro)})`}>
                      <PercentInput valueMicro={form.rsuWithholdStateMicro} placeholder={pct2(rsuW.stateMicro).replace('%', '')} onChange={(m) => setF({ rsuWithholdStateMicro: m })} />
                    </Field>
                  )}
                </>
              )}
            </FieldGrid>
          </Group>
        </div>
        <p className="sub2" style={{ marginTop: 10 }}>
          Estimation for planning, not tax advice or preparation. Brackets: {tax.vintage}.
          {stateInfo?.note ? ` ${stateInfo.note}` : ''} RSU vest income and
          realized gains are derived from the ledger; scheduled vests are valued at today's price (grants and their vest
          cadence live on Investments, in{' '}
          {stockPlan ? (
            <Link className="scr-link" to={{ screen: 'invest', params: { d: 'account', acct: stockPlan.id, tab: 'grants' } }}>
              {stockPlan.name} → Grants
            </Link>
          ) : (
            <>
              a stock-plan account's Grants tab — <Link className="scr-link" to={{ screen: 'invest', params: { d: 'add-account' } }}>add one</Link>
            </>
          )}
          ); dividends from <Link className="scr-link" to={{ screen: 'cash' }}>categorized transactions</Link>.
          {hasPaychecks
            ? ' Salary, withholding and payroll taxes (Social Security, Medicare, the 0.9% surtax) are projected from each paystub by walking its pay cadence to Dec 31; enter a paystub without stock comp in its gross, since vests come from the ledger.'
            : ' Payroll taxes (Social Security, Medicare) are modeled once paychecks are added.'}{' '}
          Washington's capital-gains excise and Massachusetts's millionaire surtax are not modeled. Verify with a professional before acting.
        </p>
      </div>
    </div>
  )
}
