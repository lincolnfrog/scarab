import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { formatCents, formatDollars } from '../../shared/money'
import { del, get, patch, post, put } from '../api'
import { fmtMonth, fmtShort } from '../viz'
import GoalFundChart from '../cards/GoalFundChart'
import { CountUp } from '../chart/CountUpText'
import { grossSaleForNet } from '../../shared/series'
import type { GoalDerived } from '../../shared/types'
import { Button } from '../ui/Button'
import { confirm, prompt } from '../ui/dialogs'
import { Field, MoneyInput, PercentInput, Select, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { useAnchor } from '../ui/screen'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import './screens.css'

type Goal = {
  targetPriceCents: number
  downPctMicro: number
  closingCents: number
  fundAccountIds: number[]
  fundExtraCents: number
  monthlyPlanCents: number
  selectedLoanId: number | null
  taxPctMicro: number
  insMonthlyCents: number
  capGainsRateMicro: number
  lossCarryforwardCents: number
  saleBasisPctMicro: number
}
type Rental = {
  propertyId: number | null
  rentCents: number
  piCents: number
  taxCents: number
  insCents: number
  maintPctMicro: number
  vacancyPctMicro: number
}
type Loan = { id: number; name: string; rate_micro: number; term_months: number; points_micro: number; note: string | null }
type GoalData = {
  goal: Goal
  rental: Rental
  accounts: { id: number; name: string; balance_cents: number }[]
  fundTotal: number
  series: { month: string; cents: number }[]
  monthlySuggest: number
  loans: Loan[]
  properties: { id: number; name: string }[]
  /** Target, fund, gap, percent and ETA, computed by the engine (GET /api/goal). */
  derived: GoalDerived
}

/** Monthly principal & interest. A projection, so float math then round once. */
function pmt(loanCents: number, rateMicro: number, termMonths: number): number {
  const r = rateMicro / 1_000_000 / 12
  if (r === 0) return Math.round(loanCents / termMonths)
  return Math.round((loanCents * r) / (1 - Math.pow(1 + r, -termMonths)))
}

const pct = (micro: number, dp = 3) => `${(micro / 10_000).toFixed(dp)}%`
/** cents × rate (micro, 1e6 = 100%), rounded once — integer in, integer out. */
const ofMicro = (cents: number, micro: number) => Math.round((cents * micro) / 1_000_000)

/** The price rows of the payment matrix: −15% … +15% around the target, to the nearest $10K. */
const MATRIX_MICRO = [850_000, 925_000, 1_000_000, 1_075_000, 1_150_000]
const TEN_K = 1_000_000 // cents
/** Loan terms offered in the add-loan form, in years. */
const TERMS = [10, 15, 20, 25, 30, 40]

/**
 * One stored money setting as a labelled, controlled field. It shows what's
 * saved, resyncs when the saved value changes (a reload, the other member's
 * edit), and saves on blur/Enter only when the value changed. A failed save
 * puts the saved value back, so the field never shows a number that isn't
 * stored. Optional amounts show 0 as an empty field; blank saves as 0.
 */
function MoneySetting(p: {
  label: ReactNode
  hint?: ReactNode
  cents: number
  required?: boolean
  onSave: (cents: number) => Promise<unknown>
}) {
  const shown = (c: number) => (c === 0 && !p.required ? null : c)
  const [v, setV] = useState<number | null>(() => shown(p.cents))
  const [saved, setSaved] = useState(p.cents)
  const [err, setErr] = useState<string | null>(null)
  if (saved !== p.cents) {
    setSaved(p.cents)
    setV(shown(p.cents))
    setErr(null)
  }
  const commit = async (c: number | null) => {
    if (c === null && p.required) return setErr('Enter an amount')
    setErr(null)
    if ((c ?? 0) === p.cents) return
    if ((await p.onSave(c ?? 0)) === undefined) setV(shown(p.cents))
  }
  return (
    <Field label={p.label} hint={p.hint} error={err}>
      <MoneyInput value={v} placeholder="0.00" onChange={setV} onCommit={(c) => void commit(c)} />
    </Field>
  )
}

/** The same for a stored rate, with its allowed range (micro; 1e6 = 100%). */
function PercentSetting(p: {
  label: ReactNode
  hint?: ReactNode
  micro: number
  min?: number
  minExclusive?: boolean
  max: number
  onSave: (micro: number) => Promise<unknown>
}) {
  const [v, setV] = useState<number | null>(p.micro)
  const [saved, setSaved] = useState(p.micro)
  const [err, setErr] = useState<string | null>(null)
  if (saved !== p.micro) {
    setSaved(p.micro)
    setV(p.micro)
    setErr(null)
  }
  const min = p.min ?? 0
  const commit = async (m: number | null) => {
    if (m === null) return setErr('Enter a percentage')
    if (m > p.max || m < min || (p.minExclusive && m === min))
      return setErr(`Between ${min / 10_000}% and ${p.max / 10_000}%`)
    setErr(null)
    if (m === p.micro) return
    if ((await p.onSave(m)) === undefined) setV(p.micro)
  }
  return (
    <Field label={p.label} hint={p.hint} error={err}>
      <PercentInput valueMicro={v} onChange={setV} onCommit={(m) => void commit(m)} />
    </Field>
  )
}

type LoanForm = { name: string; rateMicro: number | null; termYears: string; pointsMicro: number | null; note: string }
const EMPTY_LOAN: LoanForm = { name: '', rateMicro: null, termYears: '30', pointsMicro: null, note: '' }
const MAX_LOAN_RATE = 250_000 // 25%: anything above is a typo, not a mortgage

export default function Goal() {
  const [data, setData] = useState<GoalData | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [loanForm, setLoanForm] = useState<LoanForm>(EMPTY_LOAN)
  const [loanErr, setLoanErr] = useState<{ field: 'name' | 'rate'; msg: string } | null>(null)
  // '#/goal/loans' and '#/goal/rental' land on these cards (Future and Real estate link to them).
  const loansAnchor = useAnchor('loans')
  const rentalAnchor = useAnchor('rental')

  // A failed first load says so (with a retry) instead of "Loading…" forever; a failed refresh keeps the last data.
  const load = useCallback(
    () =>
      get<GoalData>('/api/goal')
        .then((d) => {
          setData(d)
          setLoadErr(null)
        })
        .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e))),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  // Every write goes through one of these: busy state, a toast either way, a reload after.
  const saveGoal = useAction(
    async (change: Partial<Goal>, receipt: string) => {
      await put('/api/goal', { goal: change })
      return receipt
    },
    { success: (r) => r, errorPrefix: "Couldn't save the goal", onDone: () => void load() },
  )
  const saveRental = useAction(
    async (change: Partial<Rental>, receipt: string) => {
      await put('/api/goal', { rental: change })
      return receipt
    },
    { success: (r) => r, errorPrefix: "Couldn't save the rental scenario", onDone: () => void load() },
  )
  const anchor = useAction(
    async (a: { id: number; name: string }, cents: number) => {
      await patch(`/api/accounts/${a.id}`, { currentBalanceCents: cents })
      return `${a.name} anchored at ${formatCents(cents)}`
    },
    { success: (r) => r, errorPrefix: "Couldn't set the balance", onDone: () => void load() },
  )
  const addLoan = useAction(
    async (f: LoanForm) => {
      await post('/api/loans', {
        name: f.name.trim(),
        rateMicro: f.rateMicro,
        termMonths: Number(f.termYears) * 12,
        pointsMicro: f.pointsMicro ?? 0,
        note: f.note.trim() || undefined,
      })
      return f.name.trim()
    },
    {
      success: (name) => `Added ${name}`,
      errorPrefix: "Couldn't add the loan option",
      onDone: () => {
        setLoanForm(EMPTY_LOAN)
        void load()
      },
    },
  )
  const removeLoan = useAction(
    async (l: Loan) => {
      await del(`/api/loans/${l.id}`)
      return l.name
    },
    { success: (name) => `Removed ${name}`, errorPrefix: "Couldn't remove the loan option", onDone: () => void load() },
  )

  const loadingHeader = <HeaderSlot sub="The down-payment fund, the loan options and what the house costs to carry" />
  if (!data)
    return loadErr ? (
      <div className="card wide" role="alert">
        {loadingHeader}
        <h2>Couldn't load the goal</h2>
        <p className="sub2">{loadErr}</p>
        <Button onClick={() => void load()}>Retry</Button>
      </div>
    ) : (
      <div className="grid12" aria-busy="true">
        {loadingHeader}
        <div className="card c12"><Skeleton h={18} w={160} /><Skeleton h={34} style={{ marginTop: 12 }} /></div>
        <div className="card c8"><Skeleton h={36} w={220} /><Skeleton h={160} style={{ marginTop: 12 }} /></div>
        <div className="card c4"><Skeleton h={120} /></div>
      </div>
    )
  const { goal, rental, accounts, series, monthlySuggest, loans, properties, derived } = data

  async function fixBalance(a: { id: number; name: string; balance_cents: number }) {
    const v = await prompt<{ cents: number }>({
      title: `Set ${a.name}'s balance`,
      body: 'The actual current balance, from the bank site. Scarab anchors the ledger to it — it only knows the flows since your first import.',
      fields: [{ key: 'cents', kind: 'money', label: 'Current balance', initial: a.balance_cents, allowNegative: true }],
      submitLabel: 'Anchor balance',
    })
    if (v) void anchor.run(a, v.cents)
  }

  async function askRemoveLoan(l: Loan) {
    const ok = await confirm({
      title: `Remove ${l.name}?`,
      body: `${pct(l.rate_micro)} over ${Math.round(l.term_months / 12)} years. The payment tables below stop using it.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) void removeLoan.run(l)
  }

  function submitLoan() {
    const f = loanForm
    if (!f.name.trim()) return setLoanErr({ field: 'name', msg: 'Name the option — lender, product, lock' })
    if (f.rateMicro === null || f.rateMicro <= 0) return setLoanErr({ field: 'rate', msg: 'Enter the rate, like 6.375' })
    if (f.rateMicro > MAX_LOAN_RATE) return setLoanErr({ field: 'rate', msg: 'Above 25% is probably a typo' })
    setLoanErr(null)
    void addLoan.run(f)
  }

  // The headline numbers come from the engine (integer cents, calendar-month ETA); the screen only lays them out.
  const { targetCents: target, fundCents: fundTotal, remainingCents: remaining, etaMonth: eta } = derived
  const downCents = target - goal.closingCents
  const progress = derived.pctMicro / 10_000 // CSS width in %, display only

  const selectedLoan = loans.find((l) => l.id === goal.selectedLoanId) ?? loans[0] ?? null
  const rentalNet =
    rental.rentCents > 0
      ? rental.rentCents -
        rental.piCents -
        rental.taxCents -
        rental.insCents -
        ofMicro(rental.rentCents, rental.maintPctMicro) -
        ofMicro(rental.rentCents, rental.vacancyPctMicro)
      : 0

  const matrixPrices = MATRIX_MICRO.map((f) => Math.round(ofMicro(goal.targetPriceCents, f) / TEN_K) * TEN_K)
  const loanAmtAtTarget = goal.targetPriceCents - downCents

  const funded = Math.floor(derived.pctMicro / 10_000) // whole percent, floored: 100 only once funded
  return (
    <div className="grid12">
      <HeaderSlot
        sub={
          `Target ≈ ${fmtShort(goal.targetPriceCents)} · ${funded}% funded` +
          (remaining === 0 ? '' : eta ? ` · on pace for ${fmtMonth(eta, true)}` : derived.monthlyPlanCents > 0 ? '' : ' · no monthly plan yet')
        }
      />
      {/* ---------- target ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>The target</h2>
          <div className="right muted">everything below recalculates from these three numbers</div>
        </div>
        <div className="scr-fields">
          <div className="scr-f lg">
            <MoneySetting
              label="Purchase price"
              cents={goal.targetPriceCents}
              required
              onSave={(c) => saveGoal.run({ targetPriceCents: c }, `Target price set to ${formatCents(c)}`)}
            />
          </div>
          <div className="scr-f sm">
            <PercentSetting
              label="Down payment"
              micro={goal.downPctMicro}
              min={0}
              minExclusive
              max={1_000_000}
              onSave={(m) => saveGoal.run({ downPctMicro: m }, `Down payment set to ${pct(m, 1)}`)}
            />
          </div>
          <div className="scr-f">
            <MoneySetting
              label="Closing costs"
              cents={goal.closingCents}
              required
              onSave={(c) => saveGoal.run({ closingCents: c }, `Closing costs set to ${formatCents(c)}`)}
            />
          </div>
          <span className="sub2" style={{ marginLeft: 'auto', alignSelf: 'center' }}>
            Fund target: <b className="inkstrong">{formatCents(target)}</b> ({fmtShort(downCents)} down + {fmtShort(goal.closingCents)} closing)
          </span>
        </div>
      </div>

      {/* ---------- fund ---------- */}
      <div className="card c8">
        <h2>Down payment fund</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <div className="heronum" style={{ fontSize: 36 }}>
            <CountUp value={fundTotal} format={formatDollars} />
          </div>
          <span className="muted">of {formatDollars(target)}</span>
          {eta && (
            <span className="sub2" style={{ marginLeft: 'auto' }}>
              on pace for <b className="inkstrong">{fmtMonth(eta, true)}</b> at {fmtShort(derived.monthlyPlanCents)}/mo
            </span>
          )}
          {!eta && remaining > 0 && derived.monthlyPlanCents > 0 && (
            <span className="sub2" style={{ marginLeft: 'auto' }}>
              more than a century away at {fmtShort(derived.monthlyPlanCents)}/mo
            </span>
          )}
          {remaining === 0 && <span className="tag" style={{ marginLeft: 'auto' }}>Funded 🎉</span>}
        </div>
        <div
          className="pbar"
          role="progressbar"
          aria-label="Down payment fund"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(progress)}
        >
          <i style={{ width: `${progress}%` }} />
        </div>
        <GoalFundChart series={series} derived={derived} />
      </div>
      <div className="card c4">
        <h2>What counts as the fund</h2>
        <div style={{ display: 'grid', gap: 6 }}>
          {accounts.map((a) => (
            <div key={a.id} className="sub2" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1, minWidth: 0 }}>
                <input
                  type="checkbox"
                  checked={goal.fundAccountIds.includes(a.id)}
                  onChange={(e) =>
                    void saveGoal.run(
                      {
                        fundAccountIds: e.target.checked
                          ? [...goal.fundAccountIds, a.id]
                          : goal.fundAccountIds.filter((id) => id !== a.id),
                      },
                      e.target.checked ? `${a.name} now counts toward the fund` : `${a.name} no longer counts toward the fund`,
                    )
                  }
                />
                {a.name}
              </label>
              <span className="num">{formatCents(a.balance_cents)}</span>
              <Tooltip content="Set the real balance — the ledger only knows flows since your first import">
                <Button variant="ghost" size="mini" aria-label={`Set ${a.name}'s actual balance`} onClick={() => void fixBalance(a)}>
                  fix
                </Button>
              </Tooltip>
            </div>
          ))}
          <div className="scr-fields" style={{ marginTop: 8 }}>
            <div className="scr-f grow">
              <MoneySetting
                label="Earmarked elsewhere"
                hint="brokerage cash and the like, outside these accounts"
                cents={goal.fundExtraCents}
                onSave={(c) => saveGoal.run({ fundExtraCents: c }, `Earmarked elsewhere: ${formatCents(c)}`)}
              />
            </div>
            <div className="scr-f grow">
              <MoneySetting
                label="Plan per month"
                cents={goal.monthlyPlanCents}
                onSave={(c) => saveGoal.run({ monthlyPlanCents: c }, `Monthly plan set to ${formatCents(c)}`)}
              />
            </div>
          </div>
          {monthlySuggest !== 0 && (
            <div className="sub2 topline">
              Trailing 6-month net into these accounts: <b className="inkstrong">{fmtShort(monthlySuggest)}/mo</b>
            </div>
          )}
        </div>
      </div>

      {/* ---------- loan options ---------- */}
      <div className="card c12" ref={loansAnchor}>
        <div className="h4row">
          <h2>Loan options</h2>
          <div className="right muted">from the loan officer's term sheets · click a row to project payments below</div>
        </div>
        {loans.length > 0 && (
          <table>
            <thead>
              <tr>
                <th /><th>Option</th><th className="r">Rate</th><th className="r">Term</th>
                <th className="r">Points</th><th className="r">P&amp;I on {fmtShort(loanAmtAtTarget)}</th><th>Note</th><th />
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => {
                const sel = selectedLoan?.id === l.id
                const pick = () => !sel && void saveGoal.run({ selectedLoanId: l.id }, `Projecting payments with ${l.name}`)
                return (
                  <tr key={l.id} className={sel ? 'selrow' : ''} style={{ cursor: 'pointer' }} onClick={pick}>
                    <td>
                      {/* The row is the mouse target; this is the keyboard's (and says which option is in use). */}
                      <button
                        type="button"
                        className="scr-pick"
                        aria-pressed={sel}
                        aria-label={`Project payments with ${l.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          pick()
                        }}
                      >
                        {sel ? '●' : '○'}
                      </button>
                    </td>
                    <td className="strong">{l.name}</td>
                    <td className="r num">{pct(l.rate_micro)}</td>
                    <td className="r num">{Math.round(l.term_months / 12)} yr</td>
                    <td className="r num">{(l.points_micro / 10_000).toFixed(2)}</td>
                    <td className="r num">{formatCents(pmt(loanAmtAtTarget, l.rate_micro, l.term_months))}/mo</td>
                    <td className="muted">{l.note ?? ''}</td>
                    <td className="r">
                      <Button
                        variant="ghost"
                        size="mini"
                        aria-label={`Remove ${l.name}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          void askRemoveLoan(l)
                        }}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <form
          className="scr-fields"
          style={{ marginTop: 12 }}
          noValidate
          onSubmit={(e) => {
            e.preventDefault()
            submitLoan()
          }}
        >
          <div className="scr-f lg">
            <Field label="Option" error={loanErr?.field === 'name' ? loanErr.msg : null}>
              <TextInput
                placeholder="e.g. 30-yr fixed jumbo"
                maxLength={60}
                value={loanForm.name}
                onChange={(e) => {
                  setLoanForm({ ...loanForm, name: e.target.value })
                  if (loanErr?.field === 'name') setLoanErr(null)
                }}
              />
            </Field>
          </div>
          <div className="scr-f sm">
            <Field label="Rate" error={loanErr?.field === 'rate' ? loanErr.msg : null}>
              <PercentInput
                valueMicro={loanForm.rateMicro}
                placeholder="6.375"
                onChange={(m) => {
                  setLoanForm({ ...loanForm, rateMicro: m })
                  if (loanErr?.field === 'rate') setLoanErr(null)
                }}
              />
            </Field>
          </div>
          <div className="scr-f xs">
            <Field label="Term">
              <Select value={loanForm.termYears} onChange={(e) => setLoanForm({ ...loanForm, termYears: e.target.value })}>
                {TERMS.map((y) => (
                  <option key={y} value={y}>{y} yr</option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="scr-f xs">
            <Field label="Points">
              <PercentInput valueMicro={loanForm.pointsMicro} placeholder="0" onChange={(m) => setLoanForm({ ...loanForm, pointsMicro: m })} />
            </Field>
          </div>
          <div className="scr-f grow">
            <Field label="Note">
              <TextInput
                placeholder="lender, lock, ARM resets…"
                maxLength={200}
                value={loanForm.note}
                onChange={(e) => setLoanForm({ ...loanForm, note: e.target.value })}
              />
            </Field>
          </div>
          <Button type="submit" busy={addLoan.busy} style={{ marginTop: 22 }}>
            Add option
          </Button>
        </form>
      </div>

      {/* ---------- payment matrix ---------- */}
      {selectedLoan && (
        <div className="card c12">
          <div className="h4row">
            <h2>
              What would we pay monthly? <span className="gold" style={{ textTransform: 'none', letterSpacing: 0 }}>· {selectedLoan.name} @ {pct(selectedLoan.rate_micro)}</span>
            </h2>
            <div className="right muted">
              P&amp;I + {pct(goal.taxPctMicro, 1)} property tax + {formatCents(goal.insMonthlyCents)}/mo insurance · {pct(goal.downPctMicro, 1)} down
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Purchase price</th><th className="r">Down</th><th className="r">Loan</th>
                <th className="r">P&amp;I</th><th className="r">Tax + ins</th><th className="r">All-in monthly</th>
                {rentalNet !== 0 && <th className="r">Net of rental</th>}
              </tr>
            </thead>
            <tbody>
              {matrixPrices.map((price, i) => {
                const down = ofMicro(price, goal.downPctMicro)
                const loanAmt = price - down
                const pi = pmt(loanAmt, selectedLoan.rate_micro, selectedLoan.term_months)
                const ti = Math.round(ofMicro(price, goal.taxPctMicro) / 12) + goal.insMonthlyCents
                const hl = i === 2
                return (
                  <tr key={i}>
                    <td className={`num ${hl ? 'gold strong' : ''}`}>{fmtShort(price)}</td>
                    <td className="r num">{fmtShort(down)}</td>
                    <td className="r num">{fmtShort(loanAmt)}</td>
                    <td className="r num">{formatCents(pi)}</td>
                    <td className="r num">{formatCents(ti)}</td>
                    <td className={`r num strong ${hl ? 'gold' : ''}`}>{formatCents(pi + ti)}/mo</td>
                    {rentalNet !== 0 && (
                      <td className="r num pos">{formatCents(pi + ti - rentalNet)}/mo</td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------- funding & taxes (full width when there's no loan to set carry vs. payoff beside it) ---------- */}
      <div className={`card ${selectedLoan ? 'c6' : 'c12'}`}>
        <div className="h4row">
          <h2>Funding the gap with asset sales</h2>
          <div className="right muted">net → gross, with the loss carryforward applied</div>
        </div>
        <div className="scr-fields">
          <div className="scr-f fill">
            <PercentSetting
              label="Cap-gains rate"
              hint="federal LTCG + NIIT + state"
              micro={goal.capGainsRateMicro}
              max={1_000_000}
              onSave={(m) => saveGoal.run({ capGainsRateMicro: m }, `Cap-gains rate set to ${pct(m, 1)}`)}
            />
          </div>
          <div className="scr-f fill">
            <MoneySetting
              label="Loss carryforward"
              hint="banked losses offset gains"
              cents={goal.lossCarryforwardCents}
              onSave={(c) => saveGoal.run({ lossCarryforwardCents: c }, `Loss carryforward set to ${formatCents(c)}`)}
            />
          </div>
          <div className="scr-f fill">
            <PercentSetting
              label="Basis"
              hint="share of the sale that is cost"
              micro={goal.saleBasisPctMicro}
              max={1_000_000}
              onSave={(m) => saveGoal.run({ saleBasisPctMicro: m }, `Basis set to ${pct(m, 1)} of the sale`)}
            />
          </div>
        </div>
        {remaining > 0 ? (
          (() => {
            const g = grossSaleForNet(remaining, goal.saleBasisPctMicro, goal.capGainsRateMicro, goal.lossCarryforwardCents)
            return (
              <table style={{ marginTop: 10, maxWidth: 440 }}>
                <tbody>
                  <tr><td>Gap to fund target (net)</td><td className="r num">{formatCents(remaining)}</td></tr>
                  <tr><td>Gross sale needed</td><td className="r num strong">{formatCents(g.grossCents)}</td></tr>
                  <tr>
                    <td>Est. capital-gains tax</td>
                    <td className={`r num ${g.taxCents === 0 ? 'pos' : ''}`}>
                      {g.taxCents === 0 ? 'fully shielded' : formatCents(g.taxCents)}
                    </td>
                  </tr>
                </tbody>
              </table>
            )
          })()
        ) : (
          <p className="sub2" style={{ marginTop: 8 }}>The fund already covers the target — nothing to gross up.</p>
        )}
        <p className="sub2" style={{ marginTop: 8 }}>
          A calculator, not tax advice — carryforward mechanics and state conformity are CPA territory.
        </p>
      </div>

      {/* ---------- carry vs payoff ---------- */}
      {selectedLoan && (
        <div className="card c6">
          <div className="h4row">
            <h2>Carry vs. payoff</h2>
            <div className="right muted">{selectedLoan.name} @ {pct(selectedLoan.rate_micro)}</div>
          </div>
          <table>
            <thead>
              <tr><th>Down</th><th className="r">Loan</th><th className="r">P&amp;I / mo</th><th className="r">≈ Interest, yr 1</th></tr>
            </thead>
            <tbody>
              {[goal.downPctMicro, 300_000, 500_000, 1_000_000].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((d) => {
                const loanAmt = goal.targetPriceCents - ofMicro(goal.targetPriceCents, d)
                return (
                  <tr key={d}>
                    <td className="num">{pct(d, 1)}</td>
                    <td className="r num">{loanAmt === 0 ? '—' : fmtShort(loanAmt)}</td>
                    <td className="r num">{loanAmt === 0 ? '$0' : formatCents(pmt(loanAmt, selectedLoan.rate_micro, selectedLoan.term_months))}</td>
                    <td className="r num">{loanAmt === 0 ? '$0' : fmtShort(ofMicro(loanAmt, selectedLoan.rate_micro))}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p className="sub2" style={{ marginTop: 10, maxWidth: '58ch' }}>
            Economically, every dollar of loan you carry while holding investments is a dollar borrowed at{' '}
            {pct(selectedLoan.rate_micro, 2)} to stay invested. Carry beats payoff only if the retained assets
            out-earn that rate after tax; payoff is a guaranteed {pct(selectedLoan.rate_micro, 2)} return. Same
            question, two framings — pick the one that makes your conviction honest.
          </p>
        </div>
      )}

      {/* ---------- rental scenario ---------- */}
      <div className="card c12" ref={rentalAnchor}>
        <div className="h4row">
          <h2>Rent out the current home</h2>
          <div className="right">
            <select
              className="mini"
              aria-label="Which property would be rented out"
              value={rental.propertyId ?? ''}
              onChange={(e) => {
                const id = e.target.value === '' ? null : Number(e.target.value)
                const name = properties.find((p) => p.id === id)?.name
                void saveRental.run({ propertyId: id }, name ? `Rental scenario: ${name}` : 'Rental scenario cleared')
              }}
            >
              <option value="">— which property —</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="scr-fields">
          {(
            [
              ['Market rent / mo', 'rentCents', 'Market rent'],
              ['P&I / mo', 'piCents', 'P&I'],
              ['Property tax / mo', 'taxCents', 'Property tax'],
              ['Insurance / mo', 'insCents', 'Insurance'],
            ] as const
          ).map(([label, key, what]) => (
            <div className="scr-f" key={key}>
              <MoneySetting
                label={label}
                cents={rental[key]}
                onSave={(c) => saveRental.run({ [key]: c } as Partial<Rental>, `${what} set to ${formatCents(c)}/mo`)}
              />
            </div>
          ))}
        </div>
        {rental.rentCents > 0 && (
          <table style={{ marginTop: 12, maxWidth: 460 }}>
            <tbody>
              <tr><td>Rent in</td><td className="r num pos">+{formatCents(rental.rentCents)}</td></tr>
              <tr><td>P&amp;I + tax + insurance</td><td className="r num">−{formatCents(rental.piCents + rental.taxCents + rental.insCents)}</td></tr>
              <tr>
                <td>Maintenance ({pct(rental.maintPctMicro, 1)}) + vacancy ({pct(rental.vacancyPctMicro, 1)})</td>
                <td className="r num">−{formatCents(ofMicro(rental.rentCents, rental.maintPctMicro + rental.vacancyPctMicro))}</td>
              </tr>
              <tr>
                <td className="strong">Net cash flow</td>
                <td className={`r num strong ${rentalNet >= 0 ? 'pos' : 'neg'}`}>{formatCents(rentalNet, { sign: rentalNet > 0 })}/mo</td>
              </tr>
              <tr>
                <td className="muted">Qualifying income (lenders count ~75% of rent)</td>
                <td className="r num muted">+{formatCents(ofMicro(rental.rentCents, 750_000))}/mo</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="sub2" style={{ marginTop: 10, maxWidth: '70ch' }}>
          Remember the §121 clock: renting out a home you lived in starts a ~3-year window after which the
          $500K married capital-gains exclusion fades. Selling within that window keeps it.
        </p>
      </div>
    </div>
  )
}
