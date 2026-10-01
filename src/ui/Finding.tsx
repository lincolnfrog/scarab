import { useId, useState } from 'react'
import { NOT_ADVICE, type Finding as FindingData, type FindingTone } from '../../shared/checkup-api'
import { formatDollars } from '../../shared/money'
import { Link, type RouteTarget } from '../router'
import './ui.css'

const TONE: Record<FindingTone, string> = { risk: 'Risk', saving: 'Tax', 'heads-up': 'Heads-up' }

/**
 * One Checkup finding, showing its work. Closed, it is a line: what kind of
 * finding, what is true, and the dollars at stake (with what they measure).
 * Open, it carries the five parts every finding must: the rule with its
 * citation and vintage; the household's numbers; the arithmetic; what it
 * leaves out; and the fixed "an estimate, not advice" line — then the link to
 * where the facts live. No status colours: green and red stay for gains and
 * losses.
 */
export function Finding({ finding: f, defaultOpen = false }: { finding: FindingData; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <article className={`ui-finding${open ? ' is-open' : ''}`}>
      <button type="button" className="ui-finding-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((o) => !o)}>
        <span className="ui-finding-eyebrow">
          {TONE[f.tone]}
          {f.isNew && <span className="tag ui-finding-new">New</span>}
        </span>
        <span className="ui-finding-title">{f.title}</span>
        <span className="ui-finding-impact">
          {f.impactCents > 0 && <b>{formatDollars(f.impactCents)}</b>}
          <span>{f.impactLabel}</span>
        </span>
        <svg className="ui-finding-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <div className="ui-finding-body" id={bodyId} hidden={!open}>
        <section>
          <h3>The rule</h3>
          <p>{f.rule.text}</p>
          <p className="ui-finding-cite">
            {f.rule.cite} · <span className="ui-finding-vintage">{f.rule.vintage}</span>
          </p>
        </section>
        <section>
          <h3>Your numbers</h3>
          <dl className="ui-finding-kv">
            {f.inputs.map((x, i) => (
              <div key={i}>
                <dt>{x.label}</dt>
                <dd>{x.value}</dd>
              </div>
            ))}
          </dl>
        </section>
        <section>
          <h3>The arithmetic</h3>
          <ol className="ui-finding-math">
            {f.math.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </section>
        {f.leavesOut.length > 0 && (
          <section>
            <h3>What it leaves out</h3>
            <ul className="ui-finding-leaves">
              {f.leavesOut.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </section>
        )}
        <div className="ui-finding-foot">
          <span>{NOT_ADVICE}</span>
          {f.action && (
            <Link to={f.action.to as RouteTarget} className="ui-finding-link">
              {f.action.label} →
            </Link>
          )}
        </div>
      </div>
    </article>
  )
}
