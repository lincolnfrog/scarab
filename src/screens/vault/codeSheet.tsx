import { useSyncExternalStore } from 'react'
import { RecoveryCodeSheet } from '../../RecoveryCode'
import { acknowledgeRecoveryCode, recoveryCodeOfSession } from '../../session'

/**
 * The recovery-code sheet, held outside React: a new code (after a re-key)
 * must reach the person even if the screen remounts meanwhile, so it lives
 * in this module until they close the sheet. One at a time; a newer code
 * replaces an older one (only the newest opens the vault).
 */
export type CodeSheet = {
  code: string
  title: string
  subtitle?: string
  /** A new code the person must keep: the sheet can't be dismissed until they say it's stored. */
  required: boolean
}

let current: CodeSheet | null = null
const listeners = new Set<() => void>()
const emit = () => {
  for (const fn of listeners) fn()
}

export function showRecoveryCode(sheet: CodeSheet): void {
  current = sheet
  emit()
}

const snapshot = () => current

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Mounted once, by the Vault screen. */
export function RecoveryCodeHost() {
  const sheet = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (
    <RecoveryCodeSheet
      code={sheet?.code ?? null}
      title={sheet?.title ?? ''}
      subtitle={sheet?.subtitle}
      required={sheet?.required ?? false}
      onDone={() => {
        const shown = current?.code
        current = null
        emit()
        // Seeing the current code through settles the reminder that a new one is owed — only if it is still the
        // vault's code (a re-key landing while the sheet was open makes it an old one).
        void recoveryCodeOfSession()
          .then((now) => now === shown && acknowledgeRecoveryCode())
          .catch(() => undefined)
      }}
    />
  )
}
