import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PortfolioPosition } from '../../shared/invest-api'
import type { MarketSymbols } from './marketSymbols'

// A zero-knowledge session, with a market list that quotes VTI and nothing else.
vi.mock('../local', () => ({ localMode: { active: true, vault: null, identity: null, dirty: false } }))
const market: MarketSymbols = { stocks: new Set(['VTI', 'SPY']), crypto: new Set(['BTC']), quotes: new Map(), index: { rows: [], byKey: new Map() } }
vi.mock('./marketSymbols', async (orig) => ({ ...(await orig<typeof import('./marketSymbols')>()), useMarketSymbols: () => market }))

import HoldingDrawer from './HoldingDrawer'

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const TODAY = '2026-10-20'
const lot = { trade_id: 1, opened_on: '2026-10-20', lt_on: '2027-10-21', qty_micro: 10_000_000, cost_cents: 150_000, invest_account_id: 1, account_name: 'Dev 401k', sheltered: false }
const position = (over: Partial<PortfolioPosition>): PortfolioPosition => ({
  asset_id: 1,
  symbol: 'VFIAX',
  kind: 'stock',
  qty_micro: 10_000_000,
  cost_cents: 150_000,
  price_cents: null,
  priced_on: null,
  value_cents: 150_000,
  unrealized_cents: 0,
  lots: [lot],
  accounts: [{ invest_account_id: 1, name: 'Dev 401k', kind: 'brokerage', qty_micro: 10_000_000, cost_cents: 150_000, value_cents: 150_000 }],
  ...over,
})
const render = (p: PortfolioPosition | null) =>
  renderToStaticMarkup(
    <HoldingDrawer position={p} ret={undefined} portfolioValue={150_000} accounts={[]} rev={1} today={TODAY} marginal={null} onClose={() => {}} onChanged={() => {}} onRecordTrade={() => {}} />,
  )

describe('the holding drawer offers the basket ask only where it can help', () => {
  const link = 'Ask the basket to cover this fund'

  it('for a fund the basket doesn’t quote — unpriced, or priced by hand — with the symbol in route state, not the address', () => {
    for (const p of [position({}), position({ price_cents: 10_000, priced_on: TODAY, price_manual: true })]) {
      const html = render(p)
      expect(text(html)).toContain(link)
      expect(html).toContain('href="#/invest/cover"')
      expect(html).not.toContain('VFIAX"') // the symbol is in no href
    }
  })

  it('not for a quoted basket symbol, a coin, or a holding whose quote is the market’s', () => {
    expect(text(render(position({ symbol: 'VTI', price_cents: 32_000, priced_on: TODAY })))).not.toContain(link)
    expect(text(render(position({ symbol: 'BTC', kind: 'crypto' })))).not.toContain(link)
    expect(text(render(position({ price_cents: 10_000, priced_on: TODAY, price_manual: false })))).not.toContain(link)
  })

  it('renders nothing while closed with nothing kept, and the same drawer either way (hooks in one order)', () => {
    expect(render(null)).toBe('')
    expect(text(render(position({})))).toContain('VFIAX')
  })
})
