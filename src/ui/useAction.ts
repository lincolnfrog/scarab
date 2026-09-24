import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { toast } from './Toast'

/**
 * Wrap a mutation so it can't fail silently: `busy` while it runs, a success
 * toast if one is configured, and on failure an error toast plus `error` for
 * inline display. `run` never rejects — it resolves to the result, or
 * undefined when the call threw — so an event handler can `await` it without
 * a try/catch and without leaking an unhandled rejection.
 *
 *   const save = useAction((cents: number) => put('/api/goal', { targetCents: cents }),
 *     { success: 'Goal saved', errorPrefix: "Couldn't save the goal", onDone: reload })
 *   <Button busy={save.busy} onClick={() => save.run(target)}>Save</Button>
 *
 * Overlapping runs are allowed (a per-row action shared by a table); `busy`
 * stays true until the last one settles.
 */
export function useAction<A extends unknown[], R>(
  fn: (...a: A) => Promise<R>,
  o?: { success?: string | ((r: R) => string); errorPrefix?: string; onDone?: (r: R) => void },
): { run: (...a: A) => Promise<R | undefined>; busy: boolean; error: string | null } {
  const [inFlight, setInFlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // `run` keeps one identity for the component's life; it calls the latest fn and options.
  const latest = useRef({ fn, o })
  useLayoutEffect(() => {
    latest.current = { fn, o }
  })

  const run = useCallback(async (...a: A): Promise<R | undefined> => {
    const { fn, o } = latest.current
    setInFlight((n) => n + 1)
    setError(null)
    let r: R
    try {
      r = await fn(...a)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      if (o?.errorPrefix) toast.error(o.errorPrefix, { detail: message })
      else toast.error(message)
      return undefined
    } finally {
      setInFlight((n) => n - 1)
    }
    // The mutation landed. A bug in what follows must not be reported as a failed save.
    try {
      const msg = typeof o?.success === 'function' ? o.success(r) : o?.success
      if (msg) toast.success(msg)
      o?.onDone?.(r)
    } catch (e) {
      console.error('useAction: success handler threw', e)
    }
    return r
  }, [])

  return { run, busy: inFlight > 0, error }
}
