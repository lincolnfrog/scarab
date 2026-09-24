/**
 * The text ⇄ integer rules behind the number inputs (MoneyInput, PercentInput,
 * QtyInput), as pure steps so they can be tested without a DOM. Field.tsx's
 * useParsedText holds the state and calls onChange / onCommit with what a step
 * says to emit.
 *
 * What the parent holds always matches the box: the value the text parses to,
 * or null while there is none — blank, or text that doesn't parse. A parent
 * never keeps the last good value from before a typo ("1,000" then "1,0000"),
 * which a form could otherwise save while the box shows an error.
 */

export type Parsed = { value: number | null; error: string | null }
export type Parse = (text: string) => Parsed

export type TextState = {
  text: string
  /** The current text's parse error, tracked on every keystroke. */
  error: string | null
  /** Errors show from the first commit (blur / Enter / a submit) on. */
  touched: boolean
  /** The value the parent was last given (or gave us). */
  emitted: number | null
}

/** What a step asks of the parent. `emit` present: call onChange with it. `commit` present: call onCommit with it. */
export type Step = { state: TextState; emit?: number | null; commit?: number | null }

export const initialText = (value: number | null, format: (v: number | null) => string): TextState => ({
  text: format(value),
  error: null,
  touched: false,
  emitted: value,
})

/** The value the parent should hold for a parse: the parsed value, or null when the text doesn't parse. */
const held = (r: Parsed): number | null => (r.error ? null : r.value)

/** A keystroke: the text is the person's; the parent hears about every change in what it parses to. */
export function typeText(s: TextState, raw: string, parse: Parse): Step {
  const r = parse(raw)
  const next = held(r)
  const state = { ...s, text: raw, error: r.error, emitted: next }
  return next === s.emitted ? { state } : { state, emit: next }
}

/**
 * Blur / Enter: valid text is reformatted (1234.5 → 1,234.50), and `commit`
 * reports the value when it differs from what it was when the field took
 * focus (`atFocus`) — so tabbing through a form writes nothing. Invalid text
 * stays as typed, shows its error, and commits nothing.
 */
export function commitText(s: TextState, parse: Parse, format: (v: number | null) => string, atFocus: number | null): Step {
  const r = parse(s.text)
  if (r.error) {
    const state = { ...s, error: r.error, touched: true, emitted: null }
    return s.emitted === null ? { state } : { state, emit: null }
  }
  const state = { ...s, text: format(r.value), error: null, touched: true, emitted: r.value }
  const step: Step = r.value === s.emitted ? { state } : { state, emit: r.value }
  if (r.value !== atFocus) step.commit = r.value
  return step
}

/**
 * The enclosing form is submitting. Text that doesn't parse refuses it (and
 * shows its error, if it wasn't showing yet); anything else lets it through.
 */
export function submitCheck(s: TextState, parse: Parse): { ok: boolean; state: TextState } {
  const r = parse(s.text)
  if (!r.error) return { ok: true, state: s }
  return { ok: false, state: { ...s, error: r.error, touched: true } }
}

/** A new value from the parent. One this input didn't emit (a reset, a reload, a clamp) replaces the text. */
export function receiveValue(s: TextState, value: number | null, format: (v: number | null) => string): TextState {
  return value === s.emitted ? s : initialText(value, format)
}
