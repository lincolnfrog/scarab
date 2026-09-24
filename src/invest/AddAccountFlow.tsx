import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react'
import type { InvestAccountCreate, InvestAccountRow, InvestKind, InvestSubtype } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { post, put } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { DateInput, Field, FieldGrid, MoneyInput, TextInput } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import { ChoiceField, OwnerPicker } from './AccountFields'
import { ACCOUNT_TYPES, accountType, COMMON_INSTITUTIONS, KIND_TEXT, kindFor, maskInput, suggestName, TYPE_GROUPS, type AccountType } from './accountTypes'
import { shortDay } from './balanceMath'
import { unparsedMoney } from './formGuard'
import './invest.css'

/** What the flow hands off to once the account exists. */
export type AddAccountNext =
  | { to: 'paste'; accountId: number }
  | { to: 'trade'; accountId: number }
  | { to: 'account'; accountId: number; tab?: 'balances' | 'settings' }

export type AddAccountFlowProps = {
  open: boolean
  owners: readonly string[]
  /** Institutions the household already uses — suggested first. */
  institutions: readonly string[]
  today: string
  onClose: () => void
  /** After the account (and any first balance) is saved — the screen reloads; resolve once it has. */
  onCreated: () => Promise<unknown>
  /** A choice on the last step: paste starting positions, record a trade, or open the account. */
  onNext: (next: AddAccountNext) => void
}

type Details = {
  institution: string
  name: string
  /** The name was typed: stop suggesting one. */
  named: boolean
  owner: string | null
  mask: string
  kind: InvestKind
  tracking: 'lots' | 'balance'
  stockPlan: boolean
  balanceCents: number | null
  balancedOn: string
}

type Created = { account: InvestAccountRow; balance: { cents: number; on: string } | null; balanceError: string | null }

/**
 * "Add account", guided: pick what kind of account it is from a card — the
 * card knows its tax treatment and how it's usually followed — then the few
 * details that tell accounts apart (institution, owner, last 4), then a
 * hand-off to what comes next: paste what a brokerage already holds, or the
 * first balance of a 401(k). Opens at #/invest?d=add-account.
 */
export default function AddAccountFlow(p: AddAccountFlowProps) {
  // Each opening starts fresh; the content stays through the exit animation.
  const [session, setSession] = useState(0)
  const [wasOpen, setWasOpen] = useState(p.open)
  if (p.open !== wasOpen) {
    setWasOpen(p.open)
    if (p.open) setSession((n) => n + 1)
  }
  return <Flow key={session} {...p} />
}

function defaultsFor(t: AccountType, owners: readonly string[], today: string): Details {
  return {
    institution: '',
    name: '',
    named: false,
    owner: t.individual && owners.length > 0 ? owners[0]! : null,
    mask: '',
    kind: 'brokerage',
    tracking: t.tracking,
    stockPlan: t.stockPlan === true,
    balanceCents: null,
    balancedOn: today,
  }
}

function Flow({ open, owners, institutions, today, onClose, onCreated, onNext }: AddAccountFlowProps) {
  const [type, setType] = useState<AccountType | null>(null)
  const [d, setD] = useState<Details | null>(null)
  const [created, setCreated] = useState<Created | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const listId = useId()
  const formId = useId()
  // Moving between steps inside the open drawer: focus lands where the new step starts.
  const panel = useRef<HTMLDivElement>(null)
  const lastPicked = useRef<InvestSubtype | null>(null)
  const step = created ? 'done' : type && d ? 'details' : 'type'
  const firstStep = useRef(true)
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false // the drawer's own initial focus handles the first step
      return
    }
    const root = panel.current
    if (step === 'type') (root?.querySelector<HTMLElement>(`[data-subtype="${lastPicked.current}"]`) ?? root?.querySelector<HTMLElement>('button'))?.focus()
    else if (step === 'done') root?.querySelector<HTMLElement>('.inv-nextcard')?.focus()
    // details: the institution box takes focus itself (autoFocus, the drawer already open)
  }, [step])
  const suggestions = useMemo(() => [...new Set([...institutions, ...COMMON_INSTITUTIONS])], [institutions])

  const pick = (t: AccountType) => {
    lastPicked.current = t.subtype
    setType(t)
    setD(defaultsFor(t, owners, today))
  }
  const set = (patch: Partial<Details>) => setD((x) => (x ? { ...x, ...patch } : x))
  const name = type && d ? (d.named ? d.name : suggestName({ subtype: type.subtype, institution: d.institution, owner: d.owner, owners })) : ''

  const create = useAction(
    async (t: AccountType, v: Details, accountName: string): Promise<Created> => {
      const body: InvestAccountCreate = {
        name: accountName.trim(),
        subtype: t.subtype,
        ...(t.subtype === 'other' ? { kind: v.kind } : {}),
        tracking: v.tracking,
        stockPlan: v.tracking === 'lots' && v.stockPlan,
        institution: v.institution.trim() || null,
        owner: v.owner?.trim() || null,
        mask: v.mask.trim() || null,
      }
      const account = await post<InvestAccountRow>('/api/invest/accounts', body)
      // The account exists now; a first balance that fails is said separately, not as a failed add.
      let balance: Created['balance'] = null
      let balanceError: string | null = null
      if (v.tracking === 'balance' && v.balanceCents !== null) {
        try {
          await put('/api/invest/balances', { investAccountId: account.id, balancedOn: v.balancedOn, balanceCents: v.balanceCents })
          balance = { cents: v.balanceCents, on: v.balancedOn }
        } catch (e) {
          balanceError = e instanceof Error ? e.message : String(e)
        }
      }
      await onCreated()
      return { account, balance, balanceError }
    },
    {
      success: (r) => `Added “${r.account.name}”`,
      errorPrefix: "Couldn't add the account",
      onDone: (r) => {
        if (r.balanceError) toast.error("The account was added, but its balance wasn't saved", { detail: r.balanceError })
        setCreated(r)
      },
    },
  )

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!type || !d || create.busy || !name.trim()) return
    const bad = unparsedMoney(form.current)
    if (bad) return bad.focus()
    void create.run(type, d, name)
  }

  /* ---------- step 3: what next ---------- */
  if (created) {
    const a = created.account
    const lots = a.tracking === 'lots'
    return (
      <Drawer
        open={open}
        onClose={onClose}
        width={600}
        title={`${a.name} is ready`}
        subtitle={lots ? 'Next: what it already holds' : created.balance ? 'Balance recorded' : 'Next: its balance'}
        footer={<Button variant="ghost" onClick={onClose}>Done</Button>}
      >
        <div className="inv-next" ref={panel}>
          {lots ? (
            <>
              <NextCard
                primary
                title="Paste what it holds"
                body="Each lot as of a statement date — symbol, shares, cost basis, acquired. The real acquisition dates keep holding periods and tax right."
                onClick={() => onNext({ to: 'paste', accountId: a.id })}
              />
              <NextCard title="Record a trade" body="Start from a buy or a sale you just made." onClick={() => onNext({ to: 'trade', accountId: a.id })} />
              <NextCard title="Open the account" body="Its positions, activity and settings." onClick={() => onNext({ to: 'account', accountId: a.id })} />
            </>
          ) : created.balance ? (
            <>
              <p className="inv-note inv-nextlede">
                {formatCents(created.balance.cents)} as of {shortDay(created.balance.on, today)}. A few quarter-ends from old statements give net worth its history.
              </p>
              <NextCard primary title="Backfill older statements" body="Quarter-end balances, eight at a time." onClick={() => onNext({ to: 'account', accountId: a.id, tab: 'balances' })} />
            </>
          ) : (
            <NextCard
              primary
              title="Enter its balance"
              body="The total from the provider’s site or the latest statement — and older quarter-ends if you have them."
              onClick={() => onNext({ to: 'account', accountId: a.id, tab: 'balances' })}
            />
          )}
        </div>
      </Drawer>
    )
  }

  /* ---------- step 1: what kind of account ---------- */
  if (!type || !d)
    return (
      <Drawer open={open} onClose={onClose} width={600} title="Add an account" subtitle="What kind is it? The type sets its tax treatment and how Scarab follows it.">
        <div className="inv-types" ref={panel}>
          {TYPE_GROUPS.map((g) => (
            <section key={g.id} className="inv-typegroup" aria-label={g.title}>
              <h3 className="inv-typehead">{g.title}</h3>
              <div className="inv-typegrid">
                {ACCOUNT_TYPES.filter((t) => t.group === g.id).map((t) => (
                  <button key={t.subtype} type="button" className="inv-typecard" data-subtype={t.subtype} onClick={() => pick(t)}>
                    <span className="inv-typecard-title">{t.title}</span>
                    <span className="inv-typecard-blurb">{t.blurb}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Drawer>
    )

  /* ---------- step 2: the details ---------- */
  const kind = kindFor(type.subtype, d.kind)
  return (
    <Drawer
      open={open}
      onClose={onClose}
      dismissible={!create.busy}
      width={600}
      title={`New ${type.title === 'Something else' ? 'account' : type.title}`}
      subtitle={`${KIND_TEXT[kind].label} · only the name is required`}
      footer={
        <>
          <Button variant="ghost" className="ui-foot-start" onClick={() => setType(null)} disabled={create.busy}>
            ← Back
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={create.busy}>
            Cancel
          </Button>
          <Button type="submit" form={formId} variant="gold" busy={create.busy} disabled={!name.trim()}>
            Add account
          </Button>
        </>
      }
    >
      <form ref={form} id={formId} className="inv-form inv-addform" onSubmit={submit}>
        <FieldGrid min={220}>
          <Field label="Institution" hint={type.subtype === 'crypto' ? 'The exchange or wallet' : 'Where it’s held'}>
            <TextInput
              autoFocus
              value={d.institution}
              maxLength={60}
              list={listId}
              placeholder={type.subtype === 'crypto' ? 'e.g. Coinbase' : 'e.g. Fidelity'}
              onChange={(e) => set({ institution: e.target.value })}
            />
          </Field>
          <Field label="Name" hint={d.named ? undefined : 'Suggested — type to change it'}>
            <TextInput
              value={name}
              maxLength={60}
              required
              onChange={(e) => set({ name: e.target.value, named: true })}
            />
          </Field>
        </FieldGrid>
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>

        <div className="inv-row2">
          <ChoiceField label="Owner" hint={type.individual ? 'Retirement accounts and stock plans belong to one person.' : undefined}>
            <OwnerPicker owners={owners} value={d.owner} onChange={(owner) => set({ owner })} />
          </ChoiceField>
          <div className="inv-maskfield">
            <Field label="Last 4" hint="Optional">
              <TextInput value={d.mask} maxLength={24} autoComplete="off" placeholder="1234" className="inv-mask" onChange={(e) => set({ mask: maskInput(e.target.value) })} />
            </Field>
          </div>
        </div>

        {type.subtype === 'other' && (
          <ChoiceField label="Tax treatment" hint={KIND_TEXT[d.kind].note}>
            <Segmented
              aria-label="Tax treatment"
              size="md"
              value={d.kind}
              onChange={(k) => set({ kind: k })}
              options={(['brokerage', 'retirement', 'crypto'] as const).map((k) => ({ value: k, label: KIND_TEXT[k].label }))}
            />
          </ChoiceField>
        )}

        <ChoiceField label="How Scarab follows it" hint={trackingHint(type.subtype, d.tracking)}>
          <Segmented
            aria-label="Tracking"
            size="md"
            value={d.tracking}
            onChange={(tracking) => set({ tracking })}
            options={[
              { value: 'lots', label: 'Track trades' },
              { value: 'balance', label: 'Track balance', disabled: type.stockPlan === true, title: type.stockPlan ? 'Vests land as buys, so a stock plan tracks trades' : undefined },
            ]}
          />
        </ChoiceField>

        {d.tracking === 'lots' && type.subtype === 'taxable' && (
          <label className="checkline inv-check">
            <input type="checkbox" checked={d.stockPlan} onChange={(e) => set({ stockPlan: e.target.checked })} />
            <span>
              My employer’s RSUs vest here
              <span className="inv-subline">Its Grants tab then keeps the unvested count, and each vest is recorded as a buy.</span>
            </span>
          </label>
        )}

        {d.tracking === 'balance' && (
          <div className="inv-firstbal">
            <FieldGrid min={180}>
              <Field label="Current balance" hint="Optional — or enter it later">
                <MoneyInput value={d.balanceCents} onChange={(balanceCents) => set({ balanceCents })} aria-label="Current balance" />
              </Field>
              <Field label="As of">
                <DateInput value={d.balancedOn} max={today} onChange={(balancedOn) => set({ balancedOn })} />
              </Field>
            </FieldGrid>
          </div>
        )}
      </form>
    </Drawer>
  )
}

function trackingHint(subtype: InvestSubtype, tracking: 'lots' | 'balance'): string {
  const t = accountType(subtype)
  if (tracking === 'lots')
    return subtype === 'taxable' || subtype === 'crypto' || subtype === 'stock_plan'
      ? 'Each buy and sell — so holdings, cost basis and the tax on every sale come out right.'
      : 'Each buy and sell: holdings and returns, with no tax to track inside the account.'
  return t.tracking === 'balance'
    ? 'The total from each statement — the usual way for a workplace plan. Simple: no holdings or lots.'
    : 'The total from each statement. Simple, but no holdings, lots or per-holding returns.'
}

function NextCard({ title, body, onClick, primary }: { title: string; body: string; onClick: () => void; primary?: boolean }) {
  return (
    <button type="button" className={`inv-nextcard${primary ? ' inv-nextcard-primary' : ''}`} onClick={onClick}>
      <span className="inv-nextcard-title">{title} →</span>
      <span className="inv-nextcard-body">{body}</span>
    </button>
  )
}
