import { useCallback, useEffect, useState } from 'react'
import { formatCents, parseMoney } from '../../shared/money'
import { del, get, patch, post, put } from '../api'
import { fmtMonth, fmtShort, LineChart } from '../viz'
import { grossSaleForNet } from '../../shared/series'

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
}

/** Monthly principal & interest. A projection, so float math then round once. */
function pmt(loanCents: number, rateMicro: number, termMonths: number): number {
  const r = rateMicro / 1_000_000 / 12
  if (r === 0) return Math.round(loanCents / termMonths)
  return Math.round((loanCents * r) / (1 - Math.pow(1 + r, -termMonths)))
}

const pct = (micro: number, dp = 3) => `${(micro / 10_000).toFixed(dp)}%`

export default function Goal() {
  const [data, setData] = useState<GoalData | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [loanForm, setLoanForm] = useState({ name: '', rate: '', termYears: '30', points: '0', note: '' })

  const load = useCallback(() => get<GoalData>('/api/goal').then(setData).catch(console.error), [])
  useEffect(() => {
    load()
  }, [load])

  if (!data) return <div className="card">Loading…</div>
  const { goal, rental, accounts, fundTotal, series, monthlySuggest, loans, properties } = data

  async function saveGoal(patch: Partial<Goal>) {
    await put('/api/goal', { goal: patch })
    load()
  }
  async function saveRental(patch: Partial<Rental>) {
    await put('/api/goal', { rental: patch })
    load()
  }
  function moneyInput(value: string, save: (cents: number) => void) {
    try {
      save(value.trim() === '' ? 0 : parseMoney(value))
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function fixBalance(a: { id: number; name: string }) {
    const v = window.prompt(`What is the ACTUAL current balance of ${a.name} (from the bank site)? Scarab will anchor the ledger to it:`, '')
    if (!v?.trim()) return
    try {
      await patch(`/api/accounts/${a.id}`, { currentBalanceCents: parseMoney(v) })
      load()
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function addLoan() {
    setMsg(null)
    const rate = Number(loanForm.rate)
    const years = Number(loanForm.termYears)
    const points = Number(loanForm.points)
    if (!loanForm.name.trim() || !Number.isFinite(rate) || rate <= 0 || rate > 25 || !Number.isFinite(years) || years <= 0)
      return setMsg('Loan needs a name, a rate like 6.375, and a term in years')
    await post('/api/loans', {
      name: loanForm.name.trim(),
      rateMicro: Math.round(rate * 10_000),
      termMonths: Math.round(years * 12),
      pointsMicro: Number.isFinite(points) ? Math.round(points * 10_000) : 0,
      note: loanForm.note.trim() || undefined,
    })
    setLoanForm({ name: '', rate: '', termYears: '30', points: '0', note: '' })
    load()
  }

  const target = Math.round((goal.targetPriceCents * goal.downPctMicro) / 1_000_000) + goal.closingCents
  const progress = target > 0 ? Math.min(100, (fundTotal / target) * 100) : 0
  const remaining = Math.max(0, target - fundTotal)
  const monthsLeft = goal.monthlyPlanCents > 0 ? Math.ceil(remaining / goal.monthlyPlanCents) : null
  const eta =
    monthsLeft !== null && remaining > 0
      ? new Date(new Date().setMonth(new Date().getMonth() + monthsLeft)).toISOString().slice(0, 7)
      : null

  const selectedLoan = loans.find((l) => l.id === goal.selectedLoanId) ?? loans[0] ?? null
  const rentalNet =
    rental.rentCents > 0
      ? rental.rentCents -
        rental.piCents -
        rental.taxCents -
        rental.insCents -
        Math.round((rental.rentCents * rental.maintPctMicro) / 1_000_000) -
        Math.round((rental.rentCents * rental.vacancyPctMicro) / 1_000_000)
      : 0

  const matrixPrices = [0.85, 0.925, 1, 1.075, 1.15].map((f) => Math.round((goal.targetPriceCents * f) / 1_000_000) * 10_000)

  return (
    <div className="grid12">
      {/* ---------- target ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>The target</h2>
          <div className="right muted">everything below recalculates from these three numbers</div>
        </div>
        <div className="formrow">
          <label className="sub2">Price</label>
          <input
            className="money"
            defaultValue={(goal.targetPriceCents / 100).toLocaleString('en-US')}
            onBlur={(e) => moneyInput(e.target.value, (c) => saveGoal({ targetPriceCents: c }))}
          />
          <label className="sub2">Down</label>
          <input
            className="qty"
            defaultValue={goal.downPctMicro / 10_000}
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n > 0 && n <= 100) saveGoal({ downPctMicro: Math.round(n * 10_000) })
            }}
          />
          <span className="sub2">%</span>
          <label className="sub2">Closing costs</label>
          <input
            className="money"
            defaultValue={(goal.closingCents / 100).toLocaleString('en-US')}
            onBlur={(e) => moneyInput(e.target.value, (c) => saveGoal({ closingCents: c }))}
          />
          <span className="sub2" style={{ marginLeft: 'auto' }}>
            Fund target: <b className="inkstrong">{formatCents(target)}</b> ({fmtShort(Math.round((goal.targetPriceCents * goal.downPctMicro) / 1_000_000))} down + {fmtShort(goal.closingCents)} closing)
          </span>
        </div>
        {msg && <div className="sub2 importmsg">{msg}</div>}
      </div>

      {/* ---------- fund ---------- */}
      <div className="card c8">
        <h2>Down payment fund</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <div className="heronum" style={{ fontSize: 36 }}>{formatCents(fundTotal)}</div>
          <span className="muted">of {formatCents(target)}</span>
          {eta && (
            <span className="sub2" style={{ marginLeft: 'auto' }}>
              on pace for <b className="inkstrong">{fmtMonth(eta, true)}</b> at {fmtShort(goal.monthlyPlanCents)}/mo
            </span>
          )}
          {remaining === 0 && <span className="tag" style={{ marginLeft: 'auto' }}>Funded 🎉</span>}
        </div>
        <div className="pbar"><i style={{ width: `${progress}%` }} /></div>
        {series.length >= 2 && (
          <LineChart
            labels={series.map((s) => fmtMonth(s.month, s.month.endsWith('-01')))}
            series={[{ name: 'Fund', color: 'var(--gold)', values: series.map((s) => s.cents), area: true }]}
            h={160}
            tipLabel={(i) => fmtMonth(series[i]!.month, true)}
          />
        )}
      </div>
      <div className="card c4">
        <h2>What counts as the fund</h2>
        <div style={{ display: 'grid', gap: 6 }}>
          {accounts.map((a) => (
            <label key={a.id} className="sub2" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={goal.fundAccountIds.includes(a.id)}
                onChange={(e) =>
                  saveGoal({
                    fundAccountIds: e.target.checked
                      ? [...goal.fundAccountIds, a.id]
                      : goal.fundAccountIds.filter((id) => id !== a.id),
                  })
                }
              />
              {a.name}
              <span className="num" style={{ marginLeft: 'auto' }}>{formatCents(a.balance_cents)}</span>
              <button className="btn mini ghosty" title="Set the real balance — the ledger only knows flows since your first import" onClick={() => fixBalance(a)}>
                fix
              </button>
            </label>
          ))}
          <div className="formrow" style={{ marginTop: 6 }}>
            <label className="sub2">+ elsewhere</label>
            <input
              className="money"
              title="earmarked money not in these accounts (brokerage cash, etc.)"
              defaultValue={goal.fundExtraCents ? (goal.fundExtraCents / 100).toLocaleString('en-US') : ''}
              placeholder="0"
              onBlur={(e) => moneyInput(e.target.value, (c) => saveGoal({ fundExtraCents: c }))}
            />
          </div>
          <div className="formrow">
            <label className="sub2">Plan / month</label>
            <input
              className="money"
              defaultValue={goal.monthlyPlanCents ? (goal.monthlyPlanCents / 100).toLocaleString('en-US') : ''}
              placeholder="0"
              onBlur={(e) => moneyInput(e.target.value, (c) => saveGoal({ monthlyPlanCents: c }))}
            />
          </div>
          {monthlySuggest !== 0 && (
            <div className="sub2 topline">
              Trailing 6-month net into these accounts: <b className="inkstrong">{fmtShort(monthlySuggest)}/mo</b>
            </div>
          )}
        </div>
      </div>

      {/* ---------- loan options ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Loan options</h2>
          <div className="right muted">from the loan officer's term sheets · click a row to project payments below</div>
        </div>
        {loans.length > 0 && (
          <table>
            <thead>
              <tr>
                <th /><th>Option</th><th className="r">Rate</th><th className="r">Term</th>
                <th className="r">Points</th><th className="r">P&amp;I on {fmtShort(Math.round((goal.targetPriceCents * (1_000_000 - goal.downPctMicro)) / 1_000_000))}</th><th>Note</th><th />
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => {
                const loanAmt = Math.round((goal.targetPriceCents * (1_000_000 - goal.downPctMicro)) / 1_000_000)
                const sel = selectedLoan?.id === l.id
                return (
                  <tr key={l.id} className={sel ? 'selrow' : ''} style={{ cursor: 'pointer' }} onClick={() => saveGoal({ selectedLoanId: l.id })}>
                    <td>{sel ? '●' : '○'}</td>
                    <td className="strong">{l.name}</td>
                    <td className="r num">{pct(l.rate_micro)}</td>
                    <td className="r num">{Math.round(l.term_months / 12)} yr</td>
                    <td className="r num">{(l.points_micro / 10_000).toFixed(2)}</td>
                    <td className="r num">{formatCents(pmt(loanAmt, l.rate_micro, l.term_months))}/mo</td>
                    <td className="muted">{l.note ?? ''}</td>
                    <td className="r">
                      <button
                        className="btn mini ghosty"
                        onClick={(e) => {
                          e.stopPropagation()
                          del(`/api/loans/${l.id}`).then(load)
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        <div className="formrow" style={{ marginTop: 10 }}>
          <input
            placeholder="e.g. 30-yr fixed jumbo"
            style={{ width: 180 }}
            value={loanForm.name}
            onChange={(e) => setLoanForm({ ...loanForm, name: e.target.value })}
          />
          <input
            className="qty"
            placeholder="rate % (6.375)"
            value={loanForm.rate}
            onChange={(e) => setLoanForm({ ...loanForm, rate: e.target.value })}
          />
          <input
            className="qty"
            placeholder="years"
            value={loanForm.termYears}
            onChange={(e) => setLoanForm({ ...loanForm, termYears: e.target.value })}
          />
          <input
            className="qty"
            placeholder="points"
            value={loanForm.points}
            onChange={(e) => setLoanForm({ ...loanForm, points: e.target.value })}
          />
          <input
            placeholder="note (lender, lock, ARM resets…)"
            style={{ width: 220 }}
            value={loanForm.note}
            onChange={(e) => setLoanForm({ ...loanForm, note: e.target.value })}
          />
          <button className="btn" onClick={addLoan} disabled={!loanForm.name || !loanForm.rate}>
            Add option
          </button>
        </div>
      </div>

      {/* ---------- payment matrix ---------- */}
      {selectedLoan && (
        <div className="card c12">
          <div className="h4row">
            <h2>
              What would we pay monthly? <span className="gold" style={{ textTransform: 'none', letterSpacing: 0 }}>· {selectedLoan.name} @ {pct(selectedLoan.rate_micro)}</span>
            </h2>
            <div className="right muted">
              P&amp;I + {pct(goal.taxPctMicro, 1)} property tax + {formatCents(goal.insMonthlyCents)}/mo insurance · {goal.downPctMicro / 10_000}% down
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
              {matrixPrices.map((price) => {
                const down = Math.round((price * goal.downPctMicro) / 1_000_000)
                const loanAmt = price - down
                const pi = pmt(loanAmt, selectedLoan.rate_micro, selectedLoan.term_months)
                const ti = Math.round((price * goal.taxPctMicro) / 1_000_000 / 12) + goal.insMonthlyCents
                const hl = price === matrixPrices[2]
                return (
                  <tr key={price}>
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

      {/* ---------- funding & taxes ---------- */}
      <div className="card c6">
        <div className="h4row">
          <h2>Funding the gap with asset sales</h2>
          <div className="right muted">net → gross, with the loss carryforward applied</div>
        </div>
        <div className="formrow">
          <label className="sub2">Cap-gains rate</label>
          <input
            className="qty"
            defaultValue={goal.capGainsRateMicro / 10_000}
            title="combined federal LTCG + NIIT + state marginal — confirm with your CPA"
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= 0 && n < 60) saveGoal({ capGainsRateMicro: Math.round(n * 10_000) })
            }}
          />
          <span className="sub2">%</span>
          <label className="sub2">Loss carryforward</label>
          <input
            className="money"
            defaultValue={goal.lossCarryforwardCents ? (goal.lossCarryforwardCents / 100).toLocaleString('en-US') : ''}
            placeholder="0"
            title="realized capital losses banked (e.g. from tax-aware strategies) — they offset gains dollar-for-dollar"
            onBlur={(e) => moneyInput(e.target.value, (c) => saveGoal({ lossCarryforwardCents: c }))}
          />
          <label className="sub2">Basis</label>
          <input
            className="qty"
            defaultValue={goal.saleBasisPctMicro / 10_000}
            title="share of sale proceeds that is cost basis (2017 coins ≈ low single digits)"
            onBlur={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n >= 0 && n <= 100) saveGoal({ saleBasisPctMicro: Math.round(n * 10_000) })
            }}
          />
          <span className="sub2">% of sale</span>
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
              {[goal.downPctMicro / 10_000, 30, 50, 100].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b).map((d) => {
                const loanAmt = Math.round((goal.targetPriceCents * (100 - d)) / 100)
                return (
                  <tr key={d}>
                    <td className="num">{d}%</td>
                    <td className="r num">{loanAmt === 0 ? '—' : fmtShort(loanAmt)}</td>
                    <td className="r num">{loanAmt === 0 ? '$0' : formatCents(pmt(loanAmt, selectedLoan.rate_micro, selectedLoan.term_months))}</td>
                    <td className="r num">{loanAmt === 0 ? '$0' : fmtShort(Math.round((loanAmt * selectedLoan.rate_micro) / 1_000_000))}</td>
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
      <div className="card c12">
        <div className="h4row">
          <h2>Rent out the current home</h2>
          <div className="right">
            <select
              className="mini"
              value={rental.propertyId ?? ''}
              onChange={(e) => saveRental({ propertyId: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">— which property —</option>
              {properties.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="formrow">
          {(
            [
              ['Market rent /mo', 'rentCents'],
              ['P&I /mo', 'piCents'],
              ['Property tax /mo', 'taxCents'],
              ['Insurance /mo', 'insCents'],
            ] as const
          ).map(([label, key]) => (
            <span key={key} className="addform">
              <label className="sub2">{label}</label>
              <input
                className="money"
                defaultValue={rental[key] ? (rental[key] / 100).toLocaleString('en-US') : ''}
                placeholder="0"
                onBlur={(e) => moneyInput(e.target.value, (c) => saveRental({ [key]: c } as Partial<Rental>))}
              />
            </span>
          ))}
        </div>
        {rental.rentCents > 0 && (
          <table style={{ marginTop: 12, maxWidth: 460 }}>
            <tbody>
              <tr><td>Rent in</td><td className="r num pos">+{formatCents(rental.rentCents)}</td></tr>
              <tr><td>P&amp;I + tax + insurance</td><td className="r num">−{formatCents(rental.piCents + rental.taxCents + rental.insCents)}</td></tr>
              <tr>
                <td>Maintenance ({pct(rental.maintPctMicro, 1)}) + vacancy ({pct(rental.vacancyPctMicro, 1)})</td>
                <td className="r num">−{formatCents(Math.round((rental.rentCents * (rental.maintPctMicro + rental.vacancyPctMicro)) / 1_000_000))}</td>
              </tr>
              <tr>
                <td className="strong">Net cash flow</td>
                <td className={`r num strong ${rentalNet >= 0 ? 'pos' : 'neg'}`}>{formatCents(rentalNet, { sign: rentalNet > 0 })}/mo</td>
              </tr>
              <tr>
                <td className="muted">Qualifying income (lenders count ~75% of rent)</td>
                <td className="r num muted">+{formatCents(Math.round(rental.rentCents * 0.75))}/mo</td>
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
