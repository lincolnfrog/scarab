import type { DbLike } from './db'
import { listInvestAccounts, getPortfolio } from './invest'
import { listPaySources, payDatesThrough, projectPaySource, remainingPayDates, type PayCadence, type PaySource } from './paychecks'
import { ageInYear, listPeople, personNamed, type HsaCoverage } from './people'
import { LIMITS_2026, LIMITS_VINTAGE, ROTH_IRA_PHASEOUT_2026, taxYear, type FilingStatus } from './tax'

/**
 * Contribution pace (copilot §4b): what each person is on track to put into
 * a 401(k)/403(b) this year — from their paystubs, walked to Dec 31 — against
 * the limit their age allows; the check on which they reach it and the
 * employer match that stops with it; the match left unclaimed; HSA room; and
 * whether a Roth IRA is open to them at this year's income. All derived:
 * the facts are the stubs, the plan's match formula, birth years and the
 * accounts.
 *
 * Model: every pay date still ahead repeats the stub. Each employer's plan
 * stops deferring once its own total reaches the person's limit (that is how
 * payroll systems enforce §402(g) within a plan); across two employers
 * nothing stops it, so the person's total can run over — which is a finding.
 */

const r6 = (cents: number, micro: number) => Math.round((cents * micro) / 1_000_000)

export type MatchPace = {
  rateMicro: number
  capMicro: number
  trueUp: boolean
  /** The match this year as the stub and the limit play out (a true-up pays it on the whole year). */
  projectedCents: number
  /** Match on the checks after the plan stopped deferring at the limit — lost without a true-up. */
  lostToLimitCents: number
  /** Match the remaining checks would earn if the deferral reached the formula's share of pay. */
  unclaimedCents: number
}

export type SourcePace = {
  id: number
  employer: string
  cadence: PayCadence
  /** Deferral per check: pre-tax + Roth. */
  perCheckCents: number
  grossCents: number
  ytdCents: number
  ytdEstimated: boolean
  /** Pay dates still ahead this year. */
  remainingChecks: number
  /** Deferrals this plan takes by Dec 31: YTD + the checks ahead, stopping at the limit. */
  projectedCents: number
  /** The pay date on which this plan's deferrals reach the limit, if they do this year. */
  reachedOn: string | null
  /** Checks after `reachedOn` that defer nothing. */
  checksAfterLimit: number
  match: MatchPace | null
  /** Deferrals + match into this plan, against §415(c). */
  annualAdditionsCents: number
  /** `projectedCents` split by the stub's pre-tax / Roth lines (Future's buckets read these). */
  projectedPretaxCents: number
  projectedRothCents: number
}

export type PersonPace = {
  name: string
  birthYear: number | null
  age: number | null
  deferral: {
    baseCents: number
    catchUpCents: number
    catchUpTier: '50+' | '60–63' | null
    limitCents: number
    ytdCents: number
    projectedCents: number
    /** Limit − projected, when under. */
    roomCents: number
    /** Projected − limit, when two plans together run over. */
    excessCents: number
    remainingChecks: number
  } | null
  sources: SourcePace[]
  hsa: { coverage: HsaCoverage; limitCents: number; plannedCents: number; catchUpCents: number } | null
  ira: {
    limitCents: number
    /** What a direct Roth IRA contribution may be at this year's MAGI. */
    rothAllowedCents: number
    /** Traditional (pre-tax) IRA balances in this person's name: what the pro-rata rule counts. */
    pretaxIraCents: number
    pretaxIras: { name: string; cents: number }[]
  }
}

export type Contributions = {
  year: number
  today: string
  vintage: string
  filing: FilingStatus
  magiCents: number
  rothPhaseout: [number, number]
  people: PersonPace[]
  /** Family HSA coverage is one limit the spouses share; set when anyone has it. */
  hsaFamily: { members: string[]; limitCents: number; plannedCents: number } | null
  /** IRAs with no owner set, when more than one person could hold them. */
  unassignedIras: { name: string; cents: number }[]
  limits: typeof LIMITS_2026
}

/** The deferral limit for a person's age this year: the base, plus the catch-up tier they're in. */
export function deferralLimit(age: number | null) {
  const tier: '50+' | '60–63' | null = age === null ? null : age >= 60 && age <= 63 ? '60–63' : age >= 50 ? '50+' : null
  const catchUp = tier === '60–63' ? LIMITS_2026.catchUp60to63Cents : tier === '50+' ? LIMITS_2026.catchUp50Cents : 0
  return { baseCents: LIMITS_2026.deferralCents, catchUpCents: catchUp, catchUpTier: tier, limitCents: LIMITS_2026.deferralCents + catchUp }
}

/**
 * A direct Roth IRA contribution at `magi`: the full limit below the phase-out,
 * nothing above it, and in between the limit scaled down — rounded up to the
 * next $10, and never under $200 while any is allowed (§408A(c)(3)).
 */
export function rothAllowed(limitCents: number, magiCents: number, [start, end]: [number, number]): number {
  if (magiCents <= start) return limitCents
  if (magiCents >= end) return 0
  const raw = (limitCents * (end - magiCents)) / (end - start)
  const tens = Math.ceil(raw / 1_000) * 1_000
  return Math.max(200_00, Math.min(limitCents, tens))
}

function sourcePace(s: PaySource, year: number, limit: number): SourcePace {
  const p = projectPaySource(s, year)
  const perCheck = s.retirementCents + s.rothCents
  const capPerCheck = s.matchCapMicro === null ? 0 : r6(s.grossCents, s.matchCapMicro)
  const matchOf = (deferral: number) => (s.matchRateMicro === null ? 0 : r6(Math.min(deferral, capPerCheck), s.matchRateMicro))

  // The checks this plan withholds from, oldest first, each taking what's left under the limit. With a YTD
  // column the year so far is one known lump; without one, every pay date so far repeats the stub — and the
  // plan would have stopped at the limit on those too.
  const estimated = !p.stale && s.ytdGrossCents === null
  const past = estimated ? payDatesThrough(s.paidOn, s.cadence, `${year}-01-01`).reverse() : []
  const ahead = remainingPayDates(s, year)
  let cum = p.stale ? 0 : estimated ? 0 : (s.ytdRetirementCents ?? 0) + (s.ytdRothCents ?? 0)
  // Already at the limit by the stub: the plan reached it then.
  let reachedOn: string | null = !estimated && cum >= limit && perCheck > 0 ? s.paidOn : null
  let after = 0
  let matched = 0
  let uncut = 0
  let ytd = cum
  const walk = (dates: string[], isPast: boolean) => {
    for (const d of dates) {
      const take = Math.max(0, Math.min(perCheck, limit - cum))
      if (reachedOn === null && perCheck > 0 && cum < limit && cum + perCheck >= limit) reachedOn = d
      if (perCheck > 0 && take === 0) after++
      cum += take
      matched += matchOf(take)
      uncut += matchOf(perCheck)
      if (isPast) ytd = cum
    }
  }
  walk(past, true)
  walk(ahead, false)

  let match: MatchPace | null = null
  if (s.matchRateMicro !== null && s.matchCapMicro !== null) {
    // A known YTD lump is matched as the stub says: the rate on deferrals up to the cap share of YTD pay.
    const lump = estimated || p.stale ? 0 : r6(Math.min(ytd, r6(p.ytd.grossCents, s.matchCapMicro)), s.matchRateMicro)
    match = {
      rateMicro: s.matchRateMicro,
      capMicro: s.matchCapMicro,
      trueUp: s.matchTrueUp,
      projectedCents: s.matchTrueUp
        ? r6(Math.min(cum, r6(p.projected.grossCents, s.matchCapMicro)), s.matchRateMicro)
        : lump + matched,
      lostToLimitCents: s.matchTrueUp ? 0 : Math.max(0, uncut - matched),
      unclaimedCents: ahead.length * r6(Math.max(0, capPerCheck - perCheck), s.matchRateMicro),
    }
  }
  return {
    id: s.id,
    employer: s.employer,
    cadence: s.cadence,
    perCheckCents: perCheck,
    grossCents: s.grossCents,
    ytdCents: ytd,
    ytdEstimated: p.ytdEstimated,
    remainingChecks: ahead.length,
    projectedCents: cum,
    reachedOn,
    checksAfterLimit: after,
    match,
    annualAdditionsCents: cum + (match?.projectedCents ?? 0),
    projectedPretaxCents: perCheck > 0 ? Math.round((cum * s.retirementCents) / perCheck) : cum,
    projectedRothCents: perCheck > 0 ? cum - Math.round((cum * s.retirementCents) / perCheck) : 0,
  }
}

/** Each lots account's value (holdings + recorded cash) and each balance account's latest balance. */
function accountValues(db: DbLike, today: string): Map<number, number> {
  const out = new Map<number, number>()
  for (const a of getPortfolio(db, today).accounts) out.set(a.invest_account_id, a.value_cents + (a.cash_cents ?? 0))
  for (const a of listInvestAccounts(db))
    if (a.tracking === 'balance') out.set(a.id, a.latest_snapshot && a.latest_snapshot.balanced_on <= today ? a.latest_snapshot.balance_cents : 0)
  return out
}

/**
 * The household's contribution picture for `today`'s year. `magiCents` and
 * `filing` come from the tax year (engine/tax.ts taxYear): the year's total
 * income stands in for the Roth IRA's modified AGI.
 */
export function computeContributions(db: DbLike, today: string, filing: FilingStatus, magiCents: number): Contributions {
  return contributionsOf(db, today, filing, magiCents)
}

/** GET /api/contributions: the picture against this year's tax projection. */
export function getContributions(db: DbLike, today: string): Contributions {
  const year = taxYear(db, today).out
  return contributionsOf(db, today, year.settings.filingStatus, year.incomes.totalIncomeCents)
}

function contributionsOf(db: DbLike, today: string, filing: FilingStatus, magiCents: number): Contributions {
  const year = Number(today.slice(0, 4))
  const sources = listPaySources(db)
  const people = listPeople(db)
  const names = new Map<string, string>()
  for (const p of people) names.set(p.name.toLowerCase(), p.name)
  for (const s of sources) if (!names.has(s.earner.toLowerCase())) names.set(s.earner.toLowerCase(), s.earner)

  // Traditional IRAs, by owner: what the pro-rata rule would count for each person.
  const values = accountValues(db, today)
  const iras = listInvestAccounts(db)
    .filter((a) => a.subtype === 'ira')
    .map((a) => ({ name: a.name, owner: a.owner?.trim().toLowerCase() ?? null, cents: values.get(a.id) ?? 0 }))
  const solo = names.size === 1 ? [...names.keys()][0]! : null
  const phaseout = ROTH_IRA_PHASEOUT_2026[filing]

  const out: PersonPace[] = []
  for (const [key, name] of names) {
    const person = personNamed(people, name)
    const age = ageInYear(person, year)
    const mine = sources.filter((s) => s.earner.trim().toLowerCase() === key)
    let deferral: PersonPace['deferral'] = null
    let paces: SourcePace[] = []
    if (mine.length) {
      const lim = deferralLimit(age)
      paces = mine.map((s) => sourcePace(s, year, lim.limitCents))
      const projected = paces.reduce((sum, p) => sum + p.projectedCents, 0)
      deferral = {
        ...lim,
        ytdCents: paces.reduce((sum, p) => sum + p.ytdCents, 0),
        projectedCents: projected,
        roomCents: Math.max(0, lim.limitCents - projected),
        excessCents: Math.max(0, projected - lim.limitCents),
        remainingChecks: paces.reduce((sum, p) => sum + p.remainingChecks, 0),
      }
    }
    const hsaCatchUp = age !== null && age >= 55 ? LIMITS_2026.hsaCatchUp55Cents : 0
    const hsa =
      person.hsaCoverage === 'none'
        ? null
        : {
            coverage: person.hsaCoverage,
            limitCents: (person.hsaCoverage === 'family' ? LIMITS_2026.hsaFamilyCents : LIMITS_2026.hsaSelfCents) + hsaCatchUp,
            plannedCents: person.hsaCents,
            catchUpCents: hsaCatchUp,
          }
    const iraLimit = LIMITS_2026.iraCents + (age !== null && age >= 50 ? LIMITS_2026.iraCatchUpCents : 0)
    const pretax = iras.filter((i) => i.owner === key || (i.owner === null && solo === key))
    out.push({
      name,
      birthYear: person.birthYear,
      age,
      deferral,
      sources: paces,
      hsa,
      ira: {
        limitCents: iraLimit,
        rothAllowedCents: rothAllowed(iraLimit, magiCents, phaseout),
        pretaxIraCents: pretax.reduce((sum, i) => sum + i.cents, 0),
        pretaxIras: pretax.map((i) => ({ name: i.name, cents: i.cents })),
      },
    })
  }

  // Family coverage: one family limit the spouses split, plus each one's own catch-up.
  const fam = out.filter((p) => p.hsa?.coverage === 'family')
  const hsaFamily = fam.length
    ? {
        members: fam.map((p) => p.name),
        limitCents: LIMITS_2026.hsaFamilyCents + fam.reduce((sum, p) => sum + p.hsa!.catchUpCents, 0),
        plannedCents: fam.reduce((sum, p) => sum + p.hsa!.plannedCents, 0),
      }
    : null

  const known = new Set(names.keys())
  return {
    year,
    today,
    vintage: LIMITS_VINTAGE,
    filing,
    magiCents,
    rothPhaseout: phaseout,
    people: out,
    hsaFamily,
    unassignedIras: iras.filter((i) => (i.owner === null && solo === null) || (i.owner !== null && !known.has(i.owner))).map((i) => ({ name: i.name, cents: i.cents })),
    limits: LIMITS_2026,
  }
}
