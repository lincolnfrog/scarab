import { useCallback, useEffect, useState, type FormEvent } from 'react'
import type { Capacity, CapacityAccount, CapacityYear } from '../../engine/capacity'
import type { PlannedGain } from '../../engine/planned-sales'
import { NOT_ADVICE } from '../../shared/checkup-api'
import type { InvestAccountRow, PlannedSaleRow, PortfolioPosition, PortfolioResponse } from '../../shared/invest-api'
import { formatCents, formatDollars, formatQtyMicro } from '../../shared/money'
import { del, get, post, put } from '../api'
import { TimeChart, type TMarker, type TSeries } from '../chart/TimeChart'
import '../invest/invest.css'
import { Link } from '../router'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, MoneyInput, QtyInput, Select, TextInput } from '../ui/Field'
import { Stats } from '../ui/Drill'
import { EmptyState } from '../ui/EmptyState'
import { Menu, type MenuItem } from '../ui/Menu'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import './capacity.css'

export type CapacityState = { c: Capacity | null; err: string | null; reload: () => void }

/**
 * The capacity picture, held by the Taxes screen so its overview can
 * summarize it; `version` bumps when the screen reloads (0: the tax picture
 * hasn't loaded, nothing is fetched).
 */
export function useCapacity(version: number): CapacityState {
  const [c, setC] = useState<Capacity | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(() => {
    get<Capacity>('/api/tax/capacity')
      .then((r) => {
        setC(r)
        setErr(null)
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])
  useEffect(() => {
    if (version === 0) return
    load()
  }, [load, version])
  return { c, err, reload: load }
}

const signed = (c: number) => formatDollars(c, { sign: c > 0 })
const tone = (c: number) => (c > 0 ? 'pos' : c < 0 ? 'neg' : undefined)
const sum = (...xs: number[]) => xs.reduce((a, b) => a + b, 0)

/** What one year comes to, in a phrase: room left, or a net gain and its tax. */
export function yearLine(y: CapacityYear): { label: string; value: string; note: string } {
  const net = y.netStCents + y.netLtCents
  if (net > 0) return { label: `Net gain, ${y.year}`, value: formatDollars(net), note: `est. tax on it ${formatDollars(y.capGainsTaxCents)}` }
  return { label: `Room in ${y.year}`, value: formatDollars(y.roomCents), note: y.roomCents > 0 ? 'of losses left for gains before Dec 31' : 'gains and losses net to zero' }
}

/**
 * Loss capacity (Taxes › Loss capacity): the losses a managed strategy has
 * realized and is expected to, against the gains realized and planned, year
 * by year — the chart, the per-year netting, the planned sales (and where
 * to plan one), the managed accounts behind the forecast, and how it was
 * worked out. Everything from GET /api/tax/capacity.
 */
export default function CapacityCard({ cp }: { cp: CapacityState }) {
  const c = cp.c
  if (!c)
    return (
      <div className="card c12">
        <h2>Loss capacity</h2>
        {cp.err ? <p className="sub2">Couldn’t work out the capacity: {cp.err}</p> : <Skeleton h={240} />}
      </div>
    )
  const [thisYear, nextYear] = [c.years[0]!, c.years[1]!]
  const managed = c.accounts.filter((a) => a.profile)
  const nothing = managed.length === 0 && c.sales.length === 0 && c.accounts.every((a) => !a.reported)
  const series: TSeries[] = [
    { id: 'losses', label: 'Losses available', points: c.series.losses, mark: 'line', slot: 1 },
    { id: 'gains', label: 'Gains realized', points: c.series.gains, mark: 'step', slot: 2 },
  ]
  const markers: TMarker[] = c.markers.map((m) => ({ ...m, tone: 'neutral' as const }))
  const plannedTotal = sum(...c.sales.map((s) => s.st_cents + s.lt_cents))
  return (
    <>
      <div className="card c12">
        <div className="h4row">
          <h2>Loss capacity</h2>
          <div className="right">
            <span className="muted">{c.vintage}</span>
          </div>
        </div>
        {nothing ? (
          <EmptyState
            title="Nothing to net yet"
            body="Enter a managed account’s harvest forecast — the Forecast tab in its drawer on Investments — or plan a sale below, and the losses and gains ahead are netted here year by year."
            action={{ label: 'Open Investments', to: '#/invest/accounts' }}
          />
        ) : (
          <>
            <Stats
              items={[
                { ...yearLine(thisYear), note: `${yearLine(thisYear).note}${thisYear.est ? ' · est.' : ''}` },
                { ...yearLine(nextYear), note: `${yearLine(nextYear).note} · est.` },
                {
                  label: `Forecast losses, ${nextYear.year}`,
                  value: formatDollars(-nextYear.forecastCents),
                  note: managed.length ? `from ${managed.map((a) => a.name).join(', ')}` : 'no forecast entered',
                },
                { label: 'Planned sales', value: c.sales.length ? signed(plannedTotal) : 'None', note: c.sales.length ? `${c.sales.length} planned · realized as the lots stand` : 'plan one below' },
              ]}
            />
            <div style={{ marginTop: 14 }}>
              <TimeChart
                ariaLabel="Losses available and gains realized through each tax year, facts solid and the forecast and plan dashed"
                series={series}
                markers={markers}
                unit="cents"
                baseline="zero"
                presets={false}
                scaleToggle={false}
                height={240}
                legendAt="foot"
              />
            </div>
            <p className="sub2" style={{ marginTop: 8 }}>
              Each year starts over from the loss it carried in: the gold line is what the managed accounts have realized (solid) and are
              expected to (dashed); the blue step is what sales realize, recorded and planned. Where the step stays under the line, the
              gains cost nothing.
            </p>
          </>
        )}
      </div>

      <YearsCard years={c.years} />
      <SalesCard sales={c.sales} today={c.today} thisYear={c.thisYear} onChanged={cp.reload} />
      <AccountsCard accounts={c.accounts} years={c.years.map((y) => y.year)} />

      <div className="card c12">
        <h2>How this is worked out</h2>
        <ol className="cap-basis">
          {c.basis.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ol>
        <h3 className="cap-h3">What it leaves out</h3>
        <ul className="cap-basis">
          {c.leavesOut.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
        <p className="sub2" style={{ marginTop: 12 }}>{NOT_ADVICE}</p>
      </div>
    </>
  )
}

/* ---------- the years ---------- */

function YearsCard({ years }: { years: readonly CapacityYear[] }) {
  return (
    <div className="card c12">
      <h2>Year by year</h2>
      <div className="inv-tablewrap">
        <table className="cap-years">
          <thead>
            <tr>
              <th>Year</th>
              <th className="r">Gains</th>
              <th className="r">Losses</th>
              <th className="r">Carried in</th>
              <th className="r">Net taxable</th>
              <th className="r">Tax on it</th>
              <th className="r">Carries out</th>
            </tr>
          </thead>
          <tbody>
            {years.map((y) => {
              const gains = y.salesStCents + y.salesLtCents + y.plannedStCents + y.plannedLtCents
              const planned = y.plannedStCents + y.plannedLtCents
              const losses = y.reportedCents + y.forecastCents
              const net = y.netStCents + y.netLtCents
              return (
                <tr key={y.year}>
                  <td>
                    {y.year}
                    {y.est && <span className="cap-est">est.</span>}
                  </td>
                  <td className={`r num ${tone(gains) ?? ''}`}>
                    {signed(gains)}
                    {planned !== 0 && <span className="inv-subline">{signed(planned)} planned</span>}
                  </td>
                  <td className={`r num ${tone(losses) ?? ''}`}>
                    {signed(losses)}
                    {y.forecastCents !== 0 && <span className="inv-subline">{signed(y.forecastCents)} forecast</span>}
                  </td>
                  <td className="r num">{y.carryInStCents + y.carryInLtCents > 0 ? `−${formatDollars(y.carryInStCents + y.carryInLtCents)}` : '—'}</td>
                  <td className={`r num ${tone(net) ?? ''}`}>{net > 0 ? formatDollars(net) : '—'}</td>
                  <td className="r num">{formatDollars(y.capGainsTaxCents, { sign: y.capGainsTaxCents < 0 })}</td>
                  <td className="r num">{y.roomCents > 0 ? formatDollars(y.roomCents) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="sub2" style={{ marginTop: 8 }}>
        Gains are recorded sales plus the plan; losses what brokers reported plus the forecast. Short nets against long; a net loss takes
        $3,000 off ordinary income and the rest carries into the next year. “Tax on it” is the year’s bill with the capital side against
        without it, on this year’s brackets.
      </p>
    </div>
  )
}

/* ---------- planned sales ---------- */

type SaleForm = { id: number | null; accountId: number | null; assetId: number | null; qtyMicro: number | null; plannedOn: string; priceCents: number | null; note: string }
const blankSale = (thisYear: number): SaleForm => ({ id: null, accountId: null, assetId: null, qtyMicro: null, plannedOn: `${thisYear + 1}-01-04`, priceCents: null, note: '' })
const editSale = (s: PlannedSaleRow): SaleForm => ({ id: s.id, accountId: s.invest_account_id, assetId: s.asset_id, qtyMicro: s.qty_micro, plannedOn: s.planned_on, priceCents: s.price_cents, note: s.note ?? '' })

/** How many of an asset a lots account holds, from the portfolio's per-account rows. */
export const heldIn = (p: PortfolioPosition, accountId: number): number => p.accounts.find((a) => a.invest_account_id === accountId)?.qty_micro ?? 0

function SalesCard({ sales, today, thisYear, onChanged }: { sales: readonly PlannedGain[]; today: string; thisYear: number; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<InvestAccountRow[] | null>(null)
  const [positions, setPositions] = useState<PortfolioPosition[] | null>(null)
  const [form, setForm] = useState<SaleForm>(() => blankSale(thisYear))
  const [open, setOpen] = useState(false)
  const set = (f: Partial<SaleForm>) => setForm((x) => ({ ...x, ...f }))
  useEffect(() => {
    if (!open || accounts) return
    let live = true
    Promise.all([get<InvestAccountRow[]>('/api/invest/accounts'), get<PortfolioResponse>('/api/portfolio')])
      .then(([a, p]) => {
        if (!live) return
        setAccounts(a)
        setPositions(p.positions)
      })
      .catch(() => live && setAccounts([]))
    return () => {
      live = false
    }
  }, [open, accounts])

  // Taxable lots accounts holding something: the only place a sale can be planned from.
  const sellable = (accounts ?? []).filter((a) => a.tracking === 'lots' && a.kind !== 'retirement' && (positions ?? []).some((p) => heldIn(p, a.id) > 0))
  const held = (positions ?? []).filter((p) => form.accountId !== null && heldIn(p, form.accountId) > 0)
  const chosen = held.find((p) => p.asset_id === form.assetId) ?? null
  const otherPlanned = sum(...sales.filter((s) => s.id !== form.id && s.invest_account_id === form.accountId && s.asset_id === form.assetId).map((s) => s.qty_micro))
  const available = chosen && form.accountId !== null ? heldIn(chosen, form.accountId) - otherPlanned : 0
  const ready = form.accountId !== null && form.assetId !== null && form.qtyMicro !== null && form.qtyMicro > 0 && form.plannedOn > today

  const save = useAction(
    (f: SaleForm) => {
      const body = { investAccountId: f.accountId, assetId: f.assetId, plannedOn: f.plannedOn, qtyMicro: f.qtyMicro, priceCents: f.priceCents, note: f.note.trim() || null }
      return f.id === null
        ? post<{ ok: true; row: PlannedSaleRow }>('/api/invest/planned-sales', body)
        : put<{ ok: true; changed: boolean; row: PlannedSaleRow }>(`/api/invest/planned-sales/${f.id}`, body)
    },
    {
      success: (r) => `Planned: sell ${formatQtyMicro(r.row.qty_micro)} ${r.row.symbol} on ${r.row.planned_on} — capacity recomputed`,
      errorPrefix: 'Couldn’t save the plan',
      onDone: () => {
        setForm(blankSale(thisYear))
        setOpen(false)
        onChanged()
      },
    },
  )
  const remove = useAction((s: PlannedGain) => del(`/api/invest/planned-sales/${s.id}`).then(() => s), {
    success: (s) => `Dropped the plan to sell ${formatQtyMicro(s.qty_micro)} ${s.symbol}`,
    errorPrefix: 'Couldn’t remove the plan',
    onDone: onChanged,
  })
  async function askRemove(s: PlannedGain) {
    const ok = await confirm({
      title: `Drop the plan to sell ${formatQtyMicro(s.qty_micro)} ${s.symbol}?`,
      body: `${s.account}, ${s.planned_on}. Nothing recorded changes; the capacity view recomputes without it.`,
      confirmLabel: 'Drop plan',
      danger: true,
    })
    if (ok) void remove.run(s)
  }
  function submit(e: FormEvent) {
    e.preventDefault()
    if (ready) void save.run(form)
  }
  const startEdit = (s: PlannedGain) => {
    setForm(editSale(s))
    setOpen(true)
  }

  return (
    <div className="card c6">
      <div className="h4row">
        <h2>Planned sales</h2>
        <div className="right">
          {!open && (
            <Button size="mini" variant="gold" onClick={() => setOpen(true)}>
              + Plan a sale
            </Button>
          )}
        </div>
      </div>
      {sales.length === 0 && !open ? (
        <p className="sub2">
          Nothing planned. A planned sale — so many shares of a holding, on a day ahead — is priced off the lots as they stand and netted
          against the losses expected by then, so “25 BTC in January” gets a number before January.
        </p>
      ) : (
        sales.length > 0 && (
          <div className="inv-tablewrap">
            <table className="cap-sales">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Sell</th>
                  <th className="r">Proceeds</th>
                  <th className="r">Gain</th>
                  <th className="inv-actcol"><span className="ui-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sales.map((s) => {
                  const items: MenuItem[] = [
                    { label: 'Edit…', onSelect: () => startEdit(s) },
                    { label: 'Drop plan…', danger: true, disabled: remove.busy, onSelect: () => void askRemove(s) },
                  ]
                  const gain = s.st_cents + s.lt_cents
                  return (
                    <tr key={s.id}>
                      <td>
                        {s.planned_on}
                        {s.note && <span className="inv-subline inv-subwrap">{s.note}</span>}
                      </td>
                      <td>
                        {formatQtyMicro(s.qty_micro)} {s.symbol}
                        <span className="inv-subline">
                          {s.account} · {s.price_source === 'typed' ? `at ${formatCents(s.price_used_cents!)}` : s.price_source === 'quote' ? `at ${formatCents(s.price_used_cents!)} (${s.priced_on})` : 'no price'}
                        </span>
                      </td>
                      <td className="r num">{formatDollars(s.proceeds_cents)}</td>
                      <td className={`r num ${tone(gain) ?? ''}`}>
                        {signed(gain)}
                        {s.warnings.length > 0 && (
                          <Tooltip content={s.warnings.join(' ')}>
                            <span className="cap-warn" role="img" aria-label="Warning">
                              {' '}
                              ⚠
                            </span>
                          </Tooltip>
                        )}
                        <span className="inv-subline">
                          {s.lt_cents !== 0 && `LT ${signed(s.lt_cents)}`}
                          {s.lt_cents !== 0 && s.st_cents !== 0 && ' · '}
                          {s.st_cents !== 0 && `ST ${signed(s.st_cents)}`}
                        </span>
                      </td>
                      <td className="r">
                        <Menu label={`${s.symbol} plan actions`} items={items} align="end" />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      )}
      {open && (
        <form className="cap-form" onSubmit={submit}>
          <div className="inv-formtitle">{form.id === null ? 'Plan a sale' : 'Edit the plan'}</div>
          {accounts === null ? (
            <Skeleton h={60} />
          ) : sellable.length === 0 ? (
            <p className="sub2">No taxable account holds anything to plan a sale from — record holdings on Investments first.</p>
          ) : (
            <FieldGrid min={150}>
              <Field label="From">
                <Select value={form.accountId ?? ''} onChange={(e) => set({ accountId: e.target.value ? Number(e.target.value) : null, assetId: null })}>
                  <option value="">Choose an account…</option>
                  {sellable.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Holding">
                <Select value={form.assetId ?? ''} disabled={form.accountId === null} onChange={(e) => set({ assetId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Choose a holding…</option>
                  {held.map((p) => (
                    <option key={p.asset_id} value={p.asset_id}>
                      {p.symbol} · holds {formatQtyMicro(heldIn(p, form.accountId!))}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Shares" hint={chosen ? `up to ${formatQtyMicro(Math.max(0, available))}${otherPlanned ? ' not yet planned' : ''}` : undefined}>
                <QtyInput valueMicro={form.qtyMicro} placeholder="0" onChange={(qtyMicro) => set({ qtyMicro })} />
              </Field>
              <Field label="On" hint="a day ahead">
                <DateInput value={form.plannedOn} min={today} onChange={(plannedOn) => set({ plannedOn })} />
              </Field>
              <Field label="Price per share" hint={chosen?.price_cents ? `blank = the latest quote, ${formatCents(chosen.price_cents)}` : 'blank = the latest quote'}>
                <MoneyInput value={form.priceCents} placeholder="market" onChange={(priceCents) => set({ priceCents })} />
              </Field>
              <Field label="Note" hint="optional">
                <TextInput value={form.note} maxLength={120} placeholder="e.g. January tranche" onChange={(e) => set({ note: e.target.value })} />
              </Field>
            </FieldGrid>
          )}
          <div className="inv-actions">
            <Button type="submit" busy={save.busy} disabled={!ready}>
              {form.id === null ? 'Plan it' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setForm(blankSale(thisYear))
                setOpen(false)
              }}
            >
              Cancel
            </Button>
            <span className="inv-note">Nothing is recorded: a plan only shapes the forecast until you sell.</span>
          </div>
        </form>
      )}
    </div>
  )
}

/* ---------- the managed accounts ---------- */

function AccountsCard({ accounts, years }: { accounts: readonly CapacityAccount[]; years: readonly number[] }) {
  return (
    <div className="card c6">
      <h2>Managed accounts</h2>
      {accounts.length === 0 ? (
        <p className="sub2">
          No taxable account is tracked by balance. A managed strategy — a long/short book realizing losses while its market exposure
          rides — is one; add it on Investments, tracked by balance, and report the losses its broker shows.
        </p>
      ) : (
        <div className="cap-list">
          {accounts.map((a) => {
            const drawer = (tab: string) => ({ screen: 'invest' as const, params: { d: 'account', acct: a.accountId, tab } })
            const planned = a.flows.filter((f) => f.planned)
            return (
              <div key={a.accountId} className="cap-item">
                <div className="cap-item-head">
                  <b>{a.name}</b>
                  <span className="muted">
                    {a.balanceCents !== null ? `${formatCents(a.balanceCents)} as of ${a.balanceOn}` : 'no balance recorded'}
                  </span>
                </div>
                <span className="muted">
                  {a.reported ? (
                    <>
                      Reported {signed(a.reported.cents)} through {a.reported.asOf}
                    </>
                  ) : (
                    <>
                      Nothing reported this year — <Link className="scr-link" to={drawer('realized')}>report its realized gains</Link>
                    </>
                  )}
                  {' · '}
                  {a.flows.length ? (
                    <Link className="scr-link" to={drawer('flows')}>
                      {a.flows.length} deposit{a.flows.length === 1 ? '' : 's'}
                      {planned.length ? `, ${planned.length} planned` : ''}
                    </Link>
                  ) : (
                    <Link className="scr-link" to={drawer('flows')}>
                      record its deposits
                    </Link>
                  )}
                </span>
                {a.profile ? (
                  <>
                    <div className="cap-chips">
                      {years.map((y) => (
                        <span key={y}>
                          {y} {formatDollars(a.byYear.find((b) => b.year === y)?.cents ?? 0)}
                        </span>
                      ))}
                    </div>
                    <span className="muted">
                      Expected further losses by year — <Link className="scr-link" to={drawer('harvest')}>the manager’s estimate</Link>
                      {a.profile.source ? ` (${a.profile.source})` : ''}, given {a.profile.as_of}
                    </span>
                  </>
                ) : (
                  <span className="muted">
                    <Link className="scr-link" to={drawer('harvest')}>
                      Enter the manager’s forecast
                    </Link>{' '}
                    to expect anything beyond what is reported.
                  </span>
                )}
                {a.notes.length > 0 && (
                  <ul className="cap-notes">
                    {a.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

