import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { HISTORICAL_REAL_RETURNS_MICRO } from './history'
import {
  compareScenarios,
  createScenario,
  deleteScenario,
  listScenarios,
  priceScenarioDecision,
  updateScenario,
} from './scenarios'
import { dumpDb, loadDump } from './snapshot'
import { openBrowserDb } from './sqljs-db'
import { migrate } from './migrations'
import { crossingYear, priceDecision, simulate, type SimParams } from './simulate'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-09-03'

const BASE: SimParams = {
  startYear: 2026,
  endYear: 2056,
  liquidCents: $(1_000_000),
  propertyCents: 0,
  liabilitiesCents: 0,
  meanReturnMicro: 50_000,
  volMicro: 0,
  propertyGrowthMicro: 0,
  saveBeforeBuyCents: 0,
  saveAfterBuyCents: 0,
  buy: null,
  retireYear: 2056,
  retireSpendCents: 0,
  paths: 200,
  seed: 7,
}

/* ---------- simulate: events ---------- */

describe('simulate events', () => {
  it('a one-off outflow leaves the portfolio in its year and compounds away', () => {
    const plain = simulate(BASE)
    const withEvent = simulate({ ...BASE, events: [{ year: 2030, amountCents: -$(80_000) }] })
    const i2029 = plain.years.indexOf(2029)
    const i2030 = plain.years.indexOf(2030)
    expect(withEvent.p50[i2029]).toBe(plain.p50[i2029]) // untouched before
    expect(plain.p50[i2030]! - withEvent.p50[i2030]!).toBe($(80_000))
    // 26 years of 5% real on the missing $80k
    const last = plain.years.length - 1
    expect(plain.p50[last]! - withEvent.p50[last]!).toBeCloseTo($(80_000) * Math.pow(1.05, 26), -6)
  })

  it('a recurring event repeats through untilYear inclusive, then stops', () => {
    const r = simulate({ ...BASE, meanReturnMicro: 0, events: [{ year: 2030, amountCents: -$(10_000), untilYear: 2032 }] })
    const at = (y: number) => r.p50[r.years.indexOf(y)]!
    expect(at(2029)).toBe($(1_000_000))
    expect(at(2030)).toBe($(990_000))
    expect(at(2032)).toBe($(970_000))
    expect(at(2033)).toBe($(970_000))
  })

  it('an inflow raises the plan; events can turn a failing retirement into a passing one', () => {
    const tight: SimParams = { ...BASE, liquidCents: $(500_000), retireYear: 2030, retireSpendCents: $(60_000), volMicro: 100_000, paths: 500 }
    const before = simulate(tight).successPct
    const after = simulate({ ...tight, events: [{ year: 2029, amountCents: $(1_500_000), label: 'inheritance' }] }).successPct
    expect(after).toBeGreaterThan(before)
    expect(after).toBe(100)
  })
})

/* ---------- simulate: historical draw ---------- */

describe('historical draw', () => {
  it('bundles a plausible record: 1928 onward, long-run real mean in the 6–9% band', () => {
    const r = HISTORICAL_REAL_RETURNS_MICRO
    expect(r.length).toBeGreaterThanOrEqual(95)
    const mean = r.reduce((s, v) => s + v, 0) / r.length / 1_000_000
    expect(mean).toBeGreaterThan(0.06)
    expect(mean).toBeLessThan(0.09)
    expect(Math.min(...r)).toBeLessThan(-300_000) // 1931 is in there
  })

  it('is deterministic for a seed and differs across seeds', () => {
    const p: SimParams = { ...BASE, volMicro: 120_000, draw: 'historical', paths: 300 }
    const a = simulate(p)
    const b = simulate(p)
    const c = simulate({ ...p, seed: 8 })
    expect(a).toEqual(b)
    expect(a.p50).not.toEqual(c.p50)
  })

  it('re-centres to the scenario assumptions: same expected growth as lognormal, wider fan', () => {
    const p: SimParams = { ...BASE, volMicro: 120_000, paths: 4000, seed: 3 }
    const ln = simulate(p)
    const hist = simulate({ ...p, draw: 'historical' })
    const last = ln.years.length - 1
    // medians within ~15% of each other after 30 years (same mean, different shape)
    const ratio = hist.p50[last]! / ln.p50[last]!
    expect(ratio).toBeGreaterThan(0.8)
    expect(ratio).toBeLessThan(1.25)
    // fan is ordered either way
    expect(hist.p10[last]!).toBeLessThan(hist.p50[last]!)
    expect(hist.p50[last]!).toBeLessThan(hist.p90[last]!)
  })

  it('zero volatility collapses the historical fan to the deterministic path', () => {
    const r = simulate({ ...BASE, draw: 'historical' })
    const last = r.years.length - 1
    expect(r.p10[last]).toBe(r.p90[last])
    expect(r.p50[last]).toBeCloseTo($(1_000_000) * Math.pow(1.05, 30), -6)
  })
})

/* ---------- crossing year ---------- */

describe('crossingYear', () => {
  const p: SimParams = {
    ...BASE,
    liquidCents: $(1_500_000),
    saveBeforeBuyCents: $(100_000),
    retireSpendCents: $(120_000),
    volMicro: 120_000,
    paths: 500,
  }
  it('finds the earliest retirement year clearing the threshold, and it clears it', () => {
    const y = crossingYear(p, 90)
    expect(y).not.toBeNull()
    expect(simulate({ ...p, retireYear: y!, paths: 1000 }).successPct).toBeGreaterThanOrEqual(90)
    expect(simulate({ ...p, retireYear: y! - 1, paths: 1000 }).successPct).toBeLessThan(90)
  })
  it('a stricter threshold never crosses earlier', () => {
    const y90 = crossingYear(p, 90)!
    const y75 = crossingYear(p, 75)!
    expect(y75).toBeLessThanOrEqual(y90)
  })
  it('returns null when nothing clears the bar', () => {
    expect(crossingYear({ ...p, liquidCents: $(10_000), saveBeforeBuyCents: 0, retireSpendCents: $(500_000) }, 90)).toBeNull()
  })
})

/* ---------- price a decision ---------- */

describe('priceDecision', () => {
  it('compounds the outlay to retirement and reports the odds shift', () => {
    const p: SimParams = { ...BASE, retireYear: 2046, retireSpendCents: $(70_000), volMicro: 120_000, paths: 1000 }
    const d = priceDecision(p, { year: 2027, amountCents: -$(80_000) })
    expect(d.atYear).toBe(2046)
    expect(d.futureValueCents).toBe(-Math.round($(80_000) * Math.pow(1.05, 19)))
    expect(d.successAfterPct).toBeLessThanOrEqual(d.successBeforePct)
    expect(d.medianEndAfterCents).toBeLessThan(d.medianEndBeforeCents)
  })
})

/* ---------- scenarios service ---------- */

function seedBalanceSheet(db: DbLike) {
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Brokerage', 'brokerage', 'balance')").run()
  db.prepare('INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (1, ?, ?)').run(
    '2026-08-31',
    $(2_000_000),
  )
}

describe('scenarios', () => {
  it('seeds a baseline on first read, once', () => {
    const db = mem()
    const a = listScenarios(db, today)
    expect(a).toHaveLength(1)
    expect(a[0]!.isBaseline).toBe(true)
    expect(a[0]!.params.retireYear).toBe(2048)
    expect(a[0]!.params.saveBeforeBuyCents).toBe($(150_000))
    expect(a[0]!.params.retireSpendCents).toBe($(180_000))
    expect(listScenarios(db, today)).toHaveLength(1)
  })

  it('create clones, update validates, baseline moves, last one is kept', () => {
    const db = mem()
    const base = listScenarios(db, today)[0]!
    updateScenario(db, base.id, { params: { retireYear: 2050, events: [{ year: 2030, amountCents: -$(50_000), label: 'roof' }] } }, today)
    const copy = createScenario(db, { name: 'Retire 55', cloneFromId: base.id, params: { retireYear: 2043 } }, today)
    expect(copy.params.retireYear).toBe(2043)
    expect(copy.params.events).toEqual([{ year: 2030, amountCents: -$(50_000), label: 'roof' }])
    expect(copy.isBaseline).toBe(false)

    expect(() => updateScenario(db, copy.id, { params: { retireYear: 2070 } }, today)).toThrow(/endYear/)
    expect(() => updateScenario(db, copy.id, { params: { volMicro: 'lots' } }, today)).toThrow(/integer/)
    expect(() => updateScenario(db, copy.id, { name: '  ' }, today)).toThrow(/name/)

    updateScenario(db, copy.id, { isBaseline: true }, today)
    const list = listScenarios(db, today)
    expect(list[0]!.id).toBe(copy.id)
    expect(list.filter((s) => s.isBaseline)).toHaveLength(1)

    deleteScenario(db, copy.id) // deleting the baseline promotes the other
    const after = listScenarios(db, today)
    expect(after).toHaveLength(1)
    expect(after[0]!.isBaseline).toBe(true)
    expect(() => deleteScenario(db, after[0]!.id)).toThrow(/at least one/)
  })

  it('compare runs every scenario against the ledger with deltas vs baseline', () => {
    const db = mem()
    seedBalanceSheet(db)
    const base = listScenarios(db, today)[0]!
    updateScenario(db, base.id, { params: { buyEnabled: false, retireYear: 2046, retireSpendCents: $(90_000) } }, today)
    createScenario(db, { name: 'Retire 2040', cloneFromId: base.id, params: { retireYear: 2040 } }, today)

    const c = compareScenarios(db, today, { draw: 'lognormal', thresholdPct: 90 })
    expect(c.balance?.total).toBe($(2_000_000))
    expect(c.home).toBeNull() // no loan options → no purchase terms
    expect(c.runs).toHaveLength(2)
    const [b, early] = c.runs
    expect(b!.isBaseline).toBe(true)
    expect(b!.delta).toBeNull()
    expect(early!.delta).not.toBeNull()
    expect(early!.result.successPct).toBeLessThanOrEqual(b!.result.successPct)
    expect(early!.delta!.successPct).toBe(early!.result.successPct - b!.result.successPct)
    // crossing year is a property of the plan, not of retireYear — both scenarios share everything else
    expect(early!.crossingYear).toBe(b!.crossingYear)
    // the balance sheet is resolved at read time, never stored in the scenario
    expect(JSON.stringify(listScenarios(db, today))).not.toContain('liquidCents')
  })

  it('compare with no balance sheet yields no runs; price rejects it', () => {
    const db = mem()
    const c = compareScenarios(db, today)
    expect(c.balance).toBeNull()
    expect(c.runs).toEqual([])
    expect(() => priceScenarioDecision(db, today, { event: { year: 2027, amountCents: -1 } })).toThrow(/nothing to project/)
  })

  it('prices a decision against the baseline without saving it', () => {
    const db = mem()
    seedBalanceSheet(db)
    const base = listScenarios(db, today)[0]!
    updateScenario(db, base.id, { params: { buyEnabled: false, retireYear: 2046 } }, today)
    const d = priceScenarioDecision(db, today, { event: { year: 2027, amountCents: -$(80_000), label: 'remodel' } })
    expect(d.scenarioId).toBe(base.id)
    expect(d.atYear).toBe(2046)
    expect(d.futureValueCents).toBeLessThan(-$(200_000))
    expect(listScenarios(db, today)[0]!.params.events).toEqual([])
  })

  it('is identical on sql.js and survives a snapshot round-trip', async () => {
    const server = mem()
    seedBalanceSheet(server)
    const base = listScenarios(server, today)[0]!
    updateScenario(server, base.id, { params: { buyEnabled: false, retireYear: 2046 } }, today)
    createScenario(server, { name: 'Sabbatical', cloneFromId: base.id, params: { events: [{ year: 2028, amountCents: -$(120_000), untilYear: 2029 }] } }, today)
    const dump = dumpDb(server)
    expect(dump.tables.scenarios).toHaveLength(2)

    const browser = await openBrowserDb()
    migrate(browser)
    loadDump(browser, dump)
    expect(listScenarios(browser, today)).toEqual(listScenarios(server, today))
    expect(compareScenarios(browser, today, { draw: 'historical' })).toEqual(compareScenarios(server, today, { draw: 'historical' }))
  })
})
