import { parseMoney, parseQtyMicro } from '../shared/money'

/**
 * Starting positions, pasted: rows copied from a brokerage's positions or
 * lots page (a spreadsheet copy is tab-separated), a CSV export, or typed by
 * hand. Pure — no DB — so the paste sheet previews exactly what the engine
 * will accept, and createOpeningPositions re-validates what arrives.
 *
 * Columns, in this order unless a header row names them:
 *   Symbol · Shares · Cost basis (the lot's total) · Acquired (optional)
 * A header row may name them in any order ("Quantity", "Ticker", "Date
 * acquired", …). With neither a usable header nor the fixed order, the
 * columns are sniffed from their content. The delimiter (tab, comma with
 * quoting, semicolon, runs of spaces) is whichever reads the most rows.
 *
 * Money and share counts go through parseMoney / parseQtyMicro — string
 * math, integer cents and micro-shares, never a float.
 */

export type PastedRow = {
  /** 1-based line in the pasted text, so a message can point at it. */
  line: number
  symbol: string
  qtyMicro: number
  basisCents: number
  /** When the shares were really acquired; null when the row doesn't say. */
  acquiredOn: string | null
}
export type PasteIssue = { line: number; message: string }
export type PasteColumns = { symbol: number; shares: number; basis: number; acquired: number | null }
export type PasteResult = {
  rows: PastedRow[]
  /** Lines that couldn't be read. The engine takes all rows or none, so these block saving. */
  errors: PasteIssue[]
  /** Lines left out on purpose: totals, cash sweeps. */
  skipped: PasteIssue[]
  header: boolean
  columns: PasteColumns
  delimiter: Delimiter
}
export type Delimiter = 'tab' | 'comma' | 'semicolon' | 'space'

/* ---------- dates ---------- */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/** 'Mar', 'march', 'Sept.' → 3 / 3 / 9; anything shorter than 3 letters or not a month prefix → null. */
function monthNumber(name: string): number | null {
  const n = name.toLowerCase().replace(/\.$/, '')
  if (n.length < 3) return null
  const i = MONTHS.findIndex((m) => m.startsWith(n))
  return i < 0 ? null : i + 1
}

const leap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)
const DAYS_IN = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function ymd(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1) return null
  const max = m === 2 && leap(y) ? 29 : DAYS_IN[m - 1]!
  if (d > max) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/** Two-digit years: 00–69 → 2000s, 70–99 → 1900s. */
const fullYear = (s: string) => (s.length === 2 ? (Number(s) <= 69 ? 2000 : 1900) + Number(s) : Number(s))

/**
 * A date as brokerages and people write it → 'YYYY-MM-DD', or null. Reads
 * 2019-03-15, 2019/3/15, 20190315, 3/15/2019, 3/15/19, 03-15-2019 (numeric
 * day-month order is US: month first), Mar 15, 2019, March 15 2019,
 * 15 Mar 2019 and 15-Mar-19; a trailing time (T…, or a space and a clock) is
 * ignored. Impossible days (Feb 30, Feb 29 of a common year) are null.
 */
export function isoFromAny(input: string): string | null {
  const s = input
    .trim()
    .replace(/[T\s]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[AP]M|[+-]\d{2}:?\d{2})?$/i, '')
    .replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  if ((m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s))) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return ymd(Number(m[1]), Number(m[2]), Number(m[3]))
  if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(s))) return ymd(fullYear(m[3]!), Number(m[1]), Number(m[2]))
  if ((m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/i.exec(s))) {
    const mo = monthNumber(m[1]!)
    return mo === null ? null : ymd(Number(m[3]), mo, Number(m[2]))
  }
  if ((m = /^(\d{1,2})[ -]([a-z]+)\.?[ ,-]+(\d{4}|\d{2})$/i.exec(s))) {
    const mo = monthNumber(m[2]!)
    return mo === null ? null : ymd(fullYear(m[3]!), mo, Number(m[1]))
  }
  return null
}

/* ---------- cells ---------- */

/** Split one line on a delimiter, honouring double quotes ("$1,234.00", "a ""quoted"" cell"). */
function splitQuoted(line: string, d: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else quoted = false
      } else cur += ch
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true
      cur = ''
    } else if (ch === d) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

function splitLine(line: string, d: Delimiter): string[] {
  if (d === 'tab') return splitQuoted(line, '\t')
  if (d === 'comma') return splitQuoted(line, ',')
  if (d === 'semicolon') return splitQuoted(line, ';')
  // Runs of 2+ spaces when the line has them (a fixed-width copy keeps
  // "Mar 15, 2019" in one cell); otherwise any whitespace.
  const t = line.trim()
  return /\s{2,}/.test(t) ? t.split(/\s{2,}/) : t.split(/\s+/)
}

const SYMBOLISH = /^[A-Za-z][A-Za-z0-9.\-/]{0,14}$/
const isSymbolish = (s: string) => SYMBOLISH.test(s.trim())
const qtyOf = (s: string): number | null => {
  try {
    return parseQtyMicro(s.replace(/\s/g, ''))
  } catch {
    return null
  }
}
const moneyOf = (s: string): number | null => {
  try {
    return parseMoney(s)
  } catch {
    return null
  }
}
const isNumeric = (s: string) => s.trim() !== '' && (qtyOf(s) !== null || moneyOf(s) !== null)
const isDateCell = (s: string) => s.trim() !== '' && isoFromAny(s) !== null

/** Lines a positions page carries that aren't holdings. */
const NOT_A_HOLDING = /^(total|totals|account total|grand total|cash|cash & cash investments|cash and cash investments|money market|pending|sweep)\b/i
/** An acquired cell that says "no single date". */
const NO_DATE = /^(|-+|—|n\/?a|various|multiple|none)$/i

/* ---------- header ---------- */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/# ]+/g, ' ').replace(/\s+/g, ' ').trim()
/** Per role: exact names first, then looser matches that must not be a per-share or value column. */
const HEADER: Record<keyof PasteColumns, { exact: RegExp; loose: RegExp; not?: RegExp }> = {
  symbol: { exact: /^(symbol|ticker|ticker symbol|sym|security symbol)$/, loose: /symbol|ticker/ },
  shares: { exact: /^(shares|quantity|qty|units|share count|shares held|# of shares|number of shares)$/, loose: /share|quantity|qty|units/, not: /price|cost|value|basis|per/ },
  basis: {
    exact: /^(cost basis|basis|total cost|total cost basis|cost basis total|cost)$/,
    loose: /basis|cost/,
    not: /per share|\/ ?share|\/sh|avg|average|unit|price|per/,
  },
  acquired: { exact: /^(acquired|date acquired|acquired date|acquisition date|open date|opened|purchase date|purchased|date)$/, loose: /acquir|open|purchase/ },
}

function headerColumns(cells: string[]): Partial<PasteColumns> {
  const names = cells.map(norm)
  const cols: Partial<PasteColumns> = {}
  const taken = new Set<number>()
  for (const pass of ['exact', 'loose'] as const)
    for (const role of ['symbol', 'shares', 'basis', 'acquired'] as const) {
      if (cols[role] !== undefined) continue
      const h = HEADER[role]
      const i = names.findIndex((n, j) => !taken.has(j) && h[pass].test(n) && !(pass === 'loose' && h.not?.test(n)))
      if (i >= 0) {
        cols[role] = i
        taken.add(i)
      }
    }
  return cols
}

/** A header: nothing in it reads as a number or date, and it names at least one column Scarab knows. */
function isHeader(cells: string[]): boolean {
  if (cells.some((c) => isNumeric(c) || isDateCell(c))) return false
  return Object.keys(headerColumns(cells)).length > 0
}

/* ---------- column sniffing ---------- */

const FIXED: PasteColumns = { symbol: 0, shares: 1, basis: 2, acquired: 3 }

/** Guess which column is which from what's in them, for pastes in another order with no header. */
function sniffColumns(table: string[][]): PasteColumns {
  const width = Math.max(...table.map((r) => r.length))
  const share = (c: number, test: (s: string) => boolean) => {
    const filled = table.filter((r) => (r[c] ?? '').trim() !== '')
    return filled.length === 0 ? 0 : filled.filter((r) => test(r[c]!)).length / filled.length
  }
  const cols = Array.from({ length: width }, (_, c) => ({
    c,
    date: share(c, isDateCell),
    symbol: share(c, (s) => isSymbolish(s) && !isDateCell(s)),
    numeric: share(c, (s) => isNumeric(s) && !isDateCell(s)),
    dollar: share(c, (s) => s.includes('$')),
    fine: share(c, (s) => /\.\d{3,}$/.test(s.trim())), // more than cents: a share count
  }))
  const pick = (ok: (x: (typeof cols)[number]) => boolean, score: (x: (typeof cols)[number]) => number, used: Set<number>) =>
    cols.filter((x) => !used.has(x.c) && ok(x)).sort((a, b) => score(b) - score(a) || a.c - b.c)[0]?.c
  const used = new Set<number>()
  const acquired = pick((x) => x.date >= 0.5, (x) => x.date, used)
  if (acquired !== undefined) used.add(acquired)
  const symbol = pick((x) => x.symbol >= 0.5, (x) => x.symbol, used) ?? FIXED.symbol
  used.add(symbol)
  const numeric = cols.filter((x) => !used.has(x.c) && x.numeric >= 0.5)
  // A '$' marks the basis; more than two decimals marks the share count;
  // otherwise the fixed order's relative order holds: shares, then basis.
  let basis = numeric.find((x) => x.dollar >= 0.5 && x.fine < 0.5)?.c
  let shares = numeric.find((x) => x.c !== basis && (x.fine >= 0.5 || x.dollar < 0.5))?.c
  if (basis === undefined) basis = numeric.find((x) => x.c !== shares)?.c
  shares ??= FIXED.shares
  basis ??= FIXED.basis
  return { symbol, shares, basis, acquired: acquired ?? null }
}

/** Does the fixed order read most rows? */
function fixedFits(table: string[][]): boolean {
  if (table.length === 0) return true
  const ok = table.filter((r) => isSymbolish(r[0] ?? '') && qtyOf(r[1] ?? '') !== null && moneyOf(r[2] ?? '') !== null)
  return ok.length * 2 >= table.length
}

/* ---------- rows ---------- */

function readRow(cells: string[], line: number, cols: PasteColumns): { row?: PastedRow; error?: string; skip?: string } {
  const at = (i: number | null) => (i === null ? '' : (cells[i] ?? '').trim())
  const rawSym = at(cols.symbol)
  // "Account Total", "Cash & Cash Investments" — but an all-caps CASH is a real ticker.
  const wordy = rawSym !== rawSym.toUpperCase() || /\s/.test(rawSym)
  if ((NOT_A_HOLDING.test(rawSym) && wordy) || (rawSym === '' && cells.some((c) => /total/i.test(c))))
    return { skip: 'not a holding (a total or cash line)' }
  if (rawSym === '') return { error: 'no symbol' }
  if (!isSymbolish(rawSym)) return { error: `“${rawSym}” doesn't look like a ticker` }
  const symbol = rawSym.toUpperCase()

  const rawQty = at(cols.shares)
  if (rawQty === '') return { error: `${symbol}: no share count` }
  const qtyMicro = qtyOf(rawQty)
  if (qtyMicro === null) return { error: `${symbol}: shares “${rawQty}” isn't a positive number (up to 6 decimals)` }

  const rawBasis = at(cols.basis)
  if (rawBasis === '') return { error: `${symbol}: no cost basis — the lot's total cost` }
  const basisCents = moneyOf(rawBasis)
  if (basisCents === null) return { error: `${symbol}: cost basis “${rawBasis}” isn't dollars and cents` }
  if (basisCents < 0) return { error: `${symbol}: cost basis can't be negative` }

  const rawAcq = at(cols.acquired)
  let acquiredOn: string | null = null
  if (!NO_DATE.test(rawAcq)) {
    acquiredOn = isoFromAny(rawAcq)
    if (acquiredOn === null) return { error: `${symbol}: acquired “${rawAcq}” isn't a date (2019-03-15 or 3/15/2019)` }
  }
  return { row: { line, symbol, qtyMicro, basisCents, acquiredOn } }
}

function parseWith(lines: { line: number; text: string }[], d: Delimiter): PasteResult {
  const table = lines.map((l) => splitLine(l.text, d))
  let header = false
  let cols: PasteColumns = FIXED
  let start = 0
  if (table.length > 0 && isHeader(table[0]!)) {
    header = true
    start = 1
    const h = headerColumns(table[0]!)
    if (h.symbol !== undefined && h.shares !== undefined && h.basis !== undefined)
      cols = { symbol: h.symbol, shares: h.shares, basis: h.basis, acquired: h.acquired ?? null }
    else cols = fixedFits(table.slice(1)) ? FIXED : sniffColumns(table.slice(1))
  } else if (!fixedFits(table)) cols = sniffColumns(table)
  if (cols === FIXED) {
    // No fourth column anywhere: there are no acquisition dates to read.
    const width = Math.max(0, ...table.slice(start).map((r) => r.length))
    if (width < 4) cols = { ...FIXED, acquired: null }
  }

  const out: PasteResult = { rows: [], errors: [], skipped: [], header, columns: cols, delimiter: d }
  for (let i = start; i < table.length; i++) {
    const r = readRow(table[i]!, lines[i]!.line, cols)
    if (r.row) out.rows.push(r.row)
    else if (r.skip) out.skipped.push({ line: lines[i]!.line, message: r.skip })
    else out.errors.push({ line: lines[i]!.line, message: r.error! })
  }
  return out
}

/** Read pasted positions. Blank lines and lines starting with # are ignored. */
export function parsePositions(text: string): PasteResult {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter((l) => l.text.trim() !== '' && !l.text.trim().startsWith('#'))
  const candidates: Delimiter[] = ['tab', 'comma', 'semicolon', 'space']
  const present = candidates.filter(
    (d) => d === 'space' || lines.some((l) => l.text.includes(d === 'tab' ? '\t' : d === 'comma' ? ',' : ';')),
  )
  let best: PasteResult | null = null
  for (const d of present) {
    const r = parseWith(lines, d)
    if (!best || r.rows.length > best.rows.length || (r.rows.length === best.rows.length && r.errors.length < best.errors.length))
      best = r
  }
  return best!
}
