import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { formatRoute, parseHash, SCREENS, type Route, type ScreenId } from '../router'
import {
  COMMANDS,
  DEEP_ACTIONS,
  INVEST_LINKS,
  PaletteList,
  commandTarget,
  isPaletteShortcut,
  matchCommand,
  rankCommands,
} from './CommandPalette'

const byId = (id: string) => {
  const c = COMMANDS.find((x) => x.id === id)
  if (!c) throw new Error(`no command ${id}`)
  return c
}
const top = (q: string, n = 1) => rankCommands(q).slice(0, n).map((r) => r.cmd.id)
const labelHits = (q: string, id: string) => {
  const c = byId(id)
  const m = matchCommand(q, c)
  return m ? m.hits.map((i) => c.label[i]).join('') : null
}

describe('the command list', () => {
  it('offers every screen once, in nav order, and ids are unique', () => {
    const screens = COMMANDS.filter((c) => c.kind === 'screen').map((c) => c.screen)
    expect(screens).toEqual(SCREENS.map((s) => s.id))
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length)
  })

  it('only offers actions a screen actually runs, and runs none that are never offered', () => {
    const deep = DEEP_ACTIONS as Partial<Record<ScreenId, readonly string[]>>
    const live = new Set(INVEST_LINKS.filter((l) => l.live).map((l) => `invest:${l.action}`))
    const offered = new Set<string>()
    for (const c of COMMANDS) {
      if (c.kind !== 'action') continue
      offered.add(`${c.screen}:${c.action}`)
      expect(deep[c.screen]?.includes(c.action) || live.has(`${c.screen}:${c.action}`), c.id).toBe(true)
    }
    for (const [screen, actions] of Object.entries(DEEP_ACTIONS)) for (const a of actions) expect(offered.has(`${screen}:${a}`), `${screen}:${a}`).toBe(true)
  })

  it('leaves out the Investments links until that screen handles them', () => {
    for (const l of INVEST_LINKS) expect(COMMANDS.some((c) => c.id === `invest:${l.action}`)).toBe(l.live)
    // Invest.tsx opens the record-trade sheet, the guided add and the check-in exactly while the address
    // says d=trade, d=add-account and d=checkin.
    expect(INVEST_LINKS.filter((l) => l.live).map((l) => l.action)).toEqual(['trade', 'add-account', 'checkin'])
  })

  it('lands every command on a hash-safe URL (formatRoute throws on anything else in development)', () => {
    const last = (s: ScreenId): Route | null => ({ screen: s, rest: [], params: { month: '2026-08', cat: '7' }, state: {} })
    for (const c of COMMANDS) {
      const hash = formatRoute(commandTarget(c, last))
      const back = parseHash(hash)
      expect(back.screen, c.id).toBe(c.screen)
      if (c.kind === 'action') expect(back.params.d, c.id).toBe(c.action)
      else expect(back.params.d, c.id).toBeUndefined()
    }
  })
})

describe('commandTarget', () => {
  const lastWith = (params: Record<string, string>) => (s: ScreenId): Route => ({ screen: s, rest: ['budget'], params, state: {} })

  it('takes a screen back to the filters it was left with, as the nav does — never a leftover action', () => {
    expect(commandTarget(byId('cash'), lastWith({ month: '2026-08', d: 'import' }))).toEqual({ screen: 'cash', params: { month: '2026-08' } })
    expect(commandTarget(byId('tax'), () => null)).toEqual({ screen: 'tax', params: undefined })
  })

  it('keeps the filters for an action and adds its d', () => {
    expect(commandTarget(byId('cash:import'), lastWith({ month: '2026-08', cat: '7' }))).toEqual({
      screen: 'cash',
      rest: ['import'],
      params: { month: '2026-08', cat: '7', d: 'import' },
    })
    expect(commandTarget(byId('future:new-scenario'), () => null)).toEqual({ screen: 'future', rest: undefined, params: { d: 'new-scenario' } })
  })

  it('opens a blank trade sheet, not the account or lot a sheet left open was on', () => {
    const t = commandTarget(byId('invest:trade'), lastWith({ d: 'trade', acct: '3', lot: '41' }))
    expect(t).toEqual({ screen: 'invest', rest: undefined, params: { d: 'trade' } })
    expect(formatRoute(t)).toBe('#/invest?d=trade')
    // The screen itself still comes back without the sheet.
    expect(commandTarget(byId('invest'), lastWith({ d: 'trade', acct: '3' }))).toEqual({ screen: 'invest', params: { acct: '3' } })
  })

  it('lands a section on exactly its path', () => {
    expect(formatRoute(commandTarget(byId('cash/transactions?cat=uncat'), lastWith({ month: '2026-08' })))).toBe('#/cash/transactions?cat=uncat')
    expect(formatRoute(commandTarget(byId('tax/paychecks')))).toBe('#/tax/paychecks')
  })
})

describe('the filter', () => {
  it('lists everything, screens then actions then sections, for an empty query', () => {
    const all = rankCommands('  ')
    expect(all).toHaveLength(COMMANDS.length)
    const kinds = all.map((r) => r.cmd.kind)
    expect(kinds.indexOf('action')).toBe(SCREENS.length)
    expect(kinds.lastIndexOf('screen')).toBeLessThan(kinds.indexOf('action'))
    expect(kinds.lastIndexOf('action')).toBeLessThan(kinds.indexOf('section'))
  })

  it('puts the screen a word names first, whatever the case', () => {
    expect(top('tax')).toEqual(['tax'])
    expect(top('TAXES')).toEqual(['tax'])
    expect(top('cash')).toEqual(['cash'])
    expect(top('dream')).toEqual(['goal'])
    expect(top('vault')).toEqual(['vault'])
  })

  it('finds actions by what they say', () => {
    expect(top('import')).toEqual(['cash:import'])
    expect(top('new sc')).toEqual(['future:new-scenario'])
    expect(top('add prop')).toEqual(['re:add-property'])
    expect(top('paycheck', 2).sort()).toEqual(['tax/paychecks', 'tax:add-paycheck'].sort())
    expect(top('trade')).toEqual(['invest:trade'])
    expect(top('record')).toEqual(['invest:trade'])
    expect(top('buy', 3)).toContain('invest:trade')
  })

  it('matches initials and letters in order, starting at a word', () => {
    expect(top('nsc')).toEqual(['future:new-scenario'])
    expect(labelHits('nsc', 'future:new-scenario')).toBe('Nsc')
    expect(labelHits('bs', 'cash:import')).toBe('bs') // Import Bank Statement
    expect(labelHits('ab', 'cash:add-account')).toBe('ab') // the tighter "a bank" beats "Add … bank"
    expect(top('uncat')).toEqual(['cash/transactions?cat=uncat'])
    // Letters scattered mid-word don't count: "xs" isn't in "Taxes" as a word start.
    expect(matchCommand('xs', byId('tax'))).toBeNull()
  })

  it('reaches a command through its keywords and screen name, below a label match', () => {
    expect(top('mortgage', 3)).toContain('re')
    expect(top('mortgage', 3)).toContain('goal/loans')
    expect(matchCommand('mortgage', byId('re'))?.hits).toEqual([]) // nothing in the label to highlight
    // "cash" names the Cash screen outright; its actions follow through the screen name.
    const cash = top('cash', 4)
    expect(cash[0]).toBe('cash')
    expect(cash).toContain('cash:import')
    expect(top('taxes paycheck', 3)).toEqual(expect.arrayContaining(['tax/paychecks', 'tax:add-paycheck']))
  })

  it('matches keywords as words, never letters strung across them', () => {
    // "trade" is not t…r…a from "transactions" plus d…e from "budget".
    expect(rankCommands('trade').map((r) => r.cmd.id)).toEqual(['invest:trade', 'invest'])
    expect(matchCommand('trade', byId('cash'))).toBeNull()
    // A keyword's prefix still counts.
    expect(top('mort', 3)).toContain('goal/loans')
  })

  it('needs every word to match somewhere', () => {
    expect(rankCommands('import zzz')).toEqual([])
    expect(rankCommands('qqq')).toEqual([])
  })

  it('highlights a contiguous match where it starts a word', () => {
    expect(labelHits('sett', 'tax/settings')).toBe('sett')
    expect(labelHits('state', 'cash:import')).toBe('state') // "statement", not the "st" inside "Import"
  })
})

describe('the shortcut', () => {
  const key = (o: Partial<KeyboardEvent>) =>
    ({ key: 'k', code: 'KeyK', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...o }) as KeyboardEvent

  it('is ⌘K on a Mac and Ctrl-K elsewhere', () => {
    expect(isPaletteShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isPaletteShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isPaletteShortcut(key({ key: 'K', metaKey: true }), true)).toBe(true) // caps lock
  })

  it('leaves a Mac text field its Ctrl-K, and ignores other chords and letters', () => {
    expect(isPaletteShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isPaletteShortcut(key({ metaKey: true }), false)).toBe(false)
    expect(isPaletteShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isPaletteShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false)
    expect(isPaletteShortcut(key({ key: 'j', code: 'KeyJ', metaKey: true }), true)).toBe(false)
    expect(isPaletteShortcut(key({}), true)).toBe(false)
  })

  it('follows the letter on a Latin layout and the physical key on others', () => {
    expect(isPaletteShortcut(key({ key: 'л', code: 'KeyK', metaKey: true }), true)).toBe(true) // Russian
    expect(isPaletteShortcut(key({ key: 't', code: 'KeyK', metaKey: true }), true)).toBe(false) // Dvorak's T
    expect(isPaletteShortcut(key({ key: 'k', code: 'KeyV', metaKey: true }), true)).toBe(true) // Dvorak's K
  })
})

describe('the listbox', () => {
  const render = (q: string, active = 0, here: ScreenId | null = 'tax') =>
    renderToStaticMarkup(
      <PaletteList
        results={rankCommands(q)}
        grouped={!q.trim()}
        active={active}
        here={here}
        listId="lb"
        optionId={(i) => `lb-${i}`}
        onPick={() => {}}
        onHover={() => {}}
      />,
    )
  const count = (html: string, s: string) => html.split(s).length - 1

  it('groups an empty query under labelled headings, with exactly one option selected', () => {
    const html = render('', 2)
    expect(count(html, 'role="option"')).toBe(COMMANDS.length)
    expect(count(html, 'role="group"')).toBe(3)
    expect(html).toContain('aria-labelledby="lb-screen"')
    expect(html).toContain('id="lb-screen"')
    expect(count(html, 'aria-selected="true"')).toBe(1)
    expect(html).toMatch(/id="lb-2" role="option" aria-selected="true"/)
    // Option ids run 0…n-1 across the groups, so aria-activedescendant can point at any of them.
    expect(html).toContain(`id="lb-${COMMANDS.length - 1}"`)
    expect(html).toContain('You’re here')
  })

  it('shows a ranked list flat, with matched letters marked and the destination screen named', () => {
    const html = render('add prop')
    expect(count(html, 'role="group"')).toBe(0)
    expect(html).toMatch(/^<div id="lb" role="listbox"/)
    expect(html).toContain('<mark>Add</mark> a <mark>prop</mark>erty…')
    expect(html).toContain('<span class="scr-cmdk-hint">Real estate</span>')
  })
})
