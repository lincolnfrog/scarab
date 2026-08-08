import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha1Hex } from './hash'

describe('sha1Hex', () => {
  it('matches node:crypto on known and random inputs', () => {
    const cases = [
      '',
      'abc',
      'The quick brown fox jumps over the lazy dog',
      '2026-08-01|-341800|MR. COOPER MORTGAGE PYMT',
      'x'.repeat(55), // padding boundary
      'y'.repeat(56),
      'z'.repeat(64),
      'unicode: émojis 🪲 and ünïcödé',
    ]
    for (let i = 0; i < 50; i++) cases.push(`random-${i}-${Math.sin(i)}`.repeat((i % 7) + 1))
    for (const c of cases) {
      expect(sha1Hex(c)).toBe(createHash('sha1').update(c).digest('hex'))
    }
  })
})
