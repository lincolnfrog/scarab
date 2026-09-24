import { useId, useMemo, useState, type FormEvent } from 'react'
import type { InvestAccountRow, UnvestedRow } from '../../shared/invest-api'
import { todayLocal } from '../../shared/dates'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { put } from '../api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, FieldGrid, QtyInput, Select } from '../ui/Field'
import { Menu, type MenuItem } from '../ui/Menu'
import { useAction } from '../ui/useAction'
import { useMarketSymbols } from './marketSymbols'
import { useRecordedAssets } from './recordedAssets'
import { SymbolInput } from './SymbolInput'
import { resolveSymbol, symbolHint } from './symbolSearch'
import { qtyParam } from './tradeMath'
import NestedDialog from './NestedDialog'
import VestDialog from './VestDialog'
import './invest.css'

/**
 * An employee stock plan's unvested grants — one running count per grant,
 * with an optional vest cadence Taxes projects the year from. When shares
 * vest, "Vest…" records them from the release: the gross shares as a buy at
 * vest-day value (their cost basis), any shares withheld for tax as a $0
 * same-day sale, and the count drops. "Edit grant…" fixes the count or the
 * schedule. Unvested shares are never counted in net worth.
 */

type GrantForm = { symbol: string; qtyMicro: number | null; vestQtyMicro: number | null; vestEveryMonths: string; nextVestOn: string }
const EMPTY: GrantForm = { symbol: '', qtyMicro: null, vestQtyMicro: null, vestEveryMonths: '3', nextVestOn: '' }
/** Grants are company stock. */
const STOCK_ONLY = ['stock'] as const

export default function GrantsPanel({ account, grants, onChanged }: {
  account: InvestAccountRow
  /** This account's grants (GET /api/invest/accounts/:id → grants). */
  grants: readonly UnvestedRow[]
  onChanged: () => void
}) {
  const [grant, setGrant] = useState<GrantForm>(EMPTY)
  const market = useMarketSymbols()
  const { assets } = useRecordedAssets()
  const stockAssets = useMemo(() => assets.filter((a) => a.kind === 'stock'), [assets])
  const res = resolveSymbol(grant.symbol, stockAssets, market?.index ?? null)
  const totalEst = grants.reduce((s, g) => s + (g.est_cents ?? 0), 0)
  const scheduleHalf = (grant.nextVestOn !== '') !== (grant.vestQtyMicro !== null)

  const saveGrant = useAction(
    async (f: GrantForm) => {
      if (f.qtyMicro === null) throw new Error('total unvested shares are required')
      const scheduled = f.nextVestOn !== ''
      if (scheduled !== (f.vestQtyMicro !== null)) throw new Error('a vest schedule needs both the shares per vest and the next vest date')
      await put('/api/unvested', {
        investAccountId: account.id,
        symbol: f.symbol,
        qty: qtyParam(f.qtyMicro),
        // A blank schedule leaves the stored cadence alone; clearing it is its own action.
        ...(scheduled ? { nextVestOn: f.nextVestOn, vestEveryMonths: Number(f.vestEveryMonths), vestQty: qtyParam(f.vestQtyMicro!) } : {}),
      })
      return f
    },
    {
      success: (f) =>
        `Unvested ${f.symbol.trim().toUpperCase()} set to ${formatQtyMicro(f.qtyMicro!)} shares` +
        (f.nextVestOn ? ` · ${formatQtyMicro(f.vestQtyMicro!)} every ${f.vestEveryMonths} mo from ${f.nextVestOn}` : ''),
      errorPrefix: "Couldn't save the grant",
      onDone: () => {
        setGrant(EMPTY)
        onChanged()
      },
    },
  )

  const updateGrant = useAction(
    (u: UnvestedRow, change: { qty: string; nextVestOn?: '' }) => put('/api/unvested', { investAccountId: u.invest_account_id, symbol: u.symbol, ...change }),
    { success: 'Grant updated', errorPrefix: "Couldn't update the grant", onDone: onChanged },
  )
  // The vest or edit dialog: which grant (kept through the exit fade, so focus
  // returns to the opener), whether it's open, and a key so each opening starts fresh.
  const [sheet, setSheet] = useState<{ kind: 'vest' | 'edit'; grant: UnvestedRow; n: number } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const openSheet = (kind: 'vest' | 'edit', grant: UnvestedRow) => {
    setSheet((cur) => ({ kind, grant, n: (cur?.n ?? 0) + 1 }))
    setSheetOpen(true)
  }
  const closeSheet = () => setSheetOpen(false)

  async function clearGrant(u: UnvestedRow) {
    const ok = await confirm({
      title: `Clear unvested ${u.symbol}?`,
      body: `Removes the ${formatQtyMicro(u.qty_micro)} unvested shares in ${u.account_name} and their schedule. Vests already recorded stay.`,
      confirmLabel: 'Clear grant',
      danger: true,
    })
    if (ok) await updateGrant.run(u, { qty: '0' })
  }

  return (
    <div className="inv-panel">
      {grants.length > 0 && (
        <>
          <div className="inv-paneltools">
            <span className="inv-note">
              {totalEst > 0 ? (
                <>
                  ≈ <b className="inkstrong">{formatCents(totalEst)}</b> at today’s price · not counted in net worth
                </>
              ) : (
                'Not counted in net worth until they vest'
              )}
            </span>
          </div>
          <div className="inv-tablewrap">
            <table className="inv-grants">
              <thead>
                <tr>
                  <th>Asset</th><th className="r">Unvested</th><th className="r">Est. value</th><th>Schedule</th>
                  <th className="inv-actcol"><span className="ui-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {grants.map((u) => {
                  const scheduled = !!(u.next_vest_on && u.vest_every_months && u.vest_qty_micro)
                  const items: MenuItem[] = [
                    { label: 'Edit grant…', hint: 'Fix the count or the schedule', onSelect: () => openSheet('edit', u) },
                    ...(scheduled
                      ? [{ label: 'Clear schedule', hint: 'Keep the shares, stop projecting vests', onSelect: () => void updateGrant.run(u, { qty: qtyParam(u.qty_micro), nextVestOn: '' }) }]
                      : []),
                    { label: 'Clear grant…', danger: true, onSelect: () => void clearGrant(u) },
                  ]
                  return (
                    <tr key={u.asset_id}>
                      <td>
                        <span className="tk"><span className="lg">{u.symbol}</span></span>
                        <span className="inv-subline">updated {u.updated_on}</span>
                      </td>
                      <td className="r num">{formatQtyMicro(u.qty_micro)}</td>
                      <td className="r num">{u.est_cents !== null ? formatCents(u.est_cents) : <span className="muted">—</span>}</td>
                      <td className="muted">
                        {scheduled
                          ? `${formatQtyMicro(u.vest_qty_micro!)} every ${u.vest_every_months === 1 ? 'month' : `${u.vest_every_months} mo`} · next ${u.next_vest_on}`
                          : '—'}
                      </td>
                      <td className="r">
                        <span className="inv-rowactions">
                          <Button size="mini" title="Some shares vested — record them from the release and lower this count" onClick={() => openSheet('vest', u)}>
                            Vest…
                          </Button>
                          <Menu label={`${u.symbol} grant actions`} items={items} align="end" />
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <form
        className="inv-form inv-grantform"
        onSubmit={(e) => {
          e.preventDefault()
          void saveGrant.run(grant)
        }}
      >
        <div className="inv-formtitle">{grants.length > 0 ? 'Add another grant' : 'Track an unvested grant'}</div>
        {grants.length === 0 && (
          <p className="inv-note">
            Keep one running number per grant. When shares vest, Vest… records them as a buy at vest-day value and the count drops.
          </p>
        )}
        <FieldGrid min={140}>
          <Field label="Ticker" hint={symbolHint(res, 'stock', false, market !== null, formatCents) ?? undefined}>
            <SymbolInput
              placeholder="TICKER or company"
              recorded={stockAssets}
              market={market?.index ?? null}
              kinds={STOCK_ONLY}
              value={grant.symbol}
              onChange={(symbol) => setGrant({ ...grant, symbol })}
            />
          </Field>
          <Field label="Unvested shares" hint="The total still to vest">
            <QtyInput valueMicro={grant.qtyMicro} onChange={(qtyMicro) => setGrant({ ...grant, qtyMicro })} />
          </Field>
          <Field label="Shares per vest" hint="Optional — Taxes projects the rest of the year">
            <QtyInput valueMicro={grant.vestQtyMicro} onChange={(vestQtyMicro) => setGrant({ ...grant, vestQtyMicro })} />
          </Field>
          <Field label="Every">
            <Select value={grant.vestEveryMonths} onChange={(e) => setGrant({ ...grant, vestEveryMonths: e.target.value })}>
              <option value="1">month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">year</option>
            </Select>
          </Field>
          <Field label="Next vest" hint="Blank keeps the current schedule">
            <DateInput value={grant.nextVestOn} onChange={(nextVestOn) => setGrant({ ...grant, nextVestOn })} />
          </Field>
        </FieldGrid>
        <div className="inv-actions">
          <Button type="submit" busy={saveGrant.busy} disabled={!grant.symbol.trim() || grant.qtyMicro === null || scheduleHalf}>
            {grants.length > 0 ? 'Add grant' : 'Set grant'}
          </Button>
          {scheduleHalf && <span className="inv-note">A schedule needs both the shares per vest and the next vest date.</span>}
        </div>
      </form>
      <NestedDialog>
        {sheet?.kind === 'vest' && <VestDialog key={sheet.n} open={sheetOpen} grant={sheet.grant} today={todayLocal()} onClose={closeSheet} onDone={onChanged} />}
        {sheet?.kind === 'edit' && <GrantEditDialog key={sheet.n} open={sheetOpen} grant={sheet.grant} onClose={closeSheet} onDone={onChanged} />}
      </NestedDialog>
    </div>
  )
}

type EditForm = { qtyMicro: number | null; vestQtyMicro: number | null; vestEveryMonths: string; nextVestOn: string }

/** The PUT an edit stands for: the count, and the schedule set, kept or cleared. Exported for the test. */
export function grantEditBody(u: UnvestedRow, f: EditForm): { body: Record<string, unknown> } | { error: string } {
  if (f.qtyMicro === null || f.qtyMicro <= 0) return { error: 'Unvested shares are required — to drop the grant, use Clear grant.' }
  const scheduled = f.nextVestOn !== ''
  if (scheduled !== (f.vestQtyMicro !== null)) return { error: 'A schedule needs both the shares per vest and the next vest date — or neither.' }
  const had = !!(u.next_vest_on && u.vest_every_months && u.vest_qty_micro)
  return {
    body: {
      investAccountId: u.invest_account_id,
      symbol: u.symbol,
      qty: qtyParam(f.qtyMicro),
      ...(scheduled
        ? { nextVestOn: f.nextVestOn, vestEveryMonths: Number(f.vestEveryMonths), vestQty: qtyParam(f.vestQtyMicro!) }
        : had
          ? { nextVestOn: '' }
          : {}),
    },
  }
}

/** Fix a grant: its unvested count and its vest schedule (both blank = no schedule). */
function GrantEditDialog({ open, grant, onClose, onDone }: { open: boolean; grant: UnvestedRow; onClose: () => void; onDone: () => void }) {
  const formId = useId()
  const [f, setF] = useState<EditForm>({
    qtyMicro: grant.qty_micro,
    vestQtyMicro: grant.vest_qty_micro,
    vestEveryMonths: String(grant.vest_every_months ?? 3),
    nextVestOn: grant.next_vest_on ?? '',
  })
  const [tried, setTried] = useState(false)
  const built = grantEditBody(grant, f)
  const save = useAction((body: Record<string, unknown>) => put('/api/unvested', body), {
    success: `${grant.symbol} grant updated`,
    errorPrefix: "Couldn't update the grant",
    onDone: () => {
      onClose()
      onDone()
    },
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setTried(true)
    if ('body' in built) void save.run(built.body)
  }
  return (
    <Dialog
      open={open}
      width={520}
      onClose={onClose}
      dismissible={!save.busy}
      title={`Edit ${grant.symbol} grant`}
      subtitle={`${grant.account_name} · updated ${grant.updated_on}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" form={formId} variant="gold" busy={save.busy}>
            Save grant
          </Button>
        </>
      }
    >
      <form id={formId} className="inv-form" onSubmit={submit} noValidate>
        <FieldGrid min={140}>
          <Field label="Unvested shares" hint="The total still to vest">
            <QtyInput autoFocus valueMicro={f.qtyMicro} onChange={(qtyMicro) => setF({ ...f, qtyMicro })} />
          </Field>
          <Field label="Shares per vest" hint="Blank with no date: no schedule">
            <QtyInput valueMicro={f.vestQtyMicro} onChange={(vestQtyMicro) => setF({ ...f, vestQtyMicro })} />
          </Field>
          <Field label="Every">
            <Select value={f.vestEveryMonths} onChange={(e) => setF({ ...f, vestEveryMonths: e.target.value })}>
              {['1', '3', '6', '12'].includes(f.vestEveryMonths) ? null : <option value={f.vestEveryMonths}>{f.vestEveryMonths} months</option>}
              <option value="1">month</option>
              <option value="3">3 months</option>
              <option value="6">6 months</option>
              <option value="12">year</option>
            </Select>
          </Field>
          <Field label="Next vest">
            <DateInput value={f.nextVestOn} onChange={(nextVestOn) => setF({ ...f, nextVestOn })} />
          </Field>
        </FieldGrid>
        <p className="inv-note">Taxes projects the rest of the year’s vests from the schedule. Vests already recorded don’t change.</p>
        {tried && 'error' in built && (
          <p className="inv-pv-warn" role="alert">
            {built.error}
          </p>
        )}
      </form>
    </Dialog>
  )
}
