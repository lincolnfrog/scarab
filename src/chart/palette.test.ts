import { describe, expect, it } from 'vitest'
import {
  CONTEXT_VAR,
  DOWN_VAR,
  GOAL_VAR,
  MARK_VAR,
  pinSlots,
  scenarioSlots,
  signColor,
  SLOT_VAR,
  slotAt,
  slotColor,
  slotTint,
  UP_VAR,
} from './palette'

describe('palette', () => {
  it('names the six series tokens, never a hex', () => {
    expect(Object.values(SLOT_VAR)).toEqual(['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)'])
    expect(slotColor(4)).toBe('var(--s4)')
    expect(slotColor(null)).toBe(CONTEXT_VAR)
  })

  it('tints by color-mix against transparent, clamped to 0–100%', () => {
    expect(slotTint(2, 16)).toBe('color-mix(in srgb, var(--s2) 16%, transparent)')
    expect(slotTint(null, 32)).toBe('color-mix(in srgb, var(--ink-3) 32%, transparent)')
    expect(slotTint(1, 140)).toBe('color-mix(in srgb, var(--s1) 100%, transparent)')
    expect(slotTint(1, -5)).toBe('color-mix(in srgb, var(--s1) 0%, transparent)')
  })

  it('gives the baseline s1 wherever it sits, the rest s2… by id', () => {
    const slots = scenarioSlots([{ id: 7 }, { id: 3 }, { id: 5 }], 5)
    expect(slots.get(5)).toBe(1)
    expect(slots.get(3)).toBe(2)
    expect(slots.get(7)).toBe(3)
  })

  it('colours by id, not list position', () => {
    const a = scenarioSlots([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }], 1)
    const reordered = scenarioSlots([{ id: 4 }, { id: 2 }, { id: 1 }, { id: 3 }], 1)
    expect([...reordered.entries()].sort()).toEqual([...a.entries()].sort())
    // deleting 3 leaves the older scenarios alone; only 4, created after it, moves up
    const deleted = scenarioSlots([{ id: 4 }, { id: 1 }, { id: 2 }], 1)
    expect(deleted.get(1)).toBe(1)
    expect(deleted.get(2)).toBe(a.get(2))
    expect(deleted.get(4)).toBe(3)
  })

  it('drops a seventh scenario to a context line instead of cycling', () => {
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id }))
    const slots = scenarioSlots(runs, 1)
    expect([...slots.values()]).toEqual([1, 2, 3, 4, 5, 6, null, null])
    expect(slots.get(7)).toBeNull()
  })

  it('ignores duplicate ids and a baseline that is not in the list', () => {
    const slots = scenarioSlots([{ id: 2 }, { id: 2 }, { id: 9 }], 1)
    expect(slots.has(1)).toBe(false)
    expect(slots.get(2)).toBe(2)
    expect(slots.get(9)).toBe(3)
    expect(slots.size).toBe(2)
  })
})

describe('palette extensions', () => {
  it('names the non-series colours as tokens', () => {
    expect([GOAL_VAR, UP_VAR, DOWN_VAR, MARK_VAR]).toEqual(['var(--gold)', 'var(--up)', 'var(--down)', 'var(--ink-2)'])
    expect(signColor(5)).toBe(UP_VAR)
    expect(signColor(-1)).toBe(DOWN_VAR)
    expect(signColor(0)).toBe(MARK_VAR)
  })

  it('slots the i-th series s1…s6, then a context line', () => {
    expect([0, 1, 5, 6, -1, 1.5].map(slotAt)).toEqual([1, 2, 6, null, null, null])
  })

  it('pins a slot to each id and hands new ids the lowest free one', () => {
    const a = pinSlots(['nw:total', 'nw:cash'], new Map())
    expect([...a]).toEqual([
      ['nw:total', 1],
      ['nw:cash', 2],
    ])
    // cash hidden then a new series added: cash keeps s2, the new one takes s3
    const b = pinSlots(['nw:total', 'bench:SPY'], a)
    expect(b.get('nw:cash')).toBe(2)
    expect(b.get('bench:SPY')).toBe(3)
    // releasing frees s2 for the next newcomer
    const c = pinSlots(['nw:total', 'bench:SPY', 'px:1'], b, { release: true })
    expect(c.has('nw:cash')).toBe(false)
    expect(c.get('px:1')).toBe(2)
  })

  it('leaves a seventh id unpinned (null → context line) instead of cycling', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const m = pinSlots(ids, new Map())
    expect(m.size).toBe(6)
    expect(m.get('g')).toBeUndefined()
    expect(new Set(m.values()).size).toBe(6)
  })

  it('gives a removed-then-re-added id its remembered slot when that slot is free', () => {
    const remember = new Map<string, 1 | 2 | 3 | 4 | 5 | 6>([
      ['nw:cash', 2],
      ['bench:SPY', 4],
    ])
    // nw:cash comes back while s2 is free → s2 again
    const a = pinSlots(['nw:total', 'px:1', 'nw:cash'], new Map([['nw:total', 1], ['px:1', 3]]), { release: true, remember })
    expect(a.get('nw:cash')).toBe(2)
    // SPY remembers s4: it skips the free s2 and takes s4 back
    const b = pinSlots(['nw:total', 'bench:SPY'], new Map([['nw:total', 1]]), { release: true, remember })
    expect(b.get('bench:SPY')).toBe(4)
    // …unless s4 is taken now, then the lowest free slot
    const c = pinSlots(['x', 'bench:SPY'], new Map([['x', 4]]), { release: true, remember })
    expect(c.get('bench:SPY')).toBe(1)
  })
})
