import { useCallback, useEffect, useState } from 'react'
import { formatCents, parseMoney } from '../../shared/money'
import { get, post, put } from '../api'
import { LineChart } from '../viz'

type Liability = {
  id: number
  name: string
  rate_micro: number | null
  latest_balance: { balanced_on: string; balance_cents: number } | null
  balances: { balanced_on: string; balance_cents: number }[]
}
type Property = {
  id: number
  name: string
  purchased_on: string | null
  purchase_cents: number | null
  latest_valuation: { valued_on: string; value_cents: number; source: string } | null
  valuations: { valued_on: string; value_cents: number }[]
  liabilities: Liability[]
}

const todayIso = () => new Date().toISOString().slice(0, 10)
const pct = (rateMicro: number) => `${(rateMicro / 10000).toFixed(3)}%`

export default function RealEstate() {
  const [props, setProps] = useState<Property[]>([])
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', purchasedOn: '', purchase: '' })
  const [msg, setMsg] = useState<string | null>(null)

  const load = useCallback(() => get<Property[]>('/api/properties').then(setProps).catch(console.error), [])
  useEffect(() => {
    load()
  }, [load])

  async function addProperty() {
    if (!form.name.trim()) return
    try {
      await post('/api/properties', {
        name: form.name,
        purchasedOn: form.purchasedOn || undefined,
        purchaseCents: form.purchase ? parseMoney(form.purchase) : undefined,
      })
      setAdding(false)
      setForm({ name: '', purchasedOn: '', purchase: '' })
      load()
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function updateValuation(p: Property) {
    const v = window.prompt(`Current estimated value for ${p.name} (Zillow or your own estimate):`, '')
    if (!v?.trim()) return
    try {
      await put(`/api/properties/${p.id}/valuation`, { valuedOn: todayIso(), valueCents: parseMoney(v) })
      load()
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function addMortgage(p: Property) {
    const name = window.prompt(`Lender / loan name for ${p.name}:`, 'Mortgage')
    if (!name?.trim()) return
    const rate = window.prompt('Interest rate % (e.g. 3.125) — optional:', '')
    let rateMicro: number | undefined
    if (rate?.trim()) {
      const n = Number(rate)
      if (!Number.isFinite(n) || n < 0 || n > 25) return setMsg('Rate should be a percentage like 3.125')
      rateMicro = Math.round(n * 10000)
    }
    await post('/api/liabilities', { propertyId: p.id, name, rateMicro })
    load()
  }

  async function updateBalance(l: Liability) {
    const v = window.prompt(`Current balance on ${l.name} (from your lender's site):`, '')
    if (!v?.trim()) return
    try {
      await put(`/api/liabilities/${l.id}/balance`, { balancedOn: todayIso(), balanceCents: parseMoney(v) })
      load()
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  return (
    <div className="grid12">
      <div className="card c12">
        <div className="h4row">
          <h2>Properties</h2>
          <div className="right">
            {adding ? (
              <span className="addform">
                <input
                  autoFocus
                  placeholder="e.g. 2847 Foothill Rd — Goleta"
                  style={{ width: 240 }}
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
                <input
                  className="date"
                  type="date"
                  title="purchase date"
                  value={form.purchasedOn}
                  onChange={(e) => setForm({ ...form, purchasedOn: e.target.value })}
                />
                <input
                  className="money"
                  placeholder="purchase price $"
                  value={form.purchase}
                  onChange={(e) => setForm({ ...form, purchase: e.target.value })}
                />
                <button className="btn" onClick={addProperty}>Add</button>
                <button className="btn ghosty" onClick={() => setAdding(false)}>Cancel</button>
              </span>
            ) : (
              <button className="btn" onClick={() => setAdding(true)}>+ Add property</button>
            )}
          </div>
        </div>
        {props.length === 0 && !adding && (
          <p>Add your house: name it, note what you paid, then keep the value and mortgage balance fresh — equity, the net-worth slice, and (in Phase III) the rental scenario all flow from it.</p>
        )}
        {msg && <div className="sub2 importmsg">{msg}</div>}
      </div>

      {props.map((p) => {
        const value = p.latest_valuation?.value_cents ?? p.purchase_cents ?? 0
        const debt = p.liabilities.reduce((s, l) => s + (l.latest_balance?.balance_cents ?? 0), 0)
        const chartMonths = [
          ...new Set([
            ...p.valuations.map((v) => v.valued_on.slice(0, 7)),
            ...p.liabilities.flatMap((l) => l.balances.map((b) => b.balanced_on.slice(0, 7))),
          ]),
        ].sort()
        const valueAt = (m: string) =>
          [...p.valuations].reverse().find((v) => v.valued_on.slice(0, 7) <= m)?.value_cents ??
          p.purchase_cents ??
          0
        const debtAt = (m: string) =>
          p.liabilities.reduce(
            (s, l) => s + ([...l.balances].reverse().find((b) => b.balanced_on.slice(0, 7) <= m)?.balance_cents ?? 0),
            0,
          )
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
                <button className="btn mini" style={{ marginTop: 4 }} onClick={() => updateValuation(p)}>
                  Update value
                </button>
              </div>
              {p.liabilities.map((l) => (
                <div className="propstat" key={l.id}>
                  <div className="muted">
                    {l.name} {l.rate_micro ? `· ${pct(l.rate_micro)}` : ''}
                    {l.latest_balance ? ` · ${l.latest_balance.balanced_on}` : ''}
                  </div>
                  <div className="v">{l.latest_balance ? formatCents(l.latest_balance.balance_cents) : '—'}</div>
                  <button className="btn mini" style={{ marginTop: 4 }} onClick={() => updateBalance(l)}>
                    Update balance
                  </button>
                </div>
              ))}
              <div className="propstat">
                <div className="muted">Equity</div>
                <div className="v gold">{formatCents(value - debt)}</div>
                {p.liabilities.length === 0 && (
                  <button className="btn mini" style={{ marginTop: 4 }} onClick={() => addMortgage(p)}>
                    + Mortgage
                  </button>
                )}
              </div>
            </div>
            {chartMonths.length >= 2 && (
              <LineChart
                labels={chartMonths.map((m) => m.slice(2).replace('-', "/"))}
                series={[
                  { name: 'Est. value', color: 'var(--s1)', values: chartMonths.map(valueAt), area: true },
                  { name: 'Mortgage balance', color: 'var(--s2)', values: chartMonths.map(debtAt) },
                ]}
                h={180}
              />
            )}
          </div>
        )
      })}

      {props.length > 0 && (
        <div className="card c12">
          <h2>Worth knowing · §121 exclusion</h2>
          <p>
            If you sell a home you lived in for 2 of the last 5 years, up to $500K of gain (married filing
            jointly) is federally tax-free. Renting it out starts a clock: the exclusion fades ~3 years after
            you move out. The Dream Home page will track this window once the rental scenario goes live.
          </p>
        </div>
      )}
    </div>
  )
}
