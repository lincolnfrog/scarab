import { Component, Fragment, useEffect, useReducer, type ReactNode } from 'react'
import { localMode } from '../local'
import { saveVault } from '../session'
import { Button } from './Button'
import { useAction } from './useAction'
import './ui.css'

type State = { error: Error | null; attempt: number }

/**
 * Contains a render crash to one screen or card: a card with the message and
 * Retry instead of a blank app. In a zero-knowledge session the data lives
 * in the tab's database, not in the component that crashed — the card says
 * so and offers Save now, so a crash never costs unsaved work.
 *
 * Logging is the root's job (main.tsx onCaughtError), once per crash.
 */
export class ErrorBoundary extends Component<{ label: string; children: ReactNode }, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  private retry = () => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))

  render() {
    const { error, attempt } = this.state
    // A new key per attempt remounts the subtree from scratch rather than re-rendering its broken state.
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>
    return (
      <div className="card ui-errcard" role="alert">
        <h2>{this.props.label} hit a problem</h2>
        <p>This part of Scarab stopped rendering. Retrying usually clears it; if it keeps happening, the message below says what broke.</p>
        <div className="ui-errmsg">{error.message || String(error)}</div>
        <div className="ui-errrow">
          <Button variant="gold" onClick={this.retry}>
            Retry
          </Button>
          {localMode.active && <SessionNote />}
        </div>
      </div>
    )
  }
}

function SessionNote() {
  // localMode isn't React state; re-read it whenever the session announces a change (dirty, saved).
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    window.addEventListener('scarab-mode', refresh)
    return () => window.removeEventListener('scarab-mode', refresh)
  }, [])
  const save = useAction(saveVault, { success: (r) => `Saved · vault v${r.version}`, errorPrefix: "Couldn't save the vault" })
  return (
    <>
      {localMode.vault && localMode.dirty && (
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save now
        </Button>
      )}
      <span className="muted">
        Your data is intact — it lives in this tab, not in this screen.
        {!localMode.vault && ' Create a vault from Data & Vault to keep it.'}
      </span>
    </>
  )
}
