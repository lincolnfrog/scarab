import { useEffect, useState } from 'react'
import { formatCents, formatDollars, formatQtyMicro } from '../shared/money'
import { get, post } from './api'
import { DriverBars, type DriverRow } from './chart/DriverBars'
import { monthLong, shortDay } from './chart/format'
import { todayLocal } from '../shared/dates'
import { Link, type RouteTarget } from './router'
import { Button } from './ui/Button'
import { DrillCard } from './ui/Drill'
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
  allocationVsTarget?: boolean
  budgetOverruns: { name: string; budgetCents: number; actualCents: number }[]
  mortgage: null | { marketRateMicro: number; marketOn: string; bestLoanName: string; bestLoanRateMicro: number; triggered: boolean }
  vestsDue?: { grantId: number; accountId: number; accountName: string; symbol: string; dueOn: string; qtyMicro: number | null }[]
  notable: boolean
  errors: string[]
}

const pct = (micro: number) => `${(micro / 10_000).toFixed(1)}%`
const pp = (micro: number) => `${micro > 0 ? '+' : ''}${(micro / 10_000).toFixed(1)}pp`
const CLASS_LABEL: Record<string, string> = {
  cash: 'Cash', brokerage: 'Brokerage', retirement: 'Retirement', crypto: 'Crypto',
  property: 'Property', liabilities: 'Loans', credit: 'Credit cards',
  // asset classes, when drift is against the target (engine/allocation.ts)
  us_stock: 'US stocks', intl_stock: 'International', bonds: 'Bonds', real_estate: 'REITs', other: 'Other',
}
/** Where each net-worth class lives, for the driver links. */
const CLASS_SCREEN: Record<string, RouteTarget> = {
  cash: { screen: 'cash' }, brokerage: { screen: 'invest' }, retirement: { screen: 'invest' }, crypto: { screen: 'invest' },
  property: { screen: 're' }, liabilities: { screen: 're' }, credit: { screen: 'cash' },
}

/**
 * "Since you were last here": what moved net worth (diverging driver bars,
 * each linked to where the number lives), new and uncategorized transactions
 * (linked to Cash & budget's list filtered to uncategorized), recurring-
 * charge changes, drift, overruns (linked to the budget) and the
 * mortgage-rate trigger (linked to the loan sheets). Renders nothing unless
 * something is notable.
 */
function useDigest(): Digest | null {
  const [digest, setDigest] = useState<Digest | null>(null)
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
  return digest
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The digest in one card, for the Dashboard's overview: how far net worth
 * moved, and a count of everything else worth a look. The card opens the
 * whole digest (`to`, a detail view). Renders nothing unless something is notable.
 */
export function DigestSummary({ to, span }: { to: string; span?: string }) {
  const d = useDigest()
  if (!d || !d.notable) return null
  const nw = d.netWorth && d.netWorth.deltaCents !== 0 ? d.netWorth : null
  const bits = [
    (d.vestsDue ?? []).length > 0 && count(d.vestsDue!.length, 'vest') + ' to record',
    d.newTx.count > 0 && count(d.newTx.count, 'new transaction'),
    d.newTx.uncategorized > 0 && `${d.newTx.uncategorized} uncategorized`,
    d.newRecurring.length > 0 && count(d.newRecurring.length, 'new recurring charge'),
    d.priceCreep.length > 0 && count(d.priceCreep.length, 'price increase'),
    d.lapsed.length > 0 && count(d.lapsed.length, 'missed charge'),
    d.allocationDrift.length > 0 && (d.allocationVsTarget ? count(d.allocationDrift.length, 'class', 'classes') + ' off target' : 'allocation drift'),
    d.budgetOverruns.length > 0 && count(d.budgetOverruns.length, 'budget') + ' over',
    d.mortgage?.triggered && 'mortgage rates dipped',
  ].filter((x): x is string => typeof x === 'string')
  return (
    <DrillCard
      to={to}
      span={span}
      title="Since you were last here"
      badge={shortDay(d.sinceDay, todayLocal())}
      tone={nw ? (nw.deltaCents >= 0 ? 'pos' : 'neg') : undefined}
      value={
        nw ? (
          <>
            <span aria-hidden="true">{nw.deltaCents >= 0 ? '▲' : '▼'} </span>
            <span className="ui-sr">{nw.deltaCents >= 0 ? 'Net worth up' : 'Net worth down'} </span>
            {formatDollars(Math.abs(nw.deltaCents))}
          </>
        ) : undefined
      }
      note={
        <>
          {nw && <>net worth since {monthLong(nw.baselineMonth)}</>}
          {nw && bits.length > 0 && <br />}
          {bits.join(' · ')}
        </>
      }
    />
  )
}

export default function DigestCard({ onCaughtUp }: { onCaughtUp?: () => void } = {}) {
  const digest = useDigest()
  const [gone, setGone] = useState(false)

  const ack = useAction(() => post('/api/digest/ack', {}), {
    errorPrefix: "Couldn't mark the digest as caught up",
    onDone: () => {
      setGone(true)
      onCaughtUp?.()
    },
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
          {(d.vestsDue ?? []).length > 0 && (
            <div className="sub2">
              Vest{d.vestsDue!.length > 1 ? 's' : ''} to record:{' '}
              {d.vestsDue!.map((v, i) => (
                <span key={v.grantId}>
                  {i > 0 && ' · '}
                  {/* The account's Grants tab, where Vest… records it from the release. */}
                  <Link to={{ screen: 'invest', params: { d: 'account', acct: v.accountId, tab: 'grants' } }} className="ch-a">
                    <b className="inkstrong">{v.symbol}</b>
                    {v.qtyMicro !== null && <> {formatQtyMicro(v.qtyMicro)} sh</>} vested {shortDay(v.dueOn, todayLocal())} in {v.accountName} →
                  </Link>
                </span>
              ))}
            </div>
          )}
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
              {d.allocationVsTarget ? 'Off target:' : 'Allocation drift:'}{' '}
              {d.allocationDrift.map((x, i) => (
                <span key={x.name}>
                  {i > 0 && ' · '}
                  <b className="inkstrong">{CLASS_LABEL[x.name] ?? x.name}</b>{' '}
                  {d.allocationVsTarget ? `${pct(x.nowMicro)} vs ${pct(x.thenMicro)} target` : `${pct(x.thenMicro)} → ${pct(x.nowMicro)}`} ({pp(x.deltaMicro)})
                </span>
              ))}
              {d.allocationVsTarget && (
                <>
                  {' '}—{' '}
                  <Link to={{ screen: 'invest', rest: ['allocation'] }} className="ch-a">
                    see the rebalance plan →
                  </Link>
                </>
              )}
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
