import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { todayLocal } from '../../shared/dates'
import { formatCents, formatDollars } from '../../shared/money'
import { get, post, put } from '../api'
import RealEstateChart from '../cards/RealEstateChart'
import { Link } from '../router'
import { Button } from '../ui/Button'
import { useDeepAction } from '../ui/CommandPalette'
import { Dialog } from '../ui/Dialog'
import { prompt } from '../ui/dialogs'
import { EmptyState } from '../ui/EmptyState'
import { DateInput, Field, MoneyInput, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { Skeleton } from '../ui/Skeleton'
import { useAction } from '../ui/useAction'
import './screens.css'

type Liability = {
  id: number
  name: string
  rate_micro: number | null
  latest_balance: { balanced_on: string; balance_cents: number } | null
  balances: { balanced_on: string; balance_cents: number }[]
}
/** One property as GET /api/properties returns it: valuations and liabilities with their histories. */
export type PropertyDetail = {
  id: number
  name: string
  purchased_on: string | null
  purchase_cents: number | null
  latest_valuation: { valued_on: string; value_cents: number; source: string } | null
  valuations: { valued_on: string; value_cents: number }[]
  liabilities: Liability[]
}

const pct = (rateMicro: number) => `${(rateMicro / 10000).toFixed(3)}%`
const valueOf = (p: PropertyDetail) => p.latest_valuation?.value_cents ?? p.purchase_cents ?? 0
const debtOf = (p: PropertyDetail) => p.liabilities.reduce((s, l) => s + (l.latest_balance?.balance_cents ?? 0), 0)

/** The header's subtitle (the mockup's "1 property · manual + Zillow-assisted valuation"). */
function propertiesLine(props: PropertyDetail[] | null): string | undefined {
  if (props === null) return undefined
  if (props.length === 0) return 'Your home, its value and what you still owe on it'
  const equity = props.reduce((s, p) => s + valueOf(p) - debtOf(p), 0)
  return `${props.length} propert${props.length === 1 ? 'y' : 'ies'} · manual valuations · ${formatDollars(equity)} equity`
}
const MAX_MORTGAGE_RATE = 250_000 // 25%: above that it's a typo, not a mortgage

type NewProperty = { name: string; purchasedOn: string; purchaseCents: number | null }
const EMPTY_PROPERTY: NewProperty = { name: '', purchasedOn: '', purchaseCents: null }

/** "Add property": name, and optionally when it was bought and for how much. */
function AddPropertyDialog(p: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState<NewProperty>(EMPTY_PROPERTY)
  const [nameErr, setNameErr] = useState<string | null>(null)
  const formId = useId()
  const formRef = useRef<HTMLFormElement>(null)
  const add = useAction(
    async (f: NewProperty) => {
      await post('/api/properties', {
        name: f.name.trim(),
        purchasedOn: f.purchasedOn || undefined,
        purchaseCents: f.purchaseCents ?? undefined,
      })
      return f.name.trim()
    },
    {
      success: (name) => `Added ${name}`,
      errorPrefix: "Couldn't add the property",
      onDone: () => {
        setForm(EMPTY_PROPERTY)
        p.onAdded()
      },
    },
  )
  const submit = () => {
    if (!form.name.trim()) return setNameErr('Name the property — an address or a nickname')
    // A number box whose text doesn't parse flags itself and holds its last good value; don't save around it.
    const bad = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')
    if (bad) {
      bad.focus()
      return
    }
    void add.run(form)
  }
  return (
    <Dialog
      open={p.open}
      onClose={p.onClose}
      dismissible={!add.busy}
      title="Add property"
      subtitle="Keep its value and mortgage balance fresh — equity and the net-worth slice follow from them."
      footer={
        <>
          <Button onClick={p.onClose} disabled={add.busy}>Cancel</Button>
          <Button type="submit" form={formId} variant="gold" busy={add.busy}>Add property</Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="ui-dialog-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <Field label="Name" error={nameErr}>
          <TextInput
            autoFocus
            maxLength={120}
            placeholder="e.g. 2847 Foothill Rd — Goleta"
            value={form.name}
            onChange={(e) => {
              setForm({ ...form, name: e.target.value })
              setNameErr(null)
            }}
          />
        </Field>
        <Field label="Purchased" hint="optional">
          <DateInput value={form.purchasedOn} max={todayLocal()} onChange={(v) => setForm({ ...form, purchasedOn: v })} />
        </Field>
        <Field label="Purchase price" hint="optional — the cost basis, and the value until you add an estimate">
          <MoneyInput value={form.purchaseCents} onChange={(c) => setForm({ ...form, purchaseCents: c })} />
        </Field>
      </form>
    </Dialog>
  )
}

export default function RealEstate() {
  // null until the first load lands, so the "add your house" copy never flashes before the properties do.
  const [props, setProps] = useState<PropertyDetail[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // '#/re?d=add-property' (the ⌘K palette) opens the Add property dialog on arrival.
  useDeepAction('re', { 'add-property': () => setAdding(true) })

  // A failed first load says so, with a retry; a failed refresh keeps what's on screen.
  const load = useCallback(
    () =>
      get<PropertyDetail[]>('/api/properties')
        .then((p) => {
          setProps(p)
          setLoadErr(null)
        })
        .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e))),
    [],
  )
  useEffect(() => {
    load()
  }, [load])

  const saveValuation = useAction(
    async (prop: PropertyDetail, cents: number, on: string) => {
      await put(`/api/properties/${prop.id}/valuation`, { valuedOn: on, valueCents: cents })
      return `${prop.name}: ${formatCents(cents)} as of ${on}`
    },
    { success: (r) => r, errorPrefix: "Couldn't save the value", onDone: () => void load() },
  )
  const saveBalance = useAction(
    async (l: Liability, cents: number, on: string) => {
      await put(`/api/liabilities/${l.id}/balance`, { balancedOn: on, balanceCents: cents })
      return `${l.name}: ${formatCents(cents)} as of ${on}`
    },
    { success: (r) => r, errorPrefix: "Couldn't save the balance", onDone: () => void load() },
  )
  const addMortgage = useAction(
    async (prop: PropertyDetail, m: { name: string; rateMicro: number | null; balanceCents: number | null; on: string }) => {
      await post('/api/liabilities', {
        propertyId: prop.id,
        name: m.name,
        rateMicro: m.rateMicro,
        balanceCents: m.balanceCents,
        balancedOn: m.balanceCents === null ? undefined : m.on,
      })
      return `Added ${m.name} on ${prop.name}`
    },
    { success: (r) => r, errorPrefix: "Couldn't add the mortgage", onDone: () => void load() },
  )

  async function updateValuation(p: PropertyDetail) {
    const v = await prompt<{ cents: number; on: string }>({
      title: `Update ${p.name}'s value`,
      body: 'Your current estimate — Zillow, a comp, or your own number.',
      fields: [
        { key: 'cents', kind: 'money', label: 'Estimated value', initial: p.latest_valuation?.value_cents ?? p.purchase_cents ?? null },
        { key: 'on', kind: 'date', label: 'As of', initial: todayLocal() },
      ],
      validate: (x) => (x.on > todayLocal() ? 'The date can’t be in the future' : null),
      submitLabel: 'Save value',
    })
    if (v) void saveValuation.run(p, v.cents, v.on)
  }

  async function onAddMortgage(p: PropertyDetail) {
    const v = await prompt<{ name: string; rateMicro: number | null; balanceCents: number | null; on: string }>({
      title: `Add a mortgage on ${p.name}`,
      fields: [
        { key: 'name', kind: 'text', label: 'Lender / loan', initial: 'Mortgage', maxLength: 80 },
        { key: 'rateMicro', kind: 'percent', label: 'Interest rate', required: false, hint: 'optional — e.g. 3.125' },
        { key: 'balanceCents', kind: 'money', label: 'Current balance', required: false, hint: "optional — from your lender's site" },
        { key: 'on', kind: 'date', label: 'Balance as of', initial: todayLocal() },
      ],
      validate: (x) =>
        x.rateMicro !== null && x.rateMicro > MAX_MORTGAGE_RATE
          ? 'A rate above 25% is probably a typo'
          : x.balanceCents !== null && x.on > todayLocal()
            ? 'The balance date can’t be in the future'
            : null,
      submitLabel: 'Add mortgage',
    })
    if (v) void addMortgage.run(p, v)
  }

  async function updateBalance(l: Liability) {
    const v = await prompt<{ cents: number; on: string }>({
      title: `Update ${l.name}'s balance`,
      body: "The payoff balance from your lender's site.",
      fields: [
        { key: 'cents', kind: 'money', label: 'Current balance', initial: l.latest_balance?.balance_cents ?? null },
        { key: 'on', kind: 'date', label: 'As of', initial: todayLocal() },
      ],
      validate: (x) => (x.on > todayLocal() ? 'The date can’t be in the future' : null),
      submitLabel: 'Save balance',
    })
    if (v) void saveBalance.run(l, v.cents, v.on)
  }

  const onAdded = () => {
    setAdding(false)
    void load()
  }

  return (
    <div className="grid12">
      <HeaderSlot sub={propertiesLine(props)} actions={<Button onClick={() => setAdding(true)}>+ Add property</Button>} />
      {props === null && (
        <div className="card c12">
          {loadErr ? (
            <div role="alert">
              <h2>Properties</h2>
              <p className="sub2">Couldn't load your properties: {loadErr}</p>
              <Button size="mini" onClick={() => void load()}>Retry</Button>
            </div>
          ) : (
            <div aria-busy="true" aria-label="Loading properties">
              <Skeleton h={14} w="60%" />
              <Skeleton h={120} style={{ marginTop: 12 }} />
            </div>
          )}
        </div>
      )}
      {props?.length === 0 && (
        <div className="card c12">
          <EmptyState
            title="No properties yet"
            body={
              <>
                Add your house: name it, note what you paid, then keep the value and mortgage balance fresh — equity, the
                net-worth slice and the <Link className="scr-link" to={{ screen: 'goal', rest: ['rental'] }}>Dream Home</Link> rental
                scenario all flow from it.
              </>
            }
            action={{ label: '+ Add property', onClick: () => setAdding(true) }}
          />
        </div>
      )}

      {(props ?? []).map((p) => {
        const value = valueOf(p)
        const debt = debtOf(p)
        return (
          <div className="card c12" key={p.id}>
            <div className="h4row">
              <h2>{p.name}</h2>
              <div className="right muted">
                {p.purchased_on && p.purchase_cents
                  ? `purchased ${p.purchased_on} · ${formatCents(p.purchase_cents)}`
                  : ''}
              </div>
            </div>
            <div className="proprow" style={{ marginBottom: 12 }}>
              <div className="propstat">
                <div className="muted">Est. value {p.latest_valuation ? `· ${p.latest_valuation.valued_on}` : ''}</div>
                <div className="v">{value ? formatCents(value) : '—'}</div>
                <Button size="mini" style={{ marginTop: 4 }} onClick={() => void updateValuation(p)}>
                  Update value
                </Button>
              </div>
              {p.liabilities.map((l) => (
                <div className="propstat" key={l.id}>
                  <div className="muted">
                    {l.name} {l.rate_micro ? `· ${pct(l.rate_micro)}` : ''}
                    {l.latest_balance ? ` · ${l.latest_balance.balanced_on}` : ''}
                  </div>
                  <div className="v">{l.latest_balance ? formatCents(l.latest_balance.balance_cents) : '—'}</div>
                  <Button size="mini" style={{ marginTop: 4 }} onClick={() => void updateBalance(l)}>
                    Update balance
                  </Button>
                </div>
              ))}
              <div className="propstat">
                <div className="muted">Equity</div>
                <div className="v">{formatCents(value - debt)}</div>
                {p.liabilities.length === 0 && (
                  <Button size="mini" style={{ marginTop: 4 }} onClick={() => void onAddMortgage(p)}>
                    + Mortgage
                  </Button>
                )}
              </div>
            </div>
            <RealEstateChart property={p} />
          </div>
        )
      })}

      <AddPropertyDialog open={adding} onClose={() => setAdding(false)} onAdded={onAdded} />

      {props && props.length > 0 && (
        <div className="card c12">
          <h2>Worth knowing · §121 exclusion</h2>
          <p>
            If you sell a home you lived in for 2 of the last 5 years, up to $500K of gain (married filing
            jointly) is federally tax-free. Renting it out starts a clock: the exclusion fades ~3 years after
            you move out. Model renting it out on the <Link className="scr-link" to={{ screen: 'goal', rest: ['rental'] }}>Dream Home</Link> page;
            the move-out date and that window are yours to track.
          </p>
        </div>
      )}
    </div>
  )
}
