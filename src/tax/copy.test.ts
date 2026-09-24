import { describe, expect, it } from 'vitest'
import { gapLine, scheduleNote } from './copy'

describe('gapLine', () => {
  it('says neither owed nor over-withheld when there is no gap (F32)', () => {
    expect(gapLine(0)).toEqual({ tone: 'muted', text: 'On track — nothing more to pay, nothing over-withheld' })
    expect(gapLine(-0).tone).toBe('muted')
  })
  it('keeps the owed and over-withheld wording, in the loss and gain colours', () => {
    expect(gapLine(1_234_00)).toEqual({ tone: 'neg', text: "▲ $1,234.00 more than you're on track to pay" })
    expect(gapLine(-500_00)).toEqual({ tone: 'pos', text: '▼ $500.00 over-withheld so far' })
  })
})

describe('scheduleNote', () => {
  it('describes an even federal split instead of leaving the rule dangling', () => {
    expect(scheduleNote('Federal (Form 1040-ES)', [25, 25, 25, 25])).toBe('Federal (Form 1040-ES) — four equal installments.')
  })
  it('names the weights when the installments differ', () => {
    expect(scheduleNote('California (Form 540-ES)', [30, 40, 0, 30])).toBe('California (Form 540-ES) — installments weighted 30/40/0/30.')
  })
})
