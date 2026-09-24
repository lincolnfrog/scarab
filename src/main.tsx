import { StrictMode, type ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

/**
 * Render errors, reported once, as one line: the message (plus the component
 * stack while developing). A crash an ErrorBoundary caught is already on
 * screen as a card with Retry; an uncaught one took the tree down.
 */
const report = (what: string) => (error: unknown, info: ErrorInfo) => {
  const message = error instanceof Error ? error.message : String(error)
  if (import.meta.env.DEV) console.error(`Scarab: ${what}: ${message}`, info.componentStack)
  else console.error(`Scarab: ${what}: ${message}`)
}

createRoot(document.getElementById('root')!, {
  onCaughtError: report('render error, contained by an error boundary'),
  onUncaughtError: report('uncaught render error'),
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
