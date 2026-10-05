import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { todayLocal } from '../../shared/dates'
import type { InvestAccountRow, PortfolioAccount, PortfolioLot, PortfolioPosition, PortfolioResponse, UnvestedRow } from '../../shared/invest-api'
import type { HistoryApplyResult, ReturnsResponse, SparksResponse } from '../../shared/series-api'
import { get, post } from '../api'
import { scopeReturns, type ScopedReturns } from '../cards/cardModel'
import PortfolioValueCard from '../cards/PortfolioValueCard'
import AccountDrawer, { type DrawerTab } from '../invest/AccountDrawer'
import AllocationCard from '../invest/AllocationCard'
import AccountStrip from '../invest/AccountStrip'
import ActivityTable from '../invest/ActivityTable'
import { accountValueCents } from '../invest/accountTypes'
import AddAccountFlow, { type AddAccountNext } from '../invest/AddAccountFlow'
import { shortDay } from '../invest/balanceMath'
import { portfolioCash } from '../invest/cashMath'
import CheckinDrawer from '../invest/CheckinDrawer'
import HoldingDrawer from '../invest/HoldingDrawer'
import HoldingsCard from '../invest/HoldingsCard'
import InvestSummary from '../invest/InvestSummary'
import OpeningPositionsSheet from '../invest/OpeningPositionsSheet'
import PastSalesSheet from '../invest/PastSalesSheet'
import { HOUSEHOLD, inScope, ownerGroups, scopePortfolio, scopeWords, type OwnerKey } from '../invest/ownerFilter'
import OwnerPills from '../invest/OwnerPills'
import { failedSymbols, priceClock, priceStale, refreshMemory, shouldRefresh } from '../invest/priceRefresh'
import TaxPictureCard from '../invest/TaxPictureCard'
import { accountsLine } from '../invest/tradeMath'
import TradeSheet from '../invest/TradeSheet'
import '../invest/invest.css'
import { localMode } from '../local'
import { setParams, useRouteState } from '../router'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { BASKET_EVENT } from '../ui/syncStatus'
import { HeaderSlot } from '../ui/HeaderSlot'
import { useAnchor, useScreen, useScreenRoute } from '../ui/screen'
import { toast } from '../ui/Toast'
import { Tooltip } from '../ui/Tooltip'
import { useAction } from '../ui/useAction'

type UnvestedList = { rows: UnvestedRow[]; total_est_cents: number }
type Marginal = { ordinaryMicro: number; stMicro: number; ltMicro: number }

const NO_POSITIONS: PortfolioPosition[] = []
const NO_OWNERS: string[] = []
const plural = (n: number, noun: string) => (n === 0 ? '' : `${n} ${noun}${n === 1 ? '' : 's'}`)
/** A monthly-history import's errors as one quiet line — just the symbols, when all they say is that the history lacks them. */
function historyLine(errors: readonly string[]): string {
  const missing = errors.map((e) => /^(.+): not in the shared market history$/.exec(e)?.[1])
  return missing.every((m) => m !== undefined) ? `Not in the shared market history: ${missing.join(', ')}` : errors.join(' · ')
}
const loadFailed = (e: unknown) => toast.error("Couldn't load investments", { detail: e instanceof Error ? e.message : String(e) })

type PriceContext = { memory: ReturnType<typeof refreshMemory>; clock: string | null }
/** This data universe's refresh memory, and the clock fresher prices would come from now (src/invest/priceRefresh.ts). */
async function priceContext(): Promise<PriceContext> {
  const session = localMode.active
  const memory = refreshMemory(session ? `s${localMode.dataEpoch}` : 'h')
  // In a tab, prices come from the shared basket: its build time is the clock.
  const builtAt = session
    ? ((await get<{ builtAt: string | null }>('/api/basket/status').catch(() => null))?.builtAt ?? null)
    : null
  return { memory, clock: priceClock(session ? 'session' : 'household', builtAt, todayLocal()) }
}
/** Nothing open: every param a drawer or sheet uses, cleared. */
const CLOSED = { d: null, acct: null, tab: null, lot: null, via: null, asset: null } as const
/** A positive integer route param (`acct`, `lot`, `asset`), or null. */
const idParam = (v: string | undefined): number | null => {
  const n = Number(v)
  return v && Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * Investments. What's open lives in the address, ids and enums only:
 *   ?d=account&acct=3[&tab=activity]       an account's drawer
 *   ?d=holding&asset=7                      a holding's drawer (the asset's id — never its ticker)
 *   ?d=add-account                          the guided add
 *   ?d=trade[&acct=3][&lot=41][&via=account] the record-trade sheet (via=account|holding: over that drawer, back to it on close)
 *   ?d=checkin                              the balance check-in
 * so a link or a reload opens the same thing, and ⌘K can send people there.
 */
export default function Invest() {
  const [accounts, setAccounts] = useState<InvestAccountRow[]>([])
  const [portfolio, setPortfolio] = useState<PortfolioResponse | null>(null)
  const [unvested, setUnvested] = useState<UnvestedList>({ rows: [], total_est_cents: 0 })
  const [owners, setOwners] = useState<string[]>(NO_OWNERS)
  const [loaded, setLoaded] = useState(false)
  // Bumped on every load so the activity ledger and the open drawer refetch alongside the portfolio.
  const [rev, setRev] = useState(0)
  // '#/invest/allocation' (the Checkup's drift findings, the digest, ⌘K) scrolls to the allocation card.
  const allocationAnchor = useAnchor('allocation')
  // The starting-positions sheet, and the account it opens on.
  const [opening, setOpening] = useState<{ accountId: number | null } | null>(null)
  const [pastSales, setPastSales] = useState<{ accountId: number | null } | null>(null)
  const [taxMarginal, setTaxMarginal] = useState<Marginal | null>(null)
  const [taxCarryIn, setTaxCarryIn] = useState<{ stCents: number; ltCents: number } | null>(null)
  // Return by holding and the sparklines' closes: the Holdings table's extra columns, which it can draw without.
  const [returns, setReturns] = useState<ReturnsResponse | null>(null)
  const [sparks, setSparks] = useState<SparksResponse | null>(null)
  // What the last monthly-history import (a tab's refresh, B3) couldn't cover: shown quietly beside the refresh button.
  const [historyErrors, setHistoryErrors] = useState<string[]>([])
  const today = todayLocal()
  const { active } = useScreen()
  const route = useScreenRoute()
  const d = route.params.d
  const acctParam = idParam(route.params.acct)
  const assetParam = idParam(route.params.asset)
  const via = route.params.via

  const load = useCallback(async () => {
    const [a, p, u, o] = await Promise.all([
      get<InvestAccountRow[]>('/api/invest/accounts'),
      get<PortfolioResponse>('/api/portfolio'),
      get<UnvestedList>('/api/unvested'),
      get<string[]>('/api/invest/owners'),
    ])
    setAccounts(a)
    setPortfolio(p)
    setUnvested(u)
    setOwners(o)
    setLoaded(true)
    setRev((n) => n + 1)
    get<{ marginal: Marginal; incomes: { carryInStCents: number; carryInLtCents: number } }>('/api/tax')
      .then((t) => {
        setTaxMarginal(t.marginal)
        setTaxCarryIn({ stCents: t.incomes.carryInStCents, ltCents: t.incomes.carryInLtCents })
      })
      .catch(() => {
        setTaxMarginal(null)
        setTaxCarryIn(null)
      })
    get<ReturnsResponse>('/api/portfolio/returns')
      .then(setReturns)
      .catch(() => undefined) // a failed refresh keeps the last ones
    get<SparksResponse>('/api/portfolio/sparks')
      .then(setSparks)
      .catch(() => undefined)
    return p
  }, [])
  const reload = useCallback(() => {
    load().catch(loadFailed)
  }, [load])

  const refresh = useAction(
    async (quiet: boolean, known?: PriceContext) => {
      const ctx = known ?? (await priceContext())
      // In a tab the reply can carry the monthly-history import that ran with it (src/local/routes-analytics.ts).
      const r = await post<{ updated: number; errors: string[]; history?: HistoryApplyResult }>('/api/prices/refresh', {})
      if (r.history) setHistoryErrors(r.history.errors)
      const p = await load()
      // Every holding took part in this refresh (by hand or not): the same clock won't ask for them again.
      // In a tab the refresh may have had today's basket built: remember the clock as it now stands.
      const held = p.positions.map((x) => x.symbol)
      const clock = localMode.active ? ((await priceContext()).clock ?? ctx.clock) : ctx.clock
      if (clock) ctx.memory.record(clock, failedSymbols(r.errors, held), held)
      if (localMode.active) window.dispatchEvent(new Event(BASKET_EVENT))
      return { ...r, quiet, positions: p.positions }
    },
    {
      errorPrefix: "Couldn't refresh prices",
      onDone: (r) => {
        if (r.quiet) {
          // Quietly, speak up only for holdings left with no usable price —
          // not for ones already priced by hand.
          const failed = new Set(failedSymbols(r.errors, r.positions.map((x) => x.symbol)))
          const unpriced = r.positions.filter((x) => failed.has(x.symbol) && !x.price_manual && priceStale(x.priced_on, todayLocal()))
          if (unpriced.length > 0)
            toast.info(`No market quote for ${unpriced.map((x) => x.symbol).join(', ')} — use “Set price” on ${unpriced.length === 1 ? 'its row' : 'their rows'} in Holdings.`)
          return
        }
        const text = `Prices updated for ${plural(r.updated, 'asset') || 'no assets'}`
        if (r.errors.length) toast.info(`${text} · ${r.errors.join(' · ')}`)
        else toast.success(text)
      },
    },
  )

  // Fetches prices only if fresher ones can exist than what is stored and
  // this tab hasn't already asked for them (src/invest/priceRefresh.ts).
  const autoRefresh = useCallback(
    async (p: PortfolioResponse, live: () => boolean = () => true) => {
      if (!live() || p.positions.length === 0) return
      const ctx = await priceContext()
      if (!live() || !ctx.clock) return
      ctx.memory.adopt(p.positions.map((x) => x.symbol))
      if (!shouldRefresh(p.positions, ctx.clock, ctx.memory.failed, ctx.memory.refreshedFor, ctx.memory.covered)) return
      await refresh.run(true, ctx)
    },
    [refresh.run],
  )
  // After a trade, a vest or starting positions: a symbol new to the household arrives unpriced, and
  // the day's refresh ran without it — price it now rather than carry it at cost until tomorrow.
  const reloadAndPrice = useCallback(() => {
    load()
      .then((p) => autoRefresh(p))
      .catch(loadFailed)
  }, [load, autoRefresh])

  // Every visit (keep-alive re-runs this on reveal) reloads quietly, then refreshes prices if due.
  useEffect(() => {
    let live = true
    load()
      .then((p) => autoRefresh(p, () => live))
      .catch(loadFailed)
    return () => {
      live = false
    }
  }, [load, autoRefresh])

  /* ---------- what's open: drawers and sheets, from the address ---------- */

  const lotAccounts = accounts.filter((a) => a.tracking === 'lots')
  const knownSymbols = useMemo(() => new Set((portfolio?.positions ?? NO_POSITIONS).map((p) => p.symbol)), [portfolio])
  const unvestedByAccount = useMemo(() => {
    const m = new Map<number, number>()
    for (const u of unvested.rows) m.set(u.invest_account_id, (m.get(u.invest_account_id) ?? 0) + u.qty_micro)
    return m
  }, [unvested])
  const institutions = useMemo(() => [...new Set(accounts.map((a) => a.institution).filter((x): x is string => !!x))], [accounts])
  const cashByAccount = useMemo(() => new Map<number, PortfolioAccount>((portfolio?.accounts ?? []).map((a) => [a.invest_account_id, a])), [portfolio])

  // The owner pills: whose accounts the screen shows (route state — a name never goes in the address).
  const [ownerPick, setOwnerPick] = useRouteState<OwnerKey>('investOwner', HOUSEHOLD)
  const groups = useMemo(() => ownerGroups(accounts, owners, portfolio?.positions ?? NO_POSITIONS, cashByAccount), [accounts, owners, portfolio, cashByAccount])
  const group = groups.find((g) => g.key === ownerPick) // gone (renamed, deleted): back to the household
  const scoped = !!group && group.key !== HOUSEHOLD
  const shownAccounts = useMemo(() => (scoped ? accounts.filter((a) => inScope(a, group!.key)) : accounts), [accounts, scoped, group])
  const scopeIds = useMemo(() => (scoped ? new Set(shownAccounts.map((a) => a.id)) : undefined), [scoped, shownAccounts])
  // The trend cards count lots-tracked accounts only (as inv:all does).
  const scopeLotIds = useMemo(
    () => (scoped ? new Set(shownAccounts.filter((a) => a.tracking === 'lots').map((a) => a.id)) : undefined),
    [scoped, shownAccounts],
  )
  const scopeLabel = scoped ? scopeWords(group!) : undefined
  const view = useMemo(
    () => (portfolio ? (scopeIds ? scopePortfolio(portfolio.positions, portfolio.totals, scopeIds) : { positions: portfolio.positions, totals: portfolio.totals }) : null),
    [portfolio, scopeIds],
  )
  const cash = portfolio ? portfolioCash(scopeIds ? portfolio.accounts.filter((a) => scopeIds.has(a.invest_account_id)) : portfolio.accounts) : null
  const viewReturns = useMemo(
    (): ScopedReturns | null => (!returns || !portfolio ? null : scopeIds ? scopeReturns(returns, portfolio.positions, scopeIds) : returns),
    [returns, portfolio, scopeIds],
  )
  // What the accounts in view are worth (their tiles, added up), and the part of it known only from statements.
  const worth = useMemo(() => {
    let value = 0
    let byBalance = 0
    for (const a of shownAccounts) {
      const v = accountValueCents(a, portfolio?.positions ?? NO_POSITIONS, a.tracking === 'lots' ? cashByAccount.get(a.id) : undefined) ?? 0
      value += v
      if (a.tracking === 'balance') byBalance += v
    }
    return { value, byBalance }
  }, [shownAccounts, portfolio, cashByAccount])

  const tradeOpen = d === 'trade'
  const drawerWanted = acctParam !== null && (d === 'account' || (tradeOpen && via === 'account'))
  const drawerAccount = loaded && drawerWanted ? (accounts.find((a) => a.id === acctParam) ?? null) : null
  const holdingWanted = assetParam !== null && (d === 'holding' || (tradeOpen && via === 'holding'))
  const holding = loaded && holdingWanted ? (view?.positions.find((x) => x.asset_id === assetParam) ?? null) : null
  const addOpen = loaded && d === 'add-account'
  const checkinOpen = loaded && d === 'checkin'

  // A trade needs a lots-tracked account to go in (⌘K's "Record trade" can arrive before there is one):
  // say so and start the guided add instead of opening nothing.
  const noTradeAccount = active && loaded && tradeOpen && lotAccounts.length === 0
  useEffect(() => {
    if (!noTradeAccount) return
    toast.info('Add a brokerage account first')
    setParams({ ...CLOSED, d: 'add-account' })
  }, [noTradeAccount])

  /**
   * Where focus goes once a drawer closes, if the dialog had no opener to
   * return it to (it opened from a link) or the opener is gone (a deleted
   * account's tile): the thing that opens it again. Applied by the effect
   * below, after the commit that closed the dialog — its own focus return
   * runs in a layout effect of that commit, so by then focus is settled.
   */
  const landFocus = useRef<{ sel: string; afterRev?: number } | null>(null)
  useEffect(() => {
    const want = landFocus.current
    if (!want || !active || (want.afterRev !== undefined && rev <= want.afterRev) || document.querySelector('dialog[open]')) return
    landFocus.current = null
    // Lost: on the page itself, or still inside the closed dialog (its content stays through the exit fade).
    const a = document.activeElement
    if (!a || a === document.body || !a.isConnected || a.closest('dialog:not([open])')) document.querySelector<HTMLElement>(want.sel)?.focus()
  })
  const refocusTile = (key: number | 'add') => {
    landFocus.current = { sel: `.inv-strip [data-acct="${key}"]` }
  }
  const openAccount = (id: number, tab?: DrawerTab) => setParams({ ...CLOSED, d: 'account', acct: id, tab: tab ?? null })
  const closeAccount = () => {
    setParams(CLOSED)
    if (acctParam !== null) refocusTile(acctParam)
  }
  const openHolding = (assetId: number) => setParams({ ...CLOSED, d: 'holding', asset: assetId })
  const openAdd = () => setParams({ ...CLOSED, d: 'add-account' })
  const openCheckin = () => setParams({ ...CLOSED, d: 'checkin' })
  /** Opened from a link there's no opener to return to: land on the button that opens it. */
  const closeCheckin = () => {
    setParams({ d: null })
    landFocus.current = { sel: '.inv-accounts [data-checkin]' }
  }
  /** Where "starting positions" should open: the named account, else the first lots account with nothing in it yet. */
  const openOpening = (accountId?: number) =>
    setOpening({ accountId: accountId ?? lotAccounts.find((a) => a.counts.trades === 0)?.id ?? lotAccounts[0]?.id ?? null })

  // The sheet's open state lives in the address (ids only), so a link or a reload opens it.
  const openTrade = (o: { accountId?: number; lotTradeId?: number; over?: 'account' | 'holding' } = {}) =>
    setParams({ d: 'trade', acct: o.accountId ?? null, lot: o.lotTradeId ?? null, via: o.over ?? null, ...(o.over === 'holding' ? {} : { asset: null }) })
  // Opened over a drawer, the sheet closes back onto it.
  const closeTrade = () =>
    via === 'account' && acctParam !== null
      ? setParams({ d: 'account', lot: null, via: null })
      : via === 'holding' && assetParam !== null
        ? setParams({ d: 'holding', acct: null, lot: null, via: null })
        : setParams(CLOSED)
  /** Sell… on a lot: the sheet opens on that lot's account with the lot chosen. */
  const sellLot = (lot: PortfolioLot, over?: 'account' | 'holding') =>
    openTrade({ accountId: lot.invest_account_id, lotTradeId: lot.trade_id ?? undefined, over })

  // A link to an account or a holding that isn't there (deleted, sold, outside the owner in view, or another
  // universe's id) just closes — after one fresh look, since the list may predate it (a revisit's reload still in flight).
  const missing = !(active && loaded)
    ? null
    : drawerWanted && drawerAccount === null
      ? `account:${acctParam}`
      : holdingWanted && holding === null && portfolio !== null
        ? `holding:${assetParam}`
        : null
  const [lookedAt, setLookedAt] = useState<{ what: string; rev: number } | null>(null)
  useEffect(() => {
    if (missing === null) return
    if (lookedAt?.what !== missing) {
      setLookedAt({ what: missing, rev })
      reload()
    } else if (rev > lookedAt.rev) setParams(CLOSED)
  }, [missing, lookedAt, rev, reload])

  function afterAdd(next: AddAccountNext) {
    if (next.to === 'paste') {
      setParams({ d: null })
      openOpening(next.accountId)
    } else if (next.to === 'trade') openTrade({ accountId: next.accountId })
    else openAccount(next.accountId, next.tab)
  }

  const pricedOn = portfolio?.positions.reduce<string | null>((m, p) => (p.priced_on && (!m || p.priced_on > m) ? p.priced_on : m), null)
  const hasHoldings = (portfolio?.positions.length ?? 0) > 0
  const strip = (
    <AccountStrip
      accounts={shownAccounts}
      positions={portfolio?.positions ?? NO_POSITIONS}
      cash={cashByAccount}
      unvested={unvestedByAccount}
      owners={owners}
      today={today}
      loaded={loaded}
      onOpen={(id) => openAccount(id)}
      onAdd={openAdd}
      actions={
        loaded &&
        accounts.length > 0 && (
          <Tooltip content="Update every balance from this month’s statements">
            <Button size="mini" data-checkin onClick={openCheckin}>
              Check in balances
            </Button>
          </Tooltip>
        )
      }
    />
  )

  return (
    <div className="grid12">
      <HeaderSlot
        sub={accounts.length > 0 ? accountsLine(accounts.map((a) => a.name)) : undefined}
        actions={
          lotAccounts.length > 0 ? (
            <Button variant="gold" onClick={() => openTrade()}>
              + Record trade
            </Button>
          ) : loaded ? (
            <Button variant="gold" onClick={openAdd}>
              + Add account
            </Button>
          ) : undefined
        }
      />

      {/* ---------- the headline: worth, today, overall ---------- */}
      {(!loaded || accounts.length > 0) && (
        <InvestSummary
          loaded={loaded}
          valueCents={worth.value}
          totals={view?.totals ?? null}
          positions={view?.positions ?? NO_POSITIONS}
          cashCents={cash ? cash.cents : null}
          balanceCents={worth.byBalance}
          rate={viewReturns?.totals ?? null}
          today={today}
          scopeLabel={scopeLabel}
          filter={<OwnerPills groups={groups} value={group?.key ?? HOUSEHOLD} onChange={setOwnerPick} />}
          actions={
            loaded &&
            hasHoldings && (
              <>
                {pricedOn && <span className="muted">prices as of {shortDay(pricedOn, today)}</span>}
                {historyErrors.length > 0 && (
                  <Tooltip content={historyErrors.join(' · ')}>
                    <span className="muted inv-hist-errs">{historyLine(historyErrors)}</span>
                  </Tooltip>
                )}
                <Button size="mini" busy={refresh.busy} onClick={() => void refresh.run(false)}>
                  Refresh prices
                </Button>
              </>
            )
          }
        />
      )}

      {/* Until something is held, the accounts come first: they are what there is to set up. */}
      {!hasHoldings && strip}

      {/* ---------- nothing held yet: bring it in ---------- */}
      {loaded && lotAccounts.length > 0 && portfolio !== null && portfolio.positions.length === 0 && !scoped && (
        <div className="card c12">
          <EmptyState
            title="Bring in what you already hold"
            body="Paste each account’s lots as of a statement date — symbol, shares, cost basis, acquired. Scarab keeps the true acquisition dates, so holding periods and tax come out right. New trades go in with Record trade."
            action={{ label: 'Paste starting positions', onClick: () => openOpening() }}
          />
        </div>
      )}

      {/* ---------- warnings ---------- */}
      {portfolio && portfolio.warnings.length > 0 && (
        <div className="card c12 warncard">
          <h2>Data warnings</h2>
          {portfolio.warnings.map((w, i) => (
            <p key={i} className="sub2">{w}</p>
          ))}
        </div>
      )}

      <PortfolioValueCard rev={rev} accountIds={scopeLotIds} scopeLabel={scopeLabel} />

      {/* ---------- holdings ---------- */}
      {portfolio && view && view.positions.length > 0 && (
        <HoldingsCard
          positions={view.positions}
          totals={view.totals}
          returns={viewReturns}
          sparks={sparks}
          today={today}
          onOpen={openHolding}
          onPriceSaved={reload}
          cash={cash && { cents: cash.cents, note: `in ${cash.accounts} account${cash.accounts === 1 ? '' : 's'}` }}
          scopeLabel={scopeLabel}
        />
      )}

      {/* ---------- accounts ---------- */}
      {hasHoldings && strip}

      {/* ---------- tax (household-wide: one return) ---------- */}
      {portfolio && (hasHoldings || portfolio.totals.ytd_reported_st !== 0 || portfolio.totals.ytd_reported_lt !== 0) && (
        <TaxPictureCard totals={portfolio.totals} marginal={taxMarginal} year={today.slice(0, 4)} scope={scopeLabel ?? null} carryIn={taxCarryIn} />
      )}

      {/* ---------- target allocation (household-wide: the owner filter doesn't narrow it) ---------- */}
      {loaded && accounts.length > 0 && <AllocationCard rev={rev} anchor={allocationAnchor} planOpen={route.rest[0] === 'allocation'} />}

      {/* ---------- the activity ledger ---------- */}
      {lotAccounts.length > 0 && (!scoped || shownAccounts.some((a) => a.tracking === 'lots')) && (
        <ActivityTable accounts={accounts} rev={rev} today={today} onChanged={reloadAndPrice} onRecord={() => openTrade()} scope={scopeIds} />
      )}

      {/* The drawers render before the trade sheet: opened together from a link, the sheet stacks on top. */}
      <HoldingDrawer
        position={holding}
        ret={holding ? viewReturns?.rows.find((r) => r.asset_id === holding.asset_id) : undefined}
        portfolioValue={view?.totals.value ?? 0}
        accounts={accounts}
        scope={scopeIds}
        scopeLabel={scopeLabel}
        rev={rev}
        today={today}
        marginal={taxMarginal}
        onClose={() => setParams(CLOSED)}
        onChanged={reloadAndPrice}
        onRecordTrade={(accountId, lot) => (lot ? sellLot(lot, 'holding') : openTrade({ accountId, over: 'holding' }))}
      />

      <AccountDrawer
        account={drawerAccount}
        accounts={accounts}
        owners={owners}
        tab={route.params.tab}
        rev={rev}
        today={today}
        marginal={taxMarginal}
        onTab={(tab) => setParams({ tab })}
        onClose={closeAccount}
        onChanged={reloadAndPrice}
        onRecordTrade={(accountId, lot) => (lot ? sellLot(lot, 'account') : openTrade({ accountId, over: 'account' }))}
        onPasteOpening={(accountId) => openOpening(accountId)}
        onPasteSales={(accountId) => setPastSales({ accountId })}
        onDeleted={() => {
          setParams(CLOSED)
          // Its tile (where focus would return) is gone: once the list reloads, land on the strip instead of the page.
          landFocus.current = { sel: '.inv-strip .inv-tile', afterRev: rev }
          reload()
        }}
      />

      <TradeSheet
        open={loaded && tradeOpen}
        accounts={lotAccounts}
        positions={portfolio?.positions ?? NO_POSITIONS}
        init={{ accountId: acctParam, lotTradeId: idParam(route.params.lot) }}
        today={today}
        onClose={closeTrade}
        onRecorded={reloadAndPrice}
        onPasteOpening={(id) => {
          closeTrade()
          openOpening(id)
        }}
        onPasteSales={(id) => {
          closeTrade()
          setPastSales({ accountId: id })
        }}
      />

      <AddAccountFlow
        open={addOpen}
        owners={owners}
        institutions={institutions}
        today={today}
        onClose={() => {
          setParams({ d: null })
          refocusTile('add')
        }}
        onCreated={() => load().catch(() => undefined)}
        onNext={afterAdd}
      />

      <CheckinDrawer
        open={checkinOpen}
        owners={owners}
        today={today}
        onClose={closeCheckin}
        onSaved={reload}
        onAddAccount={openAdd}
      />

      <PastSalesSheet
        open={pastSales !== null}
        accounts={lotAccounts}
        initialAccountId={pastSales?.accountId ?? null}
        onClose={() => setPastSales(null)}
        onDone={reload}
      />

      <OpeningPositionsSheet
        open={opening !== null}
        accounts={lotAccounts}
        initialAccountId={opening?.accountId ?? null}
        knownSymbols={knownSymbols}
        today={today}
        onClose={() => setOpening(null)}
        // New symbols arrive unpriced: fetch their quotes now.
        onDone={reloadAndPrice}
      />
    </div>
  )
}
