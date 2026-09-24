import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { todayLocal } from '../../shared/dates'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { DateInput, Field, NumberBox, Select, TextInput, type NumberBoxState } from './Field'
import {
  formatMoneyField,
  formatPercentField,
  formatQtyField,
  parseMoneyField,
  parsePercentField,
  parseQtyField,
} from './fieldParse'
import { DUR, prefersReducedMotion } from './motion'

/**
 * On-brand replacements for window.confirm / window.prompt, as promises:
 *
 *   if (!(await confirm({ title: 'Delete this account?', danger: true, confirmLabel: 'Delete' }))) return
 *   const v = await prompt<{ cents: number }>({ title: 'Update balance', fields: [{ key: 'cents', kind: 'money', label: 'Balance' }] })
 *   if (v) await put(…, { balanceCents: v.cents })
 *
 * One <DialogHost/> mounted in App renders them, one at a time in call order.
 * Money typed into a prompt goes through parseMoney (integer cents); rates
 * and quantities come back as integer micro.
 */

export type ConfirmOpts = {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive: the confirm button turns red and Cancel takes the initial focus. */
  danger?: boolean
  /** The confirm button stays disabled until this exact text is typed. */
  typeToConfirm?: string
}

/**
 * One prompt field. `required` defaults to true where it applies: an empty
 * required field blocks submit; an empty optional number comes back as null.
 * Results: money → cents, percent/qty → micro, text (trimmed) / date / select
 * → string.
 */
export type PromptField =
  | { key: string; kind: 'money'; label: string; initial?: number | null; allowNegative?: boolean; required?: boolean; hint?: string }
  | { key: string; kind: 'percent'; label: string; initialMicro?: number | null; allowNegative?: boolean; required?: boolean; hint?: string }
  | { key: string; kind: 'qty'; label: string; initialMicro?: number | null; required?: boolean; hint?: string }
  | { key: string; kind: 'text'; label: string; initial?: string; maxLength?: number; required?: boolean; hint?: string }
  | { key: string; kind: 'date'; label: string; initial?: string /* default todayLocal() */; hint?: string }
  | { key: string; kind: 'select'; label: string; options: { value: string; label: string }[]; initial?: string }

export type PromptOpts<T> = {
  title: string
  body?: ReactNode
  fields: PromptField[]
  submitLabel?: string
  /** Cross-field check on the parsed values; a string blocks submit and is shown above the buttons. */
  validate?: (v: T) => string | null
}

/* ---------- the queue ---------- */

type Request =
  | { id: number; kind: 'confirm'; opts: ConfirmOpts; resolve: (ok: boolean) => void; closing: boolean }
  | { id: number; kind: 'prompt'; opts: PromptOpts<Record<string, unknown>>; resolve: (v: Record<string, unknown> | null) => void; closing: boolean }

let queue: readonly Request[] = []
let nextId = 1
let hosts = 0
const listeners = new Set<() => void>()

function setQueue(q: readonly Request[]) {
  queue = q
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}
const snapshot = () => queue

/** Settle a request now, keep it on screen through the exit fade, then drop it so the next one shows. */
function answer(id: number, settle: () => void) {
  const req = queue.find((r) => r.id === id)
  if (!req || req.closing) return
  settle()
  setQueue(queue.map((r) => (r.id === id ? { ...r, closing: true } : r)))
  setTimeout(() => setQueue(queue.filter((r) => r.id !== id)), prefersReducedMotion() ? 0 : DUR[2] + 60)
}

/** Ask a yes/no question. Resolves true only on an explicit confirm; Esc, ✕, the backdrop and Cancel resolve false. */
export function confirm(o: ConfirmOpts): Promise<boolean> {
  if (hosts === 0) {
    // No host mounted (only possible before App mounts one): degrade to the native dialog rather than hang.
    console.warn('confirm(): <DialogHost/> is not mounted; using window.confirm')
    const text = typeof o.body === 'string' ? `${o.title}\n\n${o.body}` : o.title
    if (o.typeToConfirm) return Promise.resolve(window.prompt(`${text}\n\nType ${o.typeToConfirm} to confirm.`) === o.typeToConfirm)
    return Promise.resolve(window.confirm(text))
  }
  return new Promise((resolve) => setQueue([...queue, { id: nextId++, kind: 'confirm', opts: o, resolve, closing: false }]))
}

/** Ask for one or more typed values. Resolves the parsed values, or null if the person backs out. */
export function prompt<T extends Record<string, unknown>>(o: PromptOpts<T>): Promise<T | null> {
  if (hosts === 0) return Promise.reject(new Error('prompt() needs <DialogHost/> mounted in App'))
  return new Promise<T | null>((resolve) =>
    setQueue([
      ...queue,
      {
        id: nextId++,
        kind: 'prompt',
        opts: o as PromptOpts<Record<string, unknown>>,
        resolve: resolve as (v: Record<string, unknown> | null) => void,
        closing: false,
      },
    ]),
  )
}

/** Renders confirm() and prompt() requests. Mount exactly once, outside any screen. */
export function DialogHost() {
  const q = useSyncExternalStore(subscribe, snapshot, snapshot)
  useEffect(() => {
    hosts++
    return () => {
      hosts--
    }
  }, [])
  const req = q[0]
  if (!req) return <></>
  return req.kind === 'confirm' ? (
    <ConfirmView key={req.id} opts={req.opts} open={!req.closing} onAnswer={(ok) => answer(req.id, () => req.resolve(ok))} />
  ) : (
    <PromptView key={req.id} opts={req.opts} open={!req.closing} onAnswer={(v) => answer(req.id, () => req.resolve(v))} />
  )
}

/* ---------- confirm ---------- */

function ConfirmView(p: { opts: ConfirmOpts; open: boolean; onAnswer: (ok: boolean) => void }) {
  const { opts } = p
  const formId = useId()
  const [typed, setTyped] = useState('')
  const cancelRef = useRef<HTMLButtonElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)
  const typeRef = useRef<HTMLInputElement>(null)
  const ok = !opts.typeToConfirm || typed.trim() === opts.typeToConfirm
  return (
    <Dialog
      open={p.open}
      onClose={() => p.onAnswer(false)}
      title={opts.title}
      initialFocus={opts.typeToConfirm ? typeRef : opts.danger ? cancelRef : okRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={() => p.onAnswer(false)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button ref={okRef} type="submit" form={formId} variant={opts.danger ? 'danger' : 'gold'} disabled={!ok}>
            {opts.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="ui-dialog-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (ok) p.onAnswer(true)
        }}
      >
        {opts.body != null && <div className="ui-dialog-lede">{typeof opts.body === 'string' ? <p>{opts.body}</p> : opts.body}</div>}
        {opts.typeToConfirm && (
          <div className="ui-typeconfirm">
            <Field
              label={
                <>
                  Type <b>{opts.typeToConfirm}</b> to confirm
                </>
              }
            >
              <TextInput
                ref={typeRef}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </Field>
          </div>
        )}
      </form>
    </Dialog>
  )
}

/* ---------- prompt ---------- */

type NumKind = 'money' | 'percent' | 'qty'
type Parsed = { value: number | null; error: string | null }

function parseNum(f: Extract<PromptField, { kind: NumKind }>, text: string): Parsed {
  if (f.kind === 'money') {
    const r = parseMoneyField(text, { allowNegative: f.allowNegative })
    return { value: r.cents, error: r.error }
  }
  const r = f.kind === 'percent' ? parsePercentField(text, { allowNegative: f.allowNegative }) : parseQtyField(text)
  return { value: r.micro, error: r.error }
}

function formatNum(kind: NumKind, v: number | null): string {
  return kind === 'money' ? formatMoneyField(v) : kind === 'percent' ? formatPercentField(v) : formatQtyField(v)
}

function initialText(f: PromptField): string {
  switch (f.kind) {
    case 'money':
      return formatMoneyField(f.initial ?? null)
    case 'percent':
      return formatPercentField(f.initialMicro ?? null)
    case 'qty':
      return formatQtyField(f.initialMicro ?? null)
    case 'text':
      return f.initial ?? ''
    case 'date':
      return f.initial ?? todayLocal()
    case 'select':
      return f.initial ?? f.options[0]?.value ?? ''
  }
}

/** One field's text → its value, or the message that blocks submit. */
function check(f: PromptField, text: string): { value: unknown; error: string | null } {
  switch (f.kind) {
    case 'money':
    case 'percent':
    case 'qty': {
      const r = parseNum(f, text)
      if (r.error) return { value: null, error: r.error }
      if (r.value === null && f.required !== false) return { value: null, error: 'Required' }
      return { value: r.value, error: null }
    }
    case 'text': {
      const t = text.trim()
      if (!t && f.required !== false) return { value: t, error: 'Required' }
      if (f.maxLength && t.length > f.maxLength) return { value: t, error: `At most ${f.maxLength} characters` }
      return { value: t, error: null }
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { value: text, error: null } : { value: text, error: 'Enter a date' }
    case 'select':
      return { value: text, error: null }
  }
}

function PromptView(p: { opts: PromptOpts<Record<string, unknown>>; open: boolean; onAnswer: (v: Record<string, unknown> | null) => void }) {
  const { opts } = p
  const formId = useId()
  const [text, setText] = useState<Record<string, string>>(() => Object.fromEntries(opts.fields.map((f) => [f.key, initialText(f)])))
  // A field's error shows once it has been edited and left, or after a submit attempt; then it tracks typing.
  // (Leaving an untouched field says nothing: focus also leaves when the dialog re-opens.)
  const [shown, setShown] = useState<Record<string, boolean>>({})
  const edited = useRef<Set<string>>(new Set())
  const [formError, setFormError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const errorOf = (f: PromptField) => (shown[f.key] ? check(f, text[f.key] ?? '').error : null)
  const setField = (key: string, v: string) => {
    edited.current.add(key)
    setText((t) => ({ ...t, [key]: v }))
    setFormError(null)
  }

  const submit = () => {
    const values: Record<string, unknown> = {}
    let firstBad: string | null = null
    for (const f of opts.fields) {
      const r = check(f, text[f.key] ?? '')
      values[f.key] = r.value
      if (r.error && firstBad === null) firstBad = f.key
    }
    if (firstBad !== null) {
      setShown(Object.fromEntries(opts.fields.map((f) => [f.key, true])))
      const idx = opts.fields.findIndex((f) => f.key === firstBad)
      formRef.current?.querySelectorAll<HTMLElement>('input, select')[idx]?.focus()
      return
    }
    const err = opts.validate?.(values) ?? null
    if (err) {
      setFormError(err)
      return
    }
    p.onAnswer(values)
  }

  return (
    <Dialog
      open={p.open}
      onClose={() => p.onAnswer(null)}
      title={opts.title}
      footer={
        <>
          <Button onClick={() => p.onAnswer(null)}>Cancel</Button>
          <Button type="submit" form={formId} variant="gold">
            {opts.submitLabel ?? 'Save'}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        ref={formRef}
        className="ui-dialog-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {opts.body != null && <div className="ui-dialog-lede">{typeof opts.body === 'string' ? <p>{opts.body}</p> : opts.body}</div>}
        {opts.fields.map((f) => {
          const hint = 'hint' in f ? f.hint : undefined
          const value = text[f.key] ?? ''
          const error = errorOf(f)
          const leave = () => {
            if (edited.current.has(f.key)) setShown((s) => ({ ...s, [f.key]: true }))
          }
          if (f.kind === 'money' || f.kind === 'percent' || f.kind === 'qty') {
            const commit = () => {
              if (!edited.current.has(f.key)) return
              leave()
              const r = parseNum(f, value)
              if (!r.error) setText((t) => ({ ...t, [f.key]: formatNum(f.kind, r.value) }))
            }
            const state: NumberBoxState = {
              text: value,
              error,
              onChange: (raw) => setField(f.key, raw),
              onFocus: () => undefined,
              onBlur: commit,
              onKeyDown: (e) => {
                if (e.key === 'Enter') commit()
              },
            }
            return (
              <Field key={f.key} label={f.label} hint={hint}>
                <NumberBox
                  state={state}
                  prefix={f.kind === 'money' ? '$' : undefined}
                  suffix={f.kind === 'percent' ? '%' : undefined}
                  inputMode={f.kind !== 'qty' && f.allowNegative ? 'text' : 'decimal'}
                />
              </Field>
            )
          }
          return (
            <Field key={f.key} label={f.label} hint={hint} error={error}>
              {f.kind === 'text' ? (
                <TextInput
                  value={value}
                  maxLength={f.maxLength}
                  onChange={(e) => setField(f.key, e.target.value)}
                  // An untouched default is selected, so typing replaces it rather than appending.
                  onFocus={(e) => {
                    if (value && !edited.current.has(f.key)) e.currentTarget.select()
                  }}
                  onBlur={leave}
                />
              ) : f.kind === 'date' ? (
                <DateInput value={value} onChange={(v) => setField(f.key, v)} />
              ) : (
                <Select value={value} onChange={(e) => setField(f.key, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )
        })}
        {formError && (
          <div className="ui-formerr" role="alert">
            {formError}
          </div>
        )}
      </form>
    </Dialog>
  )
}
