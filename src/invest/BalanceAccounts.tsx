import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { InvestAccountRow } from '../../engine/invest'
import type { BalanceSnapshotRow } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { del, put } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { confirm } from '../ui/dialogs'
import { DateInput, Field, MoneyInput } from '../ui/Field'
import { EmptyState } from '../ui/EmptyState'
import { Popover } from '../ui/Popover'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import { balanceAgeDays, BALANCE_STALE_DAYS, isBalanceStale, quarterEnds, shortDay } from './balanceMath'
import { unparsedMoney } from './formGuard'
import NestedDialog from './NestedDialog'
import './invest.css'

/**
 * Balance-tracked accounts — 401(k)s, HSAs, anything entered as a total from
 * the provider's site or a statement. A dated balance is a fact; the
 * account's value on any day is the latest balance on or before it, so the
 * history here is what net worth draws from.
 */

/** "stale · 85 days" once a balance is older than 45 days. */
export function StaleChip({ balancedOn, today, className }: { balancedOn: string | null | undefined; today: string; className?: string }) {
  if (!balancedOn || !isBalanceStale(balancedOn, today)) return null
  const days = balanceAgeDays(balancedOn, today)
  return (
    <Tooltip content={`Last updated ${balancedOn}, ${days} days ago. Statements come quarterly — update it when the next one arrives.`}>
      <span className={`inv-tag inv-stale${className ? ` ${className}` : ''}`}>stale · {days}d</span>
    </Tooltip>
  )
}

/* ---------- update balance (popover) ---------- */

/**
 * What a dated snapshot means on this account: a balance account's total, or
 * (on a lots account) the cash it holds — its cash anchor.
 */
export type SnapshotMode = 'balance' | 'cash'

/** A button that opens a small dated-balance form under itself. */
export function UpdateBalanceButton({
  account,
  snapshots,
  today,
  onSaved,
  children = 'Update balance',
  className,
  mode = 'balance',
  initialCents,
}: {
  account: InvestAccountRow
  snapshots?: readonly BalanceSnapshotRow[]
  today: string
  onSaved: () => void
  children?: ReactNode
  className?: string
  mode?: SnapshotMode
  /** What the amount box starts with (default: the latest recorded snapshot). */
  initialCents?: number | null
}) {
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLButtonElement>(null)
  return (
    <>
      <Button ref={anchor} size="mini" className={className} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {children}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" aria-label={`Update ${account.name}`}>
        <UpdateBalanceForm
          account={account}
          snapshots={snapshots}
          today={today}
          mode={mode}
          initialCents={initialCents}
          onDone={() => {
            setOpen(false)
            onSaved()
          }}
          onCancel={() => setOpen(false)}
        />
      </Popover>
    </>
  )
}

function UpdateBalanceForm({ account, snapshots, today, onDone, onCancel, mode, initialCents }: {
  account: InvestAccountRow
  snapshots?: readonly BalanceSnapshotRow[]
  today: string
  onDone: () => void
  onCancel: () => void
  mode: SnapshotMode
  initialCents?: number | null
}) {
  const cash = mode === 'cash'
  const [cents, setCents] = useState<number | null>(initialCents !== undefined ? initialCents : (account.latest_snapshot?.balance_cents ?? null))
  const [on, setOn] = useState(today)
  const form = useRef<HTMLFormElement>(null)
  const replaces = snapshots?.find((s) => s.invest_account_id === account.id && s.balanced_on === on)
  const what = cash ? 'cash balance' : 'balance'
  const save = useAction(
    (v: { cents: number; on: string }) => put('/api/invest/balances', { investAccountId: account.id, balancedOn: v.on, balanceCents: v.cents }),
    { success: `${account.name} ${what} saved`, errorPrefix: `Couldn't save the ${account.name} ${what}`, onDone },
  )
  const ok = cents !== null && !!on && on <= today
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const bad = unparsedMoney(form.current)
    if (bad) return bad.focus()
    if (ok) void save.run({ cents: cents!, on })
  }
  return (
    <form ref={form} className="inv-pop" onSubmit={submit}>
      <div className="inv-pop-title">{cash ? `Cash in ${account.name}` : `Update ${account.name}`}</div>
      {cash && (
        <p className="inv-note">
          The cash (or settlement / sweep fund) balance at the end of a day. Sales after it add their proceeds and buys spend, so
          the cash follows your trades until the next statement.
        </p>
      )}
      <Field label={cash ? 'Cash balance' : 'Balance'} hint={cash ? 'Negative for a margin balance.' : undefined}>
        <MoneyInput autoFocus value={cents} onChange={setCents} aria-label={cash ? 'Cash balance' : 'Balance'} allowNegative={cash} />
      </Field>
      <Field
        label="As of"
        hint={
          replaces
            ? `Replaces the ${formatCents(replaces.balance_cents)} recorded for that day.`
            : cash
              ? 'End of that day: trades on it are already in the balance.'
              : 'The day the provider’s site or statement shows.'
        }
      >
        <DateInput value={on} max={today} onChange={setOn} />
      </Field>
      <div className="inv-pop-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="gold" busy={save.busy} disabled={!ok}>
          {cash ? 'Save cash' : 'Save balance'}
        </Button>
      </div>
    </form>
  )
}

/* ---------- one account's balances (the account drawer) ---------- */

/**
 * A balance account's history: every recorded balance, newest first, each
 * editable in place and deletable, plus the statement backfill. Updating
 * today's balance is the drawer's summary button (UpdateBalanceButton).
 */
export function BalancePanel({
  account,
  snapshots,
  today,
  onChanged,
}: {
  account: InvestAccountRow
  /** This account's balances, newest first. */
  snapshots: readonly BalanceSnapshotRow[]
  today: string
  onChanged: () => void
}) {
  const [backfill, setBackfill] = useState(false)
  return (
    <div className="inv-panel">
      {snapshots.length === 0 ? (
        <EmptyState
          title="No balance yet"
          body="Enter today’s total with Update balance, or backfill quarter-ends from old statements so net worth has its history."
          action={{ label: 'Backfill statements…', onClick: () => setBackfill(true) }}
        />
      ) : (
        <>
          <div className="inv-paneltools">
            <span className="inv-note">
              {snapshots.length} balance{snapshots.length === 1 ? '' : 's'} · net worth uses the latest on or before each month’s end · stale after{' '}
              {BALANCE_STALE_DAYS} days
            </span>
            <Button size="mini" onClick={() => setBackfill(true)}>
              Backfill statements…
            </Button>
          </div>
          <table className="inv-baltable">
            <thead>
              <tr>
                <th>As of</th>
                <th className="r">Balance</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <HistoryRow key={s.balanced_on} account={account} snap={s} today={today} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </>
      )}
      {backfill && (
        // Opened from inside the account drawer.
        <NestedDialog>
          <BackfillDrawer account={account} snapshots={snapshots} today={today} onClose={() => setBackfill(false)} onSaved={onChanged} />
        </NestedDialog>
      )}
    </div>
  )
}

/** One recorded balance: its amount edits in place (saved on Enter or leaving the box); Delete asks first. */
export function HistoryRow({ account, snap, today, onChanged, mode = 'balance' }: {
  account: InvestAccountRow
  snap: BalanceSnapshotRow
  today: string
  onChanged: () => void
  mode?: SnapshotMode
}) {
  const what = mode === 'cash' ? 'cash balance' : 'balance'
  const save = useAction(
    (v: number) => put('/api/invest/balances', { investAccountId: account.id, balancedOn: snap.balanced_on, balanceCents: v }),
    { success: `${snap.balanced_on} ${what} updated`, errorPrefix: `Couldn't update the ${what}`, onDone: onChanged },
  )
  const remove = useAction(() => del(`/api/invest/balances/${account.id}/${snap.balanced_on}`), {
    success: `Deleted the ${snap.balanced_on} ${what}`,
    errorPrefix: `Couldn't delete the ${what}`,
    onDone: onChanged,
  })
  async function askDelete() {
    const ok = await confirm({
      title: `Delete the ${shortDay(snap.balanced_on, today)} ${what}?`,
      body:
        mode === 'cash'
          ? `${account.name}: ${formatCents(snap.balance_cents)} cash as of ${snap.balanced_on}. From then on the cash follows the balance before it (and with none, isn’t counted).`
          : `${account.name}: ${formatCents(snap.balance_cents)} as of ${snap.balanced_on}. Net worth for that stretch falls back to the balance before it.`,
      confirmLabel: `Delete ${what}`,
      danger: true,
    })
    if (ok) await remove.run()
  }
  return (
    <tr className="inv-histrow">
      <td>
        <span className="inv-histdate">{snap.balanced_on}</span>
      </td>
      <td className="r">
        {/* Follows the recorded value; what's typed is kept until it commits. */}
        <MoneyInput
          value={snap.balance_cents}
          width={150}
          aria-label={`${mode === 'cash' ? 'Cash balance' : 'Balance'} on ${snap.balanced_on}`}
          allowNegative={mode === 'cash'}
          onChange={() => {}}
          onCommit={(v) => {
            if (v !== null && v !== snap.balance_cents) void save.run(v)
          }}
        />
      </td>
      <td className="muted">{save.busy ? 'saving…' : ''}</td>
      <td className="r">
        <Button size="mini" variant="ghost" busy={remove.busy} onClick={() => void askDelete()}>
          Delete
        </Button>
      </td>
    </tr>
  )
}

/* ---------- backfill (drawer) ---------- */

export function BackfillDrawer({ account, snapshots, today, onClose, onSaved }: {
  account: InvestAccountRow
  snapshots: readonly BalanceSnapshotRow[]
  today: string
  onClose: () => void
  onSaved: () => void
}) {
  const dates = useMemo(() => quarterEnds(today, 8), [today])
  const recorded = useMemo(() => new Map(snapshots.map((s) => [s.balanced_on, s.balance_cents])), [snapshots])
  const [values, setValues] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(dates.map((d) => [d, recorded.get(d) ?? null])),
  )
  const grid = useRef<HTMLDivElement>(null)
  const changed = dates.filter((d) => values[d] !== null && values[d] !== undefined && values[d] !== recorded.get(d))
  const save = useAction(
    () =>
      put<{ ok: true; written: number }>('/api/invest/balances', {
        investAccountId: account.id,
        balances: changed.map((d) => ({ balancedOn: d, balanceCents: values[d]! })),
      }),
    {
      success: (r) => `Saved ${r.written} statement balance${r.written === 1 ? '' : 's'} for ${account.name}`,
      errorPrefix: "Couldn't save the balances",
      onDone: () => {
        onSaved()
        onClose()
      },
    },
  )
  return (
    <Drawer
      open
      onClose={onClose}
      dismissible={!save.busy}
      title="Backfill statements"
      subtitle={`${account.name} · quarter-end balances from old statements`}
      footer={
        <>
          <span className="ui-foot-start inv-note">Blank rows are skipped.</span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="gold"
            busy={save.busy}
            disabled={changed.length === 0}
            onClick={() => {
              // A box showing an error would otherwise be skipped as blank.
              const bad = unparsedMoney(grid.current)
              if (bad) bad.focus()
              else void save.run()
            }}
          >
            {changed.length === 0 ? 'Save' : `Save ${changed.length} balance${changed.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <p className="inv-note" style={{ marginBottom: 12 }}>
        Each statement’s ending balance, for the day it closed. Net worth uses the latest balance on or before each month’s end,
        so a few quarters fill the history back in.
      </p>
      <div ref={grid} className="inv-backfill">
        {dates.map((d, i) => (
          <Field
            key={d}
            label={shortDay(d, today)}
            hint={recorded.has(d) ? (values[d] === recorded.get(d) ? 'recorded' : `was ${formatCents(recorded.get(d)!)}`) : undefined}
          >
            <MoneyInput
              autoFocus={i === 0}
              value={values[d] ?? null}
              aria-label={`Balance on ${d}`}
              onChange={(v) => setValues((x) => ({ ...x, [d]: v }))}
            />
          </Field>
        ))}
      </div>
    </Drawer>
  )
}
