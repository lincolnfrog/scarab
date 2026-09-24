import { describe, expect, it } from 'vitest'
import { formatMoneyField, formatQtyField, parseMoneyField, parseQtyField } from './fieldParse'
import { commitText, initialText, receiveValue, submitCheck, typeText, type Parse, type TextState } from './parsedText'

const qty: Parse = (t) => {
  const r = parseQtyField(t)
  return { value: r.micro, error: r.error }
}
const money: Parse = (t) => {
  const r = parseMoneyField(t)
  return { value: r.cents, error: r.error }
}

/** Type `text` one character at a time, as a person does; returns the final state and every value the parent heard. */
function typeOut(s: TextState, text: string, parse: Parse): { state: TextState; heard: (number | null)[] } {
  const heard: (number | null)[] = []
  for (let i = 1; i <= text.length; i++) {
    const step = typeText(s, text.slice(0, i), parse)
    if ('emit' in step) heard.push(step.emit ?? null)
    s = step.state
  }
  return { state: s, heard }
}

describe('number input text rules', () => {
  it('never leaves the parent holding the last good value after a typo (1,000 → 1,0000)', () => {
    const { state, heard } = typeOut(initialText(null, formatQtyField), '1,0000', qty)
    // "1,000" parsed to 1,000 shares; one more zero doesn't parse, and the parent hears that it has no value.
    expect(heard.at(-2)).toBe(1_000_000_000)
    expect(heard.at(-1)).toBeNull()
    expect(state.emitted).toBeNull()
    expect(state.text).toBe('1,0000')
    expect(state.error).toMatch(/shares/)
  })

  it('hears each new value once, and nothing while the value stays the same', () => {
    const { heard } = typeOut(initialText(null, formatMoneyField), '12.50', money)
    expect(heard).toEqual([100, 1200, 1250]) // "12." and "12.5" parse to 1200 then 1250; "12.50" changes nothing
  })

  it('a blur on invalid text keeps the text, shows the error, and commits nothing', () => {
    let s = typeText(initialText(5000, formatMoneyField), '12.345', money).state
    expect(s.emitted).toBeNull()
    const step = commitText(s, money, formatMoneyField, 5000)
    expect(step.state).toMatchObject({ text: '12.345', touched: true, emitted: null })
    expect(step.state.error).toMatch(/2 decimal/)
    expect('emit' in step).toBe(false) // already told: null
    expect('commit' in step).toBe(false)
    // …and fixing it commits the new value.
    s = typeText(step.state, '12.34', money).state
    const fixed = commitText(s, money, formatMoneyField, 5000)
    expect(fixed.state).toMatchObject({ text: '12.34', error: null, emitted: 1234 })
    expect(fixed.commit).toBe(1234)
  })

  it('a blur reformats valid text and commits only a change since focus', () => {
    const s = typeText(initialText(null, formatMoneyField), '1234.5', money).state
    const step = commitText(s, money, formatMoneyField, null)
    expect(step.state.text).toBe('1,234.50')
    expect(step.commit).toBe(123_450)
    expect('commit' in commitText(step.state, money, formatMoneyField, 123_450)).toBe(false) // tabbing through writes nothing
  })

  it('refuses a submit while the text does not parse, and shows why', () => {
    const typed = typeOut(initialText(null, formatQtyField), '1,0000', qty).state
    expect(typed.touched).toBe(false) // typed, never blurred: the error isn't showing yet
    const r = submitCheck(typed, qty)
    expect(r.ok).toBe(false)
    expect(r.state.touched).toBe(true)
    expect(submitCheck(typeText(typed, '10,000', qty).state, qty).ok).toBe(true)
    expect(submitCheck(initialText(null, formatQtyField), qty).ok).toBe(true) // blank is the form's call, not the box's
  })

  it("a value from the parent that this input didn't emit replaces the text; its own echo doesn't", () => {
    const s = typeText(initialText(null, formatQtyField), '1,0000', qty).state
    expect(receiveValue(s, null, formatQtyField)).toBe(s) // the parent echoing null back keeps the typo on screen
    expect(receiveValue(s, 2_000_000, formatQtyField)).toMatchObject({ text: '2', error: null, touched: false, emitted: 2_000_000 })
  })
})
