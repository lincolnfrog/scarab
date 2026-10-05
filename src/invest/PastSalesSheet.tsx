import { Fragment, useEffect, useMemo, useState, type TextareaHTMLAttributes } from 'react'
import { isLongTerm } from '../../engine/lots'
import { parseSales, type AmountBasis, type PastedSale } from '../../engine/sales-paste'
import type { PastSalesBody, PastSalesResult } from '../../shared/invest-api'
import { formatCents, formatQtyMicro } from '../../shared/money'
import { post } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { Field, FieldGrid, Select, useField } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { useAction } from '../ui/useAction'
import './invest.css'

export type PastSalesAccount = { id: number; name: string }

/**
 * "Paste past sales": shares sold before Scarab tracked them, one sale per
 * line with the lot it came from — a realized gain/loss page, copied. Each
 * becomes a sale with an explicit basis (engine createPastSales): the gain
 * realizes with the lot's acquisition date setting its term, and the
 * account's holdings stay as they are. Read as it's typed by the engine's
 * parser (engine/sales-paste.ts); a dry run of the engine's checks shows
 * every error and warning before anything is saved, and the engine takes
 * all the rows or none.
 */
export default function PastSalesSheet(p: {
  open: boolean
  accounts: readonly PastSalesAccount[]
  initialAccountId: number | null
  onClose: () => void
  onDone: () => void
}) {
  if (!p.open) return null
  return <Sheet {...p} />
}

const PLACEHOLDER = 'GOOG, 26.5, 3141.31, 06/25/2022, 8301.125, 1/5/2026\nGOOG, 10, 1185.40, 06/25/2022, 3132.50, 3/2/2026'

// Which way the last paste's amounts were, per viewer: a report keeps its layout from one visit to the next.
const PREF_KEY = 'scarab:past-sales-amounts'
function readPref(): { basis: AmountBasis; proceeds: AmountBasis } {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null') as { basis?: unknown; proceeds?: unknown } | null
    const ok = (x: unknown): x is AmountBasis => x === 'total' || x === 'perShare'
    if (v && ok(v.basis) && ok(v.proceeds)) return { basis: v.basis, proceeds: v.proceeds }
  } catch {
    /* no storage here: the defaults */
  }
  return { basis: 'total', proceeds: 'total' }
}
function writePref(v: { basis: AmountBasis; proceeds: AmountBasis }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(v))
  } catch {
    /* fine: it just won't be remembered */
  }
}

type Notes = { errors: Map<number, string>; warnings: Map<number, string[]> }
const NO_NOTES: Notes = { errors: new Map(), warnings: new Map() }

const AMOUNT_OPTIONS: { value: AmountBasis; label: string }[] = [
  { value: 'total', label: 'Total' },
  { value: 'perShare', label: 'Per share' },
]

function Sheet({ accounts, initialAccountId, onClose, onDone }: Omit<Parameters<typeof PastSalesSheet>[0], 'open'>) {
  const [accountId, setAccountId] = useState(() => initialAccountId ?? accounts[0]?.id ?? 0)
  const [text, setText] = useState('')
  const [amounts, setAmounts] = useState(readPref)
  const [notes, setNotes] = useState<Notes>(NO_NOTES)
  const setAmount = (k: 'basis' | 'proceeds', v: AmountBasis) => {
    const next = { ...amounts, [k]: v }
    setAmounts(next)
    writePref(next)
  }

  const parsed = useMemo(() => parseSales(text, amounts), [text, amounts])
  const account = accounts.find((a) => a.id === accountId)
  const body = (dryRun: boolean): PastSalesBody => ({
    investAccountId: accountId,
    dryRun,
    rows: parsed.rows.map((r) => ({
      symbol: r.symbol,
      qty: formatQtyMicro(r.qtyMicro).replace(/,/g, ''),
      basisCents: r.basisCents,
      acquiredOn: r.acquiredOn,
      proceedsCents: r.proceedsCents,
      soldOn: r.soldOn,
    })),
  })
  // The engine's own checks, as a dry run, a moment after the paste settles: errors block, warnings inform.
  const checkKey = JSON.stringify(body(true))
  useEffect(() => {
    if (parsed.rows.length === 0 || !account) {
      setNotes(NO_NOTES)
      return
    }
    let live = true
    const lines = parsed.rows.map((r) => r.line)
    const t = setTimeout(() => {
      post<PastSalesResult>('/api/trades/sales', JSON.parse(checkKey) as PastSalesBody)
        .then((r) => live && setNotes(notesOf(r, lines)))
        .catch(() => live && setNotes(NO_NOTES)) // the save reports whatever this couldn't
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
    // checkKey is the request itself: it changes exactly when the rows or the account do.
  }, [checkKey])

  const blocking = parsed.errors.length + notes.errors.size
  const canSave = parsed.rows.length > 0 && blocking === 0 && !!account
  const totals = parsed.rows.reduce(
    (t, r) => {
      const gain = r.proceedsCents - r.basisCents
      return isLongTerm(r.acquiredOn, r.soldOn) ? { ...t, lt: t.lt + gain } : { ...t, st: t.st + gain }
    },
    { st: 0, lt: 0 },
  )

  const save = useAction(
    async () => {
      const lines = parsed.rows.map((r) => r.line)
      const r = await post<PastSalesResult>('/api/trades/sales', body(false))
      if (r.errors.length > 0) {
        setNotes(notesOf(r, lines))
        throw new Error(`${r.errors.length} row${r.errors.length === 1 ? '' : 's'} need fixing — nothing was recorded`)
      }
      return r
    },
    {
      success: (r) => `Recorded ${r.created} past sale${r.created === 1 ? '' : 's'} in ${account?.name ?? 'the account'}`,
      errorPrefix: "Couldn't record the sales",
      onDone: () => {
        onDone()
        onClose()
      },
    },
  )

  return (
    <Drawer
      open
      width={780}
      onClose={onClose}
      dismissible={!save.busy}
      title="Past sales"
      subtitle="Shares sold before Scarab tracked them — each with the lot it came from, so the gain and its term come out right"
      footer={
        <>
          <span className="ui-foot-start inv-note">
            {parsed.rows.length > 0
              ? `${parsed.rows.length} sale${parsed.rows.length === 1 ? '' : 's'} · ${formatCents(totals.st + totals.lt, { sign: true })} gain` +
                (totals.st !== 0 && totals.lt !== 0 ? ` (short ${formatCents(totals.st, { sign: true })} · long ${formatCents(totals.lt, { sign: true })})` : '')
              : 'Nothing read yet'}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gold" busy={save.busy} disabled={!canSave} onClick={() => canSave && void save.run()}>
            {parsed.rows.length > 0 ? `Record ${parsed.rows.length} sale${parsed.rows.length === 1 ? '' : 's'}` : 'Record sales'}
          </Button>
        </>
      }
    >
      <div className="inv-form">
        <FieldGrid min={180}>
          <Field label="Account">
            <Select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Cost basis is">
            <Segmented aria-label="Cost basis is" size="md" value={amounts.basis} options={AMOUNT_OPTIONS} onChange={(v) => setAmount('basis', v)} />
          </Field>
          <Field label="Sale amount is">
            <Segmented aria-label="Sale amount is" size="md" value={amounts.proceeds} options={AMOUNT_OPTIONS} onChange={(v) => setAmount('proceeds', v)} />
          </Field>
        </FieldGrid>
        <Field
          label="Sales"
          hint="Symbol · Shares · Cost basis · Acquired · Sale amount · Sold, one sale per line, separated by tabs or commas — the columns of a realized gain/loss page. A header row may name them in another order. Holdings aren't changed: these shares were never in Scarab's lots."
        >
          <PasteArea autoFocus value={text} placeholder={PLACEHOLDER} onChange={(e) => setText(e.target.value)} />
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
        {parsed.rows.length > 0 && <Preview rows={parsed.rows} notes={notes} />}
      </div>
    </Drawer>
  )
}

/** The engine's row-indexed errors and warnings, keyed by pasted line. */
function notesOf(r: PastSalesResult, lines: number[]): Notes {
  const errors = new Map<number, string>()
  const warnings = new Map<number, string[]>()
  for (const e of r.errors) errors.set(lines[e.row] ?? -1, e.message)
  for (const w of r.warnings) {
    const line = lines[w.row] ?? -1
    warnings.set(line, [...(warnings.get(line) ?? []), w.message])
  }
  return { errors, warnings }
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
      rows={6}
      spellCheck={false}
      autoComplete="off"
    />
  )
}

function Preview({ rows, notes }: { rows: PastedSale[]; notes: Notes }) {
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
            <th className="r">Sale amount</th>
            <th>Sold</th>
            <th className="r">Gain</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const gain = r.proceedsCents - r.basisCents
            const err = notes.errors.get(r.line)
            const warns = notes.warnings.get(r.line) ?? []
            return (
              <Fragment key={r.line}>
              <tr className={`${err ? 'inv-rowerr' : ''}${err || warns.length ? ' inv-hasnote' : ''}`}>
                <td className="r num muted">{r.line}</td>
                <td><span className="tk"><span className="lg">{r.symbol}</span></span></td>
                <td className="r num">{formatQtyMicro(r.qtyMicro)}</td>
                <td className="r num">{formatCents(r.basisCents)}</td>
                <td className="num">{r.acquiredOn}</td>
                <td className="r num">{formatCents(r.proceedsCents)}</td>
                <td className="num">{r.soldOn}</td>
                <td className={`r num ${gain > 0 ? 'pos' : gain < 0 ? 'neg' : ''}`}>
                  {formatCents(gain, { sign: true })}
                  <span className="muted"> {isLongTerm(r.acquiredOn, r.soldOn) ? 'LT' : 'ST'}</span>
                </td>
              </tr>
              {(err || warns.length > 0) && (
                // A sale's notes run the table's full width beneath it: they are sentences, not a column.
                <tr className={`inv-noterow${err ? ' inv-rowerr' : ''}`}>
                  <td />
                  <td colSpan={7}>
                    <div className="inv-notes">
                      {err && <span className="inv-err">{err}</span>}
                      {warns.map((w) => (
                        <span key={w} className="inv-warn">{w}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
