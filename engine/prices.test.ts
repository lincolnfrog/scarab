import { describe, expect, it } from 'vitest'
import { addMonthsToMonth } from '../shared/dates'
import type { HistoryPack } from '../shared/series-api'
import type { DbLike } from './db'
import { applyBasket, applyMonthlyHistory, encodeMonthly, needsMonthlyHistory, type MonthClose } from './prices'
import { onBothEngines } from './test/parity'

const TODAY = '2026-09-22'
const START = '2016-09'

/** `n` consecutive months from `first`, each close `cents`. */
const monthsOf = (first: string, n: number, cents: number): MonthClose[] =>
  Array.from({ length: n }, (_, i) => ({ month: addMonthsToMonth(first, i), cents }))

/** A file shaped like the server's: months through `final` are true month ends; September is in progress. */
const PACK: HistoryPack = {
  v: 1,
  start: START,
  final: '2026-08',
  asOf: TODAY,
  builtAt: '2026-09-01T06:00:00.000Z',
  stock: {
    SPY: encodeMonthly(START, monthsOf(START, 121, 50_000)), // the whole file: 2016-09 … 2026-09
    NEWCO: encodeMonthly(START, monthsOf('2025-03', 19, 2_000)), // listed 2025-03
    FRESH: encodeMonthly(START, monthsOf('2026-09', 1, 1_000)), // listed this month: no finished month yet
  },
  crypto: {},
}

/** One brokerage account and one asset bought on `tradedOn`. */
const holding = (symbol: string, tradedOn: string) => (db: DbLike) => {
  db.prepare("INSERT INTO invest_accounts (name, kind, tracking) VALUES ('Taxable', 'brokerage', 'lots')").run()
  db.prepare("INSERT INTO assets (symbol, kind) VALUES (?, 'stock')").run(symbol)
  db.prepare("INSERT INTO trades (invest_account_id, asset_id, traded_on, side, qty_micro, total_cents) VALUES (1, 1, ?, 'buy', 1000000, 1000)").run(tradedOn)
}

/** A refresh from the daily basket with one quote. */
const refresh = (db: DbLike, symbol: string, pricedOn: string, cents: number) =>
  applyBasket(db, { builtAt: `${TODAY}T06:00:00.000Z`, quotes: [{ symbol, kind: 'stock', cents, pricedOn }] })

/** The file's own price for each symbol, so a refresh quote never disagrees with it. */
const NEAR: Record<string, number> = { SPY: 51_000, NEWCO: 2_100, FRESH: 1_050 }

/**
 * A refresh quote dated `pricedOn`, then needsMonthlyHistory before the file,
 * after one apply and after a second, with what each apply wrote.
 */
const lifecycle = (db: DbLike, pricedOn: string, symbol: string) => {
  refresh(db, symbol, pricedOn, NEAR[symbol]!)
  const before = needsMonthlyHistory(db, TODAY)
  const first = applyMonthlyHistory(db, PACK)
  expect(first.errors).toEqual([])
  const afterFirst = needsMonthlyHistory(db, TODAY)
  const second = applyMonthlyHistory(db, PACK).written
  return { before, first: first.written, afterFirst, second, afterSecond: needsMonthlyHistory(db, TODAY) }
}

describe('needsMonthlyHistory stops asking once the file is applied (F23)', () => {
  it('for a stock bought in the month it listed: the file has nothing from before the trade', async () => {
    const { server, browser } = await onBothEngines(holding('NEWCO', '2025-03-10'), (db) => lifecycle(db, TODAY, 'NEWCO'))
    expect(browser).toEqual(server)
    // 2025-03 … 2026-08; the second apply writes nothing, and the asset asks no more.
    expect(server).toEqual({ before: true, first: 18, afterFirst: false, second: 0, afterSecond: false })
  })

  it("for a buy from before the file's first month", async () => {
    const { server, browser } = await onBothEngines(holding('SPY', '2012-05-01'), (db) => lifecycle(db, TODAY, 'SPY'))
    expect(browser).toEqual(server)
    expect(server).toEqual({ before: true, first: 120, afterFirst: false, second: 0, afterSecond: false }) // 2016-09 … 2026-08
  })

  it('for a position pasted as of today, as before', async () => {
    const { server, browser } = await onBothEngines(holding('SPY', TODAY), (db) => lifecycle(db, TODAY, 'SPY'))
    expect(browser).toEqual(server)
    expect(server).toEqual({ before: true, first: 120, afterFirst: false, second: 0, afterSecond: false })
  })

  it("still asks for a position pasted on the 1st, priced by the last trading day's quote from the month before", async () => {
    // A refresh quote is no history, even dated before the first trade's month or at a month's end.
    const { server, browser } = await onBothEngines(holding('SPY', '2026-09-01'), (db) => lifecycle(db, '2026-08-31', 'SPY'))
    expect(browser).toEqual(server)
    expect(server).toEqual({ before: true, first: 119, afterFirst: false, second: 0, afterSecond: false }) // the quote keeps 08-31
  })

  it('keeps asking for a stock that listed this month, until a file has a finished month for it', async () => {
    const { server, browser } = await onBothEngines(holding('FRESH', '2026-09-15'), (db) => ({
      now: lifecycle(db, TODAY, 'FRESH'),
      // Next month's file, where September is finished.
      nextMonth: (() => {
        const pack = { ...PACK, final: '2026-09', asOf: '2026-10-05' }
        const written = applyMonthlyHistory(db, pack).written
        return { written, needed: needsMonthlyHistory(db, '2026-10-05') }
      })(),
    }))
    expect(browser).toEqual(server)
    expect(server.now).toEqual({ before: true, first: 0, afterFirst: true, second: 0, afterSecond: true })
    expect(server.nextMonth).toEqual({ written: 1, needed: false })
  })

  it("counts a household's own month-end close from the trade's month on, but not one in the month in progress", async () => {
    const { server, browser } = await onBothEngines(holding('SPY', '2026-03-10'), (db) => {
      const put = db.prepare('INSERT INTO prices (asset_id, priced_on, close_cents) VALUES (1, ?, 50000)')
      put.run('2026-09-30') // the month in progress: its end hasn't come
      const inProgress = needsMonthlyHistory(db, TODAY)
      put.run('2026-06-29') // not a month's end
      const midMonth = needsMonthlyHistory(db, TODAY)
      put.run('2026-06-30')
      return { inProgress, midMonth, monthEnd: needsMonthlyHistory(db, TODAY) }
    })
    expect(browser).toEqual(server)
    expect(server).toEqual({ inProgress: true, midMonth: true, monthEnd: false })
  })
})
