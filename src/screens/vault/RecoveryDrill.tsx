import { useState } from 'react'
import { drillRecoveryCode, type Drill } from '../../session'
import { Button } from '../../ui/Button'
import { Field, TextInput } from '../../ui/Field'
import './vault.css'

/**
 * The recovery-code drill: type the code from the paper and learn whether it
 * opens this vault — a typo is named as a typo, a code for another key (an
 * old one, from before a rotation) as that. Checked against the key already
 * in this tab: nothing is fetched or sent, and a code that passes is cleared.
 */
export function RecoveryDrill() {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<Drill | null>(null)
  const [busy, setBusy] = useState(false)

  async function check() {
    setBusy(true)
    try {
      const r = await drillRecoveryCode(code)
      setResult(r)
      if (r.ok) setCode('')
    } catch (e) {
      setResult({ ok: false, problem: 'mismatch', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="zk-drill"
      onSubmit={(e) => {
        e.preventDefault()
        if (code.trim() && !busy) void check()
      }}
    >
      <div className="zk-drill-row">
        <Field label="Test your written-down recovery code" hint="Checked against the key in this tab — nothing is sent or kept">
          <TextInput
            placeholder="XXXX-XXXX-XXXX-…"
            spellCheck={false}
            autoComplete="off"
            className="zk-drill-input"
            value={code}
            onChange={(e) => {
              setCode(e.target.value)
              setResult(null)
            }}
          />
        </Field>
        <Button type="submit" busy={busy} disabled={!code.trim()}>
          Test code
        </Button>
      </div>
      {result && (
        <div role="status" className={result.ok ? 'zk-drill-ok' : 'zk-drill-bad'}>
          {result.ok ? '✓ ' : ''}
          {result.message.charAt(0).toUpperCase() + result.message.slice(1)}
        </div>
      )}
    </form>
  )
}
