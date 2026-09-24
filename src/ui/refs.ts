import type { Ref, RefObject } from 'react'

/** Point a ref (callback or object) at a node — for components that need their own handle on an element a caller also refs. */
export function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value)
  else if (ref) (ref as RefObject<T | null>).current = value
}

/** Elements a keyboard user can Tab to, in document order. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
