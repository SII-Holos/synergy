type BrowserDebugDetails = Record<string, unknown>

function browserDebugEnabled() {
  if (import.meta.env.DEV) return true
  if (typeof window === "undefined") return false
  try {
    return window.localStorage.getItem("synergy.browser.debug") === "1"
  } catch {
    return false
  }
}

export function browserDebug(event: string, details?: BrowserDebugDetails) {
  if (!browserDebugEnabled()) return
  if (details) {
    console.debug(`[browser] ${event}`, details)
    return
  }
  console.debug(`[browser] ${event}`)
}

export function summarizeBrowserMessage(msg: Record<string, unknown>): BrowserDebugDetails {
  const summary: BrowserDebugDetails = { type: msg.type }
  for (const key of [
    "tabId",
    "activeTabId",
    "url",
    "title",
    "mode",
    "status",
    "severity",
    "code",
    "message",
    "reason",
    "source",
  ]) {
    if (msg[key] !== undefined) summary[key] = msg[key]
  }
  if (msg.tab && typeof msg.tab === "object") {
    const tab = msg.tab as Record<string, unknown>
    summary.tab = { id: tab.id, url: tab.url, title: tab.title, isLoading: tab.isLoading }
  }
  if (Array.isArray(msg.tabs)) summary.tabCount = msg.tabs.length
  if (typeof msg.data === "string") summary.dataLength = msg.data.length
  if (typeof msg.dataUrl === "string") summary.dataUrlLength = msg.dataUrl.length
  if (msg.metadata && typeof msg.metadata === "object") summary.metadata = msg.metadata
  return summary
}
