/**
 * Monte Carlo over the household balance sheet. A projection tool: floats are
 * fine internally, results round to cents at the boundary. All dollar values
 * are real (today's) dollars — use real return assumptions.
 */
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

export function simulate(p: SimParams): SimResult {
  const paths = p.paths ?? 2000
  const rng = mulberry32(p.seed ?? 42)
  const years: number[] = []
  for (let y = p.startYear; y <= p.endYear; y++) years.push(y)
  const n = years.length

  const mean = p.meanReturnMicro / 1_000_000
  const vol = p.volMicro / 1_000_000
  const muLog = Math.log(1 + mean) - (vol * vol) / 2
  const propG = 1 + p.propertyGrowthMicro / 1_000_000
  const loanCents = p.buy ? p.buy.priceCents - Math.max(0, p.buy.cashOutCents - 0) : 0

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

    for (let i = 0; i < n; i++) {
      const year = years[i]!
      if (i > 0) {
        liquid *= Math.exp(muLog + vol * nextNormal())
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
