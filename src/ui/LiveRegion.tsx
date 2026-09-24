/**
 * Screen-reader announcements for things that change without moving focus:
 * a route change, a recomputed total, a save that landed. One visually hidden
 * live region per politeness level, created on first use and kept for the
 * life of the tab (it must already exist when its text changes, or assistive
 * tech may miss the update).
 */

const regions: Partial<Record<'polite' | 'assertive', HTMLElement>> = {}
const timers: Partial<Record<'polite' | 'assertive', ReturnType<typeof setTimeout>>> = {}

function region(politeness: 'polite' | 'assertive'): HTMLElement | null {
  if (typeof document === 'undefined') return null
  let el = regions[politeness]
  if (!el || !el.isConnected) {
    el = document.createElement('div')
    el.className = 'ui-sr'
    el.setAttribute('aria-live', politeness)
    el.setAttribute('aria-atomic', 'true')
    if (politeness === 'assertive') el.setAttribute('role', 'alert')
    document.body.appendChild(el)
    regions[politeness] = el
  }
  return el
}

/**
 * Say `text` to screen-reader users. Repeating the same text announces it
 * again: the region is emptied first and refilled on the next tick.
 */
export function announce(text: string, politeness: 'polite' | 'assertive' = 'polite'): void {
  const el = region(politeness)
  if (!el) return
  clearTimeout(timers[politeness])
  el.textContent = ''
  timers[politeness] = setTimeout(() => {
    el.textContent = text
  }, 60)
}
