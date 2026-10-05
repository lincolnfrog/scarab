import { describe, expect, it } from 'vitest'
import { openDb } from '../server/migrations'
import type { DbLike } from './db'
import { getDigest, vestsDue } from './digest'
import { createInvestAccount, getUnvested, putUnvested, vestUnvested } from './invest'

describe('digest: vests to record', () => {
  it('lists a scheduled vest once its day has passed, until Vest… records it', () => {
    const db = openDb(':memory:') as unknown as DbLike
    const plan = createInvestAccount(db, { name: 'Morgan Stanley', kind: 'brokerage', tracking: 'lots', stockPlan: true }).id as number
    putUnvested(db, { investAccountId: plan, symbol: 'GOOG', qty: '200', nextVestOn: '2026-09-25', vestEveryMonths: 1, vestQty: '16.332' }, '2026-09-01')

    expect(vestsDue(db, '2026-09-24')).toEqual([]) // not yet
    const due = vestsDue(db, '2026-10-05')
    expect(due).toEqual([{ grantId: expect.any(Number), accountId: plan, accountName: 'Morgan Stanley', symbol: 'GOOG', dueOn: '2026-09-25', qtyMicro: 16_332_000 }])
    expect(getDigest(db, 'me@example.com', '2026-10-05')).toMatchObject({ vestsDue: due, notable: true })

    vestUnvested(db, { investAccountId: plan, grantId: due[0]!.grantId, symbol: 'GOOG', qty: '16.332', tradedOn: '2026-09-25', totalCents: 560_000, withheldQty: '5.5' }, '2026-10-05')
    expect(vestsDue(db, '2026-10-05')).toEqual([]) // recorded: next one is 10/25
    expect(getUnvested(db).rows[0]!.next_vest_on).toBe('2026-10-25')
    expect(vestsDue(db, '2026-10-26')[0]!.dueOn).toBe('2026-10-25')
  })
})
