import { describe, expect, it } from 'vitest'
import type { Dump } from '../../../engine/snapshot'
import { compareCounts, countRows, deltaText, pinLabel, policyText, sameCounts } from './versions'

const dump = (tables: Record<string, unknown[]>): Dump => ({ scarab: true, schemaVersion: 20, exportedAt: '2026-09-23T00:00:00Z', tables: tables as Dump['tables'] })

describe('versions: counting and comparing what a snapshot holds', () => {
  it('counts rows per table, never the price basket’s app_meta keys', () => {
    const d = dump({
      app_meta: [{ key: 'digest:max', value: '1' }, { key: 'basket:built_at', value: 'x' }, { key: 'BASKET:history:v1', value: 'x' }],
      accounts: [{ id: 1 }, { id: 2 }],
      trades: [],
      junk: 'not rows' as unknown as unknown[],
    })
    expect(countRows(d)).toEqual({ app_meta: 1, accounts: 2, trades: 0 })
  })

  it('compares then with now: tables with rows on either side, in the snapshot’s order, then any only now has', () => {
    const rows = compareCounts({ app_meta: 1, accounts: 2, trades: 0, prices: 5 }, { accounts: 3, trades: 0, prices: 5, scenarios: 1, app_meta: 1 })
    expect(rows.map((r) => [r.table, r.label, r.then, r.now, r.delta])).toEqual([
      ['app_meta', 'Settings and marks', 1, 1, 0],
      ['accounts', 'Cash accounts', 2, 3, -1],
      ['prices', 'Prices', 5, 5, 0],
      ['scenarios', 'Scenarios', 0, 1, -1],
    ])
    expect(sameCounts(rows)).toBe(false)
    expect(sameCounts(compareCounts({ accounts: 2 }, { accounts: 2 }))).toBe(true)
    // Nothing to compare with (the front door): now and the change are null, and an unknown table shows its own name.
    expect(compareCounts({ accounts: 2, mystery: 1 }, null)).toEqual([
      { table: 'accounts', label: 'Cash accounts', then: 2, now: null, delta: null },
      { table: 'mystery', label: 'mystery', then: 1, now: null, delta: null },
    ])
  })

  it('says a change without colouring it, and why a version is kept', () => {
    expect([deltaText(3), deltaText(-2), deltaText(0), deltaText(null)]).toEqual(['+3', '−2', '', ''])
    expect(pinLabel('pre-upgrade')).toBe('kept from before an upgrade')
    expect(pinLabel('pre-restore')).toBe('kept from before a restore')
    expect(pinLabel(null)).toBeNull()
    expect(pinLabel('other')).toBe('kept (other)')
    expect(policyText({ keepLast: 20, dailyDays: 30, byteCap: 64 * 1024 * 1024 })).toBe(
      'The server keeps the last 20 versions, the last one of each day for 30 days, and versions kept from before an upgrade or a restore — up to 64 MB in all.',
    )
  })
})
