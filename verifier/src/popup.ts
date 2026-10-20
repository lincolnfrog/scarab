/**
 * Scarab Verify — the popup: the current tab's result from
 * chrome.storage.session, as the worker (worker.ts) left it. Release and
 * commit, linked; one row per file the page loaded; the time of the last
 * check; "Check again". Opened as a page (chrome-extension://…/popup.html?tab=N)
 * it shows that tab, which is how the end-to-end test reads it.
 */
import { loadOrigins } from './origins.js'
import { settingFor, shortCommit, type FileResult, type FileStatus, type TabState, type Verdict } from './verify.js'

const root = document.getElementById('root')!

const VERDICT: Record<Verdict, { glyph: string; label: string; cls: string }> = {
  ok: { glyph: '✓', label: 'This page is the attested release', cls: 'ok' },
  fail: { glyph: '✕', label: 'This page is NOT the attested release', cls: 'fail' },
  unverifiable: { glyph: '?', label: 'Cannot verify this page', cls: 'unknown' },
  checking: { glyph: '…', label: 'Checking…', cls: 'unknown' },
}

const STATUS: Record<FileStatus, { label: string; cls: string }> = {
  ok: { label: 'ok', cls: 'ok' },
  mismatch: { label: 'MISMATCH', cls: 'fail' },
  shell: { label: 'MISSING', cls: 'fail' },
  'not-in-manifest': { label: 'NOT IN RELEASE', cls: 'fail' },
  'size-differs': { label: 'SIZE DIFFERS', cls: 'fail' },
  unreachable: { label: 'unreachable', cls: 'unknown' },
  unchecked: { label: 'not checked', cls: 'unknown' },
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (string | Node)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  e.append(...children)
  return e
}

const link = (href: string, text: string) => el('a', { href, target: '_blank', rel: 'noreferrer' }, text)

const bytes = (n: number | null) => (n === null ? '—' : n.toLocaleString())

const time = (t: number) => new Date(t).toLocaleTimeString()

function render(tabId: number, state: TabState | undefined, configured: boolean): void {
  root.replaceChildren()
  if (!state) {
    root.append(
      el('p', { class: 'lead unknown' }, configured ? 'Nothing observed yet. Reload the page to check it.' : 'This tab is not a Scarab origin.'),
      el('p', { class: 'muted' }, 'Scarab Verify checks that the page scarab.one (or a self-hosted Scarab) serves you is the release its repository attested. ', settingsLink()),
    )
    return
  }
  const v = VERDICT[state.verdict]
  root.append(el('p', { class: `lead ${v.cls}` }, el('span', { class: 'glyph' }, v.glyph), ' ', v.label))

  const release = state.release
  const m = release?.manifest
  const facts = el('dl', { class: 'facts' })
  const fact = (k: string, ...v: (string | Node)[]) => facts.append(el('dt', {}, k), el('dd', {}, ...v))
  fact('Site', state.origin)
  if (m) {
    const repo = m.repo
    fact('Release', m.tag ? (repo ? link(`${repo}/releases/tag/${encodeURIComponent(m.tag)}`, m.tag) : m.tag) : 'untagged')
    if (m.commit) fact('Commit', repo ? link(`${repo}/commit/${m.commit}`, shortCommit(m.commit)) : shortCommit(m.commit), el('span', { class: 'muted mono' }, ` ${m.commit}`))
    if (release?.manifestUrl) fact('Manifest', link(release.manifestUrl, 'attested build.json'))
  } else if (release?.served) {
    fact('Site says', `${release.served.tag ?? 'no release'}${release.served.commit ? ` · ${shortCommit(release.served.commit)}` : ''}`)
  }
  if (state.checkedAt) fact('Checked', time(state.checkedAt))
  root.append(facts)

  if (state.reason) root.append(el('p', { class: 'reason' }, state.reason))
  for (const n of state.notes) root.append(el('p', { class: 'note' }, n))

  if (state.files.length) {
    const table = el('table', { class: 'files' })
    table.append(el('thead', {}, el('tr', {}, el('th', {}, 'file'), el('th', { class: 'num' }, 'page saw'), el('th', { class: 'num' }, 'fetched'), el('th', {}, 'status'))))
    const body = el('tbody')
    for (const f of sorted(state.files)) {
      const s = STATUS[f.status]
      const row = el('tr', { class: s.cls }, el('td', { class: 'mono', title: f.url }, f.path), el('td', { class: 'num mono' }, bytes(f.observedSize)), el('td', { class: 'num mono' }, bytes(f.fetchedSize)), el('td', { class: 'status' }, s.label))
      body.append(row)
      if (f.note) body.append(el('tr', { class: `detail ${s.cls}` }, el('td', { colspan: '4' }, f.note)))
    }
    table.append(body)
    root.append(table)
  }

  const again = el('button', { type: 'button' }, 'Check again')
  again.addEventListener('click', () => {
    again.disabled = true
    void chrome.runtime.sendMessage({ type: 'recheck', tabId }).finally(() => (again.disabled = false))
  })
  root.append(el('p', { class: 'actions' }, again, ' ', settingsLink()))
}

function settingsLink(): HTMLElement {
  const a = el('a', { href: '#' }, 'Settings')
  a.addEventListener('click', (e) => {
    e.preventDefault()
    void chrome.runtime.openOptionsPage()
  })
  return a
}

/** The document first, then by path; a failing row before an ok one at the same path order is not needed — paths are unique. */
function sorted(files: FileResult[]): FileResult[] {
  return [...files].sort((a, b) => (a.path === 'index.html' ? -1 : b.path === 'index.html' ? 1 : a.path.localeCompare(b.path)))
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search)
  let tabId = params.has('tab') ? Number(params.get('tab')) : NaN
  if (!Number.isInteger(tabId)) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (tab?.id === undefined) return render(-1, undefined, false)
    tabId = tab.id
  }
  const key = `tab:${tabId}`
  const show = async () => {
    const [stored, tab, origins] = await Promise.all([chrome.storage.session.get(key), chrome.tabs.get(tabId).catch(() => undefined), loadOrigins()])
    render(tabId, stored[key] as TabState | undefined, !!(tab?.url && settingFor(tab.url, origins)))
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && key in changes) void show()
  })
  await show()
}

void main()
