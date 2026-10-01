// The Checkup contract: what /api/checkup answers. engine/checkup.ts builds it
// (with engine/itemize.ts and engine/tax.ts); the Checkup screen, the
// Dashboard echo and src/ui/Finding.tsx consume it and never re-declare it.

/** The fixed last line of every finding (src/ui/Finding.tsx renders it; nothing may drop it). */
export const NOT_ADVICE = 'An estimate, not advice — verify before acting.'

/** Where a finding's action points: a screen, an optional section, optional hash-safe params (src/router.ts). */
export type FindingLink = { screen: string; rest?: string[]; params?: Record<string, string | number> }

/**
 * What kind of thing a finding is about. Wording on the card only — never a
 * status colour: green and red stay reserved for gains and losses.
 */
export type FindingTone = 'risk' | 'saving' | 'heads-up'

export type FindingKind =
  | 'concentration'
  | 'runway-low'
  | 'idle-cash'
  | 'itemize'
  | 'give-shares'
  | 'gain-harvest'
  | 'loss-harvest'
  | 'safe-harbor'
  | 'addl-medicare'
  | 'allocation-drift'
  | 'price-creep'
  | 'mortgage-rate'
  | 'deferral-room'
  | 'match-stops'
  | 'match-unclaimed'
  | 'deferral-excess'
  | 'hsa-room'
  | 'backdoor-roth'
  | 'asset-location'

/**
 * One derived observation. Every finding carries the five parts the Finding
 * primitive renders — the rule (with its citation and the vintage of the
 * numbers behind it), the household's inputs, the arithmetic, what it leaves
 * out — plus the fixed "an estimate, not advice" line the component adds.
 * Nothing here is stored: it is recomputed from the ledger on every read.
 */
export type Finding = {
  /** Stable across reads while the finding says the same thing ('concentration:GOOG'); the seen mark keys on it. */
  id: string
  kind: FindingKind
  tone: FindingTone
  /** One line: what is true. */
  title: string
  /** The dollars at stake, as `impactLabel` defines them for this finding; the list sorts on it. 0 when unpriced. */
  impactCents: number
  impactLabel: string
  rule: { text: string; cite: string; vintage: string }
  inputs: { label: string; value: string }[]
  math: string[]
  leavesOut: string[]
  /** Where the facts behind it live (each finding keeps its home card). */
  action: { label: string; to: FindingLink } | null
  /** Not in the reader's seen mark: new since they last marked the Checkup seen. */
  isNew: boolean
}

/** Room left in the federal ordinary bracket and the long-term bands this year. */
export type BracketHeadroom = {
  year: number
  filing: string
  /** Whether wages (paychecks or the salary setting) are entered — without them every figure here is too low. */
  wagesEntered: boolean
  ordinaryTaxableCents: number
  /** The ordinary brackets for this filing status: upper edge (null = no top) and rate. */
  brackets: { upToCents: number | null; rateMicro: number }[]
  /** The bracket the last dollar of ordinary taxable income lands in. */
  bracketIndex: number
  /** Room before the next bracket starts; null in the top bracket. */
  roomCents: number | null
  /** Long-term gains + qualified dividends stack on top of ordinary taxable income. */
  ltTaxableCents: number
  lt0TopCents: number
  lt15TopCents: number
  /** Room left in the 0% / 15% long-term bands once this year's gains are stacked. */
  lt0RoomCents: number
  lt15RoomCents: number
  vintage: string
}

export type CalendarItem = {
  on: string // yyyy-mm-dd
  title: string
  detail: string
  /** An amount due or at stake, when there is one. */
  cents: number | null
  to: FindingLink | null
}

export type CheckupSettings = {
  /** Employer stock above this share of liquid assets is a finding (micro; default 10%). */
  concentrationMicro: number
  /** Category roles. null = guess from the category names; 0 = none; otherwise a category id. */
  charityCategoryId: number | null
  propertyTaxCategoryId: number | null
  giftCategoryId: number | null
}

/** A category role as resolved for this read: which category (if any), and whether it was guessed from its name. */
export type ResolvedRole = { id: number; name: string; guessed: boolean } | null

export type Checkup = {
  today: string
  findings: Finding[]
  headroom: BracketHeadroom
  calendar: CalendarItem[]
  settings: CheckupSettings
  roles: { charity: ResolvedRole; propertyTax: ResolvedRole; gift: ResolvedRole }
  /** When this reader last marked the Checkup seen (app_meta datetime), or null. */
  seenAt: string | null
}

/** One block of the Assumptions page: a table of constants with where they come from. */
export type AssumptionGroup = {
  id: string
  title: string
  vintage: string
  source: string
  rows: { label: string; value: string }[]
  note?: string
}
