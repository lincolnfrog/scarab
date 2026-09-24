/**
 * Axis labels. Short, and never wrong at a unit boundary: $999,950 reads
 * "$1.0M", never "$1000K" (bug #42). Tooltips use the exact formatters in
 * shared/money.ts; these are for ticks and compact figures only.
 */

export type AxisUnit = 'cents' | 'pct' | 'index'

const MINUS = '−'

/** One decimal while under 100 of the unit, whole above; an exact multiple drops the decimal ($5M, $2.5K, $850). */
function compact(n: number, suffix: string): string {
  if (Number.isInteger(n)) return `${n}${suffix}`
  const tenth = Math.round(n * 10) / 10
  if (tenth < 100) return `${tenth.toFixed(1)}${suffix}`
  return `${Math.round(n)}${suffix}`
}

/**
 * A value in chart units → an axis label.
 *   cents: '$0' · '$4.50' (under $10 keeps its cents) · '$850' · '$2.5K' · '$268K' · '$1.0M' · '$5M' · '$1.2B'
 *   pct:   micro-fraction (1_000_000 = 100%) → '+12%' · '−2.5%' · '0%'
 *   index: index_micro (1_000_000 = 100) → '100' · '112.5'
 */
export function fmtAxis(v: number, unit: AxisUnit): string {
  if (!Number.isFinite(v)) return ''
  if (unit === 'pct') {
    const p = v / 10_000
    if (Math.abs(p) < 1e-9) return '0%'
    const a = Math.abs(p)
    // Whole numbers group their thousands, as the tooltips do: '+20,000%', never '+20000%'.
    const s = Number.isInteger(a) || a >= 10 ? Math.round(a).toLocaleString('en-US') : (Math.round(a * 10) / 10).toFixed(1)
    return `${p < 0 ? MINUS : '+'}${s}%`
  }
  if (unit === 'index') {
    const x = v / 10_000
    const a = Math.abs(x)
    const s = Number.isInteger(Math.round(a * 1e6) / 1e6) ? Math.round(a).toLocaleString('en-US') : (Math.round(a * 10) / 10).toFixed(1)
    return `${x < 0 ? MINUS : ''}${s}`
  }
  const sign = v < 0 ? MINUS : ''
  const d = Math.abs(v) / 100
  if (d === 0) return '$0'
  if (d < 10) return `${sign}$${Number.isInteger(d) ? d : d.toFixed(2)}`
  // Pick the unit from the value as it will print, so rounding up carries over (999.95K → 1.0M).
  const units: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (let i = 0; i < units.length; i++) {
    const [div, suf] = units[i]!
    const n = d / div
    if (n >= 1) return `${sign}$${compact(n, suf)}`
    const next = units[i + 1]
    if (next) {
      // Would the smaller unit round to 1000 of itself? Then it belongs up here.
      const m = d / next[0]
      const printed = Number.isInteger(m) ? m : m < 100 ? Math.round(m * 10) / 10 : Math.round(m)
      if (printed >= 1000) return `${sign}$${n.toFixed(1)}${suf}`
    }
  }
  const whole = Math.round(d)
  if (whole >= 1000) return `${sign}$1.0K`
  return `${sign}$${whole}`
}

/**
 * A change in basis points as an unsigned percent with one decimal — the
 * caller shows the direction (▲/▼ and up/down colour): 140 → '1.4%',
 * 12_345 → '123.5%'. Tenths round half away from zero in integer math; a
 * change too small to show a tenth reads '<0.1%' rather than a false '0.0%'.
 */
export function fmtChangeBp(bp: number): string {
  if (!Number.isSafeInteger(bp)) return ''
  const a = Math.abs(bp)
  if (a === 0) return '0%'
  if (a < 5) return '<0.1%'
  const tenths = Math.floor(a / 10) + (a % 10 >= 5 ? 1 : 0)
  return `${Math.floor(tenths / 10).toLocaleString('en-US')}.${tenths % 10}%`
}

/**
 * A micro-fraction as a percent with one decimal (1_000_000 = 100%):
 * 591_000 → '59.1%'; with `sign`, '+59.1%' / '−24.0%' (a real minus) and '0%'
 * for zero. Tenths round half away from zero in integer math; a change too
 * small for a tenth reads '<0.1%' rather than a false '0.0%'.
 */
export function fmtPctMicro(micro: number, o: { sign?: boolean } = {}): string {
  if (!Number.isSafeInteger(micro)) return ''
  const a = Math.abs(micro)
  if (a === 0) return '0%'
  const s = o.sign ? (micro > 0 ? '+' : '−') : micro < 0 ? '−' : ''
  if (a < 500) return `${o.sign ? s : ''}<0.1%`
  const tenths = Math.floor(a / 1000) + (a % 1000 >= 500 ? 1 : 0)
  return `${s}${Math.floor(tenths / 10).toLocaleString('en-US')}.${tenths % 10}%`
}

/** An index-micro value on a 100 base, one decimal: 1_125_000 → '112.5'. Half away from zero. */
export function fmtIndex(micro: number): string {
  if (!Number.isSafeInteger(micro)) return ''
  const a = Math.abs(micro)
  const tenths = Math.floor(a / 1000) + (a % 1000 >= 500 ? 1 : 0)
  return `${micro < 0 && tenths > 0 ? '−' : ''}${Math.floor(tenths / 10).toLocaleString('en-US')}.${tenths % 10}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 'YYYY-MM' (or a longer ISO date) → 'Nov 2027'; anything else comes back as given. */
export function monthLong(month: string): string {
  const name = /^\d{4}-\d{2}/.test(month) ? MONTHS[Number(month.slice(5, 7)) - 1] : undefined
  return name ? `${name} ${month.slice(0, 4)}` : month
}

/** 'YYYY-MM-DD' → 'Aug 4', with the year when it isn't `today`'s year ('Dec 30, 2025'). */
export function shortDay(iso: string, today: string): string {
  const name = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? MONTHS[Number(iso.slice(5, 7)) - 1] : undefined
  if (!name) return iso
  const day = `${name} ${Number(iso.slice(8, 10))}`
  return iso.slice(0, 4) === today.slice(0, 4) ? day : `${day}, ${iso.slice(0, 4)}`
}
