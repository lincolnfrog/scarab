import { useCallback, useEffect, useRef, useState } from 'react'
import { formatCents, formatQtyMicro, parseMoney, parseQtyMicro } from '../../shared/money'
import { del, get, patch, post, put } from '../api'
import BigChart, { type ChartData } from '../BigChart'

type InvestAccount = {
  id: number
  name: string
  kind: 'brokerage' | 'retirement' | 'crypto'
  tracking: 'lots' | 'balance'
  stock_plan: number
  latest_snapshot: { balanced_on: string; balance_cents: number } | null
  counts: { trades: number; balances: number; unvested: number; paychecks: number }
}
type PosLot = { trade_id?: number; opened_on: string; qty_micro: number; cost_cents: number }
type Position = {
  symbol: string
  kind: 'stock' | 'crypto'
  qty_micro: number
  cost_cents: number
  price_cents: number | null
  priced_on: string | null
  value_cents: number
  unrealized_cents: number
  lots: PosLot[]
}
type Portfolio = {
  positions: Position[]
  totals: { value: number; cost: number; unrealized: number; ytd_st: number; ytd_lt: number }
  warnings: string[]
}
type Unvested = {
  invest_account_id: number
  asset_id: number
  symbol: string
  account_name: string
  qty_micro: number
  updated_on: string
  next_vest_on: string | null
  vest_every_months: number | null
  vest_qty_micro: number | null
  price_cents: number | null
  est_cents: number | null
}
type UnvestedList = { rows: Unvested[]; total_est_cents: number }

const todayIso = () => new Date().toISOString().slice(0, 10)
const plural = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)
const perShare = (costCents: number, qtyMicro: number) => Math.round(costCents / (qtyMicro / 1_000_000))

export default function Invest() {
  const [accounts, setAccounts] = useState<InvestAccount[]>([])
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [unvested, setUnvested] = useState<UnvestedList>({ rows: [], total_est_cents: 0 })
  const [msg, setMsg] = useState<string | null>(null)
  const [addingAccount, setAddingAccount] = useState(false)
  const [acctForm, setAcctForm] = useState({ name: '', kind: 'brokerage', tracking: 'lots', stockPlan: false })
  const [editAcct, setEditAcct] = useState<{ id: number; name: string; stockPlan: boolean } | null>(null)
  const [deleteAcct, setDeleteAcct] = useState<{ acct: InvestAccount; typed: string } | null>(null)
  const [trade, setTrade] = useState({
    investAccountId: 0,
    symbol: '',
    assetKind: 'stock',
    side: 'buy',
    tradedOn: todayIso(),
    qty: '',
    total: '',
    lotChoice: 'fifo' as 'fifo' | 'manual' | number,
    acquiredOn: '',
    basisPerShare: '',
  })
  const [openLots, setOpenLots] = useState<Set<string>>(new Set())
  const [unvestedForm, setUnvestedForm] = useState({
    investAccountId: 0, symbol: '', qty: '', nextVestOn: '', vestEveryMonths: '3', vestQty: '',
  })
  const [vesting, setVesting] = useState<{ row: Unvested; qty: string; date: string; total: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const autoRefreshed = useRef(false)
  const [taxMarginal, setTaxMarginal] = useState<{ stMicro: number; ltMicro: number } | null>(null)
  const [chartSymbol, setChartSymbol] = useState<string | null>(null)
  const [charts, setCharts] = useState<Record<string, ChartData>>({})

  const load = useCallback(async () => {
    const [a, p, u] = await Promise.all([
      get<InvestAccount[]>('/api/invest/accounts'),
      get<Portfolio>('/api/portfolio'),
      get<UnvestedList>('/api/unvested'),
    ])
    setAccounts(a)
    setPortfolio(p)
    setUnvested(u)
    get<{ marginal: { stMicro: number; ltMicro: number } }>('/api/tax')
      .then((t) => setTaxMarginal(t.marginal))
      .catch(() => setTaxMarginal(null))
    const firstLots = a.find((x) => x.tracking === 'lots')?.id ?? 0
    const firstPlan = a.find((x) => x.tracking === 'lots' && x.stock_plan === 1)?.id ?? 0
    setTrade((t) => ({ ...t, investAccountId: a.some((x) => x.id === t.investAccountId) ? t.investAccountId : firstLots }))
    setUnvestedForm((f) => ({
      ...f,
      investAccountId: a.some((x) => x.id === f.investAccountId && x.stock_plan === 1) ? f.investAccountId : firstPlan,
    }))
    return p
  }, [])

  const refreshPrices = useCallback(async () => {
    setRefreshing(true)
    try {
      const r = await post<{ updated: number; errors: string[] }>('/api/prices/refresh', {})
      setMsg(
        `Prices updated for ${r.updated} asset${r.updated === 1 ? '' : 's'}${r.errors.length ? ` · ${r.errors.join(' · ')}` : ''}`,
      )
      await load()
    } catch (e) {
      setMsg(`Price refresh failed — ${e instanceof Error ? e.message : e}`)
    } finally {
      setRefreshing(false)
    }
  }, [load])

  useEffect(() => {
    load()
      .then((p) => {
        // Prices go stale the moment the screen is older than its data — fetch
        // automatically once per visit instead of waiting for the button.
        const stale = p.positions.length > 0 && p.positions.some((x) => !x.priced_on || x.priced_on < todayIso())
        if (stale && !autoRefreshed.current) {
          autoRefreshed.current = true
          refreshPrices()
        }
      })
      .catch(console.error)
  }, [load, refreshPrices])

  async function addAccount() {
    if (!acctForm.name.trim()) return
    setMsg(null)
    try {
      await post('/api/invest/accounts', { ...acctForm, stockPlan: acctForm.tracking === 'lots' && acctForm.stockPlan })
      setAddingAccount(false)
      setAcctForm({ name: '', kind: 'brokerage', tracking: 'lots', stockPlan: false })
      load().catch(console.error)
    } catch (e) {
      setMsg(`Could not add the account — ${e instanceof Error ? e.message : e}`)
    }
  }

  async function saveAccount() {
    if (!editAcct?.name.trim()) return
    setMsg(null)
    try {
      await patch(`/api/invest/accounts/${editAcct.id}`, { name: editAcct.name, stockPlan: editAcct.stockPlan })
      setEditAcct(null)
      load().catch(console.error)
    } catch (e) {
      setMsg(`Could not save the account — ${e instanceof Error ? e.message : e}`)
    }
  }

  async function removeAccount() {
    if (!deleteAcct) return
    setMsg(null)
    try {
      const r = await del<{ name: string; removed: { trades: number; balances: number; unvested: number }; unlinkedPaychecks: number }>(
        `/api/invest/accounts/${deleteAcct.acct.id}`,
      )
      const bits = [
        plural(r.removed.trades, 'trade'),
        plural(r.removed.balances, 'balance update'),
        plural(r.removed.unvested, 'unvested grant'),
      ].filter(Boolean)
      setMsg(
        (bits.length ? `Deleted “${r.name}” and ${bits.join(', ')}.` : `Deleted “${r.name}”.`) +
          (r.unlinkedPaychecks ? ` ${plural(r.unlinkedPaychecks, 'paycheck')} lost the stock-comp link.` : ''),
      )
      setDeleteAcct(null)
      setEditAcct(null)
      load().catch(console.error)
    } catch (e) {
      setMsg(`Could not delete the account — ${e instanceof Error ? e.message : e}`)
    }
  }

  async function recordTrade() {
    setMsg(null)
    try {
      const extra: Record<string, unknown> = {}
      if (trade.side === 'sell' && trade.lotChoice === 'manual') {
        if (!trade.acquiredOn || !trade.basisPerShare) throw new Error('acquisition date and basis/share required')
        extra.acquiredOn = trade.acquiredOn
        extra.basisCents = Math.round((parseMoney(trade.basisPerShare) * parseQtyMicro(trade.qty)) / 1_000_000)
      } else if (trade.side === 'sell' && typeof trade.lotChoice === 'number') {
        extra.soldLotTradeId = trade.lotChoice
      }
      await post('/api/trades', {
        investAccountId: trade.investAccountId,
        symbol: trade.symbol,
        assetKind: trade.assetKind,
        side: trade.side,
        tradedOn: trade.tradedOn,
        qty: trade.qty,
        totalCents: parseMoney(trade.total),
        ...extra,
      })
      setMsg(`Recorded: ${trade.side} ${trade.qty} ${trade.symbol.toUpperCase()} for ${trade.total}`)
      setTrade((t) => ({ ...t, symbol: '', qty: '', total: '', lotChoice: 'fifo', acquiredOn: '', basisPerShare: '' }))
      load().catch(console.error)
    } catch (e) {
      setMsg(`Could not record trade — ${e instanceof Error ? e.message : e}`)
    }
  }

  async function snapshotBalance(a: InvestAccount) {
    const v = window.prompt(`Current balance for ${a.name} (from the provider's site):`, '')
    if (!v?.trim()) return
    try {
      await put('/api/invest/balances', { investAccountId: a.id, balancedOn: todayIso(), balanceCents: parseMoney(v) })
      load().catch(console.error)
    } catch (e) {
      setMsg(`Bad amount — ${e instanceof Error ? e.message : e}`)
    }
  }

  async function setUnvestedQty() {
    setMsg(null)
    try {
      const f = unvestedForm
      const scheduled = f.nextVestOn.trim() !== ''
      await put('/api/unvested', {
        investAccountId: f.investAccountId,
        symbol: f.symbol,
        qty: f.qty,
        // date given → set the cadence; date blank with shares/cadence blank too → leave it alone
        ...(scheduled
          ? { nextVestOn: f.nextVestOn, vestEveryMonths: Number(f.vestEveryMonths), vestQty: f.vestQty }
          : f.vestQty.trim() === '' ? {} : { nextVestOn: '' }),
      })
      setMsg(
        f.qty.trim() === '0'
          ? `Cleared unvested ${f.symbol.toUpperCase()}`
          : `Unvested ${f.symbol.toUpperCase()} set to ${f.qty} shares${scheduled ? ` · ${f.vestQty} every ${f.vestEveryMonths} mo from ${f.nextVestOn}` : ''}`,
      )
      setUnvestedForm((f) => ({ ...f, symbol: '', qty: '', nextVestOn: '', vestQty: '' }))
      load().catch(console.error)
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  async function recordVest() {
    if (!vesting) return
    setMsg(null)
    try {
      const r = await post<{ ok: true; remainingQtyMicro: number }>('/api/unvested/vest', {
        investAccountId: vesting.row.invest_account_id,
        symbol: vesting.row.symbol,
        qty: vesting.qty,
        tradedOn: vesting.date,
        totalCents: parseMoney(vesting.total),
      })
      setMsg(
        `Vested ${vesting.qty} ${vesting.row.symbol} — recorded as a buy · ${formatQtyMicro(r.remainingQtyMicro)} still unvested`,
      )
      setVesting(null)
      load().catch(console.error)
    } catch (e) {
      setMsg(`${e instanceof Error ? e.message : e}`)
    }
  }

  useEffect(() => {
    if (!portfolio || portfolio.positions.length === 0) return
    setChartSymbol((cur) => cur ?? (portfolio.positions.some((p) => p.symbol === 'BTC') ? 'BTC' : portfolio.positions[0]!.symbol))
  }, [portfolio])
  useEffect(() => {
    if (!chartSymbol || charts[chartSymbol]) return
    get<ChartData>(`/api/charts/${chartSymbol}`)
      .then((d) => setCharts((c) => ({ ...c, [chartSymbol]: d })))
      .catch(console.error)
  }, [chartSymbol, charts])

  const lotAccounts = accounts.filter((a) => a.tracking === 'lots')
  const planAccounts = lotAccounts.filter((a) => a.stock_plan === 1)
  const sellableLots =
    trade.side === 'sell'
      ? (portfolio?.positions.find((p) => p.symbol === trade.symbol.trim().toUpperCase())?.lots.filter((l) => l.trade_id) ?? [])
      : []
  const pricedOn = portfolio?.positions.find((p) => p.priced_on)?.priced_on

  return (
    <div className="grid12">
      {/* ---------- accounts ---------- */}
      <div className="card c12">
        <div className="h4row">
          <h2>Accounts</h2>
          <div className="right">
            {pricedOn && <span className="muted">prices as of {pricedOn}</span>}
            <button className="btn mini" disabled={refreshing} onClick={refreshPrices}>
              {refreshing ? 'Refreshing…' : 'Refresh prices'}
            </button>
          </div>
        </div>
        <div className="importbar">
          {accounts.length === 0 && !addingAccount && (
            <span className="sub2">
              Add your brokerage/Coinbase (tracked by trades) and 401(k)s (tracked by balance) →
            </span>
          )}
          {accounts.map((a) =>
            editAcct?.id === a.id ? (
              <span key={a.id} className="addform">
                <input
                  autoFocus
                  value={editAcct.name}
                  onChange={(e) => setEditAcct({ ...editAcct, name: e.target.value })}
                />
                {a.tracking === 'lots' && (
                  <label className="checkline" title="Grants that vest into this account — adds the unvested-RSU tracker">
                    <input
                      type="checkbox"
                      checked={editAcct.stockPlan}
                      onChange={(e) => setEditAcct({ ...editAcct, stockPlan: e.target.checked })}
                    />
                    employee stock plan
                  </label>
                )}
                <button className="btn" onClick={saveAccount}>Save</button>
                <button className="btn ghosty" onClick={() => setEditAcct(null)}>Cancel</button>
                <button
                  className="btn danger"
                  onClick={() => setDeleteAcct({ acct: a, typed: '' })}
                >
                  Delete…
                </button>
              </span>
            ) : (
              <span key={a.id} className="chipbtn" style={{ cursor: 'default' }}>
                {a.name} <span className="muted">· {a.kind}{a.stock_plan === 1 ? ' · stock plan' : ''}</span>
                {a.tracking === 'balance' && (
                  <>
                    {' '}
                    <b className="inkstrong">{a.latest_snapshot ? formatCents(a.latest_snapshot.balance_cents) : '—'}</b>
                    <button className="btn mini" style={{ marginLeft: 6 }} onClick={() => snapshotBalance(a)}>
                      update
                    </button>
                  </>
                )}
                <button
                  className="btn mini"
                  style={{ marginLeft: 6 }}
                  title="Rename, mark as an employee stock plan, or delete"
                  onClick={() => {
                    setDeleteAcct(null)
                    setEditAcct({ id: a.id, name: a.name, stockPlan: a.stock_plan === 1 })
                  }}
                >
                  edit
                </button>
              </span>
            ),
          )}
          {addingAccount ? (
            <span className="addform">
              <input
                autoFocus
                placeholder="e.g. Broker — RSUs"
                value={acctForm.name}
                onChange={(e) => setAcctForm({ ...acctForm, name: e.target.value })}
              />
              <select value={acctForm.kind} onChange={(e) => setAcctForm({ ...acctForm, kind: e.target.value })}>
                <option value="brokerage">brokerage</option>
                <option value="retirement">retirement</option>
                <option value="crypto">crypto</option>
              </select>
              <select
                value={acctForm.tracking}
                onChange={(e) => setAcctForm({ ...acctForm, tracking: e.target.value })}
                title="lots = you enter each trade · balance = you enter a total now and then"
              >
                <option value="lots">track trades</option>
                <option value="balance">track balance</option>
              </select>
              {acctForm.tracking === 'lots' && (
                <label
                  className="checkline"
                  title="Tick this only for the account your employer's grants vest into — it adds the unvested-RSU tracker"
                >
                  <input
                    type="checkbox"
                    checked={acctForm.stockPlan}
                    onChange={(e) => setAcctForm({ ...acctForm, stockPlan: e.target.checked })}
                  />
                  employee stock plan
                </label>
              )}
              <button className="btn" onClick={addAccount}>Add</button>
              <button className="btn ghosty" onClick={() => setAddingAccount(false)}>Cancel</button>
            </span>
          ) : (
            <button className="chipbtn" onClick={() => setAddingAccount(true)}>+ account</button>
          )}
        </div>
        {deleteAcct && (
          <div className="dangerbox">
            <b className="inkstrong">Delete “{deleteAcct.acct.name}”?</b>
            <p className="sub2">
              {plural(deleteAcct.acct.counts.trades, 'trade') ||
              plural(deleteAcct.acct.counts.balances, 'balance update') ||
              plural(deleteAcct.acct.counts.unvested, 'unvested grant')
                ? `This also deletes ${[
                    plural(deleteAcct.acct.counts.trades, 'trade'),
                    plural(deleteAcct.acct.counts.balances, 'balance update'),
                    plural(deleteAcct.acct.counts.unvested, 'unvested grant'),
                  ]
                    .filter(Boolean)
                    .join(', ')}. Holdings, net worth and the tax picture recompute without them.`
                : 'Nothing has been recorded against it yet.'}
              {deleteAcct.acct.counts.paychecks > 0 &&
                ` ${plural(deleteAcct.acct.counts.paychecks, 'paycheck')} will lose the stock-comp link.`}{' '}
              There is no undo — export from the Vault first if you want a way back.
            </p>
            <div className="formrow">
              <span className="sub2">
                Type <b className="inkstrong">delete</b> to confirm:
              </span>
              <input
                autoFocus
                placeholder="delete"
                value={deleteAcct.typed}
                onChange={(e) => setDeleteAcct({ ...deleteAcct, typed: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && deleteAcct.typed.trim().toLowerCase() === 'delete') removeAccount()
                }}
              />
              <button
                className="btn danger"
                disabled={deleteAcct.typed.trim().toLowerCase() !== 'delete'}
                onClick={removeAccount}
              >
                Delete account
              </button>
              <button className="btn ghosty" onClick={() => setDeleteAcct(null)}>Cancel</button>
            </div>
          </div>
        )}
        {msg && <div className="sub2 importmsg">{msg}</div>}
      </div>

      {/* ---------- record a trade ---------- */}
      {lotAccounts.length > 0 && (
        <div className="card c12">
          <h2>Record a trade</h2>
          <div className="formrow">
            <select
              value={trade.investAccountId}
              onChange={(e) => setTrade({ ...trade, investAccountId: Number(e.target.value) })}
            >
              {lotAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <select value={trade.side} onChange={(e) => setTrade({ ...trade, side: e.target.value, lotChoice: 'fifo' })}>
              <option value="buy">Buy</option>
              <option value="sell">Sell</option>
            </select>
            <input
              className="sym"
              placeholder="VTI"
              value={trade.symbol}
              onChange={(e) => setTrade({ ...trade, symbol: e.target.value })}
            />
            <select value={trade.assetKind} onChange={(e) => setTrade({ ...trade, assetKind: e.target.value })}>
              <option value="stock">stock/ETF</option>
              <option value="crypto">crypto</option>
            </select>
            <input
              className="qty"
              placeholder="qty (10 or 0.05)"
              value={trade.qty}
              onChange={(e) => setTrade({ ...trade, qty: e.target.value })}
            />
            <input
              className="money"
              placeholder={trade.side === 'buy' ? 'total paid $' : 'total received $'}
              value={trade.total}
              onChange={(e) => setTrade({ ...trade, total: e.target.value })}
            />
            <input
              className="date"
              type="date"
              value={trade.tradedOn}
              onChange={(e) => setTrade({ ...trade, tradedOn: e.target.value })}
            />
            {trade.side === 'sell' && (
              <select
                value={typeof trade.lotChoice === 'number' ? String(trade.lotChoice) : trade.lotChoice}
                onChange={(e) => {
                  const v = e.target.value
                  setTrade({ ...trade, lotChoice: v === 'fifo' || v === 'manual' ? v : Number(v) })
                }}
                title="Which shares are being sold"
              >
                <option value="fifo">Lots: oldest first (FIFO)</option>
                {sellableLots.map((l) => (
                  <option key={l.trade_id} value={l.trade_id}>
                    lot {l.opened_on} · {formatQtyMicro(l.qty_micro)} sh · {formatCents(perShare(l.cost_cents, l.qty_micro))}/sh
                  </option>
                ))}
                <option value="manual">shares not tracked — enter basis</option>
              </select>
            )}
            {trade.side === 'sell' && trade.lotChoice === 'manual' && (
              <>
                <input
                  className="date"
                  type="date"
                  title="when those shares were acquired/vested"
                  value={trade.acquiredOn}
                  onChange={(e) => setTrade({ ...trade, acquiredOn: e.target.value })}
                />
                <input
                  className="money"
                  placeholder="basis $/share"
                  value={trade.basisPerShare}
                  onChange={(e) => setTrade({ ...trade, basisPerShare: e.target.value })}
                />
              </>
            )}
            <button className="btn gold" onClick={recordTrade} disabled={!trade.symbol || !trade.qty || !trade.total}>
              Record
            </button>
          </div>
          <div className="sub2" style={{ marginTop: 8 }}>
            Total includes fees — it's what actually left or entered the account. Selling? Pick the exact lot, or
            “enter basis” for shares whose history predates Scarab.
          </div>
        </div>
      )}

      {/* ---------- unvested RSUs (employee stock plans only) ---------- */}
      {planAccounts.length > 0 && (
        <div className="card c12">
          <div className="h4row">
            <h2>Unvested RSUs</h2>
            <div className="right">
              {unvested.total_est_cents > 0 && (
                <span className="sub2">
                  ≈ <b className="inkstrong">{formatCents(unvested.total_est_cents)}</b> at today's price · not
                  counted in net worth
                </span>
              )}
            </div>
          </div>
          <div className="formrow">
            <select
              value={unvestedForm.investAccountId}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, investAccountId: Number(e.target.value) })}
            >
              {planAccounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
            <input
              className="sym"
              placeholder="TICKER"
              value={unvestedForm.symbol}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, symbol: e.target.value })}
            />
            <input
              className="qty"
              placeholder="total shares"
              value={unvestedForm.qty}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, qty: e.target.value })}
            />
            <span className="sub2">vesting</span>
            <input
              className="qty"
              placeholder="shares per vest"
              title="Optional cadence — lets Taxes project the rest of this year's vests into income"
              value={unvestedForm.vestQty}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, vestQty: e.target.value })}
            />
            <span className="sub2">every</span>
            <select
              value={unvestedForm.vestEveryMonths}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, vestEveryMonths: e.target.value })}
            >
              <option value="1">month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">year</option>
            </select>
            <span className="sub2">next on</span>
            <input
              className="date"
              type="date"
              title="Next vest date — leave blank to keep whatever cadence is already set"
              value={unvestedForm.nextVestOn}
              onChange={(e) => setUnvestedForm({ ...unvestedForm, nextVestOn: e.target.value })}
            />
            <button
              className="btn"
              disabled={!unvestedForm.symbol || !unvestedForm.qty || (!!unvestedForm.nextVestOn && !unvestedForm.vestQty)}
              onClick={setUnvestedQty}
            >
              Set
            </button>
          </div>
          {unvested.rows.length > 0 && (
            <table style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>Asset</th><th>Account</th><th className="r">Unvested shares</th>
                  <th className="r">Est. value today</th><th>Schedule</th><th>Updated</th><th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {unvested.rows.map((u) => (
                  <tr key={`${u.invest_account_id}-${u.asset_id}`}>
                    <td><span className="tk"><span className="lg">{u.symbol}</span></span></td>
                    <td className="muted">{u.account_name}</td>
                    <td className="r num">{formatQtyMicro(u.qty_micro)}</td>
                    <td className="r num">{u.est_cents !== null ? formatCents(u.est_cents) : '—'}</td>
                    <td className="muted">
                      {u.next_vest_on && u.vest_every_months && u.vest_qty_micro
                        ? `${formatQtyMicro(u.vest_qty_micro)} every ${u.vest_every_months === 1 ? 'month' : `${u.vest_every_months} mo`} · next ${u.next_vest_on}`
                        : '—'}
                    </td>
                    <td className="muted">{u.updated_on}</td>
                    <td className="r">
                      <button
                        className="btn mini"
                        title="Some shares vested — record them as a buy and lower this count"
                        onClick={() => setVesting({ row: u, qty: '', date: todayIso(), total: '' })}
                      >
                        Vest…
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {vesting && (
            <div className="formrow" style={{ marginTop: 12 }}>
              <span className="sub2">
                <b className="inkstrong">{vesting.row.symbol}</b> vested:
              </span>
              <input
                autoFocus
                className="qty"
                placeholder="shares"
                value={vesting.qty}
                onChange={(e) => setVesting({ ...vesting, qty: e.target.value })}
              />
              <input
                className="date"
                type="date"
                value={vesting.date}
                onChange={(e) => setVesting({ ...vesting, date: e.target.value })}
              />
              <input
                className="money"
                placeholder="total value at vest $"
                title="shares × vest-day price, from the release statement — this becomes the cost basis"
                value={vesting.total}
                onChange={(e) => setVesting({ ...vesting, total: e.target.value })}
              />
              <button className="btn gold" disabled={!vesting.qty || !vesting.total} onClick={recordVest}>
                Record vest
              </button>
              <button className="btn ghosty" onClick={() => setVesting(null)}>Cancel</button>
            </div>
          )}
          {unvested.rows.length === 0 && (
            <p className="sub2" style={{ marginTop: 8 }}>
              Keep one running number per grant (e.g. your employer-stock grant). When shares
              vest, click “Vest…” — they become a buy at vest-day value and this count drops.
            </p>
          )}
        </div>
      )}

      {/* ---------- warnings ---------- */}
      {portfolio && portfolio.warnings.length > 0 && (
        <div className="card c12 warncard">
          <h2>Data warnings</h2>
          {portfolio.warnings.map((w, i) => (
            <p key={i} className="sub2">{w}</p>
          ))}
        </div>
      )}

      {/* ---------- holdings + tax ---------- */}
      {portfolio && portfolio.positions.length > 0 && (
        <>
          <div className="card c8">
            <h2>Holdings</h2>
            <table>
              <thead>
                <tr>
                  <th>Asset</th><th className="r">Qty</th><th className="r">Price</th>
                  <th className="r">Value</th><th className="r">Cost basis</th><th className="r">Unrealized</th>
                </tr>
              </thead>
              <tbody>
                {portfolio.positions.flatMap((p) => {
                  const open = openLots.has(p.symbol)
                  const rows = [
                    <tr key={p.symbol}>
                      <td>
                        <span className="tk">
                          <button
                            className="btn mini ghosty"
                            style={{ padding: '1px 6px' }}
                            title={open ? 'Hide lots' : 'Show lots / sell a specific tranche'}
                            onClick={() =>
                              setOpenLots((s) => {
                                const n = new Set(s)
                                if (open) n.delete(p.symbol)
                                else n.add(p.symbol)
                                return n
                              })
                            }
                          >
                            {open ? '▾' : '▸'}
                          </button>
                          <span className="lg">{p.symbol}</span>
                        </span>
                      </td>
                      <td className="r num">{formatQtyMicro(p.qty_micro)}</td>
                      <td className="r num">
                        {p.price_cents ? formatCents(p.price_cents) : <span className="muted">no price yet</span>}
                      </td>
                      <td className="r num">{formatCents(p.value_cents)}</td>
                      <td className="r num muted">{formatCents(p.cost_cents)}</td>
                      <td className={`r num ${p.price_cents === null ? '' : p.unrealized_cents >= 0 ? 'pos' : 'neg'}`}>
                        {p.price_cents === null ? (
                          <span className="muted">—</span>
                        ) : (
                          <>
                            {p.unrealized_cents >= 0 ? '▲ ' : '▼ '}
                            {formatCents(Math.abs(p.unrealized_cents))}
                            {p.cost_cents > 0 && ` (${Math.round((p.unrealized_cents / p.cost_cents) * 100)}%)`}
                          </>
                        )}
                      </td>
                    </tr>,
                  ]
                  if (open)
                    rows.push(
                      ...p.lots.map((l, li) => (
                        <tr
                          key={`${p.symbol}-lot-${l.trade_id ?? li}`}
                          className="lotrow"
                          title={(() => {
                            if (!p.price_cents || !taxMarginal) return undefined
                            const value = Math.round((l.qty_micro * p.price_cents) / 1_000_000)
                            const gain = value - l.cost_cents
                            const lt = Date.now() - Date.parse(l.opened_on) > 365 * 86400000
                            const rate = lt ? taxMarginal.ltMicro : taxMarginal.stMicro
                            const tax = Math.round((gain * rate) / 1_000_000)
                            return gain >= 0
                              ? `Sold today (${lt ? 'long' : 'short'}-term): gain ${formatCents(gain)} → est. tax ${formatCents(tax)} → after-tax proceeds ${formatCents(value - tax)}`
                              : `Sold today (${lt ? 'long' : 'short'}-term): loss ${formatCents(-gain)} → est. tax saved ${formatCents(-tax)} — see Taxes for wash-sale checks`
                          })()}
                        >
                          <td className="muted" style={{ paddingLeft: 44 }}>lot · {l.opened_on}</td>
                          <td className="r num muted">{formatQtyMicro(l.qty_micro)}</td>
                          <td className="r num muted">{formatCents(perShare(l.cost_cents, l.qty_micro))}/sh</td>
                          <td className="r num muted">
                            {p.price_cents ? formatCents(Math.round((l.qty_micro * p.price_cents) / 1_000_000)) : '—'}
                          </td>
                          <td className="r num muted">{formatCents(l.cost_cents)}</td>
                          <td className="r">
                            {l.trade_id && (
                              <button
                                className="btn mini"
                                title="Prefill the trade form to sell this tranche"
                                onClick={() => {
                                  setTrade((t) => ({
                                    ...t,
                                    side: 'sell',
                                    symbol: p.symbol,
                                    assetKind: p.kind,
                                    qty: formatQtyMicro(l.qty_micro).replace(/,/g, ''),
                                    total: '',
                                    lotChoice: l.trade_id!,
                                  }))
                                  setMsg(
                                    `Selling lot ${l.opened_on} of ${p.symbol} — enter the total proceeds and date in “Record a trade”, then Record.`,
                                  )
                                  window.scrollTo({ top: 0, behavior: 'smooth' })
                                }}
                              >
                                Sell…
                              </button>
                            )}
                          </td>
                        </tr>
                      )),
                    )
                  return rows
                })}
                <tr>
                  <td className="strong">Total</td>
                  <td />
                  <td />
                  <td className="r num strong">{formatCents(portfolio.totals.value)}</td>
                  <td className="r num muted">{formatCents(portfolio.totals.cost)}</td>
                  <td className={`r num strong ${portfolio.totals.unrealized >= 0 ? 'pos' : 'neg'}`}>
                    {formatCents(portfolio.totals.unrealized, { sign: portfolio.totals.unrealized > 0 })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card c4">
            <h2>Tax picture · {new Date().getFullYear()}</h2>
            <div style={{ display: 'grid', gap: 12 }}>
              <div>
                <div className="muted">Realized short-term (ordinary rates)</div>
                <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
                  {formatCents(portfolio.totals.ytd_st, { sign: portfolio.totals.ytd_st > 0 })}
                </div>
              </div>
              <div>
                <div className="muted">Realized long-term (cap-gains rates)</div>
                <div className="v" style={{ fontSize: 20, fontWeight: 650 }}>
                  {formatCents(portfolio.totals.ytd_lt, { sign: portfolio.totals.ytd_lt > 0 })}
                </div>
              </div>
              <div className="sub2 topline">
                Unrealized gain across holdings:{' '}
                <b className="inkstrong">{formatCents(portfolio.totals.unrealized, { sign: true })}</b>.
                {taxMarginal && (
                  <>
                    {' '}Est. tax on realized gains so far:{' '}
                    <b className="inkstrong">
                      {formatCents(
                        Math.round(
                          (Math.max(0, portfolio.totals.ytd_st) * taxMarginal.stMicro +
                            Math.max(0, portfolio.totals.ytd_lt) * taxMarginal.ltMicro) /
                            1_000_000,
                        ),
                      )}
                    </b>
                    .
                  </>
                )}{' '}
                The Taxes screen has the full picture — withholding gap, harvesting, quarterlies. Hover a lot
                for its after-tax sale value.
              </div>
            </div>
          </div>
        </>
      )}

      {/* ---------- detailed charts ---------- */}
      {portfolio && portfolio.positions.length > 0 && (
        <div className="card c12">
          <div className="h4row">
            <h2>Charts</h2>
            <div className="right importbar">
              {portfolio.positions.map((p) => (
                <button
                  key={p.symbol}
                  className={`chipbtn ${chartSymbol === p.symbol ? 'on' : ''}`}
                  onClick={() => setChartSymbol(p.symbol)}
                >
                  {p.symbol}
                </button>
              ))}
            </div>
          </div>
          {chartSymbol && charts[chartSymbol] ? (
            <>
              {(charts[chartSymbol]!.errors?.length ?? 0) > 0 && (
                <div className="sub2 importmsg">{charts[chartSymbol]!.errors!.join(' · ')}</div>
              )}
              <BigChart data={charts[chartSymbol]!} />
            </>
          ) : (
            <p className="sub2">Loading daily history…</p>
          )}
        </div>
      )}
    </div>
  )
}
