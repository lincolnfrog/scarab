import { describe, expect, it } from 'vitest'
import { PRODUCTION_RP_ID, rpIdFor, wrongOriginMessage } from './passkey'

describe('rpIdFor: passkeys are pinned to the production domain', () => {
  it('scarab.one and every subdomain share one RP ID; everything else keeps its hostname', () => {
    const table: [string, string][] = [
      ['scarab.one', 'scarab.one'],
      ['www.scarab.one', 'scarab.one'],
      ['staging.scarab.one', 'scarab.one'],
      ['a.b.scarab.one', 'scarab.one'],
      ['SCARAB.ONE', 'scarab.one'],
      ['scarab.one.', 'scarab.one'], // a fully-qualified hostname
      // Not scarab.one: dev and self-hosting are unchanged.
      ['localhost', 'localhost'],
      ['127.0.0.1', '127.0.0.1'],
      ['scarab-abc123-uc.a.run.app', 'scarab-abc123-uc.a.run.app'],
      ['money.example.com', 'money.example.com'],
      // Lookalikes are not subdomains.
      ['evilscarab.one', 'evilscarab.one'],
      ['scarab.one.evil.com', 'scarab.one.evil.com'],
      ['scarab.onex', 'scarab.onex'],
      ['xscarab.one', 'xscarab.one'],
    ]
    for (const [host, want] of table) expect([host, rpIdFor(host)]).toEqual([host, want])
    expect(PRODUCTION_RP_ID).toBe('scarab.one')
  })

  it('says where the passkeys live when a vault is opened elsewhere', () => {
    expect(wrongOriginMessage('scarab.one')).toBe('This vault’s passkeys belong to scarab.one — open it there, or use the recovery code.')
  })
})
