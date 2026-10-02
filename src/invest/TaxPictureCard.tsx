import { netCapitalGains } from '../../shared/capgains'
import type { PortfolioResponse } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { Link } from '../router'
import './invest.css'

export type TaxPictureProps = {
  totals: PortfolioResponse['totals']
  /** The household's marginal rates from /api/tax; null while unknown. */
  marginal: { ordinaryMicro: number; stMicro: number; ltMicro: number } | null
  year: string
  /** The screen is narrowed to some accounts ("Max’s accounts"): this card still speaks for the household. */
  scope?: string | null
  /** The loss carried in from last year's return (Taxes' settings), positive cents; null while unknown. */
  carryIn?: { stCents: number; ltCents: number } | null
}

const rate = (cents: number, micro: number) => Math.round((cents * micro) / 1_000_000)

/**
 * This year's realized gains from taxable accounts, netted the way the return
 * nets them (short against long, then up to $3,000 of a net loss against
 * ordinary income), with the estimated tax at the household's marginal rates.
 * Gains realized inside IRAs and 401(k)s are shown apart: they never reach
 * the bill. Realized gains brokers report for balance-tracked accounts are in
 * the totals (and said so), and last year's carryover nets in by character.
 * A strip of figures across the screen — Taxes has the detail.
 */
export default function TaxPictureCard({ totals, marginal, year, scope, carryIn }: TaxPictureProps) {
  const cSt = carryIn?.stCents ?? 0
  const cLt = carryIn?.ltCents ?? 0
  const st = totals.ytd_st - cSt
  const lt = totals.ytd_lt - cLt
  const n = netCapitalGains(st, lt)
  const netted = n.netStCents !== st || n.netLtCents !== lt
  const reported = (c: number) => (c !== 0 ? ` · incl. ${formatCents(c, { sign: c > 0 })} reported by the broker` : '')
  const netLoss = n.capLossUsedCents + n.capLossCarryCents
  const estTax = marginal
    ? rate(n.netStCents, marginal.stMicro) + rate(n.netLtCents, marginal.ltMicro) - rate(n.capLossUsedCents, marginal.ordinaryMicro)
    : null

  return (
    <div className="card c12 inv-taxcard">
      <div className="h4row">
        <h2>Tax picture · {year}</h2>
        <span className="sub2">
          <Link to={{ screen: 'tax' }}>Taxes</Link> has the full picture — withholding gap, harvesting, quarterlies
        </span>
      </div>
      {scope && <p className="inv-scopenote">The whole household’s, not only {scope}: every taxable account’s gains and losses meet on the return.</p>}
      <div className="inv-taxpic">
        <div className="inv-row">
          <span>Realized short-term, taxable accounts (ordinary rates){reported(totals.ytd_reported_st)}</span>
          <b>{formatCents(totals.ytd_st, { sign: totals.ytd_st > 0 })}</b>
        </div>
        <div className="inv-row">
          <span>Realized long-term, taxable accounts (cap-gains rates){reported(totals.ytd_reported_lt)}</span>
          <b>{formatCents(totals.ytd_lt, { sign: totals.ytd_lt > 0 })}</b>
        </div>
        {cSt + cLt > 0 && (
          <div className="inv-row">
            <span>Loss carried in from {Number(year) - 1}</span>
            <b>{formatCents(-(cSt + cLt))}</b>
          </div>
        )}
        {netted && netLoss === 0 && (
          <div className="inv-row">
            <span>After netting{cSt + cLt > 0 ? '' : ' short against long'}</span>
            <b>
              {n.netStCents !== 0 ? `${formatCents(n.netStCents)} ST` : `${formatCents(n.netLtCents)} LT`}
            </b>
          </div>
        )}
        {netLoss > 0 && (
          <div className="inv-row">
            <span>
              Net capital loss: {formatCents(n.capLossUsedCents)} offsets ordinary income this year
              {n.capLossCarryCents > 0 && `, ${formatCents(n.capLossCarryCents)} carries forward`}
            </span>
            <b>{formatCents(-netLoss)}</b>
          </div>
        )}
        {estTax !== null && (
          <div className="inv-row">
            <span>{estTax >= 0 ? 'Est. tax on realized gains so far' : 'Est. tax saved by realized losses so far'}</span>
            <b>{formatCents(Math.abs(estTax))}</b>
          </div>
        )}
        {totals.ytd_sheltered !== 0 && (
          <div className="inv-row">
            <span>Realized inside tax-advantaged accounts — not taxed</span>
            <b>{formatCents(totals.ytd_sheltered, { sign: totals.ytd_sheltered > 0 })}</b>
          </div>
        )}
      </div>
    </div>
  )
}
