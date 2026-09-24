/**
 * The Future screen's save and re-run bookkeeping, as small pure pieces that
 * node tests can drive (vitest has no DOM). Future.tsx wires them to React.
 *
 * - createLatest: tag each request; only the newest tag's reply may land, so a
 *   slow compare can't overwrite a newer one.
 * - editGeneration: every edit is a new generation, a save carries the
 *   generation it was taken at, and the form is clean only once the newest
 *   generation is saved. Keystrokes typed while a save is in flight stay
 *   dirty, so the reply can't revert them.
 * - createFlushable: a debounce whose waiting call can be run now. Keep-alive
 *   screens run their effect cleanups when hidden; cleanup flushes, never
 *   cancels, so an edit made just before leaving is saved.
 * - parseThreshold / compareKey / dataVersionOf: the odds threshold as typed,
 *   and the key a compare result is cached under.
 * - assumptionPills: the header's summary of a scenario's knobs.
 */

import type { ScenarioParams } from '../../engine/scenarios'
import { formatPercentMicro } from '../../shared/money'
import { formatPercentField } from '../ui/fieldParse'
import { fmtShort } from '../viz'

/** Latest-wins request tags. */
export function createLatest() {
  let seq = 0
  return {
    /** Tag a request that is starting; every earlier tag goes stale. */
    next(): number {
      return ++seq
    },
    /** True while no newer request has started. */
    isCurrent(tag: number): boolean {
      return tag === seq
    },
    /** Make every outstanding reply stale without starting a request. */
    cancel(): void {
      seq++
    },
  }
}

export type EditSnapshot = {
  /** Generation of the newest edit (0 = untouched). */
  readonly gen: number
  /** Newest generation the server has confirmed, or that was deliberately set aside. */
  readonly acked: number
  /** A generation whose save failed; cleared by the next edit or a later ack. */
  readonly failed: number | null
}
export type SaveStatus = 'saved' | 'saving' | 'failed'

export function editGeneration() {
  let snap: EditSnapshot = { gen: 0, acked: 0, failed: null }
  const subs = new Set<() => void>()
  const set = (next: EditSnapshot) => {
    snap = next
    for (const f of subs) f()
  }
  return {
    /** A local edit: returns its generation, which the save that carries it will ack. */
    edit(): number {
      set({ gen: snap.gen + 1, acked: snap.acked, failed: null })
      return snap.gen
    },
    /** The save carrying generation `g` landed. Edits newer than g keep the form dirty. */
    ack(g: number): void {
      if (g <= snap.acked) return
      set({ gen: snap.gen, acked: Math.min(g, snap.gen), failed: snap.failed !== null && snap.failed <= g ? null : snap.failed })
    },
    /** The save carrying generation `g` failed. It only shows while g is still the newest edit. */
    fail(g: number): void {
      if (g <= snap.acked || g !== snap.gen) return
      set({ ...snap, failed: g })
    },
    /** Set every edit aside (flushed to another scenario, or its scenario was deleted): the form is clean. */
    discard(): void {
      if (snap.acked === snap.gen && snap.failed === null) return
      set({ gen: snap.gen, acked: snap.gen, failed: null })
    },
    get dirty(): boolean {
      return snap.gen > snap.acked
    },
    snapshot: (): EditSnapshot => snap,
    subscribe(f: () => void): () => void {
      subs.add(f)
      return () => {
        subs.delete(f)
      }
    },
  }
}
export type EditGeneration = ReturnType<typeof editGeneration>

export function saveStatus(s: EditSnapshot): SaveStatus {
  if (s.gen <= s.acked) return 'saved'
  return s.failed === s.gen ? 'failed' : 'saving'
}

/**
 * A debounce you can flush. schedule() replaces whatever was waiting;
 * flush() runs it now; cancel() drops it.
 */
export function createFlushable(ms: number) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiting: (() => void) | null = null
  const clear = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    waiting = null
  }
  const flush = () => {
    const f = waiting
    clear()
    f?.()
  }
  return {
    schedule(f: () => void): void {
      clear()
      waiting = f
      timer = setTimeout(flush, ms)
    },
    flush,
    cancel: clear,
    get pending(): boolean {
      return waiting !== null
    },
  }
}

export const THRESHOLD_MIN = 50
export const THRESHOLD_MAX = 99

/**
 * The crossing-odds threshold as typed: a whole percent from 50 to 99, with an
 * optional trailing '%'. Anything else — empty, partial ('9' on the way to
 * '95'), decimals, out of range — is null, and null never reaches the server.
 */
export function parseThreshold(text: string): number | null {
  const m = /^\s*(\d{1,2})\s*%?\s*$/.exec(text)
  if (!m) return null
  const n = Number(m[1])
  return n >= THRESHOLD_MIN && n <= THRESHOLD_MAX ? n : null
}

/**
 * What a compare result depends on: the draw mode, the threshold and the
 * ledger's version. A null version means the ledger can change without this
 * tab knowing, so the key is null and never matches — a reveal re-validates.
 */
export function compareKey(draw: string, thresholdPct: number, dataVersion: string | null): string | null {
  return dataVersion === null ? null : `${draw}|${thresholdPct}|${dataVersion}`
}

/**
 * The ledger version a compare result was computed at (Future.tsx reads the
 * live counters). In a tab session: localMode.dataRevision, which moves on
 * every change to the tab's database — writes, data swaps, and a price
 * refresh, which changes what the simulations read (holdings at their latest
 * price) without leaving unsaved work. On the household server: this tab's
 * writes to it, a price refresh included.
 */
export function dataVersionOf(v: { session: true; revision: number } | { session: false; serverWrites: number }): string {
  return v.session ? `t${v.revision}` : `h${v.serverWrites}`
}

/** A percent as the knob's field shows it: '13.5%', '12%' — never rounded away from what was typed. */
const knobPercent = (micro: number) => `${formatPercentField(micro)}%`

/**
 * The mockup's assumption pills: the scenario's knobs as it was last
 * simulated. The return reads to a tenth like the mockup's 'Real return
 * 5.0%'; volatility reads as typed (13.5 stays 13.5, not 14). The purchase
 * shows only when one is modelled — `homeModelled` is false when the Dream
 * Home has no loan options, and the engine then buys nothing.
 */
export function assumptionPills(
  p: Pick<ScenarioParams, 'meanReturnMicro' | 'volMicro' | 'saveBeforeBuyCents' | 'buyEnabled' | 'buyYear' | 'retireYear'>,
  homeModelled: boolean,
): string[] {
  return [
    `Real return ${formatPercentMicro(p.meanReturnMicro, 1)}`,
    `σ ${knobPercent(p.volMicro)}`,
    `Save ${fmtShort(p.saveBeforeBuyCents)}/yr`,
    p.buyEnabled && homeModelled ? `Buy house ${p.buyYear}` : null,
    `Retire ${p.retireYear}`,
  ].filter((x): x is string => x !== null)
}
