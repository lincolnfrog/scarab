import type { ReactNode } from 'react'
import type { Setup, SetupStep } from '../../engine/setup'
import { put } from '../api'
import { Link, navigate, type RouteTarget } from '../router'
import { FILING_LABEL } from '../tax/copy'
import { Button } from '../ui/Button'
import { DrillCard } from '../ui/Drill'
import { useAction } from '../ui/useAction'
import './setup.css'

/**
 * The Dashboard's setup checklist (engine/setup.ts): what a new household
 * brings in, one row per step, each linking into the flow that already does
 * it (`?d=` actions and detail views). While the household has nothing to add
 * up, SetupHero takes the net-worth hero's place; once it has, SetupCard is
 * one card on the overview and the list is a click down ('#/dash/setup'). It
 * goes away when every step is done, or when this person hides it.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)
const andList = (names: readonly string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

/** Where a step's action goes. `params.d` is the screen's deep action (src/ui/CommandPalette.tsx DEEP_ACTIONS). */
type Go = { label: string; to: RouteTarget }

type View = {
  title: string
  /** What the step is for while it's to do; what's there once it's done. */
  note: ReactNode
  /** The way to do it. None: it waits on another step. */
  go?: Go
}

function viewOf(s: SetupStep): View {
  switch (s.id) {
    case 'bank':
      return {
        title: 'Bring in a bank or card account',
        note: s.done
          ? `${plural(s.transactions, 'transaction')} in ${plural(s.accounts, 'account')}`
          : 'Spending, the budget and cash on hand come from its statements — a CSV or OFX download.',
        go:
          s.accounts === 0
            ? { label: 'Add an account', to: { screen: 'cash', rest: ['import'], params: { d: 'add-account' } } }
            : { label: 'Import a statement', to: { screen: 'cash', rest: ['import'], params: { d: 'import' } } },
      }
    case 'invest':
      return {
        title: 'Add an investment account',
        note: s.done ? plural(s.accounts, 'account') : 'A brokerage, a 401(k) or an IRA — its holdings, or just the balance on its statement.',
        go: s.accounts === 0 ? { label: 'Add an account', to: { screen: 'invest', params: { d: 'add-account' } } } : { label: 'Open Investments', to: { screen: 'invest' } },
      }
    case 'property':
      return {
        title: 'Add your home',
        note: s.done ? plural(s.properties, 'property', 'properties') : 'Its value less the mortgage is your home equity. Renting? Leave this one.',
        go: { label: 'Add a property', to: { screen: 're', params: { d: 'add-property' } } },
      }
    case 'paycheck':
      return {
        title: 'Add a paycheck',
        note: s.done ? plural(s.paychecks, 'paycheck') : 'One pay stub projects the year’s wages, withholding and 401(k) pace.',
        go: { label: 'Add a paycheck', to: { screen: 'tax', params: { d: 'add-paycheck' } } },
      }
    case 'people':
      return {
        title: 'Add birth years',
        note: s.done
          ? `Everyone’s is in (${plural(s.people, 'person', 'people')})`
          : s.people === 0
            ? 'Once a paycheck names who earns it — ages set the catch-up limits.'
            : `For ${andList(s.missing)} — ages set the catch-up limits.`,
        go: s.people === 0 ? undefined : { label: 'Add birth years', to: { screen: 'tax', rest: ['contributions'] } },
      }
    case 'filing':
      return {
        title: 'Confirm how you file',
        note: s.done
          ? `${sentence(FILING_LABEL[s.filingStatus])} · ${s.stateName}`
          : `Taxes assumes ${FILING_LABEL[s.filingStatus]} in ${s.stateName} until you say so.`,
        go: { label: 'Change', to: { screen: 'tax', rest: ['settings'] } },
      }
  }
}

/** The first step still to do that can be done now: its action is the gold one. */
const nextOf = (setup: Setup): SetupStep | null => setup.steps.find((s) => !s.done && viewOf(s).go) ?? null

function Mark({ done, n }: { done: boolean; n: number }) {
  return (
    <span className="su-mark" aria-hidden="true">
      {done ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : (
        n
      )}
    </span>
  )
}

/** Every step, in order. `onChanged` runs after a step changed here (the filing confirmation) — the caller re-reads. */
export function SetupList({ setup, onChanged }: { setup: Setup; onChanged: () => void }) {
  const next = nextOf(setup)
  // The defaults are right for this household: saving them is the answer Taxes was waiting for.
  const confirmFiling = useAction(
    (s: Extract<SetupStep, { id: 'filing' }>) => put('/api/tax/settings', { filingStatus: s.filingStatus, state: s.state }).then(() => s),
    {
      success: (s) => `Saved — Taxes works from ${FILING_LABEL[s.filingStatus]} in ${s.stateName}`,
      errorPrefix: "Couldn't save the filing status",
      onDone: onChanged,
    },
  )
  return (
    <ol className="su-list">
      {setup.steps.map((s, i) => {
        const v = viewOf(s)
        const gold = next?.id === s.id
        return (
          <li key={s.id} className="su-step" data-done={s.done || undefined}>
            <Mark done={s.done} n={i + 1} />
            <div className="su-text">
              <span className="su-title">
                <span className="ui-sr">{s.done ? 'Done: ' : 'To do: '}</span>
                {v.title}
              </span>
              <span className="su-note">{v.note}</span>
            </div>
            {!s.done && (
              <div className="su-act">
                {s.id === 'filing' && (
                  <Button size="mini" variant={gold ? 'gold' : 'default'} busy={confirmFiling.busy} onClick={() => void confirmFiling.run(s)}>
                    That’s right
                  </Button>
                )}
                {v.go && (
                  // Filing's link is the alternative to its confirmation, so it never wears the gold.
                  <Link to={v.go.to} className={s.id === 'filing' ? 'btn mini ghosty' : gold ? 'btn mini gold' : 'btn mini'}>
                    {v.go.label}
                  </Link>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/** "2 of 6" over "steps done", the way the net-worth hero puts its figure over its change. */
function Progress({ setup }: { setup: Setup }) {
  return (
    <div className="su-progress">
      <span className="su-figure">
        {setup.done} of {setup.steps.length}
      </span>
      <span className="su-figure-label">steps done</span>
    </div>
  )
}

/** The empty household's Dashboard: the checklist in the hero's place. */
export function SetupHero({ setup, onChanged }: { setup: Setup; onChanged: () => void }) {
  return (
    <div className="card c12 hero su-hero">
      <h2>Set up your household</h2>
      <Progress setup={setup} />
      <p className="su-lead">
        Net worth adds itself up from what you bring in, and each step lights up more of this Dashboard. Do them in any order — skip what
        doesn’t apply.
      </p>
      <SetupList setup={setup} onChanged={onChanged} />
    </div>
  )
}

/** Once there's something to add up: one card on the overview, the list a click down. */
export function SetupCard({ setup, span }: { setup: Setup; span?: string }) {
  const next = nextOf(setup)
  const title = next ? viewOf(next).title : null
  return (
    <DrillCard
      to="setup"
      span={span}
      title="Setting up"
      value={`${setup.done} of ${setup.steps.length}`}
      note={title ? `Next: ${title.charAt(0).toLowerCase()}${title.slice(1)}` : 'steps done'}
    />
  )
}

/** '#/dash/setup': the whole list, and the way to hide it (or bring it back). */
export function SetupDetail({ setup, onChanged }: { setup: Setup; onChanged: () => void }) {
  const hide = useAction((hidden: boolean) => put<Setup>('/api/setup', { hidden }), {
    success: (r) => (r.hidden ? 'Checklist hidden from the Dashboard' : 'The checklist is back on the Dashboard'),
    errorPrefix: "Couldn't change the checklist",
    onDone: (r) => {
      onChanged()
      if (r.hidden) navigate({ screen: 'dash' })
    },
  })
  const complete = setup.done === setup.steps.length
  return (
    <div className="card c12">
      <div className="h4row">
        <h2>{complete ? 'All set' : 'First steps'}</h2>
        <div className="right">
          <span className="muted">
            {setup.done} of {setup.steps.length} done
          </span>
        </div>
      </div>
      <SetupList setup={setup} onChanged={onChanged} />
      {!complete && (
        <div className="su-foot topline">
          {setup.hidden ? (
            <>
              <span className="sub2">Hidden from the Dashboard.</span>
              <Button size="mini" busy={hide.busy} onClick={() => void hide.run(false)}>
                Show it on the Dashboard
              </Button>
            </>
          ) : (
            <>
              <span className="sub2">Set up the way you want? The Dashboard can do without it.</span>
              <Button size="mini" variant="ghost" busy={hide.busy} onClick={() => void hide.run(true)}>
                Hide the checklist
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Whether the overview shows the checklist at all: loaded, not hidden, something still to do. */
export const setupOpen = (setup: Setup | null | undefined): setup is Setup => !!setup && !setup.hidden && setup.done < setup.steps.length
