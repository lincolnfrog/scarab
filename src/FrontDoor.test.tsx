import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { Invite, Mode } from './session'

/**
 * The invitation step, rendered to static markup (Node has no DOM here; the
 * Join confirmation itself is a dialog, checked in the browser).
 */

vi.mock('sql.js/dist/sql-wasm.wasm?url', async () => {
  const { createRequire } = await import('node:module')
  return { default: createRequire(import.meta.url).resolve('sql.js/dist/sql-wasm.wasm') }
})
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hostname: 'localhost', reload: () => {} } }))
vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 })
vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })

const door = async (mode: Mode) => {
  const FrontDoor = (await import('./FrontDoor')).default
  return renderToStaticMarkup(<FrontDoor mode={mode} onEnter={() => {}} onHousehold={() => {}} />)
}
const base: Mode = { vault: null, household: null, serverHasData: false, zkOnly: true, invites: [] }
const inv = (household: string, at: string): Invite => ({ household, invited_by: household, invited_at: at })
/** Each button's class and label, in order. */
const buttons = (html: string) =>
  [...html.matchAll(/<button([^>]*)><span[^>]*>([^<]*)</g)].map((m) => ({ attrs: m[1]!, label: m[2]!.replace(/&#x27;/g, "'") }))

describe('the front door’s invitation step', () => {
  it('focuses nothing for you: Join is never the default, and Decline is a full button beside it', async () => {
    const html = await door({ ...base, invites: [inv('max@x.com', '2026-09-22 09:00:00')] })
    expect(html).not.toMatch(/autofocus/)
    const [join, decline, later] = buttons(html)
    expect(join).toMatchObject({ label: 'Join max@x.com’s household' })
    expect(join!.attrs).toMatch(/class="btn gold"/)
    expect(decline).toMatchObject({ label: 'Decline' })
    expect(decline!.attrs).toMatch(/class="btn"/) // not the ghost style "Not now" wears
    expect(later).toMatchObject({ label: 'Not now' })
    expect(later!.attrs).toMatch(/class="btn ghosty"/)
  })

  it('two households’ invitations each get their own Join and Decline', async () => {
    const html = await door({ ...base, invites: [inv('max@x.com', '2026-09-21 09:00:00'), inv('ann@x.com', '2026-09-22 09:00:00')] })
    expect(buttons(html).map((b) => b.label).filter((l) => l.startsWith('Join') || l === 'Decline')).toEqual([
      'Join max@x.com’s household',
      'Decline',
      'Join ann@x.com’s household',
      'Decline',
    ])
  })
})
