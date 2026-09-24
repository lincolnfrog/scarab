import { useEffect, useState } from 'react'
import { formatCents, formatDollars } from '../shared/money'
import { get, post } from './api'
import { DriverBars, type DriverRow } from './chart/DriverBars'
import { monthLong, shortDay } from './chart/format'
import { todayLocal } from '../shared/dates'
import { Link, type RouteTarget } from './router'
import { Button } from './ui/Button'
import { useAction } from './ui/useAction'
import './chart/chart.css'

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
/** Where each net-worth class lives, for the driver links. */
const CLASS_SCREEN: Record<string, RouteTarget> = {
  cash: { screen: 'cash' }, brokerage: { screen: 'invest' }, retirement: { screen: 'invest' }, crypto: { screen: 'invest' },
  property: { screen: 're' }, liabilities: { screen: 're' },
}

/**
 * "Since you were last here": what moved net worth (diverging driver bars,
 * each linked to where the number lives), new and uncategorized transactions
 * (linked to Cash & budget's list filtered to uncategorized), recurring-
 * charge changes, drift, overruns (linked to the budget) and the
 * mortgage-rate trigger (linked to the loan sheets). Renders nothing unless
 * something is notable.
 */
export default function DigestCard() {
  const [digest, setDigest] = useState<Digest | null>(null)
  const [gone, setGone] = useState(false)

  useEffect(() => {
    let live = true
    // Optional: a failed digest just stays out of the way.
    get<Digest>('/api/digest')
      .then((d) => live && setDigest(d))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const ack = useAction(() => post('/api/digest/ack', {}), {
    errorPrefix: "Couldn't mark the digest as caught up",
    onDone: () => setGone(true),
  })

  if (gone || !digest || !digest.notable) return null
  const d = digest
  const nw = d.netWorth && d.netWorth.deltaCents !== 0 ? d.netWorth : null
  const drivers: DriverRow[] = (nw?.drivers ?? []).map((x) => ({
    id: x.name,
    name: CLASS_LABEL[x.name] ?? x.name,
    cents: x.deltaCents,
    to: CLASS_SCREEN[x.name],
  }))

  return (
    <div className="card c12">
      <div className="h4row">
        <h2>
          Since you were last here <span className="muted">· {shortDay(d.sinceDay, todayLocal())}</span>
        </h2>
        <div className="right">
          <Button size="mini" busy={ack.busy} onClick={() => void ack.run()} title="Start the next digest from now">
            Caught up ✓
          </Button>
        </div>
      </div>
      <div className="ch-digest">
        {nw && (
          <div className="ch-digest-nw">
            <div className="sub2">
              Net worth{' '}
              <b className={`inkstrong ${nw.deltaCents >= 0 ? 'pos' : 'neg'}`}>
                <span aria-hidden="true">{nw.deltaCents >= 0 ? '▲' : '▼'} </span>
                <span className="ui-sr">{nw.deltaCents >= 0 ? 'up' : 'down'} </span>
                {formatDollars(Math.abs(nw.deltaCents))}
              </b>{' '}
              since {monthLong(nw.baselineMonth)}
              {drivers.length > 0 && <> — mostly:</>}
            </div>
            <DriverBars
              rows={drivers}
              tipTitle={`Change since ${monthLong(nw.baselineMonth)}`}
              ariaLabel={`What moved net worth since ${monthLong(nw.baselineMonth)}`}
            />
          </div>
        )}
        <div className="ch-digest-list">
          {d.newTx.count > 0 && (
            <div className="sub2">
              <b className="inkstrong">{d.newTx.count}</b> new transaction{d.newTx.count > 1 ? 's' : ''} imported
              {d.newTx.uncategorized > 0 && (
                <>
                  {' '}
                  ·{' '}
                  {/* Cash reads its category filter from `cat` ('uncat' = uncategorized; src/screens/cash-route.ts); the path scrolls to the list. */}
                  <Link to={{ screen: 'cash', rest: ['transactions'], params: { cat: 'uncat' } }} className="ch-a">
                    <b className="inkstrong">{d.newTx.uncategorized}</b> still uncategorized →
                  </Link>
                </>
              )}
            </div>
          )}
          {d.newRecurring.length > 0 && (
            <div className="sub2">
              New recurring charge{d.newRecurring.length > 1 ? 's' : ''}:{' '}
              {d.newRecurring.slice(0, 4).map((r, i) => (
                <span key={r.merchant}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{r.merchant}</b> ≈{formatCents(r.typicalCents)}/{r.cadence.replace('ly', '')}
                </span>
              ))}
            </div>
          )}
          {d.priceCreep.length > 0 && (
            <div className="sub2">
              Price creep:{' '}
              {d.priceCreep.slice(0, 4).map((r, i) => (
                <span key={r.merchant}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{r.merchant}</b> {formatCents(r.typicalCents)} → {formatCents(r.lastCents)} (+{pct(r.priceCreepMicro)})
                </span>
              ))}
            </div>
          )}
          {d.lapsed.length > 0 && (
            <div className="sub2">
              Possibly cancelled or missed:{' '}
              {d.lapsed.slice(0, 4).map((r, i) => (
                <span key={r.merchant}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{r.merchant}</b> (expected {shortDay(r.nextExpectedOn, todayLocal())})
                </span>
              ))}
            </div>
          )}
          {d.allocationDrift.length > 0 && (
            <div className="sub2">
              Allocation drift:{' '}
              {d.allocationDrift.map((x, i) => (
                <span key={x.name}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{CLASS_LABEL[x.name] ?? x.name}</b> {pct(x.thenMicro)} → {pct(x.nowMicro)} ({pp(x.deltaMicro)})
                </span>
              ))}
            </div>
          )}
          {d.budgetOverruns.length > 0 && (
            <div className="sub2">
              Over budget this month:{' '}
              {d.budgetOverruns.map((x, i) => (
                <span key={x.name}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{x.name}</b> {formatCents(x.actualCents)} of {formatCents(x.budgetCents)}
                </span>
              ))}{' '}
              —{' '}
              <Link to={{ screen: 'cash', rest: ['budget'] }} className="ch-a">
                see the budget →
              </Link>
            </div>
          )}
          {d.mortgage?.triggered && (
            <div className="sub2">
              The 30-yr average <b className="inkstrong">{pct(d.mortgage.marketRateMicro)}</b> ({shortDay(d.mortgage.marketOn, todayLocal())}) is
              below your best saved option <b className="inkstrong">{d.mortgage.bestLoanName}</b> at {pct(d.mortgage.bestLoanRateMicro)} —{' '}
              <Link to={{ screen: 'goal', rest: ['loans'] }} className="ch-a">
                compare the loan sheets →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
