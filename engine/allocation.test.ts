import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import { getAllocation, guessClass, putAccountClass, putAssetClass, putTarget } from './allocation'
import { getCheckup } from './checkup'
import type { DbLike } from './db'
import { getDigest } from './digest'
import { createPaySource } from './paychecks'
import { dumpDb, loadDump } from './snapshot'
import { putTaxSettings } from './tax'
import { onBothEngines } from './test/parity'

const mem = () => openDb(':memory:') as unknown as DbLike
const $ = (dollars: number) => Math.round(dollars * 100)
const today = '2026-10-01'

/**
 * $100k: $10k cash in the bank; a taxable brokerage with VTI (two lots: one
 * at a loss, one at a gain) and BND; a lots-tracked 401(k) holding VTI.
 */
function household(db: DbLike) {
  db.prepare("INSERT INTO accounts (name, kind, opening_cents) VALUES ('Checking', 'checking', ?)").run($(10_000))
  const acct = db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype) VALUES (?, ?, 'lots', ?)")
  acct.run('Schwab', 'brokerage', 'taxable') // 1
  acct.run('401(k)', 'retirement', '401k') // 2
  const asset = db.prepare("INSERT INTO assets (symbol, kind) VALUES (?, 'stock')")
  asset.run('VTI') // 1
  asset.run('BND') // 2
  const buy = db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (?, ?, ?, 'buy', ?, ?)")
  buy.run(1, 1, '2019-03-01', 50_000_000, $(5_000)) // 50 sh → $15,000: +$10,000
  buy.run(1, 1, '2025-01-02', 50_000_000, $(20_000)) // 50 sh → $15,000: −$5,000
  buy.run(1, 2, '2020-01-02', 200_000_000, $(16_000)) // 200 sh → $14,000
  buy.run(2, 1, '2018-01-02', 153_333_333, $(20_000)) // ≈153.3 sh → $46,000
  const price = db.prepare("INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (?, '2026-09-30', ?)")
  price.run(1, $(300))
  price.run(2, $(70))
}
const row = (db: DbLike, cls: string) => getAllocation(db, today).rows.find((r) => r.cls === cls)

describe('asset classes', () => {
  it('guesses from known funds, then the name, then the kind', () => {
    expect(guessClass('VTI', null, 'stock')).toBe('us_stock')
    expect(guessClass('VXUS', null, 'stock')).toBe('intl_stock')
    expect(guessClass('BND', null, 'stock')).toBe('bonds')
    expect(guessClass('SGOV', null, 'stock')).toBe('cash')
    expect(guessClass('XYZ', 'Acme Total Bond Market Index ETF', 'stock')).toBe('bonds')
    expect(guessClass('XYZ', 'Acme Emerging Markets Fund', 'stock')).toBe('intl_stock')
    expect(guessClass('XYZ', 'Acme Target Retirement 2050', 'stock')).toBe('other')
    expect(guessClass('AAPL', 'Apple Inc.', 'stock')).toBe('us_stock')
    expect(guessClass('BTC', null, 'crypto')).toBe('crypto')
  })

  it('adds up what is invested by class: holdings, bank cash, balance-only accounts', () => {
    const db = mem()
    household(db)
    db.prepare("INSERT INTO invest_accounts (name, kind, tracking, subtype) VALUES ('Old 401(k)', 'retirement', 'balance', '401k')").run() // 3
    db.prepare("INSERT INTO balance_snapshots (invest_account_id, balanced_on, balance_cents) VALUES (3, '2026-09-01', ?)").run($(20_000))
    const a = getAllocation(db, today)
    expect(a.totalCents).toBe($(120_000))
    expect(row(db, 'us_stock')!.cents).toBe($(76_000))
    expect(row(db, 'bonds')!.cents).toBe($(14_000))
    expect(row(db, 'cash')!.cents).toBe($(10_000))
    expect(row(db, 'other')!.cents).toBe($(20_000))
    putAccountClass(db, 3, { assetClass: 'bonds' })
    expect(row(db, 'bonds')!.cents).toBe($(34_000))
    putAssetClass(db, 2, { assetClass: 'cash' })
    expect(row(db, 'cash')!.cents).toBe($(24_000))
    expect(getAllocation(db, today).assets.find((x) => x.symbol === 'BND')).toMatchObject({ cls: 'cash', guessed: false })
    expect(() => putAccountClass(db, 1, { assetClass: 'bonds' })).toThrow(/balance-tracked/)
    expect(() => putAssetClass(db, 1, { assetClass: 'gold' })).toThrow(/assetClass/)
  })

  it('rides the snapshot', () => {
    const db = mem()
    household(db)
    putAssetClass(db, 2, { assetClass: 'cash' })
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const copy = mem()
    loadDump(copy, dumpDb(db))
    expect(getAllocation(copy, today)).toEqual(getAllocation(db, today))
  })
})

describe('target and plan', () => {
  it('refuses a target that does not make 100%', () => {
    const db = mem()
    expect(() => putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000 } })).toThrow(/90.00%/)
    expect(() => putTarget(db, { targets: { gold: 1_000_000 } })).toThrow(/unknown/)
    expect(putTarget(db, { targets: {} }).targets).toBeNull()
  })

  it('reports drift and what moves each class to target', () => {
    const db = mem()
    household(db)
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const us = row(db, 'us_stock')!
    expect(us.shareMicro).toBe(760_000)
    expect(us.driftMicro).toBe(160_000)
    expect(us.toTargetCents).toBe(-$(16_000))
    expect(row(db, 'bonds')!.toTargetCents).toBe($(16_000))
  })

  it('sells inside the 401(k) before touching taxable: no tax', () => {
    const db = mem()
    household(db)
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const p = getAllocation(db, today).plan!
    expect(p.contributionsCents).toBe(0)
    expect(p.steps.filter((s) => s.step === 'taxable')).toEqual([])
    expect(p.steps.find((s) => s.step === 'sheltered' && s.action === 'sell')).toMatchObject({ cls: 'us_stock', cents: $(16_000), where: 'VTI in 401(k)' })
    expect(p.taxable.taxCents).toBe(0)
  })

  it('spends a year of contributions on the underweight first', () => {
    const db = mem()
    household(db)
    createPaySource(db, { earner: 'Max', cadence: 'biweekly', paidOn: '2026-09-25', grossCents: $(5_000), retirementCents: $(500), ytdGrossCents: $(95_000), ytdRetirementCents: $(9_500) })
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const p = getAllocation(db, today).plan!
    expect(p.contributionsCents).toBe($(12_500)) // $9,500 so far + 6 checks × $500
    const given = p.steps.filter((s) => s.step === 'contribute').reduce((s, x) => s + x.cents, 0)
    expect(given).toBe($(12_500))
    expect(p.steps.filter((s) => s.step === 'contribute').map((s) => s.cls)).toContain('bonds')
  })

  it('in taxable, sells losses before gains and prices the tax', () => {
    const db = mem()
    household(db)
    putTaxSettings(db, { filingStatus: 'mfj', state: 'TX', wagesAnnualCents: $(300_000) })
    // The 401(k) holds only bonds, so US stock ($30,000, all taxable VTI) can only come down by selling there.
    putTarget(db, { targets: { us_stock: 100_000, bonds: 800_000, cash: 100_000 } })
    db.prepare("UPDATE trades SET asset_id = 2, qty_micro = 657142857 WHERE invest_account_id = 2").run() // 401(k) → BND ($46,000)
    const p = getAllocation(db, today).plan!
    const sales = p.steps.filter((s) => s.step === 'taxable' && s.action === 'sell')
    expect(sales[0]!.lot).toMatchObject({ symbol: 'VTI', openedOn: '2025-01-02', term: 'lt' })
    expect(sales[0]!.lot!.gainCents).toBeLessThan(0)
    expect(sales[1]!.lot).toMatchObject({ openedOn: '2019-03-01' })
    expect(p.taxable.ltGainCents).toBe(-$(5_000) + Math.round(($(10_000) * sales[1]!.cents) / $(15_000)))
  })
})

describe('digest and Checkup', () => {
  it('the digest measures drift against the target once there is one', () => {
    const db = mem()
    household(db)
    db.prepare("INSERT INTO app_meta (key, value) VALUES ('digest:last_seen:max@x', '2026-09-01 00:00:00')").run()
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const d = getDigest(db, 'max@x', today)
    expect(d.allocationVsTarget).toBe(true)
    expect(d.allocationDrift.find((r) => r.name === 'us_stock')).toMatchObject({ nowMicro: 760_000, thenMicro: 600_000 })
  })

  it('the Checkup prices how far off target, with the plan in its arithmetic', () => {
    const db = mem()
    household(db)
    putTarget(db, { targets: { us_stock: 600_000, bonds: 300_000, cash: 100_000 } })
    const f = getCheckup(db, today, 'max@x').findings.find((x) => x.kind === 'allocation-drift')!
    expect(f.impactCents).toBe($(16_000))
    expect(f.action?.to).toEqual({ screen: 'invest', rest: ['allocation'] })
  })

  it('flags bonds in taxable while the 401(k) holds stock, but not municipal bonds', () => {
    const db = mem()
    household(db)
    const f = getCheckup(db, today, 'max@x').findings.find((x) => x.kind === 'asset-location')!
    expect(f.title).toContain('$14,000 of bonds sit in taxable')
    db.prepare("UPDATE assets SET symbol = 'VTEB' WHERE id = 2").run()
    expect(getCheckup(db, today, 'max@x').findings.some((x) => x.kind === 'asset-location')).toBe(false)
  })

  it('reads the same on sql.js', async () => {
    const { server, browser } = await onBothEngines(
      (db) => {
        household(db)
        putTarget(db, { targets: { us_stock: 500_000, intl_stock: 100_000, bonds: 300_000, cash: 100_000 } })
      },
      (db) => getAllocation(db, today),
    )
    expect(browser).toEqual(server)
  })
})
