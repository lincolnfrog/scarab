import { describe, expect, it } from 'vitest'
import { CLEAR_AFTER_MS, createClipboardGuard } from './clipboard'

function fake() {
  const w = {
    clipboard: '',
    focused: true,
    writes: [] as string[],
    refuse: false,
    timers: new Map<number, { fn: () => void; at: number }>(),
    focusFns: new Set<() => void>(),
    now: 0,
    nextId: 1,
  }
  const guard = createClipboardGuard({
    async write(t) {
      if (w.refuse || !w.focused) throw new Error('Document is not focused.')
      w.writes.push(t)
      w.clipboard = t
    },
    hasFocus: () => w.focused,
    onNextFocus: (fn) => {
      w.focusFns.add(fn)
      return () => w.focusFns.delete(fn)
    },
    setTimer: (fn, ms) => {
      const id = w.nextId++
      w.timers.set(id, { fn, at: w.now + ms })
      return id
    },
    clearTimer: (id) => w.timers.delete(id as number),
  })
  const advance = async (ms: number) => {
    w.now += ms
    for (const [id, t] of [...w.timers]) if (t.at <= w.now) {
      w.timers.delete(id)
      t.fn()
    }
    await Promise.resolve()
    await Promise.resolve()
  }
  const focus = async () => {
    w.focused = true
    for (const fn of [...w.focusFns]) {
      w.focusFns.delete(fn)
      fn()
    }
    await Promise.resolve()
    await Promise.resolve()
  }
  return { w, guard, advance, focus }
}

describe('copying the recovery code', () => {
  it('copies, then clears the clipboard a minute later', async () => {
    const { w, guard, advance } = fake()
    await guard.copy('CODE-1')
    expect(w.clipboard).toBe('CODE-1')
    expect(guard.pending()).toBe(true)
    await advance(CLEAR_AFTER_MS - 1)
    expect(w.clipboard).toBe('CODE-1')
    await advance(1)
    expect(w.clipboard).toBe('')
    expect(guard.pending()).toBe(false)
    expect(w.writes).toEqual(['CODE-1', ''])
  })

  it('in the background when the minute is up, it clears at the next focus', async () => {
    const { w, guard, advance, focus } = fake()
    await guard.copy('CODE-1')
    w.focused = false
    await advance(CLEAR_AFTER_MS)
    expect(w.clipboard).toBe('CODE-1')
    expect(guard.pending()).toBe(true)
    await focus()
    expect(w.clipboard).toBe('')
    expect(guard.pending()).toBe(false)
  })

  it('a second copy restarts the minute; only one clearing ever runs', async () => {
    const { w, guard, advance } = fake()
    await guard.copy('CODE-1')
    await advance(40_000)
    await guard.copy('CODE-2')
    await advance(40_000)
    expect(w.clipboard).toBe('CODE-2')
    await advance(20_000)
    expect(w.clipboard).toBe('')
    expect(w.writes).toEqual(['CODE-1', 'CODE-2', ''])
    expect(w.timers.size).toBe(0)
  })

  it('a copy the browser refuses throws (the button says so) and schedules nothing; a refused clearing is swallowed', async () => {
    const { w, guard, advance } = fake()
    w.refuse = true
    await expect(guard.copy('CODE-1')).rejects.toThrow(/not focused/)
    expect(guard.pending()).toBe(false)
    expect(w.timers.size).toBe(0)
    w.refuse = false
    await guard.copy('CODE-1')
    w.refuse = true
    await advance(CLEAR_AFTER_MS) // focused, but the write is refused at the last moment: no unhandled rejection
    expect(guard.pending()).toBe(false)
  })
})
