/**
 * Scarab Verify — settings: the origins to check. scarab.one is built in;
 * a self-hosted Scarab is added here, which asks Chrome for that host (the
 * extension needs to fetch from it as you) and registers the content script
 * for it. Optionally, where that install's attested manifests live, when its
 * releases are not on GitHub.
 */
import { loadOrigins, matchPattern, saveOrigins, syncContentScripts } from './origins.js'
import { DEFAULT_ORIGIN, normalizeOrigin, type OriginSetting } from './verify.js'

const list = document.getElementById('origins') as HTMLUListElement
const form = document.getElementById('add') as HTMLFormElement
const originInput = document.getElementById('origin') as HTMLInputElement
const manifestInput = document.getElementById('manifest') as HTMLInputElement
const status = document.getElementById('status') as HTMLParagraphElement

function say(text: string, cls = ''): void {
  status.textContent = text
  status.className = cls
}

async function show(): Promise<void> {
  const origins = await loadOrigins()
  list.replaceChildren()
  for (const o of origins) {
    const li = document.createElement('li')
    const name = document.createElement('span')
    name.className = 'mono'
    name.textContent = o.origin
    li.append(name)
    const where = document.createElement('span')
    where.className = 'muted'
    where.textContent = o.manifest ? ` · manifest at ${o.manifest}` : ' · manifest from the GitHub release the site names'
    li.append(where)
    if (o.origin === DEFAULT_ORIGIN) {
      const builtIn = document.createElement('span')
      builtIn.className = 'muted'
      builtIn.textContent = ' · built in'
      li.append(builtIn)
    } else {
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
  const origins = (await loadOrigins()).filter((x) => x.origin !== o.origin)
  await saveOrigins(origins)
  const hosts = [matchPattern(o.origin), ...(o.manifest ? [matchPattern(new URL(o.manifest).origin)] : [])].filter((h) => h !== matchPattern(DEFAULT_ORIGIN))
  await chrome.permissions.remove({ origins: hosts }).catch(() => {})
  say(`Removed ${o.origin}.`)
  await show()
}

form.addEventListener('submit', (e) => {
  e.preventDefault()
  const origin = normalizeOrigin(originInput.value)
  if (!origin) return say('Enter the site as https://host (or http://localhost:port for a local server).', 'fail')
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
  const hosts = [matchPattern(origin)]
  if (manifestOrigin && manifestOrigin !== origin) hosts.push(matchPattern(manifestOrigin))
  // chrome.permissions.request must run inside the click: nothing awaited before it.
  void chrome.permissions.request({ origins: hosts }).then(async (granted) => {
    if (!granted) return say(`Chrome did not grant ${hosts.join(' and ')}; nothing was added.`, 'fail')
    const origins = (await loadOrigins()).filter((o) => o.origin !== origin)
    origins.push({ origin, manifest })
    await saveOrigins(origins)
    originInput.value = ''
    manifestInput.value = ''
    say(`Added ${origin}. Open it and look at the toolbar badge.`, 'ok')
    await show()
  })
})

void show()
