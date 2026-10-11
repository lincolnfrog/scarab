import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { todayLocal } from '../../shared/dates'
import { formatCents } from '../../shared/money'
import type { Account, AccountKind, BudgetRow, Category, CategorySpend, ImportSummary, MonthlyFlow, Tx, TxPage } from '../../shared/types'
import { get, patch, post, put } from '../api'
import { Link, navigate, setParams, useRouteState, type RouteTarget } from '../router'
import { Bullets, fmtMonth, fmtShort } from '../viz'
import RecurringCard, { recurringSummary, useRecurring } from '../RecurringCard'
import CashFlowCard from '../cards/CashFlowCard'
import CategorySpendCard from '../cards/CategorySpendCard'
import RulesSheet from './RulesSheet'
import { Button } from '../ui/Button'
import { useDeepAction } from '../ui/CommandPalette'
import { prompt } from '../ui/dialogs'
import { Tooltip } from '../ui/Tooltip'
import { EmptyState } from '../ui/EmptyState'
import { MoneyInput, Select, TextInput } from '../ui/Field'
import { HeaderSlot } from '../ui/HeaderSlot'
import { DetailView, DrillCard, DrillMore, MiniRows, Stats, useDetail } from '../ui/Drill'
import { useScreen, useScreenRoute } from '../ui/screen'
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
import './cash-overview.css'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Bank account types. A credit card's balance is money owed: net worth counts it as debt, not cash. */
const KIND_OPTIONS: { value: AccountKind; label: string }[] = [
  { value: 'checking', label: 'checking' },
  { value: 'savings', label: 'savings' },
  { value: 'credit', label: 'credit card' },
]

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

/** The header's subtitle: short — how many accounts, and the month on screen. */
function accountsLine(accounts: Account[] | null, month: string): string {
  if (!accounts?.length) return 'Bank CSV or OFX downloads'
  return `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${fmtMonth(month, true)}`
}

/**
 * The screen's detail views. `import`, `budget` and `transactions` were
 * section anchors before the overview existed — the digest, the Dashboard and
 * the command palette link to them — so they keep their names.
 */
const DETAILS = ['spending', 'budget', 'recurring', 'import', 'transactions'] as const
type Detail = (typeof DETAILS)[number]

/** How many rows the overview previews of a list. */
const PREVIEW = 6

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
  const [rulesOpen, setRulesOpen] = useState(false)
  const [newAccount, setNewAccount] = useState<{ name: string; kind: AccountKind } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const accountNameRef = useRef<HTMLInputElement>(null)
  const detail = useDetail(DETAILS)
  const { active } = useScreen()
  const recurring = useRecurring(dataVersion)

  // What the filters resolve to. A filter naming an account or category that no longer exists reads as "all".
  const latest = monthly?.at(-1)?.month ?? null
  const month = filters.month ?? latest ?? todayLocal().slice(0, 7)
  const acct: number | 'all' =
    accounts && filters.acct !== 'all' && !accounts.some((a) => a.id === filters.acct) ? 'all' : filters.acct
  const cat: CatFilter =
    categories && typeof filters.cat === 'number' && !categories.some((c) => c.id === filters.cat) ? 'all' : filters.cat
  // The filters belong to the Transactions view; everywhere else the list is the ledger's latest rows.
  const inTx = detail === 'transactions'
  const filterQuery = inTx ? txFilterQuery({ cat, acct, scope: filters.scope, month, q }) : ''
  const filtered = filterQuery !== ''

  /** A view of this screen, on the month showing — plus the transaction filters when `keep` is set. */
  const viewTarget = (d: Detail | null, f: Partial<CashFilters> = {}, keep = false): RouteTarget => {
    const base: CashFilters = keep ? filters : { month: filters.month, cat: 'all', acct: 'all', scope: 'all' }
    const params: Record<string, string | number | undefined> = {}
    for (const [k, v] of Object.entries(cashParamsPatch({ ...base, ...f }))) if (v !== null) params[k] = v
    return { screen: 'cash', rest: d ? [d] : [], params }
  }
  const go = (d: Detail, f: Partial<CashFilters> = {}, o: { replace?: boolean; state?: Record<string, unknown>; keep?: boolean } = {}) =>
    navigate(viewTarget(d, f, o.keep), { replace: o.replace, state: o.state })

  // A link that filters the list without naming a view ('#/cash?cat=12', from before the overview) opens the list.
  const strayFilter = detail === null && (filters.cat !== 'all' || filters.acct !== 'all' || filters.scope === 'month')
  useEffect(() => {
    if (active && strayFilter && route.params.d === undefined) navigate(viewTarget('transactions', {}, true), { replace: true })
  })

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
    if (inTx && filters.scope === 'month' && !monthKnown) return
    const same = loadedKey.current === filterQuery
    const t = setTimeout(
      () => loadTxs(filterQuery, same ? keepLimit() : TX_PAGE).catch((e) => toast.error("Couldn't load transactions", { detail: message(e) })),
      same ? 0 : 200,
    )
    return () => clearTimeout(t)
  }, [filterQuery, inTx, filters.scope, monthKnown, loadTxs])

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
      if (detail !== 'import' && monthly?.length) go('import')
      toast.info('Name the bank account first — every import is filed under one')
      return
    }
    fileRef.current?.click()
  }

  const addAccount = useAction(
    (b: { name: string; kind: AccountKind }) => post<Account>('/api/accounts', { name: b.name.trim(), kind: b.kind }),
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
  const anchor = useAction(
    async (a: Account, cents: number) => {
      await patch(`/api/accounts/${a.id}`, { currentBalanceCents: cents })
      return a.kind === 'credit'
        ? `${a.name}: ${formatCents(Math.max(0, -cents))} owed`
        : `${a.name} anchored at ${formatCents(cents)}`
    },
    { success: (r) => r, errorPrefix: "Couldn't set the balance", onDone: () => void loadStatic().then(refreshAll, refreshAll) },
  )
  async function setBalance(a: Account) {
    const card = a.kind === 'credit'
    const v = await prompt<{ cents: number }>({
      title: `Set ${a.name}'s balance`,
      body: card
        ? 'What the card owes right now, from the statement or the card’s site — after the latest transaction you imported. Scarab anchors the ledger to it.'
        : 'The balance right now, from the bank’s site — after the latest transaction you imported. Scarab only knows the flows since your first import, and anchors them to it.',
      fields: [
        card
          ? { key: 'cents', kind: 'money', label: 'Amount owed', initial: -a.balance_cents, allowNegative: true, hint: 'Negative if the card is in credit' }
          : { key: 'cents', kind: 'money', label: 'Current balance', initial: a.balance_cents, allowNegative: true },
      ],
      submitLabel: 'Anchor balance',
    })
    if (v) void anchor.run(a, card ? -v.cents : v.cents)
  }
  const changeKind = useAction(
    async (a: Account, kind: AccountKind) => {
      await patch(`/api/accounts/${a.id}`, { kind })
      return `${a.name} is a ${KIND_OPTIONS.find((k) => k.value === kind)!.label} account`
    },
    { success: (r) => r, errorPrefix: "Couldn't change the account type", onDone: () => void loadStatic().then(refreshAll, refreshAll) },
  )

  function onAddAccount() {
    if (newAccount?.name.trim()) void addAccount.run(newAccount)
  }
  /** The account form open, in view (it lives in the Accounts view), with the cursor in its name. */
  function startAddAccount() {
    setNewAccount((cur) => cur ?? { name: '', kind: 'checking' })
    if (detail !== 'import') go('import', {}, { replace: true })
    requestAnimationFrame(() => accountNameRef.current?.focus({ preventScroll: true }))
  }

  // Deep links ('#/cash/import?d=import', the ⌘K palette): run once the accounts and the file input are here —
  // both are mounted in every view. The file picker needs the click's user activation, which a palette keypress
  // still carries on arrival; if a browser refuses it anyway, the header's Import button is there in every view.
  // Arriving without the view named opens the Accounts view, where the import's target account is chosen.
  useDeepAction(
    'cash',
    {
      import: () => {
        if (detail !== 'import') go('import', {}, { replace: true })
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

  // Jumps between views: each opens the Transactions (or Budget) view as a new entry, so Back returns here.
  /** A Spending-by-category bar: that category's transactions for the month. */
  function showCategory(id: number | null) {
    go('transactions', { cat: id === null ? 'uncategorized' : id, scope: 'month' }, { state: { q: '' } })
  }
  /** A merchant in the recurring card: its transactions, any month or category. */
  function showMerchant(merchant: string) {
    go('transactions', {}, { state: { q: merchant } })
  }
  function showCategoryNamed(name: string) {
    const c = categories?.find((x) => x.name === name)
    if (c) go('transactions', { cat: c.id }, { state: { q: '' } })
  }
  function showBudget(m: string) {
    go('budget', { month: m === latest ? null : m })
  }
  function clearFilters() {
    setQ('')
    setFilters({ cat: 'all', acct: 'all', scope: 'all' })
  }

  const header = (
    <HeaderSlot
      sub={accountsLine(accounts, month)}
      actions={
        <>
          <Button variant="ghost" disabled={!categories} onClick={() => setRulesOpen(true)}>
            Import rules…
          </Button>
          <Button variant="gold" busy={importFile.busy} onClick={onImportClick}>
            Import CSV / OFX
          </Button>
        </>
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
  // The rest of the month's story, from the same ledger: tax payments within spending, and money moved out to
  // accounts the ledger doesn't hold (investments, crypto, people) — and the same over the months on screen.
  // A month linked to from outside the twelve loaded has no flow row: its tax comes from the budget's Taxes
  // row (the same definition), and what moved goes unsaid.
  const flow = monthly.find((m) => m.month === month)
  const taxCents = flow ? flow.tax_cents : (budget.find((b) => b.kind === 'expense' && b.name === 'Taxes')?.actual_cents ?? 0)
  const movedCents = flow?.moved_cents ?? 0
  const span = monthly.reduce(
    (t, m) => ({ kept: t.kept + m.income_cents - m.spend_cents, tax: t.tax + m.tax_cents, moved: t.moved + m.moved_cents }),
    { kept: 0, tax: 0, moved: 0 },
  )

  const months = monthly.map((m) => m.month)
  const hasData = monthly.length > 0
  const thisYear = todayLocal().slice(0, 4)
  const rows = page?.rows ?? []
  const left = page ? page.matching - rows.length : 0

  const monthSelect = (
    <Select
      className="mini"
      aria-label="Month"
      value={month}
      onChange={(e) => setFilters({ month: e.target.value === latest ? null : e.target.value })}
    >
      {monthChoices(months, month).map((m) => (
        <option key={m} value={m}>
          {fmtMonth(m, true)}
        </option>
      ))}
    </Select>
  )

  // Mounted in every view: the header's buttons, the rules sheet and the file picker the import actions click.
  const chrome = (
    <>
      {header}
      <RulesSheet
        open={rulesOpen}
        categories={categories ?? []}
        onClose={() => setRulesOpen(false)}
        onDone={() => {
          loadStatic().catch((e) => toast.error("Couldn't refresh the categories", { detail: message(e) }))
          refreshAll()
        }}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".csv,.ofx,.qfx,.txt"
        hidden
        onChange={(e) => e.target.files?.[0] && void onImportFile(e.target.files[0])}
      />
    </>
  )

  /* ---------- accounts: where imports go ---------- */
  const accountsCard = (
    <div className="card wide scr-accounts">
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
              onChange={(e) => setNewAccount({ ...newAccount, kind: e.target.value as AccountKind })}
            >
              {KIND_OPTIONS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
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
      {!!accounts?.length && (
        <ul className="scr-balances topline" aria-label="Account balances">
          {accounts.map((a) => (
            <li key={a.id}>
              <span className="scr-bal-name">{a.name}</span>
              <Select
                className="mini"
                aria-label={`${a.name}: account type`}
                value={a.kind}
                disabled={changeKind.busy}
                onChange={(e) => void changeKind.run(a, e.target.value as AccountKind)}
              >
                {KIND_OPTIONS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </Select>
              <span className="scr-bal-amt">
                {a.kind === 'credit' ? (
                  <>
                    {formatCents(Math.abs(a.balance_cents))} <span className="muted">{a.balance_cents <= 0 ? 'owed' : 'credit'}</span>
                  </>
                ) : (
                  formatCents(a.balance_cents)
                )}
              </span>
              <Tooltip content="Set the real balance — the ledger only knows flows since your first import">
                <Button variant="ghost" size="mini" aria-label={`Set ${a.name}'s actual balance`} onClick={() => void setBalance(a)}>
                  Set balance
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  // First run: name an account, import a file. Every view is this until there's a month to show.
  if (!hasData)
    return (
      <>
        {chrome}
        {accountsCard}
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
      </>
    )

  if (detail === 'import')
    return (
      <>
        {chrome}
        <DetailView title="Accounts & import" plain>
          {accountsCard}
        </DetailView>
      </>
    )

  if (detail === 'spending')
    return (
      <>
        {chrome}
        <DetailView title="Spending & income">
          <CategorySpendCard
            rows={catSpend}
            month={month}
            monthOptions={monthChoices(months, month)}
            onMonth={(m) => setFilters({ month: m === latest ? null : m })}
            onSelectCategory={showCategory}
          />
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
          <div className="card c4">
            <div className="h4row">
              <h2>Savings · {fmtMonth(month, true)}</h2>
            </div>
            <div className="heronum">{savingsRate === null ? '—' : `${savingsRate}%`}</div>
            <div className="sub2">
              of income kept · <b className="inkstrong">{formatCents(savings, { sign: savings > 0 })}</b>
            </div>
            {(taxCents > 0 || movedCents !== 0) && (
              <dl className="scr-flowlist topline">
                {taxCents > 0 && (
                  <>
                    <dt>Tax payments, in spending</dt>
                    <dd>{formatCents(taxCents)}</dd>
                    <dt>Kept before tax payments</dt>
                    <dd>{formatCents(savings + taxCents, { sign: savings + taxCents > 0 })}</dd>
                  </>
                )}
                {movedCents !== 0 && (
                  <>
                    <dt>
                      <Tooltip content="Transfers out of your bank and card accounts, less transfers in. Moves between two of them cancel out, so this is what went to — or came from — accounts outside them: investments, crypto, other people.">
                        <span className="scr-tipped">{movedCents > 0 ? 'Moved to investments & other accounts' : 'Came in from investments & other accounts'}</span>
                      </Tooltip>
                    </dt>
                    <dd>{formatCents(Math.abs(movedCents))}</dd>
                  </>
                )}
              </dl>
            )}
            {monthly.length > 1 && (span.tax > 0 || span.moved !== 0) && (
              <div className="sub2 topline">
                Last {monthly.length} months: kept {fmtShort(span.kept)}
                {span.tax > 0 && <> after {fmtShort(span.tax)} of tax payments</>}
                {span.moved !== 0 && (
                  <>
                    {' '}· {fmtShort(Math.abs(span.moved))} {span.moved > 0 ? 'moved to' : 'came in from'} investments &amp; other accounts
                  </>
                )}
                .
              </div>
            )}
            <div className="sub2 topline">
              Income {fmtShort(incomeTotal)} − spending {fmtShort(spendTotal)}. Refunds lower their category's
              spending; transfers between your own accounts are excluded.
            </div>
          </div>
        </DetailView>
      </>
    )

  const budgeted = expenseBudget.filter((b) => b.monthly_cents > 0)
  const budgetCents = budgeted.reduce((t, b) => t + b.monthly_cents, 0)
  const budgetSpent = budgeted.reduce((t, b) => t + b.actual_cents, 0)
  const overBudget = budgeted.filter((b) => b.actual_cents > b.monthly_cents)

  if (detail === 'budget')
    return (
      <>
        {chrome}
        <DetailView title="Budget">
          <div className="card c8">
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
          <div className="card c4">
            <div className="h4row">
              <h2>The month's plan</h2>
              <div className="right">{monthSelect}</div>
            </div>
            {anyBudget ? (
              <Stats
                items={[
                  { label: 'Budgeted', value: formatCents(budgetCents) },
                  { label: 'Spent of it', value: formatCents(budgetSpent) },
                  { label: 'Over plan', value: overBudget.length === 0 ? 'None' : `${overBudget.length} of ${budgeted.length}` },
                ]}
              />
            ) : (
              <p className="sub2">No category has a monthly amount yet.</p>
            )}
            <p className="sub2 topline">
              The plan resets each month. Spending in a category without a budget shows on its own, and refunds lower
              their category's spending.
            </p>
          </div>
        </DetailView>
      </>
    )

  if (detail === 'recurring')
    return (
      <>
        {chrome}
        <DetailView title="Recurring & subscriptions">
          <RecurringCard data={recurring} onMerchant={showMerchant} onCategory={showCategoryNamed} onBudget={showBudget} />
        </DetailView>
      </>
    )

  if (detail === 'transactions')
    return (
      <>
        {chrome}
        <DetailView title="Transactions">
          <div className="card c12">
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
            <table className="scr-txlist">
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
        </DetailView>
      </>
    )

  /* ---------- the overview ---------- */
  const spendRows = [...catSpend].filter((c) => c.spend_cents > 0).sort((a, b) => b.spend_cents - a.spend_cents)
  const catTotal = spendRows.reduce((t, c) => t + c.spend_cents, 0)
  // Closest to (or furthest past) its plan first: actual/budget compared by cross-multiplying, in whole cents.
  const tightest = [...budgeted].sort((a, b) => b.actual_cents * a.monthly_cents - a.actual_cents * b.monthly_cents)
  const rec = recurring ? recurringSummary(recurring, todayLocal()) : null
  const bank = (accounts ?? []).filter((a) => a.kind !== 'credit')
  const cards = (accounts ?? []).filter((a) => a.kind === 'credit')
  const bankCents = bank.reduce((t, a) => t + a.balance_cents, 0)
  const owedCents = cards.reduce((t, a) => t + Math.max(0, -a.balance_cents), 0)
  const mm = fmtMonth(month, true)
  const latestRows = rows.slice(0, PREVIEW)

  return (
    <>
      {chrome}
      <div className="grid12">
        <div className="card c4 co-hero">
          <div className="h4row">
            <h2>Kept</h2>
            <div className="right">{monthSelect}</div>
          </div>
          <div className="heronum">{formatCents(savings, { sign: savings > 0 })}</div>
          <div className="sub2">{savingsRate === null ? `No income recorded in ${mm}` : `${savingsRate}% of ${mm}'s income`}</div>
          <Stats
            items={[
              { label: 'Income', value: formatCents(incomeTotal) },
              { label: 'Spending', value: formatCents(spendTotal) },
              ...(taxCents > 0 ? [{ label: 'Of it, tax', value: formatCents(taxCents) }] : []),
            ]}
          />
        </div>
        <CashFlowCard monthly={monthly} month={month} onSelectMonth={(m) => setFilters({ month: m === latest ? null : m })} />

        <DrillCard
          to={viewTarget('spending')}
          title="Spending by category"
          value={spendRows.length ? formatCents(catTotal) : undefined}
          note={
            spendRows.length
              ? `${mm} · ${spendRows.length} categor${spendRows.length === 1 ? 'y' : 'ies'}, with income and savings`
              : `No spending in ${mm} yet`
          }
        >
          {spendRows.length > 0 && (
            <MiniRows
              rows={spendRows.slice(0, 4).map((c) => ({
                key: c.category_id ?? 'un',
                label: c.name,
                sub: `${Math.round((c.spend_cents * 100) / catTotal)}%`,
                value: formatCents(c.spend_cents),
              }))}
            />
          )}
        </DrillCard>
        <DrillCard
          to={viewTarget('budget')}
          title="Budget"
          badge={overBudget.length > 0 ? `${overBudget.length} over` : undefined}
          value={anyBudget ? formatCents(budgetSpent) : undefined}
          note={
            anyBudget
              ? `spent of ${formatCents(budgetCents)} planned for ${mm}`
              : 'No budgets set — plan a monthly amount for the categories you care about'
          }
        >
          {anyBudget && (
            <MiniRows
              rows={tightest.slice(0, 4).map((b) => ({
                key: b.category_id ?? 'un',
                label: b.name,
                sub: b.actual_cents > b.monthly_cents ? `over by ${formatCents(b.actual_cents - b.monthly_cents)}` : undefined,
                value: `${fmtShort(b.actual_cents)} / ${fmtShort(b.monthly_cents)}`,
              }))}
            />
          )}
        </DrillCard>
        <DrillCard
          to={viewTarget('recurring')}
          title="Recurring"
          badge={rec && rec.priceUp > 0 ? `${rec.priceUp} up in price` : undefined}
          value={rec && rec.active > 0 ? (rec.safe ? formatCents(rec.safe.cents) : `${rec.active} active`) : undefined}
          note={
            !rec
              ? 'Looking for a rhythm in the ledger…'
              : rec.active === 0
                ? 'No recurring charges detected yet'
                : rec.safe
                  ? `left to spend this month · ${rec.active} recurring, ≈${formatCents(rec.safe.billsCents)} still coming`
                  : 'bills and subscriptions with a steady rhythm'
          }
        >
          {rec && rec.upcoming.length > 0 && (
            <MiniRows
              rows={rec.upcoming.slice(0, 4).map((r) => ({
                key: r.merchant,
                label: r.merchant,
                sub: shortDate(r.nextExpectedOn, thisYear),
                value: formatCents(r.typicalCents),
              }))}
            />
          )}
        </DrillCard>

        <DrillCard
          to={viewTarget('import')}
          title="Accounts"
          value={accounts?.length ? formatCents(bankCents) : undefined}
          note={
            accounts?.length
              ? `in ${bank.length} bank account${bank.length === 1 ? '' : 's'}` +
                (cards.length ? ` · ${formatCents(owedCents)} owed on ${cards.length} card${cards.length === 1 ? '' : 's'}` : '')
              : 'No accounts yet — add one to import into'
          }
        >
          {!!accounts?.length && (
            <MiniRows
              rows={[...accounts]
                .sort((a, b) => Math.abs(b.balance_cents) - Math.abs(a.balance_cents))
                .slice(0, 4)
                .map((a) => ({
                  key: a.id,
                  label: a.name,
                  sub: a.kind === 'credit' ? (a.balance_cents <= 0 ? 'card · owed' : 'card · credit') : a.kind,
                  value: formatCents(a.kind === 'credit' ? Math.abs(a.balance_cents) : a.balance_cents),
                }))}
            />
          )}
        </DrillCard>
        <div className="card c8 co-latest">
          <div className="h4row">
            <h2>Latest transactions</h2>
            <div className="right">
              {!!page?.uncategorized && (
                <Link className="scr-link" to={viewTarget('transactions', { cat: 'uncategorized' })} state={{ q: '' }}>
                  {page.uncategorized.toLocaleString()} uncategorized
                </Link>
              )}
              <DrillMore to={viewTarget('transactions')} state={{ q: '' }}>
                {page ? `All ${page.matching.toLocaleString()}` : 'All'}
              </DrillMore>
            </div>
          </div>
          {!page ? (
            <Skeleton h={150} />
          ) : latestRows.length === 0 ? (
            <p className="sub2">No transactions yet.</p>
          ) : (
            <MiniRows
              rows={latestRows.map((t) => ({
                key: t.id,
                label: (
                  <>
                    <span className="co-tx-when">{shortDate(t.posted_on, thisYear)}</span>
                    <span className="co-tx-desc">{t.description}</span>
                    <span className="co-tx-cat">{t.category_name ?? 'uncategorized'}</span>
                  </>
                ),
                value: formatCents(t.amount_cents, { sign: t.amount_cents > 0 }),
                tone: t.amount_cents > 0 ? ('pos' as const) : undefined,
              }))}
            />
          )}
        </div>
      </div>
    </>
  )
}
