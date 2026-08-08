import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatCents, parseMoney } from '../../shared/money'
import type {
  Account,
  BudgetRow,
  Category,
  CategorySpend,
  ImportSummary,
  MonthlyFlow,
  Tx,
} from '../../shared/types'
import { get, patch, post, put } from '../api'
import { Bullets, fmtMonth, fmtShort, GroupedBars, HBars } from '../viz'

export default function Cash() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [monthly, setMonthly] = useState<MonthlyFlow[]>([])
  const [catSpend, setCatSpend] = useState<CategorySpend[]>([])
  const [budget, setBudget] = useState<BudgetRow[]>([])
  const [txs, setTxs] = useState<Tx[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [month, setMonth] = useState<string>(() => new Date().toISOString().slice(0, 7))
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<'all' | 'uncategorized' | number>('all')
  const [accountFilter, setAccountFilter] = useState<number | 'all'>('all')
  const [importAccount, setImportAccount] = useState<number | null>(null)
  const [importing, setImporting] = useState(false)
  const [lastImport, setLastImport] = useState<string | null>(null)
  const [editBudgets, setEditBudgets] = useState(false)
  const [newAccount, setNewAccount] = useState<{ name: string; kind: 'checking' | 'savings' } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const loadStatic = useCallback(async () => {
    const [a, c] = await Promise.all([get<Account[]>('/api/accounts'), get<Category[]>('/api/categories')])
    setAccounts(a)
    setCategories(c)
    setImportAccount((cur) => cur ?? a[0]?.id ?? null)
    if (a.length === 0) setNewAccount((cur) => cur ?? { name: '', kind: 'checking' })
  }, [])

  const loadMonthly = useCallback(async () => {
    const m = await get<MonthlyFlow[]>('/api/cashflow/monthly')
    setMonthly(m)
    setMonth((cur) => (m.some((r) => r.month === cur) ? cur : (m[m.length - 1]?.month ?? cur)))
  }, [])

  const loadMonth = useCallback(async (m: string) => {
    const [cats, bud] = await Promise.all([
      get<CategorySpend[]>(`/api/cashflow/categories?month=${m}`),
      get<BudgetRow[]>(`/api/budget?month=${m}`),
    ])
    setCatSpend(cats)
    setBudget(bud)
  }, [])

  const loadTxs = useCallback(async (query: string, f: typeof filter, acct: typeof accountFilter) => {
    const params = new URLSearchParams()
    if (query) params.set('q', query)
    if (f === 'uncategorized') params.set('uncategorized', '1')
    else if (typeof f === 'number') params.set('category_id', String(f))
    if (acct !== 'all') params.set('account_id', String(acct))
    const r = await get<{ rows: Tx[]; total: number }>(`/api/transactions?${params}`)
    setTxs(r.rows)
    setTxTotal(r.total)
  }, [])

  useEffect(() => {
    loadStatic().catch(console.error)
    loadMonthly().catch(console.error)
  }, [loadStatic, loadMonthly])
  useEffect(() => {
    loadMonth(month).catch(console.error)
  }, [month, loadMonth])
  useEffect(() => {
    const t = setTimeout(() => loadTxs(q, filter, accountFilter).catch(console.error), 200)
    return () => clearTimeout(t)
  }, [q, filter, accountFilter, loadTxs])

  const refreshAll = useCallback(() => {
    loadMonthly().catch(console.error)
    loadMonth(month).catch(console.error)
    loadTxs(q, filter, accountFilter).catch(console.error)
  }, [loadMonthly, loadMonth, loadTxs, month, q, filter, accountFilter])

  async function onImportFile(file: File) {
    if (!importAccount) return
    setImporting(true)
    setLastImport(null)
    try {
      const content = await file.text()
      const s = await post<ImportSummary>('/api/imports', {
        accountId: importAccount,
        filename: file.name,
        content,
      })
      setLastImport(
        `${file.name}: ${s.imported} imported, ${s.skipped} duplicate${s.skipped === 1 ? '' : 's'} skipped (${s.format})` +
          (s.transfersFiled ? ` · ${s.transfersFiled} auto-filed as transfers` : ''),
      )
      refreshAll()
    } catch (e) {
      setLastImport(`Import failed — ${e instanceof Error ? e.message : e}`)
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function onAddAccount() {
    if (!newAccount?.name.trim()) return
    const a = await post<Account>('/api/accounts', newAccount)
    setNewAccount(null)
    setAccounts((cur) => [...cur, a])
    setImportAccount(a.id)
  }

  async function onNewCategory(tx: Tx) {
    const name = window.prompt('New category name (e.g. Gardening):', '')
    if (!name?.trim()) return
    const cat = await post<Category>('/api/categories', { name: name.trim(), kind: 'expense' })
    await loadStatic()
    await onCategorize(tx, cat.id)
  }

  async function onCategorize(tx: Tx, categoryId: number | null) {
    const r = await patch<{ ok: true; ruleApplied: number; pattern: string | null }>(
      `/api/transactions/${tx.id}`,
      { categoryId },
    )
    const cat = categories.find((c) => c.id === categoryId)?.name
    if (categoryId !== null && r.pattern) {
      setLastImport(
        `Filed under ${cat} — “${r.pattern}” now auto-files this merchant` +
          (r.ruleApplied > 0 ? ` (${r.ruleApplied} past transaction${r.ruleApplied === 1 ? '' : 's'} updated too)` : ''),
      )
    }
    refreshAll()
  }

  async function onBudgetChange(categoryId: number, value: string) {
    let cents = 0
    try {
      cents = value.trim() === '' ? 0 : parseMoney(value)
    } catch {
      return
    }
    await put('/api/budget', { categoryId, monthlyCents: cents })
    loadMonth(month).catch(console.error)
  }

  const incomeRows = budget.filter((b) => b.kind === 'income' && (b.actual_cents !== 0 || b.monthly_cents !== 0))
  const expenseBudget = budget.filter((b) => b.kind === 'expense' && b.category_id !== null)
  const bulletRows = expenseBudget
    .filter((b) => b.monthly_cents > 0 || b.actual_cents > 0)
    .map((b) => ({ name: b.name, actual: b.actual_cents, budget: b.monthly_cents }))
  const incomeTotal = budget.filter((b) => b.kind === 'income').reduce((s, b) => s + b.actual_cents, 0)
  const spendTotal = budget.filter((b) => b.kind === 'expense').reduce((s, b) => s + Math.max(0, b.actual_cents), 0)
  const savings = incomeTotal - spendTotal
  const savingsRate = incomeTotal > 0 ? Math.round((savings / incomeTotal) * 100) : null
  const uncategorizedCount = useMemo(() => txs.filter((t) => t.category_id === null).length, [txs])

  const monthOptions = monthly.map((m) => m.month)
  const hasData = monthly.length > 0

  return (
    <>
      {/* ---------- import bar ---------- */}
      <div className="card wide">
        <div className="h4row">
          <h2>Accounts &amp; import</h2>
          <div className="right muted">
            CSV or OFX/QFX download from the bank · duplicates are skipped automatically
          </div>
        </div>
        <div className="importbar">
          {accounts.length === 0 && (
            <span className="sub2">
              First: name the bank account these imports belong to <b className="inkstrong">→</b>
            </span>
          )}
          {accounts.map((a) => (
            <button
              key={a.id}
              className={`chipbtn ${importAccount === a.id ? 'on' : ''}`}
              onClick={() => setImportAccount(a.id)}
              title={`Imports go to ${a.name}`}
            >
              {a.name}
            </button>
          ))}
          {newAccount ? (
            <span className="addform">
              <input
                autoFocus
                placeholder="e.g. WF Checking ··2841"
                value={newAccount.name}
                onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && onAddAccount()}
              />
              <select
                value={newAccount.kind}
                onChange={(e) => setNewAccount({ ...newAccount, kind: e.target.value as 'checking' | 'savings' })}
              >
                <option value="checking">checking</option>
                <option value="savings">savings</option>
              </select>
              <button className="btn" onClick={onAddAccount}>
                Add
              </button>
              <button className="btn ghosty" onClick={() => setNewAccount(null)}>
                Cancel
              </button>
            </span>
          ) : (
            <button className="chipbtn" onClick={() => setNewAccount({ name: '', kind: 'checking' })}>
              + account
            </button>
          )}
          <span style={{ marginLeft: 'auto' }} />
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.ofx,.qfx,.txt"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onImportFile(e.target.files[0])}
          />
          <button
            className="btn gold"
            disabled={!importAccount || importing}
            title={!importAccount ? 'Add an account first — imports are filed under an account' : undefined}
            onClick={() => fileRef.current?.click()}
          >
            {importing ? 'Importing…' : 'Import file'}
          </button>
        </div>
        {lastImport && <div className="sub2 importmsg">{lastImport}</div>}
      </div>

      {!hasData ? (
        <div className="card wide">
          <h2>Nothing here yet</h2>
          <p>
            Download a CSV from Wells Fargo (Accounts → Download Account Activity → Comma Delimited) or an
            OFX/QFX file, then import it above. Charts, categories, and the budget light up from the first
            file.
          </p>
        </div>
      ) : (
        <div className="grid12">
          {/* ---------- charts row ---------- */}
          <div className="card c8">
            <div className="h4row">
              <h2>Income vs. spending</h2>
              <div className="right legend">
                <span className="li">
                  <span className="sw" style={{ background: 'var(--s3)' }} />
                  Income
                </span>
                <span className="li">
                  <span className="sw" style={{ background: 'var(--s5)' }} />
                  Spending
                </span>
              </div>
            </div>
            <GroupedBars
              data={monthly.map((m) => ({ label: fmtMonth(m.month), a: m.income_cents, b: m.spend_cents }))}
              names={['Income', 'Spending']}
              colors={['var(--s3)', 'var(--s5)']}
            />
          </div>
          <div className="card c4">
            <div className="h4row">
              <h2>Spending by category</h2>
              <div className="right">
                <select className="mini" value={month} onChange={(e) => setMonth(e.target.value)}>
                  {monthOptions.map((m) => (
                    <option key={m} value={m}>
                      {fmtMonth(m, true)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <HBars data={catSpend.map((c) => ({ name: c.name, cents: c.spend_cents }))} color="var(--s2)" />
          </div>

          {/* ---------- budget row ---------- */}
          <div className="card c4">
            <div className="h4row">
              <h2>Income · {fmtMonth(month, true)}</h2>
            </div>
            <table>
              <tbody>
                {incomeRows.map((r) => (
                  <tr key={r.category_id ?? "un"}>
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
          <div className="card c5">
            <div className="h4row">
              <h2>Plan vs. actual · {fmtMonth(month, true)}</h2>
              <div className="right">
                <button className="btn mini" onClick={() => setEditBudgets((v) => !v)}>
                  {editBudgets ? 'Done' : 'Set budgets'}
                </button>
              </div>
            </div>
            {editBudgets ? (
              <table>
                <tbody>
                  {expenseBudget.map((b) => (
                    <tr key={b.category_id}>
                      <td>{b.name}</td>
                      <td className="r">
                        <input
                          className="budgetinput"
                          defaultValue={b.monthly_cents > 0 ? (b.monthly_cents / 100).toString() : ''}
                          placeholder="0"
                          onBlur={(e) => onBudgetChange(b.category_id!, e.target.value)}
                          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : bulletRows.length > 0 ? (
              <Bullets data={bulletRows} />
            ) : (
              <p className="sub2">No budgets set — click “Set budgets” to plan monthly amounts per category.</p>
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
              Income {fmtShort(incomeTotal)} − spending {fmtShort(spendTotal)}. Transfers between your own
              accounts are excluded.
            </div>
          </div>

          {/* ---------- transactions ---------- */}
          <div className="card c12">
            <div className="h4row">
              <h2>Transactions</h2>
              <div className="right">
                <select
                  className="mini"
                  value={accountFilter === 'all' ? 'all' : String(accountFilter)}
                  onChange={(e) => setAccountFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                >
                  <option value="all">All accounts</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <select
                  className="mini"
                  value={typeof filter === 'number' ? String(filter) : filter}
                  onChange={(e) => {
                    const v = e.target.value
                    setFilter(v === 'all' || v === 'uncategorized' ? v : Number(v))
                  }}
                >
                  <option value="all">All categories</option>
                  <option value="uncategorized">Uncategorized{uncategorizedCount ? ` (${uncategorizedCount})` : ''}</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <span className="search">
                  <input placeholder="Search merchant or category…" value={q} onChange={(e) => setQ(e.target.value)} />
                </span>
                <span className="muted">
                  {txs.length} of {txTotal}
                </span>
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
                {txs.map((t) => (
                  <tr key={t.id}>
                    <td className="muted nowrap">{t.posted_on.slice(5)}</td>
                    <td className="desc" title={t.description}>
                      {t.description}
                    </td>
                    <td className="muted nowrap">{t.account_name}</td>
                    <td>
                      <select
                        className={`mini catsel ${t.category_id === null ? 'unset' : ''}`}
                        value={t.category_id ?? ''}
                        onChange={(e) =>
                          e.target.value === '__new'
                            ? onNewCategory(t)
                            : onCategorize(t, e.target.value === '' ? null : Number(e.target.value))
                        }
                        title={t.categorized_by ?? 'uncategorized'}
                      >
                        <option value="">— pick —</option>
                        {categories.map((c) => (
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
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  )
}
