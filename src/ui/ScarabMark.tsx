import { useId } from 'react'

// A 64-unit box: the coin, and the beetle drawn into it.
const BODY =
  'M24.6 19.31A7.4 5.55 0 0 1 39.4 19.31Q32 23.16 24.6 19.31Z' + // head
  'M23.49 20.42Q32 25.6 40.51 20.42C43.1 20.42 44.58 22.64 44.58 25.6C44.58 28.19 43.84 30.04 41.62 30.04H22.38C20.16 30.04 19.42 28.19 19.42 25.6C19.42 22.64 20.9 20.42 23.49 20.42Z' + // thorax
  'M31.07 31.89V50.02C25.34 50.02 20.16 47.8 20.16 41.88V34.11C20.16 32.85 21.12 31.89 22.38 31.89Z' + // wing cases
  'M32.92 31.89V50.02C38.66 50.02 43.84 47.8 43.84 41.88V34.11C43.84 32.85 42.88 31.89 41.62 31.89Z'
// The gaps between head, thorax and wing cases, painted back into the coin at one width.
const CUTS = 'M22.75 19.16L24.05 19.87Q32 24.38 39.95 19.87L41.25 19.16M18.68 30.96H45.32M32 30.96V51.13'
const LEGS =
  'M20.9 24.86L16.46 24.12L11.65 17.83M20.53 31.15L14.61 32.26L12.02 36.7M20.9 39.29L16.46 42.25L15.35 48.54' +
  'M43.1 24.86L47.54 24.12L52.35 17.83M43.47 31.15L49.39 32.26L51.98 36.7M43.1 39.29L47.54 42.25L48.65 48.54'

/**
 * The brand mark: a scarab struck out of a gold coin. The beetle is a mask
 * cut-out rather than a dark fill, so the sidebar, a card or the page shows
 * through it. index.html can't import this, so it keeps two copies — the boot
 * splash, and the favicon (heavier cuts, darker gold on a light tab strip) —
 * and a change here goes there too.
 */
export function ScarabMark({ size }: { size: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <mask id={`${uid}-m`}>
        <circle cx="32" cy="32" r="30" fill="#fff" />
        <path d={BODY} fill="#000" />
        <path d={CUTS} fill="none" stroke="#fff" strokeWidth="2.81" />
        <path d={LEGS} fill="none" stroke="#000" strokeWidth="2.66" strokeLinecap="round" strokeLinejoin="round" />
      </mask>
      <rect width="64" height="64" fill="var(--gold)" mask={`url(#${uid}-m)`} />
    </svg>
  )
}
