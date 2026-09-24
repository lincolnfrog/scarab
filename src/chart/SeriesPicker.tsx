import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { MAX_SERIES_IDS, type SeriesMeta } from '../../shared/series-api'
import { Button } from '../ui/Button'
import { TextInput } from '../ui/Field'
import { Popover } from '../ui/Popover'
import { Skeleton } from '../ui/Skeleton'
import { slotColor, type Slot } from './palette'
import { coverageText, flatItems, pickerGroups, pickStep } from './pickerModel'
import './chart.css'

export type SeriesPickerProps = {
  /** The catalog (GET /api/series/catalog); null while it loads. */
  catalog: SeriesMeta[] | null
  error?: string | null
  onRetry?: () => void
  selected: readonly string[]
  /** Pinned colours of the selected series, for their swatches. */
  slots: ReadonlyMap<string, Slot>
  onToggle: (id: string) => void
  max?: number
}

/**
 * The Compare series picker (plan §C7): a searchable, keyboard-first list of
 * everything the catalog offers, grouped (Net worth, Accounts, Holdings,
 * Benchmarks…). Typing filters; ↑/↓ (PageUp/PageDown, Ctrl+Home/End) move;
 * Enter adds or removes the active entry and the list stays open for the
 * next; Esc closes. An entry that can't be drawn yet is disabled with the
 * catalog's reason, and so is everything else once six are picked.
 *
 * ARIA: a combobox search box controlling a multi-select listbox through
 * aria-activedescendant — focus never leaves the box.
 */
export function SeriesPicker(p: SeriesPickerProps) {
  const max = p.max ?? MAX_SERIES_IDS
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const anchor = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const groups = useMemo(() => pickerGroups(p.catalog ?? [], q, p.selected, max), [p.catalog, q, p.selected, max])
  const items = flatItems(groups)
  const cur = items.length ? Math.min(Math.max(0, active), items.length - 1) : -1
  const optId = (i: number) => `${uid}-o${i}`

  // Keep the active row in view as the keyboard (or a new search) moves it — never on hover, where
  // scrolling the row under the pointer would hand the pointer the next row, and scroll again.
  const follow = useRef(false)
  useLayoutEffect(() => {
    if (!follow.current) return
    follow.current = false
    if (!open || cur < 0) return
    document.getElementById(optId(cur))?.scrollIntoView({ block: 'nearest' })
  })

  const toggle = (i: number) => {
    const it = items[i]
    if (!it || it.disabled) return
    p.onToggle(it.meta.id)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (cur >= 0) toggle(cur)
      return
    }
    const next = pickStep(e.key, cur, items.length, e.ctrlKey || e.metaKey)
    if (next === undefined) return
    e.preventDefault()
    follow.current = true
    setActive(next)
  }

  const count = p.selected.length
  const activeItem = cur >= 0 ? items[cur] : undefined
  let k = -1

  return (
    <>
      <Button
        ref={anchor}
        size="mini"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Each opening starts a fresh search.
          if (!open) {
            setQ('')
            setActive(0)
          }
          setOpen(!open)
        }}
      >
        + Add series
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="start" aria-label="Add series" className="ch-picker">
        <div className="ch-picker-head">
          <TextInput
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-activedescendant={cur >= 0 ? optId(cur) : undefined}
            aria-autocomplete="list"
            aria-label="Search series"
            placeholder="Search accounts, holdings, benchmarks…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setActive(0)
              follow.current = true
            }}
            onKeyDown={onKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="ch-picker-count" aria-live="polite">
            {count} of {max}
          </span>
        </div>
        {p.catalog === null ? (
          p.error ? (
            <div className="ch-picker-empty">
              Couldn’t load what can be compared: {p.error}
              {p.onRetry && (
                <Button size="mini" onClick={p.onRetry}>
                  Retry
                </Button>
              )}
            </div>
          ) : (
            <div className="ch-picker-empty" aria-busy="true">
              <Skeleton h={12} />
              <Skeleton h={12} w="70%" />
              <Skeleton h={12} w="80%" />
            </div>
          )
        ) : (
          <div
            ref={listRef}
            id={`${uid}-list`}
            className="ch-picker-list"
            role="listbox"
            aria-multiselectable="true"
            aria-label="Series"
            // Clicks on rows must not take focus from the search box.
            onMouseDown={(e) => e.preventDefault()}
          >
            {items.length === 0 && <div className="ch-picker-empty">Nothing matches “{q.trim()}”.</div>}
            {groups.map((g) => (
              <div key={g.group} role="group" aria-labelledby={`${uid}-g-${g.group.replace(/\W/g, '')}`}>
                <div className="ch-picker-group" id={`${uid}-g-${g.group.replace(/\W/g, '')}`} role="presentation">
                  {g.group}
                </div>
                {g.items.map((it) => {
                  k++
                  const i = k
                  const slot = p.slots.get(it.meta.id)
                  return (
                    <div
                      key={it.meta.id}
                      id={optId(i)}
                      role="option"
                      aria-selected={it.selected}
                      aria-disabled={it.disabled || undefined}
                      className={`ch-picker-opt${i === cur ? ' on' : ''}${it.selected ? ' sel' : ''}${it.disabled ? ' off' : ''}`}
                      onPointerMove={() => i !== cur && setActive(i)}
                      onClick={() => {
                        setActive(i)
                        toggle(i)
                      }}
                    >
                      <span className="ch-picker-check" aria-hidden="true">
                        {it.selected ? <span className="ch-picker-sw" style={{ background: slot ? slotColor(slot) : 'var(--ink-3)' }} /> : null}
                      </span>
                      <span className="ch-picker-txt">
                        <span className="ch-picker-lbl">{it.meta.label}</span>
                        <span className="ch-picker-sub">{it.why ?? coverageText(it.meta)}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        )}
        <div className="ch-picker-foot">
          {activeItem?.disabled && activeItem.why ? (
            <span className="ch-picker-why" aria-live="polite">
              {activeItem.why}
            </span>
          ) : (
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move · <kbd>Enter</kbd> {activeItem?.selected ? 'remove' : 'add'} · <kbd>Esc</kbd> close
            </span>
          )}
        </div>
      </Popover>
    </>
  )
}
