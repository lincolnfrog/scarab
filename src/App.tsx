import { useEffect, useState } from 'react'
import Cash from './screens/Cash'
import Dashboard from './screens/Dashboard'
import Invest from './screens/Invest'
import RealEstate from './screens/RealEstate'
import Goal from './screens/Goal'
import Future from './screens/Future'
import Taxes from './screens/Taxes'
import Vault from './screens/Vault'
import FrontDoor from './FrontDoor'
import { exitLocalMode, localMode } from './local'
import { autosave, fetchMode, type Mode } from './session'

const SCREENS = [
  { id: 'dash', label: 'Dashboard', phase: '', blurb: '', icon: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z' },
  { id: 'invest', label: 'Investments', phase: '', blurb: '', icon: 'M3 17l5-6 4 3 6-8M14 6h4v4' },
  { id: 're', label: 'Real estate', phase: '', blurb: '', icon: 'M3 11l9-7 9 7M5 10v10h14V10' },
  { id: 'cash', label: 'Cash & budget', phase: '', blurb: '', icon: 'M7 10l-4 4 4 4M3 14h13M17 4l4 4-4 4M21 8H8' },
  { id: 'goal', label: 'Dream Home', phase: '', blurb: '', icon: 'M5 21V4M5 4h13l-3 4 3 4H5' },
  { id: 'tax', label: 'Taxes', phase: '', blurb: '', icon: 'M19 5L5 19M6.5 4.5a2 2 0 100 4 2 2 0 000-4zM17.5 15.5a2 2 0 100 4 2 2 0 000-4z' },
  { id: 'future', label: 'Future', phase: '', blurb: '', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2' },
  { id: 'vault', label: 'Data & Vault', phase: '', blurb: '', icon: 'M12 3l7 4v5c0 4.6-3 7.7-7 9-4-1.3-7-4.4-7-9V7z M9 12l2 2 4-4' },
] as const

type ScreenId = (typeof SCREENS)[number]['id']

type Me = { email: string }
export default function App() {
  const [active, setActive] = useState<ScreenId>('dash')
  const [me, setMe] = useState<Me | null>(null)
  const [mode, setMode] = useState<Mode | null | 'household'>(null)
  // The front door owns the tab until a session is unlocked, created, or the
  // household escape hatch is taken — even while a session is already booting
  // behind it (creating a vault starts the engine before the passkey prompt).
  const [entered, setEntered] = useState(false)
  const [, forceRender] = useState(0)

  useEffect(() => {
    const bump = () => forceRender((n) => n + 1)
    window.addEventListener('scarab-mode', bump)
    return () => window.removeEventListener('scarab-mode', bump)
  }, [])

  useEffect(() => {
    fetch('/api/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null))
    // The front door: only when the server holds no plaintext. A household
    // install with data goes straight in, as before.
    fetchMode()
      .then((m) => setMode(m.serverHasData ? 'household' : m))
      .catch(() => setMode('household'))
  }, [])

  const screen = SCREENS.find((s) => s.id === active)!

  if (mode === null) return null
  if (mode !== 'household' && !entered)
    return <FrontDoor mode={mode} onEnter={() => setEntered(true)} onHousehold={() => setMode('household')} />

  return (
    <div className="app">
      <aside className="side">
        <div className="logo">
          <svg width="26" height="26" viewBox="0 0 44 44" fill="none" aria-hidden="true">
            <circle cx="22" cy="9" r="5" stroke="var(--gold)" strokeWidth="2.6" />
            <ellipse cx="22" cy="27" rx="10" ry="11" stroke="var(--gold)" strokeWidth="2.6" />
            <path d="M22 16v22" stroke="var(--gold)" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
          <span>SCARAB</span>
        </div>
        <nav className="nav">
          {SCREENS.map((s) => (
            <button key={s.id} className={s.id === active ? 'on' : ''} onClick={() => setActive(s.id)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d={s.icon} />
              </svg>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="foot">Phase V · zero-knowledge, growing</div>
      </aside>

      <div className="main">
        <div className="topbar">
          <span className="where">
            Scarab {localMode.active ? 'session' : 'household'} · <b>{screen.label}</b>
          </span>
          {localMode.active && (
            <span
              className="tag"
              style={{ cursor: 'pointer', color: autosave.status === 'error' || (localMode.dirty && !localMode.vault) ? 'var(--down)' : undefined }}
              title={
                autosave.status === 'error'
                  ? `autosave failed: ${autosave.error} — retry from Data & Vault`
                  : !localMode.vault
                    ? 'zero-knowledge session with no vault — create one from Data & Vault or this work is lost'
                    : localMode.dirty
                      ? 'zero-knowledge session — saving shortly'
                      : 'zero-knowledge session — everything saved. Click to end.'
              }
              onClick={() => { if (!localMode.dirty || window.confirm('End the session and discard unsaved changes?')) exitLocalMode() }}
            >
              ⬤{' '}
              {autosave.status === 'error'
                ? 'SAVE FAILED'
                : autosave.status === 'saving'
                  ? 'SAVING…'
                  : localMode.dirty
                    ? localMode.vault ? 'UNSAVED' : 'NO VAULT'
                    : 'SAVED'}
            </span>
          )}
          <span className="who">
            {me ? (
              <>
                signed in as <b>{me.email}</b> · via IAP
              </>
            ) : (
              'not signed in'
            )}
          </span>
        </div>

        <div className="screens">
          <div className="shead">
            <h1>{screen.label}</h1>
            {screen.phase && <span className="sub">arrives in Phase {screen.phase}</span>}
          </div>

          {active === 'cash' && <Cash />}
          {active === 'dash' && <Dashboard />}
          {active === 'invest' && <Invest />}
          {active === 're' && <RealEstate />}
          {active === 'goal' && <Goal />}
          {active === 'tax' && <Taxes />}
          {active === 'future' && <Future />}
          {active === 'vault' && <Vault />}


          {screen.phase && (
            <div className="card">
              <h2>
                <span className="tag">Phase {screen.phase}</span>
              </h2>
              <p>{screen.blurb}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
