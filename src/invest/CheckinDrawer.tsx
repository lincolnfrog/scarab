import { useCallback, useEffect, useRef, useState } from 'react'
import type { CheckinItem, CheckinResponse } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { get, put } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { confirm } from '../ui/dialogs'
import { DateInput, MoneyInput } from '../ui/Field'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import { OwnerAvatar } from './AccountFields'
import { StaleChip } from './BalanceAccounts'
import { shortDay } from './balanceMath'
import { checkinRequest, checkinSummary, checkinWrites, rowKey, type CheckinDraft, type CheckinWrite } from './checkinMath'
import { unparsedMoney } from './formGuard'
import './invest.css'

export type CheckinDrawerProps = {
  open: boolean
  owners: readonly string[]
  today: string
  onClose: () => void
  /** After a sitting saved anything (the screen reloads). */
  onSaved: () => void
  /** Nothing to check in yet: offer adding an account instead. */
  onAddAccount: () => void
}

const SECTIONS: { kind: CheckinItem['kind']; title: string; note: string }[] = [
  { kind: 'balance', title: 'Balances from statements', note: '401(k)s, HSAs and anything followed by its total.' },
  { kind: 'cash', title: 'Cash in brokerage accounts', note: 'The cash or sweep fund at the end of the day. Sales and buys after it move it until the next one.' },
  { kind: 'property', title: 'Homes', note: 'An estimate or an appraisal.' },
  { kind: 'liability', title: 'Loans', note: 'What’s still owed.' },
]

/**
 * The balance check-in (#/invest?d=checkin): every number that comes from a
 * statement on one sheet — balance accounts, brokerage cash, homes, loans —
 * each with its latest value and a box for the new one. Fill in what changed
 * (blank rows are left alone), under one "as of" date or a row's own; Save
 * writes each through the route it already has and ends with one summary.
 */
export default function CheckinDrawer(p: CheckinDrawerProps) {
  if (!p.open) return null
  return <Sheet {...p} />
}

function Sheet({ owners, today, onClose, onSaved, onAddAccount }: CheckinDrawerProps) {
  const [data, setData] = useState<CheckinResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [asOf, setAsOf] = useState(today)
  const [drafts, setDrafts] = useState<Record<string, CheckinDraft>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const body = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    let live = true
    setLoadError(null)
    get<CheckinResponse>('/api/invest/checkin')
      .then((r) => live && setData(r))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [])
  useEffect(() => load(), [load])

  const items = data?.items ?? []
  const writes = checkinWrites(items, drafts, asOf)
  const setDraft = (key: string, patch: Partial<CheckinDraft>) => {
    setDrafts((d) => ({ ...d, [key]: { cents: null, on: null, ...d[key], ...patch } }))
    setErrors((e) => {
      if (!(key in e)) return e
      const { [key]: _, ...rest } = e
      return rest
    })
  }

  const save = useAction(
    async (ws: CheckinWrite[]) => {
      const saved: CheckinWrite[] = []
      const failed: { write: CheckinWrite; message: string }[] = []
      // One at a time, in the sheet's order; a refusal doesn't stop the rest.
      for (const w of ws) {
        const req = checkinRequest(w)
        try {
          await put(req.path, req.body)
          saved.push(w)
        } catch (e) {
          failed.push({ write: w, message: e instanceof Error ? e.message : String(e) })
        }
      }
      return { saved, failed }
    },
    {
      errorPrefix: 'Couldn’t save the check-in',
      onDone: ({ saved, failed }) => {
        const s = checkinSummary(saved, failed)
        if (s.ok) toast.success(s.text)
        else toast.error(s.text, { detail: s.detail })
        if (saved.length > 0) onSaved()
        if (failed.length === 0) return onClose()
        // Keep what didn't save, with its reason; clear what did.
        setDrafts((d) => {
          const next = { ...d }
          for (const w of saved) delete next[rowKey(w.item)]
          return next
        })
        setErrors(Object.fromEntries(failed.map((f) => [rowKey(f.write.item), f.message])))
        load()
      },
    },
  )

  const submit = () => {
    if (save.busy) return
    const bad = unparsedMoney(body.current)
    if (bad) {
      // Leaving the box commits it, which shows its error; then back to it.
      bad.blur()
      bad.focus()
      return
    }
    if (writes.length > 0) void save.run(writes)
  }
  const requestClose = async () => {
    if (save.busy) return
    if (writes.length > 0) {
      const ok = await confirm({
        title: 'Discard this check-in?',
        body: `${writes.length} ${writes.length === 1 ? 'number isn’t' : 'numbers aren’t'} saved yet.`,
        confirmLabel: 'Discard',
        cancelLabel: 'Keep editing',
        danger: true,
      })
      if (!ok) return
    }
    onClose()
  }

  let content
  if (loadError)
    content = (
      <div className="inv-loaderr" role="alert">
        <span>Couldn’t load what to check in: {loadError}</span>
        <Button size="mini" onClick={load}>Retry</Button>
      </div>
    )
  else if (data === null)
    content = (
      <div className="inv-skel" aria-busy="true" aria-label="Loading">
        <Skeleton h={14} w="40%" />
        <Skeleton h={34} />
        <Skeleton h={34} />
        <Skeleton h={34} />
      </div>
    )
  else if (items.length === 0)
    content = (
      <EmptyState
        title="Nothing to check in yet"
        body="Balance-tracked accounts (401(k)s, HSAs), brokerage cash, homes and loans show up here, so one sitting with the month’s statements brings them all up to date."
        action={{ label: 'Add an account', onClick: onAddAccount }}
      />
    )
  else {
    let first = true
    content = (
      <>
        <div className="inv-ci-top">
          <label className="inv-ci-asof">
            <span className="ui-field-label">As of</span>
            <DateInput value={asOf} max={today} onChange={(v) => setAsOf(v || today)} aria-label="As of (every row without its own date)" />
          </label>
          <p className="inv-note">Fill in what changed — blank rows are left as they are. A row can take its own date.</p>
        </div>
        {SECTIONS.map((s) => {
          const rows = items.filter((i) => i.kind === s.kind)
          if (rows.length === 0) return null
          return (
            <section key={s.kind} className="inv-ci-sec" aria-labelledby={`ci-${s.kind}`}>
              <h3 id={`ci-${s.kind}`} className="inv-ci-h">
                {s.title}
                <span className="inv-note">{s.note}</span>
              </h3>
              <ul className="inv-ci-list">
                {rows.map((i) => {
                  const key = rowKey(i)
                  const autoFocus = first
                  first = false
                  return (
                    <CheckinRow
                      key={key}
                      item={i}
                      draft={drafts[key]}
                      asOf={asOf}
                      today={today}
                      owners={owners}
                      error={errors[key] ?? null}
                      autoFocus={autoFocus}
                      onChange={(patch) => setDraft(key, patch)}
                    />
                  )
                })}
              </ul>
            </section>
          )
        })}
      </>
    )
  }

  return (
    <Drawer
      open
      width={680}
      onClose={() => void requestClose()}
      dismissible={!save.busy}
      title="Balance check-in"
      subtitle="Everything that comes from a statement, in one sitting"
      footer={
        <>
          <span className="ui-foot-start inv-note" aria-live="polite">
            {writes.length === 0 ? 'Nothing to save yet' : `${writes.length} to save`}
          </span>
          <Button variant="ghost" onClick={() => void requestClose()}>
            Cancel
          </Button>
          <Button variant="gold" busy={save.busy} disabled={writes.length === 0} onClick={submit}>
            {writes.length > 1 ? `Save ${writes.length}` : 'Save'}
          </Button>
        </>
      }
    >
      <div
        ref={body}
        className="inv-ci"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            submit()
          }
        }}
      >
        {content}
      </div>
    </Drawer>
  )
}

const AMOUNT_WORD: Record<CheckinItem['kind'], string> = { balance: 'balance', cash: 'cash balance', property: 'value', liability: 'balance owed' }

/** One number: what it was last, and a box for what it is now. */
export function CheckinRow({ item, draft, asOf, today, owners, error, autoFocus, onChange }: {
  item: CheckinItem
  draft: CheckinDraft | undefined
  asOf: string
  today: string
  owners: readonly string[]
  error: string | null
  autoFocus?: boolean
  onChange: (patch: Partial<CheckinDraft>) => void
}) {
  const on = draft?.on ?? asOf
  const account = item.kind === 'balance' || item.kind === 'cash'
  const word = AMOUNT_WORD[item.kind]
  // Two loans can share a name ("Mortgage"): the property tells their boxes apart.
  const label = item.kind === 'liability' && item.detail ? `${item.name} on ${item.detail}` : item.name
  return (
    <li className={`inv-ci-row${error ? ' inv-ci-bad' : ''}`}>
      <div className="inv-ci-who">
        <div className="inv-ci-name">
          {account && <OwnerAvatar owner={item.owner} owners={owners} />}
          <b>{item.name}</b>
          {item.detail && <span className="inv-ci-detail">{item.kind === 'liability' ? `on ${item.detail}` : item.detail}</span>}
        </div>
        <div className="inv-ci-last">
          {item.last ? (
            <>
              {formatCents(item.last.cents)} on {shortDay(item.last.on, today)}
              {item.kind === 'balance' && <StaleChip balancedOn={item.last.on} today={today} />}
            </>
          ) : item.kind === 'cash' ? (
            item.uncounted_cents > 0 ? (
              `No cash balance yet — ${formatCents(item.uncounted_cents)} of sales isn’t counted in net worth`
            ) : (
              'No cash balance yet'
            )
          ) : (
            `No ${word} yet`
          )}
        </div>
        {item.kind === 'cash' && item.last && item.derived_cents !== null && item.derived_cents !== item.last.cents && (
          <div className="inv-ci-last">With the trades since: {formatCents(item.derived_cents)} today</div>
        )}
        {error && (
          <div className="ui-field-err" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="inv-ci-amount">
        <MoneyInput
          autoFocus={autoFocus}
          value={draft?.cents ?? null}
          allowNegative={item.kind === 'cash'}
          // Not the last value: a grey figure reads as already filled in. Blank means "leave it".
          placeholder="—"
          aria-label={`${label} ${word}`}
          onChange={(cents) => onChange({ cents })}
        />
      </div>
      <div className="inv-ci-date">
        <DateInput value={on} max={today} aria-label={`${label} as of`} onChange={(v) => onChange({ on: v || null })} />
      </div>
      <div className="inv-ci-same">
        {item.last && (
          <button
            type="button"
            className="inv-linkbtn"
            title={`Still ${formatCents(item.last.cents)} — record it as of ${shortDay(on, today)}`}
            onClick={() => onChange({ cents: item.last!.cents })}
          >
            Unchanged
          </button>
        )}
      </div>
    </li>
  )
}
