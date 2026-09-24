import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { InvestAccountDetail, InvestAccountRow, PortfolioLot } from '../../shared/invest-api'
import { formatCents } from '../../shared/money'
import { get } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { Skeleton } from '../ui/Skeleton'
import { Tabs, tabId } from '../ui/Tabs'
import AccountSettings, { type AccountDeleted } from './AccountSettings'
import { institutionLine, KIND_TEXT, typeLabel } from './accountTypes'
import ActivityTable from './ActivityTable'
import { BalancePanel, StaleChip, UpdateBalanceButton } from './BalanceAccounts'
import { shortDay } from './balanceMath'
import { cashView } from './cashMath'
import CashPanel from './CashPanel'
import GrantsPanel from './GrantsPanel'
import HoldingsTable from './HoldingsTable'
import './invest.css'

export type DrawerTab = 'positions' | 'activity' | 'grants' | 'balances' | 'settings'

/** The tabs an account has: a lots account's holdings, trades and (stock plans) grants; a balance account's history. */
export function drawerTabs(a: Pick<InvestAccountRow, 'tracking'>): DrawerTab[] {
  return a.tracking === 'lots' ? ['positions', 'activity', 'grants', 'settings'] : ['balances', 'settings']
}

/** The tab to show for a `tab` route param: one this account has, else its first. */
export function drawerTab(a: Pick<InvestAccountRow, 'tracking'>, param: string | undefined): DrawerTab {
  const tabs = drawerTabs(a)
  return tabs.find((t) => t === param) ?? tabs[0]!
}

const TAB_LABEL: Record<DrawerTab, string> = { positions: 'Positions', activity: 'Activity', grants: 'Grants', balances: 'Balances', settings: 'Settings' }

export type AccountDrawerProps = {
  /** The account shown; null closes the drawer (it keeps the last one through the exit). */
  account: InvestAccountRow | null
  /** Every investment account (the activity rows' names and kinds). */
  accounts: readonly InvestAccountRow[]
  owners: readonly string[]
  tab: string | undefined
  /** Bump to refetch — the screen does after every load. */
  rev: number
  today: string
  marginal: { stMicro: number; ltMicro: number } | null
  onTab: (t: DrawerTab) => void
  onClose: () => void
  /** After anything here changes data (the screen reloads). */
  onChanged: () => void
  onRecordTrade: (accountId: number, lot?: PortfolioLot) => void
  onPasteOpening: (accountId: number) => void
  onDeleted: (r: AccountDeleted) => void
}

/**
 * One account, opened from its tile: a summary of what it's worth, then tabs
 * — Positions (its own holdings and lots, with Sell…), Activity (its trades,
 * editable), Grants (a stock plan's unvested shares) and Settings (profile,
 * tracking, tax treatment, Delete). A balance account has its Balances
 * history instead. Everything is fetched for this account alone
 * (GET /api/invest/accounts/:id).
 */
export default function AccountDrawer(p: AccountDrawerProps) {
  // Through the exit animation the drawer keeps showing the account it had.
  const [kept, setKept] = useState<InvestAccountRow | null>(p.account)
  if (p.account && p.account !== kept) setKept(p.account)
  const a = p.account ?? kept
  const open = p.account !== null

  const [detail, setDetail] = useState<InvestAccountDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const id = a?.id ?? null
  const load = useCallback(() => {
    if (!open || id === null) return
    let live = true
    setError(null)
    get<InvestAccountDetail>(`/api/invest/accounts/${id}`)
      .then((d) => live && setDetail(d))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [open, id])
  useEffect(() => load(), [load, p.rev])
  // Another account's numbers never flash under this one's name.
  const shown = detail && detail.account.id === id ? detail : null

  if (!a) return null
  const tab = drawerTab(a, p.tab)
  const where = institutionLine(a)
  const subtitle = [typeLabel(a), where, a.owner ?? 'Joint'].filter(Boolean).join(' · ')

  const cashV = shown ? cashView(shown.cash, p.today) : null
  let panel: ReactNode
  if (tab === 'settings')
    panel = (
      <AccountSettings
        account={a}
        owners={p.owners}
        institutions={[...new Set(p.accounts.map((x) => x.institution).filter((x): x is string => !!x))]}
        onSaved={p.onChanged}
        onDeleted={p.onDeleted}
      />
    )
  else if (tab === 'activity')
    panel = (
      <ActivityTable
        accounts={p.accounts}
        accountId={a.id}
        variant="plain"
        rev={p.rev}
        today={p.today}
        onChanged={p.onChanged}
        onRecord={() => p.onRecordTrade(a.id)}
      />
    )
  else if (error && !shown)
    panel = (
      <div className="inv-loaderr" role="alert">
        <span>Couldn’t load {a.name}: {error}</span>
        <Button size="mini" onClick={load}>Retry</Button>
      </div>
    )
  else if (!shown)
    panel = (
      <div className="inv-skel" aria-busy="true" aria-label={`Loading ${a.name}`}>
        <Skeleton h={14} w="45%" />
        <Skeleton h={14} />
        <Skeleton h={14} />
        <Skeleton h={14} w="80%" />
      </div>
    )
  else if (tab === 'balances') panel = <BalancePanel account={a} snapshots={shown.balances} today={p.today} onChanged={p.onChanged} />
  else if (tab === 'grants')
    panel =
      a.stock_plan === 1 ? (
        <GrantsPanel account={a} grants={shown.grants} onChanged={p.onChanged} />
      ) : (
        <EmptyState
          title="Not an employee stock plan"
          body="If your employer’s RSUs vest into this account, turn on “Employee stock plan” in Settings. Scarab then keeps the unvested count, and each vest becomes a buy at vest-day value."
          action={{ label: 'Open Settings', onClick: () => p.onTab('settings') }}
        />
      )
  else
    panel = (
      <div className="inv-panel">
        <div className="inv-paneltools">
          <span className="inv-note">
            {shown.positions.length > 0
              ? `${shown.positions.length} holding${shown.positions.length === 1 ? '' : 's'} · lots pool in this account alone`
              : 'Nothing held here right now'}
          </span>
          <span className="inv-rowactions">
            <Button size="mini" onClick={() => p.onPasteOpening(a.id)} title="Lots already held, as of a statement date">
              Paste starting positions
            </Button>
            <Button size="mini" variant="gold" onClick={() => p.onRecordTrade(a.id)}>
              + Record trade
            </Button>
          </span>
        </div>
        {shown.positions.length === 0 ? (
          <EmptyState
            title={a.counts.trades > 0 ? 'Everything here has been sold' : 'Nothing held here yet'}
            body={
              a.counts.trades > 0
                ? 'Its trades are in Activity. Record a buy, or paste positions as of a statement, to hold something again.'
                : 'Paste what it holds as of a statement date — Scarab keeps each lot’s real acquisition date, so holding periods and tax come out right. Or record trades as you make them.'
            }
            action={{ label: 'Paste starting positions', onClick: () => p.onPasteOpening(a.id) }}
          />
        ) : (
          <HoldingsTable
            variant="plain"
            positions={shown.positions}
            totals={shown.totals}
            marginal={p.marginal}
            today={p.today}
            onSell={(lot) => p.onRecordTrade(a.id, lot)}
            onPriceSaved={p.onChanged}
            cash={cashV?.state === 'set' ? { cents: cashV.cents, note: cashV.line } : null}
          />
        )}
        <CashPanel account={a} cash={shown.cash} anchors={shown.balances} today={p.today} onChanged={p.onChanged} inTable={shown.positions.length > 0} />
        {shown.warnings.length > 0 && (
          <div className="inv-callout inv-drawerwarn">
            <b>Data warnings</b>
            {shown.warnings.map((w, i) => (
              <span key={i}>{w}</span>
            ))}
          </div>
        )}
      </div>
    )

  return (
    <Drawer open={open} onClose={p.onClose} width={780} title={a.name} subtitle={subtitle}>
      <Summary a={a} detail={shown} today={p.today} onChanged={p.onChanged} />
      <Tabs
        aria-label={`${a.name} sections`}
        idPrefix="inv-acct"
        value={tab}
        onChange={p.onTab}
        tabs={drawerTabs(a).map((t) => ({
          value: t,
          label: TAB_LABEL[t],
          badge:
            t === 'activity' && a.counts.trades > 0
              ? a.counts.trades
              : t === 'grants' && a.counts.unvested > 0
                ? a.counts.unvested
                : t === 'balances' && a.counts.balances > 0
                  ? a.counts.balances
                  : undefined,
        }))}
      />
      <div role="tabpanel" id={`inv-acct-panel-${tab}`} aria-labelledby={tabId('inv-acct', tab)} className="inv-tabpanel">
        {panel}
      </div>
    </Drawer>
  )
}

/** The numbers at the top: what it's worth, and for a balance account when that was, with Update balance. */
function Summary({ a, detail, today, onChanged }: { a: InvestAccountRow; detail: InvestAccountDetail | null; today: string; onChanged: () => void }) {
  if (a.tracking === 'balance') {
    const snap = a.latest_snapshot
    return (
      <div className="inv-dsum">
        <div className="inv-dsum-main">
          <span className="inv-dsum-label">Balance</span>
          <span className="inv-dsum-v">{snap ? formatCents(snap.balance_cents) : '—'}</span>
          <span className="inv-dsum-sub">
            {snap ? `as of ${shortDay(snap.balanced_on, today)}` : 'no balance recorded yet'}
            <StaleChip balancedOn={snap?.balanced_on} today={today} />
          </span>
        </div>
        <div className="inv-dsum-side">
          <span className="inv-note">
            {a.kind === 'retirement'
              ? 'Tax-advantaged · counted in net worth from its statements.'
              : 'Counted in net worth from its statements; tracked by balance, its sales aren’t in the tax picture.'}
          </span>
          <UpdateBalanceButton account={a} snapshots={detail?.balances} today={today} onSaved={onChanged} className="inv-dsum-btn">
            Update balance
          </UpdateBalanceButton>
        </div>
      </div>
    )
  }
  const t = detail?.totals
  const sheltered = a.kind === 'retirement'
  const realized = t ? (sheltered ? t.ytd_sheltered : t.ytd_st + t.ytd_lt) : null
  const year = today.slice(0, 4)
  const cash = cashView(detail?.cash, today)
  const withCash = cash?.state === 'set' ? cash.cents : null
  return (
    <div className="inv-dsum">
      <div className="inv-dsum-main">
        <span className="inv-dsum-label">Value</span>
        <span className="inv-dsum-v">{t ? formatCents(t.value + (withCash ?? 0)) : <Skeleton h={22} w={140} />}</span>
        <span className="inv-dsum-sub">
          {t && withCash !== null ? `holdings ${formatCents(t.value)} · cash ${formatCents(withCash)}` : KIND_TEXT[a.kind].note}
        </span>
      </div>
      <dl className="inv-dsum-stats">
        <div>
          <dt>Cash</dt>
          <dd>
            {!cash ? '—' : cash.state === 'set' ? formatCents(cash.cents) : <span className="inv-dsum-none">not set</span>}
            {cash?.state === 'set' && <span className="inv-subline">{cash.short ? 'below $0 — update it' : `as of ${shortDay(detail!.cash!.cash_as_of!, today)}${detail!.cash!.cash_trades ? ' + trades' : ''}`}</span>}
            {cash?.state === 'none' && cash.uncountedCents > 0 && <span className="inv-subline">{formatCents(cash.uncountedCents)} of sales uncounted</span>}
          </dd>
        </div>
        <div>
          <dt>Cost basis</dt>
          <dd>{t ? formatCents(t.cost) : '—'}</dd>
        </div>
        <div>
          <dt>Unrealized</dt>
          <dd className={t && t.cost > 0 && t.unrealized !== 0 ? (t.unrealized > 0 ? 'pos' : 'neg') : undefined}>{t ? formatCents(t.unrealized, { sign: t.unrealized > 0 }) : '—'}</dd>
        </div>
        <div>
          <dt>Realized {year}</dt>
          <dd className={realized ? (realized > 0 ? 'pos' : 'neg') : undefined}>
            {realized === null ? '—' : formatCents(realized, { sign: realized > 0 })}
            {t && !sheltered && (t.ytd_st !== 0 || t.ytd_lt !== 0) && (
              <span className="inv-subline">
                ST {formatCents(t.ytd_st)} · LT {formatCents(t.ytd_lt)}
              </span>
            )}
            {t && sheltered && realized !== 0 && <span className="inv-subline">inside the account — no tax</span>}
          </dd>
        </div>
      </dl>
    </div>
  )
}
