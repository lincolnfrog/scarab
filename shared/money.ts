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
 * Whole dollars for tiles and headlines: 123456 → '$1,235'. Rounds half away
 * from zero on the integer cents (−$0.50 → '-$1'); a value that rounds to zero
 * carries no minus sign.
 */
export function formatDollars(cents: Cents, opts: { sign?: boolean } = {}): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`not integer cents: ${cents}`)
  const abs = Math.abs(cents)
  const dollars = Math.floor(abs / 100) + (abs % 100 >= 50 ? 1 : 0)
  const prefix = cents < 0 && dollars > 0 ? '-' : opts.sign ? '+' : ''
  return `${prefix}$${dollars.toLocaleString('en-US')}`
}

/** Cents as an input field shows them: '1,234.56', '-12.00' — no '$', and parseMoney reads it back. */
export function formatCentsPlain(cents: Cents): string {
  return formatCents(cents).replace('$', '')
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
  // Commas are allowed only as correctly-placed thousands separators, as in parseMoney.
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?$/.exec(input.trim())
  if (!m) throw new Error(`unparseable quantity: ${JSON.stringify(input)} (up to 6 decimal places)`)
  const micro = Number(m[1]!.replace(/,/g, '')) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'))
  if (!Number.isSafeInteger(micro) || micro <= 0) throw new Error(`quantity out of range: ${input}`)
  return micro
}

export function formatQtyMicro(micro: number): string {
  const whole = Math.floor(micro / 1_000_000)
  const frac = String(micro % 1_000_000).padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole.toLocaleString('en-US')}.${frac}` : whole.toLocaleString('en-US')
}

/**
 * Rates are integer micro-units: 1_000_000 = 100%, so one micro is 0.0001%.
 * Parse what a person types — '6.375', '6.375%', '-2.5 %', '.5' — to micro
 * (6.375% → 63_750). String math like parseMoney: the fraction is padded to
 * four digits and read as an integer, never as a float. Throws on anything
 * else, including a fifth decimal place.
 */
export function parsePercentMicro(input: string): number {
  const m = /^([+-]?)(\d*)(?:\.(\d{1,4}))?\s*%?$/.exec(input.trim())
  if (!m || (m[2] === '' && m[3] === undefined))
    throw new Error(`unparseable percent: ${JSON.stringify(input)} (up to 4 decimal places)`)
  const [, sign, whole, frac = ''] = m
  const micro = (whole ? parseInt(whole, 10) : 0) * 10_000 + parseInt(frac.padEnd(4, '0'), 10)
  if (!Number.isSafeInteger(micro)) throw new Error(`percent out of range: ${input}`)
  return sign === '-' && micro !== 0 ? -micro : micro
}

/**
 * A micro-unit rate as a percent with a fixed number of decimals (default 2):
 * 63_750 → '6.38%'. Rounds half away from zero in integer math; a value that
 * rounds to zero carries no minus sign.
 */
export function formatPercentMicro(micro: number, digits = 2): string {
  if (!Number.isSafeInteger(micro)) throw new Error(`not integer micro: ${micro}`)
  if (!Number.isInteger(digits) || digits < 0 || digits > 4) throw new Error(`digits must be 0–4: ${digits}`)
  const unit = 10 ** (4 - digits) // micro per last displayed digit
  const abs = Math.abs(micro)
  const scaled = Math.floor(abs / unit) + (unit > 1 && abs % unit >= unit / 2 ? 1 : 0)
  const whole = Math.floor(scaled / 10 ** digits)
  const frac = digits ? `.${String(scaled % 10 ** digits).padStart(digits, '0')}` : ''
  return `${micro < 0 && scaled > 0 ? '-' : ''}${whole.toLocaleString('en-US')}${frac}%`
}
