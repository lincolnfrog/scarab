/**
 * The slice of the Chrome extensions API this extension uses (Manifest V3,
 * promise forms), declared by hand so the extension stays dependency-free:
 * @types/chrome would be a package for five files. Add to it as needed; the
 * shapes follow developer.chrome.com/docs/extensions/reference.
 */
declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: tabs.Tab
      frameId?: number
      id?: string
      url?: string
      origin?: string
    }
    const onMessage: {
      addListener(cb: (message: unknown, sender: MessageSender, sendResponse: (response?: unknown) => void) => boolean | void): void
    }
    const onInstalled: { addListener(cb: (details: { reason: string }) => void): void }
    const onStartup: { addListener(cb: () => void): void }
    function sendMessage(message: unknown): Promise<unknown>
    function getURL(path: string): string
    function openOptionsPage(): Promise<void>
    const lastError: { message?: string } | undefined
  }
  namespace tabs {
    interface Tab {
      id?: number
      /** Only for URLs the extension has host permission for. */
      url?: string
      active: boolean
      windowId: number
    }
    function query(info: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function sendMessage(tabId: number, message: unknown): Promise<unknown>
    const onUpdated: { addListener(cb: (tabId: number, change: { status?: string; url?: string }, tab: Tab) => void): void }
    const onRemoved: { addListener(cb: (tabId: number) => void): void }
  }
  namespace action {
    function setBadgeText(d: { text: string; tabId?: number }): Promise<void>
    function getBadgeText(d: { tabId?: number }): Promise<string>
    function setBadgeBackgroundColor(d: { color: string; tabId?: number }): Promise<void>
    function setBadgeTextColor(d: { color: string; tabId?: number }): Promise<void>
    function setTitle(d: { title: string; tabId?: number }): Promise<void>
  }
  namespace storage {
    interface Area {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>
      set(items: Record<string, unknown>): Promise<void>
      remove(keys: string | string[]): Promise<void>
    }
    const local: Area
    const session: Area
    const onChanged: {
      addListener(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void): void
    }
  }
  namespace permissions {
    function request(p: { origins?: string[] }): Promise<boolean>
    function remove(p: { origins?: string[] }): Promise<boolean>
    function contains(p: { origins?: string[] }): Promise<boolean>
  }
  namespace scripting {
    interface RegisteredContentScript {
      id: string
      matches: string[]
      js: string[]
      runAt?: 'document_start' | 'document_end' | 'document_idle'
      persistAcrossSessions?: boolean
    }
    function registerContentScripts(scripts: RegisteredContentScript[]): Promise<void>
    function unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>
    function getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>
  }
}
