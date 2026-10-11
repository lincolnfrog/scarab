import { useEffect, useState } from 'react'
import type { Checkup, FindingTone } from '../../shared/checkup-api'
import { formatDollars } from '../../shared/money'
import { get } from '../api'
import { DrillCard, MiniRows } from '../ui/Drill'
import '../screens/checkup.css'

const TONE: Record<FindingTone, string> = { risk: 'Risk', saving: 'Tax', 'heads-up': 'Heads-up' }

/**
 * The Checkup's top three, on the Dashboard: what each finding says and the
 * dollars at stake. The card opens the Checkup, where each shows its work.
 * Renders nothing while loading, on failure, or when no rule fires.
 */
export default function CheckupCard({ span }: { span?: string }) {
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
  const n = data.findings.length
  return (
    <DrillCard
      to={{ screen: 'checkup' }}
      span={span}
      title="Checkup"
      badge={fresh > 0 ? `${fresh} new` : undefined}
      note={`${n} finding${n === 1 ? '' : 's'}, largest dollar impact first`}
    >
      <MiniRows
        rows={top.map((f) => ({
          key: f.id,
          label: f.title,
          value: f.impactCents > 0 ? formatDollars(f.impactCents) : TONE[f.tone],
        }))}
      />
    </DrillCard>
  )
}
