/** Simple moving average over a daily series; null until the window fills. */
export function sma(values: number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!
    if (i >= window) sum -= values[i - window]!
    if (i >= window - 1) out[i] = Math.round(sum / window)
  }
  return out
}

/**
 * Gross sale needed to net a target amount after long-term capital-gains tax,
 * given the basis share of proceeds and a capital-loss carryforward that
 * shields gains dollar-for-dollar. Solves X − tax(X) = net where
 * tax(X) = max(0, X·(1−basis) − carryforward) · rate.
 */
export function grossSaleForNet(
  netCents: number,
  basisPctMicro: number,
  rateMicro: number,
  carryforwardCents: number,
): { grossCents: number; taxCents: number } {
  if (netCents <= 0) return { grossCents: 0, taxCents: 0 }
  const b = basisPctMicro / 1_000_000
  const r = rateMicro / 1_000_000
  if (netCents * (1 - b) <= carryforwardCents || r === 0) return { grossCents: netCents, taxCents: 0 }
  const gross = Math.round((netCents - carryforwardCents * r) / (1 - (1 - b) * r))
  const tax = Math.max(0, Math.round((gross * (1 - b) - carryforwardCents) * r))
  return { grossCents: gross, taxCents: tax }
}
