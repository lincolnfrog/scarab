import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { createAccountFlow } from './account-flows'
import { getCapacity } from './capacity'
import type { DbLike } from './db'
import { putHarvestProfile } from './harvest'
import { createPlannedSale } from './planned-sales'
import { putReportedRealized } from './realized-reported'
import { putTaxSettings } from './tax'
import { getTwoYear, priceTiming } from './twoyear'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const pct = (p: number) => p * 10_000
const BTC = (n: number) => n * 1_000_000
const today = '2026-10-11'

/**
 * A Texas household on $300k of wages. Coinbase (1) holds 10 BTC from 2017 at
 * $3,500 and sold one in August for $63,000; Flex 250 (2), tracked by balance,
 * has reported $500,000 of losses through Sept 18 and carries the manager's
 * estimate (the same one engine/harvest.test.ts checks day by day); a Roth (3)
 * is along for the ride. BTC last quoted at $80,000.
 */
function household() {
  const db = mem()
  putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', wagesAnnualCents: $(300_000) })
  const acct = db.prepare('INSERT INTO invest_accounts (name, kind, tracking) VALUES (?, ?, ?)')
  acct.run('Coinbase', 'crypto', 'lots')
  acct.run('Flex 250', 'brokerage', 'balance')
  acct.run('Roth IRA', 'retirement', 'lots')
  db.prepare("INSERT INTO assets (symbol, kind) VALUES ('BTC', 'crypto')").run()
  const t = db.prepare('INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, 1, ?, ?, ?, ?)')
  t.run(1, '2017-06-06', 'buy', BTC(10), $(35_000))
  t.run(1, '2026-08-17', 'sell', BTC(1), $(63_000))
  t.run(3, '2024-01-10', 'buy', BTC(1), $(40_000))
  t.run(3, '2026-05-01', 'sell', BTC(1), $(70_000)) // sheltered: never counts
  db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, '2026-10-01', ?)").run($(80_000))
  db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (2, '2026-08-31', ?)").run($(2_000_000))
  putHarvestProfile(
    db,
    2,
    {
      asOf: '2026-08-31',
      year1Micro: pct(70),
      year2Micro: pct(39),
      laterMicro: pct(25),
      source: 'Manager email',
      years: [
        { taxYear: 2026, lossCents: $(350_000) },
        { taxYear: 2027, lossCents: $(670_000) },
        { taxYear: 2028, lossCents: $(540_000) },
      ],
    },
    today,
  )
  createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-04-01', amountCents: $(1_500_000) }, today)
  createAccountFlow(db, { investAccountId: 2, flowedOn: '2026-09-15', amountCents: $(200_000) }, today)
  createAccountFlow(db, { investAccountId: 2, flowedOn: '2027-01-05', amountCents: $(1_600_000) }, today)
  createAccountFlow(db, { investAccountId: 2, flowedOn: '2027-06-01', amountCents: -$(50_000) }, today)
  putReportedRealized(db, 2, 2026, { stCents: -$(500_000), ltCents: 0, asOf: '2026-09-18' }, today)
  return db
}

describe('loss capacity, year by year', () => {
  it('nets this year’s sales and reported losses with the forecast, and carries the rest by character', () => {
    const db = household()
    const cap = getCapacity(db, today)
    expect(cap.thisYear).toBe(2026)
    expect(cap.years.map((y) => y.year)).toEqual([2026, 2027, 2028]) // the manager's figures reach 2028
    const y26 = cap.years[0]!
    expect(y26).toMatchObject({
      salesStCents: 0,
      salesLtCents: $(59_500),
      plannedStCents: 0,
      plannedLtCents: 0,
      reportedCents: -$(500_000),
      forecastCents: -33_582_537,
      carryInStCents: 0,
      carryInLtCents: 0,
      netStCents: 0,
      netLtCents: 0,
      capLossUsedCents: $(3_000),
      est: true,
    })
    // $500,000 reported + $335,825.37 expected − $59,500 of gains − the $3,000 against income: all short-term, since the
    // loss is.
    expect(y26.carryOutStCents).toBe($(500_000) + 33_582_537 - $(59_500) - $(3_000))
    expect(y26.carryOutLtCents).toBe(0)
    expect(y26.roomCents).toBe(y26.carryOutStCents)
    // The capital side lowers the bill by the $3,000 at the household's marginal rate (24%, no state tax).
    expect(y26.capGainsTaxCents).toBe(-$(720))
    const y27 = cap.years[1]!
    expect(y27).toMatchObject({ carryInStCents: y26.carryOutStCents, carryInLtCents: 0, salesStCents: 0, salesLtCents: 0, reportedCents: 0, forecastCents: -189_931_776, est: true })
    expect(y27.roomCents).toBe(y26.carryOutStCents + 189_931_776 - $(3_000))
    expect(cap.years[2]!.carryInStCents).toBe(y27.carryOutStCents)
    // No forecast, no plan: facts only, and the year says so.
    db.prepare('DELETE FROM harvest_forecasts').run()
    db.prepare('DELETE FROM harvest_profiles').run()
    const plain = getCapacity(db, today)
    expect(plain.years.map((y) => y.year)).toEqual([2026, 2027])
    expect(plain.years[0]).toMatchObject({ forecastCents: 0, est: false, carryOutStCents: $(500_000) - $(59_500) - $(3_000) })
  })

  it('a planned sale is a gain in its year, priced off the lots, and taxed once the losses run out', () => {
    const db = household()
    createPlannedSale(db, { investAccountId: 1, assetId: 1, plannedOn: '2027-01-05', qtyMicro: BTC(8), note: 'January' }, today)
    const cap = getCapacity(db, today)
    const y27 = cap.years[1]!
    // 8 × $80,000 against 8 × $3,500 of 2017 basis: long-term $612,000.
    expect(y27).toMatchObject({ plannedStCents: 0, plannedLtCents: $(612_000) })
    expect(cap.sales).toHaveLength(1)
    expect(cap.sales[0]).toMatchObject({ symbol: 'BTC', lt_cents: $(612_000), price_source: 'quote' })
    // Losses still exceed the gain: nothing taxed, less carried.
    expect(y27.netLtCents).toBe(0)
    expect(y27.roomCents).toBe(cap.years[0]!.carryOutStCents + 189_931_776 - $(612_000) - $(3_000))
    // Sell the lot at a price the losses can't cover: the net gain is taxed in 2027.
    createPlannedSale(db, { investAccountId: 1, assetId: 1, plannedOn: '2027-01-06', qtyMicro: BTC(1), priceCents: $(50_000_000) }, today)
    const rich = getCapacity(db, today).years[1]!
    expect(rich.netLtCents).toBeGreaterThan(0)
    expect(rich.roomCents).toBe(0)
    expect(rich.capGainsTaxCents).toBeGreaterThan($(1_000_000))
    expect(rich.taxCents).toBe(rich.capGainsTaxCents + cap.years[1]!.taxCents - cap.years[1]!.capGainsTaxCents)
  })

  it('draws both sides through the calendar: facts solid, the rest dashed, each year from its carry-in', () => {
    const db = household()
    createPlannedSale(db, { investAccountId: 1, assetId: 1, plannedOn: '2027-01-05', qtyMicro: BTC(8) }, today)
    const cap = getCapacity(db, today)
    const { losses, gains } = cap.series
    // Losses: the year opens at its carry-in, the broker's figure lands on its day, then month ends ahead are estimates.
    expect(losses[0]).toEqual({ t: '2026-01-01', v: 0, est: false })
    expect(losses[1]).toEqual({ t: '2026-09-18', v: $(500_000) })
    expect(losses[2]).toMatchObject({ t: '2026-10-31', est: true })
    const dec26 = losses.find((p) => p.t === '2026-12-31')!
    expect(dec26.v).toBe($(500_000) + 33_582_537)
    // A break, then 2027 opens at what 2026 carried.
    const brk = losses.findIndex((p) => p.t === '2027-01-01')
    expect(losses[brk]).toEqual({ t: '2027-01-01', v: null })
    expect(losses[brk + 1]).toEqual({ t: '2027-01-02', v: cap.years[0]!.carryOutStCents, est: true })
    expect(losses.find((p) => p.t === '2027-12-31')!.v).toBe(cap.years[0]!.carryOutStCents + 189_931_776)
    // Gains: the August sale as it happened, the planned one dashed, each year a step from zero.
    expect(gains.slice(0, 3)).toEqual([
      { t: '2026-01-01', v: 0, est: false },
      { t: '2026-08-17', v: $(59_500) },
      { t: '2026-12-31', v: $(59_500), est: true },
    ])
    expect(gains.find((p) => p.t === '2027-01-05')).toEqual({ t: '2027-01-05', v: $(612_000), est: true })
    expect(cap.markers).toEqual([{ id: expect.stringMatching(/^sale:/), t: '2027-01-05', label: 'BTC 8' }])
    // Every series is in time order, nulls aside.
    for (const s of [losses, gains]) for (let i = 1; i < s.length; i++) expect(s[i]!.t >= s[i - 1]!.t, `${s[i - 1]!.t} → ${s[i]!.t}`).toBe(true)
  })

  it('names its accounts, says what it assumed and what it leaves out', () => {
    const db = household()
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Old managed', 'brokerage', 'balance')").run()
    const cap = getCapacity(db, today)
    expect(cap.accounts.map((a) => [a.name, a.profile !== null, a.flows.length, a.byYear.length])).toEqual([
      ['Flex 250', true, 4, 3],
      ['Old managed', false, 0, 0],
    ])
    expect(cap.accounts[0]!.reported).toEqual({ cents: -$(500_000), asOf: '2026-09-18' })
    expect(cap.accounts[0]!.notes.join(' ')).toMatch(/1 deposit on or before the estimate/)
    expect(cap.accounts[1]!.notes[0]).toMatch(/No harvest forecast entered/)
    expect(cap.basis[0]).toBe('Realized so far in 2026: +$59,500 from recorded sales, -$500,000 as brokers report it through 2026-09-18')
    expect(cap.basis.find((b) => b.startsWith('Flex 250:'))).toMatch(/figures \(2026 \$350,000, 2027 \$670,000, 2028 \$540,000\); new money 70% in its first year, 39% in its second, 25% a year after — Manager email, as of 2026-08-31/)
    expect(cap.leavesOut.length).toBeGreaterThan(2)
    expect(cap.vintage).toMatch(/held for later years/)
  })

  it('the two-year view and the timing question see the same plan', () => {
    const db = household()
    createPlannedSale(db, { investAccountId: 1, assetId: 1, plannedOn: '2027-01-05', qtyMicro: BTC(8) }, today)
    const v = getTwoYear(db, today)
    expect(v.thisYear).toMatchObject({ stGainCents: -$(500_000), ltGainCents: $(59_500), plannedLtCents: 0, forecastLossCents: 33_582_537 })
    expect(v.nextYear).toMatchObject({ stGainCents: 0, ltGainCents: 0, plannedStCents: 0, plannedLtCents: $(612_000), forecastLossCents: 189_931_776 })
    expect(v.nextYear.carryInStCents).toBe(getCapacity(db, today).years[0]!.carryOutStCents)
    expect(v.basis.find((b) => b.includes('planned sale'))).toBe('2027: 1 planned sale — +$612,000 realized as the lots stand today')
    // With this much loss ahead either year, a $25,000 gain costs nothing now or in January.
    const t = priceTiming(db, today, { kind: 'lt-gain', amountCents: $(25_000) })
    expect(t.nowSavesCents).toBe(0)
  })
})
