import { useEffect, useId, useMemo, useState, type KeyboardEvent, type Ref } from 'react'
import type { AssetRow } from '../../shared/invest-api'
import { TextInput } from '../ui/Field'
import { searchSymbols, type MarketIndex, type SymbolKind, type SymbolOption } from './symbolSearch'
import './invest.css'

export type SymbolInputProps = {
  value: string
  onChange: (text: string) => void
  /** A suggestion was picked: its symbol is already in the box; this says which security (its kind, its name). */
  onPick?: (o: SymbolOption) => void
  /** The household's recorded symbols (their kinds are fixed). */
  recorded: readonly Pick<AssetRow, 'symbol' | 'kind'>[]
  /** The market list, or null while it loads (suggestions then come from `recorded` alone). */
  market: MarketIndex | null
  /** Symbols to rank first: what the account holds. */
  held?: ReadonlySet<string>
  /** Offer only these kinds (a stock grant: stock). */
  kinds?: readonly SymbolKind[]
  /** Ties go to this kind. */
  preferKind?: SymbolKind
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
  'aria-label'?: string
  ref?: Ref<HTMLInputElement>
}

/**
 * A ticker box that suggests as it's typed — a combobox over the household's
 * own symbols and the shared market list (names from the basket, where the
 * source gave one). Suggestions never select themselves: typing and pressing
 * Enter still submits the form; ↓/↑ move through the list, Enter picks, Esc
 * closes it (without closing the drawer it sits in). What's typed is kept
 * as typed — a symbol the market doesn't list (a fund, private stock) is fine.
 */
export function SymbolInput({ value, onChange, onPick, recorded, market, held, kinds, preferKind, placeholder, autoFocus, disabled, ref, ...rest }: SymbolInputProps) {
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const options = useMemo(
    () => (open ? searchSymbols(value, { recorded, market, held, kinds, preferKind }) : []),
    [open, value, recorded, market, held, kinds, preferKind],
  )
  const shown = open && options.length > 0
  const at = shown && active >= 0 && active < options.length ? active : -1

  useEffect(() => {
    if (at >= 0) document.getElementById(`${listId}-o${at}`)?.scrollIntoView({ block: 'nearest' })
  }, [at, listId])

  const pick = (o: SymbolOption) => {
    onChange(o.symbol)
    onPick?.(o)
    setOpen(false)
    setActive(-1)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!shown) {
        setOpen(true)
        setActive(0)
      } else setActive((at + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      if (!shown) return
      e.preventDefault()
      setActive(at <= 0 ? options.length - 1 : at - 1)
    } else if (e.key === 'Enter') {
      if (at >= 0 && !e.metaKey && !e.ctrlKey) {
        // Picking, not submitting.
        e.preventDefault()
        e.stopPropagation()
        pick(options[at]!)
      } else setOpen(false)
    } else if (e.key === 'Escape') {
      if (!shown) return
      // Closes the list, not the drawer around it.
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      setActive(-1)
    } else if (e.key === 'Tab') setOpen(false)
  }

  return (
    <span className="inv-symbox">
      <TextInput
        {...rest}
        ref={ref}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={at >= 0 ? `${listId}-o${at}` : undefined}
        className="inv-sym"
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onMouseDown={() => setOpen(true)}
        onBlur={() => {
          setOpen(false)
          setActive(-1)
        }}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Suggestions" className="inv-symlist" hidden={!shown}>
        {options.map((o, i) => (
          <li
            key={`${o.kind}:${o.symbol}`}
            id={`${listId}-o${i}`}
            role="option"
            aria-selected={i === at}
            className={`inv-symopt${i === at ? ' inv-symopt-on' : ''}`}
            // Keep focus in the box: a click picks without blurring it first.
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== at && setActive(i)}
            onClick={() => pick(o)}
          >
            <span className="inv-symopt-sym">{o.symbol}</span>
            <span className="inv-symopt-name">{o.name ?? ''}</span>
            <span className="inv-symopt-tags">
              {o.held ? <span className="inv-tag">held here</span> : o.recorded ? <span className="inv-tag">recorded</span> : null}
              <span className="inv-tag inv-quiet">{o.kind === 'crypto' ? 'crypto' : o.etf ? 'ETF' : 'stock'}</span>
            </span>
          </li>
        ))}
      </ul>
    </span>
  )
}
