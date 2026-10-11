import { useEffect, useState } from 'react'
import type { Allocation } from '../../engine/allocation'
import { RSU_VEST_NOTE, RSU_WITHHOLDING_NOTE, type InvestAccountRow, type PortfolioAccount, type PortfolioPosition, type PortfolioResponse, type TradeRow } from '../../shared/invest-api'
import { formatDollars } from '../../shared/money'
import { get } from '../api'
import { DrillCard, MiniRows, type MiniRow } from '../ui/Drill'
import { Skeleton } from '../ui/Skeleton'
import { accountValueCents, staleReason, typeLabel } from './accountTypes'
import { CLASS_LABEL, pct, pp } from './AllocationCard'
import { shortDay } from './balanceMath'
import { toneOf } from './dayMath'
import { taxPicture, type TaxPictureProps } from './TaxPictureCard'
import './invest.css'

/**
 * Investments' overview cards: each one figure, a line of context and the top
 * of its table, linking to the view that has the rest. They add nothing of
 * their own — every number is one the full card behind it shows too.
 */

const PREVIEW = 3
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
/** Drift this far from target is "off" — the allocation table's own mark (3 points). */
const OFF_MICRO = 30_000

/** The accounts in view: what they add up to and the largest few. Opens the full strip (add, check in). */
export function AccountsDrill(p: {
  accounts: readonly InvestAccountRow[]
  positions: readonly PortfolioPosition[]
  cash: ReadonlyMap<number, PortfolioAccount>
  valueCents: number
  today: string
  span: string
}) {
  const valued = p.accounts
    .map((a) => ({ a, cents: accountValueCents(a, p.positions, a.tracking === 'lots' ? p.cash.get(a.id) : undefined) }))
    .sort((x, y) => (y.cents ?? 0) - (x.cents ?? 0))
  const stale = p.accounts.filter((a) => staleReason(a, p.positions, p.today) !== null).length
  return (
    <DrillCard
      to="accounts"
      span={p.span}
      title="Accounts"
      value={formatDollars(p.valueCents)}
      note={
        <>
          {count(p.accounts.length, 'account')}
          {stale > 0 && ` · ${stale} out of date`}
        </>
      }
    >
      <MiniRows
        rows={valued.slice(0, PREVIEW).map(
          ({ a, cents }): MiniRow => ({ key: a.id, label: a.name, sub: typeLabel(a), value: cents !== null ? formatDollars(cents) : '—' }),
        )}
      />
    </DrillCard>
  )
}

/**
 * Allocation in one line: the class furthest from its target, or that there is
 * no target yet. Reads the same GET /api/allocation the full card does (which
 * isn't mounted while this one is); `rev` is Investments' load counter.
 */
export function AllocationDrill({ rev, span, household }: { rev: number; span: string; household: boolean }) {
  const [a, setA] = useState<Allocation | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    get<Allocation>('/api/allocation')
      .then((r) => {
        if (!live) return
        setA(r)
        setErr(false)
      })
      .catch(() => live && setErr(true))
    return () => {
      live = false
    }
  }, [rev])

  if (!a)
    return (
      <DrillCard to="allocation" span={span} title="Allocation" note={err ? 'Couldn’t work out the allocation' : undefined}>
        {!err && <Skeleton h={72} />}
      </DrillCard>
    )
  const scope = household ? ' · whole household' : ''
  if (a.totalCents <= 0) return <DrillCard to="allocation" span={span} title="Allocation" value="—" note="Nothing invested yet" />

  const rows = [...a.rows].sort((x, y) => y.cents - x.cents)
  const preview = (
    <MiniRows
      rows={rows.slice(0, PREVIEW).map(
        (r): MiniRow => ({ key: r.cls, label: CLASS_LABEL[r.cls], sub: r.targetMicro != null ? `target ${pct(r.targetMicro)}` : undefined, value: pct(r.shareMicro) }),
      )}
    />
  )
  if (!a.target)
    return (
      <DrillCard to="allocation" span={span} title="Allocation" value={formatDollars(a.totalCents)} note={`No target set${scope}`}>
        {preview}
      </DrillCard>
    )
  const worst = a.rows.reduce<(typeof a.rows)[number] | null>(
    (w, r) => (r.driftMicro != null && (w === null || Math.abs(r.driftMicro) > Math.abs(w.driftMicro ?? 0)) ? r : w),
    null,
  )
  const off = a.rows.filter((r) => r.driftMicro != null && Math.abs(r.driftMicro) >= OFF_MICRO).length
  return (
    <DrillCard
      to="allocation"
      span={span}
      title="Allocation vs target"
      value={worst?.driftMicro != null ? pp(worst.driftMicro) : '—'}
      note={
        <>
          {worst ? `${CLASS_LABEL[worst.cls]} is furthest from target` : 'On target'}
          {off > 1 && ` · ${off} classes 3pp or more off`}
          {scope}
        </>
      }
    >
      {preview}
    </DrillCard>
  )
}

/** The year's realized gains in taxable accounts, net, and what they cost. Taxes has the rest. */
export function TaxDrill(p: {
  totals: PortfolioResponse['totals']
  marginal: TaxPictureProps['marginal']
  carryIn: TaxPictureProps['carryIn']
  year: string
  span: string
  household: boolean
}) {
  const { estTax } = taxPicture(p.totals, p.marginal, p.carryIn)
  const net = p.totals.ytd_st + p.totals.ytd_lt
  const tone = toneOf(net)
  const signed = (c: number) => formatDollars(c, { sign: c > 0 })
  const rows: MiniRow[] = [
    { label: 'Short-term', value: signed(p.totals.ytd_st) },
    { label: 'Long-term', value: signed(p.totals.ytd_lt) },
  ]
  if (estTax !== null) rows.push({ label: estTax >= 0 ? 'Est. tax so far' : 'Est. tax saved', value: formatDollars(Math.abs(estTax)) })
  return (
    <DrillCard
      to={{ screen: 'tax' }}
      span={p.span}
      title="Tax picture"
      value={signed(net)}
      tone={tone === 'pos' || tone === 'neg' ? tone : undefined}
      note={`Realized in taxable accounts, ${p.year}${p.household ? ' · whole household' : ''}`}
    >
      <MiniRows rows={rows} />
    </DrillCard>
  )
}

const tradeWord = (r: TradeRow) => (r.note === RSU_VEST_NOTE ? 'Vest' : r.note === RSU_WITHHOLDING_NOTE && r.side === 'sell' ? 'Withheld' : r.side === 'buy' ? 'Buy' : 'Sell')

/**
 * The ledger's latest few trades and how many the year holds. Reads GET
 * /api/trades as the full table does (which isn't mounted while this one is).
 */
export function ActivityDrill({ rev, scope, today, span }: { rev: number; scope?: ReadonlySet<number>; today: string; span: string }) {
  const [rows, setRows] = useState<TradeRow[] | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    get<TradeRow[]>('/api/trades')
      .then((r) => {
        if (!live) return
        setRows(r)
        setErr(false)
      })
      .catch(() => live && setErr(true))
    return () => {
      live = false
    }
  }, [rev])

  if (!rows)
    return (
      <DrillCard to="activity" span={span} title="Activity" note={err ? 'Couldn’t load the activity' : undefined}>
        {!err && <Skeleton h={72} />}
      </DrillCard>
    )
  const mine = (scope ? rows.filter((r) => scope.has(r.invest_account_id)) : rows).slice().sort((x, y) => (x.traded_on < y.traded_on ? 1 : x.traded_on > y.traded_on ? -1 : y.id - x.id))
  const latest = mine[0]
  if (!latest) return <DrillCard to="activity" span={span} title="Activity" value="0 trades" note="No trades yet — record the first" />
  const year = today.slice(0, 4)
  const thisYear = mine.filter((r) => r.traded_on.startsWith(year)).length
  return (
    <DrillCard
      to="activity"
      span={span}
      title="Activity"
      value={count(thisYear > 0 ? thisYear : mine.length, 'trade')}
      note={`${thisYear > 0 ? 'in' : 'none yet in'} ${year} · latest ${shortDay(latest.traded_on, today)}`}
    >
      <MiniRows
        rows={mine.slice(0, PREVIEW).map(
          (r): MiniRow => ({ key: r.id, label: `${tradeWord(r)} ${r.symbol}`, sub: shortDay(r.traded_on, today), value: formatDollars(r.total_cents) }),
        )}
      />
    </DrillCard>
  )
}
