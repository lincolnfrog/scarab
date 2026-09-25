import { useMemo, useState, type TextareaHTMLAttributes } from 'react'
import { parseRules } from '../../engine/import'
import type { Category, RulesImportResult } from '../../shared/types'
import { post } from '../api'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { Field, useField } from '../ui/Field'
import { useAction } from '../ui/useAction'
import './screens.css'

const PLACEHOLDER = 'NUGGET MARKET\tGroceries\nLIFE TIME\tFitness\nSQ *AMY-GYPSY ROSE\tPersonal care\t1'

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * "Import rules": paste a pattern → category list and every transaction that
 * matches is filed, past and future. Read as it's typed by the engine's own
 * parser (engine/import.ts parseRules), so the preview is what gets saved;
 * the engine takes all the lines or none (engine/services.ts importRules).
 */
export default function RulesSheet(p: { open: boolean; categories: readonly Category[]; onClose: () => void; onDone: () => void }) {
  if (!p.open) return null
  return <Sheet {...p} />
}

function Sheet({ categories, onClose, onDone }: { categories: readonly Category[]; onClose: () => void; onDone: () => void }) {
  const [text, setText] = useState('')
  const parsed = useMemo(() => parseRules(text), [text])
  const known = useMemo(() => new Set(categories.map((c) => c.name.toLowerCase())), [categories])
  const newCats = useMemo(() => {
    const out = new Map<string, string>()
    for (const r of parsed.rules) if (!known.has(r.category.toLowerCase())) out.set(r.category.toLowerCase(), out.get(r.category.toLowerCase()) ?? r.category)
    return [...out.values()]
  }, [parsed.rules, known])
  const canSave = parsed.rules.length > 0 && parsed.errors.length === 0

  const save = useAction((body: { text: string }) => post<RulesImportResult>('/api/rules/import', body), {
    success: (r) =>
      [
        `${plural(r.added, 'rule')} added` + (r.updated ? `, ${r.updated.toLocaleString()} updated` : ''),
        r.categoriesCreated.length ? `${plural(r.categoriesCreated.length, 'new category', 'new categories')}` : null,
        `${plural(r.refiled, 'transaction')} re-filed`,
      ]
        .filter(Boolean)
        .join(' · '),
    errorPrefix: "Couldn't import the rules",
    onDone: () => {
      onDone()
      onClose()
    },
  })

  return (
    <Drawer
      open
      width={640}
      onClose={onClose}
      dismissible={!save.busy}
      title="Import rules"
      subtitle="Merchant patterns that file transactions into a category, now and on every later import"
      footer={
        <>
          <span className="ui-foot-start scr-note">
            {parsed.rules.length > 0
              ? `${plural(parsed.rules.length, 'rule')}` + (newCats.length ? ` · ${plural(newCats.length, 'new category', 'new categories')}` : '')
              : 'Nothing read yet'}
          </span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gold" busy={save.busy} disabled={!canSave} onClick={() => canSave && void save.run({ text })}>
            {parsed.rules.length > 0 ? `Import ${plural(parsed.rules.length, 'rule')}` : 'Import rules'}
          </Button>
        </>
      }
    >
      <div className="scr-sheet">
        <Field
          label="Rules"
          hint="Pattern · Category · optional priority, separated by tabs or →, one per line. A pattern matches anywhere in the bank's description, ignoring case; the longest match wins. Categories that don't exist yet are created as spending. Transactions you filed by hand are never changed."
        >
          <PasteArea autoFocus value={text} placeholder={PLACEHOLDER} onChange={(e) => setText(e.target.value)} />
        </Field>

        {parsed.errors.length > 0 && (
          <div className="ui-formerr" role="alert">
            {parsed.errors.length === 1 ? 'One line can’t be read. Fix or delete it:' : `${parsed.errors.length} lines can’t be read. Fix or delete them:`}
            <ul className="scr-errlist">
              {parsed.errors.map((e) => (
                <li key={e.line}>Line {e.line}: {e.message}</li>
              ))}
            </ul>
          </div>
        )}
        {newCats.length > 0 && <p className="scr-note">New spending categories: {newCats.join(', ')}</p>}
        {parsed.rules.length > 0 && (
          <div className="scr-preview">
            <table>
              <thead>
                <tr>
                  <th className="r">Line</th>
                  <th>Pattern</th>
                  <th>Category</th>
                  <th className="r">Priority</th>
                </tr>
              </thead>
              <tbody>
                {parsed.rules.map((r) => (
                  <tr key={r.line}>
                    <td className="r num muted">{r.line}</td>
                    <td className="num">{r.pattern}</td>
                    <td>
                      {r.category}
                      {!known.has(r.category.toLowerCase()) && <span className="tag scr-newtag">new</span>}
                    </td>
                    <td className="r num muted">{r.priority ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
      className="scr-paste"
      rows={8}
      spellCheck={false}
      autoComplete="off"
    />
  )
}
