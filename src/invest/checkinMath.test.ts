import { describe, expect, it } from 'vitest'
import type { CheckinItem } from '../../shared/invest-api'
import { checkinRequest, checkinSummary, checkinWhat, checkinWrites, rowKey } from './checkinMath'

const item = (kind: CheckinItem['kind'], id: number, name: string, last: CheckinItem['last'] = null): CheckinItem => ({
  kind,
  id,
  name,
  detail: null,
  owner: null,
  last,
  derived_cents: null,
  uncounted_cents: 0,
})

const k401 = item('balance', 3, '401(k)', { on: '2026-06-30', cents: 44_500_00 })
const cash = item('cash', 1, 'Schwab', { on: '2026-08-31', cents: 2_000_00 })
const house = item('property', 1, 'House', { on: '2026-07-15', cents: 850_000_00 })
const mortgage = item('liability', 1, 'Mortgage', { on: '2026-08-01', cents: 635_000_00 })
const fresh = item('balance', 9, 'New HSA')
const items = [k401, cash, house, mortgage, fresh]

describe('which rows a check-in saves', () => {
  it('only rows with an amount; the sitting’s date unless a row has its own', () => {
    const w = checkinWrites(items, { [rowKey(k401)]: { cents: 46_100_00, on: null }, [rowKey(house)]: { cents: null, on: '2026-09-01' }, [rowKey(mortgage)]: { cents: 633_900_00, on: '2026-09-01' } }, '2026-09-22')
    expect(w.map((x) => [x.item.name, x.on, x.cents])).toEqual([
      ['401(k)', '2026-09-22', 46_100_00],
      ['Mortgage', '2026-09-01', 633_900_00],
    ])
  })

  it('skips an amount that repeats what is recorded for that very day; the same amount on a later day is a check-in', () => {
    expect(checkinWrites([k401], { [rowKey(k401)]: { cents: 44_500_00, on: '2026-06-30' } }, '2026-09-22')).toEqual([])
    expect(checkinWrites([k401], { [rowKey(k401)]: { cents: 44_500_00, on: null } }, '2026-09-22')).toEqual([{ item: k401, on: '2026-09-22', cents: 44_500_00 }])
  })

  it('a row with nothing recorded yet saves whatever is typed (a negative cash balance too)', () => {
    expect(checkinWrites([fresh, cash], { [rowKey(fresh)]: { cents: 0, on: null }, [rowKey(cash)]: { cents: -250_00, on: null } }, '2026-09-22')).toEqual([
      { item: fresh, on: '2026-09-22', cents: 0 },
      { item: cash, on: '2026-09-22', cents: -250_00 },
    ])
  })
})

describe('each number saves through its own route', () => {
  it('accounts and cash → invest balances; homes → valuation; loans → liability balance', () => {
    expect(checkinRequest({ item: k401, on: '2026-09-22', cents: 1 })).toEqual({ path: '/api/invest/balances', body: { investAccountId: 3, balancedOn: '2026-09-22', balanceCents: 1 } })
    expect(checkinRequest({ item: cash, on: '2026-09-22', cents: -5 })).toEqual({ path: '/api/invest/balances', body: { investAccountId: 1, balancedOn: '2026-09-22', balanceCents: -5 } })
    expect(checkinRequest({ item: house, on: '2026-09-01', cents: 2 })).toEqual({ path: '/api/properties/1/valuation', body: { valuedOn: '2026-09-01', valueCents: 2 } })
    expect(checkinRequest({ item: mortgage, on: '2026-09-01', cents: 3 })).toEqual({ path: '/api/liabilities/1/balance', body: { balancedOn: '2026-09-01', balanceCents: 3 } })
  })
})

describe('one summary for the sitting', () => {
  const w = (i: CheckinItem) => ({ item: i, on: '2026-09-22', cents: 1 })
  it('says what was saved, in words', () => {
    expect(checkinWhat([w(k401)])).toBe('a balance')
    expect(checkinWhat([w(k401), w(fresh), w(house)])).toBe('2 balances and a home value')
    expect(checkinWhat([w(k401), w(cash), w(house), w(mortgage)])).toBe('a balance, a cash balance, a home value and a loan balance')
    expect(checkinSummary([w(k401), w(mortgage)], [])).toEqual({ ok: true, text: 'Checked in a balance and a loan balance · net worth updated' })
  })
  it('names what did not save, and why', () => {
    expect(checkinSummary([w(k401)], [{ write: w(house), message: 'no such property' }])).toEqual({
      ok: false,
      text: 'Saved a balance — 1 didn’t save',
      detail: 'House: no such property',
    })
    expect(checkinSummary([], [{ write: w(house), message: 'x' }])).toMatchObject({ ok: false, text: 'Couldn’t save the check-in' })
  })
})
