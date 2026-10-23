import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Setup, SetupStep } from '../../engine/setup'
import { ScreenProvider } from '../ui/screen'
import { SetupCard, SetupHero, SetupList, setupOpen } from './Setup'

/** The setup checklist as markup (Node has no DOM here; the screens are checked in the browser). */

const empty: Setup = {
  done: 0,
  hidden: false,
  steps: [
    { id: 'bank', done: false, accounts: 0, transactions: 0 },
    { id: 'invest', done: false, accounts: 0 },
    { id: 'property', done: false, properties: 0 },
    { id: 'paycheck', done: false, paychecks: 0 },
    { id: 'people', done: false, people: 0, missing: [] },
    { id: 'filing', done: false, filingStatus: 'mfj', state: 'CA', stateName: 'California' },
  ],
}
const withSteps = (patch: Partial<Record<SetupStep['id'], Partial<SetupStep>>>): Setup => {
  const steps = empty.steps.map((s) => ({ ...s, ...patch[s.id] }) as SetupStep)
  return { ...empty, steps, done: steps.filter((s) => s.done).length }
}
const list = (s: Setup) => renderToStaticMarkup(<SetupList setup={s} onChanged={() => {}} />)
/** Each action link: its class and where it goes. */
const links = (html: string) => [...html.matchAll(/<a href="([^"]+)" class="([^"]+)">([^<]+)</g)].map((m) => ({ href: m[1]!.replace(/&amp;/g, '&'), cls: m[2]!, label: m[3]! }))

describe('the setup checklist', () => {
  it('lists every step, each linking into the flow that already does it, with the first one gold', () => {
    const html = list(empty)
    expect((html.match(/<li class="su-step"/g) ?? []).length).toBe(6)
    expect(links(html)).toEqual([
      { href: '#/cash/import?d=add-account', cls: 'btn mini gold', label: 'Add an account' },
      { href: '#/invest?d=add-account', cls: 'btn mini', label: 'Add an account' },
      { href: '#/re?d=add-property', cls: 'btn mini', label: 'Add a property' },
      { href: '#/tax?d=add-paycheck', cls: 'btn mini', label: 'Add a paycheck' },
      // Birth years wait for a paycheck to name the earners: no link yet.
      { href: '#/tax/settings', cls: 'btn mini ghosty', label: 'Change' },
    ])
    expect(html).toContain('Taxes assumes married filing jointly in California until you say so.')
    expect(html).toMatch(/<button[^>]*class="btn mini"><span class="ui-btn-label">That’s right</)
  })

  it('moves the gold to the next step that can be done, and says what is there once a step is done', () => {
    const html = list(
      withSteps({
        bank: { done: true, accounts: 2, transactions: 1204 },
        invest: { done: true, accounts: 3 },
        property: { done: true, properties: 1 },
        paycheck: { done: true, paychecks: 2 },
        people: { people: 2, missing: ['Robin', 'Kai'] },
      }),
    )
    expect(html).toContain('1,204 transactions in 2 accounts')
    expect(html).toContain('For Robin and Kai — ages set the catch-up limits.')
    expect(links(html)).toEqual([
      { href: '#/tax/contributions', cls: 'btn mini gold', label: 'Add birth years' },
      { href: '#/tax/settings', cls: 'btn mini ghosty', label: 'Change' },
    ])
    // A done step has no action, and says so to a screen reader.
    expect(html).toContain('<span class="ui-sr">Done: </span>Bring in a bank or card account')
  })

  it('offers an import once a bank account exists, and the filing confirmation as the gold action when it is all that is left', () => {
    expect(links(list(withSteps({ bank: { accounts: 1 } })))[0]).toMatchObject({ href: '#/cash/import?d=import', label: 'Import a statement' })
    const last = list(
      withSteps({
        bank: { done: true },
        invest: { done: true },
        property: { done: true },
        paycheck: { done: true },
        people: { done: true, people: 2 },
      }),
    )
    expect(last).toMatch(/<button[^>]*class="btn gold mini"><span class="ui-btn-label">That’s right</)
  })

  it('is the hero while the household is empty, and a one-figure card once it is not', () => {
    const hero = renderToStaticMarkup(<SetupHero setup={empty} onChanged={() => {}} />)
    expect(hero).toMatch(/class="card c12 hero su-hero"/)
    expect(hero).toContain('0 of 6')
    const card = renderToStaticMarkup(
      <ScreenProvider id="dash" active headerHost={null} onCrumb={() => {}}>
        <SetupCard setup={withSteps({ bank: { done: true } })} />
      </ScreenProvider>,
    )
    expect(card).toContain('href="#/dash/setup"')
    expect(card).toContain('1 of 6')
    expect(card).toContain('Next: add an investment account')
  })

  it('stays away once everything is done or this person hid it', () => {
    expect(setupOpen(empty)).toBe(true)
    expect(setupOpen({ ...empty, hidden: true })).toBe(false)
    expect(setupOpen({ ...empty, done: 6 })).toBe(false)
    expect(setupOpen(null)).toBe(false)
  })
})
