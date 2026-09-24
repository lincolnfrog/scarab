import { useEffect, useMemo, useState, type TextareaHTMLAttributes } from 'react'
import { parsePositions, type PastedRow } from '../../engine/positions-paste'
import type { OpeningPositionsBody, OpeningPositionsResult } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { post } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { DateInput, Field, FieldGrid, Select, useField } from '../ui/Field'
import { useAction } from '../ui/useAction'
import './invest.css'
import { inMarketList, loadMarketSymbols, type MarketSymbols } from './marketSymbols'

export type OpeningAccount = { id: number; name: string }

/**
 * "Bring in what you already hold": paste an account's lots as of a
 * statement date. Each becomes a buy booked on that date that keeps its real
 * acquisition date for tax (engine createOpeningPositions). The paste is
 * read as it's typed (engine/positions-paste.ts, the same parser the preview
 * shows), and the engine takes all the rows or none.
 *
 * Mountable from anywhere with a list of lots accounts: an empty account,
 * the trade card, and later the account drawer.
 */
export default function OpeningPositionsSheet({
  open,
  accounts,
  initialAccountId,
  knownSymbols,
  today,
  onClose,
  onDone,
}: {
  open: boolean
  accounts: readonly OpeningAccount[]
  initialAccountId: number | null
  /** Symbols Scarab already records — never flagged as unknown. */
  knownSymbols: ReadonlySet<string>
  today: string
  onClose: () => void
  onDone: () => void
}) {
  if (!open) return null
  return (
    <Sheet
      accounts={accounts}
      initialAccountId={initialAccountId}
      knownSymbols={knownSymbols}
      today={today}
      onClose={onClose}
      onDone={onDone}
    />
  )
}

// One separator per paste (engine/positions-paste.ts picks it from the rows),
// so the example uses one too: pasting it as shown must parse.
export const PLACEHOLDER = 'VTI, 120, $18400.00, 3/15/2019\nAAPL, 40, 5200.50, 2021-06-02\nFXAIX, 55.125, $9120, 2020-01-04'

type RowIssue = { error?: string; warnings: string[] }

function Sheet({ accounts, initialAccountId, knownSymbols, today, onClose, onDone }: Omit<Parameters<typeof OpeningPositionsSheet>[0], 'open'>) {
  const [accountId, setAccountId] = useState(() => initialAccountId ?? accounts[0]?.id ?? 0)
  const [asOf, setAsOf] = useState(today)
  const [text, setText] = useState('')
  const [market, setMarket] = useState<MarketSymbols | null>(null)
  // Row errors the engine returned for the rows as last sent, by pasted line.
  const [serverErrors, setServerErrors] = useState<Map<number, string>>(() => new Map())

  useEffect(() => {
    let live = true
    loadMarketSymbols()
      .then((m) => live && setMarket(m))
      .catch(() => live && setMarket(null)) // no list, no unknown-ticker hints
    return () => {
      live = false
    }
  }, [])

  const parsed = useMemo(() => parsePositions(text), [text])
  const issues = useMemo(() => {
    const out = new Map<number, RowIssue>()
    for (const r of parsed.rows) {
      const i: RowIssue = { warnings: [] }
      if (r.acquiredOn && r.acquiredOn > asOf) i.error = `acquired after the as-of date (${asOf})`
      else if (serverErrors.has(r.line)) i.error = serverErrors.get(r.line)
      if (!r.acquiredOn) i.warnings.push(`no acquisition date — holding period starts ${asOf}`)
      if (market && !knownSymbols.has(r.symbol) && !inMarketList(market, r.symbol))
        i.warnings.push('not in the market list — fine for a fund or private stock; set its price by hand')
      out.set(r.line, i)
    }
    return out
  }, [parsed.rows, asOf, market, knownSymbols, serverErrors])

  const blocking = parsed.errors.length + [...issues.values()].filter((i) => i.error).length
  const basisTotal = parsed.rows.reduce((s, r) => s + r.basisCents, 0)
  const account = accounts.find((a) => a.id === accountId)
  const canSave = parsed.rows.length > 0 && blocking === 0 && !!account && !!asOf && asOf <= today

  const save = useAction(
    async (body: OpeningPositionsBody, lines: number[]) => {
      const r = await post<OpeningPositionsResult>('/api/trades/opening', body)
      if (r.errors.length > 0) {
        setServerErrors(new Map(r.errors.map((e) => [lines[e.row] ?? -1, e.message])))
        throw new Error(`${r.errors.length} row${r.errors.length === 1 ? '' : 's'} need fixing — nothing was added`)
      }
      return r
    },
    {
      success: (r) => `Added ${r.created} starting lot${r.created === 1 ? '' : 's'} to ${account?.name ?? 'the account'}`,
      errorPrefix: "Couldn't add the positions",
      onDone: () => {
        onDone()
        onClose()
      },
    },
  )
  const submit = () => {
    if (!canSave) return
    setServerErrors(new Map())
    const rows = parsed.rows
    void save.run(
      {
        investAccountId: accountId,
        asOf,
        rows: rows.map((r) => ({ symbol: r.symbol, qty: formatQtyMicro(r.qtyMicro).replace(/,/g, ''), basisCents: r.basisCents, acquiredOn: r.acquiredOn })),
      },
      rows.map((r) => r.line),
    )
  }

  return (
    <Drawer
      open
      width={640}
      onClose={onClose}
      dismissible={!save.busy}
      title="Starting positions"
      subtitle="What an account already holds, one lot per row — acquisition dates kept for tax"
      footer={
        <>
          <span className="ui-foot-start inv-note">
            {parsed.rows.length > 0 ? `${parsed.rows.length} lot${parsed.rows.length === 1 ? '' : 's'} · ${formatCents(basisTotal)} cost basis` : 'Nothing read yet'}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gold" busy={save.busy} disabled={!canSave} onClick={submit}>
            {parsed.rows.length > 0 ? `Add ${parsed.rows.length} lot${parsed.rows.length === 1 ? '' : 's'}` : 'Add lots'}
          </Button>
        </>
      }
    >
      <div className="inv-form">
        <FieldGrid min={200}>
          <Field label="Account">
            <Select value={accountId} onChange={(e) => { setAccountId(Number(e.target.value)); setServerErrors(new Map()) }}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="As of" hint="The statement date. The lots are on the books from this day; trades before it can't sell them.">
            <DateInput value={asOf} max={today} onChange={(v) => { setAsOf(v); setServerErrors(new Map()) }} />
          </Field>
        </FieldGrid>
        <Field
          label="Positions"
          hint="Symbol · Shares · Cost basis (the lot's total) · Acquired, separated by tabs, commas or spaces — one style per paste. Copy rows from your brokerage's positions or lots page, or type them; a header row is fine."
        >
          <PasteArea
            autoFocus
            value={text}
            placeholder={PLACEHOLDER}
            onChange={(e) => { setText(e.target.value); setServerErrors(new Map()) }}
          />
        </Field>

        {parsed.errors.length > 0 && (
          <div className="ui-formerr" role="alert">
            {parsed.errors.length === 1 ? 'One line can’t be read — fix or delete it:' : `${parsed.errors.length} lines can’t be read — fix or delete them:`}
            <ul className="inv-errlist">
              {parsed.errors.map((e) => (
                <li key={e.line}>Line {e.line}: {e.message}</li>
              ))}
            </ul>
          </div>
        )}
        {parsed.rows.length > 0 && parsed.columns.acquired === null && (
          <p className="inv-note">No acquisition dates in this paste: every lot’s holding period will start on {asOf}, so gains read as short-term.</p>
        )}
        {parsed.rows.length > 0 && <Preview rows={parsed.rows} issues={issues} skipped={parsed.skipped.length} />}
      </div>
    </Drawer>
  )
}

/** A monospace textarea that takes its id and description from the enclosing Field. */
function PasteArea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const f = useField()
  return (
    <textarea
      {...p}
      id={f?.id}
      aria-describedby={f?.describedBy}
      aria-invalid={f?.invalid || undefined}
      data-autofocus={p.autoFocus || undefined}
      className="inv-paste"
      rows={7}
      spellCheck={false}
      autoComplete="off"
    />
  )
}

function Preview({ rows, issues, skipped }: { rows: PastedRow[]; issues: Map<number, RowIssue>; skipped: number }) {
  return (
    <div className="inv-preview">
      <table>
        <thead>
          <tr>
            <th className="r">Line</th>
            <th>Symbol</th>
            <th className="r">Shares</th>
            <th className="r">Cost basis</th>
            <th>Acquired</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const i = issues.get(r.line)
            return (
              <tr key={r.line} className={i?.error ? 'inv-rowerr' : undefined}>
                <td className="r num muted">{r.line}</td>
                <td><span className="tk"><span className="lg">{r.symbol}</span></span></td>
                <td className="r num">{formatQtyMicro(r.qtyMicro)}</td>
                <td className="r num">{formatCents(r.basisCents)}</td>
                <td className="num">{r.acquiredOn ?? <span className="muted">—</span>}</td>
                <td>
                  {/* The grid goes inside the cell: a td that is itself a grid stops being a table cell (its row's rule and tint stop short). */}
                  <div className="inv-notes">
                    {i?.error && <span className="inv-err">{i.error}</span>}
                    {i?.warnings.map((w) => (
                      <span key={w} className="inv-warn">{w}</span>
                    ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {skipped > 0 && <p className="inv-note">{skipped === 1 ? 'One total or cash line was' : `${skipped} total or cash lines were`} left out.</p>}
    </div>
  )
}
