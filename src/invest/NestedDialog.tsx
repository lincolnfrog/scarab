import type { ReactNode } from 'react'

/**
 * Formerly an event boundary for a Dialog or Drawer rendered from inside
 * another one (the account drawer's vest, grant and backfill dialogs): React
 * dispatches a dialog's `cancel` and `close` up the component tree, so Esc in
 * a nested dialog closed the drawer too. Dialog itself now ignores those
 * events unless they fired on its own <dialog>, so this is a plain
 * pass-through; callers can drop it.
 */
export default function NestedDialog({ children }: { children: ReactNode }) {
  return <>{children}</>
}
