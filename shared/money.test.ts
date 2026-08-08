import { describe, expect, it } from 'vitest'
import { formatCents, parseMoney } from './money'

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
