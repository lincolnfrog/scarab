import { useState, type ReactNode } from 'react'
import type { InvestKind, PortfolioLot, PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { formatCents, formatPercentMicro, formatQtyMicro } from '../../shared/money'
import { Button } from '../ui/Button'
import { Tooltip } from '../ui/Tooltip'
import { lotTerm, lotValueCents, perShareCents, saleEstimate } from './lotMath'
import PriceCell from './SetPrice'
import './invest.css'

export type HoldingsTableProps = {
  positions: PortfolioPosition[]
  totals: PortfolioResponse['totals']
  /** Marginal ST/LT rates from the tax picture; null while unknown. */
  marginal: { stMicro: number; ltMicro: number } | null
  today: string
  onSell: (lot: PortfolioLot, position: PortfolioPosition) => void
  /** Asset ids to show expanded at first. */
  defaultOpen?: readonly number[]
  /** When given, a missing, stale or hand-entered price can be set from its cell; called after a save. */
  onPriceSaved?: () => void
  /**
   * 'card' (default): the Holdings card, symbols expanding to accounts, then lots.
   * 'plain': the table alone for one account (its drawer) — a symbol expands straight to its lots.
   */
  variant?: 'card' | 'plain'
  /**
   * A Cash row under the holdings — an account's derived cash, or every
   * anchored account's — which the Total then includes (cost basis and
   * unrealized stay the holdings'). Omit when no cash balance is recorded.
   */
  cash?: { cents: number; note?: string } | null
}

const KIND_LABEL: Record<InvestKind, string> = { brokerage: 'taxable', retirement: 'tax-advantaged', crypto: 'crypto' }

/**
 * Holdings, one row per symbol. Expanding a symbol shows each account that
 * holds it (lots pool per account), and under each account its open lots with
 * their holding period and what selling them today would mean for tax.
 */
export default function HoldingsTable({ positions, totals, marginal, today, onSell, defaultOpen, onPriceSaved, variant = 'card', cash }: HoldingsTableProps) {
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(defaultOpen))
  const toggle = (assetId: number) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(assetId)) n.delete(assetId)
      else n.add(assetId)
      return n
    })

  const table = (
    <table className="inv-holdings">
      <thead>
        <tr>
          <th>Asset</th><th className="r">Qty</th><th className="r">Price</th>
          {/* Cost basis rides under the value and the percent under the gain, so the table fits a two-thirds card at 1100. */}
          <th className="r">Value<span className="inv-thsub">cost basis</span></th>
          <th className="r">Unrealized<span className="inv-thsub">% of cost</span></th>
        </tr>
      </thead>
      <tbody>
        {positions.flatMap((p) => {
          const isOpen = open.has(p.asset_id)
          const rows: ReactNode[] = [
            <tr key={p.asset_id}>
              <td>
                <span className="tk">
                  <button
                    type="button"
                    className="inv-toggle"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Hide' : 'Show'} ${p.symbol} ${variant === 'plain' ? 'lots' : 'accounts and lots'}`}
                    onClick={() => toggle(p.asset_id)}
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                  <span className="lg">{p.symbol}</span>
                  {p.accounts.length > 1 && <span className="muted inv-nw">{p.accounts.length} accounts</span>}
                </span>
              </td>
              <td className="r num">{formatQtyMicro(p.qty_micro)}</td>
              {onPriceSaved ? (
                <PriceCell p={p} today={today} onSaved={onPriceSaved} />
              ) : (
                <td className="r num">
                  {p.price_cents !== null ? formatCents(p.price_cents) : <span className="muted">no price yet</span>}
                </td>
              )}
              <ValueCell value={p.value_cents} cost={p.cost_cents} />
              <Unrealized unrealized={p.unrealized_cents} cost={p.cost_cents} priced={p.price_cents !== null} />
            </tr>,
          ]
          if (!isOpen) return rows
          for (const a of p.accounts) {
            if (variant === 'plain' && p.accounts.length === 1) {
              p.lots.forEach((l, i) => rows.push(<LotRow key={`${p.asset_id}-l${l.trade_id ?? `i${i}`}`} lot={l} p={p} marginal={marginal} today={today} onSell={onSell} />))
              continue
            }
            rows.push(
              <tr key={`${p.asset_id}-a${a.invest_account_id}`} className="inv-acctrow">
                <td>
                  <span className="inv-acct">
                    {a.name} <span className="inv-tag inv-quiet">{KIND_LABEL[a.kind]}</span>
                  </span>
                </td>
                <td className="r num">{formatQtyMicro(a.qty_micro)}</td>
                <td />
                <ValueCell value={a.value_cents} cost={a.cost_cents} />
                <Unrealized unrealized={a.value_cents - a.cost_cents} cost={a.cost_cents} priced={p.price_cents !== null} />
              </tr>,
            )
            p.lots
              .filter((l) => l.invest_account_id === a.invest_account_id)
              .forEach((l, i) => rows.push(<LotRow key={`${p.asset_id}-l${a.invest_account_id}-${l.trade_id ?? `i${i}`}`} lot={l} p={p} marginal={marginal} today={today} onSell={onSell} />))
          }
          return rows
        })}
        {cash && (
          <tr className="inv-cashrow">
            <td>
              <span className="inv-cashlabel">Cash</span>
              {cash.note && <span className="inv-subline">{cash.note}</span>}
            </td>
            <td />
            <td />
            <td className="r num">
              <span className={cash.cents < 0 ? 'inv-shortcash' : undefined}>{formatCents(cash.cents)}</span>
            </td>
            <td />
          </tr>
        )}
        <tr>
          <td className="strong">Total</td>
          <td />
          <td />
          <ValueCell value={totals.value + (cash?.cents ?? 0)} cost={totals.cost} strong />
          <td className={`r num strong${totals.unrealized > 0 ? ' pos' : totals.unrealized < 0 ? ' neg' : ''}`}>
            {formatCents(totals.unrealized, { sign: totals.unrealized > 0 })}
            {totals.cost > 0 && <span className="inv-subline inv-subtone">{pctOfCost(totals.unrealized, totals.cost)}</span>}
          </td>
        </tr>
      </tbody>
    </table>
  )
  if (variant === 'plain') return <div className="inv-tablewrap">{table}</div>
  return (
    <div className="card c8">
      <h2>Holdings</h2>
      {/* It fits the card from 1100 up; narrower than that it scrolls inside the card rather than spill past its edge. */}
      <div className="inv-tablewrap">{table}</div>
    </div>
  )
}

/** |gain| as a whole percent of cost — unsigned: the arrow or sign beside it already says which way. */
const pctOfCost = (unrealized: number, cost: number) => formatPercentMicro(Math.round((Math.abs(unrealized) * 1_000_000) / cost), 0)

/** The value, and under it (the column's second header line) the cost basis. */
function ValueCell({ value, cost, strong }: { value: number; cost: number; strong?: boolean }) {
  return (
    <td className={`r num${strong ? ' strong' : ''}`}>
      {formatCents(value)}
      <span className="inv-subline">
        <span className="ui-sr">cost basis </span>
        {formatCents(cost)}
      </span>
    </td>
  )
}

/** ▲/▼ and the amount, the percent of cost under it. */
function Unrealized({ unrealized, cost, priced }: { unrealized: number; cost: number; priced: boolean }) {
  if (!priced)
    return (
      <td className="r num">
        <span className="muted">—</span>
      </td>
    )
  // Flat is neither a gain nor a loss: no arrow, no up/down colour.
  return (
    <td className={`r num${unrealized > 0 ? ' pos' : unrealized < 0 ? ' neg' : ''}`}>
      <span className="inv-nw">
        {unrealized > 0 ? '▲ ' : unrealized < 0 ? '▼ ' : ''}
        {formatCents(Math.abs(unrealized))}
      </span>
      {cost > 0 && <span className="inv-subline inv-subtone">{pctOfCost(unrealized, cost)}</span>}
    </td>
  )
}

function LotRow({ lot, p, marginal, today, onSell }: {
  lot: PortfolioLot
  p: PortfolioPosition
  marginal: HoldingsTableProps['marginal']
  today: string
  onSell: HoldingsTableProps['onSell']
}) {
  const term = lotTerm(lot, today)
  // Two unbreakable halves: in a tight table the tag breaks between them, never inside one.
  const tag: ReactNode =
    term.kind === 'sheltered' ? (
      <>
        <span className="inv-nw">tax-deferred —</span> <span className="inv-nw">no tax on sale</span>
      </>
    ) : term.kind === 'lt' ? (
      'long-term'
    ) : (
      <>
        <span className="inv-nw">short-term ·</span> <span className="inv-nw">long-term in {term.daysToLt}d</span>
      </>
    )
  let tip: string
  if (term.kind === 'sheltered') tip = `Held in ${lot.account_name}, a tax-advantaged account: selling it owes no tax now.`
  else if (p.price_cents === null || !marginal)
    tip = term.kind === 'lt' ? `Long-term since ${lot.lt_on}.` : `Short-term until ${lot.lt_on}, when it turns long-term.`
  else {
    const e = saleEstimate(lot, p.price_cents, marginal, today)
    const when = term.kind === 'lt' ? 'long-term' : `short-term; long-term from ${lot.lt_on}`
    tip =
      e.gainCents >= 0
        ? `Sold today (${when}): gain ${formatCents(e.gainCents)} → est. tax ${formatCents(e.taxCents)} → after-tax proceeds ${formatCents(e.afterTaxCents)}.`
        : `Sold today (${when}): loss ${formatCents(-e.gainCents)} → est. tax saved ${formatCents(-e.taxCents)}. Taxes checks wash sales before you harvest it.`
  }
  return (
    <tr className="inv-lotrow">
      <td>
        <span className="inv-lot">
          <span className="inv-nw">lot · {lot.opened_on}</span>
          <Tooltip content={tip}>
            <span className="inv-tag">{tag}</span>
          </Tooltip>
        </span>
      </td>
      <td className="r num muted">{formatQtyMicro(lot.qty_micro)}</td>
      <td className="r num muted">
        {formatCents(perShareCents(lot.cost_cents, lot.qty_micro))}
        <span className="inv-persh">/sh</span>
      </td>
      <td className="r num muted">
        {p.price_cents !== null ? formatCents(lotValueCents(lot.qty_micro, p.price_cents)) : '—'}
        <span className="inv-subline">
          <span className="ui-sr">cost basis </span>
          {formatCents(lot.cost_cents)}
        </span>
      </td>
      <td className="r">
        {lot.trade_id !== null && (
          <Button size="mini" title={`Sell this ${p.symbol} lot from ${lot.account_name}`} onClick={() => onSell(lot, p)}>
            Sell…
          </Button>
        )}
      </td>
    </tr>
  )
}
