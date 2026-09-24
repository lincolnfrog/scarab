import { describe, expect, it } from 'vitest'
import type { SeriesMeta } from '../../shared/series-api'
import { coverageText, flatItems, matches, pickerGroups, pickStep } from './pickerModel'

const meta = (id: string, label: string, group: SeriesMeta['group'], available = true, reason?: string): SeriesMeta => ({
  id,
  label,
  group,
  unit: 'cents',
  kind: 'level',
  firstMonth: '2024-06',
  lastMonth: '2026-09',
  available,
  ...(reason ? { reason } : {}),
})

const catalog = [
  meta('nw:total', 'Net worth', 'Net worth'),
  meta('nw:crypto', 'Crypto', 'Net worth', false, 'No crypto holdings'),
  meta('inv:all:value', 'Portfolio · value', 'Accounts'),
  meta('inv:3:value', 'Fidelity 401(k) · value', 'Accounts'),
  meta('pos:1:value', 'VTI · value', 'Holdings'),
  meta('bench:SPY', 'S&P 500 (SPY)', 'Benchmarks'),
  meta('nw:cash', 'Cash', 'Net worth'),
]

describe('matches', () => {
  it('needs every word somewhere in the label, group or id, ignoring case and accents', () => {
    expect(matches(catalog[4]!, 'vti val')).toBe(true)
    expect(matches(catalog[4]!, 'VTI cost')).toBe(false)
    expect(matches(catalog[3]!, '401')).toBe(true)
    expect(matches(catalog[5]!, 'benchmarks spy')).toBe(true)
    expect(matches(catalog[5]!, 's&p')).toBe(true)
    expect(matches(meta('x', 'Café fund', 'Goal'), 'cafe')).toBe(true)
    expect(matches(catalog[0]!, '   ')).toBe(true)
  })
})

describe('pickerGroups', () => {
  it('groups in catalog order (first appearance), keeping entry order', () => {
    const g = pickerGroups(catalog, '', [])
    expect(g.map((x) => x.group)).toEqual(['Net worth', 'Accounts', 'Holdings', 'Benchmarks'])
    expect(g[0]!.items.map((i) => i.meta.id)).toEqual(['nw:total', 'nw:crypto', 'nw:cash'])
  })

  it('disables unavailable entries with their reason', () => {
    const crypto = flatItems(pickerGroups(catalog, 'crypto', []))[0]!
    expect(crypto.disabled).toBe(true)
    expect(crypto.why).toBe('No crypto holdings')
  })

  it('once full, disables everything not selected, but a selected entry can always be removed', () => {
    const sel = ['nw:total', 'nw:cash']
    const items = flatItems(pickerGroups(catalog, '', sel, 2))
    const total = items.find((i) => i.meta.id === 'nw:total')!
    expect(total.selected && !total.disabled).toBe(true)
    const spy = items.find((i) => i.meta.id === 'bench:SPY')!
    expect(spy.disabled).toBe(true)
    expect(spy.why).toBe('Up to 2 series — remove one first')
    // a selected entry that has since become unavailable is still removable
    const gone = flatItems(pickerGroups(catalog, 'crypto', ['nw:crypto']))[0]!
    expect(gone.selected && !gone.disabled).toBe(true)
  })

  it('drops groups with no match', () => {
    expect(pickerGroups(catalog, 'spy', []).map((g) => g.group)).toEqual(['Benchmarks'])
    expect(pickerGroups(catalog, 'nothing like this', [])).toEqual([])
  })
})

describe('pickStep', () => {
  it('wraps on arrows, clamps on pages, and leaves plain Home/End to the text box', () => {
    expect(pickStep('ArrowDown', -1, 5)).toBe(0)
    expect(pickStep('ArrowUp', -1, 5)).toBe(4)
    expect(pickStep('ArrowDown', 4, 5)).toBe(0)
    expect(pickStep('ArrowUp', 0, 5)).toBe(4)
    expect(pickStep('PageDown', 1, 20)).toBe(9)
    expect(pickStep('PageDown', 15, 20)).toBe(19)
    expect(pickStep('PageUp', 3, 20)).toBe(0)
    expect(pickStep('Home', 3, 20)).toBeUndefined()
    expect(pickStep('End', 3, 20, true)).toBe(19)
    expect(pickStep('Enter', 3, 20)).toBeUndefined()
    expect(pickStep('ArrowDown', 0, 0)).toBeUndefined()
    expect(pickStep('ArrowDown', 9, 3)).toBe(0) // a stale index after the list shrank
  })
})

describe('coverageText', () => {
  it('names the months an entry covers', () => {
    expect(coverageText({ firstMonth: '2024-06', lastMonth: '2026-09' })).toBe('Jun 2024 – Sep 2026')
    expect(coverageText({ firstMonth: '2026-09', lastMonth: '2026-09' })).toBe('Sep 2026')
    expect(coverageText({ firstMonth: null, lastMonth: null })).toBe('')
  })
})
