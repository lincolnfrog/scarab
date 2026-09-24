import { describe, expect, it } from 'vitest'
import {
  accountsLine,
  formPriceCents,
  formTotalCents,
  grossCents,
  mulDivRound,
  priceFromTotal,
  qtyParam,
  totalFromPrice,
  tradeBody,
  type TradeForm,
} from './tradeMath'

const M = 1_000_000
const TODAY = '2026-09-22'
const form = (over: Partial<TradeForm> = {}): TradeForm => ({
  accountId: 3,
  side: 'buy',
  symbol: ' vti ',
  assetKind: 'stock',
  qtyMicro: 10 * M,
  mode: 'price',
  priceCents: 248_17,
  totalCents: null,
  feesCents: null,
  tradedOn: '2026-09-21',
  lot: 'fifo',
  acquiredOn: '',
  basisCents: null,
  ...over,
})

describe('price or total, in integer math', () => {
  it('shares × price rounds to the cent, exactly even past 2^53', () => {
    expect(grossCents(10 * M, 248_17)).toBe(2_481_70)
    expect(grossCents(333_333, 100)).toBe(33) // 0.333333 sh × $1.00
    expect(grossCents(1_500_000, 1)).toBe(2) // 1.5¢ rounds half up
    // 5,000,000 shares at $9,999.99: the product is past 2^53.
    expect(mulDivRound(5_000_000 * M, 999_999, M)).toBe(4_999_995_000_000)
    expect(mulDivRound(3, 1, 2)).toBe(2)
  })

  it('fees add to a buy and come out of a sale; a total implies the price back', () => {
    expect(totalFromPrice('buy', 10 * M, 100_00, 4_95)).toBe(1_004_95)
    expect(totalFromPrice('sell', 10 * M, 100_00, 4_95)).toBe(995_05)
    expect(priceFromTotal('buy', 10 * M, 1_004_95, 4_95)).toBe(100_00)
    expect(priceFromTotal('sell', 10 * M, 995_05, 4_95)).toBe(100_00)
    expect(priceFromTotal('buy', 3 * M, 100_00, 0)).toBe(33_33)
    expect(priceFromTotal('buy', 0, 100, 0)).toBeNull()
    expect(priceFromTotal('buy', M, 100, 200)).toBeNull()
  })

  it('the form stands for one total and one price, whichever is typed', () => {
    expect(formTotalCents(form())).toBe(2_481_70)
    expect(formPriceCents(form())).toBe(248_17)
    expect(formTotalCents(form({ mode: 'total', totalCents: 2_490_00, feesCents: 8_30 }))).toBe(2_490_00)
    expect(formPriceCents(form({ mode: 'total', totalCents: 2_490_00, feesCents: 8_30 }))).toBe(248_17)
    expect(formTotalCents(form({ priceCents: null }))).toBeNull()
    expect(formTotalCents(form({ qtyMicro: null }))).toBeNull()
  })
})

describe('form → request', () => {
  it('a buy: trimmed, upper-cased symbol; qty as plain text; the total fees included', () => {
    expect(tradeBody(form({ qtyMicro: 1_250_500_000, feesCents: 1_00 }), TODAY)).toEqual({
      body: { investAccountId: 3, symbol: 'VTI', assetKind: 'stock', side: 'buy', tradedOn: '2026-09-21', qty: '1250.5', totalCents: grossCents(1_250_500_000, 248_17) + 1_00 },
    })
    expect(qtyParam(1_234_567_891)).toBe('1234.567891')
  })

  it('a sale names its lot, or carries an explicit basis', () => {
    expect(tradeBody(form({ side: 'sell', lot: 41 }), TODAY)).toMatchObject({ body: { side: 'sell', soldLotTradeId: 41 } })
    const fifo = tradeBody(form({ side: 'sell' }), TODAY)
    expect('body' in fifo && 'soldLotTradeId' in fifo.body).toBe(false)
    expect(tradeBody(form({ side: 'sell', lot: 'manual', acquiredOn: '2019-03-15', basisCents: 900_00 }), TODAY)).toMatchObject({
      body: { acquiredOn: '2019-03-15', basisCents: 900_00 },
    })
    // Not filled in yet: say nothing.
    expect(tradeBody(form({ side: 'sell', lot: 'manual', acquiredOn: '2019-03-15' }), TODAY)).toEqual({ error: null })
  })

  it('stays quiet while incomplete and names what to fix once it is wrong', () => {
    expect(tradeBody(form({ symbol: '  ' }), TODAY)).toEqual({ error: null })
    expect(tradeBody(form({ qtyMicro: null }), TODAY)).toEqual({ error: null })
    expect(tradeBody(form({ mode: 'total' }), TODAY)).toEqual({ error: null })
    expect(tradeBody(form({ tradedOn: '2026-09-23' }), TODAY)).toEqual({ error: expect.stringMatching(/once it has happened/) })
    expect(tradeBody(form({ side: 'sell', priceCents: 1, feesCents: 5_00 }), TODAY)).toEqual({ error: expect.stringMatching(/fees are more/) })
    expect(tradeBody(form({ side: 'sell', lot: 'manual', acquiredOn: '2026-09-22', basisCents: 1 }), TODAY)).toEqual({
      error: expect.stringMatching(/acquired after this sale/),
    })
  })
})

describe('the header account line', () => {
  it('counts repeated names and keeps first-seen order', () => {
    expect(accountsLine(['Schwab', 'Fidelity 401(k)', 'Fidelity 401(k)', 'Coinbase'])).toBe('Schwab · Fidelity 401(k) ×2 · Coinbase')
    expect(accountsLine([])).toBe('')
  })
})
