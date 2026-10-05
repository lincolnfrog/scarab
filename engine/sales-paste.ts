import { isoFromAny, isSymbolish, splitLine, type Delimiter, type PasteIssue } from './positions-paste'
import { parseQtyMicro } from '../shared/money'

/**
 * Past sales, pasted: shares sold before Scarab tracked them, one sale per
 * line with the lot it came from — the way a brokerage's realized gain/loss
 * page lists them. Each becomes a sale with an explicit basis
 * (engine/invest.ts createPastSales): the gain is realized with the lot's
 * acquisition date setting its term, and the account's holdings are left
 * alone, because the shares never lived in its lots. Pure — no DB — so the
 * sheet previews exactly what the engine will be sent.
 *
 * Columns, in this order unless a header row names them:
 *   Symbol · Shares · Cost basis · Acquired · Sale amount · Sold
 * Cost basis and sale amount are the lot's totals unless `amounts` says a
 * column is per share. Amounts may carry more than cents (a per-share price
 * of 118.5401, or a computed total like 8301.125); the dollar figure saved is
 * rounded to the cent, half up, once — after multiplying by the shares.
 */

export type AmountBasis = 'total' | 'perShare'
export type SaleAmounts = { basis: AmountBasis; proceeds: AmountBasis }
export type PastedSale = {
  line: number
  symbol: string
  qtyMicro: number
  basisCents: number
  acquiredOn: string
  proceedsCents: number
  soldOn: string
}
export type SalesPaste = { rows: PastedSale[]; errors: PasteIssue[]; header: boolean; delimiter: Delimiter }

type Role = 'symbol' | 'shares' | 'basis' | 'acquired' | 'proceeds' | 'sold'
const ROLES: Role[] = ['symbol', 'shares', 'basis', 'acquired', 'proceeds', 'sold']
const FIXED: Record<Role, number> = { symbol: 0, shares: 1, basis: 2, acquired: 3, proceeds: 4, sold: 5 }
/** Header names per role, most specific first (a "date sold" column is never the sale amount). */
const HEADER: [Role, RegExp][] = [
  ['acquired', /acquir|purchase|open|bought/],
  ['sold', /(date sold|sold date|sale date|date of sale|closed|close date|^sold$)/],
  ['proceeds', /proceeds|sale|sold|sell/],
  ['basis', /basis|cost/],
  ['shares', /share|quantity|qty|units/],
  ['symbol', /symbol|ticker|security/],
]
const headerNorm = (s: string) => s.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim()

function headerColumns(cells: string[]): Partial<Record<Role, number>> {
  const out: Partial<Record<Role, number>> = {}
  const taken = new Set<number>()
  for (const [role, re] of HEADER) {
    const i = cells.findIndex((c, j) => !taken.has(j) && re.test(headerNorm(c)))
    if (i >= 0 && out[role] === undefined) {
      out[role] = i
      taken.add(i)
    }
  }
  return out
}

/** "$1,234.5678" → 1_234_567_800 micro-dollars; null when it isn't a non-negative amount (up to 6 decimals). */
export function decimalMicro(input: string): number | null {
  const s = input.trim().replace(/[$\s]/g, '')
  const m = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,6}))?$/.exec(s)
  if (!m) return null
  const micro = Number(m[1]!.replace(/,/g, '')) * 1_000_000 + Number((m[2] ?? '').padEnd(6, '0'))
  return Number.isSafeInteger(micro) ? micro : null
}

/** A lot's dollar figure in cents: a total as given, or a per-share amount times the shares — rounded half up, once. */
export function amountCents(micro: number, qtyMicro: number, basis: AmountBasis): number {
  if (basis === 'total') return Math.floor((micro + 5_000) / 10_000)
  return Number((BigInt(micro) * BigInt(qtyMicro) + 5_000_000_000n) / 10_000_000_000n)
}

const isNumericCell = (s: string) => decimalMicro(s) !== null
const isDateCell = (s: string) => s.trim() !== '' && isoFromAny(s) !== null

function readRow(cells: string[], line: number, cols: Record<Role, number>, amounts: SaleAmounts): { row?: PastedSale; error?: string } {
  const at = (r: Role) => (cells[cols[r]] ?? '').trim()
  const rawSym = at('symbol')
  if (!rawSym) return { error: 'no symbol' }
  if (!isSymbolish(rawSym)) return { error: `“${rawSym}” doesn't look like a ticker` }
  const symbol = rawSym.toUpperCase()
  let qtyMicro: number
  try {
    qtyMicro = parseQtyMicro(at('shares').replace(/\s/g, ''))
  } catch {
    return { error: `${symbol}: shares “${at('shares')}” isn't a positive number (up to 6 decimals)` }
  }
  const money = (role: 'basis' | 'proceeds', what: string): number | string => {
    const raw = at(role)
    if (!raw) return `${symbol}: no ${what}`
    const micro = decimalMicro(raw)
    if (micro === null) return `${symbol}: ${what} “${raw}” isn't a dollar amount`
    return amountCents(micro, qtyMicro, amounts[role])
  }
  const basisCents = money('basis', 'cost basis')
  if (typeof basisCents === 'string') return { error: basisCents }
  const proceedsCents = money('proceeds', 'sale amount')
  if (typeof proceedsCents === 'string') return { error: proceedsCents }
  const acquiredOn = isoFromAny(at('acquired'))
  if (!acquiredOn) return { error: `${symbol}: acquired “${at('acquired')}” isn't a date (2022-06-25 or 6/25/2022)` }
  const soldOn = isoFromAny(at('sold'))
  if (!soldOn) return { error: `${symbol}: sold “${at('sold')}” isn't a date (2026-01-05 or 1/5/2026)` }
  if (acquiredOn > soldOn) return { error: `${symbol}: acquired ${acquiredOn} is after it was sold (${soldOn})` }
  return { row: { line, symbol, qtyMicro, basisCents, acquiredOn, proceedsCents, soldOn } }
}

function parseWith(lines: { line: number; text: string }[], d: Delimiter, amounts: SaleAmounts): SalesPaste {
  const table = lines.map((l) => splitLine(l.text, d))
  let cols = FIXED
  let start = 0
  const first = table[0]
  if (first && !first.some((c) => isNumericCell(c) || isDateCell(c)) && Object.keys(headerColumns(first)).length > 0) {
    start = 1
    const h = headerColumns(first)
    if (ROLES.every((r) => h[r] !== undefined)) cols = h as Record<Role, number>
  }
  const out: SalesPaste = { rows: [], errors: [], header: start === 1, delimiter: d }
  for (let i = start; i < table.length; i++) {
    const r = readRow(table[i]!, lines[i]!.line, cols, amounts)
    if (r.row) out.rows.push(r.row)
    else out.errors.push({ line: lines[i]!.line, message: r.error! })
  }
  return out
}

/** Read pasted sales. Blank lines and lines starting with # are ignored; the delimiter is whichever reads the most rows. */
export function parseSales(text: string, amounts: SaleAmounts): SalesPaste {
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((t, i) => ({ line: i + 1, text: t }))
    .filter((l) => l.text.trim() !== '' && !l.text.trim().startsWith('#'))
  const candidates: Delimiter[] = ['tab', 'comma', 'semicolon', 'space']
  const present = candidates.filter((d) => d === 'space' || lines.some((l) => l.text.includes(d === 'tab' ? '\t' : d === 'comma' ? ',' : ';')))
  let best: SalesPaste | null = null
  for (const d of present) {
    const r = parseWith(lines, d, amounts)
    if (!best || r.rows.length > best.rows.length || (r.rows.length === best.rows.length && r.errors.length < best.errors.length)) best = r
  }
  return best!
}
