import { Fragment, useEffect, useRef, useState } from 'react'
import { clipboardGuard, CLEAR_AFTER_MS } from './screens/vault/clipboard'
import { Button } from './ui/Button'
import { Dialog } from './ui/Dialog'
import './screens/vault/vault.css'

const today = () => new Date().toISOString().slice(0, 10)

/**
 * Print the recovery code on its own page: a drawer, a safe, the folder with
 * the passports. False when the browser blocked the print window.
 */
export function printRecoveryCode(code: string): boolean {
  const w = window.open('', '_blank', 'width=560,height=420')
  if (!w) return false
  w.document.write(
    `<title>Scarab recovery code</title><body style="font-family:system-ui;padding:32px;color:#111">` +
      `<h2 style="margin:0 0 6px">Scarab vault — recovery code</h2>` +
      `<p style="margin:0 0 18px;color:#555">Printed ${today()}. Opens the vault without a passkey. There is no reset: keep this somewhere real.</p>` +
      `<pre style="font:18px/1.6 ui-monospace,monospace;letter-spacing:1px;white-space:pre-wrap">${code.replace(/(.{24})-/g, '$1-\n')}</pre></body>`,
  )
  w.document.close()
  w.focus()
  w.print()
  return true
}

/** Copy (cleared from the clipboard a minute later, best effort), Print, and whether either — or "I wrote it down" — happened. */
function useKeeping(code: string) {
  /** The label shows "Copied ✓" until the clipboard is cleared; `kept` remembers that a copy happened at all. */
  const [copied, setCopied] = useState(false)
  const [everCopied, setEverCopied] = useState(false)
  const [printed, setPrinted] = useState(false)
  const [wrote, setWrote] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const flip = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (flip.current && clearTimeout(flip.current)), [])
  // A different code (after a re-key) starts over.
  useEffect(() => {
    setCopied(false)
    setEverCopied(false)
    setPrinted(false)
    setWrote(false)
    setProblem(null)
  }, [code])
  return {
    copied,
    printed,
    wrote,
    setWrote,
    problem,
    kept: everCopied || printed || wrote,
    async copy() {
      setProblem(null)
      try {
        await clipboardGuard().copy(code)
        setCopied(true)
        setEverCopied(true)
        if (flip.current) clearTimeout(flip.current)
        flip.current = setTimeout(() => setCopied(false), CLEAR_AFTER_MS)
      } catch (e) {
        setProblem(`Couldn’t copy (${e instanceof Error ? e.message : String(e)}) — select the code and copy it, or print it.`)
      }
    },
    print() {
      setProblem(null)
      if (printRecoveryCode(code)) setPrinted(true)
      else setProblem('The browser blocked the print window — allow pop-ups for this site, or copy the code instead.')
    },
  }
}

function CodeText({ code }: { code: string }) {
  return (
    <>
      <pre className="recoverycode zk-rc-code" aria-label="Recovery code">
        {/* Lines break only between groups, never inside one. */}
        {code.split('-').map((g, i, all) => (
          <Fragment key={i}>
            {g}
            {i < all.length - 1 && '-'}
            <wbr />
          </Fragment>
        ))}
      </pre>
      <p className="sub2 zk-rc-note">
        This code alone opens the vault, on any device, without a passkey. Zero-knowledge means nobody can reset it for you: lose every
        passkey and this code, and the vault is gone.
      </p>
    </>
  )
}

const copyLabel = (copied: boolean) => (copied ? 'Copied ✓ — cleared in 60s' : 'Copy')

/**
 * The one place the raw data key is ever shown unprompted, inline (the front
 * door's last setup step). "I've stored it" waits for Copy, Print or "I wrote
 * it down": the vault is only as recoverable as this code.
 */
export default function RecoveryCode({ code, title, onDone }: { code: string; title: string; onDone: () => void }) {
  const k = useKeeping(code)
  return (
    <div className="recovery zk-rc-inline">
      <div className="h4row">
        <b className="inkstrong">{title}</b>
        <div className="right muted">write it down · it will not be shown again unprompted</div>
      </div>
      <CodeText code={code} />
      <label className="checkline zk-rc-check">
        <input type="checkbox" checked={k.wrote} onChange={(e) => k.setWrote(e.target.checked)} />
        I wrote it down
      </label>
      {k.problem && (
        <p className="sub2 neg" role="alert">
          {k.problem}
        </p>
      )}
      <div className="formrow">
        <Button onClick={k.print}>Print</Button>
        <Button variant="ghost" onClick={() => void k.copy()} aria-live="polite">
          {copyLabel(k.copied)}
        </Button>
        <Button variant="gold" disabled={!k.kept} onClick={onDone}>
          I’ve stored it
        </Button>
      </div>
      {!k.kept && <p className="sub2 muted zk-rc-hint">Copy it, print it, or tick “I wrote it down” first.</p>}
    </div>
  )
}

/**
 * The recovery code in a sheet. `required`: a new code the person must keep
 * (after a re-key the old one no longer opens anything) — the sheet can't be
 * dismissed, and "I've stored it" waits for Copy, Print or "I wrote it
 * down". Otherwise it is a plain look at the current code.
 */
export function RecoveryCodeSheet(p: { code: string | null; title: string; subtitle?: string; required: boolean; onDone: () => void }) {
  const [shown, setShown] = useState(p.code)
  // Keep the last code through the exit fade, then drop it from the DOM.
  useEffect(() => {
    if (p.code) setShown(p.code)
    else {
      const t = setTimeout(() => setShown(null), 400)
      return () => clearTimeout(t)
    }
  }, [p.code])
  const code = p.code ?? shown ?? ''
  const k = useKeeping(code)
  const canFinish = !p.required || k.kept
  return (
    <Dialog
      open={p.code !== null}
      onClose={p.onDone}
      dismissible={!p.required}
      width={520}
      title={p.title}
      subtitle={p.subtitle}
      footer={
        <div className="zk-rc-foot">
          <Button onClick={k.print}>Print</Button>
          <Button variant="ghost" onClick={() => void k.copy()} aria-live="polite">
            {copyLabel(k.copied)}
          </Button>
          <Button variant="gold" disabled={!canFinish} onClick={p.onDone}>
            {p.required ? 'I’ve stored it' : 'Done'}
          </Button>
        </div>
      }
    >
      <div className="zk-rc">
        <CodeText code={code} />
        {p.required && (
          <label className="checkline zk-rc-check">
            <input type="checkbox" checked={k.wrote} onChange={(e) => k.setWrote(e.target.checked)} />
            I wrote it down
          </label>
        )}
        {k.problem && (
          <p className="sub2 neg" role="alert">
            {k.problem}
          </p>
        )}
      </div>
    </Dialog>
  )
}
