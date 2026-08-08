/**
 * Money is integer cents everywhere — in the DB, over the API, in app state.
 * Floats never touch a monetary value; parsing and formatting are string math.
 */
export type Cents = number

export function formatCents(cents: Cents, opts: { sign?: boolean } = {}): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`not integer cents: ${cents}`)
  const neg = cents < 0
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100).toLocaleString('en-US')
  const frac = String(abs % 100).padStart(2, '0')
  const prefix = neg ? '-' : opts.sign ? '+' : ''
  return `${prefix}$${whole}.${frac}`
}

/**
 * Parse "1,234.56", "$1,234.56", "-$12", "+40.25", "(1,234.56)" → integer cents.
 * Accounting parentheses mean negative. Throws on anything else.
 */
export function parseMoney(input: string): Cents {
  let cleaned = input.trim().replace(/[$\s]/g, '')
  let paren = false
  const p = /^\((.*)\)$/.exec(cleaned)
  if (p) {
    paren = true
    cleaned = p[1]!
  }
  // Commas are allowed only as correctly-placed thousands separators.
  const m = /^([+-]?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/.exec(cleaned)
  if (!m) throw new Error(`unparseable money: ${JSON.stringify(input)}`)
  const [, sign, whole, frac = ''] = m
  if (paren && sign) throw new Error(`unparseable money: ${JSON.stringify(input)}`)
  const cents = Number(whole!.replace(/,/g, '')) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new Error(`money out of range: ${input}`)
  return sign === '-' || paren ? -cents : cents
}

/**
 * Share quantities are integer micro-shares (1 share = 1_000_000), so crypto
 * fractions stay exact. Same string-math discipline as parseMoney.
 */
export function parseQtyMicro(input: string): number {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(input.trim())
  if (!m) throw new Error(`unparseable quantity: ${JSON.stringify(input)} (up to 6 decimal places)`)
  const micro = Number(m[1]) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(micro) || micro <= 0) throw new Error(`quantity out of range: ${input}`)
  return micro
}

export function formatQtyMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000)
  const frac = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US')
}
