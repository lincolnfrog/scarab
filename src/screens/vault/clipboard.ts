/**
 * Copy a secret (the recovery code) and take it off the clipboard again a
 * minute later — best effort. Browsers let only a focused page write the
 * clipboard, so if the page is in the background when the minute is up, the
 * clearing waits for the next focus. Reading the clipboard first to see
 * whether it still holds the code would need a permission prompt, so the
 * clearing overwrites whatever is there; the copy button says so.
 */

export const CLEAR_AFTER_MS = 60_000

export type ClipboardDeps = {
  write: (text: string) => Promise<void>
  hasFocus: () => boolean
  /** Call `fn` once, at the page's next focus; returns an unsubscribe. */
  onNextFocus: (fn: () => void) => () => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}

export type ClipboardGuard = {
  /** Put `secret` on the clipboard (throws if the browser refuses) and schedule its clearing. */
  copy: (secret: string) => Promise<void>
  /** A clearing is scheduled or waiting for focus. */
  pending: () => boolean
}

export function createClipboardGuard(deps: ClipboardDeps): ClipboardGuard {
  let timer: unknown = null
  let offFocus: (() => void) | null = null
  let pending = false

  const cancel = () => {
    if (timer !== null) deps.clearTimer(timer)
    timer = null
    offFocus?.()
    offFocus = null
    pending = false
  }

  const clear = async (): Promise<void> => {
    if (!deps.hasFocus()) {
      offFocus = deps.onNextFocus(() => {
        offFocus = null
        void clear()
      })
      return
    }
    pending = false
    try {
      await deps.write('')
    } catch {
      /* refused (focus lost at the last moment): nothing more to do — best effort */
    }
  }

  return {
    async copy(secret) {
      cancel()
      await deps.write(secret)
      pending = true
      timer = deps.setTimer(() => {
        timer = null
        void clear()
      }, CLEAR_AFTER_MS)
    },
    pending: () => pending,
  }
}

/** The page's own guard: one for the whole tab, so a clearing outlives the sheet that scheduled it. */
let tabGuard: ClipboardGuard | null = null
export function clipboardGuard(): ClipboardGuard {
  tabGuard ??= createClipboardGuard({
    write: (t) => {
      if (!navigator.clipboard?.writeText) return Promise.reject(new Error('this browser won’t let the page use the clipboard'))
      return navigator.clipboard.writeText(t)
    },
    hasFocus: () => document.hasFocus(),
    onNextFocus: (fn) => {
      window.addEventListener('focus', fn, { once: true })
      return () => window.removeEventListener('focus', fn)
    },
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  })
  return tabGuard
}
