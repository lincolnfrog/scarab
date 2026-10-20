import { useEffect, useState } from 'react'
import { localMode } from '../local'
import { Link, useRouteState } from '../router'
import { Button } from '../ui/Button'
import { DetailView } from '../ui/Drill'
import { EmptyState } from '../ui/EmptyState'
import { useAction } from '../ui/useAction'
import { useMarketSymbols } from './marketSymbols'
import './invest.css'

type Suggest = typeof import('./suggest')

/**
 * '#/invest/cover' — "Ask the basket to cover this fund", opened from a
 * holding's drawer when a session holds a fund the shared basket doesn't
 * quote (so it has a hand-entered price). The symbol rides in route state,
 * never in the address. The module that knows the fund list (~165 KB) and
 * does the asking loads when this view opens.
 *
 * What it says, honestly: the request names this fund among 31 others drawn
 * from the same population, so the server learns that this household named
 * one of 32 funds, and when — not which (PRIVACY.md "Anonymous add").
 */
export default function CoverFundView() {
  const [symbol] = useRouteState<string | null>('coverSymbol', null)
  const market = useMarketSymbols()
  const [mod, setMod] = useState<Suggest | null>(null)
  const [, bump] = useState(0)
  useEffect(() => {
    let live = true
    import('./suggest').then((m) => live && setMod(m)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  useEffect(() => (mod ? mod.onSuggestChange(() => bump((n) => n + 1)) : undefined), [mod])
  // While an ask is scheduled, the "in about N min" line counts down (the state itself changes only when it is sent).
  const scheduled = !!symbol && mod?.suggestState(symbol.toUpperCase())?.state === 'scheduled'
  useEffect(() => {
    if (!scheduled) return
    const t = setInterval(() => bump((n) => n + 1), 20_000)
    return () => clearInterval(t)
  }, [scheduled])

  const ask = useAction(async () => mod!.scheduleSuggest(symbol!, market), { errorPrefix: 'Couldn’t schedule the request' })

  const back = <Link to={{ screen: 'invest' }}>Back to Investments</Link>
  if (!symbol)
    return (
      <DetailView title="Ask the basket to cover a fund">
        <div className="card c12">
          <EmptyState title="Open a holding first" body="This view is reached from a holding’s drawer — the fund the basket doesn’t quote yet." />
          <p className="sub2">{back}</p>
        </div>
      </DetailView>
    )
  const sym = symbol.toUpperCase()
  const can = mod ? mod.canSuggest(sym, market) : null
  const state = mod?.suggestState(sym) ?? null
  const k = mod?.SUGGEST_K ?? 32
  const hasSecret = localMode.vault !== null

  return (
    <DetailView title={`Ask the basket to cover ${sym}`} plain>
      <div className="card inv-cover">
        {!mod || can === null ? (
          <p className="sub2">Loading the fund list…</p>
        ) : can === 'in-basket' ? (
          <>
            <h2>{sym} is already in the basket</h2>
            <p className="sub2">The next price refresh quotes it; nothing to ask for. {back}</p>
          </>
        ) : can === 'not-a-fund' ? (
          <>
            <h2>{sym} isn’t a registered fund’s ticker</h2>
            <p className="sub2">
              The basket can only be asked for US mutual funds (the SEC’s list of fund share classes, like VFIAX). A collective investment trust, a
              private company or a plan-specific unit has no public price feed at all: keep setting its price by hand. {back}
            </p>
          </>
        ) : (
          <>
            <h2>The basket doesn’t quote {sym}</h2>
            <p className="inv-cover-lead">
              Ask it to. The request names <b className="inkstrong">{sym}</b> among {k - 1} other fund tickers drawn from the same list — so the
              server learns that this household named one of {k} funds, and when, not which — and it quotes all {k} from its next daily build on,
              for everyone. Prices follow within a day; history over the next month’s crawls.
            </p>
            <p className="sub2">
              {hasSecret
                ? `The ${k - 1} others are drawn from your vault’s key and the symbol, so asking again — later, or from another device — names the same ${k} and tells the server nothing new.`
                : `There is no vault yet, so the ${k - 1} others are random: ask once, and don’t ask again from another device before tomorrow, or the two lists would narrow it down.`}{' '}
              The request is sent after a random wait of up to ten minutes, while this tab stays open.
            </p>
            {state === null || state.state === 'failed' ? (
              <div className="formrow inv-cover-actions">
                <Button variant="gold" busy={ask.busy} onClick={() => void ask.run()}>
                  Ask for {sym} among {k - 1} others
                </Button>
                {state?.state === 'failed' && <span className="sub2 neg">Not sent: {state.error}. Try again in a minute.</span>}
              </div>
            ) : state.state === 'scheduled' ? (
              <p className="sub2 inv-cover-state">
                Scheduled — it goes out in about {Math.max(1, Math.round((state.at - Date.now()) / 60_000))} min, if this tab stays open. You can keep using
                Scarab meanwhile.
              </p>
            ) : state.state === 'sending' ? (
              <p className="sub2 inv-cover-state">Sending…</p>
            ) : (
              <p className="sub2 inv-cover-state">
                Sent: {sym} is on the basket’s list ({state.added} of the {state.k} were new to it). It gets a quote at the next daily build — usually by
                tomorrow — and the hand-entered price stands until then.
              </p>
            )}
          </>
        )}
      </div>
    </DetailView>
  )
}
