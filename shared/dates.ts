/**
 * Calendar dates as ISO strings — 'YYYY-MM-DD' days and 'YYYY-MM' months —
 * the only date shapes that cross the API or live in the DB. Everything here
 * is synchronous and isomorphic (engine, server and browser share it).
 *
 * Arithmetic is on the calendar, never on local wall-clock time: day math goes
 * through UTC (no DST gaps), month math is integer (year, month) arithmetic.
 * The one place the runtime's zone matters is `todayLocal` — "today" is the
 * household's day, and in the browser that is the zone the tab runs in.
 */

const pad2 = (n: number) => String(n).padStart(2, '0')
const pad4 = (n: number) => String(n).padStart(4, '0')

function parseDay(iso: string): [number, number, number] {
  const parts = iso.split('-').map(Number)
  if (parts.length !== 3 || !parts.every(Number.isInteger)) throw new Error(`not an ISO date: ${JSON.stringify(iso)}`)
  return parts as [number, number, number]
}

function parseMonth(month: string): [number, number] {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error(`not an ISO month: ${JSON.stringify(month)}`)
  return [Number(m[1]), Number(m[2])]
}

const fmtDay = (y: number, m: number, d: number) => `${pad4(y)}-${pad2(m)}-${pad2(d)}`
const fmtMonth = (y: number, m: number) => `${pad4(y)}-${pad2(m)}`

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)

/** Days in a calendar month (1-based month). */
function daysIn(y: number, m: number): number {
  if (m === 2) return isLeap(y) ? 29 : 28
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31
}

/** Shift a (year, 1-based month) by n whole months with integer math. */
function shiftMonth(y: number, m: number, n: number): [number, number] {
  if (!Number.isInteger(n)) throw new Error(`not a whole number of months: ${n}`)
  const idx = y * 12 + (m - 1) + n
  const ty = Math.floor(idx / 12)
  return [ty, idx - ty * 12 + 1]
}

/**
 * A real calendar day in 'YYYY-MM-DD'. The shape alone lets impossible days
 * through — '2026-02-30', '2025-00-15' — and a month '2025-00' then breaks
 * every monthly series built from it, so input is checked with this.
 */
export function isRealIsoDay(s: unknown): s is string {
  if (typeof s !== 'string') return false
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo)
}

/**
 * Today as yyyy-mm-dd in the runtime's own time zone — the household's day in
 * a browser tab. `new Date().toISOString()` is UTC, which in the evening in
 * the Americas is already tomorrow.
 */
export function todayLocal(d: Date = new Date()): string {
  return fmtDay(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** Calendar-day arithmetic: '2026-02-28' + 1 → '2026-03-01'. `n` may be negative. */
export function addDaysIso(iso: string, n: number): string {
  if (!Number.isInteger(n)) throw new Error(`not a whole number of days: ${n}`)
  const [y, m, d] = parseDay(iso)
  // setUTCFullYear, not Date.UTC: the latter maps years 0–99 onto 1900–1999.
  const t = new Date(0)
  t.setUTCFullYear(y, m - 1, d + n)
  return fmtDay(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/**
 * Calendar-month arithmetic on ISO dates; the day clamps to the target month's
 * end (2026-01-31 + 1 → 2026-02-28, 2028-01-31 + 1 → 2028-02-29). `n` may be
 * negative.
 */
export function addMonthsIso(iso: string, n: number): string {
  const [y, m, d] = parseDay(iso)
  const [ty, tm] = shiftMonth(y, m, n)
  return fmtDay(ty, tm, Math.min(d, daysIn(ty, tm)))
}

/** One calendar year later; a Feb 29 anniversary falls on Feb 28 in a common year. */
export function anniversaryIso(iso: string): string {
  return addMonthsIso(iso, 12)
}

/** The last day of a month: '2026-02' → '2026-02-28'. */
export function monthEndIso(month: string): string {
  const [y, m] = parseMonth(month)
  return fmtDay(y, m, daysIn(y, m))
}

/** Every month from `first` through `last`, inclusive, as 'YYYY-MM'. Empty when first > last. */
export function monthsBetween(first: string, last: string): string[] {
  let [y, m] = parseMonth(first)
  const [ly, lm] = parseMonth(last)
  const out: string[] = []
  while (y < ly || (y === ly && m <= lm)) {
    out.push(fmtMonth(y, m))
    ;[y, m] = shiftMonth(y, m, 1)
  }
  return out
}

/** Month arithmetic on 'YYYY-MM': '2026-11' + 3 → '2027-02'. Integer (year, month) math — no Date. */
export function addMonthsToMonth(month: string, n: number): string {
  const [y, m] = parseMonth(month)
  return fmtMonth(...shiftMonth(y, m, n))
}
