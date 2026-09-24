import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { todayLocal } from '../../shared/dates'
import { formatCents } from '../../shared/money'
import type { Account, BudgetRow, Category, CategorySpend, ImportSummary, MonthlyFlow, Tx, TxPage } from '../../shared/types'
import { get, patch, post, put } from '../api'
import { setParams, useRouteState } from '../router'
import { Bullets, fmtMonth, fmtShort } from '../viz'
import RecurringCard from '../RecurringCard'
import CashFlowCard from '../cards/CashFlowCard'
import CategorySpendCard from '../cards/CategorySpendCard'
import { Button } from '../ui/Button'
import { useDeepAction } from '../ui/CommandPalette'
import { prompt } from '../ui/dialogs'
import { EmptyState } from '../ui/EmptyState'
import { MoneyInput, Select, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { prefersReducedMotion } from '../ui/motion'
import { anchorId, useAnchor, useScreen, useScreenRoute } from '../ui/screen'
import { Skeleton } from '../ui/Skeleton'
import { toast } from '../ui/Toast'
import { useAction } from '../ui/useAction'
import {
  cashParamsPatch,
  monthChoices,
  readCashParams,
  TX_PAGE,
  TX_REFRESH_MAX,
  txFilterQuery,
  txPageQuery,
  type CashFilters,
  type CatFilter,
} from './cash-route'
import './screens.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * One category's monthly budget in the "Set budgets" table: integer cents in
 * a labelled number box, saved on blur/Enter only when it changed. A failed
 * save puts the stored amount back. Blank means no budget (0).
 */
function BudgetInput(p: { row: BudgetRow; onSave: (row: BudgetRow, cents: number) => Promise<unknown> }) {
  const stored = p.row.monthly_cents
  const [v, setV] = useState<number | null>(stored > 0 ? stored : null)
  const [seen, setSeen] = useState(stored)
  if (seen !== stored) {
    setSeen(stored)
    setV(stored > 0 ? stored : null)
  }
  return (
    <MoneyInput
      value={v}
      width={120}
      placeholder="0.00"
      aria-label={`${p.row.name} monthly budget`}
      onChange={setV}
      onCommit={async (c) => {
        if ((c ?? 0) === stored) return
        if ((await p.onSave(p.row, c ?? 0)) === undefined) setV(stored > 0 ? stored : null)
      }}
    />
  )
}

/** The header's subtitle: the bank accounts imports land in (the mockup's "Wells Fargo checking ··2841 & savings ··7730"). */
function accountsLine(accounts: Account[] | null): string {
  if (!accounts?.length) return 'Bank CSV or OFX downloads · the plan resets monthly'
  const names = accounts.slice(0, 3).map((a) => a.name)
  const more = accounts.length > 3 ? ` +${accounts.length - 3} more` : ''
  return `${names.join(' · ')}${more} · the plan resets monthly`
}

/** How long after arriving at a section link the screen keeps it in view while the cards above it load. */
const SETTLE_MS = 2500

/**
 * A section link (#/cash/transactions, #/cash/budget — the Dashboard's and
 * the digest's) scrolls when its card mounts (useAnchor), which is often
 * before the charts, budget and recurring cards above it have loaded; each
 * one that lands pushes the section back down. For a moment after arriving,
 * follow the section as the layout settles — until the person scrolls
 * themselves. Arriving is the screen showing, or the section changing (as
 * useAnchor reads it); a filter change on the same path isn't.
 */
function useSettleOnSection(section: string | undefined, active: boolean) {
  useEffect(() => {
    const scroller = document.getElementById('main')
    if (!active || !section || !scroller) return
    let stopped = false
    const stop = () => {
      stopped = true
    }
    // Each frame: where the section sits in the page (scrolling doesn't move that) and how tall the page is.
    // Jump back to it when it moves, or when the page grew while it sits below its spot (a first scroll cut
    // short by a page too short to reach it). A layout that never changes leaves useAnchor's smooth scroll alone.
    let at: number | null = null
    let tall: number | null = null
    let raf = 0
    const tick = () => {
      if (stopped) return
      const el = document.getElementById(anchorId('cash', section))
      if (el) {
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const now = top + scroller.scrollTop
        const moved = at !== null && Math.abs(now - at) > 1
        const grew = tall !== null && scroller.scrollHeight > tall && top > (parseFloat(getComputedStyle(el).scrollMarginTop) || 0) + 1
        if (moved || grew) el.scrollIntoView({ block: 'start' })
        at = now
        tall = scroller.scrollHeight
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const done = setTimeout(stop, SETTLE_MS)
    const opts = { passive: true }
    scroller.addEventListener('wheel', stop, opts)
    scroller.addEventListener('touchstart', stop, opts)
    scroller.addEventListener('pointerdown', stop, opts)
    window.addEventListener('keydown', stop)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(done)
      scroller.removeEventListener('wheel', stop)
      scroller.removeEventListener('touchstart', stop)
      scroller.removeEventListener('pointerdown', stop)
      window.removeEventListener('keydown', stop)
    }
  }, [section, active])
}

/** A posted date as the table shows it: 'MM-DD' this year, the full date otherwise (Load more reaches back years). */
const shortDate = (iso: string, year: string) => (iso.startsWith(year) ? iso.slice(5) : iso)

export default function Cash() {
  // The view lives in the URL: month, category, account and scope in the fragment, the search text in route state.
  const route = useScreenRoute()
  const filters = useMemo(() => readCashParams(route.params), [route.params])
  const setFilters = (patch: Partial<CashFilters>) => setParams(cashParamsPatch(patch))
  const [q, setQ] = useRouteState('q', '')

  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [categories, setCategories] = useState<Category[] | null>(null)
  // null until the first load lands, so the "Nothing here yet" copy never flashes before the data.
  const [monthly, setMonthly] = useState<MonthlyFlow[] | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [catSpend, setCatSpend] = useState<CategorySpend[]>([])
  const [budget, setBudget] = useState<BudgetRow[]>([])
  const [page, setPage] = useState<TxPage | null>(null)
  const [moreBusy, setMoreBusy] = useState(false)
  const [dataVersion, setDataVersion] = useState(0)
  const [importAccount, setImportAccount] = useState<number | null>(null)
  const [editBudgets, setEditBudgets] = useState(false)
  const [newAccount, setNewAccount] = useState<{ name: string; kind: 'checking' | 'savings' } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const accountNameRef = useRef<HTMLInputElement>(null)
  const txAnchor = useAnchor('transactions')
  const budgetAnchor = useAnchor('budget')
  const importAnchor = useAnchor('import')
  const { active } = useScreen()
  useSettleOnSection(route.rest[0], active)

  // What the filters resolve to. A filter naming an account or category that no longer exists reads as "all".
  const latest = monthly?.at(-1)?.month ?? null
  const month = filters.month ?? latest ?? todayLocal().slice(0, 7)
  const acct: number | 'all' =
    accounts && filters.acct !== 'all' && !accounts.some((a) => a.id === filters.acct) ? 'all' : filters.acct
  const cat: CatFilter =
    categories && typeof filters.cat === 'number' && !categories.some((c) => c.id === filters.cat) ? 'all' : filters.cat
  const filterQuery = txFilterQuery({ cat, acct, scope: filters.scope, month, q })
  const filtered = filterQuery !== ''

  const loadStatic = useCallback(async () => {
    const [a, c] = await Promise.all([get<Account[]>('/api/accounts'), get<Category[]>('/api/categories')])
    setAccounts(a)
    setCategories(c)
    setImportAccount((cur) => (cur !== null && a.some((x) => x.id === cur) ? cur : (a[0]?.id ?? null)))
    if (a.length === 0) setNewAccount((cur) => cur ?? { name: '', kind: 'checking' })
  }, [])
  const loadMonthly = useCallback(async () => {
    setMonthly(await get<MonthlyFlow[]>('/api/cashflow/monthly?months=12'))
  }, [])
  // A failed first load says so, with a retry; a failed refresh keeps what's on screen.
  const loadAll = useCallback(
    () => Promise.all([loadStatic(), loadMonthly()]).then(() => setLoadErr(null), (e: unknown) => setLoadErr(message(e))),
    [loadStatic, loadMonthly],
  )
  useEffect(() => {
    void loadAll() // on mount and on every reveal: a quiet refetch behind what's showing
  }, [loadAll])

  // The month's categories and budget. Only the newest month's reply lands.
  const monthSeq = useRef(0)
  const loadMonth = useCallback(async (m: string) => {
    const my = ++monthSeq.current
    const [cats, bud] = await Promise.all([
      get<CategorySpend[]>(`/api/cashflow/categories?month=${m}`),
      get<BudgetRow[]>(`/api/budget?month=${m}`),
    ])
    if (my !== monthSeq.current) return
    setCatSpend(cats)
    setBudget(bud)
  }, [])
  useEffect(() => {
    loadMonth(month).catch((e) => toast.error(`Couldn't load ${fmtMonth(month, true)}`, { detail: message(e) }))
  }, [month, loadMonth])

  // The transaction list. A new filter starts over at the first page; the same filter (a reveal, a refresh
  // after a write) re-reads as many rows as are showing, so Load more isn't undone. Only the newest load lands.
  const txSeq = useRef(0)
  const loadedKey = useRef<string | null>(null)
  const rowCount = useRef(0)
  rowCount.current = page?.rows.length ?? 0
  const loadTxs = useCallback(async (key: string, limit: number) => {
    const my = ++txSeq.current
    const r = await get<TxPage>(`/api/transactions?${txPageQuery(key, 0, limit)}`)
    if (my !== txSeq.current) return
    loadedKey.current = key
    setPage(r)
  }, [])
  const keepLimit = () => Math.min(TX_REFRESH_MAX, Math.max(TX_PAGE, rowCount.current))
  const monthKnown = filters.month !== null || monthly !== null // a list scoped to "the latest month" waits for it
  useEffect(() => {
    if (filters.scope === 'month' && !monthKnown) return
    const same = loadedKey.current === filterQuery
    const t = setTimeout(
      () => loadTxs(filterQuery, same ? keepLimit() : TX_PAGE).catch((e) => toast.error("Couldn't load transactions", { detail: message(e) })),
      same ? 0 : 200,
    )
    return () => clearTimeout(t)
  }, [filterQuery, filters.scope, monthKnown, loadTxs])

  async function loadMore() {
    if (!page || loadedKey.current !== filterQuery) return // the filters moved; their first page is on its way
    const at = txSeq.current
    setMoreBusy(true)
    try {
      const r = await get<TxPage>(`/api/transactions?${txPageQuery(filterQuery, page.rows.length, TX_PAGE)}`)
      if (at !== txSeq.current) return // a newer load replaced the list meanwhile
      setPage((cur) => {
        if (!cur) return r
        const seen = new Set(cur.rows.map((t) => t.id))
        return { ...r, offset: 0, rows: [...cur.rows, ...r.rows.filter((t) => !seen.has(t.id))] }
      })
    } catch (e) {
      toast.error("Couldn't load more transactions", { detail: message(e) })
    } finally {
      setMoreBusy(false)
    }
  }

  const refreshAll = useCallback(() => {
    const failed = (e: unknown) => toast.error("Couldn't refresh the Cash screen", { detail: message(e) })
    loadMonthly().catch(failed)
    loadMonth(month).catch(failed)
    if (loadedKey.current !== null) loadTxs(loadedKey.current, keepLimit()).catch(failed)
    setDataVersion((v) => v + 1) // the recurring card re-reads too
  }, [loadMonthly, loadMonth, loadTxs, month])

  /** Bring a section into view — for an in-screen jump (a bar clicked, a merchant link) that doesn't change the path. */
  const scrollTo = (section: string) =>
    document
      .getElementById(anchorId('cash', section))
      ?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })

  // Every write goes through useAction: a busy state, a toast either way, and a refresh after.
  const importFile = useAction(
    async (file: File, account: Account) => {
      const content = await file.text()
      const s = await post<ImportSummary>('/api/imports', { accountId: account.id, filename: file.name, content })
      return { file: file.name, account: account.name, s }
    },
    {
      success: ({ file, account, s }) =>
        `${file} → ${account}: ${s.imported} imported, ${s.skipped} duplicate${s.skipped === 1 ? '' : 's'} skipped (${s.format})` +
        (s.transfersFiled ? ` · ${s.transfersFiled} auto-filed as transfers` : ''),
      errorPrefix: 'Import failed',
      onDone: () => refreshAll(),
    },
  )
  async function onImportFile(file: File) {
    if (fileRef.current) fileRef.current.value = '' // the same file can be picked again
    const account = accounts?.find((a) => a.id === importAccount)
    if (account) await importFile.run(file, account)
  }
  function onImportClick() {
    if (!importAccount) {
      setNewAccount((cur) => cur ?? { name: '', kind: 'checking' })
      toast.info('Name the bank account first — every import is filed under one')
      return
    }
    fileRef.current?.click()
  }

  const addAccount = useAction(
    (b: { name: string; kind: 'checking' | 'savings' }) => post<Account>('/api/accounts', { name: b.name.trim(), kind: b.kind }),
    {
      success: (a) => `Added ${a.name} — imports go there now`,
      errorPrefix: "Couldn't add the account",
      onDone: (a) => {
        setNewAccount(null)
        setAccounts((cur) => [...(cur ?? []), a])
        setImportAccount(a.id)
      },
    },
  )
  function onAddAccount() {
    if (newAccount?.name.trim()) void addAccount.run(newAccount)
  }
  /** The account form open, in view, with the cursor in its name. */
  function startAddAccount() {
    setNewAccount((cur) => cur ?? { name: '', kind: 'checking' })
    scrollTo('import')
    requestAnimationFrame(() => accountNameRef.current?.focus({ preventScroll: true }))
  }

  // Deep links ('#/cash/import?d=import', the ⌘K palette): run once the accounts and the file input are here.
  // The file picker needs the click's user activation, which a palette keypress still carries on arrival; if a
  // browser refuses it anyway, the import card is scrolled to and pulsing with its button.
  useDeepAction(
    'cash',
    {
      import: () => {
        scrollTo('import')
        onImportClick()
      },
      'add-account': startAddAccount,
    },
    monthly !== null && accounts !== null,
  )

  const categorize = useAction(
    async (tx: Tx, categoryId: number | null, categoryName?: string) => {
      const r = await patch<{ ok: true; ruleApplied: number; pattern: string | null }>(`/api/transactions/${tx.id}`, { categoryId })
      return { r, categoryId, name: categoryName ?? categories?.find((c) => c.id === categoryId)?.name ?? 'that category' }
    },
    {
      success: ({ r, categoryId, name }) =>
        categoryId === null
          ? 'Marked uncategorized'
          : r.pattern
            ? `Filed under ${name} — “${r.pattern}” now auto-files this merchant` +
              (r.ruleApplied > 0 ? ` (${r.ruleApplied} past transaction${r.ruleApplied === 1 ? '' : 's'} updated too)` : '')
            : `Filed under ${name}`,
      errorPrefix: "Couldn't file the transaction",
      onDone: () => refreshAll(),
    },
  )

  const createCategory = useAction(
    (b: { name: string; kind: 'expense' | 'income' }) => post<Category>('/api/categories', b),
    { errorPrefix: "Couldn't create the category" },
  )
  async function onNewCategory(tx: Tx) {
    const v = await prompt<{ name: string; kind: 'expense' | 'income' }>({
      title: 'New category',
      body: `For “${tx.description}” — and every later transaction from the same merchant.`,
      fields: [
        { key: 'name', kind: 'text', label: 'Name', maxLength: 40, hint: 'e.g. Gardening' },
        { key: 'kind', kind: 'select', label: 'Kind', options: [{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }], initial: tx.amount_cents > 0 ? 'income' : 'expense' },
      ],
      submitLabel: 'Create & file',
    })
    if (!v) return
    const created = await createCategory.run(v)
    if (!created) return
    loadStatic().catch((e) => toast.error("Couldn't refresh the categories", { detail: message(e) }))
    await categorize.run(tx, created.id, created.name)
  }

  const saveBudget = useAction(
    async (row: BudgetRow, cents: number) => {
      await put('/api/budget', { categoryId: row.category_id, monthlyCents: cents })
      return cents === 0 ? `Cleared the ${row.name} budget` : `${row.name}: ${formatCents(cents)} a month`
    },
    {
      success: (r) => r,
      errorPrefix: "Couldn't save the budget",
      onDone: () => void loadMonth(month).catch((e) => toast.error("Couldn't refresh the budget", { detail: message(e) })),
    },
  )

  /** A Spending-by-category bar: that category's transactions for the month. */
  function showCategory(id: number | null) {
    setFilters({ cat: id === null ? 'uncategorized' : id, scope: 'month' })
    scrollTo('transactions')
  }
  /** A merchant in the recurring card: its transactions, any month or category. */
  function showMerchant(merchant: string) {
    setQ(merchant)
    setFilters({ cat: 'all', scope: 'all' })
    scrollTo('transactions')
  }
  function showCategoryNamed(name: string) {
    const c = categories?.find((x) => x.name === name)
    if (!c) return
    setFilters({ cat: c.id, scope: 'all' })
    scrollTo('transactions')
  }
  function showBudget(m: string) {
    setFilters({ month: m === latest ? null : m })
    scrollTo('budget')
  }
  function clearFilters() {
    setQ('')
    setFilters({ cat: 'all', acct: 'all', scope: 'all' })
  }

  const header = (
    <HeaderSlot
      sub={accountsLine(accounts)}
      actions={
        <Button variant="gold" busy={importFile.busy} onClick={onImportClick}>
          Import CSV / OFX
        </Button>
      }
    />
  )

  if (monthly === null)
    return (
      <>
        {header}
        {loadErr ? (
          <div className="card wide" role="alert">
            <h2>Couldn't load Cash &amp; budget</h2>
            <p className="sub2">{loadErr}</p>
            <Button onClick={() => void loadAll()}>Retry</Button>
          </div>
        ) : (
          <div className="grid12" aria-busy="true" aria-label="Loading Cash & budget">
            <div className="card c12"><Skeleton h={18} w={180} /><Skeleton h={30} w="50%" style={{ marginTop: 12 }} /></div>
            <div className="card c8"><Skeleton h={18} w={200} /><Skeleton h={180} style={{ marginTop: 12 }} /></div>
            <div className="card c4"><Skeleton h={18} w={160} /><Skeleton h={180} style={{ marginTop: 12 }} /></div>
            <div className="card c12"><Skeleton h={18} w={140} /><Skeleton h={220} style={{ marginTop: 12 }} /></div>
          </div>
        )}
      </>
    )

  const incomeRows = budget.filter((b) => b.kind === 'income' && (b.actual_cents !== 0 || b.monthly_cents !== 0))
  const expenseBudget = budget.filter((b) => b.kind === 'expense' && b.category_id !== null)
  const anyBudget = expenseBudget.some((b) => b.monthly_cents > 0)
  const bulletRows = expenseBudget
    .filter((b) => b.monthly_cents > 0 || b.actual_cents > 0)
    .map((b) => ({ name: b.name, actual: b.actual_cents, budget: b.monthly_cents }))
  // Budget actuals are the engine's one definition: refunds lower their category, never below zero.
  const incomeTotal = budget.filter((b) => b.kind === 'income').reduce((s, b) => s + b.actual_cents, 0)
  const spendTotal = budget.filter((b) => b.kind === 'expense').reduce((s, b) => s + b.actual_cents, 0)
  const savings = incomeTotal - spendTotal
  const savingsRate = incomeTotal > 0 ? Math.round((savings / incomeTotal) * 100) : null // a display percentage

  const months = monthly.map((m) => m.month)
  const hasData = monthly.length > 0
  const thisYear = todayLocal().slice(0, 4)
  const rows = page?.rows ?? []
  const left = page ? page.matching - rows.length : 0

  return (
    <>
      {header}
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.ofx,.qfx,.txt"
        hidden
        onChange={(e) => e.target.files?.[0] && void onImportFile(e.target.files[0])}
      />

      {/* ---------- accounts: where imports go ---------- */}
      <div className="card wide" ref={importAnchor}>
        <div className="h4row">
          <h2>Accounts &amp; import</h2>
          <div className="right muted">CSV or OFX/QFX download from the bank · duplicates are skipped automatically</div>
        </div>
        <div className="importbar">
          <span className="sub2">
            {accounts?.length ? (
              'Imports go to'
            ) : (
              <>
                First: name the bank account these imports belong to <b className="inkstrong">→</b>
              </>
            )}
          </span>
          {(accounts ?? []).map((a) => (
            <button
              key={a.id}
              className={`chipbtn ${importAccount === a.id ? 'on' : ''}`}
              aria-pressed={importAccount === a.id}
              onClick={() => setImportAccount(a.id)}
            >
              {a.name}
            </button>
          ))}
          {newAccount ? (
            <form
              className="scr-addacct"
              onSubmit={(e) => {
                e.preventDefault()
                onAddAccount()
              }}
            >
              <TextInput
                ref={accountNameRef}
                autoFocus
                aria-label="Account name"
                maxLength={60}
                placeholder="e.g. WF Checking ··2841"
                value={newAccount.name}
                onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
              />
              <Select
                aria-label="Account type"
                value={newAccount.kind}
                onChange={(e) => setNewAccount({ ...newAccount, kind: e.target.value as 'checking' | 'savings' })}
              >
                <option value="checking">checking</option>
                <option value="savings">savings</option>
              </Select>
              <Button type="submit" busy={addAccount.busy} disabled={!newAccount.name.trim()}>
                Add
              </Button>
              {!!accounts?.length && (
                <Button variant="ghost" onClick={() => setNewAccount(null)}>
                  Cancel
                </Button>
              )}
            </form>
          ) : (
            <button className="chipbtn" onClick={() => setNewAccount({ name: '', kind: 'checking' })}>
              + account
            </button>
          )}
        </div>
      </div>

      {!hasData ? (
        <div className="card wide">
          <EmptyState
            title="Nothing here yet"
            body={
              <>
                Download a CSV from your bank (Wells Fargo: Accounts → Download Account Activity → Comma Delimited) or an
                OFX/QFX file, then import it. Charts, categories and the budget light up from the first file.
              </>
            }
            action={{ label: 'Import CSV / OFX', onClick: onImportClick }}
          />
        </div>
      ) : (
        <div className="grid12">
          {/* ---------- charts row ---------- */}
          <CashFlowCard monthly={monthly} month={month} onSelectMonth={(m) => setFilters({ month: m === latest ? null : m })} />
          <CategorySpendCard
            rows={catSpend}
            month={month}
            monthOptions={monthChoices(months, month)}
            onMonth={(m) => setFilters({ month: m === latest ? null : m })}
            onSelectCategory={showCategory}
          />

          {/* ---------- budget row ---------- */}
          <div className="card c4">
            <div className="h4row">
              <h2>Income · {fmtMonth(month, true)}</h2>
            </div>
            <table>
              <tbody>
                {incomeRows.map((r) => (
                  <tr key={r.category_id ?? 'un'}>
                    <td>{r.name}</td>
                    <td className="r num pos">{formatCents(r.actual_cents)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="strong">Total</td>
                  <td className="r num strong gold">{formatCents(incomeTotal)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className="card c5" ref={budgetAnchor}>
            <div className="h4row">
              <h2>Plan vs. actual · {fmtMonth(month, true)}</h2>
              {(anyBudget || editBudgets) && (
                <div className="right">
                  <Button size="mini" onClick={() => setEditBudgets((v) => !v)}>
                    {editBudgets ? 'Done' : 'Set budgets'}
                  </Button>
                </div>
              )}
            </div>
            {editBudgets ? (
              <table className="scr-budget">
                <tbody>
                  {expenseBudget.map((b) => (
                    <tr key={b.category_id}>
                      <td>{b.name}</td>
                      <td className="r">
                        <BudgetInput row={b} onSave={saveBudget.run} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : anyBudget ? (
              <Bullets data={bulletRows} month={month} />
            ) : (
              <EmptyState
                title="No budgets set"
                body="Plan a monthly amount for the categories you care about, and this card tracks the month's spending against it."
                action={{ label: 'Set budgets', onClick: () => setEditBudgets(true) }}
              />
            )}
          </div>
          <div className="card c3">
            <div className="h4row">
              <h2>Savings · {fmtMonth(month, true)}</h2>
            </div>
            <div className="heronum">{savingsRate === null ? '—' : `${savingsRate}%`}</div>
            <div className="sub2">
              of income kept · <b className="inkstrong">{formatCents(savings, { sign: savings > 0 })}</b>
            </div>
            <div className="sub2 topline">
              Income {fmtShort(incomeTotal)} − spending {fmtShort(spendTotal)}. Refunds lower their category's
              spending; transfers between your own accounts are excluded.
            </div>
          </div>

          <RecurringCard refreshKey={dataVersion} onMerchant={showMerchant} onCategory={showCategoryNamed} onBudget={showBudget} />

          {/* ---------- transactions ---------- */}
          <div className="card c12" ref={txAnchor}>
            <div className="h4row scr-txhead">
              <h2>Transactions</h2>
              <div className="right">
                <select
                  className="mini"
                  aria-label="Account"
                  value={acct === 'all' ? 'all' : String(acct)}
                  onChange={(e) => setFilters({ acct: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
                >
                  <option value="all">All accounts</option>
                  {(accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <select
                  className="mini"
                  aria-label="Category"
                  value={typeof cat === 'number' ? String(cat) : cat}
                  onChange={(e) => {
                    const v = e.target.value
                    setFilters({ cat: v === 'all' || v === 'uncategorized' ? v : Number(v) })
                  }}
                >
                  <option value="all">All categories</option>
                  <option value="uncategorized">Uncategorized{page?.uncategorized ? ` (${page.uncategorized.toLocaleString()})` : ''}</option>
                  {(categories ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <select
                  className="mini"
                  aria-label="Months"
                  value={filters.scope}
                  onChange={(e) => setFilters({ scope: e.target.value === 'month' ? 'month' : 'all' })}
                >
                  <option value="all">All months</option>
                  <option value="month">{fmtMonth(month, true)} only</option>
                </select>
                <span className="search">
                  <input
                    type="search"
                    aria-label="Search transactions"
                    placeholder="Search merchant or category…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </span>
                <span className="muted nowrap" aria-live="polite">
                  {page ? `${page.matching.toLocaleString()} ${filtered ? 'matching' : 'transactions'}` : '…'}
                </span>
                {filtered && (
                  <Button size="mini" variant="ghost" onClick={clearFilters}>
                    Clear
                  </Button>
                )}
              </div>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Description</th>
                  <th>Account</th>
                  <th>Category</th>
                  <th className="r">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td className="muted nowrap">{shortDate(t.posted_on, thisYear)}</td>
                    <td className="desc" title={t.description}>
                      {t.description}
                    </td>
                    <td className="muted nowrap">{t.account_name}</td>
                    <td>
                      <select
                        className={`mini catsel ${t.category_id === null ? 'unset' : ''}`}
                        aria-label={`Category for ${t.description}`}
                        value={t.category_id ?? ''}
                        onChange={(e) =>
                          e.target.value === '__new'
                            ? void onNewCategory(t)
                            : void categorize.run(t, e.target.value === '' ? null : Number(e.target.value))
                        }
                        title={t.categorized_by ?? 'uncategorized'}
                      >
                        <option value="">— pick —</option>
                        {(categories ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                        <option value="__new">+ new category…</option>
                      </select>
                    </td>
                    <td className={`r num ${t.amount_cents > 0 ? 'pos' : ''}`}>
                      {formatCents(t.amount_cents, { sign: t.amount_cents > 0 })}
                    </td>
                  </tr>
                ))}
                {page && rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="sub2 scr-none">
                      No transactions match{filtered ? ' these filters' : ''}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {page && left > 0 && (
              <div className="scr-more">
                <Button busy={moreBusy} onClick={() => void loadMore()}>
                  Load {Math.min(TX_PAGE, left).toLocaleString()} more
                </Button>
                <span className="muted">
                  Showing {rows.length.toLocaleString()} of {page.matching.toLocaleString()}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
