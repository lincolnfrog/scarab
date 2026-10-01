import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { getCheckup } from './checkup'
import { deferralLimit, getContributions, rothAllowed } from './contributions'
import type { DbLike } from './db'
import { createPaySource, type PaySourceInput } from './paychecks'
import { listPeople, putPeople } from './people'
import { dumpDb, loadDump } from './snapshot'
import { putTaxSettings } from './tax'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'

/** A biweekly stub dated Sep 25: six pay dates remain (Oct 9 … Dec 18). */
function pay(db: DbLike, b: PaySourceInput) {
  return createPaySource(db, { earner: 'Max', employer: 'Acme', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(10_000), ...b })
}
const person = (db: DbLike, name = 'Max') => getContributions(db, today).people.find((p) => p.name === name)!
const kinds = (db: DbLike) => getCheckup(db, today, 'max@x').findings.map((f) => f.kind)

describe('limits', () => {
  it('adds the catch-up for the age reached by Dec 31, the larger one from 60 through 63', () => {
    expect(deferralLimit(null).limitCents).toBe($(24_500))
    expect(deferralLimit(49).limitCents).toBe($(24_500))
    expect(deferralLimit(50)).toMatchObject({ catchUpTier: '50+', limitCents: $(32_500) })
    expect(deferralLimit(60)).toMatchObject({ catchUpTier: '60–63', limitCents: $(35_750) })
    expect(deferralLimit(63).catchUpTier).toBe('60–63')
    expect(deferralLimit(64)).toMatchObject({ catchUpTier: '50+', limitCents: $(32_500) })
  })

  it('phases a direct Roth IRA contribution out, rounding up to $10 with a $200 floor', () => {
    const range: [number, number] = [$(242_000), $(252_000)]
    expect(rothAllowed($(7_500), $(200_000), range)).toBe($(7_500))
    expect(rothAllowed($(7_500), $(252_000), range)).toBe(0)
    expect(rothAllowed($(7_500), $(247_000), range)).toBe($(3_750))
    expect(rothAllowed($(7_500), $(247_003), range)).toBe($(3_750)) // $3,749.78 → $3,750
    expect(rothAllowed($(7_500), $(251_900), range)).toBe($(200))
  })
})

describe('deferral pace', () => {
  it('walks the checks ahead to Dec 31 from the YTD column', () => {
    const db = mem()
    pay(db, { retirementCents: $(1_000), ytdGrossCents: $(180_000), ytdRetirementCents: $(18_000) })
    const p = person(db)
    expect(p.deferral).toMatchObject({ ytdCents: $(18_000), projectedCents: $(24_000), roomCents: $(500), remainingChecks: 6 })
    expect(p.sources[0]!.reachedOn).toBeNull()
  })

  it('counts Roth deferrals against the same limit', () => {
    const db = mem()
    pay(db, { retirementCents: $(500), rothCents: $(500), ytdGrossCents: $(180_000), ytdRetirementCents: $(9_000), ytdRothCents: $(9_000) })
    expect(person(db).deferral!.projectedCents).toBe($(24_000))
  })

  it('stops the plan at the limit, and the match with it unless the plan trues up', () => {
    const db = mem()
    const s = pay(db, { retirementCents: $(1_000), ytdGrossCents: $(180_000), ytdRetirementCents: $(22_000), matchRateMicro: 500_000, matchCapMicro: 60_000 })
    const p = person(db)
    const src = p.sources[0]!
    // $23,000 Oct 9 · $24,000 Oct 23 · $24,500 Nov 6, then three checks defer nothing
    expect(src.reachedOn).toBe('2026-11-06')
    expect(src.checksAfterLimit).toBe(3)
    expect(src.projectedCents).toBe($(24_500))
    // A full check earns 50% × min($1,000, 6% × $10,000) = $300: three lost whole, and $50 of Nov 6's (only $500 went in)
    expect(src.match!.lostToLimitCents).toBe($(950))
    expect(kinds(db)).toContain('match-stops')
    db.prepare('UPDATE pay_sources SET match_true_up = 1 WHERE id = ?').run(s.id)
    expect(person(db).sources[0]!.match!.lostToLimitCents).toBe(0)
    expect(kinds(db)).not.toContain('match-stops')
  })

  it('stops at the limit on the estimated checks so far too, when no YTD column is entered', () => {
    const db = mem()
    // $2,000 a check × 20 pay dates Jan 2 … Sep 25 would be $40,000: the plan stopped on the 13th (Jun 19).
    pay(db, { retirementCents: $(2_000), matchRateMicro: 1_000_000, matchCapMicro: 100_000 })
    const p = person(db)
    expect(p.deferral).toMatchObject({ ytdCents: $(24_500), projectedCents: $(24_500), excessCents: 0, roomCents: 0 })
    expect(p.sources[0]!.reachedOn).toBe('2026-06-19')
    expect(kinds(db)).not.toContain('deferral-excess')
    const f = getCheckup(db, today, 'max@x').findings.find((x) => x.kind === 'match-stops')!
    expect(f.title).toContain('reached the $24,500 limit on Jun 19')
  })

  it('raises the limit with a birth year', () => {
    const db = mem()
    pay(db, { retirementCents: $(1_000), ytdGrossCents: $(180_000), ytdRetirementCents: $(22_000) })
    putPeople(db, { people: [{ name: 'Max', birthYear: 1972 }] }, today)
    const p = person(db)
    expect(p.age).toBe(54)
    expect(p.deferral).toMatchObject({ limitCents: $(32_500), projectedCents: $(28_000), roomCents: $(4_500) })
    expect(p.sources[0]!.reachedOn).toBeNull()
  })

  it('prices the match left unclaimed by deferring under the formula', () => {
    const db = mem()
    pay(db, { retirementCents: $(300), matchRateMicro: 1_000_000, matchCapMicro: 60_000 })
    expect(person(db).sources[0]!.match!.unclaimedCents).toBe($(300) * 6)
    expect(kinds(db)).toContain('match-unclaimed')
  })

  it('flags two plans that together run over the limit', () => {
    const db = mem()
    pay(db, { retirementCents: $(1_000), ytdGrossCents: $(180_000), ytdRetirementCents: $(16_000) })
    pay(db, { employer: 'Side gig', retirementCents: $(500), ytdGrossCents: $(90_000), ytdRetirementCents: $(4_000) })
    const p = person(db)
    expect(p.deferral!.excessCents).toBe($(22_000) + $(7_000) - $(24_500))
    expect(kinds(db)).toContain('deferral-excess')
  })

  it('finds room only for someone already deferring', () => {
    const db = mem()
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX' })
    pay(db, { retirementCents: 0 })
    expect(kinds(db)).not.toContain('deferral-room')
    const db2 = mem()
    putTaxSettings(db2, { filingStatus: 'mfj', state: 'TX' })
    pay(db2, { retirementCents: $(500) })
    const f = getCheckup(db2, today, 'max@x').findings.find((x) => x.kind === 'deferral-room')!
    expect(f.title).toContain('on pace for')
    expect(f.impactCents).toBeGreaterThan(0)
  })
})

describe('HSA', () => {
  it('shares one family limit between spouses, each with their own catch-up', () => {
    const db = mem()
    pay(db, { retirementCents: $(500) })
    putPeople(
      db,
      {
        people: [
          { name: 'Max', birthYear: 1970, hsaCoverage: 'family', hsaCents: $(4_000) },
          { name: 'Nicole', birthYear: 1980, hsaCoverage: 'family', hsaCents: $(2_000) },
        ],
      },
      today,
    )
    const c = getContributions(db, today)
    expect(c.hsaFamily).toEqual({ members: ['Max', 'Nicole'], limitCents: $(9_750), plannedCents: $(6_000) })
    expect(kinds(db)).toContain('hsa-room')
  })

  it('says nothing at the limit', () => {
    const db = mem()
    putPeople(db, { people: [{ name: 'Max', hsaCoverage: 'self', hsaCents: $(4_400) }] }, today)
    expect(kinds(db)).not.toContain('hsa-room')
  })
})

describe('Roth IRA and the pro-rata rule', () => {
  function seed(db: DbLike, iraDollars: number) {
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', withheldFederalCents: $(500_000) })
    pay(db, { grossCents: $(12_000), retirementCents: $(500), ytdGrossCents: $(216_000), ytdRetirementCents: $(9_000) })
    if (iraDollars) {
      db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype, owner) VALUES ('Rollover IRA', 'retirement', 'balance', 'ira', 'Max')").run()
      db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, '2026-09-01', ?)").run($(iraDollars))
    }
  }

  it('closes direct contributions over the phase-out, and prices the pro-rata tax on a backdoor', () => {
    const db = mem()
    seed(db, 50_000)
    const p = person(db)
    expect(p.ira).toMatchObject({ rothAllowedCents: 0, pretaxIraCents: $(50_000) })
    const f = getCheckup(db, today, 'max@x').findings.find((x) => x.kind === 'backdoor-roth')!
    expect(f.title).toContain('mostly taxable')
    // $7,500 × 50,000 / 57,500 = $6,521.74 taxable, at the 24% bracket
    expect(f.impactCents).toBe(Math.round(652_174 * 0.24))
  })

  it('calls the route clean with no pre-tax IRA, and is quiet under the phase-out', () => {
    const db = mem()
    seed(db, 0)
    const f = getCheckup(db, today, 'max@x').findings.find((x) => x.kind === 'backdoor-roth')!
    expect(f.impactCents).toBe(0)
    expect(f.title).toContain('tax-free')
    const db2 = mem()
    putTaxSettings(db2, { filingStatus: 'mfj', state: 'TX' })
    pay(db2, { grossCents: $(5_000), retirementCents: $(500) }) // ≈$130,000 a year
    expect(kinds(db2)).not.toContain('backdoor-roth')
  })
})

describe('people', () => {
  it('lists earners and owners, keeps what was saved, and validates', () => {
    const db = mem()
    pay(db, {})
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking, owner) VALUES ('Roth', 'retirement', 'lots', 'Nicole')").run()
    expect(listPeople(db).map((p) => p.name)).toEqual(['Max', 'Nicole'])
    putPeople(db, { people: [{ name: 'nicole', birthYear: 1985 }, { name: 'Kid', birthYear: 2015 }] }, today)
    expect(listPeople(db)).toEqual([
      { name: 'Max', birthYear: null, hsaCoverage: 'none', hsaCents: 0 },
      { name: 'nicole', birthYear: 1985, hsaCoverage: 'none', hsaCents: 0 },
      { name: 'Kid', birthYear: 2015, hsaCoverage: 'none', hsaCents: 0 },
    ])
    expect(() => putPeople(db, { people: [{ name: 'Max', birthYear: 1800 }] }, today)).toThrow(/birthYear/)
    expect(() => putPeople(db, { people: [{ name: 'Max' }, { name: 'max' }] }, today)).toThrow(/twice/)
    expect(() => putPeople(db, { people: [{ name: 'Max', hsaCoverage: 'gold' }] }, today)).toThrow(/hsaCoverage/)
  })

  it('rides the snapshot, with the paycheck’s Roth line and match', () => {
    const db = mem()
    pay(db, { retirementCents: $(500), rothCents: $(250), matchRateMicro: 500_000, matchCapMicro: 60_000, matchTrueUp: true })
    putPeople(db, { people: [{ name: 'Max', birthYear: 1975, hsaCoverage: 'self', hsaCents: $(1_000) }] }, today)
    const copy = mem()
    loadDump(copy, dumpDb(db))
    expect(getContributions(copy, today)).toEqual(getContributions(db, today))
  })

  it('refuses half a match', () => {
    const db = mem()
    expect(() => pay(db, { matchRateMicro: 500_000 })).toThrow(/match needs both/)
  })
})
