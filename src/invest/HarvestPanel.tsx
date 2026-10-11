import { useState, type FormEvent } from 'react'
import type { HarvestProfile, InvestAccountRow } from '../../shared/invest-api'
import { formatCents, formatPercentMicro } from '../../shared/money'
import { del, put } from '../api'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, MoneyInput, PercentInput, Select, TextInput } from '../ui/Field'
import { useAction } from '../ui/useAction'
import './invest.css'

type YearRow = { taxYear: number; lossCents: number | null }
type Form = { asOf: string; year1Micro: number | null; year2Micro: number | null; laterMicro: number | null; source: string; years: YearRow[] }

const yearOf = (iso: string) => Number(iso.slice(0, 4))
/** The years a figure may be given for: the estimate's year and the ten after it. */
export const forecastYears = (asOf: string): number[] => Array.from({ length: 11 }, (_, i) => yearOf(asOf) + i)

export function formFor(profile: HarvestProfile | null, today: string): Form {
  if (!profile) {
    const y = yearOf(today)
    return { asOf: today, year1Micro: null, year2Micro: null, laterMicro: null, source: '', years: [{ taxYear: y, lossCents: null }, { taxYear: y + 1, lossCents: null }] }
  }
  return {
    asOf: profile.as_of,
    year1Micro: profile.year1_micro,
    year2Micro: profile.year2_micro,
    laterMicro: profile.later_micro,
    source: profile.source ?? '',
    years: profile.years.map((y) => ({ taxYear: y.tax_year, lossCents: y.loss_cents })),
  }
}

/**
 * A taxable balance account's harvest forecast (its drawer's Forecast tab):
 * the manager's own estimate of the net losses the account will realize —
 * dollar figures for what is in it today, by tax year, and the share of new
 * money harvested by its age — with the day it was given and where it came
 * from. An assumption Scarab spreads over the calendar for Taxes' Loss
 * capacity view; nothing here is a fact off a statement.
 */
export default function HarvestPanel({ account, profile, today, onChanged }: {
  account: InvestAccountRow
  profile: HarvestProfile | null
  today: string
  onChanged: () => void
}) {
  const [form, setForm] = useState<Form>(() => formFor(profile, today))
  const set = (f: Partial<Form>) => setForm((x) => ({ ...x, ...f }))
  const setYear = (i: number, patch: Partial<YearRow>) => set({ years: form.years.map((y, k) => (k === i ? { ...y, ...patch } : y)) })
  const options = forecastYears(form.asOf)
  const addYear = () => {
    const used = new Set(form.years.map((y) => y.taxYear))
    const next = options.find((y) => !used.has(y))
    if (next !== undefined) set({ years: [...form.years, { taxYear: next, lossCents: null }] })
  }
  const ratesSet = form.year1Micro !== null && form.year2Micro !== null && form.laterMicro !== null
  const duplicate = new Set(form.years.map((y) => y.taxYear)).size !== form.years.length

  const save = useAction(
    (f: Form) =>
      put<{ ok: true; changed: boolean; profile: HarvestProfile }>(`/api/invest/accounts/${account.id}/harvest`, {
        asOf: f.asOf,
        year1Micro: f.year1Micro ?? 0,
        year2Micro: f.year2Micro ?? 0,
        laterMicro: f.laterMicro ?? 0,
        source: f.source.trim() || null,
        years: f.years.filter((y) => y.lossCents !== null).map((y) => ({ taxYear: y.taxYear, lossCents: y.lossCents! })),
      }),
    {
      success: (r) => (r.changed ? `${account.name}’s harvest forecast saved — Loss capacity recomputed` : 'Nothing to change'),
      errorPrefix: 'Couldn’t save the forecast',
      onDone: onChanged,
    },
  )
  const remove = useAction(() => del(`/api/invest/accounts/${account.id}/harvest`), {
    success: `Removed ${account.name}’s harvest forecast`,
    errorPrefix: 'Couldn’t remove it',
    onDone: () => {
      setForm(formFor(null, today))
      onChanged()
    },
  })
  async function askRemove() {
    const ok = await confirm({
      title: `Remove ${account.name}’s harvest forecast?`,
      body: 'Loss capacity will expect nothing further from this account; its reported figures stay.',
      confirmLabel: 'Remove',
      danger: true,
    })
    if (ok) void remove.run()
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    if (!ratesSet || duplicate || !form.asOf) return
    void save.run(form)
  }

  return (
    <div className="inv-panel">
      <form className="inv-form inv-grantform" onSubmit={submit}>
        <div className="inv-formtitle">{profile ? 'The manager’s estimate' : 'Enter the manager’s estimate'}</div>
        <p className="inv-note">
          Scarab can’t model this account’s trades, but it can hold what its manager expects it to realize in net losses and spread
          that over the calendar. Enter their dollar figures for the money in the account today, by tax year (the estimate’s own year
          covers the rest of it), and the share of any new money they expect to harvest in its first year, its second, and each year
          after — deposits recorded or planned after the estimate’s day count as new money. Loss capacity on Taxes nets the result
          against your gains. An estimate, never a fact.
        </p>
        <FieldGrid min={150}>
          <Field label="Given on" hint="the day of the estimate">
            <DateInput value={form.asOf} max={today} min="1900-01-01" onChange={(asOf) => set({ asOf })} />
          </Field>
          <Field label="New money, year one" hint="share of a deposit">
            <PercentInput valueMicro={form.year1Micro} placeholder="70" onChange={(year1Micro) => set({ year1Micro })} />
          </Field>
          <Field label="Year two">
            <PercentInput valueMicro={form.year2Micro} placeholder="39" onChange={(year2Micro) => set({ year2Micro })} />
          </Field>
          <Field label="Each year after" hint="also the standing book past the figures below">
            <PercentInput valueMicro={form.laterMicro} placeholder="25" onChange={(laterMicro) => set({ laterMicro })} />
          </Field>
          <Field label="Source" hint="optional — who said so, and when">
            <TextInput value={form.source} maxLength={120} placeholder="e.g. manager’s email, Aug 31" onChange={(e) => set({ source: e.target.value })} />
          </Field>
        </FieldGrid>
        <div className="inv-formtitle">The standing book, by tax year</div>
        <div className="inv-yearrows">
          {form.years.map((y, i) => (
            <div key={i} className="inv-yearrow">
              <Select value={y.taxYear} aria-label={`Tax year ${i + 1}`} onChange={(e) => setYear(i, { taxYear: Number(e.target.value) })}>
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </Select>
              <MoneyInput value={y.lossCents} placeholder="expected net loss" width={190} aria-label={`Expected loss in ${y.taxYear}`} onChange={(lossCents) => setYear(i, { lossCents })} />
              <Button size="mini" variant="ghost" onClick={() => set({ years: form.years.filter((_, k) => k !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <div>
            <Button size="mini" onClick={addYear} disabled={form.years.length >= options.length}>
              + Year
            </Button>
            {duplicate && <span className="inv-note" role="alert"> A year is listed twice.</span>}
          </div>
        </div>
        <div className="inv-actions">
          <Button type="submit" busy={save.busy} disabled={!ratesSet || duplicate || !form.asOf}>
            {profile ? 'Save forecast' : 'Save'}
          </Button>
          {profile && (
            <Button variant="ghost" busy={remove.busy} onClick={() => void askRemove()}>
              Remove forecast…
            </Button>
          )}
          {profile && (
            <span className="inv-note">
              Saved: {formatPercentMicro(profile.year1_micro, 0)} / {formatPercentMicro(profile.year2_micro, 0)} / {formatPercentMicro(profile.later_micro, 0)} on new money
              {profile.years.length > 0 && <> · {profile.years.map((y) => `${y.tax_year} ${formatCents(y.loss_cents)}`).join(' · ')}</>}
              {profile.source && <> · {profile.source}</>}
            </span>
          )}
        </div>
      </form>
    </div>
  )
}
