import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from '../api'
import BigChart, { type ChartData, type ChartTrade } from '../BigChart'
import { fmtDay, parseT } from '../chart/scale'
import { localMode } from '../local'
import { Button } from '../ui/Button'
import { Skeleton } from '../ui/Skeleton'
import '../chart/chart.css'

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ok'; data: ChartData }

/**
 * GET /api/trades?symbol= in its TradeRow form (B6) has an asset_id on every
 * row; the older shape (last 50 trades, any symbol) doesn't, and a partial
 * list would draw a misleading set of markers — so markers wait for the real
 * one.
 */
function tradeMarks(rows: unknown, symbol: string): ChartTrade[] {
  if (!Array.isArray(rows)) return []
  const isTradeRow = (r: unknown): r is ChartTrade & { symbol: string; asset_id: number } =>
    typeof r === 'object' && r !== null && 'asset_id' in r && 'traded_on' in r && 'side' in r
  if (!rows.every(isTradeRow)) return []
  return rows.filter((r) => r.symbol === symbol)
}

/**
 * Daily price history for one held symbol (the holding drawer's chart): its
 * closes and the household's own trades in it, fetched when the symbol is
 * first shown and refreshed quietly whenever Investments reloads (`rev`) — a
 * new buy or today's close shows without closing the drawer. A failed first
 * load says so and offers Retry instead of "Loading…" forever (bug #45); a
 * failed refresh keeps what is drawn.
 */
export default function PriceChart({ symbol, rev }: { symbol: string; rev: number }) {
  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [trades, setTrades] = useState<ChartTrade[]>([])
  const seq = useRef(0)
  const fetchAll = useCallback(
    (quiet: boolean) => {
      const n = ++seq.current
      if (!quiet) setLoad({ state: 'loading' })
      get<ChartData>(`/api/charts/${encodeURIComponent(symbol)}`)
        .then((data) => n === seq.current && setLoad({ state: 'ok', data }))
        .catch(
          (e: unknown) =>
            n === seq.current && setLoad((l) => (quiet && l.state === 'ok' ? l : { state: 'error', message: e instanceof Error ? e.message : String(e) })),
        )
      get<unknown>(`/api/trades?symbol=${encodeURIComponent(symbol)}`)
        .then((rows) => n === seq.current && setTrades(tradeMarks(rows, symbol)))
        .catch(() => undefined) // markers are optional; the chart stands without them
    },
    [symbol],
  )
  // A new symbol starts over; the same one on a later `rev` refreshes behind what is drawn.
  const shown = useRef<string | null>(null)
  useEffect(() => {
    const quiet = shown.current === symbol
    shown.current = symbol
    if (!quiet) setTrades([])
    fetchAll(quiet)
  }, [symbol, rev, fetchAll])

  if (load.state === 'loading')
    return (
      <div aria-busy="true" aria-label={`Loading ${symbol} price history`}>
        <Skeleton h={26} w={320} radius={8} />
        <Skeleton h={300} radius={8} style={{ marginTop: 10 }} />
      </div>
    )
  if (load.state === 'error')
    return (
      <div className="ch-empty" role="alert">
        <div className="inkstrong">Couldn’t load {symbol}’s price history.</div>
        <div className="ch-hint">{load.message}</div>
        <Button size="mini" onClick={() => fetchAll(false)}>
          Retry
        </Button>
      </div>
    )
  return <PriceBody data={load.data} trades={trades} onRetry={() => fetchAll(false)} />
}

function PriceBody({ data, trades, onRetry }: { data: ChartData; trades?: ChartTrade[]; onRetry: () => void }) {
  const errors = data.errors ?? []
  const n = data.closes.length
  if (n < 2) {
    const zk = localMode.active
    return (
      <div className="ch-empty">
        <div className="inkstrong">
          {n === 1 ? `Only one price for ${data.symbol} so far (${fmtDay(parseT(data.closes[0]!.d))}).` : `No price history for ${data.symbol} yet.`}
        </div>
        <div className="ch-hint">
          {zk
            ? 'This session never names what you hold to the server: it reads daily history from a shared file covering a hashed bucket of symbols, and this one isn’t in it yet — a fund outside the market list, or a server that hasn’t built the daily files. Prices still build up from the shared daily quotes each time you open Investments, and the line starts once there are two.'
            : n === 1
              ? 'The line starts with the second close.'
              : 'Scarab fetches daily history when this chart opens, and none came back for this symbol.'}
        </div>
        {errors.length > 0 && <div className="ch-hint">{errors.join(' · ')}</div>}
        {!zk && (
          <Button size="mini" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    )
  }
  return (
    <>
      {errors.length > 0 && <div className="sub2" style={{ marginBottom: 8 }}>{errors.join(' · ')}</div>}
      <BigChart data={data} trades={trades} />
    </>
  )
}
