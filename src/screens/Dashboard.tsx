import { useEffect, useState } from 'react'
import { formatCents } from '../../shared/money'
import { get } from '../api'
import { Donut, fmtMonth, LineChart } from '../viz'
import DigestCard from '../DigestCard'

type Point = {
  month: string
  cash: number
  brokerage: number
  retirement: number
  crypto: number
  property: number
  liabilities: number
  total: number
}
type NetWorth = { series: Point[]; current: Point | null; prev: Point | null }
type Activity = { on_date: string; description: string; cents: number; tag: string; kind: 'tx' | 'trade' }

const TILES: { key: keyof Point; label: string }[] = [
  { key: 'brokerage', label: 'Brokerage' },
  { key: 'retirement', label: 'Retirement' },
  { key: 'cash', label: 'Cash' },
  { key: 'crypto', label: 'Crypto' },
]

export default function Dashboard() {
  const [nw, setNw] = useState<NetWorth | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])

  useEffect(() => {
    get<NetWorth>('/api/networth').then(setNw).catch(console.error)
    get<Activity[]>('/api/activity').then(setActivity).catch(console.error)
  }, [])

  if (!nw) return <div className="card">Loading…</div>
  const { series, current, prev } = nw
  if (!current)
    return (
      <div className="card wide">
        <h2>Nothing to add up yet</h2>
        <p>
          Net worth assembles itself from the other screens: import bank files on Cash &amp; budget, record
          trades or balances on Investments, add your house on Real estate. Each one lights up a slice here.
        </p>
      </div>
    )

  const delta = prev ? current.total - prev.total : 0
  const equity = current.property + current.liabilities

  return (
    <div className="grid12">
      <DigestCard />
      <div className="card c8">
        <h2>Household net worth</h2>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
          <div className="heronum" style={{ fontSize: 44 }}>{formatCents(current.total)}</div>
          {prev && (
            <span className={`delta ${delta >= 0 ? 'pos' : 'neg'}`} style={{ fontWeight: 600, fontSize: 13 }}>
              {delta >= 0 ? '▲' : '▼'} {formatCents(Math.abs(delta))} vs {fmtMonth(prev.month, true)}
            </span>
          )}
        </div>
        {series.length >= 2 ? (
          <LineChart
            labels={series.map((p) => fmtMonth(p.month, p.month.endsWith('-01')))}
            series={[{ name: 'Net worth', color: 'var(--s1)', values: series.map((p) => p.total), area: true }]}
            tipLabel={(i) => fmtMonth(series[i]!.month, true)}
          />
        ) : (
          <p className="sub2" style={{ marginTop: 10 }}>
            The trend line appears once there's more than one month of history.
          </p>
        )}
      </div>
      <div className="card c4">
        <h2>Allocation</h2>
        <Donut
          data={[
            { name: 'Brokerage', cents: current.brokerage, color: 'var(--s1)' },
            { name: 'Retirement', cents: current.retirement, color: 'var(--s2)' },
            { name: 'Home equity', cents: Math.max(0, equity), color: 'var(--s3)' },
            { name: 'Crypto', cents: current.crypto, color: 'var(--s4)' },
            { name: 'Cash', cents: Math.max(0, current.cash), color: 'var(--s5)' },
          ]}
        />
        <div className="sub2 topline">
          Home equity = {formatCents(current.property)} value − {formatCents(-current.liabilities)} debt
        </div>
      </div>

      {TILES.map((t) => {
        const cur = current[t.key] as number
        const was = prev ? (prev[t.key] as number) : cur
        const d = cur - was
        return (
          <div className="card c3" key={t.key}>
            <h2>{t.label}</h2>
            <div className="v" style={{ fontSize: 21, fontWeight: 650 }}>{formatCents(cur)}</div>
            {prev && d !== 0 && (
              <span className={`sub2 ${d > 0 ? 'pos' : 'neg'}`}>
                {d > 0 ? '▲' : '▼'} {formatCents(Math.abs(d))} MoM
              </span>
            )}
          </div>
        )
      })}

      <div className="card c12">
        <h2>Recent activity</h2>
        <table>
          <tbody>
            {activity.map((a, i) => (
              <tr key={i}>
                <td className="muted nowrap" style={{ width: 80 }}>{a.on_date.slice(5)}</td>
                <td className="desc">{a.description}</td>
                <td><span className="muted">{a.tag}</span></td>
                <td className={`r num ${a.cents > 0 ? 'pos' : ''}`}>{formatCents(a.cents, { sign: a.cents > 0 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
