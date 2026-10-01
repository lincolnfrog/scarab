import { HISTORICAL_REAL_RETURNS_MICRO } from './history'
import { bracketTopGross, makeYearTax, rmdStartAge, taxableSocialSecurity, uniformLifetimePeriod } from './simtax'
import type { FilingStatus, TaxSettings } from './tax'

/**
 * Monte Carlo over the household balance sheet. A projection tool: floats are
 * fine internally, results round to cents at the boundary. All dollar values
 * are real (today's) dollars — use real return assumptions.
 */

/**
 * A dated cash flow against the liquid portfolio: a remodel, a sabbatical, an
 * inheritance, a mortgage payoff. Negative = money leaves the portfolio.
 * `untilYear` repeats the amount every year through that year (inclusive).
 */
export type SimEvent = {
  year: number
  amountCents: number
  untilYear?: number
  label?: string
}

/**
 * lognormal — yearly returns drawn from N(mean, σ) in log space (independent
 *   years; the classic fan).
 * historical — yearly returns replay contiguous runs of actual US stock real
 *   returns 1928→ (circular block bootstrap, `blockYears` per run), re-centred
 *   so the draw's arithmetic mean and σ equal the scenario's assumptions. Same
 *   expected return, real sequences: the 1966 and 2000 starts are in there.
 */
export type DrawMode = 'lognormal' | 'historical'

/** How retirement spending is drawn from the three buckets (copilot §4c). */
export type WithdrawalOrder = 'taxable-first' | 'pro-rata' | 'fill-bracket'

/**
 * Future v3: the liquid portfolio as three tax buckets, and the year's tax on
 * what leaves them. Present → `liquidCents` is ignored in favour of the
 * buckets; absent → the one-bucket, untaxed model, unchanged.
 */
export type SimTax = {
  taxableCents: number
  /** Cost basis of the taxable bucket: a sale realizes gain pro rata to (1 − basis / value). */
  taxableBasisCents: number
  traditionalCents: number
  rothCents: number
  /** Of each working year's savings: what goes in pre-tax and to Roth (the rest lands in taxable). */
  traditionalSaveCents: number
  rothSaveCents: number
  filing: FilingStatus
  state: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>
  /** Ordinary income in working years (today's wages and the like): what a conversion or a draw then stacks on. */
  workingOrdinaryCents: number
  order: WithdrawalOrder
  /** For 'fill-bracket': draw traditional up to the top of this federal bracket (e.g. 120000 = 12%). */
  fillBracketMicro: number
  /** Move traditional → Roth each year in [fromYear, toYear]: a fixed amount, or up to the top of a bracket. */
  conversion: null | { fromYear: number; toYear: number; amountCents: number | null; fillBracketMicro: number | null }
  /** Birth year whose age sets RMDs from the traditional bucket; null = none modeled. */
  rmdBirthYear: number | null
  /** Social Security benefits already adjusted for claiming age, from their first year. */
  socialSecurity: { startYear: number; annualCents: number }[]
}

export type SimParams = {
  startYear: number
  endYear: number
  liquidCents: number // investments + cash, everything spendable/investable
  propertyCents: number // current property value
  liabilitiesCents: number // current mortgage balances (positive)
  meanReturnMicro: number // 50000 = 5% real
  volMicro: number // 120000 = 12%
  propertyGrowthMicro: number // 20000 = 2% real
  saveBeforeBuyCents: number // per year, until the purchase
  saveAfterBuyCents: number // per year, purchase → retirement
  buy: null | {
    year: number
    priceCents: number
    cashOutCents: number // down payment + closing leaving liquid
    rateMicro: number
    termMonths: number
  }
  retireYear: number
  retireSpendCents: number // per year, from liquid
  events?: SimEvent[]
  /** Annual drag on the portfolio's return (an advisor's AUM fee): 10000 = 1%. */
  feeMicro?: number
  tax?: SimTax
  draw?: DrawMode
  blockYears?: number // historical mode: run length, default 10
  paths?: number
  seed?: number
}

export type SimResult = {
  years: number[]
  p10: number[]
  p25: number[]
  p50: number[]
  p75: number[]
  p90: number[]
  successPct: number // liquid never exhausted before endYear
  medianEndCents: number
  p10EndCents: number
  /** Taxed runs only: median over paths of the tax paid over the horizon on withdrawals, conversions, RMDs and Social Security. */
  medianLifetimeTaxCents?: number
  /** Taxed runs only: median end balances by bucket. */
  medianEndBuckets?: { taxable: number; traditional: number; roth: number }
  /**
   * Taxed runs only: the median end, net of the tax still owed on the traditional bucket — drawn evenly over
   * ten years, as an heir must under the 10-year rule, at this household's brackets. Taxable gains step up at
   * death and Roth is tax-free, so only traditional money carries a bill. Compares a conversion fairly.
   */
  medianEndAfterTaxCents?: number
}

/** Deterministic RNG so the fan doesn't wiggle between renders. */
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function normalPair(rng: () => number): [number, number] {
  let u = 0
  let v = 0
  while (u === 0) u = rng()
  while (v === 0) v = rng()
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

/** Remaining mortgage balance after n months of a fixed loan. */
function remainingBalance(loanCents: number, rateMicro: number, termMonths: number, monthsElapsed: number): number {
  if (monthsElapsed >= termMonths) return 0
  const r = rateMicro / 1_000_000 / 12
  if (r === 0) return Math.round(loanCents * (1 - monthsElapsed / termMonths))
  const pow = Math.pow(1 + r, termMonths)
  const powE = Math.pow(1 + r, monthsElapsed)
  return Math.round((loanCents * (pow - powE)) / (pow - 1))
}

const HIST = HISTORICAL_REAL_RETURNS_MICRO.map((m) => m / 1_000_000)
const HIST_MEAN = HIST.reduce((s, r) => s + r, 0) / HIST.length
const HIST_SD = Math.sqrt(HIST.reduce((s, r) => s + (r - HIST_MEAN) ** 2, 0) / HIST.length)

/**
 * Growth factors for one path in historical mode: blocks of consecutive
 * years starting at random points in the record (wrapping at the end), each
 * year z-scored against the record and re-expressed at the scenario's
 * mean/σ. Floored so a rescaled 1931 can't take more than the portfolio.
 */
function historicalFactors(rng: () => number, count: number, mean: number, vol: number, block: number): number[] {
  const out: number[] = []
  const H = HIST.length
  while (out.length < count) {
    const start = Math.floor(rng() * H)
    for (let j = 0; j < block && out.length < count; j++) {
      const z = (HIST[(start + j) % H]! - HIST_MEAN) / HIST_SD
      out.push(Math.max(0.05, 1 + mean + z * vol))
    }
  }
  return out
}

/** Cash flows hitting the liquid portfolio in a given year. */
function eventsIn(events: SimEvent[] | undefined, year: number): number {
  if (!events) return 0
  let sum = 0
  for (const e of events) if (year >= e.year && year <= (e.untilYear ?? e.year)) sum += e.amountCents
  return sum
}

export function simulate(p: SimParams): SimResult {
  if (p.tax) return simulateTaxed(p, p.tax)
  const paths = p.paths ?? 2000
  const rng = mulberry32(p.seed ?? 42)
  const historical = p.draw === 'historical'
  const block = Math.max(1, p.blockYears ?? 10)
  const years: number[] = []
  for (let y = p.startYear; y <= p.endYear; y++) years.push(y)
  const n = years.length

  const mean = p.meanReturnMicro / 1_000_000
  const vol = p.volMicro / 1_000_000
  const muLog = Math.log(1 + mean) - (vol * vol) / 2
  const propG = 1 + p.propertyGrowthMicro / 1_000_000
  const loanCents = p.buy ? p.buy.priceCents - Math.max(0, p.buy.cashOutCents - 0) : 0
  const fee = (p.feeMicro ?? 0) / 1_000_000

  const totalsByYear: number[][] = Array.from({ length: n }, () => new Array<number>(paths))
  let successes = 0
  let spare: number | null = null
  const nextNormal = () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    const [a, b] = normalPair(rng)
    spare = b
    return a
  }

  for (let k = 0; k < paths; k++) {
    let liquid = p.liquidCents
    let property = p.propertyCents
    let liabilities = p.liabilitiesCents
    let newHome = 0
    let newLoan = 0
    let ok = true
    const factors = historical ? historicalFactors(rng, n - 1, mean, vol, block) : null

    for (let i = 0; i < n; i++) {
      const year = years[i]!
      if (i > 0) {
        liquid *= factors ? factors[i - 1]! : Math.exp(muLog + vol * nextNormal())
        if (fee) liquid *= 1 - fee
        property *= propG
        newHome *= propG
        if (p.buy && year > p.buy.year)
          newLoan = remainingBalance(loanCents, p.buy.rateMicro, p.buy.termMonths, (year - p.buy.year) * 12)
        if (year <= p.retireYear) liquid += p.buy && year > p.buy.year ? p.saveAfterBuyCents : p.saveBeforeBuyCents
        else liquid -= p.retireSpendCents
      }
      if (p.buy && year === p.buy.year) {
        liquid -= p.buy.cashOutCents
        newHome = p.buy.priceCents
        newLoan = loanCents
      }
      liquid += eventsIn(p.events, year)
      if (liquid < 0 && year > p.retireYear) ok = false // ran out in retirement
      totalsByYear[i]![k] = liquid + property + newHome - liabilities - newLoan
    }
    if (ok) successes++
  }

  const pick = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]!
  const out: SimResult = {
    years,
    p10: [],
    p25: [],
    p50: [],
    p75: [],
    p90: [],
    successPct: Math.round((successes / paths) * 100),
    medianEndCents: 0,
    p10EndCents: 0,
  }
  for (let i = 0; i < n; i++) {
    const sorted = totalsByYear[i]!.slice().sort((a, b) => a - b)
    out.p10.push(Math.round(pick(sorted, 0.1)))
    out.p25.push(Math.round(pick(sorted, 0.25)))
    out.p50.push(Math.round(pick(sorted, 0.5)))
    out.p75.push(Math.round(pick(sorted, 0.75)))
    out.p90.push(Math.round(pick(sorted, 0.9)))
  }
  out.medianEndCents = out.p50[n - 1]!
  out.p10EndCents = out.p10[n - 1]!
  return out
}

/**
 * The three-bucket, taxed model. Same draws, same seed and same balance-sheet
 * mechanics as the one-bucket model (property, the purchase and its loan,
 * events); what changes is where money comes from and what that costs.
 *
 * Each year, after growth: working years add savings (pre-tax and Roth parts
 * to their buckets, the rest to taxable at cost); then the year's cash needs
 * (retirement spending, the down payment, outflow events) are met first from
 * Social Security and any RMD, then from the buckets in the chosen order —
 * grossed up so the tax on what is drawn is drawn too. Traditional money is
 * ordinary income; a taxable sale realizes gain pro rata to the bucket's
 * basis; Roth is free. A conversion moves traditional to Roth and its tax is
 * paid from the year's draw. Cash left over (an RMD bigger than the need)
 * goes back to taxable. The tax counted is what the simulated flows add on
 * top of working-year wages, which the savings figures are already net of.
 */
function simulateTaxed(p: SimParams, t: SimTax): SimResult {
  const paths = p.paths ?? 2000
  const rng = mulberry32(p.seed ?? 42)
  const historical = p.draw === 'historical'
  const block = Math.max(1, p.blockYears ?? 10)
  const years: number[] = []
  for (let y = p.startYear; y <= p.endYear; y++) years.push(y)
  const n = years.length
  const mean = p.meanReturnMicro / 1_000_000
  const vol = p.volMicro / 1_000_000
  const muLog = Math.log(1 + mean) - (vol * vol) / 2
  const propG = 1 + p.propertyGrowthMicro / 1_000_000
  const loanCents = p.buy ? p.buy.priceCents - Math.max(0, p.buy.cashOutCents - 0) : 0
  const fee = (p.feeMicro ?? 0) / 1_000_000
  const yearTax = makeYearTax(t.filing, t.state)
  const fillTop = t.order === 'fill-bracket' ? bracketTopGross(t.filing, t.fillBracketMicro) : null
  const convTop = t.conversion?.fillBracketMicro != null ? bracketTopGross(t.filing, t.conversion.fillBracketMicro) : null
  const rmdAge = t.rmdBirthYear === null ? null : rmdStartAge(t.rmdBirthYear)

  const totalsByYear: number[][] = Array.from({ length: n }, () => new Array<number>(paths))
  const lifetimeTax = new Array<number>(paths)
  const endTaxable = new Array<number>(paths)
  const endTrad = new Array<number>(paths)
  const endRoth = new Array<number>(paths)
  const endAfterTax = new Array<number>(paths)
  let successes = 0
  let spare: number | null = null
  const nextNormal = () => {
    if (spare !== null) {
      const s = spare
      spare = null
      return s
    }
    const [a, b] = normalPair(rng)
    spare = b
    return a
  }

  for (let k = 0; k < paths; k++) {
    let taxable = t.taxableCents
    let basis = Math.min(t.taxableBasisCents, Math.max(0, t.taxableCents))
    let trad = t.traditionalCents
    let roth = t.rothCents
    let property = p.propertyCents
    const liabilities = p.liabilitiesCents
    let newHome = 0
    let newLoan = 0
    let ok = true
    let paidTax = 0
    const factors = historical ? historicalFactors(rng, n - 1, mean, vol, block) : null

    for (let i = 0; i < n; i++) {
      const year = years[i]!
      const working = year <= p.retireYear
      let need = 0 // cash the year must find (net of tax)
      if (i > 0) {
        let g = factors ? factors[i - 1]! : Math.exp(muLog + vol * nextNormal())
        if (fee) g *= 1 - fee
        taxable *= g
        trad *= g
        roth *= g
        property *= propG
        newHome *= propG
        if (p.buy && year > p.buy.year) newLoan = remainingBalance(loanCents, p.buy.rateMicro, p.buy.termMonths, (year - p.buy.year) * 12)
        if (working) {
          const save = p.buy && year > p.buy.year ? p.saveAfterBuyCents : p.saveBeforeBuyCents
          const pre = Math.min(save, t.traditionalSaveCents)
          const ro = Math.min(save - pre, t.rothSaveCents)
          trad += pre
          roth += ro
          taxable += save - pre - ro
          basis += save - pre - ro
        } else need += p.retireSpendCents
      }
      if (p.buy && year === p.buy.year) {
        need += p.buy.cashOutCents
        newHome = p.buy.priceCents
        newLoan = loanCents
      }
      const ev = eventsIn(p.events, year)
      if (ev >= 0) {
        taxable += ev
        basis += ev
      } else need -= ev

      // Cash that arrives whether or not it's needed: Social Security and the RMD.
      let ss = 0
      for (const b of t.socialSecurity) if (year >= b.startYear) ss += b.annualCents
      let rmd = 0
      if (rmdAge !== null && t.rmdBirthYear !== null && trad > 0) {
        const age = year - t.rmdBirthYear
        if (age >= rmdAge) rmd = trad / uniformLifetimePeriod(age)
      }
      trad -= rmd
      const baseOrd = working ? t.workingOrdinaryCents : 0
      const baseTax = working ? yearTax(baseOrd, 0) : 0

      // A conversion: fixed, or up to the top of a bracket over what the year already has as ordinary income.
      let conv = 0
      const c = t.conversion
      if (c && year >= c.fromYear && year <= c.toYear && trad > 0) {
        if (c.amountCents !== null) conv = Math.min(trad, c.amountCents)
        else if (convTop !== null) {
          const ssTaxable = taxableSocialSecurity(ss, baseOrd + rmd, t.filing)
          conv = Math.min(trad, Math.max(0, convTop - baseOrd - rmd - ssTaxable))
        }
        trad -= conv
        roth += conv
      }

      // Draw what the year needs, grossed up for its own tax. A few rounds converge (each adds tax on tax at < 100%).
      const fixedOrd = baseOrd + rmd + conv
      let fromTaxable = 0
      let fromTrad = 0
      let fromRoth = 0
      let tax = 0
      const gainShare = taxable > 0 ? Math.max(0, 1 - basis / taxable) : 0
      for (let round = 0; round < 6; round++) {
        let gross = Math.max(0, need + tax - ss - rmd)
        fromTaxable = 0
        fromTrad = 0
        fromRoth = 0
        const tx = Math.max(0, taxable)
        const tr = Math.max(0, trad)
        const ro = Math.max(0, roth)
        if (t.order === 'pro-rata') {
          const pool = tx + tr + ro
          if (pool > 0) {
            const f = Math.min(1, gross / pool)
            fromTaxable = tx * f
            fromTrad = tr * f
            fromRoth = ro * f
            gross -= fromTaxable + fromTrad + fromRoth
          }
        } else {
          if (t.order === 'fill-bracket' && fillTop !== null) {
            const ssTaxable = taxableSocialSecurity(ss, fixedOrd, t.filing)
            fromTrad = Math.min(tr, gross, Math.max(0, fillTop - fixedOrd - ssTaxable))
            gross -= fromTrad
          }
          const a = Math.min(tx, gross)
          fromTaxable = a
          gross -= a
          const b = Math.min(tr - fromTrad, gross)
          fromTrad += b
          gross -= b
          const r = Math.min(ro, gross)
          fromRoth = r
          gross -= r
        }
        // Whatever no bucket covers comes out of taxable anyway: the shortfall that fails a retired path.
        fromTaxable += gross
        const ordinary = fixedOrd + fromTrad
        const ltGain = Math.max(0, Math.min(fromTaxable, tx)) * gainShare
        const ssTaxable = taxableSocialSecurity(ss, ordinary + ltGain, t.filing)
        const next = yearTax(ordinary + ssTaxable, ltGain) - baseTax
        if (Math.abs(next - tax) < 1) {
          tax = next
          break
        }
        tax = next
      }
      const soldBasis = taxable > 0 ? Math.min(basis, (Math.min(fromTaxable, Math.max(0, taxable)) / taxable) * basis) : 0
      taxable -= fromTaxable
      basis = Math.max(0, basis - soldBasis)
      trad -= fromTrad
      roth -= fromRoth
      // Cash in beyond the need and its tax (a large RMD, Social Security) is reinvested at cost.
      const leftover = ss + rmd + fromTaxable + fromTrad + fromRoth - need - tax
      if (leftover > 0.5) {
        taxable += leftover
        basis += leftover
      }
      paidTax += Math.max(0, tax)
      if (taxable < 0 && !working) ok = false // ran out in retirement
      totalsByYear[i]![k] = taxable + trad + roth + property + newHome - liabilities - newLoan
    }
    if (ok) successes++
    lifetimeTax[k] = paidTax
    endTaxable[k] = taxable
    endTrad[k] = trad
    endRoth[k] = roth
    endAfterTax[k] = totalsByYear[n - 1]![k]! - (trad > 0 ? 10 * yearTax(trad / 10, 0) : 0)
  }

  const pick = (arr: number[], q: number) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]!
  const med = (arr: number[]) => Math.round(pick(arr.slice().sort((a, b) => a - b), 0.5))
  const out: SimResult = {
    years,
    p10: [],
    p25: [],
    p50: [],
    p75: [],
    p90: [],
    successPct: Math.round((successes / paths) * 100),
    medianEndCents: 0,
    p10EndCents: 0,
    medianLifetimeTaxCents: med(lifetimeTax),
    medianEndBuckets: { taxable: med(endTaxable), traditional: med(endTrad), roth: med(endRoth) },
    medianEndAfterTaxCents: med(endAfterTax),
  }
  for (let i = 0; i < n; i++) {
    const sorted = totalsByYear[i]!.slice().sort((a, b) => a - b)
    out.p10.push(Math.round(pick(sorted, 0.1)))
    out.p25.push(Math.round(pick(sorted, 0.25)))
    out.p50.push(Math.round(pick(sorted, 0.5)))
    out.p75.push(Math.round(pick(sorted, 0.75)))
    out.p90.push(Math.round(pick(sorted, 0.9)))
  }
  out.medianEndCents = out.p50[n - 1]!
  out.p10EndCents = out.p10[n - 1]!
  return out
}

/**
 * The crossing date: the earliest retirement year at which the plan still
 * succeeds with at least `thresholdPct` odds (everything else held fixed).
 * null when no year before endYear clears the bar. A linear scan — each
 * candidate is one cheap simulation with the same seed, so the answer is
 * stable between renders.
 */
export function crossingYear(p: SimParams, thresholdPct = 90): number | null {
  const paths = Math.min(p.paths ?? 2000, 1000)
  for (let y = p.startYear + 1; y < p.endYear; y++) {
    const r = simulate({ ...p, retireYear: y, paths })
    if (r.successPct >= thresholdPct) return y
  }
  return null
}

export type DecisionPrice = {
  successBeforePct: number
  successAfterPct: number
  medianEndBeforeCents: number
  medianEndAfterCents: number
  /** The event compounded to `atYear` at the scenario's mean real return — its opportunity cost. */
  futureValueCents: number
  atYear: number
}

/** What one dated cash flow does to a plan: the "this $80k remodel is $310k at 65" number. */
export function priceDecision(p: SimParams, event: SimEvent, atYear = p.retireYear): DecisionPrice {
  const before = simulate(p)
  const after = simulate({ ...p, events: [...(p.events ?? []), event] })
  const g = 1 + p.meanReturnMicro / 1_000_000
  const last = event.untilYear ?? event.year
  let fv = 0
  for (let y = event.year; y <= last; y++) fv += event.amountCents * Math.pow(g, Math.max(0, atYear - y))
  return {
    successBeforePct: before.successPct,
    successAfterPct: after.successPct,
    medianEndBeforeCents: before.medianEndCents,
    medianEndAfterCents: after.medianEndCents,
    futureValueCents: Math.round(fv),
    atYear,
  }
}
