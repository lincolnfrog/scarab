import {
  SUBTYPE_KIND,
  type InvestAccountPatch,
  type InvestAccountRow,
  type InvestKind,
  type InvestSubtype,
  type PortfolioAccount,
  type PortfolioPosition,
} from '../../shared/invest-api'
import { formatQtyMicro } from '../../shared/money'
import { balanceAgeDays, isBalanceStale } from './balanceMath'
import { priceStale } from './priceRefresh'

/**
 * Account types — the cards the add flow starts from — and the small pure
 * rules around an account's profile: the chip it shows, the name it
 * suggests, what a settings form's edit sends, why tracking or the stock-plan
 * flag can't change right now, and what the account strip shows for it.
 * Node-tested; the components only render these.
 */

export type AccountType = {
  subtype: InvestSubtype
  /** The card's title. */
  title: string
  /** One line under it: what it's for, and how Scarab follows it. */
  blurb: string
  /** The short chip on the account strip. */
  chip: string
  /** The word a suggested name ends with ("Fidelity 401(k)", "Schwab brokerage"). */
  nameWord: string
  /** How Scarab follows it unless told otherwise. */
  tracking: 'lots' | 'balance'
  /** Grants vest here: turns the employee-stock-plan tracker on. */
  stockPlan?: boolean
  /** Owned by one person by law (retirement accounts): the owner defaults to someone, not Joint. */
  individual?: boolean
  group: 'retirement' | 'investing' | 'other'
}

export const ACCOUNT_TYPES: readonly AccountType[] = [
  { subtype: '401k', title: '401(k)', blurb: 'Workplace plan · enter the balance from each statement', chip: '401(k)', nameWord: '401(k)', tracking: 'balance', individual: true, group: 'retirement' },
  { subtype: '403b', title: '403(b)', blurb: 'Nonprofit or school plan · balance from statements', chip: '403(b)', nameWord: '403(b)', tracking: 'balance', individual: true, group: 'retirement' },
  { subtype: 'ira', title: 'Traditional IRA', blurb: 'Pre-tax or rollover IRA · trades or balance', chip: 'IRA', nameWord: 'IRA', tracking: 'lots', individual: true, group: 'retirement' },
  { subtype: 'roth_ira', title: 'Roth IRA', blurb: 'After-tax, grows tax-free · trades or balance', chip: 'Roth IRA', nameWord: 'Roth IRA', tracking: 'lots', individual: true, group: 'retirement' },
  { subtype: 'hsa', title: 'HSA', blurb: 'Health savings, invested · balance from statements', chip: 'HSA', nameWord: 'HSA', tracking: 'balance', individual: true, group: 'retirement' },
  { subtype: 'taxable', title: 'Brokerage', blurb: 'Taxable · every sale shapes the tax bill', chip: 'Taxable', nameWord: 'brokerage', tracking: 'lots', group: 'investing' },
  { subtype: 'stock_plan', title: 'Stock plan', blurb: 'Where your employer’s RSUs vest', chip: 'Stock plan', nameWord: 'stock plan', tracking: 'lots', stockPlan: true, individual: true, group: 'investing' },
  { subtype: 'crypto', title: 'Crypto', blurb: 'An exchange or a wallet', chip: 'Crypto', nameWord: 'crypto', tracking: 'lots', group: 'investing' },
  { subtype: 'other', title: 'Something else', blurb: 'An annuity, private shares, a 529…', chip: 'Other', nameWord: 'account', tracking: 'balance', group: 'other' },
]

export const TYPE_GROUPS: readonly { id: AccountType['group']; title: string }[] = [
  { id: 'retirement', title: 'Retirement' },
  { id: 'investing', title: 'Investing' },
  { id: 'other', title: 'Other' },
]

const BY_SUBTYPE = new Map(ACCOUNT_TYPES.map((t) => [t.subtype, t]))
export const accountType = (s: InvestSubtype): AccountType => BY_SUBTYPE.get(s)!

/** What each kind means for tax, in a sentence's words. */
export const KIND_TEXT: Record<InvestKind, { label: string; note: string }> = {
  brokerage: { label: 'Taxable', note: 'Sales here reach the tax bill.' },
  retirement: { label: 'Tax-advantaged', note: 'Sales here never reach the tax bill.' },
  crypto: { label: 'Crypto', note: 'Taxable: sales here reach the tax bill.' },
}

/** The chip an account wears: its type, or — for one written before types existed — what its kind implies. */
export function typeLabel(a: Pick<InvestAccountRow, 'subtype' | 'kind' | 'stock_plan'>): string {
  if (a.subtype) return accountType(a.subtype).chip
  if (a.stock_plan === 1) return 'Stock plan'
  return a.kind === 'brokerage' ? 'Taxable' : a.kind === 'retirement' ? 'Retirement' : 'Crypto'
}

/** The kind a type implies; 'other' keeps the kind chosen for it. */
export const kindFor = (subtype: InvestSubtype, otherKind: InvestKind): InvestKind => SUBTYPE_KIND[subtype] ?? otherKind

/**
 * A name to start from, updated as the details are typed until someone edits
 * it: "Fidelity 401(k)", "Schwab brokerage", "Coinbase", "Max’s Roth IRA"
 * (the owner is named only when the household has more than one person).
 */
export function suggestName(o: { subtype: InvestSubtype; institution: string; owner: string | null; owners: readonly string[] }): string {
  const t = accountType(o.subtype)
  const inst = o.institution.trim()
  const who = o.owner && o.owners.length > 1 ? `${o.owner}’s ` : ''
  let base: string
  if (inst && o.subtype === 'crypto') base = inst
  else if (inst) base = `${inst} ${t.nameWord}`
  else base = t.nameWord === t.nameWord.toLowerCase() ? t.nameWord[0]!.toUpperCase() + t.nameWord.slice(1) : t.nameWord
  const name = `${who}${base}`
  return name.length > 60 ? name.slice(0, 60).trim() : name
}

/** Institutions offered as suggestions (the ones already used come first). */
export const COMMON_INSTITUTIONS: readonly string[] = [
  'Fidelity', 'Vanguard', 'Charles Schwab', 'E*TRADE', 'Morgan Stanley', 'Merrill', 'J.P. Morgan', 'Robinhood',
  'Interactive Brokers', 'Wealthfront', 'Betterment', 'Empower', 'Principal', 'T. Rowe Price', 'TIAA', 'Coinbase',
  'Kraken', 'HealthEquity', 'Shareworks', 'Carta',
]

/**
 * What the last-4 box keeps as it's typed or pasted: letters and digits
 * only, the last four — so "XXXX-XXXX-1234" and "••1234" both become 1234.
 */
export const maskInput = (v: string): string => v.replace(/[^0-9A-Za-z]/g, '').slice(-4).toUpperCase()

/** The owner's initial for the strip's avatar. */
export const ownerInitial = (owner: string): string => (owner.trim()[0] ?? '?').toUpperCase()

/** Which avatar tone a person gets: the household's first two owners have their own; everyone else is neutral. */
export function ownerTone(owner: string, owners: readonly string[]): 1 | 2 | 0 {
  const i = owners.findIndex((o) => o.toLowerCase() === owner.toLowerCase())
  return i === 0 ? 1 : i === 1 ? 2 : 0
}

/** "Fidelity ··1234", "··1234", "Fidelity", or ''. */
export function institutionLine(a: Pick<InvestAccountRow, 'institution' | 'mask'>): string {
  return [a.institution, a.mask ? `··${a.mask}` : null].filter(Boolean).join(' ')
}

/* ---------- the settings form ---------- */

export type AccountForm = {
  name: string
  /** '' = not set (an account from before types): its kind stands in. */
  subtype: InvestSubtype | ''
  kind: InvestKind
  institution: string
  owner: string | null
  mask: string
  stockPlan: boolean
  tracking: 'lots' | 'balance'
}

export function formFromAccount(a: InvestAccountRow): AccountForm {
  return {
    name: a.name,
    subtype: a.subtype ?? '',
    kind: a.kind,
    institution: a.institution ?? '',
    owner: a.owner,
    mask: a.mask ?? '',
    stockPlan: a.stock_plan === 1,
    tracking: a.tracking,
  }
}

/** The kind the form means: a type implies one, except 'other' and "not set", which keep the kind chosen. */
export const formKind = (f: Pick<AccountForm, 'subtype' | 'kind'>): InvestKind => (f.subtype ? kindFor(f.subtype, f.kind) : f.kind)

/** Only what the form changed, in the PATCH's terms ({} when nothing did). Blank text clears. */
export function accountPatch(a: InvestAccountRow, f: AccountForm): InvestAccountPatch {
  const p: InvestAccountPatch = {}
  const name = f.name.trim()
  if (name !== a.name) p.name = name
  const subtype = f.subtype || null
  if (subtype !== a.subtype) p.subtype = subtype
  const kind = formKind(f)
  if (kind !== a.kind) p.kind = kind
  const text = (v: string) => v.trim() || null
  if (text(f.institution) !== a.institution) p.institution = text(f.institution)
  if ((f.owner?.trim() || null) !== a.owner) p.owner = f.owner?.trim() || null
  const mask = text(f.mask)?.toUpperCase() ?? null // the engine strips "••" and masking Xs; this only avoids no-op sends
  if (mask !== a.mask) p.mask = mask
  if (f.tracking !== a.tracking) p.tracking = f.tracking
  if (f.stockPlan !== (a.stock_plan === 1)) p.stockPlan = f.stockPlan
  return p
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

/** Why tracking can't change right now (the engine's guard, said before anyone tries), or null. */
export function trackingLock(a: InvestAccountRow): string | null {
  if (a.tracking === 'lots' && a.counts.trades > 0)
    return `It has ${plural(a.counts.trades, 'trade')}. Tracking by balance would drop them — add a separate balance-tracked account instead.`
  if (a.tracking === 'balance' && a.counts.balances > 0)
    return `It has ${plural(a.counts.balances, 'balance update')}. Tracking trades would drop them from net worth — add a separate account instead.`
  return null
}

/** Why the employee-stock-plan flag can't be turned off right now, or null. */
export function stockPlanLock(a: InvestAccountRow): string | null {
  if (a.stock_plan !== 1) return null
  if (a.counts.unvested > 0) return 'Clear its unvested grants (Grants tab) first.'
  if (a.counts.paychecks > 0) return 'A paycheck on Taxes vests stock comp into it — unlink that first.'
  return null
}

/* ---------- the account strip ---------- */

/**
 * What the strip shows as an account's value: a lots account's holdings plus
 * its cash (when a cash balance is recorded — `cash` is the portfolio's row
 * for it), or a balance account's latest balance; null when there's nothing to show.
 */
export function accountValueCents(a: InvestAccountRow, positions: readonly PortfolioPosition[], cash?: PortfolioAccount): number | null {
  if (a.tracking === 'balance') return a.latest_snapshot?.balance_cents ?? null
  let v = cash?.cash_cents ?? 0
  let held = cash?.cash_cents != null
  for (const p of positions)
    for (const x of p.accounts)
      if (x.invest_account_id === a.id) {
        v += x.value_cents
        held = true
      }
  return held ? v : null
}

/** Why an account's number is old — a balance past 45 days, or a holding with no fresh price — or null. */
export function staleReason(a: InvestAccountRow, positions: readonly PortfolioPosition[], today: string): string | null {
  if (a.tracking === 'balance') {
    const on = a.latest_snapshot?.balanced_on
    return on && isBalanceStale(on, today) ? `balance ${balanceAgeDays(on, today)}d old` : null
  }
  const old = positions.filter((p) => p.accounts.some((x) => x.invest_account_id === a.id) && !p.price_manual && priceStale(p.priced_on, today))
  if (old.length === 0) return null
  const names = old.map((p) => p.symbol)
  return `${names.length <= 2 ? names.join(', ') : `${names.length} holdings`} ${names.length === 1 ? 'has' : 'have'} no fresh price`
}

/** "3 held" or "no holdings yet" — the strip's line under a lots account's value. */
export function heldLine(a: InvestAccountRow, positions: readonly PortfolioPosition[]): string {
  const n = positions.filter((p) => p.accounts.some((x) => x.invest_account_id === a.id)).length
  if (n > 0) return `${n} holding${n === 1 ? '' : 's'}`
  return a.counts.trades > 0 ? 'nothing held now' : 'no holdings yet'
}

/** "120 unvested" for a stock plan's grants. */
export const unvestedLine = (qtyMicro: number): string => `${formatQtyMicro(qtyMicro)} unvested`
