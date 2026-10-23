import type { AssumptionGroup } from '../shared/checkup-api'
import { CAP_LOSS_LIMIT_CENTS } from '../shared/capgains'
import { formatDollars } from '../shared/money'
import { getCheckupSettings } from './checkup-settings'
import { GIFT_EXCLUSION_2026, RUNWAY_IDLE_MONTHS, RUNWAY_LOW_MONTHS } from './checkup'
import type { DbLike } from './db'
import { DRIFT_MICRO } from './digest'
import { SIMTAX_VINTAGE, uniformLifetimePeriod } from './simtax'
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
  LIMITS_2026,
  LIMITS_VINTAGE,
  NIIT_RATE_MICRO,
  NIIT_THRESHOLD,
  ROTH_IRA_PHASEOUT_2026,
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
      note: 'Taxable income after the deduction. Your filing status is set on Taxes. Later years (the two-year view, loss capacity) hold these figures until the next year’s are published and bundled.',
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
      id: 'contributions',
      title: 'Contribution limits',
      vintage: LIMITS_VINTAGE,
      source: 'IRC §402(g), §414(v), §415(c), §219(b), §408A(c)(3), §223(b)',
      rows: [
        { label: '401(k) / 403(b) deferrals, pre-tax + Roth', value: `${$(LIMITS_2026.deferralCents)} per person` },
        { label: 'Catch-up from 50 / for ages 60–63', value: `${$(LIMITS_2026.catchUp50Cents)} / ${$(LIMITS_2026.catchUp60to63Cents)}` },
        { label: 'Catch-ups must be Roth after prior-year wages over', value: $(LIMITS_2026.rothCatchUpWageCents) },
        { label: 'Everything into one plan (§415(c))', value: $(LIMITS_2026.annualAdditionsCents) },
        { label: 'IRA, traditional + Roth', value: `${$(LIMITS_2026.iraCents)} (+${$(LIMITS_2026.iraCatchUpCents)} from 50)` },
        ...FILINGS.map((f) => {
          const [a, b] = ROTH_IRA_PHASEOUT_2026[f.id]
          return { label: `Roth IRA phase-out — ${f.label}`, value: `${$(a)} – ${$(b)}` }
        }),
        { label: 'HSA, self-only / family', value: `${$(LIMITS_2026.hsaSelfCents)} / ${$(LIMITS_2026.hsaFamilyCents)} (+${$(LIMITS_2026.hsaCatchUp55Cents)} from 55)` },
      ],
      note: 'Catch-up ages go by the age reached by Dec 31 — birth years are set on Taxes. Each plan’s deferrals stop at the limit, this year and in next year’s view, which holds these figures until the next year’s are bundled.',
    },
    {
      id: 'retirement',
      title: 'Retirement income (Future)',
      vintage: SIMTAX_VINTAGE,
      source: 'IRC §401(a)(9) as amended by SECURE 2.0 §107; 42 U.S.C. §402(q), §402(w); IRC §86',
      rows: [
        { label: 'RMDs start at', value: '72 if born before 1951 · 73 for 1951–1959 · 75 from 1960' },
        { label: 'Uniform Lifetime divisor at 73 / 75 / 80 / 90', value: [73, 75, 80, 90].map((a) => uniformLifetimePeriod(a)).join(' / ') },
        { label: 'Full retirement age', value: '67 if born 1960 or later (66 + 2 months a year for 1955–1959)' },
        { label: 'Claiming early', value: '−5/9% a month for 36 months, −5/12% a month beyond (62 at FRA 67: 70%)' },
        { label: 'Claiming late', value: '+2/3% a month to 70 (70 at FRA 67: 124%)' },
        { label: 'Social Security taxable, MFJ provisional income', value: 'none under $32,000 · up to 50% to $44,000 · up to 85% above (not indexed)' },
        { label: 'An heir draws inherited traditional money', value: 'over 10 years (the after-tax end)' },
      ],
      note: 'Future holds this year’s brackets constant: the simulation is in today’s dollars and the brackets are indexed.',
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
    vintage: 'Scarab defaults · the concentration and tax-timing thresholds are yours',
    source: 'Rules of thumb, stated as rules so they can be checked',
    rows: [
      { label: 'Employer stock flagged above', value: `${pct(checkup.concentrationMicro)} of liquid assets` },
      {
        label: 'Tax timing flagged at',
        value: `${$(checkup.timingThresholdCents)} of tax — a planned sale the losses expected by its day don’t cover; a harvest worth more before Dec 31 than in January, or the reverse`,
      },
      { label: 'Cash flagged below / above', value: `${RUNWAY_LOW_MONTHS} / ${RUNWAY_IDLE_MONTHS} months of average spending` },
      { label: 'Allocation drift flagged at', value: `${DRIFT_MICRO / 10_000} percentage points over 3 months` },
      { label: 'Recurring price rise flagged at', value: '10% over the typical charge' },
      { label: 'Mortgage-rate trigger', value: '0.25 points under the best saved loan option' },
      { label: 'Gain harvesting assumes a later federal rate of', value: '15%' },
    ],
  })
  return groups
}
