import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assumptionPills, compareKey, createFlushable, createLatest, dataVersionOf, editGeneration, parseThreshold, saveStatus } from './future-sync'

describe('createLatest', () => {
  it('only the newest request may land', () => {
    const l = createLatest()
    const a = l.next()
    const b = l.next()
    expect(l.isCurrent(a)).toBe(false)
    expect(l.isCurrent(b)).toBe(true)
    l.cancel()
    expect(l.isCurrent(b)).toBe(false)
  })

  it('drops a slow reply that arrives after a newer one (out-of-order settle)', async () => {
    const l = createLatest()
    const shown: string[] = []
    const request = async (label: string, ms: number) => {
      const tag = l.next()
      await new Promise((r) => setTimeout(r, ms))
      if (l.isCurrent(tag)) shown.push(label)
    }
    await Promise.all([request('threshold 90 (slow)', 20), request('threshold 95', 1)])
    expect(shown).toEqual(['threshold 95'])
  })
})

describe('editGeneration', () => {
  it('keystrokes typed while a save is in flight keep the form dirty', () => {
    const e = editGeneration()
    const g1 = e.edit() // debounce fires: the save carries g1
    expect(e.dirty).toBe(true)
    e.edit() // typed while the PUT is out
    e.ack(g1) // the PUT lands
    expect(e.dirty).toBe(true) // the newer keystroke is not reverted by a resync
    expect(saveStatus(e.snapshot())).toBe('saving')
    e.ack(e.snapshot().gen)
    expect(e.dirty).toBe(false)
    expect(saveStatus(e.snapshot())).toBe('saved')
  })

  it('an out-of-order older ack never makes it dirty again', () => {
    const e = editGeneration()
    const g1 = e.edit()
    const g2 = e.edit()
    e.ack(g2)
    e.ack(g1)
    expect(e.snapshot()).toEqual({ gen: 2, acked: 2, failed: null })
  })

  it('a failed save shows until the next edit, and only for the newest generation', () => {
    const e = editGeneration()
    const g1 = e.edit()
    e.fail(g1)
    expect(saveStatus(e.snapshot())).toBe('failed')
    e.edit() // "edit again to retry"
    expect(saveStatus(e.snapshot())).toBe('saving')
    const g3 = e.edit()
    e.fail(g1) // a stale failure is ignored
    expect(e.snapshot().failed).toBeNull()
    e.fail(g3)
    e.ack(g3) // e.g. a retry of the same values landed
    expect(saveStatus(e.snapshot())).toBe('saved')
  })

  it('discard sets edits aside (switching scenarios after the flush, or deleting one)', () => {
    const e = editGeneration()
    const g = e.edit()
    e.discard()
    expect(e.dirty).toBe(false)
    e.ack(g) // the flushed save landing later changes nothing
    e.fail(g)
    expect(e.snapshot()).toEqual({ gen: 1, acked: 1, failed: null })
  })

  it('ack never runs past the newest edit', () => {
    const e = editGeneration()
    e.edit()
    e.ack(99)
    expect(e.snapshot().acked).toBe(1)
    e.edit()
    expect(e.dirty).toBe(true)
  })

  it('notifies subscribers on change only, with a new snapshot identity', () => {
    const e = editGeneration()
    const seen: unknown[] = []
    const off = e.subscribe(() => seen.push(e.snapshot()))
    e.discard() // already clean: no change
    const g = e.edit()
    e.ack(g)
    e.ack(g) // no change
    off()
    e.edit()
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('createFlushable', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the latest scheduled call once, after the pause', () => {
    const d = createFlushable(500)
    const f = vi.fn()
    d.schedule(() => f('a'))
    vi.advanceTimersByTime(300)
    d.schedule(() => f('b'))
    vi.advanceTimersByTime(499)
    expect(f).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f).toHaveBeenCalledWith('b')
    expect(d.pending).toBe(false)
  })

  it('flush runs the waiting call now — what a keep-alive cleanup does — and only once', () => {
    const d = createFlushable(500)
    const f = vi.fn()
    d.schedule(f)
    expect(d.pending).toBe(true)
    d.flush()
    expect(f).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    d.flush()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('cancel drops the waiting call', () => {
    const d = createFlushable(400)
    const f = vi.fn()
    d.schedule(f)
    d.cancel()
    vi.advanceTimersByTime(1000)
    d.flush()
    expect(f).not.toHaveBeenCalled()
  })
})

describe('parseThreshold', () => {
  it.each([
    ['90', 90],
    ['95%', 95],
    [' 50 ', 50],
    ['99 %', 99],
  ])('reads %j as %d', (t, n) => {
    expect(parseThreshold(t)).toBe(n)
  })

  it.each(['', ' ', '9', '5', '100', '49', '0', '90.5', 'abc', '-90', '9O'])('never turns %j into a threshold (no more "" → 50%%)', (t) => {
    expect(parseThreshold(t)).toBeNull()
  })
})

describe('compareKey', () => {
  it('changes with every input the simulations read', () => {
    const k = compareKey('lognormal', 90, 't7')
    expect(k).toBe(compareKey('lognormal', 90, 't7'))
    expect(k).not.toBe(compareKey('historical', 90, 't7'))
    expect(k).not.toBe(compareKey('lognormal', 95, 't7'))
    expect(k).not.toBe(compareKey('lognormal', 90, 't8'))
  })

  it('an unknown ledger version never matches, so a reveal re-validates', () => {
    expect(compareKey('lognormal', 90, null)).toBeNull()
  })
})

describe('dataVersionOf', () => {
  it('keys a tab session on its data revision and the household on its server writes (F24)', () => {
    // A tab's price refresh moves localMode.dataRevision (src/local/dispatch.test.ts), so the key changes with it.
    const before = compareKey('lognormal', 90, dataVersionOf({ session: true, revision: 6 }))
    const after = compareKey('lognormal', 90, dataVersionOf({ session: true, revision: 7 }))
    expect(before).not.toBe(after)
    expect(compareKey('lognormal', 90, dataVersionOf({ session: true, revision: 7 }))).toBe(after)
    expect(dataVersionOf({ session: true, revision: 7 })).toBe('t7')
    expect(dataVersionOf({ session: false, serverWrites: 7 })).toBe('h7')
  })
})

describe('assumptionPills', () => {
  const p = { meanReturnMicro: 55_000, volMicro: 135_000, saveBeforeBuyCents: 150_000_00, buyEnabled: true, buyYear: 2027, retireYear: 2048 }
  it('reads volatility as typed, not rounded to a whole percent (F31)', () => {
    expect(assumptionPills(p, true)).toEqual(['Real return 5.5%', 'σ 13.5%', 'Save $150K/yr', 'Buy house 2027', 'Retire 2048'])
    expect(assumptionPills({ ...p, volMicro: 120_000, meanReturnMicro: 50_000 }, true).slice(0, 2)).toEqual(['Real return 5.0%', 'σ 12%'])
  })
  it('names the purchase only when one is modelled', () => {
    expect(assumptionPills(p, false)).not.toContain('Buy house 2027')
    expect(assumptionPills({ ...p, buyEnabled: false }, true)).not.toContain('Buy house 2027')
  })
})
