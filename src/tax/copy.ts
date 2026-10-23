import type { FilingStatus } from '../../engine/tax'
import { formatCents } from '../../shared/money'

/** A filing status as a sentence names it ('Filed as married filing jointly'). */
export const FILING_LABEL: Record<FilingStatus, string> = { mfj: 'married filing jointly', single: 'single', mfs: 'married filing separately', hoh: 'head of household' }

/**
 * The Taxes headline's gap line: tax still to pay beyond withholding and
 * payments (▲, the loss colour), over-withheld (▼, the gain colour) — or
 * neither, which is every new household's case (F32: it read "▼ $0.00
 * over-withheld so far" in green).
 */
export function gapLine(gapCents: number): { tone: 'neg' | 'pos' | 'muted'; text: string } {
  if (gapCents > 0) return { tone: 'neg', text: `▲ ${formatCents(gapCents)} more than you're on track to pay` }
  if (gapCents < 0) return { tone: 'pos', text: `▼ ${formatCents(-gapCents)} over-withheld so far` }
  return { tone: 'muted', text: 'On track — nothing more to pay, nothing over-withheld' }
}

/**
 * The safe-harbor card's footnote: the rule and how it spreads the required
 * payment over the four due dates — a sentence even for the federal rule,
 * whose even split used to leave just "Federal (Form 1040-ES).".
 */
export function scheduleNote(rule: string, weights: readonly number[]): string {
  const weighted = weights.some((w) => w !== weights[0])
  return `${rule} — ${weighted ? `installments weighted ${weights.join('/')}` : `${weights.length === 4 ? 'four' : weights.length} equal installments`}.`
}
