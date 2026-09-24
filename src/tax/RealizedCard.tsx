import { useCallback, useEffect, useState } from 'react'
import { RSU_WITHHOLDING_NOTE, type RealizedLine, type RealizedReport } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { get } from '../api'
import { form8949Csv, form8949Filename } from '../invest/form8949'
import '../invest/invest.css'
import { Button } from '../ui/Button'
import { Select } from '../ui/Field'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'

export type RealizedCardProps = { year: number }

const SHOWN = 8

/**
 * The year's realized gains (Taxes), sale by sale and lot by lot, from
 * taxable accounts: the totals Schedule D takes by term, the netting, what
 * needs checking before filing (shares with no basis, possible wash sales),
 * and a CSV shaped like Form 8949. Any year with sales can be picked — the
 * spring return wants last year's.
 */
export default function RealizedCard({ year: thisYear }: RealizedCardProps) {
  const [year, setYear] = useState(thisYear)
  const [report, setReport] = useState<RealizedReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)

  const load = useCallback(() => {
    let live = true
    setError(null)
    get<RealizedReport>(`/api/invest/realized?year=${year}`)
      .then((r) => live && setReport(r))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [year])
  useEffect(() => load(), [load])

  const r = report?.year === year ? report : null
  const download = () => {
    if (!r) return
    try {
      const url = URL.createObjectURL(new Blob([form8949Csv(r)], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = form8949Filename(r.year)
      document.body.append(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      toast.error('Couldn’t make the CSV', { detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const years = report?.years ?? [thisYear]
  return (
    <div className="card c6 inv-taxcard inv-rz" style={!r || r.lines.length === 0 ? { alignSelf: 'start' } : undefined}>
      <div className="h4row">
        <h2>Realized gains</h2>
        <div className="right">
          {years.length > 1 && (
            <Select aria-label="Tax year" className="inv-rz-year" value={year} onChange={(e) => { setYear(Number(e.target.value)); setAll(false) }}>
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </Select>
          )}
          <Button size="mini" disabled={!r || r.lines.length === 0} onClick={download} title="Every line, Part I and Part II, with totals — to check against the 1099-B or hand to a preparer">
            Download CSV (Form 8949)
          </Button>
        </div>
      </div>
      {error ? (
        <div className="inv-loaderr" role="alert">
          <span>Couldn’t load the report: {error}</span>
          <Button size="mini" onClick={load}>Retry</Button>
        </div>
      ) : !r ? (
        <div className="inv-skel" aria-busy="true" aria-label="Loading the report">
          <Skeleton h={14} w="70%" />
          <Skeleton h={14} w="60%" />
          <Skeleton h={14} />
        </div>
      ) : (
        <RealizedBody r={r} all={all} onAll={() => setAll(true)} />
      )}
    </div>
  )
}

const signed = (c: number) => formatCents(c, { sign: c !== 0 })

/** Net-settled vests: the shares the employer kept were never a sale of yours, so they aren't lines. */
const withheldText = (w: RealizedReport['withheld']) =>
  `Shares withheld at ${w.sales === 1 ? 'a vest' : `${w.sales} vests`} to pay the tax (${formatCents(w.cents)}) weren’t sold by you, so they aren’t listed.`

/** The report itself: exported for the render test. */
export function RealizedBody({ r, all, onAll }: { r: RealizedReport; all: boolean; onAll: () => void }) {
  if (r.lines.length === 0)
    return (
      <p className="sub2">
        No sales in taxable accounts in {r.year}
        {r.sheltered.sales > 0 &&
          ` — ${r.sheltered.sales} inside tax-advantaged accounts (${signed(r.sheltered.gain_cents)}), which are never reported or taxed`}
        .{r.withheld.sales > 0 && ` ${withheldText(r.withheld)}`}
      </p>
    )
  const n = r.netted
  const netLoss = n.capLossUsedCents + n.capLossCarryCents
  const lines = all ? r.lines : r.lines.slice(0, SHOWN)
  return (
    <>
      <div className="inv-tablewrap">
        <table className="inv-rz-sum">
          <thead>
            <tr>
              <th>{r.year}</th><th className="r">Proceeds</th><th className="r">Cost basis</th><th className="r">Gain or loss</th>
            </tr>
          </thead>
          <tbody>
            {([['Short-term', 'Part I', r.st], ['Long-term', 'Part II', r.lt]] as const).map(([label, part, t]) => (
              <tr key={label}>
                <td>
                  {label}
                  <span className="inv-rz-sub">
                    {part} · {t.lines} line{t.lines === 1 ? '' : 's'}
                  </span>
                </td>
                <td className="r num">{formatCents(t.proceeds_cents)}</td>
                <td className="r num muted">{formatCents(t.cost_cents)}</td>
                <td className={`r num ${t.gain_cents > 0 ? 'pos' : t.gain_cents < 0 ? 'neg' : ''}`}>{signed(t.gain_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="sub2 inv-rz-net">
        {netLoss > 0 ? (
          <>
            Net capital loss {formatCents(netLoss)}: {formatCents(n.capLossUsedCents)} offsets ordinary income
            {n.capLossCarryCents > 0 && `, ${formatCents(n.capLossCarryCents)} carries forward`}.
          </>
        ) : (
          <>
            After netting: <b className="inkstrong">{formatCents(n.netStCents)}</b> short-term, <b className="inkstrong">{formatCents(n.netLtCents)}</b> long-term.
          </>
        )}
        {r.sheltered.sales > 0 && ` Sales inside tax-advantaged accounts (${r.sheltered.sales}) aren’t reported.`}
        {r.withheld.sales > 0 && ` ${withheldText(r.withheld)}`}
      </p>
      {(r.flags.no_basis > 0 || r.flags.wash_risk > 0) && (
        <ul className="inv-rz-flags">
          {r.flags.no_basis > 0 && (
            <li>
              {r.flags.no_basis} line{r.flags.no_basis === 1 ? ' has' : 's have'} shares with no recorded basis — counted at zero basis until you enter it (Investments → Activity → Edit), or add the missing buy.
            </li>
          )}
          {r.flags.wash_risk > 0 && (
            <li>
              {r.flags.wash_risk} loss{r.flags.wash_risk === 1 ? '' : 'es'} with a buy of the same stock within 30 days (any account, IRAs included) — possibly a wash sale. Scarab doesn’t adjust for it; the 1099-B shows any disallowed loss (code W).
            </li>
          )}
        </ul>
      )}
      <div className="inv-tablewrap">
        <table className="inv-rz-lines">
          <thead>
            <tr>
              <th>Sold</th><th>Lot</th><th className="r">Gain · proceeds</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <LineRow key={`${l.sale_trade_id ?? 'x'}-${i}`} l={l} />
            ))}
          </tbody>
        </table>
      </div>
      {!all && r.lines.length > SHOWN && (
        <div className="inv-more">
          <Button size="mini" onClick={onAll}>
            Show all {r.lines.length} lines
          </Button>
        </div>
      )}
      <p className="inv-note inv-rz-foot">
        From Scarab’s lots, not your broker’s 1099-B: match each line against it, and take the box (A–F) and any adjustments from there.
      </p>
    </>
  )
}

function LineRow({ l }: { l: RealizedLine }) {
  return (
    <tr>
      <td className="num">{l.sold_on}</td>
      <td>
        <span className="tk"><span className="lg">{l.symbol}</span></span>
        {l.note === RSU_WITHHOLDING_NOTE && <span className="inv-tag inv-quiet inv-rz-tag">withheld for tax</span>}
        {l.wash_risk && (
          <Tooltip content="A buy of this stock within 30 days of the sale, in any account — the loss may be disallowed (wash sale).">
            <span className="inv-tag inv-rz-tag">wash?</span>
          </Tooltip>
        )}
        <span className="inv-rz-sub">
          {formatQtyMicro(l.qty_micro)} sh · {l.account} ·{' '}
          {l.basis === 'none' ? <span className="inv-tag inv-rz-tag">no basis</span> : `acquired ${l.acquired_on}`} · {l.term === 'lt' ? 'long-term' : 'short-term'}
        </span>
      </td>
      <td className="r num">
        <span className={l.gain_cents > 0 ? 'pos' : l.gain_cents < 0 ? 'neg' : undefined}>{signed(l.gain_cents)}</span>
        <span className="inv-rz-sub">of {formatCents(l.proceeds_cents)}</span>
      </td>
    </tr>
  )
}
