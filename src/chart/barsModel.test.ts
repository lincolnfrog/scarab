import { describe, expect, it } from 'vitest'
import { DUR } from '../ui/motion'
import { budgetLeft, bulletLayout, daysInMonth, GROW_STAGGER_MS, growIndex, growMs, navStep, orderBullets, paceCents, shareText } from './barsModel'

describe('daysInMonth', () => {
  it('knows month lengths, leap years included', () => {
    expect(daysInMonth('2026-09')).toBe(30)
    expect(daysInMonth('2026-12')).toBe(31)
    expect(daysInMonth('2026-02')).toBe(28)
    expect(daysInMonth('2028-02')).toBe(29)
    expect(daysInMonth('2100-02')).toBe(28)
  })
  it('is 0 for anything that is not a month', () => {
    expect(daysInMonth('2026-13')).toBe(0)
    expect(daysInMonth('2026-00')).toBe(0)
    expect(daysInMonth('2026-9')).toBe(0)
    expect(daysInMonth('')).toBe(0)
  })
})

describe('paceCents: the budget spent evenly through the month so far', () => {
  it('is budget × day ÷ days-in-month, rounded to a cent', () => {
    expect(paceCents(64_000, '2026-09', '2026-09-23')).toBe(49_067) // 64,000 × 23 / 30 = 49,066.67
    expect(paceCents(30_000, '2026-09', '2026-09-15')).toBe(15_000)
    expect(paceCents(31_00, '2026-08', '2026-08-31')).toBe(31_00) // the last day is the whole budget
    expect(paceCents(10_000, '2028-02', '2028-02-29')).toBe(10_000)
  })
  it('stays exact integer cents for a large budget', () => {
    const p = paceCents(1_234_567_89, '2026-09', '2026-09-07')!
    expect(Number.isInteger(p)).toBe(true)
    expect(p).toBe(Math.round((1_234_567_89 * 7) / 30))
  })
  it('only exists for the month today is in, with a budget', () => {
    expect(paceCents(64_000, '2026-08', '2026-09-23')).toBeNull() // a past month
    expect(paceCents(64_000, '2026-10', '2026-09-23')).toBeNull() // a future month
    expect(paceCents(0, '2026-09', '2026-09-23')).toBeNull()
    expect(paceCents(-5, '2026-09', '2026-09-23')).toBeNull()
    expect(paceCents(12.5, '2026-09', '2026-09-23')).toBeNull() // floats never touch money
    expect(paceCents(64_000, '2026-09', '2026-09')).toBeNull() // no day
  })
})

describe('shareText', () => {
  it('is a whole percent of the total, half up', () => {
    expect(shareText(34_00, 100_00)).toBe('34%')
    expect(shareText(1, 3)).toBe('33%')
    expect(shareText(2, 3)).toBe('67%')
    expect(shareText(100, 100)).toBe('100%')
  })
  it('never prints a false 0% for a sliver', () => {
    expect(shareText(1, 1_000)).toBe('<1%')
  })
  it('is 0% for nothing, a refund, or no total', () => {
    expect(shareText(0, 100)).toBe('0%')
    expect(shareText(-40, 100)).toBe('0%')
    expect(shareText(40, 0)).toBe('0%')
  })
})

describe('Bullets rows', () => {
  const rows = [
    { name: 'Transportation', actual: 199_00, budget: 0 },
    { name: 'Housing', actual: 0, budget: 640_00 },
    { name: 'Groceries', actual: 93_00, budget: 0 },
    { name: 'Dining', actual: 120_00, budget: 100_00 },
  ]
  it('puts budgeted rows first and keeps each group in the caller order', () => {
    expect(orderBullets(rows).map((r) => r.name)).toEqual(['Housing', 'Dining', 'Transportation', 'Groceries'])
  })
  it('lays out a "No budget" caption before the first unbudgeted row', () => {
    const l = bulletLayout(rows, 34, 22)
    expect(l.rows.map((r) => [r.row.name, r.y])).toEqual([
      ['Housing', 0],
      ['Dining', 34],
      ['Transportation', 90],
      ['Groceries', 124],
    ])
    expect(l.captionY).toBe(68)
    expect(l.height).toBe(158)
  })
  it('has no caption when every row is budgeted, or none is', () => {
    expect(bulletLayout(rows.filter((r) => r.budget > 0), 34, 22)).toMatchObject({ captionY: null, height: 68 })
    expect(bulletLayout(rows.filter((r) => r.budget === 0), 34, 22)).toMatchObject({ captionY: null, height: 68 })
    expect(bulletLayout([], 34, 22)).toEqual({ rows: [], captionY: null, height: 0 })
  })
  it('says what is left of a budget, or how far over it is', () => {
    expect(budgetLeft(93_00, 640_00)).toEqual({ left: 547_00 })
    expect(budgetLeft(640_00, 640_00)).toEqual({ left: 0 })
    expect(budgetLeft(120_00, 100_00)).toEqual({ over: 20_00 })
    expect(budgetLeft(120_00, 0)).toBeNull()
    expect(budgetLeft(1.5, 100)).toBeNull()
  })
})

describe('navStep: arrows through the marks, one tab stop', () => {
  it('steps back and forward, clamped at the ends', () => {
    expect(navStep('ArrowRight', 3, 12)).toBe(4)
    expect(navStep('ArrowDown', 3, 12)).toBe(4)
    expect(navStep('ArrowLeft', 3, 12)).toBe(2)
    expect(navStep('ArrowUp', 3, 12)).toBe(2)
    expect(navStep('ArrowLeft', 0, 12)).toBe(0)
    expect(navStep('ArrowRight', 11, 12)).toBe(11)
  })
  it('jumps to the ends with Home and End', () => {
    expect(navStep('Home', 7, 12)).toBe(0)
    expect(navStep('End', 2, 12)).toBe(11)
    expect(navStep('End', null, 12)).toBe(11)
  })
  it('lands on the start mark when nothing is highlighted yet', () => {
    expect(navStep('ArrowLeft', null, 12, 11)).toBe(11)
    expect(navStep('ArrowRight', null, 12, 5)).toBe(5)
    expect(navStep('ArrowRight', null, 3, 9)).toBe(2) // a stale start is clamped
  })
  it('ignores other keys and empty charts', () => {
    expect(navStep('Enter', 2, 12)).toBeUndefined()
    expect(navStep('a', 2, 12)).toBeUndefined()
    expect(navStep('ArrowRight', null, 0)).toBeUndefined()
  })
})

describe('first-reveal grow timing', () => {
  it('lasts the reveal plus the stagger, then a little slack', () => {
    expect(growMs(1)).toBe(DUR[4] + 120)
    expect(growMs(12)).toBe(DUR[4] + 11 * GROW_STAGGER_MS + 120)
    expect(GROW_STAGGER_MS).toBe(18)
  })
  it('caps the stagger so a long list never keeps the class for seconds', () => {
    expect(growMs(500)).toBe(growMs(41))
    expect(growIndex(500)).toBe(40)
    expect(growIndex(-3)).toBe(0)
    expect(growMs(0)).toBe(DUR[4] + 120)
  })
})
