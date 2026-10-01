import type { AssumptionGroup } from '../shared/checkup-api'
import { CAP_LOSS_LIMIT_CENTS } from '../shared/capgains'
import { formatDollars } from '../shared/money'
import { getCheckupSettings } from './checkup-settings'
import { GIFT_EXCLUSION_2026, RUNWAY_IDLE_MONTHS, RUNWAY_LOW_MONTHS } from './checkup'
import type { DbLike } from './db'
import { DRIFT_MICRO } from './digest'
import { CHARITY_AGI_FLOOR_MICRO, ITEMIZE_VINTAGE, MORTGAGE_DEBT_LIMIT_CENTS, SALT_2026 } from './itemize'
import { ADDL_MEDICARE_RATE_MICRO, ADDL_MEDICARE_WITHHOLD_THRESHOLD, MEDICARE_RATE_MICRO, PAYROLL_VINTAGE, SS_RATE_MICRO, SS_WAGE_BASE_2026 } from './paychecks'
import {
  ADDL_MEDICARE_THRESHOLD,
  FEDERAL_BRACKETS_2026,
  FEDERAL_EST_RULE,
  FEDERAL_LT_THRESHOLDS_2026,
  FEDERAL_STD_DEDUCTION_2026,
  FEDERAL_SUPPLEMENTAL_MICRO,
  getTaxSettings,
  NIIT_RATE_MICRO,
  NIIT_THRESHOLD,
  STATE_TABLES,
  stateEstRule,
  STATES,
  TAX_DATA_VINTAGE,
  type FilingStatus,
} from './tax'

/**
 * Every constant the engine computes with, and where it came from — the
 * Assumptions page. It is the trust story (each number has a source and a
 * vintage) and the annual-update checklist (each vintage says what to bump).
 * Read from the very tables the engine uses, so it can't disagree with them.
 */

const $ = (cents: number) => formatDollars(cents)
const pct = (micro: number) => `${(micro / 10_000).toFixed(2).replace(/\.?0+$/, '')}%`
const FILINGS: { id: FilingStatus; label: string }[] = [
  { id: 'single', label: 'Single' },
  { id: 'mfj', label: 'Married filing jointly' },
  { id: 'mfs', label: 'Married filing separately' },
  { id: 'hoh', label: 'Head of household' },
]
const FILING_NAME = Object.fromEntries(FILINGS.map((f) => [f.id, f.label])) as Record<FilingStatus, string>

function bracketRows(brackets: { upToCents: number | null; rateMicro: number }[]) {
  let from = 0
  return brackets.map((b) => {
    const row = { label: b.upToCents === null ? `Over ${$(from)}` : `${$(from)} – ${$(b.upToCents)}`, value: pct(b.rateMicro) }
    from = b.upToCents ?? from
    return row
  })
}

export function getAssumptions(db: DbLike): AssumptionGroup[] {
  const tax = getTaxSettings(db)
  const filing = tax.filingStatus
  const checkup = getCheckupSettings(db)
  const state = STATES.find((s) => s.code === tax.state)
  const groups: AssumptionGroup[] = [
    {
      id: 'federal-brackets',
      title: `Federal ordinary brackets — ${FILING_NAME[filing]}`,
      vintage: TAX_DATA_VINTAGE,
      source: 'IRS Rev. Proc. 2025-32',
      rows: bracketRows(FEDERAL_BRACKETS_2026[filing]),
      note: 'Taxable income after the deduction. Your filing status is set on Taxes.',
    },
    {
      id: 'federal-deductions',
      title: 'Standard deduction',
      vintage: TAX_DATA_VINTAGE,
      source: 'IRS Rev. Proc. 2025-32',
      rows: FILINGS.map((f) => ({ label: f.label, value: $(FEDERAL_STD_DEDUCTION_2026[f.id]) })),
    },
    {
      id: 'federal-lt',
      title: 'Long-term gains & qualified dividends',
      vintage: TAX_DATA_VINTAGE,
      source: 'IRC §1(h); IRS Rev. Proc. 2025-32',
      rows: FILINGS.map((f) => {
        const [t0, t15] = FEDERAL_LT_THRESHOLDS_2026[f.id]
        return { label: f.label, value: `0% to ${$(t0)} · 15% to ${$(t15)} · 20% above` }
      }),
      note: 'They stack on top of ordinary taxable income. Held more than one year is long-term.',
    },
    {
      id: 'federal-surtaxes',
      title: 'Surtaxes',
      vintage: 'Statutory — not indexed for inflation',
      source: 'IRC §1411 (NIIT), §3101(b)(2) (Additional Medicare Tax)',
      rows: [
        { label: `Net investment income tax (${pct(NIIT_RATE_MICRO)}), MAGI over`, value: FILINGS.map((f) => `${f.id.toUpperCase()} ${$(NIIT_THRESHOLD[f.id])}`).join(' · ') },
        { label: `Additional Medicare Tax (${pct(ADDL_MEDICARE_RATE_MICRO)}), wages over`, value: FILINGS.map((f) => `${f.id.toUpperCase()} ${$(ADDL_MEDICARE_THRESHOLD[f.id])}`).join(' · ') },
        { label: 'Employers withhold the Medicare surtax above', value: `${$(ADDL_MEDICARE_WITHHOLD_THRESHOLD)} per employee` },
      ],
    },
    {
      id: 'payroll',
      title: 'Payroll taxes & withholding',
      vintage: PAYROLL_VINTAGE,
      source: 'SSA 2026 COLA fact sheet; IRS Pub. 15',
      rows: [
        { label: 'Social Security', value: `${pct(SS_RATE_MICRO)} up to ${$(SS_WAGE_BASE_2026)} of wages, per person` },
        { label: 'Medicare', value: `${pct(MEDICARE_RATE_MICRO)} of all wages` },
        { label: 'Supplemental withholding on stock comp (federal)', value: `${pct(FEDERAL_SUPPLEMENTAL_MICRO)} flat (37% above $1M)` },
      ],
    },
    {
      id: 'capital',
      title: 'Capital gains & losses',
      vintage: 'Statutory',
      source: 'IRC §1211(b), §1212(b), §1091, §1222',
      rows: [
        { label: 'Net capital loss against ordinary income', value: `${$(CAP_LOSS_LIMIT_CENTS)} a year; the rest carries forward` },
        { label: 'Wash-sale window', value: '30 days before and after a loss sale, in any account' },
        { label: 'Long-term holding period', value: 'More than one year' },
        { label: 'Crypto held directly', value: 'Property — outside the wash-sale rule under current law' },
      ],
    },
    {
      id: 'itemized',
      title: 'Itemized deductions',
      vintage: ITEMIZE_VINTAGE,
      source: 'IRC §163(h)(3), §164(b)(7), §170(b)(1)(I) as amended by P.L. 119-21',
      rows: [
        { label: 'SALT cap', value: `${$(SALT_2026.capCents)} (half if married filing separately)` },
        { label: 'SALT phase-down', value: `${pct(SALT_2026.phaseoutMicro)} of MAGI over ${$(SALT_2026.phaseoutStartCents)}, never below ${$(SALT_2026.floorCents)}` },
        { label: 'Mortgage debt whose interest counts', value: `${$(MORTGAGE_DEBT_LIMIT_CENTS)} (half if married filing separately)` },
        { label: 'Charitable floor for itemizers', value: `${pct(CHARITY_AGI_FLOOR_MICRO)} of AGI` },
      ],
    },
    {
      id: 'safe-harbor',
      title: 'Estimated-tax safe harbor',
      vintage: TAX_DATA_VINTAGE,
      source: 'IRC §6654(d); Form 1040-ES; FTB Form 540-ES',
      rows: [
        { label: 'Required payment', value: 'Smaller of 90% of this year’s tax and 100% of last year’s' },
        { label: 'After a prior-year AGI over $150,000 ($75,000 MFS)', value: `${pct(FEDERAL_EST_RULE.highIncomePriorMicro)} of last year’s` },
        { label: 'No payments required when the balance due is under', value: $(FEDERAL_EST_RULE.thresholdCents(filing)) },
        { label: 'Federal installments', value: 'Apr 15 · Jun 15 · Sep 15 · Jan 15 — 25% each' },
        ...(() => {
          const rule = state ? stateEstRule(state.code) : null
          return rule
            ? [{ label: `${state!.name} installments`, value: `${rule.weights.join(' / ')}%${rule.assumed ? ' (federal shape assumed)' : ''}` }]
            : []
        })(),
      ],
    },
    {
      id: 'gifts',
      title: 'Gifts',
      vintage: TAX_DATA_VINTAGE,
      source: 'IRC §2503(b); IRS Rev. Proc. 2025-32',
      rows: [{ label: 'Annual exclusion, per recipient', value: $(GIFT_EXCLUSION_2026) }],
    },
  ]

  if (state && state.kind === 'brackets') {
    const t = STATE_TABLES[state.code]!
    groups.splice(1, 0, {
      id: 'state',
      title: `${state.name} brackets — ${FILING_NAME[filing]}`,
      vintage: t.vintage,
      source: `${state.name} revenue department`,
      rows: [...bracketRows(t.brackets[filing]), { label: 'Standard deduction / exemption', value: $(t.deduction[filing]) }],
      note: t.note,
    })
  } else if (state && state.kind === 'flat') {
    groups.splice(1, 0, { id: 'state', title: state.name, vintage: 'Flat-state rates: 2025', source: `${state.name} revenue department`, rows: [{ label: 'Flat rate on taxable income', value: pct(state.rateMicro) }] })
  } else if (state && state.kind === 'custom') {
    groups.splice(1, 0, {
      id: 'state',
      title: state.name,
      vintage: 'Your setting',
      source: 'No bundled table for this state',
      rows: [{ label: 'Marginal rate you entered', value: pct(tax.customStateRateMicro) }],
    })
  }

  groups.push({
    id: 'checkup',
    title: 'Checkup rules',
    vintage: 'Scarab defaults · the concentration threshold is yours',
    source: 'Rules of thumb, stated as rules so they can be checked',
    rows: [
      { label: 'Employer stock flagged above', value: `${pct(checkup.concentrationMicro)} of liquid assets` },
      { label: 'Cash flagged below / above', value: `${RUNWAY_LOW_MONTHS} / ${RUNWAY_IDLE_MONTHS} months of average spending` },
      { label: 'Allocation drift flagged at', value: `${DRIFT_MICRO / 10_000} percentage points over 3 months` },
      { label: 'Recurring price rise flagged at', value: '10% over the typical charge' },
      { label: 'Mortgage-rate trigger', value: '0.25 points under the best saved loan option' },
      { label: 'Gain harvesting assumes a later federal rate of', value: '15%' },
    ],
  })
  return groups
}
