/**
 * Scarab Verify — settings: the origins to check. scarab.one is built in,
 * with its repository fixed in the extension (verify.ts PINNED_REPO) and no
 * setting that could move it. A self-hosted Scarab is added here with the
 * source of its attested manifests — its GitHub repository, or the address
 * of the manifests with `{tag}` — typed by you, never read from the site;
 * Chrome then asks you to grant that host (the extension fetches from it as
 * you) and the content script is registered for it.
 */
import { loadOrigins, matchPattern, saveOrigins, syncContentScripts } from './origins.js'
import { DEFAULT_ORIGIN, normalizeOrigin, normalizeRepo, type OriginSetting } from './verify.js'

const list = document.getElementById('origins') as HTMLUListElement
const form = document.getElementById('add') as HTMLFormElement
const originInput = document.getElementById('origin') as HTMLInputElement
const repoInput = document.getElementById('repo') as HTMLInputElement
const manifestInput = document.getElementById('manifest') as HTMLInputElement
const status = document.getElementById('status') as HTMLParagraphElement

function say(text: string, cls = ''): void {
  status.textContent = text
  status.className = cls
}

function span(cls: string, text: string): HTMLSpanElement {
  const e = document.createElement('span')
  e.className = cls
  e.textContent = text
  return e
}

async function show(): Promise<void> {
  const origins = await loadOrigins()
  list.replaceChildren()
  for (const o of origins) {
    const li = document.createElement('li')
    li.append(span('mono', o.origin))
    const source = o.manifest ? `manifests at ${o.manifest}` : `releases of ${o.repo}`
    li.append(span('muted', ` · ${source}`))
    if (o.origin === DEFAULT_ORIGIN) li.append(span('muted', ' · built in, fixed'))
    else {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = 'Remove'
      remove.addEventListener('click', () => void removeOrigin(o))
      li.append(' ', remove)
    }
    list.append(li)
  }
  const problems = await syncContentScripts()
  if (problems.length) say(`Not active: ${problems.join('; ')}. Grant the site in chrome://extensions → Scarab Verify → Site access, or remove and add it again.`, 'fail')
}

async function removeOrigin(o: OriginSetting): Promise<void> {
  await saveOrigins((await loadOrigins()).filter((x) => x.origin !== o.origin))
  const hosts = [matchPattern(o.origin), ...(o.manifest ? [matchPattern(new URL(o.manifest.replaceAll('{tag}', 'tag')).origin)] : [])].filter(
    (h) => h !== matchPattern(DEFAULT_ORIGIN),
  )
  await chrome.permissions.remove({ origins: hosts }).catch(() => {})
  say(`Removed ${o.origin}.`)
  await show()
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const origin = normalizeOrigin(originInput.value)
  if (!origin) return say('Enter the site as https://host (or http://localhost:port for a local server).', 'fail')
  if (origin === DEFAULT_ORIGIN) return say('scarab.one is built in: its repository is fixed in the extension and cannot be changed here.', 'fail')
  const repoText = repoInput.value.trim()
  const repo = repoText ? normalizeRepo(repoText) : null
  if (repoText && !repo) return say('The repository must be a GitHub repository: https://github.com/owner/name.', 'fail')
  const manifestText = manifestInput.value.trim()
  let manifest: string | null = null
  let manifestOrigin: string | null = null
  if (manifestText) {
    try {
      const u = new URL(manifestText.replaceAll('{tag}', 'tag'))
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error()
      manifest = manifestText
      manifestOrigin = u.origin
    } catch {
      return say('The manifest address must be a full http(s) URL; {tag} stands for the release tag.', 'fail')
    }
  }
  if (!repo && !manifest) return say('Say where the attested manifests come from: the GitHub repository, or a manifest address.', 'fail')
  const hosts = [matchPattern(origin)]
  if (manifestOrigin && manifestOrigin !== origin) hosts.push(matchPattern(manifestOrigin))
  // chrome.permissions.request must run inside the click: nothing awaited before it.
  void chrome.permissions.request({ origins: hosts }).then(async (granted) => {
    if (!granted) return say(`Chrome did not grant ${hosts.join(' and ')}; nothing was added.`, 'fail')
    const origins = (await loadOrigins()).filter((o) => o.origin !== origin)
    origins.push({ origin, repo, manifest })
    await saveOrigins(origins)
    originInput.value = ''
    repoInput.value = ''
    manifestInput.value = ''
    say(`Added ${origin}. Open it and look at the toolbar badge.`, 'ok')
    await show()
  })
})

void show()
