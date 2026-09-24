/**
 * The pure half of StackChart (net-worth composition, plan §C10): a
 * diverging stack, where each month's positive parts pile up from $0 in a
 * fixed order and its negative parts (debts, an overdrawn account) hang down
 * from $0. Integer cents in, integer cents out — node-tested.
 */
import { alignAsOf } from '../../shared/series'
import type { NetWorthPoint } from '../cards/cardModel'
import type { Slot } from './palette'

export type Stacked = {
  /** Per layer, per point: the layer's lower and upper edge (lo ≤ hi; equal when the layer is 0 there). */
  lo: number[][]
  hi: number[][]
  /** Per point: the top of the positive pile and the bottom of the negative one. */
  top: number[]
  bottom: number[]
}

/**
 * Stack `layers` (each an array of values, one per point) in order: at each
 * point a positive value sits on the positives below it, a negative value
 * hangs under the negatives above it, so `top + bottom` is the sum of the
 * layers at that point (the net line). Missing values (a shorter layer, NaN)
 * count as 0.
 */
export function divergingStack(layers: readonly (readonly number[])[]): Stacked {
  const n = Math.max(0, ...layers.map((l) => l.length))
  const top = new Array<number>(n).fill(0)
  const bottom = new Array<number>(n).fill(0)
  const lo: number[][] = []
  const hi: number[][] = []
  for (const layer of layers) {
    const L = new Array<number>(n)
    const H = new Array<number>(n)
    for (let k = 0; k < n; k++) {
      const raw = layer[k]
      const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0
      if (v >= 0) {
        L[k] = top[k]!
        H[k] = top[k]! + v
        top[k] = H[k]!
      } else {
        H[k] = bottom[k]!
        L[k] = bottom[k]! + v
        bottom[k] = L[k]!
      }
    }
    lo.push(L)
    hi.push(H)
  }
  return { lo, hi, top, bottom }
}

/**
 * Stack layers that may not share dates onto one timeline: the union of
 * their dates, each read as of each date (its last reading at or before it).
 * Before a layer's first reading, and where a reading is missing, it counts
 * as 0 — an account that didn't exist yet held nothing. `ts` ascending per layer.
 */
export function stackOnUnion(layers: readonly { ts: readonly number[]; vs: readonly (number | null)[] }[]): { ts: number[]; values: number[][] } {
  const { ts, at } = alignAsOf(layers.map((l) => l.ts))
  const values = layers.map((l, k) =>
    at[k]!.map((j) => {
      const v = j >= 0 ? l.vs[j] : null
      return typeof v === 'number' && Number.isFinite(v) ? v : 0
    }),
  )
  return { ts, values }
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toString()

/**
 * SVG path data for one stacked layer over the kept indices `idx`
 * (ascending): along its upper edge left to right, back along its lower edge.
 * Where the layer is 0 the two edges meet, so it pinches to nothing there.
 * Fewer than two indices draw nothing.
 */
export function stackBandPath(
  idx: readonly number[],
  ts: readonly number[],
  lo: readonly number[],
  hi: readonly number[],
  x: (t: number) => number,
  y: (v: number) => number,
): string {
  if (idx.length < 2) return ''
  const up = idx.map((i) => `${f1(x(ts[i]!))} ${f1(y(hi[i]!))}`)
  const dn = idx.map((i) => `${f1(x(ts[i]!))} ${f1(y(lo[i]!))}`).reverse()
  return `M${up.join('L')}L${dn.join('L')}Z`
}

/**
 * The order a tooltip lists stacked layers in, top to bottom as drawn at one
 * point: the positive pile from its top down (the reverse of stacking order),
 * then layers that are 0 there, then the negative pile from $0 down. `values`
 * are the layers' readings in stacking order; returns their indices.
 */
export function stackTipOrder(values: readonly number[]): number[] {
  const idx = values.map((_, i) => i)
  return [...idx.filter((i) => values[i]! > 0).reverse(), ...idx.filter((i) => values[i] === 0), ...idx.filter((i) => values[i]! < 0)]
}

export type CompositionLayer = { id: string; label: string; slot: Slot; values: number[] }

/**
 * Net worth's parts as stack layers, in the fixed slot order the Dashboard's
 * donut and tiles use: Brokerage s1, Retirement s2, Property s3 (its value —
 * the debt against it is its own layer), Crypto s4, Cash s5, and every debt
 * as one Liabilities layer in s6 below $0. A part that is $0 in every month
 * is left out, so the legend lists only what the household has.
 */
export function compositionLayers(points: readonly NetWorthPoint[]): CompositionLayer[] {
  const defs: { id: keyof Omit<NetWorthPoint, 'month' | 'total'>; label: string; slot: Slot }[] = [
    { id: 'brokerage', label: 'Brokerage', slot: 1 },
    { id: 'retirement', label: 'Retirement', slot: 2 },
    { id: 'property', label: 'Property', slot: 3 },
    { id: 'crypto', label: 'Crypto', slot: 4 },
    { id: 'cash', label: 'Cash', slot: 5 },
    { id: 'liabilities', label: 'Liabilities', slot: 6 },
  ]
  return defs
    .map((d) => ({ id: `nw:${d.id}`, label: d.label, slot: d.slot, values: points.map((p) => p[d.id]) }))
    .filter((l) => l.values.some((v) => v !== 0))
}
