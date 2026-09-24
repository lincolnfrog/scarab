import { RSU_WITHHOLDING_NOTE, type RealizedLine, type RealizedReport } from '../../shared/invest-api'
import { formatQtyMicro } from '../../shared/money'

/**
 * A year's realized gains as a CSV shaped like Form 8949: Part I (short-term)
 * and Part II (long-term), columns (a)–(h), a total row under each part, and
 * two columns of Scarab's own — the account, and what to check before filing.
 * Pure (node-tested); the card only hands the text to the browser.
 *
 * Columns (f) code and (g) adjustment stay empty: they come from the broker's
 * 1099-B (a wash sale's disallowed loss is code W), which Scarab never sees —
 * lines that may need one say so in the note.
 */

/** Integer cents as a plain dollar figure, exactly: -123456 → "-1234.56". No float ever touches it. */
export function csvDollars(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`not whole cents: ${cents}`)
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** yyyy-mm-dd → MM/DD/YYYY, as the form writes dates. */
export const formDate = (iso: string): string => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`

/** "10 sh VTI", "0.052 sh BTC" — column (a). */
export const description = (l: Pick<RealizedLine, 'qty_micro' | 'symbol'>): string => `${formatQtyMicro(l.qty_micro).replace(/,/g, '')} sh ${l.symbol}`

/** What to check about a line before filing, or ''. */
export function lineNote(l: RealizedLine): string {
  const notes: string[] = []
  if (l.basis === 'none') notes.push('No basis recorded: counted at zero basis and short-term until it is entered')
  if (l.basis === 'entered') notes.push('Basis entered on the sale')
  // Net-settled withholding at cost never reaches the lines; one here was edited off $0.
  if (l.note === RSU_WITHHOLDING_NOTE) notes.push('Recorded as shares withheld at a vest, but not at cost: shares withheld to pay the tax are not a sale, so check it')
  if (l.wash_risk) notes.push('Possible wash sale: a buy within 30 days; check the 1099-B for code W')
  return notes.join('; ')
}

const cell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
const row = (cells: string[]): string => cells.map(cell).join(',')

export const FORM_8949_HEADER = [
  'Part',
  '(a) Description of property',
  '(b) Date acquired',
  '(c) Date sold or disposed of',
  '(d) Proceeds',
  '(e) Cost or other basis',
  '(f) Code(s)',
  '(g) Amount of adjustment',
  '(h) Gain or (loss)',
  'Account',
  'Check before filing',
]

export function form8949Csv(r: Pick<RealizedReport, 'lines' | 'st' | 'lt'>): string {
  const out = [row(FORM_8949_HEADER)]
  for (const [term, part, totals] of [
    ['st', 'I (short-term)', r.st],
    ['lt', 'II (long-term)', r.lt],
  ] as const) {
    const lines = r.lines.filter((l) => l.term === term)
    if (lines.length === 0) continue
    for (const l of lines)
      out.push(
        row([
          part,
          description(l),
          l.acquired_on ? formDate(l.acquired_on) : '',
          formDate(l.sold_on),
          csvDollars(l.proceeds_cents),
          csvDollars(l.cost_cents),
          '',
          '',
          csvDollars(l.gain_cents),
          l.account,
          lineNote(l),
        ]),
      )
    out.push(row([`${part} total`, '', '', '', csvDollars(totals.proceeds_cents), csvDollars(totals.cost_cents), '', '', csvDollars(totals.gain_cents), '', '']))
  }
  return `${out.join('\r\n')}\r\n`
}

export const form8949Filename = (year: number): string => `scarab-form-8949-${year}.csv`
