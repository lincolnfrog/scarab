import { useId, useState } from 'react'
import { MAX_SERIES_IDS, type SeriesMeta } from '../../shared/series-api'
import { Button } from '../ui/Button'
import { Dialog } from '../ui/Dialog'
import { Field, Select } from '../ui/Field'
import { Skeleton } from '../ui/Skeleton'
import { perfDefaults, perfIds, perfLineCount, perfOptions, type PerfPick } from './compareModel'
import { coverageText } from './pickerModel'
import './chart.css'

/** 'Vanguard · time-weighted return (securities only)' → 'Vanguard (securities only)'. */
const shortLabel = (label: string) => label.replace(' · time-weighted return', '')

/**
 * Compare's Performance preset (amendment 4): pick accounts or holdings and
 * see their time-weighted returns — what the investments earned, leaving out
 * money moved in or out — against a benchmark, all rebased to 100 at one
 * common start. Several holdings can be combined into one line (their net
 * performance together, set:a+b:twr). Only ids go back to Compare.
 */
export function PerformanceDialog(p: { open: boolean; onClose: () => void; catalog: SeriesMeta[] | null; onApply: (ids: string[]) => void }) {
  // A fresh pick every time it opens (the body remounts).
  const [opened, setOpened] = useState(0)
  const [wasOpen, setWasOpen] = useState(p.open)
  if (p.open !== wasOpen) {
    setWasOpen(p.open)
    if (p.open) setOpened((n) => n + 1)
  }
  return <PerformanceBody key={`${opened}-${p.catalog ? 1 : 0}`} {...p} />
}

function PerformanceBody(p: { open: boolean; onClose: () => void; catalog: SeriesMeta[] | null; onApply: (ids: string[]) => void }) {
  const uid = useId()
  const opts = perfOptions(p.catalog ?? [])
  const [pick, setPick] = useState<PerfPick>(() => perfDefaults(opts))
  const lines = perfLineCount(pick)
  const room = pick.bench ? MAX_SERIES_IDS - 1 : MAX_SERIES_IDS
  const ok = lines >= 1 && lines <= room
  const nothing = p.catalog !== null && opts.accounts.every((a) => !a.available) && opts.holdings.every((h) => !h.available)

  const flip = (key: 'accounts' | 'holdings', id: string, on: boolean) =>
    setPick((x) => ({ ...x, [key]: on ? [...x[key], id] : x[key].filter((y) => y !== id) }))

  const row = (e: SeriesMeta, key: 'accounts' | 'holdings') => {
    const on = pick[key].includes(e.id)
    return (
      <label key={e.id} className={`ch-check${e.available ? '' : ' off'}`}>
        <input
          type="checkbox"
          aria-label={shortLabel(e.label)}
          aria-describedby={`${uid}-${e.id}`}
          checked={on}
          disabled={!e.available && !on}
          onChange={(ev) => flip(key, e.id, ev.target.checked)}
        />
        <span>
          {shortLabel(e.label)}
          <small id={`${uid}-${e.id}`}>{e.available ? coverageText(e) : e.reason}</small>
        </span>
      </label>
    )
  }

  return (
    <Dialog
      open={p.open}
      onClose={p.onClose}
      width={520}
      title="Performance"
      subtitle="Time-weighted returns — what the investments earned, leaving out money moved in or out — against a benchmark, rebased to 100 at a common start."
      footer={
        <>
          <Button onClick={p.onClose}>Cancel</Button>
          <Button
            variant="gold"
            disabled={!ok}
            onClick={() => {
              p.onApply(perfIds(pick))
              p.onClose()
            }}
          >
            Show performance
          </Button>
        </>
      }
    >
      {p.catalog === null ? (
        <div className="ch-skel-rows" aria-busy="true">
          <Skeleton h={14} />
          <Skeleton h={14} w="70%" />
          <Skeleton h={14} w="80%" />
        </div>
      ) : nothing ? (
        <p className="ch-hint">
          No returns to show yet. A time-weighted return needs trades and market prices for most of what was held — record trades, and
          refresh or set prices on Investments.
        </p>
      ) : (
        <div className="ch-perf">
          {opts.accounts.length > 0 && (
            <fieldset className="ch-perf-set">
              <legend>Accounts</legend>
              {opts.accounts.map((e) => row(e, 'accounts'))}
            </fieldset>
          )}
          {opts.holdings.length > 0 && (
            <fieldset className="ch-perf-set">
              <legend>Holdings</legend>
              {opts.holdings.map((e) => row(e, 'holdings'))}
              <label className={`ch-check ch-perf-combine${pick.holdings.length >= 2 ? '' : ' off'}`}>
                <input
                  type="checkbox"
                  aria-label="Combine the picked holdings into one line"
                  aria-describedby={`${uid}-combine`}
                  checked={pick.combine}
                  disabled={pick.holdings.length < 2}
                  onChange={(ev) => setPick((x) => ({ ...x, combine: ev.target.checked }))}
                />
                <span>
                  Combine the picked holdings into one line
                  <small id={`${uid}-combine`}>Their performance together, weighted by what was held — instead of a line each.</small>
                </span>
              </label>
            </fieldset>
          )}
          <Field label="Benchmark" hint="A market index as the same kind of index: price only, no dividends (the returns leave them out too).">
            <Select value={pick.bench ?? ''} onChange={(ev) => setPick((x) => ({ ...x, bench: ev.target.value || null }))}>
              {opts.benchmarks.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available}>
                  {b.label}
                  {b.available ? '' : ` — ${b.reason ?? 'no price history yet'}`}
                </option>
              ))}
              <option value="">None</option>
            </Select>
          </Field>
          {lines > room && (
            <p className="ch-note ch-perf-err" role="alert">
              Compare draws up to {MAX_SERIES_IDS} lines: pick at most {room}
              {pick.bench ? ' with a benchmark' : ''}, or combine the holdings into one.
            </p>
          )}
        </div>
      )}
    </Dialog>
  )
}
