import type { Finding } from '../shared/checkup-api'
import { formatDollars } from '../shared/money'
import type { Contributions, PersonPace, SourcePace } from './contributions'

/**
 * The Checkup's contribution findings (copilot §4b), built from
 * engine/contributions.ts: room under the deferral limit, the match that
 * stops at the limit, the match left unclaimed, two plans together over the
 * limit, HSA room, and the backdoor-Roth flag with the pro-rata rule.
 */

type Draft = Omit<Finding, 'isNew'>
const $ = (cents: number) => formatDollars(cents)
const pct = (micro: number, digits = 1) => `${(micro / 10_000).toFixed(digits)}%`
const r6 = (cents: number, micro: number) => Math.round((cents * micro) / 1_000_000)
const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const plan = (s: SourcePace) => (s.employer ? `the ${s.employer} plan` : 'the plan')
const toPace = { label: 'See contribution pace', to: { screen: 'tax', rest: ['contributions'] } }

function limitInputs(p: PersonPace) {
  const d = p.deferral!
  return [
    { label: 'Deferral limit, 2026', value: $(d.baseCents) },
    ...(d.catchUpTier
      ? [{ label: `Catch-up, ${d.catchUpTier} (age ${p.age} this year)`, value: $(d.catchUpCents) }]
      : [{ label: p.birthYear === null ? 'Catch-up (no birth year entered)' : `Catch-up (age ${p.age} this year)`, value: '$0' }]),
  ]
}

const limitRule = (vintage: string) => ({
  text: 'Elective deferrals — pre-tax and Roth together — are capped per person per year across every employer, with a catch-up from the year you turn 50 (larger from 60 through 63).',
  cite: 'IRC §402(g), §414(v); SECURE 2.0 §109',
  vintage,
})

function deferralRoom(c: Contributions, p: PersonPace, marginalMicro: number): Draft[] {
  const d = p.deferral
  if (!d || d.roomCents <= 0 || d.remainingChecks === 0) return []
  // Only someone already deferring (or offered a match) is in a plan for sure.
  if (!p.sources.some((s) => s.perCheckCents > 0 || s.match)) return []
  const perCheck = Math.ceil(d.roomCents / d.remainingChecks / 100) * 100
  const deferred = r6(d.roomCents, marginalMicro)
  return [
    {
      id: `deferral-room:${p.name}`,
      kind: 'deferral-room',
      tone: 'saving',
      title: `${p.name}'s 401(k) is on pace for ${$(d.projectedCents)} of ${$(d.limitCents)} — ${$(d.roomCents)} of room left`,
      impactCents: deferred,
      impactLabel: 'income tax deferred, if pre-tax',
      rule: limitRule(c.vintage),
      inputs: [
        ...limitInputs(p),
        ...p.sources.map((s) => ({
          label: `${s.employer || 'Paycheck'}: ${$(s.perCheckCents)} a check${s.ytdEstimated ? ' (YTD assumed)' : ''}, ${s.remainingChecks} checks left`,
          value: `${$(s.ytdCents)} so far`,
        })),
        { label: 'Marginal rate on ordinary income', value: pct(marginalMicro) },
      ],
      math: [
        `${$(d.ytdCents)} so far + the checks ahead = ${$(d.projectedCents)} by Dec 31`,
        `${$(d.limitCents)} − ${$(d.projectedCents)} = ${$(d.roomCents)} of room ≈ ${$(perCheck)} more on each of ${d.remainingChecks} checks`,
        `${$(d.roomCents)} × ${pct(marginalMicro)} = ${$(deferred)} of tax deferred, if it went in pre-tax`,
      ],
      leavesOut: [
        'Whether the cash flow allows it — a bigger deferral is a smaller paycheck.',
        'Roth deferrals defer no tax now; they buy tax-free withdrawals later instead.',
        'Plans that cap deferrals as a share of pay, or take changes only at set times.',
        ...(d.catchUpTier ? ['From 2026 catch-ups must go in as Roth for anyone whose prior-year wages from that employer passed $150,000.'] : []),
      ],
      action: toPace,
    },
  ]
}

function matchStops(c: Contributions, p: PersonPace): Draft[] {
  const out: Draft[] = []
  for (const s of p.sources) {
    const m = s.match
    if (!m || m.lostToLimitCents <= 0 || !s.reachedOn) continue
    out.push({
      id: `match-stops:${p.name}:${s.id}`,
      kind: 'match-stops',
      tone: 'risk',
      title:
        s.reachedOn <= c.today
          ? `${p.name} reached the ${$(p.deferral!.limitCents)} limit on ${day(s.reachedOn)} — ${plan(s)}'s match stopped for ${s.checksAfterLimit} check${s.checksAfterLimit === 1 ? '' : 's'}`
          : `${p.name} reaches the ${$(p.deferral!.limitCents)} limit on ${day(s.reachedOn)} — ${plan(s)}'s match stops for ${s.checksAfterLimit} check${s.checksAfterLimit === 1 ? '' : 's'}`,
      impactCents: m.lostToLimitCents,
      impactLabel: 'match lost this year',
      rule: {
        text: 'A plan matches each paycheck’s deferral; once deferrals reach the yearly limit they stop, and without a year-end true-up so does the match.',
        cite: 'IRC §402(g); the plan’s match formula',
        vintage: c.vintage,
      },
      inputs: [
        ...limitInputs(p),
        { label: 'Deferral per check', value: $(s.perCheckCents) },
        { label: 'Match formula', value: `${pct(m.rateMicro, 0)} of deferrals up to ${pct(m.capMicro, 0)} of pay, no true-up` },
        { label: 'Gross per check', value: $(s.grossCents) },
      ],
      math: [
        `Limit reached on the ${day(s.reachedOn)} check; ${s.checksAfterLimit} check${s.checksAfterLimit === 1 ? '' : 's'} after it defer nothing`,
        `Match those checks would have earned = ${$(m.lostToLimitCents)}`,
        `Spreading ${$(p.deferral!.limitCents)} evenly over the year’s checks keeps every check matched`,
      ],
      leavesOut: ['Plans that true up at year end (tick it on the paycheck and this goes away).', 'Vesting: a match that isn’t vested yet is only partly yours.'],
      action: toPace,
    })
  }
  return out
}

function matchUnclaimed(c: Contributions, p: PersonPace): Draft[] {
  const out: Draft[] = []
  for (const s of p.sources) {
    const m = s.match
    if (!m || m.unclaimedCents <= 0 || s.remainingChecks === 0) continue
    const capPerCheck = r6(s.grossCents, m.capMicro)
    out.push({
      id: `match-unclaimed:${p.name}:${s.id}`,
      kind: 'match-unclaimed',
      tone: 'saving',
      title: `${p.name} defers ${pct(Math.round((s.perCheckCents * 1_000_000) / s.grossCents))} of pay; ${plan(s)} matches up to ${pct(m.capMicro, 0)}`,
      impactCents: m.unclaimedCents,
      impactLabel: 'match unclaimed this year',
      rule: { text: 'The employer matches deferrals up to a share of each check’s pay; deferring less leaves the rest of the match unpaid.', cite: 'The plan’s match formula', vintage: c.vintage },
      inputs: [
        { label: 'Match formula', value: `${pct(m.rateMicro, 0)} of deferrals up to ${pct(m.capMicro, 0)} of pay` },
        { label: 'Gross per check', value: $(s.grossCents) },
        { label: 'Deferral per check', value: $(s.perCheckCents) },
        { label: 'Checks left this year', value: String(s.remainingChecks) },
      ],
      math: [
        `${pct(m.capMicro, 0)} × ${$(s.grossCents)} = ${$(capPerCheck)} matched per check at most`,
        `(${$(capPerCheck)} − ${$(s.perCheckCents)}) × ${pct(m.rateMicro, 0)} × ${s.remainingChecks} checks = ${$(m.unclaimedCents)}`,
      ],
      leavesOut: ['A higher deferral can reach the yearly limit sooner — see when on the pace card.', 'Vesting schedules on the match.'],
      action: toPace,
    })
  }
  return out
}

function deferralExcess(c: Contributions, p: PersonPace, marginalMicro: number): Draft[] {
  const d = p.deferral
  if (!d || d.excessCents <= 0) return []
  return [
    {
      id: `deferral-excess:${p.name}`,
      kind: 'deferral-excess',
      tone: 'risk',
      title: `${p.name}'s plans together will take ${$(d.projectedCents)} — ${$(d.excessCents)} over the ${$(d.limitCents)} limit`,
      impactCents: r6(d.excessCents, marginalMicro),
      impactLabel: 'taxed twice if not returned by Apr 15',
      rule: {
        text: 'The deferral limit is per person across every employer. Each plan only stops at its own total, so two jobs can run over; the excess must be returned by April 15 or it is taxed in the year deferred and again when withdrawn.',
        cite: 'IRC §402(g)(2); Treas. Reg. §1.402(g)-1(e)',
        vintage: c.vintage,
      },
      inputs: [...limitInputs(p), ...p.sources.map((s) => ({ label: `${s.employer || 'Paycheck'} by Dec 31`, value: $(s.projectedCents) }))],
      math: [`${p.sources.map((s) => $(s.projectedCents)).join(' + ')} − ${$(d.limitCents)} = ${$(d.excessCents)} over`],
      leavesOut: ['Lowering one job’s deferral now avoids the corrective distribution altogether.'],
      action: toPace,
    },
  ]
}

function hsaRoom(c: Contributions, marginalMicro: number): Draft[] {
  const out: Draft[] = []
  const rule = (text: string) => ({ text, cite: 'IRC §223(b); Rev. Proc. 2025-19', vintage: c.vintage })
  const leaves = [
    'Only while covered by a qualifying high-deductible plan, month by month.',
    'Through payroll it also skips Social Security and Medicare tax (7.65%), which isn’t counted here.',
    'Contributions for the year can be made until April 15.',
  ]
  for (const p of c.people) {
    if (!p.hsa || p.hsa.coverage !== 'self') continue
    const room = p.hsa.limitCents - p.hsa.plannedCents
    if (room <= 0) continue
    out.push({
      id: `hsa-room:${p.name}`,
      kind: 'hsa-room',
      tone: 'saving',
      title: `${p.name}: ${$(room)} of HSA room left this year`,
      impactCents: r6(room, marginalMicro),
      impactLabel: 'income tax saved',
      rule: rule('HSA contributions, employer money included, are capped per year by coverage, with a catch-up from 55.'),
      inputs: [
        { label: 'Self-only limit', value: $(p.hsa.limitCents - p.hsa.catchUpCents) },
        ...(p.hsa.catchUpCents ? [{ label: `Catch-up (age ${p.age})`, value: $(p.hsa.catchUpCents) }] : []),
        { label: 'Planned this year (your setting)', value: $(p.hsa.plannedCents) },
      ],
      math: [`${$(p.hsa.limitCents)} − ${$(p.hsa.plannedCents)} = ${$(room)}`, `${$(room)} × ${pct(marginalMicro)} = ${$(r6(room, marginalMicro))}`],
      leavesOut: leaves,
      action: toPace,
    })
  }
  const f = c.hsaFamily
  if (f && f.limitCents > f.plannedCents) {
    const room = f.limitCents - f.plannedCents
    out.push({
      id: 'hsa-room:family',
      kind: 'hsa-room',
      tone: 'saving',
      title: `${$(room)} of family HSA room left this year`,
      impactCents: r6(room, marginalMicro),
      impactLabel: 'income tax saved',
      rule: rule('Family coverage is one limit the spouses share, plus each one’s own catch-up from 55.'),
      inputs: [
        { label: `Family limit (${f.members.join(', ')})`, value: $(f.limitCents) },
        { label: 'Planned this year (your settings)', value: $(f.plannedCents) },
      ],
      math: [`${$(f.limitCents)} − ${$(f.plannedCents)} = ${$(room)}`, `${$(room)} × ${pct(marginalMicro)} = ${$(r6(room, marginalMicro))}`],
      leavesOut: leaves,
      action: toPace,
    })
  }
  return out
}

function backdoorRoth(c: Contributions, marginalMicro: number): Draft[] {
  const [start, end] = c.rothPhaseout
  if (c.magiCents <= start) return []
  // Everyone, earners or not: a spouse without paychecks can still fund an IRA on the household's pay.
  const people = c.people
  if (people.length === 0) return []
  const closed = c.magiCents >= end
  const rows = people.map((p) => {
    const conv = p.ira.limitCents
    const pre = p.ira.pretaxIraCents
    const taxable = pre > 0 ? Math.round((conv * pre) / (pre + conv)) : 0
    return { p, conv, pre, taxable, tax: r6(taxable, marginalMicro) }
  })
  const tax = rows.reduce((s, r) => s + r.tax, 0)
  const someone = rows.find((r) => r.pre > 0)
  return [
    {
      id: `backdoor-roth:${closed ? 'closed' : 'partial'}:${rows.map((r) => (r.pre > 0 ? 'p' : 'c')).join('')}`,
      kind: 'backdoor-roth',
      tone: tax > 0 ? 'risk' : 'heads-up',
      title:
        (closed ? 'Income is over the Roth IRA limit — direct contributions are closed' : 'Roth IRA contributions are partly phased out at this income') +
        (someone
          ? `; ${someone.p.name}'s ${$(someone.pre)} in pre-tax IRAs would make a backdoor conversion ${someone.pre >= someone.conv ? 'mostly' : 'partly'} taxable`
          : '; with no pre-tax IRA, a backdoor conversion would be tax-free'),
      impactCents: tax,
      impactLabel: tax > 0 ? 'tax the pro-rata rule would add' : 'unpriced — the route is clean',
      rule: {
        text: 'Direct Roth IRA contributions phase out with income. A nondeductible traditional IRA contribution converted to Roth gets there anyway, but a conversion is taxed in proportion to all pre-tax IRA money held on Dec 31 (the pro-rata rule).',
        cite: 'IRC §408A(c)(3), §408(d)(2); Form 8606',
        vintage: c.vintage,
      },
      inputs: [
        { label: 'Income (stands in for MAGI)', value: $(c.magiCents) },
        { label: 'Roth IRA phase-out for your filing status', value: `${$(start)} – ${$(end)}` },
        ...rows.map((r) => ({
          label: `${r.p.name}: direct Roth allowed · pre-tax IRAs`,
          value: `${$(r.p.ira.rothAllowedCents)} · ${$(r.pre)}`,
        })),
        ...c.unassignedIras.map((i) => ({ label: `IRA with no owner set: ${i.name}`, value: $(i.cents) })),
      ],
      math: rows.map((r) =>
        r.pre > 0
          ? `${r.p.name}: ${$(r.conv)} × ${$(r.pre)} ÷ (${$(r.pre)} + ${$(r.conv)}) = ${$(r.taxable)} taxable × ${pct(marginalMicro)} = ${$(r.tax)}`
          : `${r.p.name}: no pre-tax IRA — a ${$(r.conv)} conversion is tax-free`,
      ),
      leavesOut: [
        'SEP and SIMPLE IRAs count for the pro-rata rule too — mark them as IRAs. 401(k) balances don’t count.',
        'Rolling pre-tax IRA money into a 401(k) that accepts it takes it out of the calculation.',
        'Roth MAGI adds back a few items this income figure doesn’t.',
        ...(c.unassignedIras.length ? ['IRAs with no owner set aren’t counted for anyone — set the owner on Investments.'] : []),
      ],
      action: toPace,
    },
  ]
}

export function contributionFindings(c: Contributions, marginalOrdinaryMicro: number, wagesEntered: boolean): Draft[] {
  const out: Draft[] = []
  for (const p of c.people) {
    out.push(...deferralRoom(c, p, marginalOrdinaryMicro), ...matchStops(c, p), ...matchUnclaimed(c, p), ...deferralExcess(c, p, marginalOrdinaryMicro))
  }
  out.push(...hsaRoom(c, marginalOrdinaryMicro))
  if (wagesEntered) out.push(...backdoorRoth(c, marginalOrdinaryMicro))
  return out
}
