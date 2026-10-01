import { resolveBuckets, type Buckets } from './buckets'
import { computeContributions } from './contributions'
import type { DbLike } from './db'
import { listPeople } from './people'
import { ApiError, getGoal, getNetworth } from './services'
import { claimFactorMicro, SIMTAX_VINTAGE } from './simtax'
import {
  crossingYear,
  priceDecision,
  simulate,
  type DecisionPrice,
  type DrawMode,
  type SimEvent,
  type SimParams,
  type SimResult,
  type SimTax,
  type WithdrawalOrder,
} from './simulate'
import { FEDERAL_BRACKETS_2026, taxYear, type FilingStatus, type TaxSettings } from './tax'

/**
 * The decision engine: named scenarios, compared side by side.
 *
 * A scenario is a knob-set — the assumptions a person can change. Everything
 * else (today's balance sheet, the dream-home price and loan terms) is
 * resolved from the ledger at read time, so a scenario saved in March still
 * runs against September's numbers. Exactly one scenario is the baseline;
 * every other one is reported as a delta against it.
 */

export type ScenarioParams = {
  meanReturnMicro: number
  volMicro: number
  propertyGrowthMicro: number
  saveBeforeBuyCents: number
  saveAfterBuyCents: number
  buyEnabled: boolean
  buyYear: number
  retireYear: number
  retireSpendCents: number
  endYear: number
  events: SimEvent[]
  /** Future v3 (copilot §4c): run the three tax buckets and tax every year's flows. */
  taxModel: boolean
  withdrawalOrder: WithdrawalOrder
  /** 'fill-bracket': draw traditional up to the top of this federal bracket. */
  fillBracketMicro: number
  /** Traditional → Roth each year of a window: a fixed amount, or up to the top of a bracket. */
  conversion: null | { fromYear: number; toYear: number; amountCents: number | null; fillBracketMicro: number | null }
  /** Per person: the benefit at full retirement age (from the SSA statement, a year) and the age they claim. */
  socialSecurity: { name: string; fraBenefitCents: number; claimAge: number }[]
  /** The advisor counterfactual: this AUM fee as a drag on returns, run alongside (never in the plan itself). */
  advisorFeeMicro: number
  /** An HSA counts as Roth (medical spending usually uses it tax-free) or, false, as traditional. */
  hsaAsRoth: boolean
}

export type Scenario = {
  id: number
  name: string
  isBaseline: boolean
  sort: number
  params: ScenarioParams
}

type Row = { id: number; name: string; params: string; is_baseline: number; sort: number }

const bad = (msg: string): never => {
  throw new ApiError(400, msg)
}
const notFound = (msg: string): never => {
  throw new ApiError(404, msg)
}

export function defaultParams(today: string): ScenarioParams {
  const y = Number(today.slice(0, 4))
  return {
    meanReturnMicro: 50_000,
    volMicro: 120_000,
    propertyGrowthMicro: 20_000,
    saveBeforeBuyCents: 15_000_000, // $150k
    saveAfterBuyCents: 9_000_000, // $90k
    buyEnabled: true,
    buyYear: y + 1,
    retireYear: y + 22,
    retireSpendCents: 18_000_000, // $180k
    endYear: y + 30,
    events: [],
    taxModel: true,
    withdrawalOrder: 'taxable-first',
    fillBracketMicro: 120_000,
    conversion: null,
    socialSecurity: [],
    advisorFeeMicro: 10_000,
    hsaAsRoth: true,
  }
}

const ORDERS: readonly WithdrawalOrder[] = ['taxable-first', 'pro-rata', 'fill-bracket']
const BRACKET_RATES = new Set(FEDERAL_BRACKETS_2026.mfj.filter((b) => b.upToCents !== null).map((b) => b.rateMicro))

const isInt = (v: unknown) => Number.isSafeInteger(v)

/** Validate + normalize a params object; partial input is merged over `base`. */
export function normalizeParams(input: unknown, base: ScenarioParams): ScenarioParams {
  const b = (input ?? {}) as Partial<Record<keyof ScenarioParams, unknown>>
  const out: ScenarioParams = { ...base, events: [...base.events] }
  const ints: (keyof ScenarioParams)[] = [
    'meanReturnMicro',
    'volMicro',
    'propertyGrowthMicro',
    'saveBeforeBuyCents',
    'saveAfterBuyCents',
    'buyYear',
    'retireYear',
    'retireSpendCents',
    'endYear',
  ]
  for (const k of ints) {
    if (b[k] === undefined) continue
    if (!isInt(b[k])) bad(`${k} must be an integer`)
    ;(out as unknown as Record<string, unknown>)[k] = b[k]
  }
  if (b.buyEnabled !== undefined) out.buyEnabled = Boolean(b.buyEnabled)
  if (b.events !== undefined) {
    const list = b.events
    if (!Array.isArray(list)) bad('events must be an array')
    out.events = (list as unknown[]).map((e: unknown) => {
      const ev = (e ?? {}) as Partial<SimEvent>
      if (!isInt(ev.year) || !isInt(ev.amountCents)) bad('event year and amountCents must be integers')
      if (ev.untilYear !== undefined && ev.untilYear !== null && !isInt(ev.untilYear)) bad('event untilYear must be an integer')
      const label = typeof ev.label === 'string' ? ev.label.trim().slice(0, 80) : ''
      const o: SimEvent = { year: ev.year as number, amountCents: ev.amountCents as number }
      if (isInt(ev.untilYear) && (ev.untilYear as number) > o.year) o.untilYear = ev.untilYear as number
      if (label) o.label = label
      return o
    })
  }
  if (b.taxModel !== undefined) out.taxModel = Boolean(b.taxModel)
  if (b.hsaAsRoth !== undefined) out.hsaAsRoth = Boolean(b.hsaAsRoth)
  if (b.withdrawalOrder !== undefined) {
    if (!ORDERS.includes(b.withdrawalOrder as WithdrawalOrder)) bad(`withdrawalOrder must be one of ${ORDERS.join(', ')}`)
    out.withdrawalOrder = b.withdrawalOrder as WithdrawalOrder
  }
  if (b.fillBracketMicro !== undefined) {
    if (!BRACKET_RATES.has(b.fillBracketMicro as number)) bad('fillBracketMicro must be a federal bracket rate below the top one')
    out.fillBracketMicro = b.fillBracketMicro as number
  }
  if (b.advisorFeeMicro !== undefined) {
    if (!isInt(b.advisorFeeMicro) || (b.advisorFeeMicro as number) < 0 || (b.advisorFeeMicro as number) > 50_000)
      bad('advisorFeeMicro must be an integer from 0 to 50000 (5%)')
    out.advisorFeeMicro = b.advisorFeeMicro as number
  }
  if (b.conversion !== undefined) {
    const c = b.conversion as Partial<NonNullable<ScenarioParams['conversion']>> | null
    if (c === null) out.conversion = null
    else {
      if (!isInt(c.fromYear) || !isInt(c.toYear) || (c.toYear as number) < (c.fromYear as number)) bad('a conversion needs fromYear ≤ toYear')
      const amount = c.amountCents ?? null
      const fill = c.fillBracketMicro ?? null
      if ((amount === null) === (fill === null)) bad('a conversion is either a yearly amount or a bracket to fill, not both')
      if (amount !== null && (!isInt(amount) || amount <= 0)) bad('conversion amountCents must be a positive integer')
      if (fill !== null && !BRACKET_RATES.has(fill)) bad('conversion fillBracketMicro must be a federal bracket rate below the top one')
      out.conversion = { fromYear: c.fromYear as number, toYear: c.toYear as number, amountCents: amount, fillBracketMicro: fill }
    }
  }
  if (b.socialSecurity !== undefined) {
    if (!Array.isArray(b.socialSecurity)) bad('socialSecurity must be an array')
    const seen = new Set<string>()
    out.socialSecurity = (b.socialSecurity as Partial<ScenarioParams['socialSecurity'][number]>[]).map((x) => {
      const name = typeof x?.name === 'string' ? x.name.trim().slice(0, 40) : ''
      if (!name) bad('each Social Security entry needs a name')
      if (seen.has(name.toLowerCase())) bad(`${name} has two Social Security entries`)
      seen.add(name.toLowerCase())
      if (!isInt(x.fraBenefitCents) || (x.fraBenefitCents as number) < 0) bad('fraBenefitCents must be a non-negative integer')
      if (!isInt(x.claimAge) || (x.claimAge as number) < 62 || (x.claimAge as number) > 70) bad('claimAge must be 62 to 70')
      return { name, fraBenefitCents: x.fraBenefitCents as number, claimAge: x.claimAge as number }
    })
  }
  if (out.volMicro < 0) bad('volMicro must be ≥ 0')
  if (out.endYear <= out.retireYear) bad('endYear must be after retireYear')
  if (out.retireSpendCents < 0 || out.saveBeforeBuyCents < 0 || out.saveAfterBuyCents < 0) bad('amounts must be ≥ 0')
  return out
}

function rowToScenario(r: Row, today: string): Scenario {
  let params: ScenarioParams
  try {
    params = normalizeParams(JSON.parse(r.params), defaultParams(today))
  } catch {
    params = defaultParams(today)
  }
  return { id: r.id, name: r.name, isBaseline: r.is_baseline === 1, sort: r.sort, params }
}

/**
 * All scenarios, baseline first. An empty table gets a Baseline seeded from
 * the defaults so the screen always has something to run — that row is the
 * only write a read ever performs, and only once.
 */
export function listScenarios(db: DbLike, today: string): Scenario[] {
  let rows = db.prepare('SELECT id, name, params, is_baseline, sort FROM scenarios ORDER BY is_baseline DESC, sort, id').all() as Row[]
  if (rows.length === 0) {
    db.prepare('INSERT INTO scenarios (name, params, is_baseline, sort) VALUES (?, ?, 1, 0)').run(
      'Baseline',
      JSON.stringify(defaultParams(today)),
    )
    rows = db.prepare('SELECT id, name, params, is_baseline, sort FROM scenarios ORDER BY is_baseline DESC, sort, id').all() as Row[]
  }
  return rows.map((r) => rowToScenario(r, today))
}

export function createScenario(
  db: DbLike,
  b: { name?: string; params?: unknown; cloneFromId?: number },
  today: string,
): Scenario {
  const name = (b.name ?? '').trim()
  if (!name) bad('name required')
  let base = defaultParams(today)
  if (b.cloneFromId !== undefined) {
    const src = db.prepare('SELECT id, name, params, is_baseline, sort FROM scenarios WHERE id = ?').get(b.cloneFromId) as
      | Row
      | undefined
    if (!src) notFound('no such scenario to clone')
    base = rowToScenario(src!, today).params
  }
  const params = normalizeParams(b.params, base)
  const count = (db.prepare('SELECT count(*) AS n FROM scenarios').get() as { n: number }).n
  const maxSort = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM scenarios').get() as { m: number }).m
  const r = db
    .prepare('INSERT INTO scenarios (name, params, is_baseline, sort) VALUES (?, ?, ?, ?)')
    .run(name.slice(0, 60), JSON.stringify(params), count === 0 ? 1 : 0, maxSort + 1)
  return { id: Number(r.lastInsertRowid), name: name.slice(0, 60), isBaseline: count === 0, sort: maxSort + 1, params }
}

export function updateScenario(
  db: DbLike,
  id: number,
  b: { name?: string; params?: unknown; isBaseline?: boolean },
  today: string,
): Scenario {
  const row = db.prepare('SELECT id, name, params, is_baseline, sort FROM scenarios WHERE id = ?').get(id) as Row | undefined
  if (!row) notFound('no such scenario')
  const cur = rowToScenario(row!, today)
  const name = b.name !== undefined ? b.name.trim().slice(0, 60) : cur.name
  if (!name) bad('name required')
  const params = b.params !== undefined ? normalizeParams(b.params, cur.params) : cur.params
  db.transaction(() => {
    if (b.isBaseline) {
      db.prepare('UPDATE scenarios SET is_baseline = 0 WHERE is_baseline = 1').run()
      db.prepare('UPDATE scenarios SET is_baseline = 1 WHERE id = ?').run(id)
    }
    db.prepare("UPDATE scenarios SET name = ?, params = ?, updated_at = datetime('now') WHERE id = ?").run(
      name,
      JSON.stringify(params),
      id,
    )
  })()
  return { ...cur, name, params, isBaseline: b.isBaseline ? true : cur.isBaseline }
}

/** Deleting the baseline promotes the next scenario; the last one can't be deleted. */
export function deleteScenario(db: DbLike, id: number) {
  const row = db.prepare('SELECT id, is_baseline FROM scenarios WHERE id = ?').get(id) as
    | { id: number; is_baseline: number }
    | undefined
  if (!row) notFound('no such scenario')
  const count = (db.prepare('SELECT count(*) AS n FROM scenarios').get() as { n: number }).n
  if (count <= 1) bad('keep at least one scenario')
  db.transaction(() => {
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(id)
    if (row!.is_baseline === 1) {
      const next = db.prepare('SELECT id FROM scenarios ORDER BY sort, id LIMIT 1').get() as { id: number }
      db.prepare('UPDATE scenarios SET is_baseline = 1 WHERE id = ?').run(next.id)
    }
  })()
  return { ok: true as const }
}

/* ---------- running them ---------- */

export type BalanceSheet = {
  cash: number
  brokerage: number
  retirement: number
  crypto: number
  property: number
  liabilities: number // positive
  total: number
}
export type HomeTerms = {
  priceCents: number
  cashOutCents: number
  rateMicro: number
  termMonths: number
  loanName: string | null
} | null

/**
 * What Future v3 reads from the ledger besides the balance sheet: the three
 * buckets, this year's pre-tax / Roth / HSA savings from the paystubs and
 * settings, the year's ordinary income (what working-year flows stack on),
 * filing status and state, and each person's birth year.
 */
export type TaxContext = {
  buckets: Buckets
  /** A year of savings into each bucket, as this year's contribution pace has it. */
  saves: { traditionalCents: number; rothCents: number; hsaCents: number }
  workingOrdinaryCents: number
  filing: FilingStatus
  state: Pick<TaxSettings, 'state' | 'filingStatus' | 'customStateRateMicro'>
  people: { name: string; birthYear: number | null }[]
  vintage: string
}

export function resolveTaxContext(db: DbLike, today: string): TaxContext {
  const ty = taxYear(db, today)
  const settings = ty.out.settings
  const contrib = computeContributions(db, today, settings.filingStatus, ty.out.incomes.totalIncomeCents)
  let traditional = 0
  let roth = 0
  for (const p of contrib.people)
    for (const s of p.sources) {
      traditional += s.projectedPretaxCents + (s.match?.projectedCents ?? 0)
      roth += s.projectedRothCents
    }
  const hsa = contrib.people.reduce((sum, p) => sum + (p.hsa?.plannedCents ?? 0), 0)
  return {
    buckets: resolveBuckets(db, today),
    saves: { traditionalCents: traditional, rothCents: roth, hsaCents: hsa },
    workingOrdinaryCents: ty.inputs.ordinaryCents,
    filing: settings.filingStatus,
    state: settings,
    people: listPeople(db).map((p) => ({ name: p.name, birthYear: p.birthYear })),
    vintage: SIMTAX_VINTAGE,
  }
}

/** The oldest birth year in the household, if any: whose age the axis shows and whose RMDs the traditional bucket takes. */
export const oldestBirthYear = (ctx: Pick<TaxContext, 'people'>): number | null =>
  ctx.people.reduce<number | null>((m, p) => (p.birthYear !== null && (m === null || p.birthYear < m) ? p.birthYear : m), null)

/** A scenario's tax block for the simulation, or null when the scenario turns the tax model off. */
export function toSimTax(params: ScenarioParams, ctx: TaxContext): SimTax | null {
  if (!params.taxModel) return null
  const b = ctx.buckets
  const hsaToRoth = params.hsaAsRoth
  const born = new Map(ctx.people.map((p) => [p.name.toLowerCase(), p.birthYear]))
  return {
    taxableCents: b.taxableCents,
    taxableBasisCents: b.taxableBasisCents,
    traditionalCents: b.traditionalCents + (hsaToRoth ? 0 : b.hsaCents),
    rothCents: b.rothCents + (hsaToRoth ? b.hsaCents : 0),
    traditionalSaveCents: ctx.saves.traditionalCents + (hsaToRoth ? 0 : ctx.saves.hsaCents),
    rothSaveCents: ctx.saves.rothCents + (hsaToRoth ? ctx.saves.hsaCents : 0),
    filing: ctx.filing,
    state: ctx.state,
    workingOrdinaryCents: ctx.workingOrdinaryCents,
    order: params.withdrawalOrder,
    fillBracketMicro: params.fillBracketMicro,
    conversion: params.conversion,
    rmdBirthYear: oldestBirthYear(ctx),
    // A benefit needs a birth year to know when it starts; without one it is left out (the screen says so).
    socialSecurity: params.socialSecurity.flatMap((x) => {
      const by = born.get(x.name.toLowerCase())
      if (by == null || x.fraBenefitCents <= 0) return []
      return [{ startYear: by + x.claimAge, annualCents: Math.round((x.fraBenefitCents * claimFactorMicro(by, x.claimAge)) / 1_000_000) }]
    }),
  }
}

/** Today's balance sheet + dream-home terms — the part of a run that is never stored. */
export function resolveContext(db: DbLike, today: string): { balance: BalanceSheet | null; home: HomeTerms } {
  const nw = getNetworth(db, today).current
  const balance: BalanceSheet | null = nw
    ? {
        cash: nw.cash,
        brokerage: nw.brokerage,
        retirement: nw.retirement,
        crypto: nw.crypto,
        property: nw.property,
        liabilities: -nw.liabilities,
        total: nw.total,
      }
    : null
  const g = getGoal(db, today)
  const loans = g.loans as { id: number; name: string; rate_micro: number; term_months: number }[]
  const loan = loans.find((l) => l.id === g.goal.selectedLoanId) ?? loans[0]
  const down = Math.round((g.goal.targetPriceCents * g.goal.downPctMicro) / 1_000_000)
  const home: HomeTerms = loan
    ? {
        priceCents: g.goal.targetPriceCents,
        cashOutCents: down + g.goal.closingCents,
        rateMicro: loan.rate_micro,
        termMonths: loan.term_months,
        loanName: loan.name,
      }
    : null
  return { balance, home }
}

export function toSimParams(
  params: ScenarioParams,
  balance: BalanceSheet,
  home: HomeTerms,
  today: string,
  draw: DrawMode,
  ctx: TaxContext | null = null,
): SimParams {
  const startYear = Number(today.slice(0, 4))
  const tax = ctx ? toSimTax(params, ctx) : null
  return {
    ...(tax ? { tax } : {}),
    startYear,
    endYear: Math.max(params.endYear, startYear + 1),
    liquidCents: balance.cash + balance.brokerage + balance.retirement + balance.crypto,
    propertyCents: balance.property,
    liabilitiesCents: balance.liabilities,
    meanReturnMicro: params.meanReturnMicro,
    volMicro: params.volMicro,
    propertyGrowthMicro: params.propertyGrowthMicro,
    saveBeforeBuyCents: params.saveBeforeBuyCents,
    saveAfterBuyCents: params.saveAfterBuyCents,
    buy:
      params.buyEnabled && home
        ? {
            year: params.buyYear,
            priceCents: home.priceCents,
            cashOutCents: home.cashOutCents,
            rateMicro: home.rateMicro,
            termMonths: home.termMonths,
          }
        : null,
    retireYear: params.retireYear,
    retireSpendCents: params.retireSpendCents,
    events: params.events,
    draw,
  }
}

export type ScenarioRun = Scenario & {
  result: SimResult
  crossingYear: number | null
  /** The same plan with an advisor's AUM fee dragging returns: what the alternative costs. */
  advisor: { feeMicro: number; successPct: number; medianEndCents: number; costCents: number } | null
  /** vs the baseline; null on the baseline itself */
  delta: null | {
    successPct: number
    medianEndCents: number
    p10EndCents: number
    crossingYears: number | null // + = later than baseline
    lifetimeTaxCents: number | null
    medianEndAfterTaxCents: number | null
  }
}

export type CompareOptions = { draw?: DrawMode; thresholdPct?: number }

const cleanDraw = (d: unknown): DrawMode => (d === 'historical' ? 'historical' : 'lognormal')
const cleanThreshold = (t: unknown): number =>
  typeof t === 'number' && Number.isFinite(t) ? Math.min(99, Math.max(50, Math.round(t))) : 90

/**
 * Every scenario, run against today's ledger on a common footing: same draw
 * mode, same seed, same horizon axis. Deltas are against the baseline.
 */
export function compareScenarios(db: DbLike, today: string, opts: CompareOptions = {}) {
  const draw = cleanDraw(opts.draw)
  const thresholdPct = cleanThreshold(opts.thresholdPct)
  const scenarios = listScenarios(db, today)
  const { balance, home } = resolveContext(db, today)
  const ctx = resolveTaxContext(db, today)
  const birthYear = oldestBirthYear(ctx)
  if (!balance) return { balance: null, home, draw, thresholdPct, tax: ctx, birthYear, runs: [] as ScenarioRun[] }

  const runs: ScenarioRun[] = scenarios.map((s) => {
    const p = toSimParams(s.params, balance, home, today, draw, ctx)
    const result = simulate(p)
    let advisor: ScenarioRun['advisor'] = null
    if (s.params.advisorFeeMicro > 0) {
      const a = simulate({ ...p, feeMicro: s.params.advisorFeeMicro })
      advisor = { feeMicro: s.params.advisorFeeMicro, successPct: a.successPct, medianEndCents: a.medianEndCents, costCents: result.medianEndCents - a.medianEndCents }
    }
    return { ...s, result, crossingYear: crossingYear(p, thresholdPct), advisor, delta: null }
  })
  const base = runs.find((r) => r.isBaseline) ?? runs[0]!
  for (const r of runs) {
    if (r === base) continue
    r.delta = {
      successPct: r.result.successPct - base.result.successPct,
      medianEndCents: r.result.medianEndCents - base.result.medianEndCents,
      p10EndCents: r.result.p10EndCents - base.result.p10EndCents,
      crossingYears: r.crossingYear !== null && base.crossingYear !== null ? r.crossingYear - base.crossingYear : null,
      lifetimeTaxCents:
        r.result.medianLifetimeTaxCents != null && base.result.medianLifetimeTaxCents != null
          ? r.result.medianLifetimeTaxCents - base.result.medianLifetimeTaxCents
          : null,
      medianEndAfterTaxCents:
        r.result.medianEndAfterTaxCents != null && base.result.medianEndAfterTaxCents != null
          ? r.result.medianEndAfterTaxCents - base.result.medianEndAfterTaxCents
          : null,
    }
  }
  return { balance, home, draw, thresholdPct, tax: ctx, birthYear, runs }
}

/** Price one dated cash flow against a saved scenario without saving it. */
export function priceScenarioDecision(
  db: DbLike,
  today: string,
  b: { scenarioId?: number; event?: unknown; draw?: unknown },
): DecisionPrice & { scenarioId: number } {
  const scenarios = listScenarios(db, today)
  const s = scenarios.find((x) => x.id === b.scenarioId) ?? scenarios.find((x) => x.isBaseline) ?? scenarios[0]!
  const { balance, home } = resolveContext(db, today)
  if (!balance) bad('nothing to project yet — import accounts first')
  const [event] = normalizeParams({ events: [b.event] }, s.params).events
  if (!event) bad('event required')
  const p = toSimParams(s.params, balance!, home, today, cleanDraw(b.draw), resolveTaxContext(db, today))
  return { scenarioId: s.id, ...priceDecision(p, event!) }
}
