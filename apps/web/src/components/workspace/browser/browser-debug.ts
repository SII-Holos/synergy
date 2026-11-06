type BrowserDebugDetails = Record<string, unknown>

function browserDebugEnabled() {
  if (import.meta.env.MODE === "test") return false
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
    console.log(`[browser] ${event}`, details)
    return
  }
  console.log(`[browser] ${event}`)
}

export function shouldLogBrowserMessage(msg: Record<string, unknown>) {
  const type = msg.type
  if (type === "frame") return false
  if (type === "input.mouse") return false
  if (type === "input.key") return false
  if (type === "input.text") return false
  return true
}

export function summarizeBrowserMessage(msg: Record<string, unknown>): BrowserDebugDetails {
  const summary: BrowserDebugDetails = { type: msg.type }
  for (const key of ["pageId", "url", "title", "mode", "status", "severity", "code", "message", "reason", "source"]) {
    if (msg[key] !== undefined) summary[key] = msg[key]
  }
  if (msg.page && typeof msg.page === "object") {
    const page = msg.page as Record<string, unknown>
    summary.page = { id: page.id, url: page.url, title: page.title, isLoading: page.isLoading }
  }
  if (typeof msg.data === "string") summary.dataLength = msg.data.length
  if (typeof msg.dataUrl === "string") summary.dataUrlLength = msg.dataUrl.length
  if (msg.metadata && typeof msg.metadata === "object") summary.metadata = msg.metadata
  return summary
}
