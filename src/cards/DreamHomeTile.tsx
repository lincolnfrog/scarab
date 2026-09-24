import { formatDollars } from '../../shared/money'
import type { GoalDerived } from '../../shared/types'
import { CountUp } from '../chart/CountUpText'
import { fmtAxis, monthLong } from '../chart/format'
import { useGrow } from '../chart/useGrow'
import { Link } from '../router'
import '../chart/chart.css'

/**
 * The Dashboard's Dream-home tile (mockup c5): the fund against the cash to
 * close, a gold progress bar, and the ETA at the monthly plan — every number
 * straight from GET /api/goal's `derived`, so it can't drift from the Dream
 * Home screen. Until any account is counted as the fund, it says how to start.
 */
export default function DreamHomeTile({ derived: d, setUp, span }: { derived: GoalDerived; setUp: boolean; span: 'c5' | 'c12' }) {
  // Floor, so the bar and the words never claim a percent the fund hasn't reached.
  const pct = Math.min(100, Math.max(0, Math.floor(d.pctMicro / 10_000)))
  const funded = d.remainingCents === 0
  const plan = d.monthlyPlanCents > 0 ? `${fmtAxis(d.monthlyPlanCents, 'cents')}/mo` : null
  // The bar fills alongside the count-up, on the first reveal only.
  const grow = useGrow(setUp, 1)
  return (
    <div className={`card ${span} ch-dream`}>
      <h2>Dream home fund</h2>
      {setUp ? (
        <>
          <div className="ch-dream-row">
            <CountUp className="ch-dream-v" value={d.fundCents} format={formatDollars} />
            <span className="muted">of {formatDollars(d.targetCents)}</span>
          </div>
          <div className="pbar" role="progressbar" aria-label="Dream home fund" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <i className={grow ? 'ch-growing' : undefined} style={{ width: `${pct}%` }} />
          </div>
          <div className="sub2">
            {funded ? (
              <>Fully funded — the cash to close is in hand</>
            ) : d.etaMonth && plan ? (
              <>
                {pct}% funded · on pace for <b className="inkstrong">{monthLong(d.etaMonth)}</b> at {plan}
              </>
            ) : plan ? (
              <>
                {pct}% funded · more than a century away at {plan}
              </>
            ) : (
              <>{pct}% funded · set a monthly plan to see when it lands</>
            )}
          </div>
        </>
      ) : (
        <p className="sub2 ch-dream-empty">
          Pick the accounts that hold the down payment and Scarab tracks the fund here: {formatDollars(d.targetCents)} to close, and
          when your monthly plan gets you there.
        </p>
      )}
      <Link to={{ screen: 'goal' }} className="btn gold ch-dream-cta">
        {setUp ? 'Open goal →' : 'Set up the fund →'}
      </Link>
    </div>
  )
}
