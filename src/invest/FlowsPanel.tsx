import { useState, type FormEvent } from 'react'
import type { AccountFlowRow, InvestAccountRow } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { del, post, put } from '../api'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, MoneyInput, TextInput } from '../ui/Field'
import { Menu, type MenuItem } from '../ui/Menu'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import './invest.css'

type Form = { id: number | null; flowedOn: string; amountCents: number | null; note: string }
const blank = (today: string): Form => ({ id: null, flowedOn: today, amountCents: null, note: '' })
const editOf = (r: AccountFlowRow): Form => ({ id: r.id, flowedOn: r.flowed_on, amountCents: r.amount_cents, note: r.note ?? '' })
const signed = (c: number) => formatCents(c, { sign: c > 0 })

/** Deposits in and withdrawals out so far, and what is planned ahead — the panel's summary line. */
export function flowSummary(rows: readonly AccountFlowRow[]): { depositedCents: number; withdrawnCents: number; plannedCents: number; past: number } {
  let deposited = 0
  let withdrawn = 0
  let planned = 0
  let past = 0
  for (const r of rows) {
    if (r.planned) planned += r.amount_cents
    else {
      past++
      if (r.amount_cents > 0) deposited += r.amount_cents
      else withdrawn -= r.amount_cents
    }
  }
  return { depositedCents: deposited, withdrawnCents: withdrawn, plannedCents: planned, past }
}

/**
 * A balance account's deposits and withdrawals (its drawer's Deposits tab):
 * the money moved in and out, which a balance history alone can't tell from
 * growth; dated ahead, a planned deposit — new money the harvest forecast
 * counts from that day. Record, correct in place, remove; a summary line
 * sets the deposits against the latest balance.
 */
export default function FlowsPanel({ account, rows, today, onChanged }: {
  account: InvestAccountRow
  /** This account's flows, newest first. */
  rows: readonly AccountFlowRow[]
  today: string
  onChanged: () => void
}) {
  const [form, setForm] = useState<Form>(() => blank(today))
  const set = (f: Partial<Form>) => setForm((x) => ({ ...x, ...f }))
  const planning = form.flowedOn > today

  const save = useAction(
    (f: Form) => {
      const body = { investAccountId: account.id, flowedOn: f.flowedOn, amountCents: f.amountCents ?? 0, note: f.note.trim() || null }
      return f.id === null
        ? post<{ ok: true; row: AccountFlowRow }>('/api/invest/flows', body)
        : put<{ ok: true; changed: boolean; row: AccountFlowRow }>(`/api/invest/flows/${f.id}`, body)
    },
    {
      success: (r) =>
        `${r.row.planned ? 'Planned' : 'Recorded'} a ${formatCents(Math.abs(r.row.amount_cents))} ${r.row.amount_cents > 0 ? 'deposit' : 'withdrawal'} on ${r.row.flowed_on}`,
      errorPrefix: 'Couldn’t save it',
      onDone: () => {
        setForm(blank(today))
        onChanged()
      },
    },
  )
  const remove = useAction((r: AccountFlowRow) => del(`/api/invest/flows/${r.id}`).then(() => r), {
    success: (r) => `Removed the ${r.flowed_on} ${r.amount_cents > 0 ? 'deposit' : 'withdrawal'}`,
    errorPrefix: 'Couldn’t remove it',
    onDone: (r) => {
      if (form.id === r.id) setForm(blank(today))
      onChanged()
    },
  })

  async function askRemove(r: AccountFlowRow) {
    const ok = await confirm({
      title: `Remove the ${shortDay(r.flowed_on, today)} ${r.amount_cents > 0 ? 'deposit' : 'withdrawal'}?`,
      body: `${account.name}: ${signed(r.amount_cents)} on ${r.flowed_on}${r.planned ? ', planned' : ''}. The harvest forecast recomputes without it.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) void remove.run(r)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.amountCents === null || form.amountCents === 0 || !form.flowedOn) return
    void save.run(form)
  }

  const sum = flowSummary(rows)
  const snap = account.latest_snapshot
  return (
    <div className="inv-panel">
      <form className="inv-form inv-grantform" onSubmit={submit}>
        <div className="inv-formtitle">{form.id !== null ? 'Correct it' : planning ? 'Plan a deposit' : 'Record a deposit or withdrawal'}</div>
        <p className="inv-note">
          Money moved into or out of this account — a wire from the bank, a transfer in kind — on the day it moved. The balance history
          can’t tell a deposit from a gain; this can. Dated ahead of today, it is a plan: the harvest forecast counts it as new money from
          that day.
        </p>
        <FieldGrid min={140}>
          <Field label="Day" hint={planning ? 'ahead of today: a plan' : undefined}>
            <DateInput value={form.flowedOn} min="1900-01-01" onChange={(flowedOn) => set({ flowedOn })} />
          </Field>
          <Field label="Amount" hint="negative for a withdrawal">
            <MoneyInput allowNegative value={form.amountCents} placeholder="0.00" onChange={(amountCents) => set({ amountCents })} />
          </Field>
          <Field label="Note" hint="optional">
            <TextInput value={form.note} maxLength={120} placeholder="e.g. BTC sale proceeds" onChange={(e) => set({ note: e.target.value })} />
          </Field>
        </FieldGrid>
        <div className="inv-actions">
          <Button type="submit" busy={save.busy} disabled={form.amountCents === null || form.amountCents === 0}>
            {form.id !== null ? 'Save' : planning ? 'Plan deposit' : 'Record'}
          </Button>
          {form.id !== null && (
            <Button variant="ghost" onClick={() => setForm(blank(today))}>
              Cancel
            </Button>
          )}
          {sum.past > 0 && (
            <span className="inv-note">
              Deposited {formatCents(sum.depositedCents)}
              {sum.withdrawnCents > 0 && <> · withdrawn {formatCents(sum.withdrawnCents)}</>}
              {snap && <> · balance {formatCents(snap.balance_cents)} as of {shortDay(snap.balanced_on, today)}: {signed(snap.balance_cents - sum.depositedCents + sum.withdrawnCents)} beyond the deposits</>}
              {sum.plannedCents !== 0 && <> · {signed(sum.plannedCents)} planned</>}
            </span>
          )}
        </div>
      </form>
      {rows.length > 0 && (
        <div className="inv-tablewrap">
          <table className="inv-baltable inv-reptable">
            <thead>
              <tr>
                <th>Day</th>
                <th className="r">Amount</th>
                <th>Note</th>
                <th className="inv-actcol"><span className="ui-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const items: MenuItem[] = [
                  { label: 'Correct…', onSelect: () => setForm(editOf(r)) },
                  { label: 'Remove…', danger: true, disabled: remove.busy, onSelect: () => void askRemove(r) },
                ]
                return (
                  <tr key={r.id}>
                    <td>
                      {r.flowed_on}
                      {r.planned && <span className="inv-tag inv-quiet">planned</span>}
                    </td>
                    <td className={`r num ${r.amount_cents > 0 ? 'pos' : 'neg'}`}>{signed(r.amount_cents)}</td>
                    <td className="muted">{r.note ?? ''}</td>
                    <td className="r">
                      <Menu label={`${r.flowed_on} ${r.amount_cents > 0 ? 'deposit' : 'withdrawal'} actions`} items={items} align="end" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
