import { useId, useMemo, useState, type FormEvent } from 'react'
import type { InvestAccountRow, InvestAccountUpdateResult, InvestKind } from '../../shared/invest-api'
import { del, patch } from '../api'
import { Button } from '../ui/Button'
import { confirm } from '../ui/dialogs'
import { Field, FieldGrid, Select, TextInput } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { useAction } from '../ui/useAction'
import { ChoiceField, OwnerPicker } from './AccountFields'
import {
  ACCOUNT_TYPES,
  accountPatch,
  COMMON_INSTITUTIONS,
  formFromAccount,
  formKind,
  KIND_TEXT,
  maskInput,
  stockPlanLock,
  TYPE_GROUPS,
  trackingLock,
  typeLabel,
  type AccountForm,
} from './accountTypes'
import './invest.css'

const plural = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)
const sameForm = (a: AccountForm, b: AccountForm) => (Object.keys(a) as (keyof AccountForm)[]).every((k) => a[k] === b[k])

export type AccountDeleted = { name: string; removed: { trades: number; balances: number; unvested: number }; unlinkedPaychecks: number }

/**
 * The account drawer's Settings tab: the profile (name, type, institution,
 * owner, last 4), the stock-plan flag, how it's tracked (locked, with the
 * reason, once something is recorded) and its tax treatment — then Delete.
 * Save sends only what changed.
 */
export default function AccountSettings({ account, owners, institutions, onSaved, onDeleted }: {
  account: InvestAccountRow
  owners: readonly string[]
  /** Institutions the household already uses — offered first. */
  institutions: readonly string[]
  onSaved: () => void
  onDeleted: (r: AccountDeleted) => void
}) {
  const [form, setForm] = useState<AccountForm>(() => formFromAccount(account))
  // A save (or someone else's edit) changes the stored profile: start again
  // from it. A reload that changed nothing keeps what is being typed.
  const [basis, setBasis] = useState(account)
  if (basis !== account) {
    setBasis(account)
    if (!sameForm(formFromAccount(basis), formFromAccount(account))) setForm(formFromAccount(account))
  }
  const set = (f: Partial<AccountForm>) => setForm((x) => ({ ...x, ...f }))
  const change = accountPatch(account, form)
  const dirty = Object.keys(change).length > 0
  const kind = formKind(form)
  const tLock = trackingLock(account)
  const spLock = stockPlanLock(account)
  const suggestions = useMemo(() => [...new Set([...institutions, ...COMMON_INSTITUTIONS])], [institutions])
  const listId = useId()

  const save = useAction((p: typeof change) => patch<InvestAccountUpdateResult>(`/api/invest/accounts/${account.id}`, p), {
    success: (r) => (r.changed ? `Saved “${r.account.name}”` : 'Nothing to change'),
    errorPrefix: "Couldn't save the account",
    onDone: onSaved,
  })

  const remove = useAction(() => del<AccountDeleted>(`/api/invest/accounts/${account.id}`), {
    success: (r) => {
      const bits = [plural(r.removed.trades, 'trade'), plural(r.removed.balances, 'balance update'), plural(r.removed.unvested, 'unvested grant')].filter(Boolean)
      return (
        (bits.length ? `Deleted “${r.name}” and ${bits.join(', ')}.` : `Deleted “${r.name}”.`) +
        (r.unlinkedPaychecks ? ` ${plural(r.unlinkedPaychecks, 'paycheck')} lost the stock-comp link.` : '')
      )
    },
    errorPrefix: "Couldn't delete the account",
    onDone: onDeleted,
  })

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!dirty || !form.name.trim() || save.busy) return
    // Shelter is derived from kind: say what moves before it does.
    if (change.kind && account.counts.trades > 0) {
      const to = KIND_TEXT[change.kind as InvestKind]
      const ok = await confirm({
        title: `Treat ${account.name} as ${to.label.toLowerCase()}?`,
        body: (
          <>
            <p>{to.note} Its {plural(account.counts.trades, 'trade')} stay as they are; realized gains, the tax picture and the harvest list recompute.</p>
            <p>Change it only if the account really is {to.label.toLowerCase()} — a misfiled Roth, say.</p>
          </>
        ),
        confirmLabel: `Make it ${to.label.toLowerCase()}`,
      })
      if (!ok) return
    }
    await save.run(change)
  }

  async function confirmDelete() {
    const c = account.counts
    const facts = [plural(c.trades, 'trade'), plural(c.balances, 'balance update'), plural(c.unvested, 'unvested grant')].filter(Boolean)
    const ok = await confirm({
      title: `Delete “${account.name}”?`,
      body: (
        <>
          <p>
            {facts.length
              ? `This also deletes ${facts.join(', ')}. Holdings, net worth and the tax picture recompute without them.`
              : 'Nothing has been recorded against it yet.'}
            {c.paychecks > 0 && ` ${plural(c.paychecks, 'paycheck')} will lose the stock-comp link.`}
          </p>
          <p>There is no undo — export from Data &amp; Vault first if you want a way back.</p>
        </>
      ),
      confirmLabel: 'Delete account',
      danger: true,
      typeToConfirm: 'delete',
    })
    if (ok) await remove.run()
  }

  const typeKnown = form.subtype !== '' && form.subtype !== 'other'
  return (
    <div className="inv-panel">
      <form className="inv-form inv-settings" onSubmit={(e) => void submit(e)}>
        <FieldGrid min={300}>
          <Field label="Name">
            <TextInput value={form.name} maxLength={60} required onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Type">
            <Select value={form.subtype} onChange={(e) => set({ subtype: e.target.value as AccountForm['subtype'] })}>
              {account.subtype === null && <option value="">Not set — {typeLabel({ ...account, subtype: null })}</option>}
              {TYPE_GROUPS.map((g) => (
                <optgroup key={g.id} label={g.title}>
                  {ACCOUNT_TYPES.filter((t) => t.group === g.id).map((t) => (
                    <option key={t.subtype} value={t.subtype}>
                      {t.title}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </Field>
          <Field label="Institution" hint="Optional">
            <TextInput value={form.institution} maxLength={60} list={listId} placeholder="e.g. Fidelity" onChange={(e) => set({ institution: e.target.value })} />
          </Field>
          <Field label="Last 4" hint="Optional — to tell accounts apart">
            <TextInput
              value={form.mask}
              maxLength={24}
              inputMode="text"
              autoComplete="off"
              placeholder="1234"
              className="inv-mask"
              onChange={(e) => set({ mask: maskInput(e.target.value) })}
            />
          </Field>
        </FieldGrid>
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <ChoiceField label="Owner" hint={form.owner === null ? 'Joint: both of you.' : undefined}>
          <OwnerPicker owners={owners} value={form.owner} onChange={(owner) => set({ owner })} />
        </ChoiceField>

        <ChoiceField
          label="Tax treatment"
          hint={typeKnown ? `${KIND_TEXT[kind].note} Set by its type.` : KIND_TEXT[kind].note}
        >
          <Segmented
            aria-label="Tax treatment"
            size="md"
            value={kind}
            onChange={(k) => set({ kind: k })}
            options={(['brokerage', 'retirement', 'crypto'] as const).map((k) => ({
              value: k,
              label: KIND_TEXT[k].label,
              disabled: typeKnown && k !== kind,
              title: typeKnown && k !== kind ? 'Set by the account’s type — change the type instead' : undefined,
            }))}
          />
        </ChoiceField>

        <ChoiceField
          label="Tracking"
          hint={
            tLock ??
            (form.tracking === 'lots'
              ? 'Each buy and sell is recorded; holdings, cost basis and tax are worked out from them.'
              : 'The total from each statement; no holdings or tax lots.')
          }
        >
          <Segmented
            aria-label="Tracking"
            size="md"
            value={form.tracking}
            onChange={(tracking) => set({ tracking, ...(tracking === 'balance' ? { stockPlan: false } : {}) })}
            options={[
              { value: 'lots', label: 'Track trades', disabled: !!tLock && account.tracking !== 'lots' },
              { value: 'balance', label: 'Track balance', disabled: (!!tLock && account.tracking !== 'balance') || (form.stockPlan && !!spLock) },
            ]}
          />
        </ChoiceField>

        {form.tracking === 'lots' && (
          <label className="checkline inv-check" title={spLock && form.stockPlan ? spLock : undefined}>
            <input
              type="checkbox"
              checked={form.stockPlan}
              disabled={form.stockPlan && !!spLock}
              onChange={(e) => set({ stockPlan: e.target.checked })}
            />
            <span>
              Employee stock plan — grants vest here
              <span className="inv-subline">{form.stockPlan && spLock ? spLock : 'Its Grants tab then keeps the unvested shares, and each vest is recorded as a buy.'}</span>
            </span>
          </label>
        )}

        <div className="inv-actions">
          <Button type="submit" variant="gold" busy={save.busy} disabled={!dirty || !form.name.trim()}>
            Save changes
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(formFromAccount(account))}>
              Undo changes
            </Button>
          )}
        </div>
      </form>

      <div className="inv-danger">
        <div>
          <div className="inv-formtitle">Delete this account</div>
          <p className="inv-note">Removes it and everything recorded against it. Other accounts are untouched.</p>
        </div>
        <Button variant="danger" busy={remove.busy} onClick={() => void confirmDelete()}>
          Delete account…
        </Button>
      </div>
    </div>
  )
}
