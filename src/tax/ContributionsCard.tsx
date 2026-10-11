import { useCallback, useEffect, useState, type RefCallback } from 'react'
import type { Contributions, PersonPace } from '../../engine/contributions'
import type { Person } from '../../engine/people'
import { formatDollars } from '../../shared/money'
import { get, put } from '../api'
import { Link } from '../router'
import { Button } from '../ui/Button'
import { Field, MoneyInput, Select } from '../ui/Field'
import { Skeleton } from '../ui/Skeleton'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'
import './contrib.css'

const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const share = (part: number, whole: number) => (whole > 0 ? Math.min(100, (part / whole) * 100) : 0)

/** A filled share of a limit: what's in (s1) and what's still to come this year (s1, lighter). */
function Meter(p: { ytd: number; projected: number; limit: number; label: string }) {
  return (
    <Tooltip content={`${p.label}: ${formatDollars(p.ytd)} so far, ${formatDollars(p.projected)} by Dec 31, of ${formatDollars(p.limit)}`}>
      <div className="ct-meter" role="img" aria-label={`${p.label}: ${formatDollars(p.projected)} of ${formatDollars(p.limit)} by Dec 31`}>
        <i className="ct-ahead" style={{ width: `${share(p.projected, p.limit)}%` }} />
        <i className="ct-ytd" style={{ width: `${share(p.ytd, p.limit)}%` }} />
      </div>
    </Tooltip>
  )
}

function PersonRows({ p, c }: { p: PersonPace; c: Contributions }) {
  const d = p.deferral
  const rothNote =
    p.ira.rothAllowedCents >= p.ira.limitCents
      ? `${formatDollars(p.ira.limitCents)} allowed`
      : p.ira.rothAllowedCents > 0
        ? `${formatDollars(p.ira.rothAllowedCents)} of ${formatDollars(p.ira.limitCents)} allowed`
        : 'closed at this income'
  return (
    <section className="ct-person">
      <h3>
        {p.name}
        <span className="muted"> · {p.age === null ? 'no birth year — no catch-up assumed' : `turns ${p.age} this year`}</span>
      </h3>
      {d ? (
        <div className="ct-row">
          <span className="ct-what">401(k) / 403(b)</span>
          <Meter ytd={d.ytdCents} projected={d.projectedCents} limit={d.limitCents} label="Deferrals" />
          <span className="ct-num">
            <b>{formatDollars(d.projectedCents)}</b> of {formatDollars(d.limitCents)}
            {d.catchUpTier && <span className="muted"> incl. {d.catchUpTier} catch-up</span>}
          </span>
          <span className="ct-note">
            {d.excessCents > 0
              ? `${formatDollars(d.excessCents)} over the limit across plans`
              : d.roomCents > 0
                ? `${formatDollars(d.roomCents)} of room · ${d.remainingChecks} check${d.remainingChecks === 1 ? '' : 's'} left`
                : 'at the limit'}
            {p.sources.map((s) => {
              const bits: string[] = []
              if (s.reachedOn) bits.push(`${s.employer || 'plan'} ${s.reachedOn <= c.today ? 'reached' : 'reaches'} the limit ${day(s.reachedOn)}`)
              if (s.match)
                bits.push(
                  `match ${formatDollars(s.match.projectedCents)}` +
                    (s.match.lostToLimitCents > 0 ? `, ${formatDollars(s.match.lostToLimitCents)} lost after the limit` : '') +
                    (s.match.unclaimedCents > 0 ? `, ${formatDollars(s.match.unclaimedCents)} unclaimed` : ''),
                )
              return bits.length ? <span key={s.id}> · {bits.join(' · ')}</span> : null
            })}
          </span>
        </div>
      ) : (
        <div className="ct-row">
          <span className="ct-what">401(k) / 403(b)</span>
          <span className="ct-note ct-wide">No paycheck for {p.name} — add one on <Link className="scr-link" to={{ screen: 'tax', rest: ['paychecks'] }}>Paychecks</Link> to pace deferrals.</span>
        </div>
      )}
      {p.hsa && p.hsa.coverage === 'self' && (
        <div className="ct-row">
          <span className="ct-what">HSA (self)</span>
          <Meter ytd={0} projected={p.hsa.plannedCents} limit={p.hsa.limitCents} label="HSA" />
          <span className="ct-num">
            <b>{formatDollars(p.hsa.plannedCents)}</b> of {formatDollars(p.hsa.limitCents)}
          </span>
          <span className="ct-note">planned, from the People settings below</span>
        </div>
      )}
      <div className="ct-row">
        <span className="ct-what">IRA</span>
        <span className="ct-note ct-wide">
          {formatDollars(p.ira.limitCents)} limit · direct Roth {rothNote}
          {p.ira.pretaxIraCents > 0 && ` · ${formatDollars(p.ira.pretaxIraCents)} in pre-tax IRAs (counts for the pro-rata rule)`}
        </span>
      </div>
      {c.hsaFamily && p.name === c.hsaFamily.members[0] && (
        <div className="ct-row">
          <span className="ct-what">HSA (family)</span>
          <Meter ytd={0} projected={c.hsaFamily.plannedCents} limit={c.hsaFamily.limitCents} label="Family HSA" />
          <span className="ct-num">
            <b>{formatDollars(c.hsaFamily.plannedCents)}</b> of {formatDollars(c.hsaFamily.limitCents)}
          </span>
          <span className="ct-note">one limit for {c.hsaFamily.members.join(' and ')}</span>
        </div>
      )}
    </section>
  )
}

const YEARS = (() => {
  const now = new Date().getFullYear()
  return Array.from({ length: now - 15 - 1925 + 1 }, (_, i) => now - 15 - i)
})()

export type ContributionsState = {
  c: Contributions | null
  people: Person[] | null
  setPeople: (f: (ps: Person[] | null) => Person[] | null) => void
  /** The people list as last read or saved, for the unsaved-changes check. */
  saved: string
  dirty: boolean
  error: string | null
  /** After a save: adopt what was stored and recompute the pace. */
  adopt: (people: Person[]) => void
}

/**
 * The pace and the people form, held by the Taxes screen: its overview
 * summarizes the pace, and a half-edited person survives a trip between
 * views. `version` bumps when the screen reloads (a paycheck saved), so the
 * pace follows; 0 means the tax picture hasn't loaded yet, and nothing is
 * fetched.
 */
export function useContributions(version: number): ContributionsState {
  const [c, setC] = useState<Contributions | null>(null)
  const [people, setPeople] = useState<Person[] | null>(null)
  const [saved, setSaved] = useState('')
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const [cc, pp] = await Promise.all([get<Contributions>('/api/contributions'), get<Person[]>('/api/people')])
    setC(cc)
    setPeople((cur) => cur ?? pp)
    setSaved((cur) => cur || JSON.stringify(pp))
    setError(null)
    return pp
  }, [])
  useEffect(() => {
    if (version === 0) return
    load().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [load, version])
  const adopt = useCallback(
    (list: Person[]) => {
      setPeople(list)
      setSaved(JSON.stringify(list))
      void load()
    },
    [load],
  )
  const dirty = !!people && JSON.stringify(people) !== saved
  return { c, people, setPeople, saved, dirty, error, adopt }
}

/**
 * Contribution pace (copilot §4b): each person's 401(k)/403(b) deferrals by
 * Dec 31 against the limit their age allows — from the paystubs — with when
 * the limit is reached and what the match does; HSA against its limit; and
 * the IRA, with whether a direct Roth contribution is open at this year's
 * income. Below it, the few facts about each person the limits need.
 */
export default function ContributionsCard({ anchor, ct }: { anchor?: RefCallback<HTMLElement>; ct: ContributionsState }) {
  const { c, people, setPeople, dirty, error } = ct
  const save = useAction((list: Person[]) => put<{ ok: true; people: Person[] }>('/api/people', { people: list }), {
    success: 'Saved — the pace and the limits recomputed',
    errorPrefix: "Couldn't save the people",
    onDone: (r) => ct.adopt(r.people),
  })

  const set = (i: number, patch: Partial<Person>) => setPeople((ps) => ps && ps.map((p, k) => (k === i ? { ...p, ...patch } : p)))

  return (
    <div className="card c12" ref={anchor}>
      <div className="h4row">
        <h2>Contribution pace · {c?.year ?? ''}</h2>
        <div className="right">
          <span className="muted">{c?.vintage}</span>
        </div>
      </div>
      {!c || !people ? (
        error ? <p className="sub2">Couldn't work out the pace: {error}</p> : <Skeleton h={120} />
      ) : (
        <>
          {c.people.length === 0 ? (
            <p className="sub2">Add a <Link className="scr-link" to={{ screen: 'tax', rest: ['paychecks'] }}>paycheck</Link> and each earner’s deferrals pace against the {c.year} limits here.</p>
          ) : (
            c.people.map((p) => <PersonRows key={p.name} p={p} c={c} />)
          )}
          {c.unassignedIras.length > 0 && (
            <p className="sub2 topline">
              IRAs with no owner set ({c.unassignedIras.map((i) => i.name).join(', ')}) aren’t counted for anyone — set the owner on Investments.
            </p>
          )}
          {people.length > 0 && (
            <div className="ct-people topline">
              <div className="ct-people-head">
                <b>People</b>
                <span className="muted">birth years decide catch-ups (and, later, the Future’s age axis); HSA isn’t split out on a stub, so it’s typed here</span>
              </div>
              {people.map((p, i) => (
                <div className="scr-fields ct-person-fields" key={p.name}>
                  <div className="scr-f sm ct-name">{p.name}</div>
                  <div className="scr-f sm">
                    <Field label="Born">
                      <Select value={p.birthYear ?? ''} onChange={(e) => set(i, { birthYear: e.target.value ? Number(e.target.value) : null })}>
                        <option value="">—</option>
                        {YEARS.map((y) => (
                          <option key={y} value={y}>
                            {y}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="scr-f">
                    <Field label="HSA coverage">
                      <Select value={p.hsaCoverage} onChange={(e) => set(i, { hsaCoverage: e.target.value as Person['hsaCoverage'] })}>
                        <option value="none">none</option>
                        <option value="self">self-only</option>
                        <option value="family">family</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="scr-f">
                    <Field label="HSA this year" hint="yours + employer's">
                      <MoneyInput value={p.hsaCents || null} placeholder="0.00" disabled={p.hsaCoverage === 'none'} onChange={(v) => set(i, { hsaCents: v ?? 0 })} />
                    </Field>
                  </div>
                </div>
              ))}
              <div className="scr-formfoot">
                <span className="scr-note muted">
                  Roth IRA phase-out at your filing status: {formatDollars(c.rothPhaseout[0])} – {formatDollars(c.rothPhaseout[1])} of income.
                </span>
                <Button variant="gold" busy={save.busy} disabled={!dirty} onClick={() => void save.run(people)}>
                  Save people
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
