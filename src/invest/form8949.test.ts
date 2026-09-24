import { describe, expect, it } from 'vitest'
import type { RealizedLine, RealizedReport } from '../../shared/invest-api'
import { csvDollars, description, form8949Csv, form8949Filename, formDate, lineNote } from './form8949'

const line = (over: Partial<RealizedLine>): RealizedLine => ({
  sale_trade_id: 7,
  account: 'Schwab',
  account_id: 1,
  symbol: 'VTI',
  qty_micro: 10_000_000,
  acquired_on: '2024-01-10',
  sold_on: '2026-06-01',
  proceeds_cents: 3_200_00,
  cost_cents: 1_000_00,
  gain_cents: 2_200_00,
  term: 'lt',
  basis: 'lot',
  note: null,
  wash_risk: false,
  ...over,
})

describe('exact dollars from cents', () => {
  it('never goes through a float', () => {
    expect(csvDollars(0)).toBe('0.00')
    expect(csvDollars(5)).toBe('0.05')
    expect(csvDollars(-30_000)).toBe('-300.00')
    expect(csvDollars(123_456_789_01)).toBe('123456789.01')
    expect(csvDollars(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91')
    expect(() => csvDollars(1.5)).toThrow()
  })
  it('dates and descriptions as the form writes them', () => {
    expect(formDate('2026-06-01')).toBe('06/01/2026')
    expect(description({ qty_micro: 1_500_000_000, symbol: 'VTI' })).toBe('1500 sh VTI')
    expect(description({ qty_micro: 52_000, symbol: 'BTC' })).toBe('0.052 sh BTC')
    expect(form8949Filename(2025)).toBe('scarab-form-8949-2025.csv')
  })
})

describe('the Form 8949 CSV', () => {
  const report: Pick<RealizedReport, 'lines' | 'st' | 'lt'> = {
    lines: [
      line({}),
      line({ qty_micro: 5_000_000, acquired_on: '2026-01-05', proceeds_cents: 1_600_00, cost_cents: 1_500_00, gain_cents: 100_00, term: 'st' }),
      line({ symbol: 'QQQ', account: 'Joint, taxable', qty_micro: 3_000_000, acquired_on: null, proceeds_cents: 900_00, cost_cents: 0, gain_cents: 900_00, term: 'st', basis: 'none' }),
      line({ symbol: 'ACME', proceeds_cents: 1_200_00, cost_cents: 1_500_00, gain_cents: -300_00, term: 'st', wash_risk: true }),
    ],
    st: { proceeds_cents: 3_700_00, cost_cents: 3_000_00, gain_cents: 700_00, lines: 3 },
    lt: { proceeds_cents: 3_200_00, cost_cents: 1_000_00, gain_cents: 2_200_00, lines: 1 },
  }

  it('Part I then Part II, columns (a)–(h), a total under each part', () => {
    const rows = form8949Csv(report).split('\r\n')
    expect(rows[0]).toBe(
      'Part,(a) Description of property,(b) Date acquired,(c) Date sold or disposed of,(d) Proceeds,(e) Cost or other basis,(f) Code(s),(g) Amount of adjustment,(h) Gain or (loss),Account,Check before filing',
    )
    expect(rows.slice(1)).toEqual([
      'I (short-term),5 sh VTI,01/05/2026,06/01/2026,1600.00,1500.00,,,100.00,Schwab,',
      'I (short-term),3 sh QQQ,,06/01/2026,900.00,0.00,,,900.00,"Joint, taxable",No basis recorded: counted at zero basis and short-term until it is entered',
      'I (short-term),10 sh ACME,01/10/2024,06/01/2026,1200.00,1500.00,,,-300.00,Schwab,Possible wash sale: a buy within 30 days; check the 1099-B for code W',
      'I (short-term) total,,,,3700.00,3000.00,,,700.00,,',
      'II (long-term),10 sh VTI,01/10/2024,06/01/2026,3200.00,1000.00,,,2200.00,Schwab,',
      'II (long-term) total,,,,3200.00,1000.00,,,2200.00,,',
      '',
    ])
  })

  it('a part with no lines is left out; notes join; quotes are doubled', () => {
    const only = form8949Csv({ lines: [line({ note: 'RSU withholding', basis: 'entered', account: 'He said "hi"' })], st: { proceeds_cents: 0, cost_cents: 0, gain_cents: 0, lines: 0 }, lt: report.lt })
    expect(only).not.toContain('I (short-term)')
    expect(only).toContain('"He said ""hi"""')
    expect(lineNote(line({ note: 'RSU withholding', basis: 'entered', wash_risk: true }))).toBe(
      'Basis entered on the sale; Recorded as shares withheld at a vest, but not at cost: shares withheld to pay the tax are not a sale, so check it; Possible wash sale: a buy within 30 days; check the 1099-B for code W',
    )
  })
})
