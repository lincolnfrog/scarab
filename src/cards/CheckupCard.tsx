import { useEffect, useState } from 'react'
import type { Checkup, FindingTone } from '../../shared/checkup-api'
import { formatDollars } from '../../shared/money'
import { get } from '../api'
import { Link } from '../router'
import '../screens/checkup.css'

const TONE: Record<FindingTone, string> = { risk: 'Risk', saving: 'Tax', 'heads-up': 'Heads-up' }

/**
 * The Checkup's top three, on the Dashboard: what each finding says and the
 * dollars at stake, each a way into the Checkup where its work is shown.
 * Renders nothing while loading, on failure, or when no rule fires.
 */
export default function CheckupCard() {
  const [data, setData] = useState<Checkup | null>(null)
  useEffect(() => {
    let live = true
    // Optional: a failed Checkup just stays out of the way here (the screen says why).
    get<Checkup>('/api/checkup')
      .then((d) => live && setData(d))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  if (!data || data.findings.length === 0) return null
  const top = data.findings.slice(0, 3)
  const fresh = data.findings.filter((f) => f.isNew).length
  return (
    <div className="card c12">
      <div className="h4row">
        <h2>
          Checkup{fresh > 0 && <span className="muted"> · {fresh} new</span>}
        </h2>
        <div className="right">
          <Link to={{ screen: 'checkup' }} className="ck-a">
            {data.findings.length > top.length ? `All ${data.findings.length} findings` : 'Show the work'} →
          </Link>
        </div>
      </div>
      <ul className="ck-echo">
        {top.map((f) => (
          <li key={f.id}>
            <Link to={{ screen: 'checkup' }} className="ck-echo-item">
              <span className="ck-echo-kind">
                {TONE[f.tone]}
                {f.isNew && <span className="tag ui-finding-new">New</span>}
              </span>
              <span className="ck-echo-title">{f.title}</span>
              <span className="ck-echo-impact">
                {f.impactCents > 0 ? formatDollars(f.impactCents) : ''}
                <small>{f.impactLabel}</small>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
