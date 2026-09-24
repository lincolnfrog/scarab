import { useRef, useState, type FormEvent } from 'react'
import type { ManualPriceBody, PortfolioPosition } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { post } from '../api'
import { Button } from '../ui/Button'
import { DateInput, Field, MoneyInput } from '../ui/Field'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import { unparsedMoney } from './formGuard'
import './invest.css'
import { priceStale } from './priceRefresh'

/**
 * A holding's price cell: the price, and — when there is no price, when it
 * is stale, or when it was typed in by hand — a way to set one. Mutual
 * funds, CITs and private stock have no quote source (in a tab the shared
 * basket lists exchange-traded symbols only), so their price is the
 * household's to enter.
 */
export default function PriceCell({ p, today, onSaved }: { p: PortfolioPosition; today: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  const stale = p.price_cents !== null && priceStale(p.priced_on, today)

  let trigger
  if (p.price_cents === null)
    trigger = (
      <Button ref={anchor} size="mini" variant="ghost" aria-expanded={open} onClick={() => setOpen(true)}>
        Set price
      </Button>
    )
  else if (p.price_manual || stale) {
    const kind = p.price_manual ? 'manual' : 'stale'
    const day = shortDay(p.priced_on!, today)
    const label = `${kind} · ${day}`
    trigger = (
      <Tooltip content={p.price_manual ? `Entered by hand for ${p.priced_on} — click to update it` : `No quote since ${p.priced_on} — click to set a price by hand`}>
        <button
          ref={anchor}
          type="button"
          className={`inv-tag inv-tagbtn${stale ? ' inv-stale' : ''}`}
          aria-expanded={open}
          aria-label={`${label}: set the ${p.symbol} price`}
          onClick={() => setOpen(true)}
        >
          {/* Two unbreakable halves: in a tight table it breaks between them, never inside the date. */}
          <span className="inv-nw">{kind} ·</span> <span className="inv-nw">{day}</span>
        </button>
      </Tooltip>
    )
  }

  return (
    <td className="r num">
      <span className="inv-price">
        {trigger && p.price_cents !== null && trigger}
        {p.price_cents !== null ? formatCents(p.price_cents) : trigger}
      </span>
      {trigger && (
        <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" aria-label={`Set the ${p.symbol} price`}>
          {/* Mounted only while open, so each opening starts from the current price. */}
          <SetPriceForm p={p} today={today} onDone={() => { setOpen(false); onSaved() }} onCancel={() => setOpen(false)} />
        </Popover>
      )}
    </td>
  )
}

function SetPriceForm({ p, today, onDone, onCancel }: { p: PortfolioPosition; today: string; onDone: () => void; onCancel: () => void }) {
  const [cents, setCents] = useState<number | null>(p.price_manual ? p.price_cents : null)
  const [on, setOn] = useState(today)
  const form = useRef<HTMLFormElement>(null)
  const save = useAction((b: ManualPriceBody) => post<{ ok: true; cents: number; pricedOn: string }>('/api/prices/manual', b), {
    success: (r) => `${p.symbol} priced at ${formatCents(r.cents)} as of ${r.pricedOn}`,
    errorPrefix: `Couldn't set the ${p.symbol} price`,
    onDone,
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const bad = unparsedMoney(form.current)
    if (bad) return bad.focus()
    if (cents === null || cents <= 0 || !on) return
    void save.run({ symbol: p.symbol, pricedOn: on, cents })
  }
  return (
    <form ref={form} className="inv-pop" onSubmit={submit}>
      <div className="inv-pop-title">Set the {p.symbol} price</div>
      <Field label="Price per share">
        <MoneyInput autoFocus value={cents} onChange={setCents} aria-label="Price per share" />
      </Field>
      <Field label="As of" hint="The day that price is from — a statement date, or today.">
        <DateInput value={on} max={today} onChange={setOn} />
      </Field>
      <p className="inv-note">
        For funds and private stock no quote covers.{p.price_manual || p.price_cents === null ? '' : ' A later market quote replaces it.'}
      </p>
      <div className="inv-pop-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="gold" busy={save.busy} disabled={cents === null || cents <= 0 || !on || on > today}>
          Save price
        </Button>
      </div>
    </form>
  )
}
