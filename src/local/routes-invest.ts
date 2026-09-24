import {
  createInvestAccount,
  createOpeningPositions,
  createTrade,
  deleteBalanceSnapshot,
  deleteInvestAccount,
  deleteTrade,
  getCheckin,
  getInvestAccount,
  getPortfolio,
  getUnvested,
  listAssets,
  listBalanceSnapshots,
  listInvestAccounts,
  listInvestOwners,
  listTrades,
  putBalanceSnapshot,
  putUnvested,
  setManualPrice,
  updateInvestAccount,
  updateTrade,
  vestUnvested,
} from '../../engine/invest'
import { getRealizedReport, previewTrade } from '../../engine/tax'
import { r, type LocalRoute } from './table'

/**
 * Investment accounts, trades, the portfolio and unvested grants — the
 * in-tab mirror of api2.ts's investment half and of api9.ts. Every handler
 * calls the same engine function its server route does.
 */
export const INVEST: LocalRoute[] = [
  r('GET', '/invest/accounts', (c) => listInvestAccounts(c.db)),
  r('GET', '/invest/accounts/:id', (c) => getInvestAccount(c.db, Number(c.params.id), c.today)),
  r('GET', '/invest/owners', (c) => listInvestOwners(c.db)),
  r('GET', '/invest/assets', (c) => listAssets(c.db)),
  r('GET', '/invest/checkin', (c) => getCheckin(c.db, c.today)),
  r('POST', '/invest/accounts', (c) => createInvestAccount(c.db, c.body)),
  r('PATCH', '/invest/accounts/:id', (c) => updateInvestAccount(c.db, Number(c.params.id), c.body)),
  r('DELETE', '/invest/accounts/:id', (c) => deleteInvestAccount(c.db, Number(c.params.id))),
  r('PUT', '/invest/balances', (c) => putBalanceSnapshot(c.db, c.body, c.today)),
  r('GET', '/invest/balances', (c) => listBalanceSnapshots(c.db, { accountId: c.query.get('accountId') })),
  r('DELETE', '/invest/balances/:accountId/:date', (c) => deleteBalanceSnapshot(c.db, Number(c.params.accountId), c.params.date!)),

  r('POST', '/trades', (c) => createTrade(c.db, c.body, c.today)),
  r('POST', '/trades/opening', (c) => createOpeningPositions(c.db, c.body, c.today)),
  r('GET', '/trades', (c) =>
    listTrades(c.db, { accountId: c.query.get('accountId'), symbol: c.query.get('symbol'), year: c.query.get('year') }),
  ),
  r('PATCH', '/trades/:id', (c) => updateTrade(c.db, Number(c.params.id), c.body, c.today)),
  r('DELETE', '/trades/:id', (c) => deleteTrade(c.db, Number(c.params.id))),
  // A preview computes and stores nothing: it never dirties the tab.
  r('POST', '/trades/preview', (c) => previewTrade(c.db, c.body, c.today), 'never'),
  r('GET', '/portfolio', (c) => getPortfolio(c.db, c.today)),
  r('GET', '/invest/realized', (c) => getRealizedReport(c.db, c.query.get('year'), c.today)),

  // A hand-entered price is the household's own fact, not a refetchable
  // quote: it must persist, so it dirties the tab like any edit.
  r('POST', '/prices/manual', (c) => setManualPrice(c.db, c.body, c.today)),

  r('GET', '/unvested', (c) => getUnvested(c.db)),
  r('PUT', '/unvested', (c) => putUnvested(c.db, c.body, c.today)),
  r('POST', '/unvested/vest', (c) => vestUnvested(c.db, c.body, c.today)),
]
