import { formatCents, formatQtyMicro } from '../../shared/money'
import '../invest/invest.css'
import { Tooltip } from '../ui/Tooltip'
import type { TaxResponse } from './types'

export type HarvestCardProps = {
  harvest: TaxResponse['harvest']
  /** Marginal short- and long-term rates: what waiting for long-term saves on a gain. */
  marginal: Pick<TaxResponse['marginal'], 'stMicro' | 'ltMicro'>
}

type HarvestRow = TaxResponse['harvest']['rows'][number]

const WASH_RECENT =
  'A buy of this stock in the last 30 days — in any account, IRAs and your partner’s included — would disallow the loss (wash sale). Vests count as buys.'
const washUpcoming = (r: HarvestRow) =>
  r.wash_upcoming
    ? `${formatQtyMicro(r.wash_upcoming.qty_micro)} shares vest in ${r.wash_upcoming.account} on ${r.wash_upcoming.vest_on}. A vest within 30 days after the sale is a buy, and would disallow the loss (wash sale).`
    : ''

/**
 * Loss harvesting (Taxes): open lots in taxable accounts under water at
 * today's prices, with the account that holds each, the tax it would save,
 * wash-sale flags (a recent buy anywhere, or a vest coming up), and
 * short-term gain lots close enough to long-term that waiting pays. IRA,
 * Roth and 401(k) lots never appear: a sale inside them isn't taxed.
 */
export default function HarvestCard({ harvest, marginal }: HarvestCardProps) {
  const losses = harvest.rows.filter((r) => r.gain_cents < 0)
  const nearLt = harvest.rows.filter((r) => r.gain_cents > 0 && r.term === 'st' && r.days_to_lt <= 90)
  const upcoming = losses.filter((r) => r.wash_upcoming)
  return (
    <div className="card c6 inv-taxcard" style={losses.length === 0 ? { alignSelf: 'start' } : undefined}>
      <h2>Loss harvesting</h2>
      {losses.length === 0 ? (
        <p className="sub2">
          No open lot in a taxable account is under water at today's prices — nothing to harvest. Short-term gain lots
          approaching long-term status will appear here as they get close.
        </p>
      ) : (
        <>
          <div className="sub2" style={{ marginBottom: 8 }}>
            Harvestable: <b className="inkstrong">{formatCents(harvest.totals.harvestableStCents + harvest.totals.harvestableLtCents)}</b>{' '}
            in losses · est. tax saved <b className="inkstrong">{formatCents(harvest.totals.estTaxSavedCents)}</b>
            {harvest.totals.washFlagged > 0 && <> · ⚠ {harvest.totals.washFlagged} wash-sale risk{harvest.totals.washFlagged > 1 ? 's' : ''}</>}
          </div>
          {/* The lot's date and account ride under its symbol, its term under the loss, so the table fits a half-width card; it scrolls in place if it still can't. */}
          <div className="inv-tablewrap">
            <table className="inv-harvest">
              <thead>
                <tr>
                  <th>Lot</th><th className="r">Qty</th><th className="r">Value</th><th className="r">Loss</th><th className="r">Tax saved</th>
                </tr>
              </thead>
              <tbody>
                {losses.map((l, i) => {
                  const why = [l.wash_risk ? WASH_RECENT : '', washUpcoming(l)].filter(Boolean).join(' ')
                  return (
                    <tr key={`${l.account_id}-${l.symbol}-${l.trade_id ?? i}`}>
                      <td>
                        <span className="tk"><span className="lg">{l.symbol}</span></span>
                        {why && (
                          <Tooltip content={why}>
                            <span className="muted"> ⚠</span>
                          </Tooltip>
                        )}
                        <span className="inv-subline inv-harvest-lot">
                          {l.opened_on} · {l.account}
                        </span>
                      </td>
                      <td className="r num">{formatQtyMicro(l.qty_micro)}</td>
                      <td className="r num">{formatCents(l.value_cents)}</td>
                      <td className="r num neg">
                        {formatCents(l.gain_cents)}
                        <span className="inv-subline">{l.term === 'lt' ? 'long-term' : 'short-term'}</span>
                      </td>
                      <td className="r num pos">{formatCents(-l.tax_delta_cents)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {upcoming.length > 0 && (
            <div className="sub2 topline">
              ⚠ Vest coming up:{' '}
              {[...new Map(upcoming.map((r) => [r.symbol, r.wash_upcoming!])).entries()].map(([sym, v]) => (
                <span key={sym} style={{ marginRight: 10 }}>
                  <b className="inkstrong">{sym}</b> vests {v.vest_on} in {v.account}
                </span>
              ))}
              — selling these at a loss now would be a wash sale (the loss is deferred into the new shares). Harvest
              more than 30 days after the vest to keep it.
            </div>
          )}
        </>
      )}
      {nearLt.length > 0 && (
        <div className="sub2 topline">
          Almost long-term:{' '}
          {nearLt
            .sort((a, b) => a.days_to_lt - b.days_to_lt)
            .slice(0, 4)
            .map((l, i) => (
              <span key={`${l.account_id}-${l.symbol}-${l.trade_id ?? i}`} style={{ marginRight: 10 }}>
                <b className="inkstrong">{l.symbol}</b> {l.opened_on} · long-term {l.lt_on} ({l.days_to_lt}d) → saves{' '}
                {formatCents(Math.round((l.gain_cents * (marginal.stMicro - marginal.ltMicro)) / 1_000_000))}
              </span>
            ))}
        </div>
      )}
    </div>
  )
}
