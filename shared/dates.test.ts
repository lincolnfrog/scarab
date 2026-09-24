import { describe, expect, it } from 'vitest'
import { addDaysIso, addMonthsIso, addMonthsToMonth, anniversaryIso, isRealIsoDay, monthEndIso, monthsBetween, todayLocal } from './dates'

describe('isRealIsoDay', () => {
  it('takes real calendar days only, not just the shape', () => {
    for (const ok of ['2026-09-22', '2028-02-29', '2000-02-29', '2026-12-31', '2026-01-01']) expect(isRealIsoDay(ok)).toBe(true)
    for (const no of ['2025-00-15', '2025-13-01', '2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-09-00', '2026-9-22', '2026-09-22T00:00', '', null, undefined, 20260922])
      expect(isRealIsoDay(no)).toBe(false)
  })
})

describe('todayLocal', () => {
  it('reads the local calendar day, not the UTC one', () => {
    // Built from local parts, so whatever zone the suite runs in, 11pm on the
    // 22nd is still the 22nd — toISOString() would say the 23rd west of UTC.
    expect(todayLocal(new Date(2026, 8, 22, 23, 30))).toBe('2026-09-22')
    expect(todayLocal(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01')
  })
})

describe('addDaysIso', () => {
  it('crosses month, leap-day and year boundaries', () => {
    expect(addDaysIso('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDaysIso('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDaysIso('2026-01-01', 365)).toBe('2027-01-01')
    expect(addDaysIso('2026-09-22', 0)).toBe('2026-09-22')
  })
  it('refuses fractional days and malformed dates', () => {
    expect(() => addDaysIso('2026-01-01', 1.5)).toThrow()
    expect(() => addDaysIso('Sept 22', 1)).toThrow()
  })
})

describe('addMonthsIso', () => {
  it('clamps the day to the end of the target month', () => {
    expect(addMonthsIso('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsIso('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonthsIso('2026-03-31', 1)).toBe('2026-04-30')
    expect(addMonthsIso('2026-11-15', 3)).toBe('2027-02-15')
  })
  it('goes backwards across a year boundary', () => {
    expect(addMonthsIso('2026-03-31', -1)).toBe('2026-02-28')
    expect(addMonthsIso('2026-01-15', -1)).toBe('2025-12-15')
    expect(addMonthsIso('2026-01-15', -25)).toBe('2023-12-15')
  })
  it('matches the Date-based implementation it replaced, day for day', () => {
    const legacy = (iso: string, months: number) => {
      const [y, m, d] = iso.split('-').map(Number) as [number, number, number]
      const t = new Date(Date.UTC(y, m - 1 + months, 1))
      const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate()
      t.setUTCDate(Math.min(d, last))
      return t.toISOString().slice(0, 10)
    }
    for (let day = 0; day < 4 * 366; day += 3) {
      const iso = addDaysIso('2027-01-01', day)
      for (const n of [-13, -1, 0, 1, 2, 6, 12, 24]) expect(addMonthsIso(iso, n), `${iso} ${n}`).toBe(legacy(iso, n))
    }
  })
})

describe('anniversaryIso', () => {
  it('is one calendar year on; Feb 29 lands on Feb 28', () => {
    expect(anniversaryIso('2024-02-05')).toBe('2025-02-05')
    expect(anniversaryIso('2024-02-29')).toBe('2025-02-28')
    expect(anniversaryIso('2027-02-28')).toBe('2028-02-28')
  })
})

describe('month helpers', () => {
  it('monthEndIso knows month lengths and leap years', () => {
    expect(monthEndIso('2026-02')).toBe('2026-02-28')
    expect(monthEndIso('2028-02')).toBe('2028-02-29')
    expect(monthEndIso('2100-02')).toBe('2100-02-28')
    expect(monthEndIso('2000-02')).toBe('2000-02-29')
    expect(monthEndIso('2026-04')).toBe('2026-04-30')
    expect(monthEndIso('2026-12')).toBe('2026-12-31')
  })
  it('monthsBetween is inclusive and empty when reversed', () => {
    expect(monthsBetween('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02'])
    expect(monthsBetween('2026-02', '2026-02')).toEqual(['2026-02'])
    expect(monthsBetween('2026-03', '2026-02')).toEqual([])
  })
  it('addMonthsToMonth wraps years in both directions', () => {
    expect(addMonthsToMonth('2026-11', 3)).toBe('2027-02')
    expect(addMonthsToMonth('2026-01', -1)).toBe('2025-12')
    expect(addMonthsToMonth('2026-12', 12)).toBe('2027-12')
    expect(addMonthsToMonth('2026-06', 0)).toBe('2026-06')
  })
  it('refuses malformed months', () => {
    for (const bad of ['2026-13', '2026-00', '2026-1', '202601', '2026-01-01'])
      expect(() => monthEndIso(bad), bad).toThrow()
    expect(() => addMonthsToMonth('2026-01', 0.5)).toThrow()
  })
})
