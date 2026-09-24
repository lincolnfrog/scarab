import { describe, expect, it } from 'vitest'
import { initialsFor, parseServerTime, relTime, shortDate, sidebarText, sizeText, syncStateOf, unsavedText, updatedText, whoLabel } from './syncStatus'

describe('syncStateOf', () => {
  const base = { active: true, hasVault: true, dirty: false, autosave: 'idle' }

  it('is off in household mode, whatever else is going on', () => {
    expect(syncStateOf({ ...base, active: false, hasVault: false, dirty: true, autosave: 'error' })).toBe('off')
  })

  it('reads saved / unsaved from the dirty flag when a vault exists', () => {
    expect(syncStateOf(base)).toBe('saved')
    expect(syncStateOf({ ...base, dirty: true })).toBe('unsaved')
  })

  it('says No vault without one, even when nothing has been edited', () => {
    expect(syncStateOf({ ...base, hasVault: false })).toBe('novault')
    expect(syncStateOf({ ...base, hasVault: false, dirty: true })).toBe('novault')
  })

  it('lets a failure outrank everything, then an upload in flight', () => {
    expect(syncStateOf({ ...base, dirty: true, autosave: 'error' })).toBe('failed')
    expect(syncStateOf({ ...base, hasVault: false, autosave: 'error' })).toBe('failed')
    expect(syncStateOf({ ...base, autosave: 'toolarge' })).toBe('failed')
    expect(syncStateOf({ ...base, dirty: true, autosave: 'saving' })).toBe('saving')
  })

  it('offline reads as its own calm state, not as saving', () => {
    expect(syncStateOf({ ...base, dirty: true, autosave: 'retrying' })).toBe('retrying')
  })

  it('a refused save, or a stored vault that changed under the tab, is a conflict — above everything else', () => {
    expect(syncStateOf({ ...base, dirty: true, autosave: 'conflict' })).toBe('conflict')
    expect(syncStateOf({ ...base, attention: 'gone' })).toBe('conflict')
    expect(syncStateOf({ ...base, dirty: true, autosave: 'conflict', attention: 'newer' })).toBe('conflict')
    expect(syncStateOf({ ...base, autosave: 'error', attention: 'gone' })).toBe('conflict')
  })

  it('the other member’s newer version is a call to action above an upload or a retry, below a failure', () => {
    expect(syncStateOf({ ...base, dirty: true, attention: 'newer' })).toBe('newer')
    expect(syncStateOf({ ...base, attention: 'older' })).toBe('newer')
    expect(syncStateOf({ ...base, autosave: 'saving', attention: 'newer' })).toBe('newer')
    expect(syncStateOf({ ...base, autosave: 'retrying', attention: 'newer' })).toBe('newer')
    expect(syncStateOf({ ...base, autosave: 'toolarge', attention: 'newer' })).toBe('failed')
    expect(syncStateOf({ ...base, attention: null })).toBe('saved')
  })
})

describe('who, how big, which date', () => {
  it('says “you” for the signed-in identity (any case), the email otherwise', () => {
    expect(whoLabel('nicole@x.com', 'max@x.com')).toBe('nicole@x.com')
    expect(whoLabel('Max@X.com', 'max@x.com')).toBe('you')
    expect(whoLabel(null, 'max@x.com')).toBe('someone')
    expect(whoLabel('nicole@x.com', null)).toBe('nicole@x.com')
  })

  it('sizes in KB, then MB', () => {
    expect(sizeText(300)).toBe('1 KB')
    expect(sizeText(44 * 1024)).toBe('44 KB')
    expect(sizeText(1.25 * 1024 * 1024)).toBe('1.3 MB')
  })

  it('short dates are local', () => {
    expect(shortDate(new Date(2026, 8, 22, 23, 30).getTime())).toBe('Sep 22')
  })

  it('avatar initials come from the email, two letters where first letters clash', () => {
    expect(initialsFor(['max@x.com', 'nicole@x.com'])).toEqual(['M', 'N'])
    expect(initialsFor(['max@x.com', 'mia@x.com', 'nicole@x.com'])).toEqual(['Ma', 'Mi', 'N'])
    expect(initialsFor(['m@x.com', 'mia@x.com'])).toEqual(['M', 'Mi'])
    expect(initialsFor(['.x.@y.com', '@nobody', 'élodie@x.fr'])).toEqual(['X', '?', 'É'])
  })
})

describe('relTime', () => {
  const now = new Date(2026, 8, 23, 14, 0, 0).getTime()
  const ago = (ms: number) => relTime(now - ms, now)

  it('rounds to the unit that reads naturally', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(44_000)).toBe('just now')
    expect(ago(46_000)).toBe('1m ago')
    expect(ago(2 * 60_000 + 20_000)).toBe('2m ago')
    expect(ago(59 * 60_000)).toBe('59m ago')
    expect(ago(60 * 60_000)).toBe('1h ago')
    expect(ago(23 * 3600_000 + 59 * 60_000)).toBe('23h ago')
    expect(ago(24 * 3600_000)).toBe('1d ago')
    expect(ago(6 * 86400_000)).toBe('6d ago')
  })

  it('treats a timestamp slightly in the future (clock skew) as just now', () => {
    expect(relTime(now + 5_000, now)).toBe('just now')
  })

  it('switches to a local date after a week, adding the year only when it differs', () => {
    expect(relTime(new Date(2026, 8, 3, 9, 0).getTime(), now)).toBe('Sep 3')
    expect(relTime(new Date(2025, 11, 30, 9, 0).getTime(), now)).toBe('Dec 30, 2025')
  })
})

describe('parseServerTime', () => {
  it('reads SQLite datetime() as UTC', () => {
    expect(parseServerTime('2026-09-23 14:02:11')).toBe(Date.UTC(2026, 8, 23, 14, 2, 11))
    expect(parseServerTime('2026-09-23 14:02')).toBe(Date.UTC(2026, 8, 23, 14, 2, 0))
  })

  it('reads ISO-8601, with Z or an offset', () => {
    expect(parseServerTime('2026-09-23T14:02:11Z')).toBe(Date.UTC(2026, 8, 23, 14, 2, 11))
    expect(parseServerTime('2026-09-23T14:02:11.250Z')).toBe(Date.UTC(2026, 8, 23, 14, 2, 11))
    expect(parseServerTime('2026-09-23T07:02:11-07:00')).toBe(Date.UTC(2026, 8, 23, 14, 2, 11))
  })

  it('refuses anything else', () => {
    for (const s of ['', 'yesterday', '2026-09-23', '23/09/2026 14:02']) expect(parseServerTime(s), s).toBeNull()
  })
})

describe('unsavedText', () => {
  it('counts when it can, and says so plainly when it can’t', () => {
    expect(unsavedText(1)).toBe('1 unsaved change')
    expect(unsavedText(3)).toBe('3 unsaved changes')
    expect(unsavedText(null)).toBe('Unsaved changes')
    expect(unsavedText(0)).toBe('Unsaved changes')
  })
})

describe('what the tab says about the vault', () => {
  it('the follow toast names who saved (amendment 2), and says “you” for another tab of your own', () => {
    expect(updatedText({ version: 43, by: 'nicole@x.com' }, 'max@x.com')).toBe('Updated to v43 · saved by nicole@x.com')
    expect(updatedText({ version: 43, by: 'Max@x.com' }, 'max@x.com')).toBe('Updated to v43 · saved by you')
    expect(updatedText({ version: 43, by: null }, 'max@x.com')).toBe('Updated to v43')
  })

  it('the sidebar line: version and age when saved, otherwise what is holding it up', () => {
    const now = new Date(2026, 8, 23, 14, 0).getTime()
    const at = (state: Parameters<typeof sidebarText>[0]['state'], extra: Partial<Parameters<typeof sidebarText>[0]> = {}) =>
      sidebarText({ state, version: 43, savedAt: now - 2 * 60_000, attention: null, ...extra }, now)
    expect(at('saved')).toBe('Vault v43 · saved 2m ago')
    expect(at('saved', { savedAt: null })).toBe('Vault v43 · saved')
    expect(at('saving')).toBe('Vault v43 · saving…')
    expect(at('retrying')).toBe('Vault v43 · offline — retrying')
    expect(at('unsaved')).toBe('Vault v43 · unsaved changes')
    expect(at('newer', { attention: { kind: 'newer', version: 44 } })).toBe('Vault v43 · v44 available')
    expect(at('conflict')).toBe('Vault v43 · conflict — review')
    expect(at('failed')).toBe('Vault v43 · save failed')
    expect(at('off', { version: null })).toBe('Household · server data')
    expect(at('novault', { version: null })).toBe('Session · no vault yet')
    expect(at('failed', { version: null })).toBe('Session · save failed')
  })
})
