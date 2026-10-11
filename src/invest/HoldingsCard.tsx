import type { MouseEvent, ReactNode } from 'react'
import type { PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { formatCents, formatPercentMicro, formatQtyMicro } from '../../shared/money'
import type { SparksResponse } from '../../shared/series-api'
import { heldText, type ScopedReturn, type ScopedReturns } from '../cards/cardModel'
import { fmtPctMicro } from '../chart/format'
import { useRouteState } from '../router'
import { Tooltip } from '../ui/Tooltip'
import { dayAmount, dayChange, dayPercent, DEFAULT_SORT, formatSort, nextSort, parseSort, sortHoldings, toneOf, totalDay, type DayChange, type HoldingSortKey } from './dayMath'
import PriceCell from './SetPrice'
import Sparkline from './Sparkline'
import './invest.css'

export type HoldingsCardProps = {
  positions: PortfolioPosition[]
  totals: PortfolioResponse['totals']
  /** Return by holding for the same accounts (GET /api/portfolio/returns, narrowed like the positions); null while loading. */
  returns: ScopedReturns | null
  /** Recent closes per asset (GET /api/portfolio/sparks); null while loading. */
  sparks: SparksResponse | null
  today: string
  /** Open a holding's drawer: its chart, lots and trades. */
  onOpen: (assetId: number) => void
  /** After a hand-set price is saved. */
  onPriceSaved: () => void
  /** A Cash row under the holdings, which the Total then includes. */
  cash?: { cents: number; note?: string } | null
  scopeLabel?: string
  /**
   * The overview's short form: only the largest `limit` holdings by value, the
   * rest folded into one line, and plain column headers (sorting lives in the full view).
   */
  limit?: number
  /** The header's right side — the overview's way into the full table. */
  more?: ReactNode
}

/** The money-weighted rate, worded by what it is: '+6.4%/yr' once held a year, else '+0.4%' over its months. */
export function rateWords(r: Pick<ScopedReturn, 'irr_micro' | 'annualized' | 'held_days'>): { rate: string; sub: string } | null {
  if (r.irr_micro === null) return null
  return r.annualized
    ? { rate: `${fmtPctMicro(r.irr_micro, { sign: true })}/yr`, sub: `held ${heldText(r.held_days)}` }
    : { rate: fmtPctMicro(r.irr_micro, { sign: true }), sub: `over ${heldText(r.held_days)}` }
}

const COLUMNS: { key: HoldingSortKey; label: string; sub?: string; className: string; tip?: string }[] = [
  { key: 'symbol', label: 'Asset', className: 'h-asset' },
  { key: 'price', label: 'Price', className: 'r h-price' },
  { key: 'day', label: 'Day', sub: 'since previous close', className: 'r h-day' },
  { key: 'value', label: 'Value', sub: 'cost basis', className: 'r h-value' },
  { key: 'unrealized', label: 'Unrealized', sub: '% of cost', className: 'r h-unr' },
  {
    key: 'return',
    label: 'Return',
    sub: 'money-weighted',
    className: 'r h-ret',
    tip: 'The yearly rate that turns what you paid, when you paid it, into what the holding is worth now. Under a year it isn’t annualized: the plain return over the months held.',
  },
]

/**
 * Holdings, one row per symbol, with how each is doing in one place: today's
 * change, value against cost, the unrealized gain and the money-weighted
 * return, beside a 90-day sparkline. Any column sorts. A row opens the
 * holding's drawer — its price chart, accounts, lots and trades.
 */
export default function HoldingsCard({ positions, totals, returns, sparks, today, onOpen, onPriceSaved, cash, scopeLabel, limit, more }: HoldingsCardProps) {
  // An enum, but it stays in route state with the screen's other view choices.
  const [sortKey, setSortKey] = useRouteState<string>('holdSort', formatSort(DEFAULT_SORT))
  const capped = limit !== undefined
  const sort = capped ? DEFAULT_SORT : parseSort(sortKey)
  const retOf = new Map((returns?.rows ?? []).map((r) => [r.asset_id, r]))
  const sparkOf = new Map((sparks?.series ?? []).map((s) => [s.asset_id, s.closes]))
  const total = totals.value
  const all = sortHoldings(
    positions.map((p) => {
      const day = dayChange(p.day_change_cents, p.value_cents)
      const ret = retOf.get(p.asset_id)
      return { ...p, day, ret, day_micro: day?.micro ?? null, irr_micro: ret?.irr_micro ?? null }
    }),
    sort,
  )
  const rows = capped ? all.slice(0, limit) : all
  const rest = all.slice(rows.length)
  const restCents = rest.reduce((s, p) => s + p.value_cents, 0)
  const dayTotal = totalDay(totals)
  const rate = returns && returns.totals.irr_micro !== null ? returns.totals : null

  // A click anywhere on the row opens the holding — except on its own controls (the price cell's button, and its
  // popover, whose clicks bubble here through React though they sit outside the row).
  const rowClick = (e: MouseEvent<HTMLTableRowElement>, assetId: number) => {
    const el = e.target as Element
    if (!e.currentTarget.contains(el) || el.closest('button, a, input, form')) return
    onOpen(assetId)
  }

  return (
    <div className="card c12 inv-holdcard">
      <div className="h4row">
        <h2>
          Holdings{scopeLabel && <span className="muted"> · {scopeLabel}</span>}
        </h2>
        {more != null ? <div className="right">{more}</div> : <span className="sub2">Select a holding for its chart, lots and trades</span>}
      </div>
      <div className="inv-tablewrap">
        <table className="inv-hold">
          <thead>
            <tr>
              {COLUMNS.map((c, i) => {
                const on = sort.key === c.key
                const button = capped ? (
                  <span>{c.label}</span>
                ) : (
                  <button type="button" className={`inv-sortbtn${on ? ' on' : ''}`} onClick={() => setSortKey(formatSort(nextSort(sort, c.key)))}>
                    {c.label}
                    <span className="inv-sortmark" aria-hidden="true">{on ? (sort.dir === 'asc' ? '▴' : '▾') : ''}</span>
                  </button>
                )
                return [
                  <th key={c.key} className={c.className} aria-sort={capped ? undefined : on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    {c.tip && !capped ? <Tooltip content={c.tip}>{button}</Tooltip> : button}
                    {c.sub && <span className="inv-thsub">{c.sub}</span>}
                  </th>,
                  // The sparkline sits between the name and the numbers; it has nothing to sort by.
                  i === 0 && (
                    <th key="spark" className="h-spark">
                      90 days
                    </th>
                  ),
                ]
              })}
              <th className="r h-share">Share</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const words = p.ret ? rateWords(p.ret) : null
              return (
                <tr key={p.asset_id} className="inv-holdrow" onClick={(e) => rowClick(e, p.asset_id)}>
                  <td className="h-asset">
                    <button type="button" className="inv-symbtn" onClick={() => onOpen(p.asset_id)} aria-label={`${p.symbol}: open its chart, lots and trades`}>
                      <span className="tk">
                        <span className="lg">{p.symbol}</span>
                      </span>
                    </button>
                    <span className="inv-subline">
                      {formatQtyMicro(p.qty_micro)}
                      {p.accounts.length > 1 && ` · ${p.accounts.length} accounts`}
                    </span>
                  </td>
                  <td className="h-spark">{sparks ? <Sparkline symbol={p.symbol} closes={sparkOf.get(p.asset_id)} from={sparks.from} to={sparks.to} /> : null}</td>
                  <PriceCell p={p} today={today} onSaved={onPriceSaved} />
                  <DayCell day={p.day} />
                  <td className="r num h-value">
                    {formatCents(p.value_cents)}
                    <span className="inv-subline">
                      <span className="ui-sr">cost basis </span>
                      {formatCents(p.cost_cents)}
                    </span>
                  </td>
                  <Gain cents={p.unrealized_cents} cost={p.cost_cents} priced={p.price_cents !== null} />
                  <td className={`r num h-ret ${words && p.ret ? toneOf(p.ret.irr_micro ?? 0) : ''}`}>
                    {words ? (
                      <>
                        {words.rate}
                        <span className="inv-subline">{words.sub}</span>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="r num h-share">{total > 0 ? formatPercentMicro(Math.round((p.value_cents * 1_000_000) / total), 1) : '—'}</td>
                </tr>
              )
            })}
            {rest.length > 0 && (
              <tr className="inv-cashrow inv-restrow">
                <td className="h-asset">
                  <span className="inv-cashlabel">
                    {rest.length} more holding{rest.length === 1 ? '' : 's'}
                  </span>
                </td>
                <td className="h-spark" />
                <td className="h-price" />
                <td className="h-day" />
                <td className="r num h-value">{formatCents(restCents)}</td>
                <td className="h-unr" />
                <td className="h-ret" />
                <td className="r num h-share">{total > 0 ? formatPercentMicro(Math.round((restCents * 1_000_000) / total), 1) : ''}</td>
              </tr>
            )}
            {cash && (
              <tr className="inv-cashrow">
                <td className="h-asset">
                  <span className="inv-cashlabel">Cash</span>
                  {cash.note && <span className="inv-subline">{cash.note}</span>}
                </td>
                <td className="h-spark" />
                <td className="h-price" />
                <td className="h-day" />
                <td className="r num h-value">
                  <span className={cash.cents < 0 ? 'inv-shortcash' : undefined}>{formatCents(cash.cents)}</span>
                </td>
                <td className="h-unr" />
                <td className="h-ret" />
                <td className="h-share" />
              </tr>
            )}
            <tr className="inv-totalrow">
              <td className="strong h-asset">Total</td>
              <td className="h-spark" />
              <td className="h-price" />
              <DayCell day={dayTotal} strong />
              <td className="r num strong h-value">
                {formatCents(totals.value + (cash?.cents ?? 0))}
                <span className="inv-subline">
                  <span className="ui-sr">cost basis </span>
                  {formatCents(totals.cost)}
                </span>
              </td>
              <Gain cents={totals.unrealized} cost={totals.cost} priced strong />
              <td className={`r num strong h-ret ${rate ? toneOf(rate.irr_micro ?? 0) : ''}`}>
                {rate ? `${fmtPctMicro(rate.irr_micro!, { sign: true })}${rate.annualized ? '/yr' : ''}` : ''}
              </td>
              <td className="h-share" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** ▲/▼ and the day's change, its percent under it; a dash when the holding has none. */
function DayCell({ day, strong }: { day: DayChange | null; strong?: boolean }) {
  if (!day)
    return (
      <td className="r num h-day">
        <span className="muted">—</span>
      </td>
    )
  return (
    <td className={`r num h-day ${toneOf(day.cents)}${strong ? ' strong' : ''}`}>
      <span className="inv-nw">{dayAmount(day.cents)}</span>
      {day.micro !== null && <span className="inv-subline inv-subtone">{dayPercent(day.micro)}</span>}
    </td>
  )
}

/** ▲/▼ and the unrealized gain, the percent of cost under it. Flat is neither: no arrow, no colour. */
function Gain({ cents, cost, priced, strong }: { cents: number; cost: number; priced: boolean; strong?: boolean }): ReactNode {
  if (!priced)
    return (
      <td className="r num h-unr">
        <span className="muted">—</span>
      </td>
    )
  return (
    <td className={`r num h-unr ${toneOf(cents)}${strong ? ' strong' : ''}`}>
      <span className="inv-nw">{dayAmount(cents)}</span>
      {cost > 0 && <span className="inv-subline inv-subtone">{formatPercentMicro(Math.round((Math.abs(cents) * 1_000_000) / cost), 0)}</span>}
    </td>
  )
}
