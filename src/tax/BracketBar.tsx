import type { BracketHeadroom } from '../../shared/checkup-api'
import { formatDollars } from '../../shared/money'
import { Tooltip } from '../ui/Tooltip'
import './bracket.css'

const pct = (micro: number) => `${(micro / 10_000).toFixed(micro % 10_000 === 0 ? 0 : 1)}%`

type Band = { from: number; to: number | null; rateMicro: number }

/**
 * Where this year's income sits in the federal brackets: ordinary taxable
 * income filling the ordinary brackets (s1), and the long-term gains and
 * qualified dividends stacked on top of it across the 0/15/20% bands (s2) —
 * the same scale, so the second row starts where the first one's income ends.
 * Each band says its range on hover or focus; the sentences under the bars
 * carry the same facts for anyone not looking at the bars.
 */
export function BracketBar({ h }: { h: BracketHeadroom }) {
  const ord = h.ordinaryTaxableCents
  const end = ord + h.ltTaxableCents
  const bands: Band[] = []
  let from = 0
  for (const b of h.brackets) {
    bands.push({ from, to: b.upToCents, rateMicro: b.rateMicro })
    from = b.upToCents ?? from
  }
  // Show through the bracket after the one the stack ends in, so the next rate is in view.
  const reach = Math.max(end, ord)
  let last = bands.findIndex((b) => b.to === null || reach < b.to)
  if (last < 0) last = bands.length - 1
  last = Math.min(bands.length - 1, last + 1)
  const lastTo = bands[last]!.to
  const scale = Math.max(lastTo ?? Math.round(bands[last]!.from * 1.3), Math.round(reach * 1.08), 1)
  const ltBands: Band[] = [
    { from: 0, to: h.lt0TopCents, rateMicro: 0 },
    { from: h.lt0TopCents, to: h.lt15TopCents, rateMicro: 150_000 },
    { from: h.lt15TopCents, to: null, rateMicro: 200_000 },
  ]
  const w = (a: number, b: number | null) => `${(Math.max(0, Math.min(b ?? scale, scale) - Math.min(a, scale)) / scale) * 100}%`
  const fill = (band: Band, lo: number, hi: number) => {
    const top = Math.min(band.to ?? scale, scale)
    const span = top - band.from
    if (span <= 0) return '0%'
    const covered = Math.max(0, Math.min(hi, top) - Math.max(lo, band.from))
    return `${(covered / span) * 100}%`
  }
  const range = (b: Band) => (b.to === null ? `over ${formatDollars(b.from)}` : `${formatDollars(b.from)} – ${formatDollars(b.to)}`)
  const cur = h.brackets[h.bracketIndex]!
  const next = h.brackets[h.bracketIndex + 1]

  return (
    <div className="br">
      <div className="br-row">
        <span className="br-label">Ordinary</span>
        <div className="br-track">
          {bands.slice(0, last + 1).map((b, i) => (
            <Tooltip key={i} content={`${pct(b.rateMicro)} bracket · ${range(b)} of taxable income`}>
              <div className="br-band" style={{ width: w(b.from, b.to) }}>
                <i className="br-fill s1" style={{ width: fill(b, 0, ord) }} />
                <span className="br-rate">{pct(b.rateMicro)}</span>
              </div>
            </Tooltip>
          ))}
        </div>
      </div>
      <div className="br-row">
        <span className="br-label">Long-term</span>
        <div className="br-track">
          {ltBands.map((b, i) =>
            Math.min(b.from, scale) >= scale ? null : (
              <Tooltip key={i} content={`${pct(b.rateMicro)} on long-term gains and qualified dividends stacked ${range(b)}`}>
                <div className="br-band" style={{ width: w(b.from, b.to) }}>
                  <i className="br-fill under" style={{ width: fill(b, 0, ord) }} />
                  <i className="br-fill s2" style={{ left: fill(b, 0, ord), width: fill(b, ord, end) }} />
                  <span className="br-rate">{pct(b.rateMicro)}</span>
                </div>
              </Tooltip>
            ),
          )}
        </div>
      </div>
      <div className="br-legend">
        <span><i className="s1" />Ordinary taxable income {formatDollars(ord)}</span>
        <span><i className="s2" />Long-term gains &amp; qualified dividends {formatDollars(h.ltTaxableCents)}</span>
      </div>
      <ul className="br-facts">
        <li>
          Ordinary taxable income is in the <b className="inkstrong">{pct(cur.rateMicro)}</b> bracket
          {h.roomCents !== null && next ? (
            <>
              {' '}— <b className="inkstrong">{formatDollars(h.roomCents)}</b> more before {pct(next.rateMicro)} starts.
            </>
          ) : (
            ' — the top one.'
          )}
        </li>
        <li>
          Long-term gains stack from {formatDollars(ord)}:{' '}
          {h.lt0RoomCents > 0 ? (
            <>
              <b className="inkstrong">{formatDollars(h.lt0RoomCents)}</b> of room left at 0% federal
            </>
          ) : (
            'the 0% band is used up'
          )}
          {' · '}
          {h.lt15RoomCents > 0 ? (
            <>
              <b className="inkstrong">{formatDollars(h.lt15RoomCents)}</b> more before 20%.
            </>
          ) : (
            'they are in the 20% band.'
          )}
        </li>
        {!h.wagesEntered && <li>No wages are entered yet, so every figure here is too low — add paychecks on Taxes.</li>}
      </ul>
    </div>
  )
}
