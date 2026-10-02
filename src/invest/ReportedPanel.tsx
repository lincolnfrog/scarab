import { useState, type FormEvent } from 'react'
import type { InvestAccountRow, ReportedRealizedRow } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { del, put } from '../api'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, MoneyInput, Select } from '../ui/Field'
import { Menu, type MenuItem } from '../ui/Menu'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import './invest.css'

/** The years offered: this one and the five before it, plus any year already reported. */
export function reportYears(thisYear: number, rows: readonly Pick<ReportedRealizedRow, 'tax_year'>[]): number[] {
  const years = new Set(Array.from({ length: 6 }, (_, i) => thisYear - i))
  for (const r of rows) years.add(r.tax_year)
  return [...years].sort((a, b) => b - a)
}

/** The last day a year's figures can run through: today for this year, Dec 31 for one that has ended. */
export const lastDayOf = (year: number, today: string) => (`${year}-12-31` < today ? `${year}-12-31` : today)

type Form = { year: number; stCents: number | null; ltCents: number | null; asOf: string }

const formFor = (year: number, rows: readonly ReportedRealizedRow[], today: string): Form => {
  const r = rows.find((x) => x.tax_year === year)
  return r ? { year, stCents: r.st_cents, ltCents: r.lt_cents, asOf: r.as_of } : { year, stCents: null, ltCents: null, asOf: lastDayOf(year, today) }
}

const signed = (c: number) => formatCents(c, { sign: c > 0 })
const tone = (c: number) => (c > 0 ? 'pos' : c < 0 ? 'neg' : undefined)

/**
 * A taxable account tracked by balance — a managed strategy whose trades
 * Scarab never sees — and the realized gains its broker reports, by tax year:
 * short- and long-term, through a day. Taxes, the two-year view and the
 * realized report count them with the recorded sales. One set of figures per
 * year; saving again replaces it (the broker's year-to-date page, then the
 * 1099-B).
 */
export default function ReportedPanel({ account, rows, today, onChanged }: {
  account: InvestAccountRow
  /** This account's reported years, newest first. */
  rows: readonly ReportedRealizedRow[]
  today: string
  onChanged: () => void
}) {
  const thisYear = Number(today.slice(0, 4))
  const [form, setForm] = useState<Form>(() => formFor(thisYear, rows, today))
  const set = (f: Partial<Form>) => setForm((x) => ({ ...x, ...f }))
  const existing = rows.find((x) => x.tax_year === form.year) ?? null

  const save = useAction(
    (f: Form) =>
      put<{ ok: true; changed: boolean; row: ReportedRealizedRow }>(`/api/invest/accounts/${account.id}/realized/${f.year}`, {
        stCents: f.stCents ?? 0,
        ltCents: f.ltCents ?? 0,
        asOf: f.asOf,
      }),
    {
      success: (r) => (r.changed ? `${account.name}: ${r.row.tax_year} realized ${signed(r.row.st_cents + r.row.lt_cents)} saved — Taxes recomputed` : 'Nothing to change'),
      errorPrefix: 'Couldn’t save the realized gains',
      onDone: onChanged,
    },
  )
  const remove = useAction((year: number) => del(`/api/invest/accounts/${account.id}/realized/${year}`).then(() => year), {
    success: (year) => `Removed ${account.name}’s ${year} realized gains`,
    errorPrefix: 'Couldn’t remove them',
    onDone: (year) => {
      if (form.year === year) setForm(formFor(year, [], today))
      onChanged()
    },
  })

  async function askRemove(r: ReportedRealizedRow) {
    const ok = await confirm({
      title: `Remove ${account.name}’s ${r.tax_year} realized gains?`,
      body: `${signed(r.st_cents)} short-term and ${signed(r.lt_cents)} long-term, through ${r.as_of}. The ${r.tax_year} tax picture recomputes without them.`,
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) void remove.run(r.tax_year)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    if (form.stCents === null && form.ltCents === null) return
    void save.run(form)
  }

  const empty = form.stCents === null && form.ltCents === null
  return (
    <div className="inv-panel">
      <form className="inv-form inv-grantform" onSubmit={submit}>
        <div className="inv-formtitle">{existing ? `Update ${form.year}` : 'Report realized gains'}</div>
        <p className="inv-note">
          Scarab doesn’t see this account’s trades, so enter the gain or loss its broker reports for the year — the realized gain/loss
          page as the year goes, the 1099-B once it ends. A loss is negative. It counts on Taxes with every other sale.
        </p>
        <FieldGrid min={140}>
          <Field label="Tax year">
            <Select value={form.year} onChange={(e) => setForm(formFor(Number(e.target.value), rows, today))}>
              {reportYears(thisYear, rows).map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Short-term" hint="held a year or less">
            <MoneyInput allowNegative value={form.stCents} placeholder="0.00" onChange={(stCents) => set({ stCents })} />
          </Field>
          <Field label="Long-term" hint="held more than a year">
            <MoneyInput allowNegative value={form.ltCents} placeholder="0.00" onChange={(ltCents) => set({ ltCents })} />
          </Field>
          <Field label="Through" hint="the day the figures run to">
            <DateInput value={form.asOf} min={`${form.year}-01-01`} max={lastDayOf(form.year, today)} onChange={(asOf) => set({ asOf })} />
          </Field>
        </FieldGrid>
        <div className="inv-actions">
          <Button type="submit" busy={save.busy} disabled={empty}>
            {existing ? `Save ${form.year}` : 'Save'}
          </Button>
          <span className="inv-note">The broker’s figures already reflect any wash sale it caught inside this account.</span>
        </div>
      </form>
      {rows.length > 0 && (
        <div className="inv-tablewrap">
          <table className="inv-baltable inv-reptable">
            <thead>
              <tr>
                <th>Year</th>
                <th className="r">Short</th>
                <th className="r">Long</th>
                <th className="inv-actcol"><span className="ui-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const items: MenuItem[] = [
                  { label: `Edit ${r.tax_year}`, onSelect: () => setForm(formFor(r.tax_year, rows, today)) },
                  { label: 'Remove…', danger: true, disabled: remove.busy, onSelect: () => void askRemove(r) },
                ]
                return (
                  <tr key={r.tax_year}>
                    <td>
                      {r.tax_year}
                      <span className="inv-subline">through {shortDay(r.as_of, today)}</span>
                    </td>
                    <td className={`r num ${tone(r.st_cents) ?? ''}`}>{signed(r.st_cents)}</td>
                    <td className={`r num ${tone(r.lt_cents) ?? ''}`}>{signed(r.lt_cents)}</td>
                    <td className="r">
                      <Menu label={`${r.tax_year} realized gains actions`} items={items} align="end" />
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
