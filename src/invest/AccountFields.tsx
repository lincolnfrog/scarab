import { useId, useState, type ReactNode } from 'react'
import { TextInput } from '../ui/Field'
import { Segmented } from '../ui/Segmented'
import { ownerInitial, ownerTone } from './accountTypes'
import './invest.css'

/**
 * Pieces the add flow and the account settings share: a labelled group for a
 * pill choice (a <label> can't name a radiogroup), the owner picker, and the
 * owner avatar the account strip wears.
 */

/** A Field-like block for a group control: the caption names the group, the hint sits under it. */
export function ChoiceField({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div className="ui-field inv-choice" role="group" aria-labelledby={`${id}-l`} aria-describedby={hint ? `${id}-h` : undefined}>
      <div id={`${id}-l`} className="ui-field-label">
        {label}
      </div>
      {children}
      {hint && (
        <div id={`${id}-h`} className="ui-field-hint">
          {hint}
        </div>
      )}
    </div>
  )
}

// Stored names are trimmed, so a leading space can't collide with one.
const JOINT = ' joint'
const OTHER = ' other'

/**
 * Whose account it is: each person the household knows (paycheck earners,
 * owners already named), Joint, or someone else typed in. Joint is null.
 */
export function OwnerPicker({ owners, value, onChange }: { owners: readonly string[]; value: string | null; onChange: (v: string | null) => void }) {
  const known = value === null || owners.some((o) => o.toLowerCase() === value.trim().toLowerCase())
  const [typing, setTyping] = useState(!known)
  const selected = typing ? OTHER : value === null ? JOINT : (owners.find((o) => o.toLowerCase() === value.trim().toLowerCase()) ?? OTHER)
  return (
    <div className="inv-owner">
      <Segmented
        aria-label="Owner"
        size="md"
        value={selected}
        options={[
          ...owners.map((o) => ({ value: o, label: o })),
          { value: JOINT, label: 'Joint' },
          { value: OTHER, label: owners.length > 0 ? 'Someone else…' : 'One person…' },
        ]}
        onChange={(v) => {
          if (v === OTHER) {
            setTyping(true)
            onChange('')
          } else {
            setTyping(false)
            onChange(v === JOINT ? null : v)
          }
        }}
      />
      {typing && (
        <TextInput
          autoFocus
          aria-label="Owner’s name"
          placeholder="Their name"
          maxLength={40}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  )
}

/**
 * The owner's initial in a small disc — the mockup's avatars. A joint
 * account shows the household's first two people overlapped (a J with only
 * one known; nothing while nobody is named).
 */
export function OwnerAvatar({ owner, owners }: { owner: string | null; owners: readonly string[] }) {
  if (owner === null) {
    if (owners.length === 0) return null // nobody named yet: every account would wear the same J
    if (owners.length >= 2)
      return (
        <span className="inv-avs" aria-hidden="true">
          <span className="inv-av inv-av-1">{ownerInitial(owners[0]!)}</span>
          <span className="inv-av inv-av-2">{ownerInitial(owners[1]!)}</span>
        </span>
      )
    return (
      <span className="inv-avs" aria-hidden="true">
        <span className="inv-av inv-av-0">J</span>
      </span>
    )
  }
  return (
    <span className="inv-avs" aria-hidden="true">
      <span className={`inv-av inv-av-${ownerTone(owner, owners)}`}>{ownerInitial(owner)}</span>
    </span>
  )
}
