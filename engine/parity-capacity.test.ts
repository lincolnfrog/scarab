import { describe, expect, it } from 'vitest'
import { createAccountFlow, deleteAccountFlow, listAccountFlows, updateAccountFlow } from './account-flows'
import { getCapacity } from './capacity'
import type { DbLike } from './db'
import { deleteHarvestProfile, getHarvestProfile, putHarvestProfile } from './harvest'
import { getInvestAccount, listInvestAccounts } from './invest'
import { createPlannedSale, deletePlannedSale, plannedSaleGains, updatePlannedSale } from './planned-sales'
import { putReportedRealized } from './realized-reported'
import { putTaxSettings } from './tax'
import { seedHousehold } from './test/household'
import { onBothEngines } from './test/parity'
import { getTwoYear } from './twoyear'

const TODAY = '2026-09-22'
const $ = (dollars: number) => Math.round(dollars * 100)

/** The seeded household plus a managed account with deposits and a forecast, a reported loss and a planned sale of VTI. */
function planned(db: DbLike) {
  seedHousehold(db)
  putTaxSettings(db, { filingStatus: 'mfj', state: 'CA', wagesAnnualCents: $(250_000) })
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Flex 250', 'brokerage', 'balance')").run() // 5
  db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (5, '2026-08-31', ?)").run($(900_000))
  createAccountFlow(db, { investAccountId: 5, flowedOn: '2026-04-01', amountCents: $(800_000) }, TODAY)
  createAccountFlow(db, { investAccountId: 5, flowedOn: '2026-09-10', amountCents: $(100_000), note: 'wire' }, TODAY)
  createAccountFlow(db, { investAccountId: 5, flowedOn: '2027-01-04', amountCents: $(400_000), note: 'planned' }, TODAY)
  putHarvestProfile(
    db,
    5,
    { asOf: '2026-08-31', year1Micro: 700_000, year2Micro: 390_000, laterMicro: 250_000, source: 'test', years: [{ taxYear: 2026, lossCents: $(90_000) }, { taxYear: 2027, lossCents: $(200_000) }] },
    TODAY,
  )
  putReportedRealized(db, 5, 2026, { stCents: -$(120_000), ltCents: $(2_000), asOf: '2026-09-15' }, TODAY)
  createPlannedSale(db, { investAccountId: 1, assetId: 1, plannedOn: '2027-01-05', qtyMicro: 4_000_000, note: 'VTI' }, TODAY)
}

describe('capacity parity: better-sqlite3 and sql.js', () => {
  it('getCapacity is identical, and not vacuous', async () => {
    const { server, browser } = await onBothEngines(planned, (db) => getCapacity(db, TODAY))
    expect(browser).toEqual(server)
    expect(server.years.map((y) => y.year)).toEqual([2026, 2027])
    expect(server.years[0]!.forecastCents).toBeLessThan(0)
    expect(server.years[1]!.plannedStCents).not.toBe(0) // VTI bought in February: short-term by January
    expect(server.sales).toHaveLength(1)
    expect(server.accounts).toHaveLength(1)
    expect(server.series.losses.length).toBeGreaterThan(6)
    expect(server.markers).toHaveLength(1)
  })

  it('the two-year view with the plan in it is identical', async () => {
    const { server, browser } = await onBothEngines(planned, (db) => getTwoYear(db, TODAY))
    expect(browser).toEqual(server)
    expect(server.nextYear.forecastLossCents).toBeGreaterThan(0)
    expect(server.nextYear.plannedStCents).not.toBe(0)
  })

  it('flows, forecasts and planned sales write and read identically', async () => {
    const run = (db: DbLike) => {
      const flow = createAccountFlow(db, { investAccountId: 5, flowedOn: '2026-05-05', amountCents: -$(5_000) }, TODAY)
      const edited = updateAccountFlow(db, flow.row.id, { flowedOn: '2026-05-06', amountCents: -$(6_000), note: 'fee' }, TODAY)
      const removedFlow = deleteAccountFlow(db, flow.row.id, TODAY)
      const gains = plannedSaleGains(db, TODAY)
      const sale = gains[0]!
      const moved = updatePlannedSale(db, sale.id, { investAccountId: 1, assetId: 1, plannedOn: '2027-02-01', qtyMicro: 3_000_000, priceCents: $(300) }, TODAY)
      const removedSale = deletePlannedSale(db, sale.id)
      const profile = getHarvestProfile(db, 5)
      const removedProfile = deleteHarvestProfile(db, 5)
      return {
        flow: flow.row,
        edited,
        removedFlow,
        flows: listAccountFlows(db, TODAY, { accountId: 5 }),
        gains,
        moved,
        removedSale,
        profile,
        removedProfile,
        detail: getInvestAccount(db, 5, TODAY),
        counts: listInvestAccounts(db).map((a) => [a.name, a.counts.flows, a.counts.planned]),
      }
    }
    const { server, browser } = await onBothEngines(planned, run)
    expect(browser).toEqual(server)
    expect(server.edited.changed).toBe(true)
    expect(server.gains[0]!.st_cents).not.toBe(0)
    expect(server.profile).not.toBeNull()
    expect(server.detail.harvest).toBeNull()
    expect(server.detail.flows).toHaveLength(3)
  })
})
