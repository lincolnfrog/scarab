import { useCallback, useEffect, useRef, useState } from 'react'
import { get } from '../api'
import BigChart, { type ChartData, type ChartTrade } from '../BigChart'
import { fmtDay, parseT } from '../chart/scale'
import { localMode } from '../local'
import { useRouteState } from '../router'
import { Button } from '../ui/Button'
import { Segmented } from '../ui/Segmented'
import { Skeleton } from '../ui/Skeleton'
import '../chart/chart.css'

export type PriceChartPosition = { asset_id?: number; symbol: string; priced_on: string | null }

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
 * Daily price history for one held symbol at a time. The picker defaults to
 * the first position that has a price; the pick lives in route state (never
 * the URL — tickers stay out of history). Each symbol's history and trades
 * are fetched on first pick and kept, then refreshed quietly whenever
 * Investments reloads its positions; a failed first load says so and offers
 * Retry instead of "Loading…" forever (bug #45). Renders nothing while
 * nothing is held.
 */
export default function PriceChartCard({ positions }: { positions: PriceChartPosition[] }) {
  const [picked, setPicked] = useRouteState<string | null>('priceChart', null)
  const [loads, setLoads] = useState<Record<string, Load>>({})
  const [trades, setTrades] = useState<Record<string, ChartTrade[]>>({})

  const fallback = positions.find((p) => p.priced_on !== null) ?? positions[0]
  const symbol = picked !== null && positions.some((p) => p.symbol === picked) ? picked : (fallback?.symbol ?? null)
  const pricedOn = positions.find((p) => p.symbol === symbol)?.priced_on ?? null

  const loadTrades = useCallback((sym: string) => {
    get<unknown>(`/api/trades?symbol=${encodeURIComponent(sym)}`)
      .then((rows) => setTrades((t) => ({ ...t, [sym]: tradeMarks(rows, sym) })))
      .catch(() => setTrades((t) => (t[sym] ? t : { ...t, [sym]: [] }))) // markers are optional; the chart stands without them
  }, [])
  /** `quiet`: a refresh behind what is drawn — a failure keeps it rather than replacing it with the error. */
  const load = useCallback(
    (sym: string, quiet = false) => {
      if (!quiet) setLoads((l) => ({ ...l, [sym]: { state: 'loading' } }))
      get<ChartData>(`/api/charts/${encodeURIComponent(sym)}`)
        .then((data) => setLoads((l) => ({ ...l, [sym]: { state: 'ok', data } })))
        .catch((e: unknown) =>
          setLoads((l) => (quiet && l[sym]?.state === 'ok' ? l : { ...l, [sym]: { state: 'error', message: e instanceof Error ? e.message : String(e) } })),
        )
      loadTrades(sym)
    },
    [loadTrades],
  )

  useEffect(() => {
    if (symbol && !loads[symbol]) load(symbol)
  }, [symbol, loads, load])

  // Investments hands over a new positions list whenever it reloads (a recorded trade, a price refresh, a
  // revisit): refresh the drawn symbol behind the chart — its trades always, its closes when its latest
  // price moved — so a new buy or today's close shows without a page reload.
  const seen = useRef<{ positions: PriceChartPosition[]; priced: Record<string, string | null> }>({ positions, priced: {} })
  const loadsNow = useRef(loads)
  loadsNow.current = loads
  useEffect(() => {
    const s = seen.current
    if (symbol && !(symbol in s.priced)) s.priced[symbol] = pricedOn
    if (positions === s.positions) return
    s.positions = positions
    if (!symbol || loadsNow.current[symbol]?.state !== 'ok') return
    if (s.priced[symbol] !== pricedOn) {
      s.priced[symbol] = pricedOn
      load(symbol, true)
    } else loadTrades(symbol)
  }, [positions, symbol, pricedOn, load, loadTrades])

  if (positions.length === 0) return null
  const cur = symbol ? loads[symbol] : undefined

  return (
    <div className="card c12">
      <div className="h4row">
        <h2>Price history</h2>
        {positions.length > 1 && symbol && (
          <div className="right ch-symbols">
            <Segmented
              aria-label="Symbol"
              value={symbol}
              onChange={setPicked}
              options={positions.map((p) => ({ value: p.symbol, label: p.symbol }))}
            />
          </div>
        )}
      </div>
      {!cur || cur.state === 'loading' ? (
        <div aria-busy="true" aria-label={`Loading ${symbol ?? ''} price history`}>
          <Skeleton h={26} w={320} radius={8} />
          <Skeleton h={360} radius={8} style={{ marginTop: 10 }} />
        </div>
      ) : cur.state === 'error' ? (
        <div className="ch-empty" role="alert">
          <div className="inkstrong">Couldn’t load {symbol}’s price history.</div>
          <div className="ch-hint">{cur.message}</div>
          <Button size="mini" onClick={() => symbol && load(symbol)}>
            Retry
          </Button>
        </div>
      ) : (
        <PriceBody data={cur.data} trades={symbol ? trades[symbol] : undefined} onRetry={() => symbol && load(symbol)} />
      )}
    </div>
  )
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
            ? 'This session never tells the server what you hold, so it can’t ask for this symbol’s daily history. Prices build up from the shared daily quotes each time you open Investments, and the line starts once there are two.'
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
