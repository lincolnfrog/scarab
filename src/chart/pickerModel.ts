import { MAX_SERIES_IDS, type SeriesGroup, type SeriesMeta } from '../../shared/series-api'

/**
 * The series picker's list (plan §C7): the catalog filtered by a search,
 * grouped in catalog order. A selected entry can always be removed; an
 * unavailable one is disabled with the catalog's reason; once the selection
 * is full, every other entry is disabled saying why.
 */

export type PickItem = { meta: SeriesMeta; selected: boolean; disabled: boolean; why: string | null }
export type PickGroup = { group: SeriesGroup; items: PickItem[] }

/** Lower-cased, accent-free text to match against. */
const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Every word of the query appears somewhere in the entry's label, group or id ('vti val', 'spy', '401'). */
export function matches(meta: SeriesMeta, query: string): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = fold(`${meta.label} ${meta.group} ${meta.id}`)
  return words.every((w) => hay.includes(w))
}

export function pickerGroups(entries: readonly SeriesMeta[], query: string, selected: readonly string[], max = MAX_SERIES_IDS): PickGroup[] {
  const sel = new Set(selected)
  const full = sel.size >= max
  const groups: PickGroup[] = []
  for (const meta of entries) {
    if (!matches(meta, query)) continue
    const isSel = sel.has(meta.id)
    const why = isSel ? null : !meta.available ? (meta.reason ?? 'Not available yet') : full ? `Up to ${max} series — remove one first` : null
    const item: PickItem = { meta, selected: isSel, disabled: why !== null, why }
    const g = groups.find((x) => x.group === meta.group)
    if (g) g.items.push(item)
    else groups.push({ group: meta.group, items: [item] })
  }
  return groups
}

export const flatItems = (groups: readonly PickGroup[]): PickItem[] => groups.flatMap((g) => g.items)

/**
 * The next active row for a key, or undefined when the key isn't a list key.
 * ↑/↓ step and wrap; PageUp/PageDown jump 8 without wrapping; Home/End (with
 * Ctrl or ⌘, since plain Home/End belong to the search box's caret) go to the
 * ends. Disabled rows can be the active row, so their reason is read out.
 */
export function pickStep(key: string, cur: number, n: number, mod = false): number | undefined {
  if (n === 0) return undefined
  const at = cur < 0 || cur >= n ? -1 : cur
  switch (key) {
    case 'ArrowDown':
      return at < 0 ? 0 : (at + 1) % n
    case 'ArrowUp':
      return at < 0 ? n - 1 : (at - 1 + n) % n
    case 'PageDown':
      return Math.min(n - 1, Math.max(0, at) + 8)
    case 'PageUp':
      return Math.max(0, at - 8)
    case 'Home':
      return mod ? 0 : undefined
    case 'End':
      return mod ? n - 1 : undefined
    default:
      return undefined
  }
}

/** The months an entry covers, for the picker's second line: 'Jun 2024 – Sep 2026'. */
export function coverageText(meta: Pick<SeriesMeta, 'firstMonth' | 'lastMonth'>): string {
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const m = (s: string) => `${NAMES[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`
  if (!meta.firstMonth || !meta.lastMonth) return ''
  return meta.firstMonth === meta.lastMonth ? m(meta.firstMonth) : `${m(meta.firstMonth)} – ${m(meta.lastMonth)}`
}
