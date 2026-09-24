import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from 'react'
import {
  formatMoneyField,
  formatPercentField,
  formatQtyField,
  parseMoneyField,
  parsePercentField,
  parseQtyField,
} from './fieldParse'
import { commitText, initialText, receiveValue, submitCheck, typeText, type Parsed, type Step } from './parsedText'
import './ui.css'

/**
 * Labelled form fields. A <Field> owns the label, hint and error line and
 * hands its input an id through context, so `<label htmlFor>` and
 * aria-describedby wire up without the caller naming anything:
 *
 *   <FieldGrid>
 *     <Field label="Federal withholding" hint="per paycheck">
 *       <MoneyInput value={w} onChange={setW} />
 *     </Field>
 *   </FieldGrid>
 *
 * The number inputs keep what the person typed as text and emit integer
 * values (cents, or micro for rates and shares) — or null while the text is
 * blank or doesn't parse, so the parent never holds a value the box doesn't
 * show. Invalid text shows an inline error — in the Field's error line, or
 * under the input when it stands alone — and refuses the submit of the form
 * it sits in (focus goes to it), so no form saves around it.
 */

type FieldCtx = {
  id: string
  describedBy: string | undefined
  invalid: boolean
  /** An input reports its own parse error here; the Field shows it in place of the caller's while there is one. */
  setInnerError: (error: string | null) => void
}
const Ctx = createContext<FieldCtx | null>(null)

/** The enclosing Field's wiring, or null outside one — for custom controls that want the same label/error hookup. */
export function useField(): FieldCtx | null {
  return useContext(Ctx)
}

export function Field(p: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  const id = useId()
  const [inner, setInner] = useState<string | null>(null)
  // The input's own parse error first: the caller's is about a value, and text that doesn't parse has none.
  const shown = inner || p.error
  const hintId = `${id}-hint`
  const errId = `${id}-err`
  const describedBy = shown ? errId : p.hint ? hintId : undefined
  const ctx = useMemo<FieldCtx>(() => ({ id, describedBy, invalid: !!shown, setInnerError: setInner }), [id, describedBy, shown])
  return (
    <div className="ui-field">
      <label htmlFor={id} className="ui-field-label">
        {p.label}
      </label>
      <Ctx.Provider value={ctx}>{p.children}</Ctx.Provider>
      {shown ? (
        <div id={errId} className="ui-field-err">
          {shown}
        </div>
      ) : p.hint ? (
        <div id={hintId} className="ui-field-hint">
          {p.hint}
        </div>
      ) : null}
    </div>
  )
}

/** Responsive columns of Fields: as many as fit at `min` px (default 170), each stretching to fill. */
export function FieldGrid(p: { children: ReactNode; min?: number }) {
  return (
    <div className="ui-fieldgrid" style={{ '--ui-fg-min': `${p.min ?? 170}px` } as CSSProperties}>
      {p.children}
    </div>
  )
}

/* ---------- plain inputs ---------- */

type InputProps = InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }

/**
 * A text input that picks up its Field's id and error state. All native input
 * props pass through; `autoFocus` also marks it as a Dialog's initial focus.
 */
export function TextInput({ className, ...rest }: InputProps) {
  const f = useField()
  return (
    <input
      {...rest}
      data-autofocus={rest.autoFocus || undefined}
      id={rest.id ?? f?.id}
      className={`ui-input${f?.invalid ? ' ui-invalid' : ''}${className ? ` ${className}` : ''}`}
      aria-describedby={join(rest['aria-describedby'], f?.describedBy)}
      aria-invalid={rest['aria-invalid'] ?? (f?.invalid || undefined)}
    />
  )
}

/** A select that picks up its Field's id and error state. */
export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement> }) {
  const f = useField()
  return (
    <select
      {...rest}
      data-autofocus={rest.autoFocus || undefined}
      id={rest.id ?? f?.id}
      className={`ui-input${f?.invalid ? ' ui-invalid' : ''}${className ? ` ${className}` : ''}`}
      aria-describedby={join(rest['aria-describedby'], f?.describedBy)}
      aria-invalid={rest['aria-invalid'] ?? (f?.invalid || undefined)}
    />
  )
}

/** A calendar date as 'YYYY-MM-DD' (the native picker, dark). An incomplete date reads as ''. */
export function DateInput(p: {
  value: string
  onChange: (iso: string) => void
  max?: string
  min?: string
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
  ref?: Ref<HTMLInputElement>
}) {
  const f = useField()
  return (
    <input
      ref={p.ref}
      type="date"
      id={f?.id}
      className={`ui-input ui-date${f?.invalid ? ' ui-invalid' : ''}`}
      value={p.value}
      max={p.max}
      min={p.min}
      disabled={p.disabled}
      autoFocus={p.autoFocus}
      data-autofocus={p.autoFocus || undefined}
      aria-label={p['aria-label']}
      aria-describedby={f?.describedBy}
      aria-invalid={f?.invalid || undefined}
      onChange={(e) => p.onChange(e.target.value)}
    />
  )
}

/* ---------- number inputs ---------- */

/**
 * The text ⇄ integer state machine shared by the number inputs (the rules
 * themselves are parsedText.ts).
 *
 * - Typing: the text is the person's; onChange hears every change in what it
 *   parses to — null while it doesn't parse, never the last good value.
 * - Blur / Enter ("commit"): valid text is reformatted (1234.5 → 1,234.50)
 *   and onCommit fires — only when the value differs from what it was when
 *   the field took focus, so tabbing through a form writes nothing. Invalid
 *   text commits nothing.
 * - Errors show from the first commit on, then track every keystroke.
 * - A new `value` from the parent that this input didn't emit (a reset, a
 *   reload, a clamp) replaces the text.
 * - The enclosing form's submit is refused while the text doesn't parse.
 */
function useParsedText(
  value: number | null,
  parse: (text: string) => Parsed,
  format: (v: number | null) => string,
  onChange: (v: number | null) => void,
  onCommit?: (v: number | null) => void,
): NumberBoxState {
  const [s, setS] = useState(() => initialText(value, format))
  const [prevValue, setPrevValue] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    const next = receiveValue(s, value, format)
    if (next !== s) setS(next)
  }
  const atFocus = useRef(value)

  const apply = (step: Step) => {
    setS(step.state)
    if ('emit' in step) onChange(step.emit ?? null)
    if ('commit' in step) {
      atFocus.current = step.commit ?? null
      onCommit?.(step.commit ?? null)
    }
  }
  const commit = () => apply(commitText(s, parse, format, atFocus.current))

  return {
    text: s.text,
    error: s.touched ? s.error : null,
    onChange: (raw: string) => apply(typeText(s, raw, parse)),
    onFocus: () => {
      atFocus.current = s.emitted
    },
    onBlur: commit,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      // Commit, then let Enter carry on (it submits an enclosing form).
      if (e.key === 'Enter') commit()
    },
    check: () => {
      const r = submitCheck(s, parse)
      if (!r.ok) setS(r.state)
      return r.ok
    },
  }
}

/** What NumberBox renders from: the text, the error to show, and the handlers. useParsedText builds one; prompt() builds its own. */
export type NumberBoxState = {
  text: string
  error: string | null
  onChange: (raw: string) => void
  onFocus: () => void
  onBlur: () => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  /** The enclosing <form> is submitting: false refuses it (NumberBox then focuses the box). Omitted: never refuses. */
  check?: () => boolean
}

type NumberBoxProps = {
  state: NumberBoxState
  prefix?: string
  suffix?: string
  width?: number
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  inputMode: 'decimal' | 'text'
  'aria-label'?: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * The affixed, monospace, right-aligned box the number inputs render — a
 * building block for this folder (prompt() drives it from its own form
 * state); screens use MoneyInput / PercentInput / QtyInput. Inside
 * a Field the error goes to the Field; standing alone (a table cell) it is
 * rendered under the box. The wrapper is always there outside a Field so an
 * error appearing never remounts the input under the person's cursor.
 */
export function NumberBox(p: NumberBoxProps) {
  const f = useField()
  const errId = useId()
  const { state } = p
  const setInnerError = f?.setInnerError
  useEffect(() => {
    if (!setInnerError) return
    setInnerError(state.error)
    return () => setInnerError(null)
  }, [setInnerError, state.error])

  // Refuse the enclosing form's submit while the text doesn't parse. A listener on the form itself runs before
  // the event bubbles to React's root, so stopping it there means the form's onSubmit never sees it — whatever
  // the form does or doesn't check (noValidate forms included).
  const input = useRef<HTMLInputElement | null>(null)
  const { inputRef } = p
  const setInput = useCallback(
    (el: HTMLInputElement | null) => {
      input.current = el
      if (typeof inputRef === 'function') inputRef(el)
      else if (inputRef) inputRef.current = el
    },
    [inputRef],
  )
  const check = useRef(state.check)
  useLayoutEffect(() => {
    check.current = state.check
  })
  useEffect(() => {
    const form = input.current?.form
    if (!form) return
    const onSubmit = (e: Event) => {
      const el = input.current
      if (!el || el.disabled || !check.current || check.current()) return
      e.preventDefault()
      e.stopImmediatePropagation() // the first box that refuses speaks for the form
      el.focus()
    }
    form.addEventListener('submit', onSubmit)
    return () => form.removeEventListener('submit', onSubmit)
  }, [])

  const invalid = !!state.error || !!f?.invalid
  const box = (
    <span
      className={`ui-affix${invalid ? ' ui-invalid' : ''}${p.disabled ? ' ui-disabled' : ''}`}
      style={p.width ? { width: p.width } : undefined}
    >
      {p.prefix && (
        <span className="ui-affix-sym" aria-hidden="true">
          {p.prefix}
        </span>
      )}
      <input
        ref={setInput}
        id={f?.id}
        className="ui-num"
        type="text"
        inputMode={p.inputMode}
        autoComplete="off"
        spellCheck={false}
        value={state.text}
        placeholder={p.placeholder}
        disabled={p.disabled}
        autoFocus={p.autoFocus}
        data-autofocus={p.autoFocus || undefined}
        aria-label={p['aria-label']}
        aria-invalid={invalid || undefined}
        aria-describedby={f ? f.describedBy : state.error ? errId : undefined}
        onChange={(e) => state.onChange(e.target.value)}
        onFocus={state.onFocus}
        onBlur={state.onBlur}
        onKeyDown={state.onKeyDown}
      />
      {p.suffix && (
        <span className="ui-affix-sym" aria-hidden="true">
          {p.suffix}
        </span>
      )}
    </span>
  )
  if (f) return box
  return (
    <span className="ui-numwrap">
      {box}
      {state.error && (
        <span id={errId} className="ui-inline-err">
          {state.error}
        </span>
      )}
    </span>
  )
}

/**
 * Dollars in, integer cents out. '$' prefix, parseMoney on every keystroke,
 * '1,234.56' on blur. Blank emits null. Negative amounts only with
 * allowNegative.
 */
export function MoneyInput(p: {
  value: number | null
  onChange: (cents: number | null) => void
  onCommit?: (cents: number | null) => void
  allowNegative?: boolean
  placeholder?: string
  width?: number
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
  ref?: Ref<HTMLInputElement>
}) {
  const state = useParsedText(
    p.value,
    (t) => {
      const r = parseMoneyField(t, { allowNegative: p.allowNegative })
      return { value: r.cents, error: r.error }
    },
    formatMoneyField,
    p.onChange,
    p.onCommit,
  )
  return (
    <NumberBox
      state={state}
      prefix="$"
      width={p.width}
      disabled={p.disabled}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      inputMode={p.allowNegative ? 'text' : 'decimal'}
      aria-label={p['aria-label']}
      inputRef={p.ref}
    />
  )
}

/**
 * A rate typed as a percent ('6.375'), emitted as integer micro (63_750;
 * 1e6 = 100%). '%' suffix; shown back exactly, never rounded. Negative rates
 * only with allowNegative.
 */
export function PercentInput(p: {
  valueMicro: number | null
  onChange: (micro: number | null) => void
  onCommit?: (micro: number | null) => void
  allowNegative?: boolean
  placeholder?: string
  width?: number
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
  ref?: Ref<HTMLInputElement>
}) {
  const state = useParsedText(
    p.valueMicro,
    (t) => {
      const r = parsePercentField(t, { allowNegative: p.allowNegative })
      return { value: r.micro, error: r.error }
    },
    formatPercentField,
    p.onChange,
    p.onCommit,
  )
  return (
    <NumberBox
      state={state}
      suffix="%"
      width={p.width}
      disabled={p.disabled}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      inputMode={p.allowNegative ? 'text' : 'decimal'}
      aria-label={p['aria-label']}
      inputRef={p.ref}
    />
  )
}

/** A share quantity (up to 6 decimals, thousands commas allowed), emitted as integer micro-shares. Always > 0. */
export function QtyInput(p: {
  valueMicro: number | null
  onChange: (micro: number | null) => void
  onCommit?: (micro: number | null) => void
  placeholder?: string
  width?: number
  disabled?: boolean
  autoFocus?: boolean
  'aria-label'?: string
  ref?: Ref<HTMLInputElement>
}) {
  const state = useParsedText(
    p.valueMicro,
    (t) => {
      const r = parseQtyField(t)
      return { value: r.micro, error: r.error }
    },
    formatQtyField,
    p.onChange,
    p.onCommit,
  )
  return (
    <NumberBox
      state={state}
      width={p.width}
      disabled={p.disabled}
      placeholder={p.placeholder}
      autoFocus={p.autoFocus}
      inputMode="decimal"
      aria-label={p['aria-label']}
      inputRef={p.ref}
    />
  )
}

function join(...ids: (string | undefined)[]): string | undefined {
  const s = ids.filter(Boolean).join(' ')
  return s || undefined
}
