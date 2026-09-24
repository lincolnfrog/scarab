/**
 * Every call the server makes to an outside source — Yahoo, CoinGecko, the
 * NASDAQ Trader symbol directory, Freddie Mac's PMMS — carries a deadline.
 * Without one a stalled connection waits on undici's own limits (300 s for
 * headers, 300 s between body chunks, so longer still for a reply that
 * trickles), and whatever awaits it waits too: the basket build holds its
 * single in-flight promise, so GET /api/basket on an empty basket, POST
 * /api/basket/rebuild and the tab's symbol search all hang on one stuck socket.
 *
 * The signal covers the whole exchange: past the deadline the fetch — or the
 * read of its body still in progress — rejects with a TimeoutError, which each
 * caller already records as that source's error before carrying on with what
 * it has.
 */
export const UPSTREAM_TIMEOUT_MS = 30_000

/** A fresh deadline for one upstream call (a signal can't be shared: its clock starts when it is made). */
export const upstreamSignal = (): AbortSignal => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
