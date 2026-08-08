import { useCallback, useEffect, useRef, useState } from 'react'
import { formatCents } from '../../shared/money'
import { get, post } from '../api'
import { fmtShort, LineChart } from '../viz'

type NetWorthPoint = {
  cash: number
  brokerage: number
  retirement: number
  crypto: number
  property: number
  liabilities: number
  total: number
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

type Knobs = {
  meanReturn: string // percent strings for inputs
  vol: string
  propertyGrowth: string
  saveBefore: string // $/yr
  saveAfter: string
  btcShock: string // percent applied to the crypto slice at t=0
  buyEnabled: boolean
  buyYear: string
  retireYear: string
  retireSpend: string
  endYear: string
}

const thisYear = new Date().getFullYear()

export default function Future() {
  const [nw, setNw] = useState<NetWorthPoint | null>(null)
  const [goal, setGoal] = useState<{
    targetPriceCents: number
    downPctMicro: number
    closingCents: number
    selectedLoanId: number | null
  } | null>(null)
  const [loans, setLoans] = useState<{ id: number; rate_micro: number; term_months: number }[]>([])
  const [sim, setSim] = useState<SimResult | null>(null)
  const [knobs, setKnobs] = useState<Knobs>({
    meanReturn: '5.0',
    vol: '12',
    propertyGrowth: '2.0',
    saveBefore: '150,000',
    saveAfter: '90,000',
    btcShock: '0',
    buyEnabled: true,
    buyYear: String(thisYear + 1),
    retireYear: String(thisYear + 22),
    retireSpend: '180,000',
    endYear: String(thisYear + 30),
  })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    get<{ current: NetWorthPoint | null }>('/api/networth')
      .then((r) => setNw(r.current))
      .catch(console.error)
    get<{ goal: { targetPriceCents: number; downPctMicro: number; closingCents: number; selectedLoanId: number | null }; loans: { id: number; rate_micro: number; term_months: number }[] }>(
      '/api/goal',
    )
      .then((r) => {
        setGoal(r.goal)
        setLoans(r.loans)
      })
      .catch(console.error)
  }, [])

  const money = (s: string) => {
    const n = Number(s.replace(/[$,\s]/g, ''))
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0
  }
  const pctMicro = (s: string) => {
    const n = Number(s)
    return Number.isFinite(n) ? Math.round(n * 10_000) : 0
  }

  const run = useCallback(() => {
    if (!nw || !goal) return
    const loan = loans.find((l) => l.id === goal.selectedLoanId) ?? loans[0]
    const down = Math.round((goal.targetPriceCents * goal.downPctMicro) / 1_000_000)
    const shock = Number(knobs.btcShock)
    const shockedCrypto = Math.max(
      0,
      Math.round(nw.crypto * (1 + (Number.isFinite(shock) ? Math.max(-100, shock) : 0) / 100)),
    )
    const body = {
      startYear: thisYear,
      endYear: Number(knobs.endYear) || thisYear + 30,
      liquidCents: nw.cash + nw.brokerage + nw.retirement + shockedCrypto,
      propertyCents: nw.property,
      liabilitiesCents: -nw.liabilities,
      meanReturnMicro: pctMicro(knobs.meanReturn),
      volMicro: pctMicro(knobs.vol),
      propertyGrowthMicro: pctMicro(knobs.propertyGrowth),
      saveBeforeBuyCents: money(knobs.saveBefore),
      saveAfterBuyCents: money(knobs.saveAfter),
      buy:
        knobs.buyEnabled && loan
          ? {
              year: Number(knobs.buyYear) || thisYear + 1,
              priceCents: goal.targetPriceCents,
              cashOutCents: down + goal.closingCents,
              rateMicro: loan.rate_micro,
              termMonths: loan.term_months,
            }
          : null,
      retireYear: Number(knobs.retireYear) || thisYear + 22,
      retireSpendCents: money(knobs.retireSpend),
    }
    post<SimResult>('/api/simulate', body).then(setSim).catch(console.error)
  }, [nw, goal, loans, knobs])

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(run, 250)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [run])

  if (!nw)
    return (
      <div className="card wide">
        <h2>Nothing to project yet</h2>
        <p>The simulation starts from your real balance sheet — import accounts and add holdings first.</p>
      </div>
    )

  const knob = (key: keyof Knobs, label: string, width = 90, suffix = '') => (
    <span className="addform" key={key}>
      <label className="sub2">{label}</label>
      <input
        style={{ width }}
        value={String(knobs[key])}
        onChange={(e) => setKnobs((k) => ({ ...k, [key]: e.target.value }))}
      />
      {suffix && <span className="sub2">{suffix}</span>}
    </span>
  )

  return (
    <div className="grid12">
      <div className="card c12">
        <div className="h4row">
          <h2>Assumptions</h2>
          <div className="right muted">
            real (inflation-adjusted) dollars · 2,000 paths · today's balance sheet {fmtShort(nw.total)} ·
            crypto slice {fmtShort(nw.crypto)} (the shock knob hits this before anything runs)
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
            <input
              type="checkbox"
              checked={knobs.buyEnabled}
              onChange={(e) => setKnobs((k) => ({ ...k, buyEnabled: e.target.checked }))}
            />
            Buy the dream home ({goal ? fmtShort(goal.targetPriceCents) : '—'}, terms from the Dream Home tab)
          </label>
          {knobs.buyEnabled && knob('buyYear', 'in', 70)}
          {knob('retireYear', 'Retire', 70)}
          {knob('retireSpend', 'Spend/yr retired', 100)}
          {knob('endYear', 'Project to', 70)}
        </div>
      </div>

      <div className="card c9">
        <div className="h4row">
          <h2>Household net worth · simulated (today's dollars)</h2>
          <div className="right legend">
            <span className="li"><span className="sw" style={{ background: 'rgba(91,141,239,.16)' }} />10–90th</span>
            <span className="li"><span className="sw" style={{ background: 'rgba(91,141,239,.32)' }} />25–75th</span>
            <span className="li"><span className="sw ln" style={{ background: 'var(--s2)', width: 14, height: 3, borderRadius: 2 }} />Median</span>
          </div>
        </div>
        {sim ? (
          <LineChart
            labels={sim.years.map(String)}
            series={[{ name: 'Median', color: 'var(--s2)', values: sim.p50 }]}
            bands={[
              { lo: sim.p10, hi: sim.p90, fill: 'rgba(91,141,239,.16)' },
              { lo: sim.p25, hi: sim.p75, fill: 'rgba(91,141,239,.32)' },
            ]}
            h={300}
            maxXTicks={7}
            tipLabel={(i) => `${sim.years[i]}`}
          />
        ) : (
          <p className="sub2">Running…</p>
        )}
      </div>
      <div className="card c3">
        <h2>Odds</h2>
        {sim && (
          <div style={{ display: 'grid', gap: 14 }}>
            <div>
              <div className="muted">Plan succeeds¹</div>
              <div className="heronum" style={{ fontSize: 36 }}>{sim.successPct}%</div>
            </div>
            <div>
              <div className="muted">Median at {sim.years[sim.years.length - 1]}</div>
              <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>{fmtShort(sim.medianEndCents)}</div>
            </div>
            <div>
              <div className="muted">10th percentile</div>
              <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>{fmtShort(sim.p10EndCents)}</div>
            </div>
            <div className="sub2 topline">
              ¹ {knobs.buyEnabled ? `buy the house in ${knobs.buyYear} and ` : ''}spend{' '}
              {formatCents(money(knobs.retireSpend))}/yr from {knobs.retireYear} without the liquid portfolio
              running out before {knobs.endYear}.
            </div>
          </div>
        )}
      </div>

      <div className="card c12">
        <h2>How to read this</h2>
        <p>
          Each of 2,000 futures draws yearly investment returns from your return/volatility assumptions
          (lognormal, in real dollars), grows property deterministically, moves the down payment out of the
          portfolio in the purchase year, amortizes the new mortgage, and switches from saving to spending at
          retirement. The bands show where 80% and 50% of those futures land. It's a flashlight, not a
          promise — revisit the assumptions yearly.
        </p>
      </div>
    </div>
  )
}
