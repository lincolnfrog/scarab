import { describe, expect, it } from 'vitest'
import {
  formatCents,
  formatCentsPlain,
  formatDollars,
  formatPercentMicro,
  formatQtyMicro,
  parseMoney,
  parsePercentMicro,
  parseQtyMicro,
} from './money'

describe('formatCents', () => {
  it('formats dollars and cents', () => {
    expect(formatCents(123456)).toBe('$1,234.56')
    expect(formatCents(5)).toBe('$0.05')
    expect(formatCents(0)).toBe('$0.00')
  })
  it('formats negatives and explicit signs', () => {
    expect(formatCents(-123456)).toBe('-$1,234.56')
    expect(formatCents(123456, { sign: true })).toBe('+$1,234.56')
  })
  it('rejects non-integers', () => {
    expect(() => formatCents(12.5)).toThrow()
  })
})

describe('parseMoney', () => {
  it('parses plain and formatted values', () => {
    expect(parseMoney('1234.56')).toBe(123456)
    expect(parseMoney('$1,234.56')).toBe(123456)
    expect(parseMoney(' -$12 ')).toBe(-1200)
    expect(parseMoney('12.5')).toBe(1250)
    expect(parseMoney('0')).toBe(0)
  })
  it('round-trips with formatCents', () => {
    for (const cents of [0, 1, 99, 100, -123456, 300000000]) {
      expect(parseMoney(formatCents(cents))).toBe(cents)
    }
  })
  it('rejects garbage and sub-cent precision', () => {
    for (const bad of ['abc', '1.234', '12.', '1,2,3', '']) {
      expect(() => parseMoney(bad), bad).toThrow()
    }
  })
})

describe('formatDollars', () => {
  it('rounds to whole dollars, half away from zero', () => {
    expect(formatDollars(123456)).toBe('$1,235')
    expect(formatDollars(123449)).toBe('$1,234')
    expect(formatDollars(50)).toBe('$1')
    expect(formatDollars(49)).toBe('$0')
    expect(formatDollars(-150)).toBe('-$2')
    expect(formatDollars(-149)).toBe('-$1')
    expect(formatDollars(300_000_000)).toBe('$3,000,000')
  })
  it('never prints a negative zero, and signs on request', () => {
    expect(formatDollars(-49)).toBe('$0')
    expect(formatDollars(0)).toBe('$0')
    expect(formatDollars(2_500, { sign: true })).toBe('+$25')
    expect(formatDollars(-2_500, { sign: true })).toBe('-$25')
  })
  it('stays exact at the edge of safe integers', () => {
    expect(formatDollars(Number.MAX_SAFE_INTEGER)).toBe('$90,071,992,547,410')
    expect(() => formatDollars(1.5)).toThrow()
  })
})

describe('formatCentsPlain', () => {
  it('drops the dollar sign and round-trips through parseMoney', () => {
    expect(formatCentsPlain(123456)).toBe('1,234.56')
    expect(formatCentsPlain(-1200)).toBe('-12.00')
    for (const cents of [0, 1, 99, -123456, 300_000_000]) expect(parseMoney(formatCentsPlain(cents))).toBe(cents)
  })
})

describe('parsePercentMicro', () => {
  it('reads what people type as integer micro (1e6 = 100%)', () => {
    expect(parsePercentMicro('6.375')).toBe(63_750)
    expect(parsePercentMicro('6.375%')).toBe(63_750)
    expect(parsePercentMicro(' 6.375 % ')).toBe(63_750)
    expect(parsePercentMicro('100')).toBe(1_000_000)
    expect(parsePercentMicro('.5')).toBe(5_000)
    expect(parsePercentMicro('0.0001')).toBe(1)
    expect(parsePercentMicro('-2.5')).toBe(-25_000)
    expect(parsePercentMicro('+7')).toBe(70_000)
    expect(Object.is(parsePercentMicro('-0'), 0)).toBe(true)
  })
  it('stays exact where float math would not', () => {
    // 0.07 * 10_000 is 700.0000000000001 in floating point.
    expect(parsePercentMicro('0.07')).toBe(700)
    expect(parsePercentMicro('4.35')).toBe(43_500)
  })
  it('rejects garbage and sub-micro precision', () => {
    for (const bad of ['', '%', '-', 'abc', '6.', '6.37501', '1,000', '6%%', '6 . 5', '5-'])
      expect(() => parsePercentMicro(bad), bad).toThrow()
  })
})

describe('formatPercentMicro', () => {
  it('formats with fixed decimals, half away from zero', () => {
    expect(formatPercentMicro(63_750)).toBe('6.38%')
    expect(formatPercentMicro(63_749)).toBe('6.37%')
    expect(formatPercentMicro(-63_750)).toBe('-6.38%')
    expect(formatPercentMicro(1_000_000)).toBe('100.00%')
    expect(formatPercentMicro(63_750, 0)).toBe('6%')
    expect(formatPercentMicro(65_000, 0)).toBe('7%')
    expect(formatPercentMicro(63_750, 3)).toBe('6.375%')
    expect(formatPercentMicro(1, 4)).toBe('0.0001%')
    expect(formatPercentMicro(1_234_567_890, 1)).toBe('123,456.8%')
  })
  it('never prints a negative zero', () => {
    expect(formatPercentMicro(-49)).toBe('0.00%')
    expect(formatPercentMicro(0)).toBe('0.00%')
  })
  it('round-trips with parsePercentMicro at four decimals', () => {
    for (const micro of [0, 1, 63_750, -25_000, 1_000_000]) expect(parsePercentMicro(formatPercentMicro(micro, 4))).toBe(micro)
  })
  it('rejects non-integers and out-of-range digits', () => {
    expect(() => formatPercentMicro(0.5)).toThrow()
    expect(() => formatPercentMicro(1, 5)).toThrow()
    expect(() => formatPercentMicro(1, -1)).toThrow()
  })
})

describe('parseQtyMicro', () => {
  it('parses whole and fractional shares to micro-shares', () => {
    expect(parseQtyMicro('10')).toBe(10_000_000)
    expect(parseQtyMicro('0.123456')).toBe(123_456)
    expect(parseQtyMicro(' 2.5 ')).toBe(2_500_000)
  })
  it('accepts correctly placed thousands commas', () => {
    expect(parseQtyMicro('1,000.5')).toBe(1_000_500_000)
    expect(parseQtyMicro('1,000')).toBe(1_000_000_000)
    expect(parseQtyMicro('12,345,678')).toBe(12_345_678_000_000)
    expect(parseQtyMicro(formatQtyMicro(1_234_567_891))).toBe(1_234_567_891)
  })
  it('rejects misplaced commas, a seventh decimal and non-positive quantities', () => {
    for (const bad of ['1,00', '10,00.5', ',100', '1,000,', '1.0000001', '0', '-1', '', 'abc'])
      expect(() => parseQtyMicro(bad), bad).toThrow()
  })
})
