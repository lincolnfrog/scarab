import { describe, expect, it } from 'vitest'
import { parsePercentMicro, parseQtyMicro } from '../../shared/money'
import {
  formatMoneyField,
  formatPercentField,
  formatQtyField,
  parseMoneyField,
  parsePercentField,
  parseQtyField,
} from './fieldParse'

describe('parseMoneyField', () => {
  it('reads what people type into integer cents', () => {
    expect(parseMoneyField('1,234.56')).toEqual({ cents: 123456, error: null })
    expect(parseMoneyField('$1,234.5')).toEqual({ cents: 123450, error: null })
    expect(parseMoneyField('  42 ')).toEqual({ cents: 4200, error: null })
    expect(parseMoneyField('0.07')).toEqual({ cents: 7, error: null })
    expect(parseMoneyField('1234567.89')).toEqual({ cents: 123456789, error: null })
  })

  it('reads a trailing decimal point as the whole number (typing "12.5" passes through "12.")', () => {
    expect(parseMoneyField('12.')).toEqual({ cents: 1200, error: null })
    expect(parseMoneyField('$1,234.')).toEqual({ cents: 123400, error: null })
    expect(parsePercentField('6.')).toEqual({ micro: 60_000, error: null })
    expect(parsePercentField('6.%')).toEqual({ micro: 60_000, error: null })
    expect(parseQtyField('10.')).toEqual({ micro: 10_000_000, error: null })
    // Only a lone trailing point: anything else malformed stays an error.
    for (const bad of ['.', '1.2.', '12..', '1,0000.']) expect(parseMoneyField(bad).error, bad).not.toBeNull()
    expect(parseQtyField('0.').error).toBe('Enter a quantity above zero')
  })

  it('treats blank as empty, not as zero', () => {
    expect(parseMoneyField('')).toEqual({ cents: null, error: null })
    expect(parseMoneyField('   ')).toEqual({ cents: null, error: null })
  })

  it('refuses negatives unless the field allows them', () => {
    expect(parseMoneyField('-12')).toEqual({ cents: null, error: 'Enter a positive amount' })
    expect(parseMoneyField('(40.25)')).toEqual({ cents: null, error: 'Enter a positive amount' })
    expect(parseMoneyField('-12', { allowNegative: true })).toEqual({ cents: -1200, error: null })
    expect(parseMoneyField('(40.25)', { allowNegative: true })).toEqual({ cents: -4025, error: null })
  })

  it('never produces negative zero', () => {
    const r = parseMoneyField('-0', { allowNegative: true })
    expect(Object.is(r.cents, 0)).toBe(true)
    expect(Object.is(parseMoneyField('-0.00').cents, 0)).toBe(true)
  })

  it('explains what is wrong', () => {
    expect(parseMoneyField('12.345').error).toBe('Use at most 2 decimal places')
    expect(parseMoneyField('abc').error).toBe('Enter an amount like 1,234.56')
    expect(parseMoneyField('1,23').error).toBe('Enter an amount like 1,234.56')
    expect(parseMoneyField('12k').error).toBe('Enter an amount like 1,234.56')
    expect(parseMoneyField('99999999999999999').error).toBe('That amount is too large')
    for (const bad of ['12.345', 'abc', '1,23', '99999999999999999']) expect(parseMoneyField(bad).cents).toBeNull()
  })

  it('round-trips through the blur format', () => {
    for (const c of [0, 1, 99, 100, 123456, 100000000, -5, -123456]) {
      expect(parseMoneyField(formatMoneyField(c), { allowNegative: true }).cents).toBe(c)
    }
    expect(formatMoneyField(null)).toBe('')
    expect(formatMoneyField(123456)).toBe('1,234.56')
  })
})

describe('parsePercentField', () => {
  it('reads rates into micro (1e6 = 100%)', () => {
    expect(parsePercentField('6.375')).toEqual({ micro: 63_750, error: null })
    expect(parsePercentField('6.375%')).toEqual({ micro: 63_750, error: null })
    expect(parsePercentField('.5')).toEqual({ micro: 5_000, error: null })
    expect(parsePercentField('100')).toEqual({ micro: 1_000_000, error: null })
    expect(parsePercentField('0')).toEqual({ micro: 0, error: null })
  })

  it('treats blank as empty', () => {
    expect(parsePercentField(' ')).toEqual({ micro: null, error: null })
  })

  it('refuses negatives unless allowed', () => {
    expect(parsePercentField('-2.5')).toEqual({ micro: null, error: 'Enter a positive percentage' })
    expect(parsePercentField('-2.5', { allowNegative: true })).toEqual({ micro: -25_000, error: null })
  })

  it('explains what is wrong', () => {
    expect(parsePercentField('6.12345').error).toBe('Use at most 4 decimal places')
    expect(parsePercentField('six').error).toBe('Enter a percentage like 6.375')
    expect(parsePercentField('%').error).toBe('Enter a percentage like 6.375')
    expect(parsePercentField('-').micro).toBeNull()
  })

  it('shows stored rates exactly, and reads them back unchanged', () => {
    expect(formatPercentField(63_750)).toBe('6.375')
    expect(formatPercentField(1_000_000)).toBe('100')
    expect(formatPercentField(-25_000)).toBe('-2.5')
    expect(formatPercentField(1)).toBe('0.0001')
    expect(formatPercentField(0)).toBe('0')
    expect(formatPercentField(null)).toBe('')
    for (const m of [0, 1, 9_999, 63_750, 123_456, 1_000_000, 2_500_000, -1, -63_750]) {
      expect(parsePercentMicro(formatPercentField(m))).toBe(m)
      expect(parsePercentField(formatPercentField(m), { allowNegative: true }).micro).toBe(m)
    }
  })
})

describe('parseQtyField', () => {
  it('reads share quantities into micro-shares', () => {
    expect(parseQtyField('12')).toEqual({ micro: 12_000_000, error: null })
    expect(parseQtyField('0.5')).toEqual({ micro: 500_000, error: null })
    expect(parseQtyField('0.000001')).toEqual({ micro: 1, error: null })
    expect(parseQtyField('1,000.25')).toEqual({ micro: 1_000_250_000, error: null })
  })

  it('treats blank as empty', () => {
    expect(parseQtyField('')).toEqual({ micro: null, error: null })
  })

  it('explains what is wrong', () => {
    expect(parseQtyField('0').error).toBe('Enter a quantity above zero')
    expect(parseQtyField('0.000').error).toBe('Enter a quantity above zero')
    expect(parseQtyField('-3').error).toBe('Enter a quantity above zero')
    expect(parseQtyField('1.1234567').error).toBe('Use at most 6 decimal places')
    expect(parseQtyField('ten').error).toBe('Enter a number of shares like 12.5')
    expect(parseQtyField('99999999999').error).toBe('That quantity is too large')
    for (const bad of ['0', '-3', 'ten']) expect(parseQtyField(bad).micro).toBeNull()
  })

  it('round-trips through the blur format', () => {
    for (const m of [1, 500_000, 12_000_000, 1_000_250_000, 1_234_567_890_123]) {
      expect(parseQtyMicro(formatQtyField(m))).toBe(m)
      expect(parseQtyField(formatQtyField(m)).micro).toBe(m)
    }
    expect(formatQtyField(null)).toBe('')
  })
})
