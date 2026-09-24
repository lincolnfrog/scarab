/**
 * Capital-gain netting, shared by the tax engine and the screens (the
 * Investments tax picture nets its own realized totals the same way Taxes
 * does). Pure integer-cents math, no engine imports, so the household bundle
 * can use it without pulling the engine in.
 */

/** The most of a net capital loss that offsets ordinary income in one year (§1211(b)). */
export const CAP_LOSS_LIMIT_CENTS = 3_000_00

export type NettedGains = {
  netStCents: number
  netLtCents: number
  /** Capital loss applied against ordinary income (at most $3,000). */
  capLossUsedCents: number
  /** Net capital loss left over for next year. */
  capLossCarryCents: number
}

/** Capital-gain netting per §1211/1222: ST and LT net separately, then a net
 *  loss on one side offsets the other; an overall net loss offsets up to
 *  $3,000 of ordinary income, the rest carries forward. */
export function netCapitalGains(stCents: number, ltCents: number): NettedGains {
  let st = stCents
  let lt = ltCents
  if (st < 0 && lt > 0) { lt += st; st = 0; if (lt < 0) { st = lt; lt = 0 } }
  else if (lt < 0 && st > 0) { st += lt; lt = 0; if (st < 0) { lt = st; st = 0 } }
  const netTotal = st + lt
  let capLossUsed = 0
  let capLossCarry = 0
  if (netTotal < 0) {
    capLossUsed = Math.min(CAP_LOSS_LIMIT_CENTS, -netTotal)
    capLossCarry = -netTotal - capLossUsed
    st = 0
    lt = 0
  }
  return { netStCents: st, netLtCents: lt, capLossUsedCents: capLossUsed, capLossCarryCents: capLossCarry }
}
