import { useCallback, useEffect, useRef, useState } from 'react'
import { localMode } from '../local'
import { fetchMembers, fetchMode, fetchVaultInfo, follow, type Members, type VaultInfo } from '../session'
import { prefersReducedMotion } from '../ui/motion'
import { AdvancedCard, type BasketStatus } from './vault/Advanced'
import { BackupsCard } from './vault/Backups'
import { RecoveryCodeHost } from './vault/codeSheet'
import { HistoryCard } from './vault/History'
import { HouseholdCard } from './vault/Household'
import { RecoveryCard } from './vault/Recovery'
import { SessionCard } from './vault/Session'
import './vault/vault.css'

/**
 * Data & Vault: one card per concern — Session (what this tab runs on, and the
 * ways in and out), Household (people and their passkeys), Recovery (the code
 * and its drill), Backups (the plain export, and the encrypted .scarab file),
 * History (earlier versions the server keeps: open, compare, restore — in a
 * session with a vault), and Advanced, collapsed (the
 * stored copy and this device's memory of it, key rotation, the price basket,
 * the engine check, and the household → session switch).
 *
 * What the server holds is fetched once per visit — one download of the blob
 * (its header lists the passkeys) — and again after this tab saves a new
 * version, so the stored-copy line describes the current copy.
 */
export default function Vault() {
  /** undefined while loading; null when nothing is stored. */
  const [info, setInfo] = useState<VaultInfo | null | undefined>(undefined)
  const [members, setMembers] = useState<Members | null>(null)
  /** Whose vault the stored one is: this identity's own (null), another household's (their email), or unknown yet. */
  const [household, setHousehold] = useState<string | null | undefined>(undefined)
  const [basket, setBasket] = useState<BasketStatus | null>(null)
  const [advanced, setAdvanced] = useState(false)
  /** The stored vault couldn't be fetched (offline, a server restarting): unknown, not "none". */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [, bump] = useState(0)

  const loadMembers = useCallback(() => {
    fetchMembers().then(setMembers).catch(() => setMembers(null))
  }, [])
  const load = useCallback(() => {
    fetchVaultInfo()
      .then((v) => {
        setInfo(v)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        setInfo((cur) => (cur === null ? undefined : cur)) // never read a failed fetch as "nothing stored"
        setLoadError(e instanceof Error ? e.message : String(e))
      })
    loadMembers()
    fetchMode()
      .then((m) => setHousehold(m.household))
      .catch(() => setHousehold(undefined))
    fetch('/api/basket/status')
      .then((r) => (r.ok ? (r.json() as Promise<BasketStatus>) : null))
      .then(setBasket)
      .catch(() => setBasket(null))
  }, [loadMembers])

  useEffect(() => {
    load()
    const rerender = () => bump((n) => n + 1)
    window.addEventListener('scarab-mode', rerender)
    return () => window.removeEventListener('scarab-mode', rerender)
  }, [load])

  // Someone joined, left, was invited or answered (this tab's own change, or one the session noticed): the list with who added whom, again.
  const householdKey = follow.household ? `${follow.household.owner}|${follow.household.members.join(',')}|${follow.household.invited.join(',')}` : ''
  const seenHousehold = useRef(householdKey)
  useEffect(() => {
    if (seenHousehold.current === householdKey) return
    seenHousehold.current = householdKey
    loadMembers()
  }, [householdKey, loadMembers])

  // A save this tab made (autosave included) moved the vault on: refetch what the server holds, so the
  // stored-copy line and the device-memory line describe the current copy. Once per version: a server that
  // stays behind (restored meanwhile) must not become a fetch loop — and once the refetch is in, what it
  // says is shown, even if it is behind.
  const sessionVersion = localMode.vault?.version ?? null
  const refetchedFor = useRef<number | null>(null)
  const [refetching, setRefetching] = useState(false)
  useEffect(() => {
    if (sessionVersion === null || !info || sessionVersion <= info.version || refetchedFor.current === sessionVersion) return
    refetchedFor.current = sessionVersion
    setRefetching(true)
    fetchVaultInfo()
      .then(setInfo)
      .catch(() => undefined) // keep what was shown; the next save or visit asks again
      .finally(() => setRefetching(false))
  }, [sessionVersion, info])

  return (
    <div className="grid12 zk-vault">
      <section className="card c12 zk-card zk-intro" aria-label="How this works">
        <p>
          A <b className="inkstrong">zero-knowledge session</b> runs Scarab entirely in this tab: the vault is decrypted here, every screen computes
          here, and saving encrypts here before anything is uploaded. The server stores ciphertext it cannot read and couriers a daily price basket
          that is the same for everyone. A passkey — fingerprint or face, synced by Apple or Google — decrypts; the printed recovery code is the only
          other way in, and there is <b className="inkstrong">no reset</b>. Details and honest limits are in <span className="num">PRIVACY.md</span>.
        </p>
      </section>
      <SessionCard
        info={info}
        household={household}
        reload={load}
        openAdvanced={() => {
          setAdvanced(true)
          requestAnimationFrame(() =>
            document.getElementById('zk-advanced')?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }),
          )
        }}
      />
      <HouseholdCard info={info} members={members} loadError={loadError} reload={load} />
      <RecoveryCard />
      <BackupsCard />
      <HistoryCard />
      <div id="zk-advanced" className="c12 zk-adv-wrap">
        <AdvancedCard open={advanced} onToggle={setAdvanced} info={info} members={members} refetching={refetching} basket={basket} reload={load} />
      </div>
      <RecoveryCodeHost />
    </div>
  )
}
