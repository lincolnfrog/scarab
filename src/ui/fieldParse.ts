import { formatCentsPlain, formatQtyMicro, parseMoney, parsePercentMicro, parseQtyMicro } from '../../shared/money'

/**
 * The pure core of the money / percent / quantity inputs: what a person typed
 * → an integer value or a message they can act on. No floats, no DOM — the
 * parsing itself is shared/money.ts; this layer decides what "empty" means and
 * turns its terse exceptions into field copy.
 *
 * Contract for every parser: blank text is `{ value: null, error: null }` (the
 * field is simply empty — whether that is allowed is the form's call), a
 * valid entry has `error: null`, and an invalid one has a null value and a
 * short sentence for the inline error.
 */

export type MoneyParse = { cents: number | null; error: string | null }
export type MicroParse = { micro: number | null; error: string | null }

const tooManyDecimals = (t: string, max: number) => new RegExp(`\\.\\d{${max + 1},}\\s*%?\\)?$`).test(t)

/**
 * A decimal point with nothing after it yet ("12.") is on its way to "12.5":
 * read it as the whole number rather than as an error, so the value doesn't
 * blink to nothing in the middle of typing an amount.
 */
const settle = (t: string): string => (/^[^.]*\d\.\s*%?$/.test(t) ? t.replace(/\.(\s*%?)$/, '$1') : t)

/** '1,234.56' | '$1,234.56' | '-12' | '(40.25)' → cents. Negative amounts are refused unless allowed. */
export function parseMoneyField(text: string, o: { allowNegative?: boolean } = {}): MoneyParse {
  const t = text.trim()
  if (t === '') return { cents: null, error: null }
  let cents: number
  try {
    cents = parseMoney(settle(t))
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.startsWith('money out of range')) return { cents: null, error: 'That amount is too large' }
    if (tooManyDecimals(t, 2)) return { cents: null, error: 'Use at most 2 decimal places' }
    return { cents: null, error: 'Enter an amount like 1,234.56' }
  }
  if (cents < 0 && !o.allowNegative) return { cents: null, error: 'Enter a positive amount' }
  // parseMoney reads '-0' as -0; an integer-cents value is never negative zero.
  return { cents: cents === 0 ? 0 : cents, error: null }
}

/** '6.375' | '6.375%' → 63_750 micro (1e6 = 100%). Negative rates are refused unless allowed. */
export function parsePercentField(text: string, o: { allowNegative?: boolean } = {}): MicroParse {
  const t = text.trim()
  if (t === '') return { micro: null, error: null }
  let micro: number
  try {
    micro = parsePercentMicro(settle(t))
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.startsWith('percent out of range')) return { micro: null, error: 'That percentage is too large' }
    if (tooManyDecimals(t, 4)) return { micro: null, error: 'Use at most 4 decimal places' }
    return { micro: null, error: 'Enter a percentage like 6.375' }
  }
  if (micro < 0 && !o.allowNegative) return { micro: null, error: 'Enter a positive percentage' }
  return { micro, error: null }
}

/** '12' | '0.5' | '1,000.25' → micro-shares. Quantities are always more than zero. */
export function parseQtyField(text: string): MicroParse {
  const t = text.trim()
  if (t === '') return { micro: null, error: null }
  try {
    return { micro: parseQtyMicro(settle(t)), error: null }
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    if (tooManyDecimals(t, 6)) return { micro: null, error: 'Use at most 6 decimal places' }
    if (t.startsWith('-')) return { micro: null, error: 'Enter a quantity above zero' }
    if (msg.startsWith('quantity out of range')) {
      // parseQtyMicro folds "zero" and "too large" into one error; tell them apart for the person typing.
      return { micro: null, error: /^[0.,]+$/.test(t) ? 'Enter a quantity above zero' : 'That quantity is too large' }
    }
    return { micro: null, error: 'Enter a number of shares like 12.5' }
  }
}

/** Cents as the money input shows them after blur: '1,234.56'. Null → ''. */
export function formatMoneyField(cents: number | null): string {
  return cents === null ? '' : formatCentsPlain(cents)
}

/**
 * Micro as the percent input shows it: exact, no rounding and no '%'
 * (63_750 → '6.375', 1_000_000 → '100', -25_000 → '-2.5'). Display-only
 * formatters round; an edit field must hand back exactly what it was given, or
 * a blur with no change would still alter the stored rate.
 */
export function formatPercentField(micro: number | null): string {
  if (micro === null) return ''
  if (!Number.isSafeInteger(micro)) throw new Error(`not integer micro: ${micro}`)
  const abs = Math.abs(micro)
  const whole = Math.floor(abs / 10_000)
  const frac = String(abs % 10_000).padStart(4, '0').replace(/0+$/, '')
  return `${micro < 0 ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`
}

/** Micro-shares as the quantity input shows them: '1,000.25'. Null → ''. */
export function formatQtyField(micro: number | null): string {
  return micro === null ? '' : formatQtyMicro(micro)
}
