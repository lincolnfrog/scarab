/**
 * Scarab Verify — the content script. Runs at document_start on every
 * configured origin, in the page's isolated world, and does one thing: tells
 * the service worker what this document loaded from its origin — the document
 * itself and every script, stylesheet, module chunk, font, wasm file and the
 * web manifest, with the byte count the browser reports for each. It fetches
 * nothing and hashes nothing: a page can patch its own fetch and crypto, so
 * the checking happens in the worker (worker.ts), which re-fetches each URL
 * with its own fetch and hashes it with its own crypto.
 *
 * Two sources, because neither alone sees everything: resource timing (every
 * subresource the document fetched, from before this script ran — buffered —
 * to the chunks a screen loads an hour later) and the DOM (the shell's script
 * and link tags and the modulepreload links Vite adds before each dynamic
 * import, which also catches a memory-cache hit that resource timing may not
 * report). Same origin only; /api/* is the app's data and /build.json the
 * manifest itself, neither a file of the build (verify.ts isBuildResource —
 * repeated here because a content script cannot import).
 *
 * Not a module (Chrome injects content scripts as classic scripts), so
 * everything lives in this closure.
 */
;(() => {
  const origin = location.origin
  /** This document, for the worker: a report with a new id is a new page load, and the old results go. */
  const docId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  /** URL → decoded body size the browser reported (0 until resource timing says). */
  const seen = new Map<string, number>()
  let timer: number | undefined

  function isBuildResource(url: string): boolean {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return false
    }
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === origin && !u.pathname.startsWith('/api/') && u.pathname !== '/build.json'
  }

  function note(url: string, size: number): void {
    if (!isBuildResource(url)) return
    const key = url.split('#')[0]!
    const had = seen.get(key)
    if (had === undefined) seen.set(key, size)
    else if (had === 0 && size > 0) seen.set(key, size)
    else return
    schedule()
  }

  // 1. Resource timing: what the document actually fetched, with sizes. `buffered` replays what arrived before this ran.
  const resources = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) note(e.name, (e as PerformanceResourceTiming).decodedBodySize || 0)
  })
  resources.observe({ type: 'resource', buffered: true })

  // 2. The DOM: script and link elements, in the shell and added later (Vite's preload helper, before each dynamic import).
  function fromElement(el: Element): void {
    if (el.localName === 'script') {
      const src = (el as HTMLScriptElement).src
      if (src) note(src, 0)
    } else if (el.localName === 'link') {
      const link = el as HTMLLinkElement
      if (link.href && /\b(stylesheet|modulepreload|manifest)\b/i.test(link.rel)) note(link.href, 0)
    }
  }
  const dom = new MutationObserver((mutations) => {
    for (const m of mutations)
      for (const n of m.addedNodes) {
        if (!(n instanceof Element)) continue
        fromElement(n)
        for (const el of n.querySelectorAll('script[src], link[href]')) fromElement(el)
      }
  })
  dom.observe(document, { childList: true, subtree: true })

  /** The document's own byte count, known once the response is complete. */
  function documentSize(): number {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
    return nav?.decodedBodySize || 0
  }

  function snapshot() {
    return {
      type: 'observed',
      docId,
      origin,
      document: { url: `${origin}${location.pathname}${location.search}`, size: documentSize() },
      resources: [...seen].map(([url, size]) => ({ url, size })),
    }
  }

  function send(): void {
    timer = undefined
    chrome.runtime.sendMessage(snapshot()).catch(() => {
      // the worker is being installed or updated: the next report, or a "Check again", will reach it
    })
  }

  /** Reports coalesce: a page load adds dozens of resources in a burst, and one report after the burst is enough. */
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(send, 250)
  }

  // The document's size is known at load; so is the full list of what the shell referenced.
  addEventListener('load', schedule)
  // The popup's "Check again": the worker asks for the current list and re-fetches everything.
  chrome.runtime.onMessage.addListener((message, _sender, reply) => {
    if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'report') reply(snapshot())
  })

  // Right away, so the worker shows "checking" and fetches the two manifests while the page is still loading.
  send()
})()
