import type { CheckinItem } from '../../shared/invest-api'

/**
 * The balance check-in's rules, pure and node-tested: which rows a sitting
 * would save, where each one saves (every number keeps its own existing
 * route), and the one summary the sitting ends with.
 */

export const rowKey = (i: Pick<CheckinItem, 'kind' | 'id'>): string => `${i.kind}:${i.id}`

/** What's typed on a row: the amount (null = leave it) and its own date (null = the sitting's "as of"). */
export type CheckinDraft = { cents: number | null; on: string | null }

export type CheckinWrite = { item: CheckinItem; on: string; cents: number }

/**
 * The rows to save: those with an amount typed, unless it repeats exactly
 * what is already recorded for that day. The same amount on a later day is
 * a real check-in ("still $X as of today") and is saved.
 */
export function checkinWrites(items: readonly CheckinItem[], drafts: Readonly<Record<string, CheckinDraft>>, asOf: string): CheckinWrite[] {
  const out: CheckinWrite[] = []
  for (const item of items) {
    const d = drafts[rowKey(item)]
    if (!d || d.cents === null) continue
    const on = d.on ?? asOf
    if (item.last && item.last.on === on && item.last.cents === d.cents) continue
    out.push({ item, on, cents: d.cents })
  }
  return out
}

/** The existing route each kind saves through. */
export function checkinRequest(w: CheckinWrite): { path: string; body: Record<string, unknown> } {
  switch (w.item.kind) {
    case 'balance':
    case 'cash':
      return { path: '/api/invest/balances', body: { investAccountId: w.item.id, balancedOn: w.on, balanceCents: w.cents } }
    case 'property':
      return { path: `/api/properties/${w.item.id}/valuation`, body: { valuedOn: w.on, valueCents: w.cents } }
    case 'liability':
      return { path: `/api/liabilities/${w.item.id}/balance`, body: { balancedOn: w.on, balanceCents: w.cents } }
  }
}

const WORD: Record<CheckinItem['kind'], [string, string]> = {
  balance: ['balance', 'balances'],
  cash: ['cash balance', 'cash balances'],
  property: ['home value', 'home values'],
  liability: ['loan balance', 'loan balances'],
}

/** "3 balances and a home value", "1 loan balance": what a set of saved rows was, in words. */
export function checkinWhat(ws: readonly Pick<CheckinWrite, 'item'>[]): string {
  const n = new Map<CheckinItem['kind'], number>()
  for (const w of ws) n.set(w.item.kind, (n.get(w.item.kind) ?? 0) + 1)
  const parts = (['balance', 'cash', 'property', 'liability'] as const)
    .filter((k) => n.has(k))
    .map((k) => {
      const c = n.get(k)!
      return c === 1 ? `${/^[aeiou]/.test(WORD[k][0]) ? 'an' : 'a'} ${WORD[k][0]}` : `${c} ${WORD[k][1]}`
    })
  if (parts.length <= 1) return parts[0] ?? 'nothing'
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The sitting's one toast: everything saved, or how much did and what didn't. */
export function checkinSummary(saved: readonly CheckinWrite[], failed: readonly { write: CheckinWrite; message: string }[]): { ok: boolean; text: string; detail?: string } {
  if (failed.length === 0) return { ok: true, text: `Checked in ${checkinWhat(saved)} · net worth updated` }
  return {
    ok: false,
    text: saved.length === 0 ? `Couldn’t save the check-in` : `Saved ${checkinWhat(saved)} — ${failed.length} didn’t save`,
    detail: failed.map((f) => `${f.write.item.name}: ${f.message}`).join(' · '),
  }
}
