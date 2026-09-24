import { describe, expect, it } from 'vitest'
import { isoFromAny, parsePositions } from './positions-paste'

const M = 1_000_000

describe('isoFromAny', () => {
  it.each([
    ['2019-03-15', '2019-03-15'],
    ['2019/3/5', '2019-03-05'],
    ['20190315', '2019-03-15'],
    ['3/15/2019', '2019-03-15'],
    ['03/15/19', '2019-03-15'],
    ['3-15-2019', '2019-03-15'],
    ['12/31/99', '1999-12-31'],
    ['Mar 15, 2019', '2019-03-15'],
    ['March 15 2019', '2019-03-15'],
    ['Sept. 5, 2019', '2019-09-05'],
    ['15 Mar 2019', '2019-03-15'],
    ['15-Mar-19', '2019-03-15'],
    ['2019-03-15T00:00:00Z', '2019-03-15'],
    ['3/15/2019 4:00 PM', '2019-03-15'],
    ['2/29/2020', '2020-02-29'],
  ])('%s → %s', (input, iso) => expect(isoFromAny(input)).toBe(iso))

  it.each(['2/29/2021', '2019-02-30', '13/01/2019', '2019-13-01', 'Various', '', 'Jnu 5, 2019', 'Ma 5, 2019', '100', '15.5'])(
    'refuses %j',
    (input) => expect(isoFromAny(input)).toBeNull(),
  )
})

describe('parsePositions', () => {
  it('reads a spreadsheet copy: tabs, a header in its own order, $ and thousands commas', () => {
    const text = [
      'Symbol\tDescription\tQuantity\tPrice\tCost Basis\tDate Acquired',
      'VTI\tVanguard Total Stock\t120\t$290.10\t$18,400.00\t03/15/2019',
      'aapl\tApple Inc\t40.5\t$228.00\t$5,200.50\t2021-06-02',
      'Account Total\t\t\t\t$23,600.50\t',
    ].join('\n')
    const r = parsePositions(text)
    expect(r.delimiter).toBe('tab')
    expect(r.header).toBe(true)
    expect(r.columns).toEqual({ symbol: 0, shares: 2, basis: 4, acquired: 5 })
    expect(r.errors).toEqual([])
    expect(r.rows).toEqual([
      { line: 2, symbol: 'VTI', qtyMicro: 120 * M, basisCents: 18_400_00, acquiredOn: '2019-03-15' },
      { line: 3, symbol: 'AAPL', qtyMicro: 40_500_000, basisCents: 5_200_50, acquiredOn: '2021-06-02' },
    ])
    expect(r.skipped).toEqual([{ line: 4, message: 'not a holding (a total or cash line)' }])
  })

  it('reads a CSV with quoted money, in the fixed order with no header', () => {
    const r = parsePositions('VTI,120,"$18,400.00",3/15/2019\r\nBTC,0.5,"$10,000",2020-01-02\r\n')
    expect(r.delimiter).toBe('comma')
    expect(r.header).toBe(false)
    expect(r.rows.map((x) => [x.symbol, x.qtyMicro, x.basisCents, x.acquiredOn])).toEqual([
      ['VTI', 120 * M, 18_400_00, '2019-03-15'],
      ['BTC', 500_000, 10_000_00, '2020-01-02'],
    ])
  })

  it('reads typed rows separated by spaces, even with unquoted thousands commas', () => {
    const r = parsePositions('VTI 120 $18,400.00 2019-03-15\nQQQ 10 4000\n\n# a comment line\nVXUS 1,000 $55,000 Mar-2019')
    expect(r.delimiter).toBe('space')
    expect(r.rows.map((x) => [x.line, x.symbol, x.qtyMicro, x.basisCents, x.acquiredOn])).toEqual([
      [1, 'VTI', 120 * M, 18_400_00, '2019-03-15'],
      [2, 'QQQ', 10 * M, 4_000_00, null],
    ])
    // Line numbers point at the pasted text, blank and comment lines included.
    expect(r.errors).toEqual([{ line: 5, message: 'VXUS: acquired “Mar-2019” isn\'t a date (2019-03-15 or 3/15/2019)' }])
  })

  it('has no acquired column when no row has a fourth cell', () => {
    const r = parsePositions('VTI\t120\t18400\nQQQ\t10\t4000')
    expect(r.columns.acquired).toBeNull()
    expect(r.rows.every((x) => x.acquiredOn === null)).toBe(true)
    expect(r.errors).toEqual([])
  })

  it('sniffs columns from their content when neither a header nor the fixed order fits', () => {
    // Acquired, symbol, basis ($), shares (6 decimals) — no header.
    const r = parsePositions('2019-03-15\tVTI\t$18,400.00\t120.000000\n2021-06-02\tAAPL\t$5,200.50\t40.500000')
    expect(r.header).toBe(false)
    expect(r.columns).toEqual({ symbol: 1, shares: 3, basis: 2, acquired: 0 })
    expect(r.rows.map((x) => [x.symbol, x.qtyMicro, x.basisCents, x.acquiredOn])).toEqual([
      ['VTI', 120 * M, 18_400_00, '2019-03-15'],
      ['AAPL', 40_500_000, 5_200_50, '2021-06-02'],
    ])
  })

  it('maps loose header names but never a per-share cost column as the basis', () => {
    const r = parsePositions('Ticker,Shares Held,Cost/Share,Total Cost,Open Date\nVTI,10,$150.00,"$1,500.00",1/2/2020')
    expect(r.columns).toEqual({ symbol: 0, shares: 1, basis: 3, acquired: 4 })
    expect(r.rows[0]).toMatchObject({ symbol: 'VTI', qtyMicro: 10 * M, basisCents: 1_500_00, acquiredOn: '2020-01-02' })
  })

  it('reports every unreadable line, and treats "Various" or a dash as no date', () => {
    const r = parsePositions(
      ['VTI\t-5\t100\t2020-01-02', 'QQQ\tten\t100\t2020-01-02', 'IWM\t5\t(100.00)\t2020-01-02', 'EFA\t5\t12.345\t2020-01-02', 'SPY\t5\t$500\tVarious', 'DIA\t5\t$500\t--', '12345\t5\t500\t2020-01-02', '\t5\t500\t2020-01-02', 'GLD\t5\t\t2020-01-02'].join('\n'),
    )
    expect(r.rows.map((x) => [x.symbol, x.acquiredOn])).toEqual([
      ['SPY', null],
      ['DIA', null],
    ])
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3, 4, 7, 8, 9])
    expect(r.errors[0]!.message).toMatch(/VTI: shares “-5”/)
    expect(r.errors[2]!.message).toMatch(/can't be negative/)
    expect(r.errors[3]!.message).toMatch(/isn't dollars and cents/)
    expect(r.errors[4]!.message).toMatch(/doesn't look like a ticker/)
    expect(r.errors[5]!.message).toBe('no symbol')
    expect(r.errors[6]!.message).toMatch(/no cost basis/)
  })

  it('keeps an all-caps CASH ticker but skips a cash sweep line', () => {
    const r = parsePositions('CASH\t10\t$400\t2020-01-02\nCash & Cash Investments\t\t$1,234.00\t')
    expect(r.rows.map((x) => x.symbol)).toEqual(['CASH'])
    expect(r.skipped.map((x) => x.line)).toEqual([2])
  })

  it('reads nothing from nothing', () => {
    expect(parsePositions('  \n\n')).toMatchObject({ rows: [], errors: [], skipped: [] })
  })
})
