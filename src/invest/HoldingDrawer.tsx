import { useState } from 'react'
import type { InvestAccountRow, PortfolioLot, PortfolioPosition } from '../../shared/invest-api'
import { formatCents, formatPercentMicro, formatQtyMicro } from '../../shared/money'
import type { ScopedReturn } from '../cards/cardModel'
import PriceChart from '../cards/PriceChart'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import ActivityTable from './ActivityTable'
import { shortDay } from './balanceMath'
import { dayAmount, dayChange, dayPercent, priceDay, toneOf } from './dayMath'
import { rateWords } from './HoldingsCard'
import HoldingsTable from './HoldingsTable'
import { perShareCents } from './lotMath'
import { PriceControl } from './SetPrice'
import './invest.css'

export type HoldingDrawerProps = {
  /** The holding shown, as the screen's accounts hold it; null closes the drawer (it keeps the last one through the exit). */
  position: PortfolioPosition | null
  /** Its row of return by holding, when loaded. */
  ret: ScopedReturn | undefined
  /** What every holding in view is worth together: the share's denominator. */
  portfolioValue: number
  /** Every investment account (the activity rows' names and kinds). */
  accounts: readonly InvestAccountRow[]
  /** The accounts in view (the owner pills); omit for every account. */
  scope?: ReadonlySet<number>
  scopeLabel?: string
  rev: number
  today: string
  marginal: { stMicro: number; ltMicro: number } | null
  onClose: () => void
  /** After anything here changes data (the screen reloads). */
  onChanged: () => void
  /** Record a trade — in this holding's first account, or a sale of the lot given. */
  onRecordTrade: (accountId: number, lot?: PortfolioLot) => void
}

const KIND = { stock: 'Stock or fund', crypto: 'Crypto' } as const

/**
 * One holding, opened from its row: the price and what it did today, the
 * position's own numbers, its price chart with the household's trades
 * marked, then the accounts and lots that make it up (with Sell…) and its
 * trades. Everything a row of the table can only hint at.
 */
export default function HoldingDrawer(p: HoldingDrawerProps) {
  // Through the exit animation the drawer keeps showing the holding it had.
  const [kept, setKept] = useState<PortfolioPosition | null>(p.position)
  if (p.position && p.position !== kept) setKept(p.position)
  const h = p.position ?? kept
  if (!h) return null

  const perShare = priceDay(h)
  const day = dayChange(h.day_change_cents, h.value_cents)
  const words = p.ret ? rateWords(p.ret) : null
  const subtitle = [KIND[h.kind], `${formatQtyMicro(h.qty_micro)} held`, h.accounts.length > 1 ? `${h.accounts.length} accounts` : h.accounts[0]?.name, p.scopeLabel]
    .filter(Boolean)
    .join(' · ')
  const totals = { value: h.value_cents, cost: h.cost_cents, unrealized: h.unrealized_cents, cash: 0, day_change: 0, day_base: 0, ytd_st: 0, ytd_lt: 0, ytd_sheltered: 0, ytd_reported_st: 0, ytd_reported_lt: 0 }

  return (
    <Drawer open={p.position !== null} onClose={p.onClose} width={820} title={h.symbol} subtitle={subtitle}>
      <div className="inv-dsum">
        <div className="inv-dsum-main">
          <span className="inv-dsum-label">Price</span>
          <span className="inv-dsum-v inv-hd-price">
            <PriceControl p={h} today={p.today} onSaved={p.onChanged} />
          </span>
          <span className="inv-dsum-sub">
            {perShare ? (
              <span className={`inv-hd-day ${toneOf(perShare.cents)}`}>
                {dayAmount(perShare.cents)}
                {perShare.micro !== null && ` (${dayPercent(perShare.micro)})`}
              </span>
            ) : null}
            {h.priced_on ? (
              <span>
                {perShare ? (h.kind === 'crypto' ? 'in 24 hours · ' : 'since the previous close · ') : ''}as of {h.priced_on === p.today ? 'today' : shortDay(h.priced_on, p.today)}
              </span>
            ) : (
              <span>valued at cost until it has a price</span>
            )}
          </span>
        </div>
        <dl className="inv-dsum-stats">
          <div>
            <dt>Value</dt>
            <dd>
              {formatCents(h.value_cents)}
              {p.portfolioValue > 0 && (
                <span className="inv-subline">{formatPercentMicro(Math.round((h.value_cents * 1_000_000) / p.portfolioValue), 1)} of holdings</span>
              )}
            </dd>
          </div>
          {day && (
            <div>
              <dt>Day</dt>
              <dd className={toneOf(day.cents)}>
                {dayAmount(day.cents)}
                {day.micro !== null && <span className="inv-subline inv-subtone">{dayPercent(day.micro)}</span>}
              </dd>
            </div>
          )}
          <div>
            <dt>Unrealized</dt>
            <dd className={h.price_cents !== null ? toneOf(h.unrealized_cents) : undefined}>
              {h.price_cents !== null ? formatCents(h.unrealized_cents, { sign: h.unrealized_cents > 0 }) : '—'}
              {h.price_cents !== null && h.cost_cents > 0 && (
                <span className="inv-subline inv-subtone">{formatPercentMicro(Math.round((Math.abs(h.unrealized_cents) * 1_000_000) / h.cost_cents), 1)} of cost</span>
              )}
            </dd>
          </div>
          {words && (
            <div>
              <dt>Return</dt>
              <dd className={toneOf(p.ret?.irr_micro ?? 0)}>
                {words.rate}
                <span className="inv-subline">{words.sub}</span>
              </dd>
            </div>
          )}
          <div>
            <dt>Cost basis</dt>
            <dd>
              {formatCents(h.cost_cents)}
              <span className="inv-subline">{formatCents(perShareCents(h.cost_cents, h.qty_micro))}/sh average</span>
            </dd>
          </div>
        </dl>
      </div>

      <section className="inv-hd-section" aria-label={`${h.symbol} price history`}>
        <PriceChart symbol={h.symbol} rev={p.rev} />
      </section>

      <section className="inv-hd-section">
        <div className="inv-paneltools">
          <h3 className="inv-hd-h3">Accounts and lots</h3>
          <span className="inv-rowactions">
            <Button size="mini" variant="gold" onClick={() => h.accounts[0] && p.onRecordTrade(h.accounts[0].invest_account_id)}>
              + Record trade
            </Button>
          </span>
        </div>
        <HoldingsTable variant="lots" positions={[h]} totals={totals} marginal={p.marginal} today={p.today} onSell={(lot) => p.onRecordTrade(lot.invest_account_id, lot)} />
      </section>

      <section className="inv-hd-section">
        <h3 className="inv-hd-h3">Trades</h3>
        <ActivityTable accounts={p.accounts} variant="plain" symbol={h.symbol} scope={p.scope} rev={p.rev} today={p.today} onChanged={p.onChanged} />
      </section>
    </Drawer>
  )
}
