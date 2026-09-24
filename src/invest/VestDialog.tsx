import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { UnvestedRow, VestResult } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { post } from '../api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { DateInput, Field, FieldGrid, MoneyInput, QtyInput } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import { unparsedField } from './formGuard'
import { loadMarketSymbols, stockQuote } from './marketSymbols'
import { vestBody, vestDateDefault, vestPlan, fmvPrefill, type Quote, type VestForm, type VestPlan } from './vestMath'
import './invest.css'

/**
 * Record a vest from the release confirmation: the date, the gross shares,
 * their fair market value (per share or the total) and, with net settlement,
 * the shares withheld for tax. The FMV is prefilled only from a close dated
 * the vest day itself (the shared basket's, or the stored price) — any other
 * day's price would be the wrong cost basis.
 *
 * What it records: a buy of the gross shares at their value (income on
 * Taxes, and the lot's basis), and the withheld shares as a same-day sale of
 * that lot at their share of it — $0 gain, and never cash in the account.
 */
export default function VestDialog({ open, grant, today, onClose, onDone }: {
  open: boolean
  grant: UnvestedRow
  today: string
  onClose: () => void
  onDone: () => void
}) {
  const formId = useId()
  const form = useRef<HTMLFormElement>(null)
  const [f, setF] = useState<VestForm>(() => ({
    date: vestDateDefault(grant.next_vest_on, today),
    grossMicro: grant.vest_qty_micro ?? null,
    mode: 'price',
    priceCents: null,
    totalCents: null,
    withheldMicro: null,
  }))
  const set = (patch: Partial<VestForm>) => setF((cur) => ({ ...cur, ...patch }))
  const [basket, setBasket] = useState<Quote | null>(null)
  // The FMV box follows the vest day's close until someone types in it.
  const [prefilled, setPrefilled] = useState<Quote | null>(null)
  const [typed, setTyped] = useState(false)
  const [untracked, setUntracked] = useState(false)
  const [tried, setTried] = useState(false)

  useEffect(() => {
    let live = true
    loadMarketSymbols()
      .then((m) => live && setBasket(stockQuote(m, grant.symbol)))
      .catch(() => undefined) // no basket: the stored price may still match, else it's typed
    return () => {
      live = false
    }
  }, [grant.symbol])

  const stored: Quote | null = grant.price_cents !== null && grant.priced_on ? { cents: grant.price_cents, pricedOn: grant.priced_on } : null
  const prefill = fmvPrefill(f.date, [basket, stored])
  useEffect(() => {
    if (typed || f.mode !== 'price') return
    setPrefilled(prefill)
    setF((cur) => (cur.priceCents === (prefill?.cents ?? null) ? cur : { ...cur, priceCents: prefill?.cents ?? null }))
  }, [prefill?.cents, prefill?.pricedOn, typed, f.mode])

  const built = vestPlan(f, today)
  const plan: VestPlan | null = 'plan' in built ? built.plan : null
  const complaint = 'error' in built ? built.error : null
  const over = f.grossMicro !== null && f.grossMicro > grant.qty_micro ? f.grossMicro - grant.qty_micro : 0

  const record = useAction((body: ReturnType<typeof vestBody>) => post<VestResult>('/api/unvested/vest', body), {
    success: (r) =>
      `Vested ${formatQtyMicro(r.grossQtyMicro)} ${grant.symbol}` +
      (r.withheldQtyMicro > 0 ? ` · ${formatQtyMicro(r.withheldQtyMicro)} withheld for tax · ${formatQtyMicro(r.netQtyMicro)} kept` : '') +
      ` · ${formatQtyMicro(r.remainingQtyMicro)} still unvested`,
    errorPrefix: "Couldn't record the vest",
    onDone: () => {
      onClose()
      onDone()
    },
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTried(true)
    const bad = unparsedField(form.current)
    if (bad) return bad.focus()
    if (!plan || f.grossMicro === null || (over > 0 && !untracked)) return
    void record.run(vestBody({ accountId: grant.invest_account_id, symbol: grant.symbol, date: f.date, grossMicro: f.grossMicro, plan, allowUntracked: over > 0 }))
  }

  const missing = (v: unknown) => (tried && (v === null || v === '') ? 'Required' : null)
  const priceHint = prefilled
    ? `Prefilled with the ${shortDay(prefilled.pricedOn, today)} close — check it against the release.`
    : 'From the release confirmation — usually the vest day’s close.'

  return (
    <Dialog
      open={open}
      width={520}
      onClose={onClose}
      dismissible={!record.busy}
      title={`${grant.symbol} vested`}
      subtitle={`${grant.account_name} · ${formatQtyMicro(grant.qty_micro)} unvested`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="gold" busy={record.busy} disabled={!plan || (over > 0 && !untracked)}>
            Record vest
          </Button>
        </>
      }
    >
      <form id={formId} ref={form} className="inv-form inv-vest" onSubmit={submit} noValidate>
        <FieldGrid min={150}>
          <Field label="Vest date" error={missing(f.date)}>
            <DateInput value={f.date} max={today} onChange={(date) => set({ date })} />
          </Field>
          <Field label="Shares vested" hint="Gross, before any withheld" error={missing(f.grossMicro)}>
            <span className="inv-qtybox">
              <QtyInput autoFocus={f.grossMicro === null} valueMicro={f.grossMicro} onChange={(grossMicro) => set({ grossMicro })} />
            </span>
          </Field>
        </FieldGrid>

        <div className="inv-amounts">
          <div className="ui-field">
            <span className="ui-field-label">Value at vest</span>
            <Segmented
              aria-label="Enter the value per share or the total"
              value={f.mode}
              options={[{ value: 'price', label: 'FMV / share' }, { value: 'total', label: 'Total value' }]}
              onChange={(mode) => set(mode === 'total' ? { mode, totalCents: plan?.totalCents ?? f.totalCents } : { mode, priceCents: plan?.priceCents ?? f.priceCents })}
            />
          </div>
          {f.mode === 'price' ? (
            <Field label="Fair market value per share" hint={priceHint} error={missing(f.priceCents)}>
              <span className="inv-moneybox">
                <MoneyInput
                  autoFocus={f.grossMicro !== null}
                  value={f.priceCents}
                  onChange={(priceCents) => {
                    setTyped(true)
                    setPrefilled(null)
                    set({ priceCents })
                  }}
                />
              </span>
            </Field>
          ) : (
            <Field label="Total value at vest" hint="Shares × FMV, as the release shows it" error={missing(f.totalCents)}>
              <span className="inv-moneybox">
                <MoneyInput value={f.totalCents} onChange={(totalCents) => set({ totalCents })} />
              </span>
            </Field>
          )}
        </div>

        <Field
          label="Shares withheld for taxes"
          hint="Net settlement: shares your employer kept to pay the withholding. Blank if you paid in cash, or they sold to cover — record that sale on its own."
        >
          <span className="inv-qtybox">
            <QtyInput valueMicro={f.withheldMicro} placeholder="0" onChange={(withheldMicro) => set({ withheldMicro })} />
          </span>
        </Field>

        {over > 0 && (
          <label className="checkline inv-check">
            <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} />
            <span>
              The extra {formatQtyMicro(over)} came from a grant Scarab doesn’t track
              <span className="inv-subline">
                Only {formatQtyMicro(grant.qty_micro)} {grant.symbol} are recorded as unvested here — otherwise fix the shares vested.
              </span>
            </span>
          </label>
        )}

        <VestSummary plan={plan} complaint={complaint} grant={grant} grossMicro={f.grossMicro} />
      </form>
    </Dialog>
  )
}

/** What recording it will do, live. Exported for the render test. */
export function VestSummary({ plan, complaint, grant, grossMicro }: { plan: VestPlan | null; complaint: string | null; grant: UnvestedRow; grossMicro: number | null }) {
  if (complaint)
    return (
      <section className="inv-preview-pane" aria-live="polite">
        <p className="inv-pv-warn">{complaint}</p>
      </section>
    )
  if (!plan || grossMicro === null)
    return (
      <section className="inv-preview-pane inv-quietpane" aria-live="polite">
        <p className="inv-note">Enter the shares vested and their value to see what gets recorded.</p>
      </section>
    )
  const left = Math.max(0, grant.qty_micro - grossMicro)
  return (
    <section className="inv-preview-pane" aria-live="polite">
      <div className="inv-pv-row">
        <span>Income on Taxes</span>
        <b>{formatCents(plan.totalCents)}</b>
      </div>
      <div className="inv-pv-sub">
        <span>
          {formatQtyMicro(grossMicro)} × {formatCents(plan.priceCents)}
        </span>
        <span>the shares’ cost basis</span>
      </div>
      {plan.withheldMicro > 0 && (
        <>
          <div className="inv-pv-row">
            <span>Withheld for tax · {formatQtyMicro(plan.withheldMicro)} shares</span>
            <b>{formatCents(plan.withheldCents)}</b>
          </div>
          <div className="inv-pv-sub">
            <span>a same-day sale at cost: $0 gain, and not cash in the account</span>
          </div>
        </>
      )}
      <div className="inv-pv-row">
        <span>Kept in {grant.account_name} · {formatQtyMicro(plan.netMicro)} shares</span>
        <b>{formatCents(plan.netCostCents)}</b>
      </div>
      <div className="inv-pv-sub">
        <span>basis of what stays</span>
        <span>{formatQtyMicro(left)} still unvested after</span>
      </div>
    </section>
  )
}
