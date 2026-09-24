import { describe, expect, it } from 'vitest'
import { DUR } from '../ui/motion'
import { COUNT_MS, countUpAt } from './countUp'

describe('countUpAt', () => {
  it('starts at from and lands exactly on to', () => {
    expect(countUpAt(0, 284_731_200, 0)).toBe(0)
    expect(countUpAt(0, 284_731_200, 1)).toBe(284_731_200)
    expect(countUpAt(0, 284_731_200, 1.7)).toBe(284_731_200)
    expect(countUpAt(0, 284_731_200, -0.2)).toBe(0)
  })
  it('eases out: past halfway by the first third, whole units, never overshooting', () => {
    const to = 284_731_200
    expect(countUpAt(0, to, 1 / 3)).toBeGreaterThan(to / 2)
    let prev = -1
    for (let k = 0; k <= 1; k += 0.05) {
      const v = countUpAt(0, to, k)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(prev)
      expect(v).toBeLessThanOrEqual(to)
      prev = v
    }
  })
  it('counts down toward a negative figure without passing it', () => {
    for (let k = 0; k < 1; k += 0.1) {
      const v = countUpAt(0, -12_345_67, k)
      expect(v).toBeLessThanOrEqual(0)
      expect(v).toBeGreaterThanOrEqual(-12_345_67)
    }
    expect(countUpAt(0, -12_345_67, 1)).toBe(-12_345_67)
  })
  it('shows the true figure for a NaN progress, and runs as long as the chart reveal', () => {
    expect(countUpAt(10, 20, Number.NaN)).toBe(20) // !(NaN < 1): the true figure, never a stuck frame
    expect(COUNT_MS).toBe(DUR[4])
  })
})
