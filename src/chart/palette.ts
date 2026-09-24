/**
 * The chart series palette, by slot. The colours themselves live only in
 * styles.css (--s1 … --s6, CVD-validated on --card in this fixed order);
 * charts name a slot and never repeat a hex, so a token change reaches every
 * chart. Gold (--gold) and up/down are not series colours — see CLAUDE.md.
 */

export type Slot = 1 | 2 | 3 | 4 | 5 | 6

export const SLOT_VAR: Record<Slot, string> = {
  1: 'var(--s1)',
  2: 'var(--s2)',
  3: 'var(--s3)',
  4: 'var(--s4)',
  5: 'var(--s5)',
  6: 'var(--s6)',
}

/** Past six series a line becomes context in ink-3, never a recycled slot colour. */
export const CONTEXT_VAR = 'var(--ink-3)'

/** A slot's colour; `null` (no slot left) is the context ink. */
export function slotColor(slot: Slot | null): string {
  return slot === null ? CONTEXT_VAR : SLOT_VAR[slot]
}

/**
 * A translucent wash of a slot — bands, legend swatches for them, hover
 * columns. `pct` is the opacity in percent (0–100). color-mix against
 * transparent keeps the hue exact: `slotTint(2, 16)` paints --s2 at 16% alpha.
 */
export function slotTint(slot: Slot | null, pct: number): string {
  const p = Math.min(100, Math.max(0, pct))
  return `color-mix(in srgb, ${slotColor(slot)} ${p}%, transparent)`
}

/**
 * Colours for a set of scenarios, fixed by identity rather than list position:
 * the baseline is always s1; the rest take s2…s6 in order of id (creation
 * order). Renaming or reordering never repaints a scenario; deleting one
 * shifts only those created after it. A seventh and later scenario gets
 * `null` and draws as a context line.
 */
export function scenarioSlots(runs: { id: number }[], baselineId: number): Map<number, Slot | null> {
  const slots = new Map<number, Slot | null>()
  const others = [...new Set(runs.map((r) => r.id))].filter((id) => id !== baselineId).sort((a, b) => a - b)
  if (runs.some((r) => r.id === baselineId)) slots.set(baselineId, 1)
  others.forEach((id, i) => slots.set(id, i < 5 ? ((i + 2) as Slot) : null))
  return slots
}

/* ---------------- non-series colours (names, never hex) ---------------- */

/** The goal fund, its target and projection — the only series allowed gold (CLAUDE.md). */
export const GOAL_VAR = 'var(--gold)'
/** Gains / losses only: a return bar, an "Unrealized +$X" figure — never a series colour. */
export const UP_VAR = 'var(--up)'
export const DOWN_VAR = 'var(--down)'
/** Neutral glyphs on a chart (buy/sell markers, event ticks): ink-2, so they never read as a gain or loss. */
export const MARK_VAR = 'var(--ink-2)'

/** Gain or loss colour for a signed amount; zero is neutral ink. */
export function signColor(v: number): string {
  return v > 0 ? UP_VAR : v < 0 ? DOWN_VAR : MARK_VAR
}

/** The slot for the i-th series of a chart (0-based): s1…s6, then null (a context line). */
export function slotAt(i: number): Slot | null {
  return Number.isInteger(i) && i >= 0 && i < 6 ? ((i + 1) as Slot) : null
}

/**
 * Colours pinned to series ids for as long as the caller keeps the map
 * (Compare keeps it for the session): an id that already has a slot keeps
 * it; a new id takes the lowest free slot; with all six taken it gets null.
 * Ids no longer shown release their slots only when `release` is set, so
 * toggling a series off and on never repaints it. `remember` (every slot an
 * id has ever held) lets an id removed and added back take its old colour
 * again when that slot is still free.
 */
export function pinSlots(
  ids: string[],
  pinned: ReadonlyMap<string, Slot>,
  o: { release?: boolean; remember?: ReadonlyMap<string, Slot> } = {},
): Map<string, Slot> {
  const next = new Map<string, Slot>()
  const want = new Set(ids)
  for (const [id, slot] of pinned) if (!o.release || want.has(id)) next.set(id, slot)
  const used = new Set(next.values())
  for (const id of ids) {
    if (next.has(id)) continue
    const old = o.remember?.get(id)
    const free = old !== undefined && !used.has(old) ? old : ([1, 2, 3, 4, 5, 6] as Slot[]).find((s) => !used.has(s))
    if (free === undefined) continue
    next.set(id, free)
    used.add(free)
  }
  return next
}
