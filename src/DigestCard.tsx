import { useEffect, useState } from 'react'
import { formatCents } from '../shared/money'
import { get, post } from './api'

type Rec = {
  merchant: string
  cadence: string
  typicalCents: number
  lastCents: number
  firstOn: string
  lastOn: string
  nextExpectedOn: string
  priceCreepMicro: number
}
type Digest = {
  since: string
  sinceDay: string
  netWorth: null | { baselineMonth: string; totalCents: number; deltaCents: number; drivers: { name: string; deltaCents: number }[] }
  newTx: { count: number; uncategorized: number }
  newRecurring: Rec[]
  priceCreep: Rec[]
  lapsed: Rec[]
  allocationDrift: { name: string; nowMicro: number; thenMicro: number; deltaMicro: number }[]
  budgetOverruns: { name: string; budgetCents: number; actualCents: number }[]
  mortgage: null | { marketRateMicro: number; marketOn: string; bestLoanName: string; bestLoanRateMicro: number; triggered: boolean }
  notable: boolean
  errors: string[]
}

const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
const pp = (micro: number) => `${micro > 0 ? '+' : ''}${(micro / 10_000).toFixed(1)}pp`
const CLASS_LABEL: Record<string, string> = {
  cash: 'Cash', brokerage: 'Brokerage', retirement: 'Retirement', crypto: 'Crypto',
  property: 'Property', liabilities: 'Liabilities',
}

export default function DigestCard() {
  const [digest, setDigest] = useState<Digest | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    get<Digest>('/api/digest').then(setDigest).catch(console.error)
  }, [])

  if (gone || !digest || !digest.notable) return null
  const d = digest

  async function ack() {
    setGone(true)
    try { await post('/api/digest/ack', {}) } catch { /* next visit re-offers */ }
  }

  return (
    <div className="card c12">
      <div className="h4row">
        <h2>Since you were last here <span className="muted">· {d.sinceDay}</span></h2>
        <div className="right">
          <button className="btn mini" onClick={ack} title="Start the next digest from now">Caught up ✓</button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 6 }}>
        {d.netWorth && d.netWorth.deltaCents !== 0 && (
          <div className="sub2">
            Net worth <b className={`inkstrong ${d.netWorth.deltaCents >= 0 ? 'pos' : 'neg'}`}>
              {d.netWorth.deltaCents >= 0 ? '▲' : '▼'} {formatCents(Math.abs(d.netWorth.deltaCents))}
            </b>{' '}
            since {d.netWorth.baselineMonth} — mostly{' '}
            {d.netWorth.drivers.map((x, i) => (
              <span key={x.name}>{i > 0 && ', '}{CLASS_LABEL[x.name] ?? x.name} {formatCents(x.deltaCents, { sign: x.deltaCents > 0 })}</span>
            ))}
          </div>
        )}
        {d.newTx.count > 0 && (
          <div className="sub2">
            <b className="inkstrong">{d.newTx.count}</b> new transaction{d.newTx.count > 1 ? 's' : ''} imported
            {d.newTx.uncategorized > 0 && <> · <b className="inkstrong">{d.newTx.uncategorized}</b> still uncategorized → Cash &amp; budget</>}
          </div>
        )}
        {d.newRecurring.length > 0 && (
          <div className="sub2">
            New recurring charge{d.newRecurring.length > 1 ? 's' : ''}:{' '}
            {d.newRecurring.slice(0, 4).map((r, i) => (
              <span key={r.merchant}>{i > 0 && ' · '}<b className="inkstrong">{r.merchant}</b> ≈{formatCents(r.typicalCents)}/{r.cadence.replace('ly', '')}</span>
            ))}
          </div>
        )}
        {d.priceCreep.length > 0 && (
          <div className="sub2">
            Price creep:{' '}
            {d.priceCreep.slice(0, 4).map((r, i) => (
              <span key={r.merchant}>{i > 0 && ' · '}<b className="inkstrong">{r.merchant}</b> {formatCents(r.typicalCents)} → {formatCents(r.lastCents)} (+{pct(r.priceCreepMicro)})</span>
            ))}
          </div>
        )}
        {d.lapsed.length > 0 && (
          <div className="sub2">
            Possibly cancelled or missed:{' '}
            {d.lapsed.slice(0, 4).map((r, i) => (
              <span key={r.merchant}>{i > 0 && ' · '}<b className="inkstrong">{r.merchant}</b> (expected {r.nextExpectedOn})</span>
            ))}
          </div>
        )}
        {d.allocationDrift.length > 0 && (
          <div className="sub2">
            Allocation drift:{' '}
            {d.allocationDrift.map((x, i) => (
              <span key={x.name}>{i > 0 && ' · '}<b className="inkstrong">{CLASS_LABEL[x.name] ?? x.name}</b> {pct(x.thenMicro)} → {pct(x.nowMicro)} ({pp(x.deltaMicro)})</span>
            ))}
          </div>
        )}
        {d.budgetOverruns.length > 0 && (
          <div className="sub2">
            Over budget this month:{' '}
            {d.budgetOverruns.map((x, i) => (
              <span key={x.name}>{i > 0 && ' · '}<b className="inkstrong">{x.name}</b> {formatCents(x.actualCents)} of {formatCents(x.budgetCents)}</span>
            ))}
          </div>
        )}
        {d.mortgage?.triggered && (
          <div className="sub2">
            🔔 30-yr average <b className="inkstrong">{pct(d.mortgage.marketRateMicro)}</b> ({d.mortgage.marketOn}) is below
            your best saved option <b className="inkstrong">{d.mortgage.bestLoanName}</b> at {pct(d.mortgage.bestLoanRateMicro)} —
            worth a look on Dream Home.
          </div>
        )}
      </div>
    </div>
  )
}
