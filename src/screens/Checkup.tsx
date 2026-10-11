import { useCallback, useEffect, useState } from 'react'
import type { AssumptionGroup, CalendarItem, Checkup as CheckupData, CheckupSettings, ResolvedRole } from '../../shared/checkup-api'
import { formatDollars } from '../../shared/money'
import { get, post, put } from '../api'
import { Link, type RouteTarget } from '../router'
import { BracketBar } from '../tax/BracketBar'
import { Button } from '../ui/Button'
import { DetailView, DrillCard, useDetail } from '../ui/Drill'
import { EmptyState } from '../ui/EmptyState'
import { Field, PercentInput, Select } from '../ui/Field'
import { Finding } from '../ui/Finding'
import { HeaderSlot } from '../ui/HeaderSlot'
import { useAnchor } from '../ui/screen'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import './screens.css'
import './checkup.css'

type Category = { id: number; name: string; kind: 'income' | 'expense' | 'transfer' }

const longDay = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

/** A role select's value: '' guesses from the names, '0' turns the role off, otherwise a category id. */
const roleValue = (v: number | null) => (v === null ? '' : String(v))
const roleFrom = (s: string): number | null => (s === '' ? null : Number(s))

function CheckupSkeleton() {
  return (
    <div className="grid12" aria-busy="true">
      <div className="card c8">
        <Skeleton h={12} w={120} />
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} h={36} style={{ marginTop: 14 }} />
        ))}
      </div>
      <div className="card c4">
        <Skeleton h={12} w={100} />
        <Skeleton h={160} style={{ marginTop: 14 }} />
      </div>
    </div>
  )
}

function Calendar({ items }: { items: CalendarItem[] }) {
  if (items.length === 0) return <p className="sub2">Nothing dated ahead this year.</p>
  return (
    <ol className="ck-cal">
      {items.map((x, i) => {
        const body = (
          <>
            <span className="ck-cal-day">{longDay(x.on)}</span>
            <span className="ck-cal-title">{x.title}</span>
            {x.cents !== null && <span className="ck-cal-cents">{formatDollars(x.cents)}</span>}
            <span className="ck-cal-detail">{x.detail}</span>
          </>
        )
        return (
          <li key={i}>
            {x.to ? (
              <Link to={x.to as RouteTarget} className="ck-cal-item">
                {body}
              </Link>
            ) : (
              <div className="ck-cal-item">{body}</div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function RoleSelect(p: { label: string; value: number | null; resolved: ResolvedRole; categories: Category[]; onChange: (v: number | null) => void }) {
  // While guessing, the option names what the guess found; once a category is picked, it offers guessing back.
  const guess = p.value === null ? (p.resolved ? `Guess: ${p.resolved.name}` : 'Guess: none fits') : 'Guess from names'
  return (
    <div className="scr-f lg">
      <Field label={p.label}>
        <Select value={roleValue(p.value)} onChange={(e) => p.onChange(roleFrom(e.target.value))}>
          <option value="">{guess}</option>
          <option value="0">None</option>
          {p.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
}

function Assumptions({ groups }: { groups: AssumptionGroup[] | null }) {
  if (!groups) return <Skeleton h={160} />
  return (
    <div className="ck-asm">
      {groups.map((g) => (
        <section key={g.id} className="ck-asm-group">
          <h3>{g.title}</h3>
          <table>
            <tbody>
              {g.rows.map((r, i) => (
                <tr key={i}>
                  <td className="muted">{r.label}</td>
                  <td className="r num">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {g.note && <p className="ck-asm-note">{g.note}</p>}
          <p className="ck-asm-src">
            {g.source} · <span className="ck-asm-vintage">{g.vintage}</span>
          </p>
        </section>
      ))}
    </div>
  )
}

/**
 * The Checkup: what the ledger says a planner or a tax preparer would bring
 * up, largest dollar impact first — each finding opening into its rule, the
 * household's numbers, the arithmetic and what it leaves out. Findings, never
 * advice. Then the dated items ahead and the bracket headroom every timing
 * decision needs. One level down, in one view: the few settings the rules
 * read ('#/checkup/settings', the top of it) and every constant behind them
 * with its vintage ('#/checkup/assumptions', which scrolls to them).
 */
const DETAILS = ['assumptions', 'settings'] as const

export default function Checkup() {
  const detail = useDetail(DETAILS)
  const [data, setData] = useState<CheckupData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [assumptions, setAssumptions] = useState<AssumptionGroup[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [form, setForm] = useState<CheckupSettings | null>(null)
  const calendarAnchor = useAnchor('calendar')
  const assumptionsAnchor = useAnchor('assumptions')

  const load = useCallback(async () => {
    const [c, a, cats] = await Promise.all([
      get<CheckupData>('/api/checkup'),
      get<AssumptionGroup[]>('/api/assumptions'),
      get<Category[]>('/api/categories'),
    ])
    setData(c)
    setAssumptions(a)
    setCategories(cats.filter((x) => x.kind === 'expense'))
    setForm((f) => f ?? c.settings)
    setError(null)
  }, [])
  useEffect(() => {
    // On mount and on every reveal: a quiet refetch behind what's showing.
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [load])
  const reload = () => load().catch((e: unknown) => toast.error("Couldn't refresh the Checkup", { detail: e instanceof Error ? e.message : String(e) }))

  const ack = useAction(() => post<{ ok: true; seenAt: string }>('/api/checkup/ack', {}), {
    success: 'Marked seen — from now on only new findings are tagged',
    errorPrefix: "Couldn't mark the Checkup seen",
    onDone: () => void reload(),
  })
  const save = useAction((s: CheckupSettings) => put<{ ok: true; settings: CheckupSettings }>('/api/checkup/settings', s), {
    success: 'Checkup settings saved — the findings recomputed',
    errorPrefix: "Couldn't save the Checkup settings",
    onDone: (r) => {
      setForm(r.settings)
      void reload()
    },
  })

  if (!data) {
    if (error)
      return (
        <>
          <HeaderSlot sub="What the ledger says is worth a look" />
          <div className="card wide" role="alert">
            <h2>Couldn't run the Checkup</h2>
            <p className="sub2">{error}</p>
            <Button onClick={() => load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))}>Retry</Button>
          </div>
        </>
      )
    return (
      <>
        <HeaderSlot sub="What the ledger says is worth a look" />
        <CheckupSkeleton />
      </>
    )
  }

  const { findings } = data
  const fresh = findings.filter((f) => f.isNew).length
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(data.settings)

  const header = (
      <HeaderSlot
        sub={
          findings.length === 0
            ? 'Every rule ran against the ledger; none fired'
            : `${findings.length} finding${findings.length > 1 ? 's' : ''}${fresh ? ` · ${fresh} new` : ''} · largest dollar impact first`
        }
        actions={
          fresh > 0 ? (
            <Button busy={ack.busy} onClick={() => void ack.run()}>
              Mark all seen
            </Button>
          ) : undefined
        }
      />
  )

  const constants = assumptions?.reduce((n, g) => n + g.rows.length, 0) ?? null

  if (detail)
    return (
      <DetailView title="How Checkup works" lead="The few settings the rules read, and every constant behind them with its source and vintage.">
        {header}
      {form && (
        <div className="card c12">
          <h2>What the rules read</h2>
          <div className="scr-fields">
            <div className="scr-f lg">
              <Field label="Employer stock" hint="flag above this share of liquid assets">
                <PercentInput
                  valueMicro={form.concentrationMicro}
                  onChange={(v) => setForm({ ...form, concentrationMicro: v ?? data.settings.concentrationMicro })}
                />
              </Field>
            </div>
            <RoleSelect label="Charitable giving" value={form.charityCategoryId} resolved={data.roles.charity} categories={categories} onChange={(v) => setForm({ ...form, charityCategoryId: v })} />
            <RoleSelect label="Property tax" value={form.propertyTaxCategoryId} resolved={data.roles.propertyTax} categories={categories} onChange={(v) => setForm({ ...form, propertyTaxCategoryId: v })} />
            <RoleSelect label="Gifts to people" value={form.giftCategoryId} resolved={data.roles.gift} categories={categories} onChange={(v) => setForm({ ...form, giftCategoryId: v })} />
          </div>
          <div className="scr-formfoot">
            <span className="scr-note muted">
              The categories feed the itemized deduction (also used on Taxes), the appreciated-shares finding and the gift-tax date.
            </span>
            {dirty && (
              <Button variant="ghost" onClick={() => setForm(data.settings)}>
                Undo
              </Button>
            )}
            <Button variant="gold" busy={save.busy} disabled={!dirty} onClick={() => void save.run(form)}>
              Save
            </Button>
          </div>
        </div>
      )}

      <div className="card c12" ref={assumptionsAnchor}>
        <div className="h4row">
          <h2>Assumptions</h2>
          <div className="right">
            <span className="muted">every constant the engine uses, and where it comes from</span>
          </div>
        </div>
        <Assumptions groups={assumptions} />
      </div>
      </DetailView>
    )

  return (
    <div className="grid12">
      {header}

      <div className="card c8">
        <div className="h4row">
          <h2>Findings</h2>
          <div className="right">
            <span className="muted">derived from the ledger on every visit</span>
          </div>
        </div>
        {findings.length === 0 ? (
          <EmptyState
            title="Nothing to flag"
            body="Concentration, cash runway, deductions, harvesting, estimated tax and the rest all ran and none fired. The more of the household Scarab holds — paychecks, lots, the mortgage — the more the rules can see."
          />
        ) : (
          <div className="ck-list">
            {findings.map((f, i) => (
              <Finding key={f.id} finding={f} defaultOpen={i === 0 && findings.length === 1} />
            ))}
          </div>
        )}
      </div>

      <div className="card c4" ref={calendarAnchor}>
        <h2>Tax calendar</h2>
        <Calendar items={data.calendar} />
      </div>

      <div className="card c8">
        <div className="h4row">
          <h2>Bracket headroom · {data.headroom.year}</h2>
          <div className="right">
            <Link to={{ screen: 'tax' }} className="ck-a">
              The whole tax picture →
            </Link>
          </div>
        </div>
        <BracketBar h={data.headroom} />
        <p className="ck-fine">
          Federal only, from this year’s projection on Taxes · {data.headroom.vintage}. The number every Roth-conversion,
          gain-realizing and vest-timing question starts from. An estimate, not advice.
        </p>
      </div>

      <DrillCard
        to="settings"
        span="c4"
        title="How Checkup works"
        value={constants === null ? undefined : `${constants} constants`}
        note="Every bracket, limit and threshold the rules use, with its source and vintage — and the settings they read"
      />
    </div>
  )
}
