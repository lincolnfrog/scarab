import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { InvestAccountRow } from '../../engine/invest'
import { OPENING_NOTE, RSU_VEST_NOTE, RSU_WITHHOLDING_NOTE, type TradeDeleteResult, type TradePatch, type TradeRow, type TradeUpdateResult } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { del, get, patch } from '../api'
import { useRouteState } from '../router'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { EmptyState } from '../ui/EmptyState'
import { DateInput, MoneyInput, QtyInput, Select } from '../ui/Field'
import { Menu } from '../ui/Menu'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import { shortDay } from './balanceMath'
import { unparsedField } from './formGuard'
import { perShareCents } from './lotMath'
import { qtyParam } from './tradeMath'
import './invest.css'

export type ActivityTableProps = {
  /** Every investment account (names and kinds for the rows, choices for the filter). */
  accounts: readonly InvestAccountRow[]
  /** Show one account only (the account drawer); omit for all activity with an account filter. */
  accountId?: number
  /** Bump to refetch — the screen does after anything that records or changes trades. */
  rev: number
  today: string
  /** After an edit or a delete here. */
  onChanged: () => void
  /** Offered when the ledger is empty. */
  onRecord?: () => void
  /** 'card' (default): a full-width card with its title. 'plain': the table alone, for a drawer tab. */
  variant?: 'card' | 'plain'
  /** Only these accounts' trades (the owner pills); omit for every account. */
  scope?: ReadonlySet<number>
}

/**
 * What a trade's note says it is: a vest counts as pay on Taxes; a starting
 * position was booked, not bought that day; a vest's withheld shares paid its tax.
 */
const NOTE_TAG: Record<string, string> = { [RSU_VEST_NOTE]: 'vest', [OPENING_NOTE]: 'starting position', [RSU_WITHHOLDING_NOTE]: 'withheld for tax' }
/** A vest's withholding sale: sold from that vest, that day, at its cost — only the share count is its own. */
const isWithholding = (r: Pick<TradeRow, 'side' | 'note'>) => r.side === 'sell' && r.note === RSU_WITHHOLDING_NOTE
const PAGE = 25

type Edit = {
  id: number
  side: 'buy' | 'sell'
  tradedOn: string
  qtyMicro: number | null
  totalCents: number | null
  acquiredOn: string
  basisCents: number | null
  /** A sale with its own basis (shares Scarab never tracked): acquired + basis are editable. */
  explicit: boolean
}

const startEdit = (r: TradeRow): Edit => ({
  id: r.id,
  side: r.side,
  tradedOn: r.traded_on,
  qtyMicro: r.qty_micro,
  totalCents: r.total_cents,
  acquiredOn: r.acquired_on ?? '',
  basisCents: r.basis_cents ?? null,
  explicit: r.side === 'sell' && r.basis_cents != null,
})

/** Only what changed, in the PATCH body's terms; null when the row can't be saved as typed. */
function patchFor(r: TradeRow, e: Edit): TradePatch | null {
  if (!e.tradedOn || e.qtyMicro === null || e.totalCents === null) return null
  const p: TradePatch = {}
  if (e.tradedOn !== r.traded_on) p.tradedOn = e.tradedOn
  if (e.qtyMicro !== r.qty_micro) p.qty = qtyParam(e.qtyMicro)
  if (e.totalCents !== r.total_cents) p.totalCents = e.totalCents
  if (e.side === 'buy' && (e.acquiredOn || null) !== (r.acquired_on ?? null)) p.acquiredOn = e.acquiredOn || null
  if (e.explicit) {
    if (!e.acquiredOn || e.basisCents === null) return null
    if (e.acquiredOn !== r.acquired_on) p.acquiredOn = e.acquiredOn
    if (e.basisCents !== r.basis_cents) p.basisCents = e.basisCents
  }
  return p
}

/**
 * The activity ledger: every trade, newest first, with each sale's realized
 * gain. Filters for account, year and symbol live in route state (never the
 * URL). A row edits in place — date, shares, total, and a buy's acquisition
 * date or a sale's entered basis; Enter saves, Esc cancels — and the engine
 * re-checks the whole holding before it accepts an edit. Delete asks first,
 * saying how many sales took shares from a buy (they keep their gains).
 */
export default function ActivityTable({ accounts, accountId, rev, today, onChanged, onRecord, variant = 'card', scope }: ActivityTableProps) {
  // Route-state keys have one owner per screen: the drawer's ledger keeps its filters apart from the card's.
  const keys0 = variant === 'plain' ? 'drawerActivity' : 'activity'
  const [acctFilter, setAcctFilter] = useRouteState<number>(`${keys0}Acct`, 0)
  const [year, setYear] = useRouteState<string>(`${keys0}Year`, '')
  const [symbol, setSymbol] = useRouteState<string>(`${keys0}Sym`, '')
  const inScope = (id: number) => !scope || scope.has(id)
  const acct = accountId ?? (accounts.some((a) => a.id === acctFilter && inScope(a.id)) ? acctFilter : 0)
  const [rows, setRows] = useState<TradeRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [limit, setLimit] = useState(PAGE)
  const [edit, setEdit] = useState<Edit | null>(null)
  const tbody = useRef<HTMLTableSectionElement>(null)
  // Leaving an edit puts focus back on that row's actions, not on the page.
  const refocus = useRef<number | null>(null)
  const endEdit = useCallback(() => {
    setEdit((cur) => {
      if (cur) refocus.current = cur.id
      return null
    })
  }, [])
  // A deleted row takes its actions button (where the menu returned focus) with it: once the
  // ledger has reloaded without it, focus goes to the row that took its place.
  const afterDelete = useRef<{ deleted: number; next: number | null } | null>(null)
  useEffect(() => {
    if (edit !== null) return
    if (refocus.current !== null) {
      const id = refocus.current
      refocus.current = null
      tbody.current?.querySelector<HTMLElement>(`tr[data-trade="${id}"] button`)?.focus()
      return
    }
    const d = afterDelete.current
    if (!d || !rows || rows.some((r) => r.id === d.deleted)) return
    afterDelete.current = null
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    const body = tbody.current
    ;(body?.querySelector<HTMLElement>(`tr[data-trade="${d.next}"] button`) ?? body?.querySelector<HTMLElement>('tr[data-trade] button'))?.focus()
  }, [edit, rows])

  const load = useCallback(() => {
    let live = true
    setLoadError(null)
    get<TradeRow[]>(`/api/trades${acct ? `?accountId=${acct}` : ''}`)
      .then((r) => live && setRows(r))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [acct])
  useEffect(() => load(), [load, rev])

  const save = useAction((id: number, p: TradePatch) => patch<TradeUpdateResult>(`/api/trades/${id}`, p), {
    success: (r) =>
      !r.changed ? 'Nothing to change' : r.affected > 0 ? `Trade saved · realized gain recomputed on ${r.affected} other sale${r.affected === 1 ? '' : 's'}` : 'Trade saved',
    errorPrefix: "Couldn't save the trade",
    onDone: () => {
      endEdit()
      onChanged()
    },
  })

  const remove = useAction((r: TradeRow) => del<TradeDeleteResult>(`/api/trades/${r.id}`).then((x) => ({ ...x, row: r })), {
    success: (x) =>
      `Deleted the ${x.row.traded_on} ${x.row.note === RSU_VEST_NOTE ? 'vest' : x.row.side} of ${x.row.symbol}` +
      (x.withholdingRemoved > 0 ? ' and the shares withheld from it' : '') +
      (x.rewritten > 0 ? ` · ${x.rewritten} sale${x.rewritten === 1 ? '' : 's'} now carr${x.rewritten === 1 ? 'ies' : 'y'} its basis` : ''),
    errorPrefix: "Couldn't delete the trade",
    onDone: () => onChanged(),
  })

  async function confirmDelete(r: TradeRow) {
    const deps = r.dependents ?? 0
    const what = `${r.side === 'buy' ? 'Bought' : 'Sold'} ${formatQtyMicro(r.qty_micro)} ${r.symbol} on ${r.traded_on} in ${r.account_name} for ${formatCents(r.total_cents)}.`
    const vest = r.note === RSU_VEST_NOTE
    const withheld = r.withheld_qty_micro ?? 0
    const ok = await confirm({
      title: `Delete this ${vest ? 'vest' : isWithholding(r) ? 'withholding' : r.side}?`,
      body: (
        <>
          <p>{what}</p>
          {r.side === 'buy' ? (
            <p>
              {deps > 0
                ? `${deps} sale${deps === 1 ? '' : 's'} took shares from this lot. ${deps === 1 ? 'It keeps its' : 'They keep their'} realized gain: Scarab rewrites ${deps === 1 ? 'it' : 'them'} to carry this lot’s cost basis and acquisition date.`
                : 'Its lot leaves Holdings; net worth and the tax picture recompute without it.'}
              {vest && withheld > 0 && ` The ${formatQtyMicro(withheld)} shares withheld for tax at this vest go with it.`}
              {vest && ' The shares don’t go back to the unvested count.'}
            </p>
          ) : isWithholding(r) ? (
            <p>
              Its $0 sale goes, and these {formatQtyMicro(r.qty_micro)} shares count as held in {r.account_name} again. Delete it only if they
              weren’t really withheld — to change how many were, edit it instead.
            </p>
          ) : (
            <p>Its realized gain goes. Later FIFO sales in {r.account_name} take the lots it had taken, so their gains may change.</p>
          )}
        </>
      ),
      confirmLabel: vest ? 'Delete vest' : `Delete ${r.side}`,
      danger: true,
    })
    if (!ok) return
    // The row after it (or before, at the end) — not one that goes with it (a vest's withholding).
    const staying = shown.filter((x) => x.id === r.id || !(vest && isWithholding(x) && x.sold_lot_trade_id === r.id))
    const at = staying.findIndex((x) => x.id === r.id)
    const next = staying[at + 1] ?? staying[at - 1] ?? null
    if (await remove.run(r)) afterDelete.current = { deleted: r.id, next: next?.id ?? null }
  }

  const trySave = (r: TradeRow) => {
    if (!edit || save.busy) return
    const bad = unparsedField(tbody.current)
    if (bad) return bad.focus()
    const p = patchFor(r, edit)
    if (!p) return
    void save.run(r.id, p)
  }
  const keys = (r: TradeRow) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Escape') {
      // Esc cancels the edit, not an enclosing drawer.
      e.preventDefault()
      e.stopPropagation()
      endEdit()
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault()
      trySave(r)
    }
  }

  const byAccount = new Map(accounts.map((a) => [a.id, a]))
  const scoped = (rows ?? []).filter((r) => inScope(r.invest_account_id))
  const years = [...new Set(scoped.map((r) => r.traded_on.slice(0, 4)))].sort().reverse()
  const symbols = [...new Set(scoped.map((r) => r.symbol))].sort()
  const shown = scoped.filter((r) => (!year || r.traded_on.startsWith(year)) && (!symbol || r.symbol === symbol))
  const lotDate = new Map((rows ?? []).filter((r) => r.side === 'buy').map((r) => [r.id, r.acquired_on ?? r.traded_on]))
  const lotsAccounts = accounts.filter((a) => a.tracking === 'lots' && inScope(a.id))

  const filters = rows !== null && scoped.length > 0 && (
    <div className="inv-filters">
      {accountId === undefined && lotsAccounts.length > 1 && (
        <Select aria-label="Account" value={acct} onChange={(e) => { setAcctFilter(Number(e.target.value)); setLimit(PAGE) }}>
          <option value={0}>All accounts</option>
          {lotsAccounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </Select>
      )}
      {years.length > 1 && (
        <Select aria-label="Year" value={year} onChange={(e) => { setYear(e.target.value); setLimit(PAGE) }}>
          <option value="">All years</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </Select>
      )}
      {symbols.length > 1 && (
        <Select aria-label="Symbol" value={symbol} onChange={(e) => { setSymbol(e.target.value); setLimit(PAGE) }}>
          <option value="">All symbols</option>
          {symbols.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </Select>
      )}
    </div>
  )

  let content
  if (loadError)
    content = (
      <div className="inv-loaderr" role="alert">
        <span>Couldn’t load the activity: {loadError}</span>
        <Button size="mini" onClick={load}>Retry</Button>
      </div>
    )
  else if (rows === null)
    content = (
      <div aria-busy="true" aria-label="Loading activity" className="inv-skel">
        <Skeleton h={14} w="60%" />
        <Skeleton h={14} />
        <Skeleton h={14} />
      </div>
    )
  else if (rows.length > 0 && scoped.length === 0) content = <p className="inv-note inv-pad">No trades in these accounts.</p>
  else if (rows.length === 0)
    content = (
      <EmptyState
        title="No trades yet"
        body="Buys and sells you record show up here, newest first, with each sale’s realized gain — and every one can be fixed later."
        action={onRecord ? { label: 'Record a trade', onClick: onRecord } : undefined}
      />
    )
  else
    content = (
      <>
        <div className="inv-tablewrap">
          <table className="inv-activity">
            <thead>
              <tr>
                <th>Date</th>
                {accountId === undefined && <th>Account</th>}
                <th>Trade</th>
                <th className="r">Shares</th>
                <th className="r">Price</th>
                <th className="r">Total</th>
                <th className="r">Realized</th>
                <th className="inv-actcol"><span className="ui-sr">Actions</span></th>
              </tr>
            </thead>
            <tbody ref={tbody}>
              {shown.slice(0, limit).flatMap((r) =>
                edit?.id === r.id ? (
                  <EditRows
                    key={r.id}
                    r={r}
                    e={edit}
                    showAccount={accountId === undefined}
                    today={today}
                    busy={save.busy}
                    onChange={(patchE) => setEdit((cur) => (cur ? { ...cur, ...patchE } : cur))}
                    onKeyDown={keys(r)}
                    onSave={() => trySave(r)}
                    onCancel={endEdit}
                  />
                ) : (
                  [
                    <ActivityRow
                      key={r.id}
                      r={r}
                      today={today}
                      showAccount={accountId === undefined}
                      sheltered={byAccount.get(r.invest_account_id)?.kind === 'retirement'}
                      lotDate={r.sold_lot_trade_id != null ? lotDate.get(r.sold_lot_trade_id) : undefined}
                      onEdit={() => setEdit(startEdit(r))}
                      onDelete={() => void confirmDelete(r)}
                      locked={edit !== null}
                    />,
                  ]
                ),
              )}
            </tbody>
          </table>
        </div>
        {shown.length === 0 && <p className="inv-note inv-pad">No trades match these filters.</p>}
        {shown.length > limit && (
          <div className="inv-more">
            <Button size="mini" onClick={() => setLimit(shown.length)}>
              Show all {shown.length}
            </Button>
          </div>
        )}
      </>
    )

  if (variant === 'plain')
    return (
      <div className="inv-activitywrap">
        {filters}
        {content}
      </div>
    )
  return (
    <div className="card c12">
      <div className="h4row">
        <h2>Activity</h2>
        <div className="right">
          {rows !== null && scoped.length > 0 && <span className="muted">{shown.length === scoped.length ? `${scoped.length} trade${scoped.length === 1 ? '' : 's'}` : `${shown.length} of ${scoped.length}`}</span>}
          {filters}
        </div>
      </div>
      {content}
    </div>
  )
}

/** A trade's subline in two halves: in a tight table it breaks between them (never inside one) rather than widen the Trade column. */
function Halves({ a, b }: { a: string; b: string }) {
  return (
    <span className="inv-subline inv-subwrap">
      <span className="inv-nw">{a} ·</span> <span className="inv-nw">{b}</span>
    </span>
  )
}

/** One trade in the ledger (read-only). Exported for the render test. */
export function ActivityRow(p: {
  r: TradeRow
  today: string
  showAccount: boolean
  sheltered: boolean
  lotDate: string | undefined
  locked: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const { r } = p
  const noteTag = r.note ? NOTE_TAG[r.note] : undefined
  const g = r.realized ? r.realized.st_cents + r.realized.lt_cents : null
  const terms = r.realized ? [r.realized.lt_cents !== 0 && 'long-term', r.realized.st_cents !== 0 && 'short-term'].filter(Boolean).join(' · ') : ''
  return (
    <tr data-trade={r.id}>
      <td className="inv-nw">
        <span title={r.traded_on}>{shortDay(r.traded_on, p.today)}</span>
        {r.side === 'buy' && r.acquired_on && r.acquired_on !== r.traded_on && (
          <span className="inv-subline">acquired {shortDay(r.acquired_on, p.today)}</span>
        )}
      </td>
      {p.showAccount && <td className="muted">{r.account_name}</td>}
      <td>
        <span className="inv-tradecell">
          <span className={`inv-side inv-side-${r.side}`}>{r.side === 'buy' ? 'Buy' : 'Sell'}</span>
          <span className="tk"><span className="lg">{r.symbol}</span></span>
          {noteTag && <span className="inv-tag inv-quiet">{noteTag}</span>}
        </span>
        {r.side === 'buy' && (r.withheld_qty_micro ?? 0) > 0 && (
          <Halves a={`${formatQtyMicro(r.withheld_qty_micro!)} withheld for tax`} b={`${formatQtyMicro(r.qty_micro - r.withheld_qty_micro!)} kept`} />
        )}
        {r.side === 'sell' && r.basis_cents != null && (
          <Halves a={`entered basis ${formatCents(r.basis_cents)}`} b={`acquired ${r.acquired_on ? shortDay(r.acquired_on, p.today) : '—'}`} />
        )}
        {r.side === 'sell' && r.sold_lot_trade_id != null && !isWithholding(r) && (
          p.lotDate ? <Halves a="chosen lot" b={shortDay(p.lotDate, p.today)} /> : <span className="inv-subline">chosen lot</span>
        )}
        {isWithholding(r) && <Halves a="at the vest’s value" b="paid its tax, not cash" />}
      </td>
      <td className="r num">{formatQtyMicro(r.qty_micro)}</td>
      <td className="r num muted">{formatCents(perShareCents(r.total_cents, r.qty_micro))}</td>
      <td className="r num">{formatCents(r.total_cents)}</td>
      <td className="r num">
        {g === null ? (
          <span className="muted">—</span>
        ) : (
          <>
            <span className={g > 0 ? 'pos' : g < 0 ? 'neg' : undefined}>{formatCents(g, { sign: g !== 0 })}</span>
            <span className="inv-subline">
              {p.sheltered ? 'tax-deferred' : terms}
              {r.realized!.zero_basis_cents ? (
                <Tooltip content={`${formatCents(r.realized!.zero_basis_cents)} of the proceeds matched no recorded lot and count as gain with $0 basis. Add the missing buy, or give the sale an entered basis.`}>
                  <span className="inv-tag inv-stale">no basis {formatCents(r.realized!.zero_basis_cents)}</span>
                </Tooltip>
              ) : null}
            </span>
          </>
        )}
      </td>
      <td className="r">
        {!p.locked && (
          <Menu
            label={`${r.side} ${r.symbol} ${r.traded_on} actions`}
            align="end"
            items={[
              { label: 'Edit', onSelect: p.onEdit },
              { label: 'Delete…', danger: true, onSelect: p.onDelete, hint: r.side === 'buy' && r.dependents ? `${r.dependents} sale${r.dependents === 1 ? '' : 's'} took from it` : undefined },
            ]}
          />
        )}
      </td>
    </tr>
  )
}

function EditRows(p: {
  r: TradeRow
  e: Edit
  showAccount: boolean
  today: string
  busy: boolean
  onChange: (patch: Partial<Edit>) => void
  onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => void
  onSave: () => void
  onCancel: () => void
}) {
  const { r, e } = p
  // A vest's withholding sale follows the vest: its day and value aren't its own to edit.
  const follows = isWithholding(r)
  const extra = e.side === 'buy' || e.explicit || follows
  const cols = p.showAccount ? 8 : 7
  return [
    <tr key={`e${r.id}`} className="inv-editrow" onKeyDown={p.onKeyDown}>
      <td>
        <DateInput aria-label="Trade date" autoFocus={!follows} disabled={follows} value={e.tradedOn} max={p.today} onChange={(tradedOn) => p.onChange({ tradedOn })} />
      </td>
      {p.showAccount && <td className="muted">{r.account_name}</td>}
      <td>
        <span className="inv-tradecell">
          <span className={`inv-side inv-side-${r.side}`}>{r.side === 'buy' ? 'Buy' : 'Sell'}</span>
          <span className="tk"><span className="lg">{r.symbol}</span></span>
        </span>
      </td>
      <td className="r">
        <span className="inv-qtybox">
          <QtyInput aria-label="Shares" autoFocus={follows} width={110} valueMicro={e.qtyMicro} onChange={(qtyMicro) => p.onChange({ qtyMicro })} />
        </span>
      </td>
      <td className="r num muted">{follows ? '—' : e.qtyMicro && e.totalCents !== null ? formatCents(perShareCents(e.totalCents, e.qtyMicro)) : '—'}</td>
      <td className="r">
        <span className="inv-moneybox">
          <MoneyInput
            aria-label={follows ? 'Value at the vest (follows the shares)' : r.side === 'buy' ? 'Total paid, fees included' : 'Total received, after fees'}
            width={130}
            disabled={follows}
            value={e.totalCents}
            onChange={(totalCents) => p.onChange({ totalCents })}
          />
        </span>
      </td>
      <td colSpan={2} className="r">
        <span className="inv-rowactions">
          <Button size="mini" variant="gold" busy={p.busy} onClick={p.onSave}>Save</Button>
          <Button size="mini" variant="ghost" onClick={p.onCancel}>Cancel</Button>
        </span>
      </td>
    </tr>,
    ...(extra
      ? [
          <tr key={`e2${r.id}`} className="inv-editrow inv-editrow2" onKeyDown={p.onKeyDown}>
            <td colSpan={cols}>
              <span className="inv-editextra">
                {follows ? (
                  <span className="inv-note">Withheld at the vest: its day and value follow the vest, so only the share count changes here — the value is recomputed on save.</span>
                ) : e.side === 'buy' ? (
                  <>
                    <span className="inv-note">Acquired (if earlier than booked)</span>
                    <DateInput aria-label="Acquired" value={e.acquiredOn} max={e.tradedOn || p.today} onChange={(acquiredOn) => p.onChange({ acquiredOn })} />
                    {e.acquiredOn && (
                      <Button size="mini" variant="ghost" onClick={() => p.onChange({ acquiredOn: '' })}>Clear</Button>
                    )}
                    {(r.withheld_qty_micro ?? 0) > 0 && <span className="inv-note">· the shares withheld from it follow its value and day</span>}
                  </>
                ) : (
                  <>
                    <span className="inv-note">Entered basis</span>
                    <span className="inv-moneybox">
                      <MoneyInput aria-label="Cost basis (total)" width={130} value={e.basisCents} onChange={(basisCents) => p.onChange({ basisCents })} />
                    </span>
                    <span className="inv-note">acquired</span>
                    <DateInput aria-label="Acquired" value={e.acquiredOn} max={e.tradedOn || p.today} onChange={(acquiredOn) => p.onChange({ acquiredOn })} />
                  </>
                )}
                <span className="inv-note inv-keys">Enter saves · Esc cancels</span>
              </span>
            </td>
          </tr>,
        ]
      : []),
  ]
}
